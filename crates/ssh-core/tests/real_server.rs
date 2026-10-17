//! 连真实的 OpenSSH 验证 exec、监控采样和 SFTP。默认跳过，设置环境变量后运行：
//! SSH_E2E_ADDR=127.0.0.1:2222 SSH_E2E_USER=me SSH_E2E_KEY=/path/to/key cargo test -p ssh-core --test real_server
//!
//! SFTP 操作都在本机 $TMPDIR 下进行，要求测试机就是 SSH 服务器所在机器。

use std::sync::Arc;
use std::time::Duration;

use ssh_core::{Auth, Connection, FileKind, TransferProgress, connect_tcp};

async fn connect() -> Option<(Connection, String)> {
    let (Ok(addr), Ok(user), Ok(key)) = (
        std::env::var("SSH_E2E_ADDR"),
        std::env::var("SSH_E2E_USER"),
        std::env::var("SSH_E2E_KEY"),
    ) else {
        eprintln!("跳过：未设置 SSH_E2E_ADDR / SSH_E2E_USER / SSH_E2E_KEY");
        return None;
    };
    let (host, port) = addr.rsplit_once(':').unwrap();
    let stream = connect_tcp(host, port.parse().unwrap()).await.unwrap();
    let pem = std::fs::read_to_string(key).unwrap();
    let conn = Connection::connect(stream, &user, Auth::PrivateKey { pem, passphrase: None })
        .await
        .unwrap();
    Some((conn, user))
}

