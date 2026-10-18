//! 用 russh 自带的服务端起一个回显 shell，验证 ssh-core 的握手、认证、PTY、收发、exec、
//! 心跳断线检测和终端输出回压。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::private::{KeypairData, RsaKeypair};
use russh::keys::{Algorithm, PrivateKey, PublicKey};
use russh::server::{self, Msg, Server as _, Session};
use russh::{Channel, ChannelId, Pty};
use ssh_core::{
    Auth, ConnectConfig, Connection, Error, HostKey, HostKeyCheck, HostKeyProblem, OUTPUT_ACK_BATCH,
    OUTPUT_HIGH_WATER, OutputAck, Shell, ShellEvent, connect_tcp, known_hosts,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};
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
    /// 收到过几次密码认证请求
    password_attempts: Arc<std::sync::atomic::AtomicUsize>,
    /// 收到 Ctrl-C 时置位，让 flood 停下
    interrupted: Arc<AtomicBool>,
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
        self.password_attempts.fetch_add(1, Ordering::SeqCst);
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
        // 像 `yes` 一样不停地输出，窗口用完就等客户端补窗口；收到 Ctrl-C 停下并打印 STOPPED
        if data == b"flood\r" {
            let handle = session.handle();
            let interrupted = self.interrupted.clone();
            interrupted.store(false, Ordering::SeqCst);
            tokio::spawn(async move {
                let chunk = "y\r\n".repeat(4096).into_bytes();
                while !interrupted.load(Ordering::SeqCst) {
                    if handle.data(channel, chunk.clone()).await.is_err() {
                        return;
                    }
                }
                let _ = handle.data(channel, b"^C\r\nSTOPPED\r\n".to_vec()).await;
            });
            return Ok(());
        }
        if data == b"\x03" {
            self.interrupted.store(true, Ordering::SeqCst);
            return Ok(());
        }
        session.data(channel, data.to_vec())?;
        Ok(())
    }
}

async fn start_server() -> u16 {
    start_server_counting().await.0
}

/// 同 start_server，另外返回密码认证次数的计数器
async fn start_server_counting() -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
    let config = Arc::new(server::Config {
        keys: vec![keys().host.clone()],
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let mut server = EchoServer {
        allowed_keys: vec![keys().ed25519.public_key().clone(), keys().rsa.public_key().clone()],
        interrupted: Arc::new(AtomicBool::new(false)),
        password_attempts: Default::default(),
    };
    let attempts = server.password_attempts.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { server.run_on_socket(config, &listener).await });
    (port, attempts)
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

fn accept_any() -> ConnectConfig {
    ConnectConfig::new(HostKeyCheck::AcceptAny)
}

async fn connect(port: u16, auth: Auth) -> ssh_core::Result<Connection> {
    let stream = connect_tcp("127.0.0.1", port).await?;
    Connection::connect(stream, "tester", auth, &ConnectConfig::new(HostKeyCheck::AcceptAny)).await
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
            if let Some(ShellEvent::Exit { code, .. }) = rx.recv().await {
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
        while !matches!(rx.recv().await, Some(ShellEvent::Exit { .. }) | None) {}
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
    let conn = Connection::connect(stream, &user, Auth::PrivateKey { pem, passphrase: None }, &accept_any())
        .await
        .unwrap();
    let (shell, mut rx) = open_shell(&conn).await;
    shell.write(b"stty size; echo M0_$((40+2))\r").await.unwrap();
    let out = read_until(&mut rx, "M0_42").await;
    assert!(out.contains("24 80"), "PTY 尺寸应为 24x80: {out:?}");
    shell.write(b"exit\r").await.unwrap();
}

// ---------- 心跳 ----------

/// 在客户端和服务器之间转发字节。`cut` 置位后两个方向的数据都扔掉、但连接不关，
/// 就像换 Wi-Fi、合盖睡眠、NAT 超时后那样：没有任何报错，只是再也收不到东西
async fn start_blackhole_proxy(target: u16) -> (u16, Arc<AtomicBool>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let cut = Arc::new(AtomicBool::new(false));
    let cut2 = cut.clone();
    tokio::spawn(async move {
        let (client, _) = listener.accept().await.unwrap();
        let server = TcpStream::connect(("127.0.0.1", target)).await.unwrap();
        let (cr, cw) = client.into_split();
        let (sr, sw) = server.into_split();
        tokio::spawn(pipe(cr, sw, cut2.clone()));
        tokio::spawn(pipe(sr, cw, cut2));
    });
    (port, cut)
}

async fn pipe(mut from: OwnedReadHalf, mut to: OwnedWriteHalf, cut: Arc<AtomicBool>) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match from.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        if cut.load(Ordering::SeqCst) {
            continue;
        }
        if to.write_all(&buf[..n]).await.is_err() {
            return;
        }
    }
}

