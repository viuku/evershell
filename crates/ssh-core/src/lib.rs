//! SSH 内核。
//!
//! 只依赖一条双向字节流，不关心它从哪来：桌面端传 TCP 连接，
//! 网页端传由 WebSocket 中转适配出来的流。同一份代码在原生和 WASM 下都能编译。
//!
//! 一条 [`Connection`] 完成握手和认证后，可以在上面打开交互 shell、执行命令、
//! 开 SFTP 会话和监控采样，它们各自走独立的 SSH channel，互不干扰。

pub mod monitor;
pub mod sftp;

use std::future::Future;
use std::sync::{Arc, Mutex};

use russh::client::{self, Handle, Msg};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate, decode_secret_key};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

pub use monitor::{MonitorHandle, MonitorSnapshot};
pub use sftp::{FileEntry, FileKind, Sftp, TransferProgress};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("SSH 错误: {0}")]
    Ssh(#[from] russh::Error),
    #[error("私钥无法解析: {0}")]
    Key(#[from] russh::keys::Error),
    /// 界面按开头的「认证失败」认出这种错误（packages/ui/src/core/connect.ts 的 isAuthFailure），改文案要一起改
    #[error("认证失败：用户名、密码或私钥不正确")]
    AuthFailed,
    #[error("网络错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Sftp(String),
}

pub type Result<T> = std::result::Result<T, Error>;

pub enum Auth {
    /// 空字符串表示没有密码：只在服务器不要认证时能连上，空密码本身不会发出去
    Password(String),
    PrivateKey {
        pem: String,
        passphrase: Option<String>,
    },
}

#[derive(Debug)]
pub enum ShellEvent {
    /// 远端输出，stdout 和 stderr 合在一起，与真实终端一致
    Data(Vec<u8>),
    /// 会话结束；远端没给退出码时为 None
    Exit(Option<u32>),
}

/// `exec` 的结果
#[derive(Debug, Default)]
pub struct ExecOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// 远端没给退出码时为 None
    pub exit_code: Option<u32>,
}

impl ExecOutput {
    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

struct Client {
    fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        // TODO(M1): 对照 known_hosts 校验，首次连接时让用户确认指纹
        let fp = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256),
            PublicKeyOrCertificate::Certificate(cert) => {
                cert.public_key().fingerprint(HashAlg::Sha256)
            }
        };
        *self.fingerprint.lock().unwrap() = Some(fp.to_string());
        Ok(true)
    }
}

/// 一条已登录的 SSH 连接。
pub struct Connection {
    handle: Handle<Client>,
    host_key_fingerprint: Option<String>,
    // SFTP 会话按需打开一次，之后共用
    sftp: tokio::sync::Mutex<Option<Sftp>>,
}

impl Connection {
    /// 在给定的字节流上完成 SSH 握手和认证。
    pub async fn connect<S>(stream: S, user: &str, auth: Auth) -> Result<Self>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let config = Arc::new(client::Config::default());
        let fingerprint = Arc::new(Mutex::new(None));
        let client = Client {
            fingerprint: fingerprint.clone(),
        };
        let mut handle = client::connect_stream(config, stream, client).await?;

        // 先用 none 方式（RFC 4252 5.2 节）问服务器要不要认证，OpenSSH 和 FinalShell 用的 JSch 都这么做。
        // 不需要认证的服务器、没设密码的账号（OpenSSH 的 PermitEmptyPasswords、dropbear 的 -B）
        // 在这一步就放行，密码和私钥都不用发出去
        let none = handle.authenticate_none(user).await?;
        let auth = match auth {
            _ if none.success() => none,
            // 空密码只靠上面的 none。真把空密码发给要密码的服务器，它的日志里会多一条密码错误，
            // fail2ban 这类工具会算进封禁次数
            Auth::Password(password) if password.is_empty() => none,
            Auth::Password(password) => handle.authenticate_password(user, password).await?,
            Auth::PrivateKey { pem, passphrase } => {
                let key = decode_secret_key(&pem, passphrase.as_deref())?;
                let hash = handle.best_supported_rsa_hash().await?.flatten();
                let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
                handle.authenticate_publickey(user, key).await?
            }
        };
        if !auth.success() {
            return Err(Error::AuthFailed);
        }

