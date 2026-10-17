//! SFTP：在连接上开一个 `sftp` 子系统 channel，用 russh-sftp 的底层会话收发报文。
//!
//! 不用它的高层 `SftpSession`，因为 OpenSSH 只讲 SFTP v3，属性里没有用户名，
//! 用户名只能从 readdir 返回的 longname（`ls -l` 风格那一行）里拿，高层接口把它丢掉了。

use std::sync::Arc;

use futures_util::StreamExt;
use futures_util::stream::FuturesOrdered;
use russh::client::Handle;
use russh_sftp::client::RawSftpSession;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::rawsession::Limits;
use russh_sftp::protocol::{File, FileAttributes, FileType, OpenFlags, StatusCode};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::{Error, Result};

/// 每个读写报文的数据量；SFTP 规定服务器至少接受 32KB
const CHUNK: usize = 32 * 1024;
/// 同时在途的读写请求数，避免每个报文都等一个往返
const WINDOW: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Dir,
    File,
    Link,
}

/// 与 packages/ui/src/types.ts 里的 `FileEntry` 一一对应
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub kind: FileKind,
    pub size: u64,
    /// 修改时间，Unix 秒
    pub mtime: u64,
    /// 形如 drwxr-xr-x
    pub perm: String,
    /// 用户名；拿不到时为 uid 数字的字符串
    pub owner: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TransferProgress {
    pub done: u64,
    pub total: u64,
}

/// 一个 SFTP 会话，可以克隆后在多个任务里同时使用。
#[derive(Clone)]
pub struct Sftp {
    raw: Arc<RawSftpSession>,
}

impl Sftp {
    pub(crate) async fn open<H: russh::client::Handler>(handle: &Handle<H>) -> Result<Self> {
        let mut channel = handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        // 等服务器答复：没开 sftp 子系统时 OpenSSH 会立刻回 failure，不用等到超时
        let reply = async {
            loop {
                match channel.wait().await {
                    Some(russh::ChannelMsg::Success) => return Ok(()),
                    Some(russh::ChannelMsg::Failure) | None => {
                        return Err(Error::Sftp("服务器不支持 SFTP".into()));
                    }
                    Some(_) => {}
                }
            }
        };
        tokio::select! {
            r = reply => r?,
            _ = crate::sleep(std::time::Duration::from_secs(15)) => {
                return Err(Error::Sftp("等待服务器启动 SFTP 超时".into()));
            }
        }
        let mut raw = RawSftpSession::new(channel.into_stream());
        let version = raw.init().await.map_err(sftp_err)?;
        if version.extensions.get("limits@openssh.com").is_some_and(|v| v == "1") {
            let limits = raw.limits().await.map_err(sftp_err)?;
            raw.set_limits(Limits::from(limits));
        }
        Ok(Self { raw: Arc::new(raw) })
    }

    /// 登录用户的家目录（sftp-server 启动时的当前目录）
    pub async fn home_dir(&self) -> Result<String> {
        let name = self.raw.realpath(".").await.map_err(sftp_err)?;
        name.files
            .into_iter()
            .next()
            .map(|f| f.filename)
            .ok_or_else(|| Error::Sftp("服务器没有返回家目录".into()))
    }

    /// 列目录，不含 `.` 和 `..`，按名字排序
    pub async fn list_dir(&self, path: &str) -> Result<Vec<FileEntry>> {
        let handle = self.raw.opendir(path).await.map_err(sftp_err)?.handle;
        let mut entries = Vec::new();
        let result = loop {
            match self.raw.readdir(handle.as_str()).await {
                Ok(name) => entries.extend(
                    name.files
                        .into_iter()
                        .filter(|f| f.filename != "." && f.filename != "..")
                        .map(to_entry),
                ),
                Err(SftpError::Status(s)) if s.status_code == StatusCode::Eof => break Ok(()),
                Err(e) => break Err(sftp_err(e)),
            }
        };
        let _ = self.raw.close(handle).await;
        result?;
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    }

    pub async fn mkdir(&self, path: &str) -> Result<()> {
        self.raw
            .mkdir(path, FileAttributes::default())
            .await
            .map_err(sftp_err)?;
        Ok(())
    }

    /// 删除文件或空目录
    pub async fn remove(&self, path: &str, is_dir: bool) -> Result<()> {
        if is_dir {
            self.raw.rmdir(path).await.map_err(|e| match e {
                SftpError::Status(s) if s.status_code == StatusCode::Failure => {
                    Error::Sftp("目录不为空或没有权限".into())
                }
                e => sftp_err(e),
            })?;
        } else {
            self.raw.remove(path).await.map_err(sftp_err)?;
        }
        Ok(())
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.raw.rename(from, to).await.map_err(|e| match e {
            // SFTP v3 的 rename 在目标已存在时失败，OpenSSH 返回的是笼统的 Failure
            SftpError::Status(s) if s.status_code == StatusCode::Failure => {
                Error::Sftp("重命名失败：目标已存在或没有权限".into())
            }
            e => sftp_err(e),
        })?;
        Ok(())
    }

