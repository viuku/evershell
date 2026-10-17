//! 用 russh 自带的服务端起一个回显 shell，验证 ssh-core 的握手、认证、PTY、收发和 exec。

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::private::{KeypairData, RsaKeypair};
use russh::keys::{Algorithm, PrivateKey, PublicKey};
use russh::server::{self, Msg, Server as _, Session};
use russh::{Channel, ChannelId, Pty};
use ssh_core::{Auth, Connection, Error, Shell, ShellEvent, connect_tcp};
use tokio::net::TcpListener;
use tokio::sync::mpsc::UnboundedReceiver;

/// 测试密钥在运行时现场生成，仓库里不放私钥
struct TestKeys {
    host: PrivateKey,
    ed25519: PrivateKey,
    rsa: PrivateKey,
}

fn keys() -> &'static TestKeys {
    static KEYS: OnceLock<TestKeys> = OnceLock::new();
    KEYS.get_or_init(|| {
        let mut rng = rand::rng();
        let rsa = RsaKeypair::random(&mut rng, 2048).unwrap();
        TestKeys {
            host: PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap(),
            ed25519: PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap(),
            rsa: PrivateKey::new(KeypairData::from(rsa), "test").unwrap(),
        }
    })
}

fn pem(key: &PrivateKey) -> String {
    key.to_openssh(LineEnding::LF).unwrap().to_string()
}

#[derive(Clone)]
struct EchoServer {
    allowed_keys: Vec<PublicKey>,
}

impl server::Server for EchoServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl server::Handler for EchoServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<server::Auth, Self::Error> {
        if user == "tester" && password == "secret" {
            Ok(server::Auth::Accept)
        } else {
            Ok(server::Auth::reject())
        }
    }

    async fn auth_publickey(&mut self, _: &str, key: &PublicKey) -> Result<server::Auth, Self::Error> {
        if self.allowed_keys.iter().any(|k| k.key_data() == key.key_data()) {
            Ok(server::Auth::Accept)
        } else {
            Ok(server::Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        _: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, format!("pty {term} {cols}x{rows}\r\n").into_bytes())?;
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(channel, format!("resize {cols}x{rows}\r\n").into_bytes())?;
        Ok(())
    }

    /// exec：把命令原样回显到 stdout，"ERR" 回显到 stderr，退出码 5
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, data.to_vec())?;
        session.extended_data(channel, 1, b"ERR".to_vec())?;
        session.exit_status_request(channel, 5)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }

    /// 像 OpenSSH 一样，对不认识的子系统回 failure
    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        _: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        if data == b"exit\r" {
            session.exit_status_request(channel, 7)?;
            session.close(channel)?;
            return Ok(());
        }
        session.data(channel, data.to_vec())?;
        Ok(())
    }
}