        let host_key_fingerprint = fingerprint.lock().unwrap().take();
        Ok(Self {
            handle,
            host_key_fingerprint,
            sftp: tokio::sync::Mutex::new(None),
        })
    }

    /// 服务器公钥的 SHA256 指纹，格式同 `ssh-keygen -l`
    pub fn host_key_fingerprint(&self) -> Option<&str> {
        self.host_key_fingerprint.as_deref()
    }

    /// 打开一个分配了 PTY 的交互式 shell。远端输出通过返回的接收端逐条送出。
    pub async fn open_shell(
        &self,
        term: &str,
        cols: u32,
        rows: u32,
    ) -> Result<(Shell, mpsc::UnboundedReceiver<ShellEvent>)> {
        let channel = self.handle.channel_open_session().await?;
        channel
            .request_pty(false, term, cols, rows, 0, 0, &[])
            .await?;
        channel.request_shell(false).await?;
        let (mut reader, writer) = channel.split();

        let (tx, rx) = mpsc::unbounded_channel();
        spawn(async move {
            let mut exit_status = None;
            while let Some(msg) = reader.wait().await {
                match msg {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        let _ = tx.send(ShellEvent::Data(data.to_vec()));
                    }
                    ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                    _ => {}
                }
            }
            let _ = tx.send(ShellEvent::Exit(exit_status));
        });

        Ok((Shell { writer }, rx))
    }

    /// 执行一条命令（不分配 PTY），等它结束后返回全部输出和退出码。
    pub async fn exec(&self, cmd: &str) -> Result<ExecOutput> {
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, cmd).await?;
        // 命令不需要标准输入，先关掉，免得 cat 之类的命令一直等
        channel.eof().await?;

        let mut out = ExecOutput::default();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => out.stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => out.exit_code = Some(exit_status),
                _ => {}
            }
        }
        Ok(out)
    }

    /// SFTP 会话。第一次调用时打开，之后返回同一个。
    pub async fn sftp(&self) -> Result<Sftp> {
        let mut guard = self.sftp.lock().await;
        if let Some(sftp) = guard.as_ref() {
            return Ok(sftp.clone());
        }
        let sftp = Sftp::open(&self.handle).await?;
        *guard = Some(sftp.clone());
        Ok(sftp)
    }

    /// 往返延迟（毫秒）：从发出"打开 channel"请求到收到服务器确认的时间。
    /// 这是一次完整的加密信道请求-应答，包含网络往返和 sshd 的处理时间；
    /// 不需要服务器配合，也不受登录 shell 影响。测完立即关掉这个 channel。
    pub async fn ping(&self) -> Result<f64> {
        let start = now();
        let channel = self.handle.channel_open_session().await?;
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        let _ = channel.close().await;
        Ok(elapsed)
    }

    /// 开始周期采样服务器状态，见 [`monitor::watch`]。
    pub fn watch_monitor(
        self: &Arc<Self>,
        interval: std::time::Duration,
    ) -> (MonitorHandle, mpsc::UnboundedReceiver<MonitorSnapshot>) {
        monitor::watch(self.clone(), interval)
    }

    /// 断开连接。所有 channel 随之关闭，shell 会收到 `Exit`。
    pub async fn disconnect(&self) -> Result<()> {
        self.handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await?;
        Ok(())
    }
}

/// 一个交互式 shell 的写入端；输出从 [`Connection::open_shell`] 返回的接收端读。
pub struct Shell {
    writer: ChannelWriteHalf<Msg>,
}

impl Shell {
    pub async fn write(&self, data: &[u8]) -> Result<()> {
        self.writer.data(data).await?;
        Ok(())
    }

    pub async fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        self.writer.window_change(cols, rows, 0, 0).await?;
        Ok(())
    }

    /// 关闭这个 shell 的 channel（连接保留）。
    pub async fn close(&self) -> Result<()> {
        self.writer.close().await?;
        Ok(())
    }
}

/// 桌面端直连：建立 TCP 连接后交给 [`Connection::connect`]。
#[cfg(not(target_arch = "wasm32"))]
pub async fn connect_tcp(host: &str, port: u16) -> Result<tokio::net::TcpStream> {
    let stream = tokio::net::TcpStream::connect((host, port)).await?;
    // 终端按键是小包，关掉 Nagle 才不会有输入延迟
    stream.set_nodelay(true)?;
    Ok(stream)
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn spawn<F: Future<Output = ()> + Send + 'static>(fut: F) {
    tokio::spawn(fut);
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn spawn<F: Future<Output = ()> + 'static>(fut: F) {
    wasm_bindgen_futures::spawn_local(fut);
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) use std::time::Instant;
#[cfg(target_arch = "wasm32")]
pub(crate) use web_time::Instant;

pub(crate) fn now() -> Instant {
    Instant::now()
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) async fn sleep(d: std::time::Duration) {
    tokio::time::sleep(d).await
}

#[cfg(target_arch = "wasm32")]
pub(crate) async fn sleep(d: std::time::Duration) {
    futures_timer::Delay::new(d).await
}