    /// 把 `src` 的内容写到远端文件（已存在则覆盖）。`total` 只用于进度回调。
    pub async fn upload<R: AsyncRead + Unpin>(
        &self,
        path: &str,
        mut src: R,
        total: u64,
        mut on_progress: impl FnMut(TransferProgress),
    ) -> Result<()> {
        let flags = OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE;
        let handle = self
            .raw
            .open(path, flags, FileAttributes::default())
            .await
            .map_err(sftp_err)?
            .handle;
        let result = self
            .write_all(&handle, &mut src, total, &mut on_progress)
            .await;
        let closed = self.raw.close(handle).await.map_err(sftp_err);
        result?;
        closed?;
        Ok(())
    }

    async fn write_all<R: AsyncRead + Unpin>(
        &self,
        handle: &str,
        src: &mut R,
        total: u64,
        on_progress: &mut impl FnMut(TransferProgress),
    ) -> Result<()> {
        on_progress(TransferProgress { done: 0, total });
        let mut inflight = FuturesOrdered::new();
        let mut offset = 0u64;
        let mut done = 0u64;
        let mut eof = false;
        loop {
            while !eof && inflight.len() < WINDOW {
                let mut buf = vec![0u8; CHUNK];
                let n = read_full(src, &mut buf).await?;
                if n == 0 {
                    eof = true;
                    break;
                }
                buf.truncate(n);
                let at = offset;
                offset += n as u64;
                inflight.push_back(async move {
                    self.raw.write(handle, at, buf).await.map(|_| n as u64)
                });
            }
            match inflight.next().await {
                Some(written) => {
                    done += written.map_err(sftp_err)?;
                    on_progress(TransferProgress { done, total });
                }
                None => return Ok(()),
            }
        }
    }

    /// 把远端文件读到 `dest`，返回读到的字节数。
    pub async fn download<W: AsyncWrite + Unpin>(
        &self,
        path: &str,
        mut dest: W,
        mut on_progress: impl FnMut(TransferProgress),
    ) -> Result<u64> {
        let attrs = self.raw.stat(path).await.map_err(sftp_err)?.attrs;
        if attrs.file_type() == FileType::Dir {
            return Err(Error::Sftp("不能下载目录".into()));
        }
        let total = attrs.size.unwrap_or(0);
        let handle = self
            .raw
            .open(path, OpenFlags::READ, FileAttributes::default())
            .await
            .map_err(sftp_err)?
            .handle;
        let result = self
            .read_all(&handle, total, &mut dest, &mut on_progress)
            .await;
        let _ = self.raw.close(handle).await;
        result
    }

    /// 按 stat 到的大小预先排好偏移、窗口内并发请求、按顺序写出。
    /// 传输中文件变长的部分不读；变短则在第一个短读处停下。
    async fn read_all<W: AsyncWrite + Unpin>(
        &self,
        handle: &str,
        total: u64,
        dest: &mut W,
        on_progress: &mut impl FnMut(TransferProgress),
    ) -> Result<u64> {
        on_progress(TransferProgress { done: 0, total });
        let mut inflight = FuturesOrdered::new();
        let mut next = 0u64;
        let mut done = 0u64;
        loop {
            while next < total && inflight.len() < WINDOW {
                let len = (total - next).min(CHUNK as u64) as u32;
                let at = next;
                next += len as u64;
                inflight.push_back(async move { (at, len, self.read_at(handle, at, len).await) });
            }
            let Some((at, len, data)) = inflight.next().await else {
                break;
            };
            let mut data = data?;
            // 服务器给少了但还没到文件尾（罕见），把剩下的补齐
            while data.len() < len as usize {
                let more = self
                    .read_at(handle, at + data.len() as u64, len - data.len() as u32)
                    .await?;
                if more.is_empty() {
                    break;
                }
                data.extend_from_slice(&more);
            }
            dest.write_all(&data).await?;
            done += data.len() as u64;
            on_progress(TransferProgress { done, total });
            if data.len() < len as usize {
                break;
            }
        }
        dest.flush().await?;
        Ok(done)
    }

    /// 读到文件尾时返回空
    async fn read_at(&self, handle: &str, offset: u64, len: u32) -> Result<Vec<u8>> {
        match self.raw.read(handle, offset, len).await {
            Ok(data) => Ok(data.data),
            Err(SftpError::Status(s)) if s.status_code == StatusCode::Eof => Ok(Vec::new()),
            Err(e) => Err(sftp_err(e)),
        }
    }
}

/// 读满 `buf` 或读到流结束，返回读到的字节数
async fn read_full<R: AsyncRead + Unpin>(src: &mut R, buf: &mut [u8]) -> Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = src.read(&mut buf[filled..]).await?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

fn to_entry(file: File) -> FileEntry {
    let attrs = &file.attrs;
    let kind = match attrs.file_type() {
        FileType::Dir => FileKind::Dir,
        FileType::Symlink => FileKind::Link,
        _ => FileKind::File,
    };
    FileEntry {
        name: file.filename.clone(),
        kind,
        size: attrs.size.unwrap_or(0),
        mtime: attrs.mtime.unwrap_or(0) as u64,
        perm: attrs
            .permissions
            .map(format_mode)
            .or_else(|| longname_field(&file.longname, 0).filter(|p| p.len() == 10))
            .unwrap_or_else(|| "----------".into()),
        owner: attrs
            .user
            .clone()
            .or_else(|| longname_owner(&file.longname))
            .or_else(|| attrs.uid.map(|u| u.to_string()))
            .unwrap_or_default(),
    }
}