async fn start_server() -> u16 {
    let config = Arc::new(server::Config {
        keys: vec![keys().host.clone()],
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let mut server = EchoServer {
        allowed_keys: vec![keys().ed25519.public_key().clone(), keys().rsa.public_key().clone()],
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { server.run_on_socket(config, &listener).await });
    port
}

/// 一直读，直到累计输出里出现 `needle`
async fn read_until(rx: &mut UnboundedReceiver<ShellEvent>, needle: &str) -> String {
    let mut out = String::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !out.contains(needle) {
            match rx.recv().await {
                Some(ShellEvent::Data(d)) => out.push_str(&String::from_utf8_lossy(&d)),
                other => panic!("在收到 {needle:?} 之前遇到 {other:?}，已收到: {out:?}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("等待 {needle:?} 超时，已收到: {out:?}"));
    out
}

async fn connect(port: u16, auth: Auth) -> ssh_core::Result<Connection> {
    let stream = connect_tcp("127.0.0.1", port).await?;
    Connection::connect(stream, "tester", auth).await
}

async fn open_shell(conn: &Connection) -> (Shell, UnboundedReceiver<ShellEvent>) {
    conn.open_shell("xterm-256color", 80, 24).await.unwrap()
}

#[tokio::test]
async fn password_login_echo_resize_and_exit() {
    let port = start_server().await;
    let conn = connect(port, Auth::Password("secret".into())).await.unwrap();

    let fp = conn.host_key_fingerprint().expect("应记录服务器指纹");
    assert!(fp.starts_with("SHA256:"), "{fp}");

    let (shell, mut rx) = open_shell(&conn).await;
    read_until(&mut rx, "pty xterm-256color 80x24").await;

    shell.write(b"hello").await.unwrap();
    read_until(&mut rx, "hello").await;

    shell.resize(120, 40).await.unwrap();
    read_until(&mut rx, "resize 120x40").await;

    shell.write(b"exit\r").await.unwrap();
    let exit = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(ShellEvent::Exit(code)) = rx.recv().await {
                return code;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(exit, Some(7));

    // shell 结束了，连接还在，还能继续执行命令
    let out = conn.exec("after").await.unwrap();
    assert_eq!(out.stdout_lossy(), "after");
    conn.disconnect().await.unwrap();
}

#[tokio::test]
async fn wrong_password_is_auth_failed() {
    let port = start_server().await;
    let err = connect(port, Auth::Password("nope".into())).await.err().unwrap();
    assert!(matches!(err, Error::AuthFailed), "{err}");
}

#[tokio::test]
async fn ed25519_and_rsa_key_login() {
    let port = start_server().await;
    for pem in [pem(&keys().ed25519), pem(&keys().rsa)] {
        let auth = Auth::PrivateKey { pem, passphrase: None };
        let conn = connect(port, auth).await.unwrap();
        let (shell, mut rx) = open_shell(&conn).await;
        shell.write(b"ping").await.unwrap();
        read_until(&mut rx, "ping").await;
        conn.disconnect().await.unwrap();
    }
}

#[tokio::test]
async fn exec_collects_stdout_stderr_and_exit_code() {
    let port = start_server().await;
    let conn = connect(port, Auth::Password("secret".into())).await.unwrap();
    let out = conn.exec("echo hi").await.unwrap();
    assert_eq!(out.stdout_lossy(), "echo hi");
    assert_eq!(out.stderr, b"ERR");
    assert_eq!(out.exit_code, Some(5));

    // 同一条连接上 shell 和 exec 可以并存
    let (shell, mut rx) = open_shell(&conn).await;
    let out = conn.exec("again").await.unwrap();
    assert_eq!(out.stdout_lossy(), "again");
    shell.write(b"still alive").await.unwrap();
    read_until(&mut rx, "still alive").await;

    // 延迟测的是开 channel 的往返，回环网络上应该很小但非负
    let ms = conn.ping().await.unwrap();
    assert!((0.0..1000.0).contains(&ms), "{ms}");

    // 关掉 shell channel 后收到 Exit，连接仍可用
    shell.close().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !matches!(rx.recv().await, Some(ShellEvent::Exit(_)) | None) {}
    })
    .await
    .unwrap();
    assert_eq!(conn.exec("x").await.unwrap().exit_code, Some(5));
}

/// 回显服务端没有 sftp 子系统，应立刻报错而不是等超时
#[tokio::test]
async fn sftp_on_server_without_subsystem_fails_fast() {
    let port = start_server().await;
    let conn = connect(port, Auth::Password("secret".into())).await.unwrap();
    let err = tokio::time::timeout(Duration::from_secs(3), conn.sftp())
        .await
        .expect("不应等到超时")
        .err()
        .unwrap();
    assert!(err.to_string().contains("不支持 SFTP"), "{err}");
}

/// 连真实的 OpenSSH。默认跳过，设置环境变量后运行：
/// SSH_E2E_ADDR=127.0.0.1:2222 SSH_E2E_USER=me SSH_E2E_KEY=/path/to/key cargo test -p ssh-core real_openssh
#[tokio::test]
async fn real_openssh() {
    let (Ok(addr), Ok(user), Ok(key)) = (
        std::env::var("SSH_E2E_ADDR"),
        std::env::var("SSH_E2E_USER"),
        std::env::var("SSH_E2E_KEY"),
    ) else {
        eprintln!("跳过：未设置 SSH_E2E_ADDR / SSH_E2E_USER / SSH_E2E_KEY");
        return;
    };
    let (host, port) = addr.rsplit_once(':').unwrap();
    let stream = connect_tcp(host, port.parse().unwrap()).await.unwrap();
    let pem = std::fs::read_to_string(key).unwrap();
    let conn = Connection::connect(stream, &user, Auth::PrivateKey { pem, passphrase: None })
        .await
        .unwrap();
    let (shell, mut rx) = open_shell(&conn).await;
    shell.write(b"stty size; echo M0_$((40+2))\r").await.unwrap();
    let out = read_until(&mut rx, "M0_42").await;
    assert!(out.contains("24 80"), "PTY 尺寸应为 24x80: {out:?}");
    shell.write(b"exit\r").await.unwrap();
}
