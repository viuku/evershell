//! 连真实的 OpenSSH 验证 exec、监控采样和 SFTP。默认跳过，设置环境变量后运行：
//! SSH_E2E_ADDR=127.0.0.1:2222 SSH_E2E_USER=me SSH_E2E_KEY=/path/to/key cargo test -p ssh-core --test real_server
//!
//! SFTP 操作都在本机 $TMPDIR 下进行，要求测试机就是 SSH 服务器所在机器。

use std::sync::Arc;
use std::time::Duration;

use ssh_core::{Auth, ConnectConfig, Connection, FileKind, HostKeyCheck, TransferProgress, connect_tcp};

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
    // 本机测试服务器，不校验指纹（指纹校验在 tests/shell.rs 和桌面端测试里测）
    let cfg = ConnectConfig::new(HostKeyCheck::AcceptAny);
    let conn = Connection::connect(stream, &user, Auth::PrivateKey { pem, passphrase: None }, &cfg)
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
        assert!(!first.procs.is_empty() && first.procs.len() <= 2 * ssh_core::monitor::TOP_PROCS);
        assert!(first.procs.windows(2).all(|w| w[0].mem_bytes >= w[1].mem_bytes));
        assert!(first.procs.iter().all(|p| p.pid > 0 && p.cpu_percent == 0.0), "第一次采样没有参照");
        assert!(second.procs.iter().all(|p| p.cpu_percent >= 0.0));
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

/// 上传先写 `<文件名>.evershell-part` 再改名盖过去。要在本机看 inode、权限位和符号链接，只在 Unix 上跑
#[cfg(unix)]
mod upload {
    use std::io;
    use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use ssh_core::TransferProgress;
    use tokio::io::{AsyncRead, ReadBuf};

    use super::{connect, pseudo_random};

