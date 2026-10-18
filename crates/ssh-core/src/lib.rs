//! SSH 内核。
//!
//! 只依赖一条双向字节流，不关心它从哪来：桌面端传 TCP 连接，
//! 网页端传由 WebSocket 中转适配出来的流。同一份代码在原生和 WASM 下都能编译。
//!
//! 一条 [`Connection`] 完成握手和认证后，可以在上面打开交互 shell、执行命令、
//! 开 SFTP 会话和监控采样，它们各自走独立的 SSH channel，互不干扰。

mod flow;
pub mod known_hosts;
pub mod monitor;
pub mod sftp;

use std::borrow::Cow;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, DisconnectReason, Handle, Msg};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate, decode_secret_key};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect, Preferred};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

pub use flow::{OUTPUT_ACK_BATCH, OUTPUT_HIGH_WATER, OutputAck};
pub use known_hosts::{HostKey, KnownEntry};
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
    /// 服务器指纹没通过校验，连接在发送密码之前就停下了。界面据此弹确认框或警告
    #[error("{0}")]
    HostKey(Box<HostKeyProblem>),
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
    /// 远端输出，stdout 和 stderr 合在一起，与真实终端一致。界面处理完要回执，见 [`OutputAck`]
    Data(Vec<u8>),
    /// 会话结束。`code` 是远端给的退出码（没给时为 None）；
    /// `reason` 是整条连接断掉的原因（心跳超时、服务器断开、网络出错），正常退出或自己关闭时为 None
    Exit { code: Option<u32>, reason: Option<String> },
}

/// 怎么校验服务器指纹
#[derive(Debug, Clone)]
pub enum HostKeyCheck {
    /// 按 known_hosts 记录校验（OpenSSH 格式，见 [`known_hosts`]）。
    /// 没记过、对不上、被吊销都会在发送密码之前中止，返回 [`Error::HostKey`]
    KnownHosts {
        host: String,
        port: u16,
        known_hosts: String,
    },
    /// 什么钥匙都接受、只记下指纹。只给连本机测试服务器的测试用，正式连接不能用
    AcceptAny,
}

/// 指纹校验没通过的具体情况
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HostKeyProblem {
    /// 第一次连这台服务器。`other_types`：记过的其它类型的钥匙（通常为空）
    Unknown {
        host: String,
        port: u16,
        key: HostKey,
        other_types: Vec<KnownEntry>,
    },
    /// 和记过的同类型钥匙对不上
    Changed {
        host: String,
        port: u16,
        key: HostKey,
        recorded: Vec<KnownEntry>,
    },
    /// 这把钥匙在记录里被标为吊销
    Revoked { host: String, port: u16, key: HostKey },
}

impl std::fmt::Display for HostKeyProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unknown { .. } => "需要确认主机密钥",
            Self::Changed { .. } => "主机密钥已改变，已取消连接",
            Self::Revoked { .. } => "主机密钥已被吊销，已取消连接",
        })
    }
}

/// 连接参数里除了地址和认证以外的部分
#[derive(Debug, Clone)]
pub struct ConnectConfig {
    pub host_key: HostKeyCheck,
    /// 多久没收到服务器的任何数据就发一次心跳；None 表示不发
    pub keepalive_interval: Option<Duration>,
    /// 连续几次心跳没有回应就判定断线
    pub keepalive_max: usize,
}

impl ConnectConfig {
    /// 心跳和 OpenSSH 的 `ServerAliveInterval 15`、`ServerAliveCountMax 3` 一样：
    /// 静默 15 秒发一次，三次都没回应、第四次到点时判定断线（约 1 分钟）。
    /// 心跳走加密通道，不会像 TCP keepalive 那样被中间设备伪造
    pub fn new(host_key: HostKeyCheck) -> Self {
        Self {
            host_key,
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
        }
    }

    /// 从服务器最后一次有动静到判定断线大约多久
    fn dead_after(&self) -> Option<Duration> {
        self.keepalive_interval
            .map(|i| i * (self.keepalive_max as u32 + 1))
    }
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
    host_key: HostKeyCheck,
    /// 指纹没通过时的详情，连接失败后转成 Error::HostKey
    problem: Arc<Mutex<Option<HostKeyProblem>>>,
    fingerprint: Arc<Mutex<Option<String>>>,
    /// 连接断掉的原因，由 russh 在会话结束、关闭各 channel 之前写入
    close_reason: Arc<Mutex<Option<String>>>,
    dead_after: Option<Duration>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        // 默认不请求证书（Preferred::host_key_certificates 为空），服务器给的是普通公钥；
        // 真给了证书也只按里面的公钥校验，不认证书机构
        let server = server_key.public_key();
        *self.fingerprint.lock().unwrap() = Some(server.fingerprint(HashAlg::Sha256).to_string());
        let HostKeyCheck::KnownHosts { host, port, known_hosts } = &self.host_key else {
            return Ok(true);
        };
        let (host, port, key) = (host.clone(), *port, HostKey::from_public_key(&server));
        let problem = match known_hosts::check(known_hosts, &host, port, &server) {
            known_hosts::Verdict::Trusted => return Ok(true),
            known_hosts::Verdict::Unknown { other_types } => HostKeyProblem::Unknown { host, port, key, other_types },
            known_hosts::Verdict::Changed { recorded } => HostKeyProblem::Changed { host, port, key, recorded },
            known_hosts::Verdict::Revoked => HostKeyProblem::Revoked { host, port, key },
        };
        log::warn!("服务器指纹没通过校验：{problem}");
        *self.problem.lock().unwrap() = Some(problem);
        Ok(false)
    }

    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> std::result::Result<(), Self::Error> {
        let text = match &reason {
            DisconnectReason::ReceivedDisconnect(info) if info.message.is_empty() => {
                Some("服务器断开了连接".to_string())
            }
            DisconnectReason::ReceivedDisconnect(info) => {
                Some(format!("服务器断开了连接：{}", info.message))
            }
            // 自己调 disconnect() 结束时 russh 也走这里，不算异常
            DisconnectReason::Error(russh::Error::Disconnect) => None,
            DisconnectReason::Error(russh::Error::KeepaliveTimeout) => Some(match self.dead_after {
                Some(d) => format!(
                    "{}没有收到服务器响应，可能网络断了或电脑休眠过",
                    describe_secs(d.as_secs())
                ),
                None => "服务器没有响应心跳，可能网络断了".to_string(),
            }),
            DisconnectReason::Error(russh::Error::IO(e)) => Some(format!("网络连接中断：{e}")),
            DisconnectReason::Error(e) => Some(format!("连接出错：{e}")),
        };
        if let Some(text) = text {
            log::info!("连接断开：{text}");
            *self.close_reason.lock().unwrap() = Some(text);
        }
        Ok(())
    }
}