#[tokio::test]
async fn keepalive_detects_silent_dead_link() {
    let port = start_server().await;
    let (proxy, cut) = start_blackhole_proxy(port).await;
    let stream = connect_tcp("127.0.0.1", proxy).await.unwrap();
    let cfg = ConnectConfig {
        keepalive_interval: Some(Duration::from_millis(200)),
        keepalive_max: 2,
        ..accept_any()
    };
    let conn = Connection::connect(stream, "tester", Auth::Password("secret".into()), &cfg)
        .await
        .unwrap();
    let (shell, mut rx) = open_shell(&conn).await;
    read_until(&mut rx, "pty").await;

    // 网络正常时服务器会回应心跳，空闲再久也不会误判断线
    tokio::time::sleep(Duration::from_millis(1500)).await;
    shell.write(b"still here").await.unwrap();
    read_until(&mut rx, "still here").await;

    cut.store(true, Ordering::SeqCst);
    let cut_at = Instant::now();
    let (code, reason) = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Some(ShellEvent::Exit { code, reason }) => return (code, reason),
                Some(ShellEvent::Data(_)) => {}
                None => panic!("没收到 Exit 就结束了"),
            }
        }
    })
    .await
    .expect("网络断了应该判定断线，而不是一直挂着");
    let elapsed = cut_at.elapsed();

    assert_eq!(code, None);
    let reason = reason.expect("断线要带原因");
    assert!(reason.contains("没有收到服务器响应"), "{reason}");
    // 静默 200ms 发一次心跳，两次没回应、第三次到点判死：约 600ms
    assert!((Duration::from_millis(400)..Duration::from_secs(2)).contains(&elapsed), "{elapsed:?}");
}

#[tokio::test]
async fn closing_normally_has_no_reason() {
    let port = start_server().await;
    let conn = connect(port, Auth::Password("secret".into())).await.unwrap();
    let (shell, mut rx) = open_shell(&conn).await;
    shell.write(b"exit\r").await.unwrap();
    let reason = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(ShellEvent::Exit { reason, .. }) = rx.recv().await {
                return reason;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(reason, None, "正常退出不应显示断线原因");

    // 自己断开整条连接也不算异常
    let (_shell, mut rx) = open_shell(&conn).await;
    conn.disconnect().await.unwrap();
    let reason = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Some(ShellEvent::Exit { reason, .. }) => return reason,
                Some(_) => {}
                None => return None,
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(reason, None);
}

// ---------- 回压 ----------

/// 模拟界面：按 `bytes_per_sec` 的速度“画”收到的输出，和前端一样攒够一批再回执。
/// 顺便记下排队等着画的消息最多有几条
struct SlowTerminal {
    ack: OutputAck,
    bytes_per_sec: f64,
    pending_ack: usize,
    max_queued: usize,
    /// 欠下的“画字时间”。OpenSSH 每条消息只有一两 KB，逐条 sleep 会被定时器的 1ms 精度拖成龟速，
    /// 攒够几毫秒再睡一次，平均速度才准
    owed: Duration,
}

impl SlowTerminal {
    fn new(ack: OutputAck, bytes_per_sec: f64) -> Self {
        Self { ack, bytes_per_sec, pending_ack: 0, max_queued: 0, owed: Duration::ZERO }
    }

    async fn take(&mut self, data: &[u8]) {
        self.owed += Duration::from_secs_f64(data.len() as f64 / self.bytes_per_sec);
        if self.owed >= Duration::from_millis(5) {
            let started = Instant::now();
            tokio::time::sleep(self.owed).await;
            self.owed = self.owed.saturating_sub(started.elapsed());
        }
        self.pending_ack += data.len();
        if self.pending_ack >= OUTPUT_ACK_BATCH {
            self.ack.ack(self.pending_ack);
            self.pending_ack = 0;
        }
    }

    /// 一直收，直到输出里出现 `needle`（或 `limit` 到时），返回收到的字节数
    async fn until(&mut self, rx: &mut UnboundedReceiver<ShellEvent>, needle: &str, limit: Duration) -> usize {
        let mut tail = String::new();
        let mut total = 0;
        let deadline = Instant::now() + limit;
        loop {
            // 数据源源不断时 timeout(0, recv) 也会立刻拿到数据，得自己看钟
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                assert!(needle.is_empty(), "等 {needle:?} 超时");
                return total;
            }
            self.max_queued = self.max_queued.max(rx.len());
            match tokio::time::timeout(left, rx.recv()).await {
                Ok(Some(ShellEvent::Data(d))) => {
                    total += d.len();
                    self.take(&d).await;
                    tail.push_str(&String::from_utf8_lossy(&d));
                    if !needle.is_empty() && tail.contains(needle) {
                        return total;
                    }
                    // 只留末尾一点，够匹配就行
                    if tail.len() > 4096 {
                        tail = tail.split_off(tail.len() - 64);
                    }
                }
                Ok(other) => panic!("意外的事件 {other:?}"),
                Err(_) => {
                    assert!(needle.is_empty(), "等 {needle:?} 超时");
                    return total;
                }
            }
        }
    }
}

