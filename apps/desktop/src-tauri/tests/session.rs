//! 通过会话管理层连真实的 OpenSSH。默认跳过，设置环境变量后运行：
//! SSH_E2E_ADDR=127.0.0.1:2222 SSH_E2E_USER=me SSH_E2E_KEY=/path/to/key cargo test -p evershell-desktop --test session

use std::time::{Duration, Instant};

use evershell_desktop_lib::session::{ConnectParams, Error, SessionManager};
use ssh_core::{Auth, HostKeyProblem, MonitorDetail, OUTPUT_ACK_BATCH, OUTPUT_HIGH_WATER, ShellEvent, known_hosts};
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
    let params = |known_hosts: String| ConnectParams {
        host: host.into(),
        port: port.parse().unwrap(),
        user: user.clone(),
        auth: Auth::PrivateKey { pem: pem.clone(), passphrase: None },
        cols: 80,
        rows: 24,
        known_hosts,
    };

    // 没记过这台服务器：连接在认证之前停下，带回服务器的指纹
    let err = manager.connect(params(String::new()), |_| {}).await.err().expect("没记过的服务器不能直接连上");
    let Error::Ssh(ssh_core::Error::HostKey(problem)) = err else { panic!("应是指纹问题：{err}") };
    let HostKeyProblem::Unknown { host: h, port: p, key, .. } = *problem else {
        panic!("应是首次连接：{problem}");
    };
    assert!(key.fingerprint.starts_with("SHA256:"), "{key:?}");
    let known = known_hosts::line_for(&h, p, &key);

    let connected = manager
        .connect(params(known), move |ev| {
            let _ = tx.send(ev);
        })
        .await
        .unwrap();
    let id = connected.id.clone();
    let fp = connected.fingerprint.expect("应返回服务器指纹");
    assert_eq!(fp, key.fingerprint);

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

    // 进程、网络标签页要的详情：先于开始采样到达也不丢（前端两次 invoke 的到达顺序没有保证）；
    // 采样中改了马上采一次，不等下一个周期；没变就不多采
    manager.set_monitor_detail(&id, MonitorDetail { procs: true, sockets: true }).unwrap();
    let (snap_tx, mut snap_rx) = mpsc::unbounded_channel();
    manager
        .start_monitor(&id, Duration::from_secs(60), move |s| {
            let _ = snap_tx.send(s);
        })
        .await
        .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(10), snap_rx.recv()).await.unwrap().unwrap();
    manager.set_monitor_detail(&id, MonitorDetail { procs: false, sockets: true }).unwrap();
    let second = tokio::time::timeout(Duration::from_secs(10), snap_rx.recv())
        .await
        .expect("改了详情应马上采一次，不等 60 秒")
        .unwrap();
    if first.supported {
        assert!(first.all_procs.as_ref().is_some_and(|p| !p.is_empty()) && first.sockets.is_some(), "{first:?}");
        assert!(second.all_procs.is_none() && second.sockets.is_some(), "{second:?}");
    } else {
        eprintln!("服务器不是 Linux（本机 OpenSSH），只能验证改详情会马上重采");
        assert!(first.all_procs.is_none() && second.sockets.is_none());
    }
    manager.set_monitor_detail(&id, MonitorDetail { procs: false, sockets: true }).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(1500), snap_rx.recv()).await.is_err(),
        "详情没变不应多采一次"
    );
    manager.stop_monitor(&id).unwrap();

    // 系统信息：本机 OpenSSH 上只有 uname 那几项
    let info = manager.system_info(&id).await.unwrap();
    eprintln!("系统信息: {info:?}");
    assert!(!info.kernel.is_empty() && !info.kernel_release.is_empty(), "{info:?}");
    assert!(!info.arch.is_empty() && !info.hostname.is_empty(), "{info:?}");
    if cfg!(target_os = "macos") {
        assert_eq!(info.kernel, "Darwin");
    }
    manager.write(&id, b"echo still_$((1+1))\r".to_vec()).unwrap();
    read_until(&mut rx, "still_2").await;

    manager.close(&id).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !matches!(rx.recv().await, Some(ShellEvent::Exit { .. }) | None) {}
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
    assert!(matches!(manager.set_monitor_detail(&id, MonitorDetail::default()), Err(Error::NotFound)));
    assert!(matches!(manager.system_info(&id).await, Err(Error::NotFound)));
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
        known_hosts: String::new(),
    };
    let err = manager.connect(params, |_| {}).await.err().unwrap();
    assert!(matches!(err, Error::Ssh(ssh_core::Error::Io(_))), "{err}");
    assert!(err.to_string().starts_with("网络错误"), "{err}");
}