    /// 每个测试一个目录（测试是并行跑的），放在本机 $TMPDIR 下
    fn fresh_dir(name: &str) -> String {
        let tmp = std::env::temp_dir();
        let tmp = tmp.to_str().unwrap().trim_end_matches('/');
        let dir = format!("{tmp}/ssh-core-e2e-{}-{name}", std::process::id());
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    fn write_file(path: &str, data: &[u8], mode: u32) {
        std::fs::write(path, data).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn mode(path: &str) -> u32 {
        std::fs::metadata(path).unwrap().mode() & 0o7777
    }

    fn inode(path: &str) -> u64 {
        std::fs::metadata(path).unwrap().ino()
    }

    /// 目录里的文件名（排好序），用来确认没留下 .evershell-part
    fn names(dir: &str) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    /// 先给出 `data`，给完再读就报错：模拟传到一半本地文件读不下去
    struct FailAfter {
        data: Vec<u8>,
        pos: usize,
    }

    impl AsyncRead for FailAfter {
        fn poll_read(self: Pin<&mut Self>, _: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
            let this = self.get_mut();
            let rest = &this.data[this.pos..];
            if rest.is_empty() {
                return Poll::Ready(Err(io::Error::other("模拟读取失败")));
            }
            let n = rest.len().min(buf.remaining());
            buf.put_slice(&rest[..n]);
            this.pos += n;
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn sftp_upload_overwrite_keeps_mode() {
        let Some((conn, _)) = connect().await else { return };
        let sftp = conn.sftp().await.unwrap();
        let dir = fresh_dir("overwrite");
        let file = format!("{dir}/site.conf");
        write_file(&file, b"old content\n", 0o640);
        let before = inode(&file);

        // 300KB：跨多个 32KB 块、超过 16 个在途窗口
        let data = pseudo_random(300 * 1024 + 7, 7);
        let mut progress = Vec::new();
        sftp.upload(&file, &data[..], data.len() as u64, |p| progress.push(p))
            .await
            .unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), data, "内容应换成新的");
        assert_eq!(progress.last().unwrap(), &TransferProgress { done: data.len() as u64, total: data.len() as u64 });
        assert_eq!(mode(&file), 0o640, "权限位应保留");
        assert_ne!(inode(&file), before, "应是临时文件改名盖过去，不是原地截断重写");
        assert_eq!(names(&dir), ["site.conf"], "不应留下临时文件");

        // 目标是目录时报错，什么都不动
        let err = sftp.upload(&dir, &b"x"[..], 1, |_| {}).await.err().unwrap();
        assert!(err.to_string().contains("目录"), "{err}");
        assert_eq!(names(&dir), ["site.conf"]);

        std::fs::remove_dir_all(&dir).unwrap();
        conn.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn sftp_upload_failure_keeps_original() {
        let Some((conn, _)) = connect().await else { return };
        let sftp = conn.sftp().await.unwrap();
        let dir = fresh_dir("fail");
        let file = format!("{dir}/data.bin");
        let original = pseudo_random(100 * 1024, 1);
        write_file(&file, &original, 0o644);
        let before = inode(&file);

        // 先给 700KB 再报错：超过一整个在途窗口（16 × 32KB），出错前已经有数据写进临时文件
        let src = FailAfter { data: pseudo_random(700 * 1024, 2), pos: 0 };
        let err = sftp
            .upload(&file, src, 1024 * 1024, |_| {})
            .await
            .expect_err("源读不下去，上传应报错");
        assert!(err.to_string().contains("模拟读取失败"), "{err}");
        assert_eq!(std::fs::read(&file).unwrap(), original, "原文件应一字不差");
        assert_eq!(inode(&file), before);
        assert_eq!(names(&dir), ["data.bin"], "临时文件应已清掉");

        std::fs::remove_dir_all(&dir).unwrap();
        conn.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn sftp_upload_new_file() {
        let Some((conn, _)) = connect().await else { return };
        let sftp = conn.sftp().await.unwrap();
        let dir = fresh_dir("new");
        let file = format!("{dir}/new.txt");
        let empty = format!("{dir}/empty.txt");

        let data = b"hello evershell\n";
        let mut progress = Vec::new();
        sftp.upload(&file, &data[..], data.len() as u64, |p| progress.push(p))
            .await
            .unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), data);
        assert_eq!(progress.last().unwrap(), &TransferProgress { done: 16, total: 16 });
        // 新文件的权限照服务器默认（受 umask 影响），至少自己能读写
        assert_eq!(mode(&file) & 0o600, 0o600, "{:o}", mode(&file));

        // 空文件也要建出来
        sftp.upload(&empty, &b""[..], 0, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(&empty).unwrap(), b"");
        assert_eq!(names(&dir), ["empty.txt", "new.txt"], "不应留下临时文件");

        std::fs::remove_dir_all(&dir).unwrap();
        conn.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn sftp_upload_through_symlink() {
        let Some((conn, _)) = connect().await else { return };
        let sftp = conn.sftp().await.unwrap();
        let dir = fresh_dir("symlink");
        let real = format!("{dir}/real.txt");
        let link = format!("{dir}/link.txt");
        write_file(&real, b"old content\n", 0o600);
        symlink("real.txt", &link).unwrap();
        let before = inode(&real);

        sftp.upload(&link, &b"new content\n"[..], 12, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(&real).unwrap(), b"new content\n", "内容应写进链接指向的文件");
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "链接本身应还是链接");
        assert_eq!(std::fs::read_link(&link).unwrap(), std::path::Path::new("real.txt"));
        assert_eq!(inode(&real), before, "应写穿链接原地改写，不换文件");
        assert_eq!(mode(&real), 0o600);
        assert_eq!(names(&dir), ["link.txt", "real.txt"], "不应留下临时文件");

        std::fs::remove_dir_all(&dir).unwrap();
        conn.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn sftp_upload_without_posix_rename() {
        let Some((conn, _)) = connect().await else { return };
        let sftp = conn.sftp().await.unwrap().without_posix_rename();
        let dir = fresh_dir("no-posix-rename");
        let file = format!("{dir}/run.sh");
        // 0775：组的写位一般会被服务器的 umask 去掉，看传完能不能补回来
        write_file(&file, b"#!/bin/sh\necho old\n", 0o775);
        let before = inode(&file);

        let data = pseudo_random(64 * 1024 + 1, 5);
        sftp.upload(&file, &data[..], data.len() as u64, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), data, "内容应换成新的");
        assert_eq!(mode(&file), 0o775, "权限位应保留");
        assert_ne!(inode(&file), before, "应是先删目标再改名");
        assert_eq!(names(&dir), ["run.sh"], "不应留下临时文件");

        std::fs::remove_dir_all(&dir).unwrap();
        conn.disconnect().await.unwrap();
    }

    #[tokio::test]
    async fn sftp_upload_replaces_stale_part() {
        let Some((conn, _)) = connect().await else { return };
        let sftp = conn.sftp().await.unwrap();
        let dir = fresh_dir("stale-part");
        let file = format!("{dir}/app.conf");
        let decoy = format!("{dir}/decoy.txt");
        write_file(&file, b"old content\n", 0o644);
        write_file(&decoy, b"decoy\n", 0o644);
        // 上次中断留下的残件，而且是指向别的文件的符号链接：不能顺着它把别的文件截断
        symlink("decoy.txt", format!("{file}.evershell-part")).unwrap();

        sftp.upload(&file, &b"new content\n"[..], 12, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"new content\n");
        assert_eq!(std::fs::read(&decoy).unwrap(), b"decoy\n", "残件指向的文件不应被动到");
        assert_eq!(names(&dir), ["app.conf", "decoy.txt"], "残件应已清掉");

        std::fs::remove_dir_all(&dir).unwrap();
        conn.disconnect().await.unwrap();
    }
}
