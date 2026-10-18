//! 通过会话管理层连真实的 OpenSSH。默认跳过，设置环境变量后运行：
//! SSH_E2E_ADDR=127.0.0.1:2222 SSH_E2E_USER=me SSH_E2E_KEY=/path/to/key cargo test -p evershell-desktop --test session

use std::time::Duration;

use evershell_desktop_lib::session::{ConnectParams, Error, SessionManager};
use ssh_core::{Auth, ShellEvent};
use tokio::sync::mpsc::{self, UnboundedReceiver};

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

#[tokio::test(flavor = "multi_thread")]
async fn real_openssh_through_session_manager() {
    let (Ok(addr), Ok(user), Ok(key)) = (
        std::env::var("SSH_E2E_ADDR"),
        std::env::var("SSH_E2E_USER"),
        std::env::var("SSH_E2E_KEY"),
    ) else {
        eprintln!("跳过：未设置 SSH_E2E_ADDR / SSH_E2E_USER / SSH_E2E_KEY");
        return;
    };
    let (host, port) = addr.rsplit_once(':').unwrap();
    let pem = std::fs::read_to_string(key).unwrap();

    let manager = SessionManager::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let params = ConnectParams {
        host: host.into(),
        port: port.parse().unwrap(),
        user,
        auth: Auth::PrivateKey { pem, passphrase: None },
        cols: 80,
        rows: 24,
    };
    let connected = manager
        .connect(params, move |ev| {
            let _ = tx.send(ev);
        })
        .await
        .unwrap();
    let id = connected.id.clone();
    let fp = connected.fingerprint.expect("应返回服务器指纹");
    assert!(fp.starts_with("SHA256:"), "{fp}");

    manager.write(&id, b"echo M0_$((40+2))\r".to_vec()).unwrap();
    read_until(&mut rx, "M0_42").await;

    // 一条命令逐字节连续投递，中间不等待；顺序一乱 shell 就算不出这个结果
    let cmd = b"echo ORDER_$((1+1))_$((2+2))_$((3+3))_$((4+4))_end\r";
    for byte in cmd {
        manager.write(&id, vec![*byte]).unwrap();
    }
    read_until(&mut rx, "ORDER_2_4_6_8_end").await;

    // resize 和紧随其后的 write 也要保持先后
    manager.resize(&id, 100, 30).unwrap();
    manager.write(&id, b"stty size\r".to_vec()).unwrap();
    read_until(&mut rx, "30 100").await;

    // 监控和 SFTP 走同一条连接上的独立 channel，不影响终端
    let conn = manager.connection(&id).unwrap();
    assert_eq!(conn.exec("echo via_manager").await.unwrap().stdout_lossy(), "via_manager\n");
    assert!(conn.sftp().await.unwrap().home_dir().await.unwrap().starts_with('/'));
    let (snap_tx, mut snap_rx) = mpsc::unbounded_channel();
    manager
        .start_monitor(&id, Duration::from_millis(300), move |s| {
            let _ = snap_tx.send(s);
        })
        .await
        .unwrap();
    let snap = tokio::time::timeout(Duration::from_secs(10), snap_rx.recv()).await.unwrap().unwrap();
    assert!(snap.latency_ms.is_some(), "{snap:?}");
    manager.stop_monitor(&id).unwrap();
    manager.write(&id, b"echo still_$((1+1))\r".to_vec()).unwrap();
    read_until(&mut rx, "still_2").await;

    manager.close(&id).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !matches!(rx.recv().await, Some(ShellEvent::Exit(_)) | None) {}
    })
    .await
    .expect("关闭后应收到 Exit");

    // 会话结束后从表里移除，再操作应报会话不存在
    let removed = tokio::time::timeout(Duration::from_secs(2), async {
        while !matches!(manager.write(&id, Vec::new()), Err(Error::NotFound)) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(removed.is_ok(), "会话结束后应被移除");
    assert!(matches!(manager.connection(&id), Err(Error::NotFound)));
    assert!(matches!(manager.stop_monitor(&id), Err(Error::NotFound)));
}

/// 连不上的地址要把 ssh-core 的中文错误原样带出来
#[tokio::test(flavor = "multi_thread")]
async fn connect_refused_reports_chinese_error() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let manager = SessionManager::new();
    let params = ConnectParams {
        host: "127.0.0.1".into(),
        port,
        user: "nobody".into(),
        auth: Auth::Password("x".into()),
        cols: 80,
        rows: 24,
    };
    let err = manager.connect(params, |_| {}).await.err().unwrap();
    assert!(matches!(err, Error::Ssh(ssh_core::Error::Io(_))), "{err}");
    assert!(err.to_string().starts_with("网络错误"), "{err}");
}