/// 连本机测试服务器的参数，指纹记录里已经有它（先探一次拿到指纹）
async fn e2e_params() -> Option<ConnectParams> {
    let (Ok(addr), Ok(user), Ok(key)) = (
        std::env::var("SSH_E2E_ADDR"),
        std::env::var("SSH_E2E_USER"),
        std::env::var("SSH_E2E_KEY"),
    ) else {
        eprintln!("跳过：未设置 SSH_E2E_ADDR / SSH_E2E_USER / SSH_E2E_KEY");
        return None;
    };
    let (host, port) = addr.rsplit_once(':').unwrap();
    let mut params = ConnectParams {
        host: host.into(),
        port: port.parse().unwrap(),
        user,
        auth: Auth::PrivateKey { pem: std::fs::read_to_string(key).unwrap(), passphrase: None },
        cols: 80,
        rows: 24,
        known_hosts: String::new(),
    };
    let probe = ConnectParams { auth: Auth::Password(String::new()), ..clone_params(&params) };
    match SessionManager::new().connect(probe, |_| {}).await {
        Err(Error::Ssh(ssh_core::Error::HostKey(problem))) => match *problem {
            HostKeyProblem::Unknown { host, port, key, .. } => params.known_hosts = known_hosts::line_for(&host, port, &key),
            p => panic!("探指纹时应得到首次连接，实际 {p}"),
        },
        other => panic!("探指纹时应得到首次连接，实际 {:?}", other.err().map(|e| e.to_string())),
    }
    Some(params)
}

fn clone_params(p: &ConnectParams) -> ConnectParams {
    ConnectParams {
        host: p.host.clone(),
        port: p.port,
        user: p.user.clone(),
        auth: Auth::Password(String::new()),
        cols: p.cols,
        rows: p.rows,
        known_hosts: p.known_hosts.clone(),
    }
}

/// 界面不回执时输出停在水位线附近；这时关掉会话也不能卡住（关之前要放开限速）
#[tokio::test(flavor = "multi_thread")]
async fn unacked_output_pauses_and_close_still_works() {
    let Some(params) = e2e_params().await else { return };
    let manager = SessionManager::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let id = manager
        .connect(params, move |ev| {
            let _ = tx.send(ev);
        })
        .await
        .unwrap()
        .id;
    manager.write(&id, b"yes\r".to_vec()).unwrap();

    let mut got = 0;
    while let Ok(Some(ShellEvent::Data(d))) = tokio::time::timeout(Duration::from_millis(800), rx.recv()).await {
        got += d.len();
    }
    assert!(got >= OUTPUT_HIGH_WATER / 2, "应该先收到一批输出，实际 {got}");
    assert!(got <= OUTPUT_HIGH_WATER + 64 * 1024, "不回执时不应一直收，实际 {got}");

    // 回执之后接着来
    manager.ack(&id, got).unwrap();
    let more = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap();
    assert!(matches!(more, Some(ShellEvent::Data(_))), "{more:?}");

    manager.close(&id).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !matches!(rx.recv().await, Some(ShellEvent::Exit { .. }) | None) {}
    })
    .await
    .expect("输出暂停时关闭不应卡住");
}

/// 经会话管理层跑 `yes`，按批回执（和界面一样），Ctrl-C 后 1 秒内停
#[tokio::test(flavor = "multi_thread")]
async fn yes_then_ctrl_c_through_session_manager() {
    let Some(params) = e2e_params().await else { return };
    let manager = SessionManager::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let id = manager
        .connect(params, move |ev| {
            let _ = tx.send(ev);
        })
        .await
        .unwrap()
        .id;

    let mut pending = 0;
    let mut drain = async |rx: &mut UnboundedReceiver<ShellEvent>, needle: &str, limit: Duration| {
        let deadline = Instant::now() + limit;
        let mut tail = String::new();
        while Instant::now() < deadline {
            let Ok(Some(ShellEvent::Data(d))) = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await else {
                continue;
            };
            pending += d.len();
            if pending >= OUTPUT_ACK_BATCH {
                manager.ack(&id, pending).unwrap();
                pending = 0;
            }
            tail.push_str(&String::from_utf8_lossy(&d));
            if !needle.is_empty() && tail.contains(needle) {
                return true;
            }
            if tail.len() > 4096 {
                tail = tail.split_off(tail.len() - 64);
            }
        }
        needle.is_empty()
    };

    manager.write(&id, b"stty -echoctl; yes\r".to_vec()).unwrap();
    drain(&mut rx, "", Duration::from_secs(3)).await;
    manager.write(&id, b"\x03".to_vec()).unwrap();
    let pressed = Instant::now();
    manager.write(&id, b"echo FLOW_$((40+2))_DONE\r".to_vec()).unwrap();
    assert!(drain(&mut rx, "FLOW_42_DONE", Duration::from_secs(30)).await, "没看到 Ctrl-C 后的标记");
    let latency = pressed.elapsed();
    eprintln!("经会话管理层：Ctrl-C 后 {latency:?} 停下");
    assert!(latency < Duration::from_secs(1), "Ctrl-C 后 {latency:?} 才停");
    manager.close(&id).unwrap();
}
