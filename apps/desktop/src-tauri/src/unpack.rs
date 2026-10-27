//! 打包传输：把从服务器下载的 .tar.gz 解到本机「下载」文件夹（docs/specs/file-ops.md）。
//!
//! 压缩包是服务器给的，不可信：只解普通文件和文件夹，路径的每一段都只能是普通名字；
//! 权限去掉 SUID、SGID、粘滞位和组、其他人的写权限。先解到一个新建的临时文件夹，
//! 再把最上一层的每一项挪出来，重名加序号，不覆盖本机已有的东西。

use std::fs;
use std::io::{self, BufReader};
use std::path::{Component, Path, PathBuf};

/// 解开 archive，放进 into，返回挪出来的每一项（按名字排序）
pub fn unpack_tar_gz(archive: &Path, into: &Path) -> Result<Vec<PathBuf>, String> {
    let staging = make_staging(into)?;
    let result = extract(archive, &staging).and_then(|()| move_out(&staging, into));
    let _ = fs::remove_dir_all(&staging);
    result
}

/// `dir` 里一个还没有的名字：`a.txt`、`a (1).txt`、`a (2).txt`…；文件夹不拆扩展名
pub fn unique_path(dir: &Path, name: &str, is_dir: bool) -> PathBuf {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !is_dir && !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    (0u32..)
        .map(|n| if n == 0 { dir.join(name) } else { dir.join(format!("{stem} ({n}){ext}")) })
        .find(|p| fs::symlink_metadata(p).is_err())
        .expect("总有一个序号没被占用")
}

