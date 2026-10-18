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
use russh_sftp::protocol::{File, FileAttributes, FileType, OpenFlags, Packet, StatusCode};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::{Error, Result};

/// 每个读写报文的数据量；SFTP 规定服务器至少接受 32KB
const CHUNK: usize = 32 * 1024;
/// 同时在途的读写请求数，避免每个报文都等一个往返
const WINDOW: usize = 16;
/// 上传时先写到同目录的 `<文件名>` + 这个后缀，传完再改名成目标名
const PART_SUFFIX: &str = ".evershell-part";
/// OpenSSH 扩展：按 POSIX rename(2) 改名，目标已存在时原子地覆盖
const POSIX_RENAME: &str = "posix-rename@openssh.com";

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
    /// 服务器在 init 时报了 posix-rename@openssh.com
    posix_rename: bool,
    /// 服务器在 init 时报了 fsync@openssh.com
    fsync: bool,
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
        let has = |name: &str| version.extensions.get(name).is_some_and(|v| v == "1");
        if has("limits@openssh.com") {
            let limits = raw.limits().await.map_err(sftp_err)?;
            raw.set_limits(Limits::from(limits));
        }
        Ok(Self {
            posix_rename: has(POSIX_RENAME),
            fsync: has("fsync@openssh.com"),
            raw: Arc::new(raw),
        })
    }

    /// 只给测试用：当作服务器不支持 posix-rename，好测上传时「先删目标再改名」那条退路
    #[doc(hidden)]
    pub fn without_posix_rename(mut self) -> Self {
        self.posix_rename = false;
        self
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
    ///
    /// 照 WinSCP 的做法，先写到同目录的 `<文件名>.evershell-part`，写完再改名盖过去，
    /// 传到一半断了服务器上的原文件还是好的。目标是符号链接、临时文件建不出来、
    /// 或者保不住原文件的所有者时，退回直接覆盖目标。
    pub async fn upload<R: AsyncRead + Unpin>(
        &self,
        path: &str,
        mut src: R,
        total: u64,
        mut on_progress: impl FnMut(TransferProgress),
    ) -> Result<()> {
        let target = match self.raw.lstat(path).await {
            Ok(a) => Some(a.attrs),
            Err(SftpError::Status(s)) if s.status_code == StatusCode::NoSuchFile => None,
            Err(e) => return Err(sftp_err(e)),
        };
        match target.as_ref().map(|t| t.file_type()) {
            Some(FileType::Dir) => return Err(Error::Sftp("目标是目录，不能覆盖".into())),
            // 符号链接直接写，改的是它指向的文件；改名的话会把链接本身换成普通文件。
            // 设备、管道这类特殊文件（或服务器没给类型）同样只能直接写
            Some(FileType::Symlink | FileType::Other) => {
                return self.upload_direct(path, src, total, on_progress).await;
            }
            Some(FileType::File) | None => {}
        }

        let part = format!("{path}{PART_SUFFIX}");
        let Some(handle) = self.open_part(path, &part, target.as_ref()).await else {
            return self.upload_direct(path, src, total, on_progress).await;
        };
        let mut written = self
            .write_all(&handle, &mut src, total, &mut on_progress)
            .await;
        // 改名之前先落盘，免得服务器断电后目标名下是一个内容不全的文件
        if written.is_ok() && self.fsync {
            written = self.raw.fsync(handle.as_str()).await.map(drop).map_err(sftp_err);
        }
        if let Err(e) = written {
            self.discard_part(handle, &part).await;
            return Err(e);
        }
        if let Some(perm) = target.as_ref().and_then(|t| t.permissions) {
            // 权限位照原文件：建的时候被 umask 去掉的位、setuid 这类位在这里补上。
            // 放在写完之后，因为改所有者、普通用户写入都会让系统清掉 setuid 位
            let attrs = FileAttributes { permissions: Some(perm & 0o7777), ..Default::default() };
            if let Err(e) = self.raw.fsetstat(handle.as_str(), attrs).await {
                log::warn!("{path} 原来的权限没能设到新文件上：{}", sftp_err(e));
            }
        }
        if let Err(e) = self.raw.close(handle).await {
            let _ = self.raw.remove(part.as_str()).await;
            return Err(sftp_err(e));
        }
        self.replace_with_part(&part, path, target.is_some()).await
    }

    /// 在同目录建临时文件，目标已存在时把临时文件的所有者调成和目标一样。
    /// 做不到时打一行日志、清掉临时文件，返回 None，由调用方退回直接覆盖。
    async fn open_part(
        &self,
        path: &str,
        part: &str,
        target: Option<&FileAttributes>,
    ) -> Option<String> {
        // 建的时候就用原文件的权限（服务器还会按 umask 去掉一些），传输途中能读到它的人不比原文件多
        let attrs = FileAttributes {
            permissions: target.and_then(|t| t.permissions).map(|p| p & 0o777),
            ..Default::default()
        };
        // 用 EXCLUDE 只新建、不打开已有的：已有的多半是上次中断留下的残件，删掉再建。
        // 删的是这个名字本身，它就算是指向别处的符号链接，也不会把别处的文件截断
        let flags = OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE;
        let opened = match self.raw.open(part, flags, attrs.clone()).await {
            Ok(h) => Ok(h),
            Err(e) => match self.raw.remove(part).await {
                Ok(_) => self.raw.open(part, flags, attrs).await,
                Err(_) => Err(e),
            },
        };
        let handle = match opened {
            Ok(h) => h.handle,
            Err(e) => {
                log::warn!("建不了临时文件 {part}（{}），改为直接覆盖 {path}", sftp_err(e));
                return None;
            }
        };

        // 新建的文件属于登录用户；原文件属于别人时（比如 root 登录覆盖 www-data 的文件）
        // 要把所有者改回去，改不了就不用临时文件：保住所有者比原子替换更要紧
        if let Some(t) = target
            && let (Some(uid), Some(gid)) = (t.uid, t.gid)
        {
            let fixed = match self.raw.fstat(handle.as_str()).await {
                Ok(a) if a.attrs.uid == Some(uid) && a.attrs.gid == Some(gid) => Ok(()),
                // root 能改成任何人；普通用户只能把组改成自己所在的组
                Ok(_) => {
                    let owner =
                        FileAttributes { uid: Some(uid), gid: Some(gid), ..Default::default() };
                    self.raw.fsetstat(handle.as_str(), owner).await.map(drop)
                }
                Err(e) => Err(e),
            };
            if let Err(e) = fixed {
                log::warn!("临时文件的所有者改不成和 {path} 一样（{}），改为直接覆盖", sftp_err(e));
                self.discard_part(handle, part).await;
                return None;
            }
        }
        Some(handle)
    }

    /// 尽力关掉并删掉临时文件；连接已经断了就算了，残件下次上传同一个文件时会被清掉
    async fn discard_part(&self, handle: String, part: &str) {
        let _ = self.raw.close(handle).await;
        let _ = self.raw.remove(part).await;
    }

    /// 把传完的临时文件改名成目标名。`exists`：目标原来就有
    async fn replace_with_part(&self, part: &str, path: &str, exists: bool) -> Result<()> {
        if self.posix_rename {
            // 原子替换：任何时刻目标名下要么是旧文件，要么是完整的新文件
            let result = self.posix_rename(part, path).await;
            if result.is_err() {
                let _ = self.raw.remove(part).await;
            }
            return result;
        }
        if exists {
            // SFTP v3 的 rename 不覆盖已有文件，只能先删
            log::warn!("服务器不支持 posix-rename，先删掉 {path} 再改名，中间有一小段时间这个文件不存在");
            if let Err(e) = self.raw.remove(path).await {
                let _ = self.raw.remove(part).await;
                return Err(sftp_err(e));
            }
        }
        // 目标原来就有的话这时已经删了，新内容只在临时文件里，失败时留着它并告诉用户在哪
        self.raw
            .rename(part, path)
            .await
            .map_err(|e| Error::Sftp(format!("改名失败，上传的内容在 {part}：{}", sftp_err(e))))?;
        Ok(())
    }

    /// posix-rename@openssh.com 请求，参数是 string oldpath、string newpath
    async fn posix_rename(&self, from: &str, to: &str) -> Result<()> {
        let mut data = Vec::with_capacity(8 + from.len() + to.len());
        for s in [from, to] {
            data.extend_from_slice(&(s.len() as u32).to_be_bytes());
            data.extend_from_slice(s.as_bytes());
        }
        match self.raw.extended(POSIX_RENAME, data).await.map_err(sftp_err)? {
            Packet::Status(s) if s.status_code == StatusCode::Ok => Ok(()),
            Packet::Status(s) => Err(sftp_err(SftpError::Status(s))),
            _ => Err(Error::Sftp("服务器对改名请求的答复不对".into())),
        }
    }

    /// 原来的做法：截断目标直接写。中途断了目标就毁了，只在用不了临时文件时走这里
    async fn upload_direct<R: AsyncRead + Unpin>(
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