#[tokio::test]
async fn unacked_output_pauses_reading() {
    let port = start_server().await;
    let conn = connect(port, Auth::Password("secret".into())).await.unwrap();
    let (shell, mut rx) = open_shell(&conn).await;
    read_until(&mut rx, "pty").await;

    shell.write(b"flood\r").await.unwrap();
    // 一直不回执：收到的量停在水位线附近，不会无限涨
    let mut got = 0;
    while let Ok(Some(ShellEvent::Data(d))) = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
        got += d.len();
    }
    assert!(
        (OUTPUT_HIGH_WATER..=OUTPUT_HIGH_WATER + 64 * 1024).contains(&got),
        "不回执时应停在 {OUTPUT_HIGH_WATER} 字节附近，实际 {got}"
    );

    // 一回执就继续
    shell.output_ack().ack(got);
    let more = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap();
    assert!(matches!(more, Some(ShellEvent::Data(_))), "{more:?}");

    // 暂停着也能正常关掉（关之前放开限速）
    shell.output_ack().release();
    conn.disconnect().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !matches!(rx.recv().await, Some(ShellEvent::Exit { .. }) | None) {}
    })
    .await
    .expect("暂停时关闭不应卡住");
}

#[tokio::test]
async fn ctrl_c_stops_flood_quickly_with_slow_terminal() {
    let port = start_server().await;
    let conn = connect(port, Auth::Password("secret".into())).await.unwrap();
    let (shell, mut rx) = open_shell(&conn).await;
    read_until(&mut rx, "pty").await;

    // 界面每秒只画 10 MB（xterm.js 的保守速度）
    let mut term = SlowTerminal::new(shell.output_ack(), 10e6);
    shell.write(b"flood\r").await.unwrap();
    term.until(&mut rx, "", Duration::from_secs(2)).await;

    shell.write(b"\x03").await.unwrap();
    let pressed = Instant::now();
    term.until(&mut rx, "STOPPED", Duration::from_secs(10)).await;
    let latency = pressed.elapsed();

    assert!(latency < Duration::from_secs(1), "Ctrl-C 后 {latency:?} 才停");
    // 每条最多 16 KB，水位线 256 KB：排队的不该超过二十来条
    assert!(term.max_queued <= OUTPUT_HIGH_WATER / (12 * 1024) + 4, "排队 {} 条", term.max_queued);
}