/// 服务器给的相对路径（`/` 分隔）变成本机路径；有一段不是普通名字（`..`、盘符、Windows 上含 `\` `:` 等）就返回 None
pub fn local_relative(rel: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for seg in rel.split('/') {
        let mut parts = Path::new(seg).components();
        match (parts.next(), parts.next()) {
            (Some(Component::Normal(s)), None) if s == seg => out.push(s),
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

fn make_staging(into: &Path) -> Result<PathBuf, String> {
    for n in 0u32.. {
        let p = into.join(format!(".evershell-unpack-{}-{n}", std::process::id()));
        match fs::create_dir(&p) {
            Ok(()) => return Ok(p),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("无法在下载目录创建临时文件夹：{e}")),
        }
    }
    unreachable!()
}

/// 压缩包里的路径：每一段都是普通名字（`./` 开头可以），否则 None
fn safe_relative(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

fn bad(e: io::Error) -> String {
    format!("压缩包已损坏或格式不正确：{e}")
}

fn write_err(e: io::Error) -> String {
    format!("无法写入下载目录：{e}")
}

fn extract(archive: &Path, staging: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| format!("无法打开下载的压缩包：{e}"))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(BufReader::new(file)));
    for entry in tar.entries().map_err(bad)? {
        let mut entry = entry.map_err(bad)?;
        let kind = entry.header().entry_type();
        let path = entry.path().map_err(bad)?.into_owned();
        let Some(rel) = safe_relative(&path) else {
            log::warn!("压缩包里的路径不正常，已跳过：{}", path.display());
            continue;
        };
        let dest = staging.join(&rel);
        if kind.is_dir() {
            fs::create_dir_all(&dest).map_err(write_err)?;
        } else if kind.is_file() {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(write_err)?;
            }
            // 同一个名字前面已经解出了文件夹：不拿文件盖它
            if dest.is_dir() {
                continue;
            }
            let mut out = fs::File::create(&dest).map_err(write_err)?;
            io::copy(&mut entry, &mut out).map_err(bad)?;
            set_mode(&dest, entry.header().mode().unwrap_or(0o644));
        } else {
            // 符号链接、硬链接、设备、FIFO：一律不解
            log::warn!("压缩包里的 {} 不是普通文件或文件夹（{kind:?}），已跳过", path.display());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o755));
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {}

fn move_out(staging: &Path, into: &Path) -> Result<Vec<PathBuf>, String> {
    let mut names: Vec<_> = fs::read_dir(staging)
        .map_err(write_err)?
        .filter_map(|e| e.ok().map(|e| e.file_name()))
        .collect();
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let from = staging.join(&name);
        let to = unique_path(into, &name.to_string_lossy(), from.is_dir());
        fs::rename(&from, &to).map_err(write_err)?;
        out.push(to);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 测试用的临时目录，用完删掉
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("evershell-unpack-test-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// 造一个条目；name 直接写进头里，不经过 tar 库的路径检查，好造出带 `..` 和绝对路径的坏包
    fn raw_entry(b: &mut tar::Builder<impl Write>, name: &str, kind: tar::EntryType, data: &[u8], link: Option<&str>) {
        let mut h = tar::Header::new_gnu();
        h.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
        h.set_entry_type(kind);
        h.set_size(data.len() as u64);
        h.set_mode(0o4777);
        if let Some(l) = link {
            h.as_old_mut().linkname[..l.len()].copy_from_slice(l.as_bytes());
        }
        h.set_cksum();
        b.append(&h, data).unwrap();
    }

    fn make_archive(dir: &Path) -> PathBuf {
        let path = dir.join("pack.tar.gz");
        let gz = flate2::write::GzEncoder::new(fs::File::create(&path).unwrap(), flate2::Compression::fast());
        let mut b = tar::Builder::new(gz);
        raw_entry(&mut b, "nginx/", tar::EntryType::Directory, b"", None);
        raw_entry(&mut b, "nginx/nginx.conf", tar::EntryType::Regular, b"user www-data;", None);
        raw_entry(&mut b, "./note.txt", tar::EntryType::Regular, b"hi", None);
        raw_entry(&mut b, "../evil.txt", tar::EntryType::Regular, b"x", None);
        raw_entry(&mut b, "/tmp/evershell-abs.txt", tar::EntryType::Regular, b"x", None);
        raw_entry(&mut b, "nginx/link", tar::EntryType::Symlink, b"", Some("/etc/passwd"));
        raw_entry(&mut b, "nginx/hard", tar::EntryType::Link, b"", Some("../evil.txt"));
        b.into_inner().unwrap().finish().unwrap();
        path
    }

    #[test]
    fn only_plain_files_and_dirs_stay_inside() {
        let src = Tmp::new("src");
        let downloads = Tmp::new("dl");
        let archive = make_archive(&src.0);
        let got = unpack_tar_gz(&archive, &downloads.0).unwrap();
        let names: Vec<_> = got.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["nginx", "note.txt"]);
        assert_eq!(fs::read(downloads.0.join("nginx/nginx.conf")).unwrap(), b"user www-data;");
        assert!(!downloads.0.join("nginx/link").exists() && fs::symlink_metadata(downloads.0.join("nginx/link")).is_err(), "符号链接不解");
        assert!(fs::symlink_metadata(downloads.0.join("nginx/hard")).is_err(), "硬链接不解");
        // 临时文件夹在下载目录里面，带 .. 的条目跑出去会落在下载目录
        assert!(!downloads.0.join("evil.txt").exists(), "带 .. 的不能跑出去");
        assert!(!Path::new("/tmp/evershell-abs.txt").exists(), "绝对路径不能写");
        // 临时文件夹删掉了，下载目录里只有挪出来的两项
        assert_eq!(fs::read_dir(&downloads.0).unwrap().count(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(downloads.0.join("note.txt")).unwrap().permissions().mode() & 0o7777;
            assert_eq!(mode, 0o755, "SUID 和组、其他人的写权限要去掉");
        }
    }

    #[test]
    fn same_names_get_a_number_instead_of_overwriting() {
        let src = Tmp::new("src2");
        let downloads = Tmp::new("dl2");
        fs::create_dir(downloads.0.join("nginx")).unwrap();
        fs::write(downloads.0.join("note.txt"), b"mine").unwrap();
        let got = unpack_tar_gz(&make_archive(&src.0), &downloads.0).unwrap();
        let names: Vec<_> = got.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["nginx (1)", "note (1).txt"]);
        assert_eq!(fs::read(downloads.0.join("note.txt")).unwrap(), b"mine", "本机原来的文件不能被盖掉");
    }

    #[test]
    fn broken_archive_reports_and_leaves_nothing() {
        let downloads = Tmp::new("dl3");
        let bad_file = downloads.0.join("bad.tar.gz");
        fs::write(&bad_file, b"not a gzip").unwrap();
        let err = unpack_tar_gz(&bad_file, &downloads.0).unwrap_err();
        assert!(err.contains("压缩包"), "{err}");
        assert_eq!(fs::read_dir(&downloads.0).unwrap().count(), 1, "只剩那个坏包本身");
    }

    #[test]
    fn server_names_that_could_escape_are_rejected() {
        assert_eq!(local_relative("a/b c/d.txt"), Some(PathBuf::from("a/b c/d.txt")));
        for bad in ["", "a//b", "..", "a/../b", "./a", "/abs"] {
            assert_eq!(local_relative(bad), None, "{bad:?}");
        }
    }
}