/// longname 是 `ls -l` 那一行：`drwxr-xr-x    2 deploy   staff        64 Oct 17 07:03 name`。
/// 第 3 列是用户名；OpenSSH 拿不到用户名时这一列就是 uid 数字，照用。
fn longname_owner(longname: &str) -> Option<String> {
    let fields: Vec<&str> = longname.split_whitespace().collect();
    // 至少要有 权限 链接数 用户 组 大小 时间… 才像 ls -l 的格式
    (fields.len() >= 8 && fields[0].len() == 10).then(|| fields[2].to_string())
}

fn longname_field(longname: &str, index: usize) -> Option<String> {
    longname.split_whitespace().nth(index).map(str::to_string)
}

/// 把 st_mode 格式化成 `drwxr-xr-x`
pub fn format_mode(mode: u32) -> String {
    let kind = match mode & 0o170000 {
        0o040000 => 'd',
        0o120000 => 'l',
        0o020000 => 'c',
        0o060000 => 'b',
        0o010000 => 'p',
        0o140000 => 's',
        _ => '-',
    };
    let mut s = String::with_capacity(10);
    s.push(kind);
    let special = [(0o4000, 's', 'S'), (0o2000, 's', 'S'), (0o1000, 't', 'T')];
    for (i, shift) in [6u32, 3, 0].into_iter().enumerate() {
        let bits = (mode >> shift) & 0o7;
        s.push(if bits & 4 != 0 { 'r' } else { '-' });
        s.push(if bits & 2 != 0 { 'w' } else { '-' });
        let (flag, on, off) = special[i];
        let exec = bits & 1 != 0;
        s.push(match (mode & flag != 0, exec) {
            (true, true) => on,
            (true, false) => off,
            (false, true) => 'x',
            (false, false) => '-',
        });
    }
    s
}

/// 把 russh-sftp 的错误翻成界面能直接显示的中文
fn sftp_err(e: SftpError) -> Error {
    Error::Sftp(match e {
        SftpError::Status(s) => match s.status_code {
            StatusCode::NoSuchFile => "文件或目录不存在".into(),
            StatusCode::PermissionDenied => "没有权限".into(),
            StatusCode::OpUnsupported => "服务器不支持该操作".into(),
            StatusCode::Failure if s.error_message.is_empty() || s.error_message == "Failure" => {
                "操作失败".into()
            }
            _ => format!("操作失败：{}", s.error_message),
        },
        SftpError::Timeout => "SFTP 请求超时".into(),
        SftpError::IO(msg) => format!("SFTP 连接中断：{msg}"),
        SftpError::Limited(msg) => format!("超出服务器限制：{msg}"),
        e => format!("SFTP 错误：{e}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_mode_like_ls() {
        assert_eq!(format_mode(0o040755), "drwxr-xr-x");
        assert_eq!(format_mode(0o100644), "-rw-r--r--");
        assert_eq!(format_mode(0o120777), "lrwxrwxrwx");
        assert_eq!(format_mode(0o104755), "-rwsr-xr-x");
        assert_eq!(format_mode(0o102644), "-rw-r-Sr--");
        assert_eq!(format_mode(0o041777), "drwxrwxrwt");
        assert_eq!(format_mode(0o100000), "----------");
    }

    #[test]
    fn owner_comes_from_longname_then_uid() {
        let attrs = FileAttributes {
            uid: Some(501),
            permissions: Some(0o100644),
            size: Some(1234),
            mtime: Some(1_700_000_000),
            ..Default::default()
        };

        let mut f = File::new("a.txt", attrs.clone());
        f.longname = "-rw-r--r--    1 deploy   staff        1234 Oct 17 07:03 a.txt".into();
        let e = to_entry(f);
        assert_eq!(e.owner, "deploy");
        assert_eq!(e.perm, "-rw-r--r--");
        assert_eq!(e.kind, FileKind::File);
        assert_eq!(e.size, 1234);
        assert_eq!(e.mtime, 1_700_000_000);

        // longname 不是 ls -l 格式时退回 uid
        let mut f = File::new("a.txt", attrs);
        f.longname = "a.txt".into();
        assert_eq!(to_entry(f).owner, "501");
    }

    #[test]
    fn entry_serializes_like_types_ts() {
        let attrs = FileAttributes {
            permissions: Some(0o040755),
            ..Default::default()
        };
        // File::new 会按属性拼一个 longname，这里清掉，测没有 longname 也没有 uid 的情况
        let mut f = File::new("dir", attrs);
        f.longname.clear();
        let json = serde_json::to_value(to_entry(f)).unwrap();
        assert_eq!(json["kind"], "dir");
        assert_eq!(json["perm"], "drwxr-xr-x");
        assert_eq!(json["owner"], "");
    }
}