/// 可复现的伪随机字节，不引入 rand
fn pseudo_random(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

#[tokio::test]
async fn exec_returns_output_and_exit_code() {
    let Some((conn, _)) = connect().await else { return };
    let out = conn.exec("echo hello; echo oops >&2; exit 3").await.unwrap();
    assert_eq!(out.stdout_lossy(), "hello\n");
    assert_eq!(String::from_utf8_lossy(&out.stderr), "oops\n");
    assert_eq!(out.exit_code, Some(3));

    // stdin 已关闭，读 stdin 的命令不会卡住
    let out = tokio::time::timeout(Duration::from_secs(5), conn.exec("cat; echo done"))
        .await
        .expect("cat 不应等待 stdin")
        .unwrap();
    assert_eq!(out.stdout_lossy(), "done\n");
    conn.disconnect().await.unwrap();
}

#[tokio::test]
async fn monitor_two_consecutive_samples() {
    let Some((conn, _)) = connect().await else { return };
    let is_linux = conn.exec("uname -s").await.unwrap().stdout_lossy().trim() == "Linux";
    let conn = Arc::new(conn);

    let (handle, mut rx) = conn.watch_monitor(Duration::from_millis(300));
    let first = tokio::time::timeout(Duration::from_secs(15), rx.recv()).await.unwrap().unwrap();
    let second = tokio::time::timeout(Duration::from_secs(15), rx.recv()).await.unwrap().unwrap();
    eprintln!("第一次采样: {first:?}");
    eprintln!("第二次采样: {second:?}");

    // 延迟不依赖服务器系统
    assert!(first.latency_ms.is_some_and(|ms| (0.0..5000.0).contains(&ms)), "{first:?}");
    assert!(second.latency_ms.is_some(), "{second:?}");

    if is_linux {
        assert!(first.supported && second.supported);
        assert!(first.cpu_cores > 0);
        assert!(first.mem_total > 0 && first.mem_used > 0 && first.mem_used <= first.mem_total);
        assert!(second.uptime_secs > first.uptime_secs);
        assert!(first.net.is_empty(), "第一次采样算不出网速");
        assert!(!second.net.is_empty(), "第二次采样应有网速");
        assert!(second.net.iter().all(|n| n.rx_per_sec >= 0.0 && n.tx_per_sec >= 0.0));
        assert!((0.0..=100.0).contains(&second.cpu_percent));
        assert!(!first.disks.is_empty() && first.disks.iter().all(|d| d.size >= d.avail));
        assert!(!first.procs.is_empty() && first.procs.len() <= 10);
        assert!(first.procs.windows(2).all(|w| w[0].mem_bytes >= w[1].mem_bytes));
    } else {
        eprintln!("服务器不是 Linux（本机 OpenSSH），只能验证 supported=false 的路径");
        assert!(!first.supported && !second.supported);
        assert_eq!(first.cpu_cores, 0);
        assert!(first.net.is_empty() && first.disks.is_empty());
    }

    // 丢掉句柄后循环停止，接收端随之结束
    drop(handle);
    let end = tokio::time::timeout(Duration::from_secs(5), async {
        while rx.recv().await.is_some() {}
    })
    .await;
    assert!(end.is_ok(), "停止后不应再有快照");
    conn.disconnect().await.unwrap();
}

#[tokio::test]
async fn sftp_roundtrip_in_tmpdir() {
    let Some((conn, user)) = connect().await else { return };
    let sftp = conn.sftp().await.unwrap();

    let home = sftp.home_dir().await.unwrap();
    assert!(home.starts_with('/'), "{home}");
    let shell_home = conn.exec("printf %s \"$HOME\"").await.unwrap().stdout_lossy();
    assert_eq!(home, shell_home);

    let tmp = std::env::temp_dir();
    let tmp = tmp.to_str().unwrap().trim_end_matches('/');
    let dir = format!("{tmp}/ssh-core-e2e-{}", std::process::id());
    let file = format!("{dir}/upload.bin");
    let renamed = format!("{dir}/renamed.bin");
    let _ = std::fs::remove_dir_all(&dir);

    sftp.mkdir(&dir).await.unwrap();
    let parent = sftp.list_dir(tmp).await.unwrap();
    let me = parent
        .iter()
        .find(|e| e.name == dir.rsplit('/').next().unwrap())
        .expect("新建目录应出现在列表里");
    assert_eq!(me.kind, FileKind::Dir);
    assert!(me.perm.starts_with('d'), "{}", me.perm);
    assert_eq!(me.owner, user, "owner 应是用户名");

    // 300KB：跨多个 32KB 块、超过 16 个在途窗口
    let data = pseudo_random(300 * 1024 + 123, 42);
    let mut progress = Vec::new();
    sftp.upload(&file, &data[..], data.len() as u64, |p: TransferProgress| progress.push(p))
        .await
        .unwrap();
    assert_eq!(progress.first().unwrap().done, 0);
    assert_eq!(progress.last().unwrap(), &TransferProgress { done: data.len() as u64, total: data.len() as u64 });
    assert!(progress.windows(2).all(|w| w[0].done <= w[1].done), "进度应单调");
    assert_eq!(std::fs::read(&file).unwrap(), data, "服务器上的文件内容应一致");

    let listed = sftp.list_dir(&dir).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "upload.bin");
    assert_eq!(listed[0].kind, FileKind::File);
    assert_eq!(listed[0].size, data.len() as u64);
    assert!(listed[0].perm.starts_with("-rw"), "{}", listed[0].perm);
    assert_eq!(listed[0].owner, user);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    assert!(listed[0].mtime.abs_diff(now) < 120, "mtime {} 应接近当前时间 {now}", listed[0].mtime);

    let mut downloaded = Vec::new();
    let mut progress = Vec::new();
    let n = sftp
        .download(&file, &mut downloaded, |p| progress.push(p))
        .await
        .unwrap();
    assert_eq!(n, data.len() as u64);
    assert_eq!(downloaded, data);
    assert_eq!(progress.last().unwrap().total, data.len() as u64);

    sftp.rename(&file, &renamed).await.unwrap();
    let names: Vec<String> = sftp.list_dir(&dir).await.unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(names, vec!["renamed.bin"]);

    // 非空目录不能删，错误是中文
    let err = sftp.remove(&dir, true).await.err().unwrap();
    assert!(err.to_string().contains("目录不为空"), "{err}");

    sftp.remove(&renamed, false).await.unwrap();
    assert!(sftp.list_dir(&dir).await.unwrap().is_empty());
    sftp.remove(&dir, true).await.unwrap();
    assert!(!std::path::Path::new(&dir).exists());

    let err = sftp.list_dir(&dir).await.err().unwrap();
    assert!(err.to_string().contains("不存在"), "{err}");
    let err = sftp.download(tmp, &mut Vec::new(), |_| {}).await.err().unwrap();
    assert!(err.to_string().contains("不能下载目录"), "{err}");

    // 第二次拿到的是同一个会话
    let again = conn.sftp().await.unwrap();
    assert_eq!(again.home_dir().await.unwrap(), home);
    conn.disconnect().await.unwrap();
}