/// 连本机 OpenSSH 跑真的 `yes`：界面按 10 MB/s 画、按批回执，跑 10 秒后按 Ctrl-C，1 秒内要停。
/// 设置 SSH_E2E_* 后运行（见 real_openssh）。EVERSHELL_NO_FLOW=1 时不限速，用来对比改之前的表现
#[tokio::test]
async fn real_openssh_yes_then_ctrl_c() {
    let (Ok(addr), Ok(user), Ok(key)) = (
        std::env::var("SSH_E2E_ADDR"),
        std::env::var("SSH_E2E_USER"),
        std::env::var("SSH_E2E_KEY"),
    ) else {
        eprintln!("跳过：未设置 SSH_E2E_ADDR / SSH_E2E_USER / SSH_E2E_KEY");
        return;
    };
    let secs: u64 = std::env::var("EVERSHELL_YES_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(10);
    let no_flow = std::env::var("EVERSHELL_NO_FLOW").is_ok();
    let (host, port) = addr.rsplit_once(':').unwrap();
    let stream = connect_tcp(host, port.parse().unwrap()).await.unwrap();
    let pem = std::fs::read_to_string(key).unwrap();
    let conn = Connection::connect(stream, &user, Auth::PrivateKey { pem, passphrase: None }, &accept_any())
        .await
        .unwrap();
    let (shell, mut rx) = open_shell(&conn).await;
    if no_flow {
        shell.output_ack().release();
    }
    let mut term = SlowTerminal::new(shell.output_ack(), 10e6);
    shell.write(b"stty -echoctl; yes\r").await.unwrap();
    let during = term.until(&mut rx, "", Duration::from_secs(secs)).await;

    // Ctrl-C 之后马上打一行标记，看到标记就说明 yes 已经停了、积压的输出也画完了
    shell.write(b"\x03").await.unwrap();
    let pressed = Instant::now();
    shell.write(b"echo FLOW_$((40+2))_DONE\r").await.unwrap();
    let after = term.until(&mut rx, "FLOW_42_DONE", Duration::from_secs(120)).await;
    let latency = pressed.elapsed();
    eprintln!(
        "yes {secs} 秒：期间画了 {:.1} MB，按 Ctrl-C 后又画了 {:.1} MB、用了 {latency:?}；最多排队 {} 条{}",
        during as f64 / 1e6,
        after as f64 / 1e6,
        term.max_queued,
        if no_flow { "（未限速）" } else { "" }
    );
    shell.write(b"exit\r").await.unwrap();
    if !no_flow {
        assert!(latency < Duration::from_secs(1), "Ctrl-C 后 {latency:?} 才停");
    }
}

// ---------- 指纹校验 ----------

async fn connect_checked(port: u16, known_hosts: &str) -> ssh_core::Result<Connection> {
    let stream = connect_tcp("127.0.0.1", port).await?;
    let cfg = ConnectConfig::new(HostKeyCheck::KnownHosts {
        host: "127.0.0.1".into(),
        port,
        known_hosts: known_hosts.into(),
    });
    Connection::connect(stream, "tester", Auth::Password("secret".into()), &cfg).await
}

fn server_host_key() -> HostKey {
    HostKey::from_public_key(keys().host.public_key())
}

#[tokio::test]
async fn unknown_server_stops_before_password_is_sent() {
    let (port, attempts) = start_server_counting().await;
    let err = connect_checked(port, "").await.err().expect("没记过的服务器不能直接连上");
    let Error::HostKey(problem) = err else { panic!("应是指纹问题：{err}") };
    let HostKeyProblem::Unknown { host, port: p, key, other_types } = *problem else {
        panic!("应是首次连接：{problem}");
    };
    assert_eq!((host.as_str(), p), ("127.0.0.1", port));
    assert_eq!(key, server_host_key());
    assert!(other_types.is_empty());
    assert_eq!(attempts.load(Ordering::SeqCst), 0, "指纹没确认之前不能把密码发出去");

    // 记下以后就能连上，密码这时才发出去
    let line = known_hosts::line_for("127.0.0.1", port, &key);
    let conn = connect_checked(port, &format!("# 别的记录\nother.example {}\n{line}\n", key.openssh)).await.unwrap();
    assert_eq!(conn.host_key_fingerprint(), Some(key.fingerprint.as_str()));
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn changed_or_revoked_key_is_blocked() {
    let (port, attempts) = start_server_counting().await;
    // 记录里同一台服务器是另一把 Ed25519：指纹变了
    let other = HostKey::from_public_key(keys().ed25519.public_key());
    let recorded = known_hosts::line_for("127.0.0.1", port, &other);
    let Error::HostKey(problem) = connect_checked(port, &recorded).await.err().unwrap() else {
        panic!("应是指纹问题");
    };
    match *problem {
        HostKeyProblem::Changed { key, recorded: r, .. } => {
            assert_eq!(key, server_host_key());
            assert_eq!(r.len(), 1);
            assert_eq!(r[0].key, other);
            assert_eq!(r[0].line, recorded);
            assert!(r[0].exact);
        }
        e => panic!("应是指纹变了：{e}"),
    }

    // 吊销：哪怕同时也记着它，也不能连
    let host = server_host_key();
    let kh = format!("{}\n@revoked * {}\n", known_hosts::line_for("127.0.0.1", port, &host), host.openssh);
    let err = connect_checked(port, &kh).await.err().unwrap();
    assert!(matches!(&err, Error::HostKey(p) if matches!(**p, HostKeyProblem::Revoked { .. })), "{err}");
    assert_eq!(attempts.load(Ordering::SeqCst), 0, "被拦下时不能发出密码");
}

#[test]
fn host_key_problem_serializes_for_the_ui() {
    let key = server_host_key();
    let json = serde_json::to_value(HostKeyProblem::Unknown {
        host: "h".into(),
        port: 22,
        key: key.clone(),
        other_types: vec![],
    })
    .unwrap();
    assert_eq!(json["kind"], "unknown");
    assert_eq!(json["key"]["fingerprint"], key.fingerprint.as_str());
    assert_eq!(json["otherTypes"], serde_json::json!([]));
}