/// 记录里有这台服务器的钥匙时，让服务器优先出示那些类型（其余顺序照 russh 默认），
/// 免得记的是 RSA、服务器默认先给 Ed25519，被当成没见过的服务器
fn preferred_for(check: &HostKeyCheck) -> Preferred {
    let mut preferred = Preferred::default();
    if let HostKeyCheck::KnownHosts { host, port, known_hosts } = check {
        let known = known_hosts::known_algorithms(known_hosts, host, *port);
        if !known.is_empty() {
            let is_known = |a: &russh::keys::Algorithm| known.iter().any(|k| known_hosts::same_family(k.clone(), a));
            let (mut first, rest): (Vec<_>, Vec<_>) = preferred.key.iter().cloned().partition(is_known);
            first.extend(rest);
            preferred.key = Cow::Owned(first);
        }
    }
    preferred
}

/// 60 → "约 1 分钟"，45 → "45 秒"
fn describe_secs(secs: u64) -> String {
    if secs >= 60 && secs.is_multiple_of(60) {
        format!("约 {} 分钟", secs / 60)
    } else {
        format!("{secs} 秒")
    }
}

/// 一条已登录的 SSH 连接。
pub struct Connection {
    handle: Handle<Client>,
    host_key_fingerprint: Option<String>,
    close_reason: Arc<Mutex<Option<String>>>,
    // SFTP 会话按需打开一次，之后共用
    sftp: tokio::sync::Mutex<Option<Sftp>>,
}

impl Connection {
    /// 在给定的字节流上完成 SSH 握手、指纹校验和认证。
    /// 指纹没通过时在发送密码之前就返回 [`Error::HostKey`]。
    pub async fn connect<S>(stream: S, user: &str, auth: Auth, cfg: &ConnectConfig) -> Result<Self>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let config = Arc::new(client::Config {
            keepalive_interval: cfg.keepalive_interval,
            keepalive_max: cfg.keepalive_max,
            preferred: preferred_for(&cfg.host_key),
            ..Default::default()
        });
        let problem = Arc::new(Mutex::new(None));
        let fingerprint = Arc::new(Mutex::new(None));
        let close_reason = Arc::new(Mutex::new(None));
        let client = Client {
            host_key: cfg.host_key.clone(),
            problem: problem.clone(),
            fingerprint: fingerprint.clone(),
            close_reason: close_reason.clone(),
            dead_after: cfg.dead_after(),
        };
        let mut handle = match client::connect_stream(config, stream, client).await {
            Ok(h) => h,
            Err(e) => {
                return Err(match problem.lock().unwrap().take() {
                    Some(p) => Error::HostKey(Box::new(p)),
                    None => e.into(),
                });
            }
        };

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
            close_reason,
            sftp: tokio::sync::Mutex::new(None),
        })
    }

    /// 服务器公钥的 SHA256 指纹，格式同 `ssh-keygen -l`
    pub fn host_key_fingerprint(&self) -> Option<&str> {
        self.host_key_fingerprint.as_deref()
    }

    /// 打开一个分配了 PTY 的交互式 shell。远端输出通过返回的接收端逐条送出。
    ///
    /// 收到的每条 [`ShellEvent::Data`] 处理完都要用 [`Shell::output_ack`] 回执，
    /// 没回执的输出超过 [`OUTPUT_HIGH_WATER`] 就不再往下读，直到回执或 [`OutputAck::release`]。
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

        // 接收端不设上限：积压的量由回执控制，最多 OUTPUT_HIGH_WATER 加一条消息
        let (tx, rx) = mpsc::unbounded_channel();
        let ack = OutputAck::default();
        let flow = ack.clone();
        let close_reason = self.close_reason.clone();
        spawn(async move {
            let mut exit_status = None;
            loop {
                tokio::select! {
                    _ = flow.wait_room() => {}
                    // 没人收输出了，不必再读
                    _ = tx.closed() => break,
                }
                let Some(msg) = reader.wait().await else { break };
                match msg {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        flow.sent(data.len());
                        let _ = tx.send(ShellEvent::Data(data.to_vec()));
                    }
                    ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                    _ => {}
                }
            }
            // 连接断掉时 russh 先记下原因再关 channel，走到这里原因已经在了
            let reason = close_reason.lock().unwrap().clone();
            let _ = tx.send(ShellEvent::Exit { code: exit_status, reason });
        });

        Ok((Shell { writer, ack }, rx))
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
    ack: OutputAck,
}

impl Shell {
    /// 回执输出用的句柄，见 [`OutputAck`]
    pub fn output_ack(&self) -> OutputAck {
        self.ack.clone()
    }

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
