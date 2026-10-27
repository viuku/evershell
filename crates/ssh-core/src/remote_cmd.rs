//! 文件区要在服务器上执行的命令：快速删除、打包传输（docs/specs/file-ops.md）。
//!
//! 路径和名字来自服务器的目录列表，是不可信输入：每个参数都用单引号包起来、前面加 `--`，
//! 不合格的（相对路径、`..`、根目录、含 NUL 等）整条命令不拼，直接报错。

use crate::{Error, Result};

/// 单引号包起来；里面的 `'` 写成 `'\''`。单引号里什么都不展开，sh、bash、zsh、fish、csh 都认
pub fn quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', r"'\''"))
}

/// 绝对路径，不是根目录，没有 `.` `..` 段和空段，不含 NUL
fn check_path(path: &str) -> Result<()> {
    let ok = path.starts_with('/')
        && path != "/"
        && !path.contains('\0')
        && path[1..].trim_end_matches('/').split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..");
    if ok { Ok(()) } else { Err(Error::Sftp(format!("路径不合法：{path}"))) }
}

/// 目录里的一个名字：不为空，不是 `.` `..`，不含 `/` 和 NUL
fn check_name(name: &str) -> Result<()> {
    let ok = !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\0');
    if ok { Ok(()) } else { Err(Error::Sftp(format!("名称不合法：{name}"))) }
}

/// `rm -rf -- '路径'…`
pub fn rm_rf(paths: &[String]) -> Result<String> {
    if paths.is_empty() {
        return Err(Error::Sftp("没有要删除的项目".into()));
    }
    let mut cmd = String::from("rm -rf --");
    for p in paths {
        check_path(p)?;
        cmd.push(' ');
        cmd.push_str(&quote(p));
    }
    Ok(cmd)
}

/// 打包脚本：路径和名字作为 `$1`、`$2`… 传给 `sh -c`，不拼进脚本正文。
/// 成功时标准输出是服务器上临时包的路径；失败时把临时包删掉
const PACK_SCRIPT: &str = r#"umask 077
f=$(mktemp "${TMPDIR:-/tmp}/evershell-pack.XXXXXX") || exit 1
cd -- "$1" || { rm -f -- "$f"; exit 1; }
shift
tar -czf "$f" -- "$@" || { rm -f -- "$f"; exit 1; }
printf '%s' "$f""#;

/// 把 dir 里的 names 打成 .tar.gz 的命令
pub fn pack(dir: &str, names: &[String]) -> Result<String> {
    if names.is_empty() {
        return Err(Error::Sftp("没有要打包的项目".into()));
    }
    if dir != "/" {
        check_path(dir)?;
    }
    let mut cmd = format!("sh -c {} evershell-pack {}", quote(PACK_SCRIPT), quote(dir));
    for n in names {
        check_name(n)?;
        cmd.push(' ');
        cmd.push_str(&quote(n));
    }
    Ok(cmd)
}

/// 命令失败时给用户看的原因：标准错误的第一行非空内容，没有就写退出码
pub fn failure_reason(stderr: &[u8], code: Option<u32>) -> String {
    let text = String::from_utf8_lossy(stderr);
    match text.lines().map(str::trim).find(|l| !l.is_empty()) {
        Some(line) => line.chars().take(200).collect(),
        None => match code {
            Some(c) => format!("命令退出码 {c}"),
            None => "连接中断，命令没有执行完".into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn quote_keeps_quotes_and_specials_literal() {
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote("$(reboot)`x`\n;&|"), "'$(reboot)`x`\n;&|'");
    }

    #[test]
    fn rm_quotes_each_path_after_double_dash() {
        let cmd = rm_rf(&s(&["/var/log/a b", "/tmp/-rf", "/srv/it's"])).unwrap();
        assert_eq!(cmd, r"rm -rf -- '/var/log/a b' '/tmp/-rf' '/srv/it'\''s'");
    }

    #[test]
    fn rm_rejects_bad_paths() {
        for bad in ["/", "relative", "", "/var/../etc", "/var/./x", "//x", "/a\0b"] {
            assert!(rm_rf(&s(&["/ok", bad])).is_err(), "{bad:?} 应被拒");
        }
        assert!(rm_rf(&[]).is_err());
        // 末尾的斜杠不影响
        assert!(rm_rf(&s(&["/var/log/nginx/"])).is_ok());
    }

    #[test]
    fn pack_passes_paths_as_sh_arguments() {
        let cmd = pack("/var/log", &s(&["nginx", "my file", "-x"])).unwrap();
        assert!(cmd.starts_with("sh -c 'umask 077"), "{cmd}");
        assert!(cmd.ends_with(" evershell-pack '/var/log' 'nginx' 'my file' '-x'"), "{cmd}");
        // 根目录下的也能打
        assert!(pack("/", &s(&["etc"])).is_ok());
    }

    #[test]
    fn pack_rejects_bad_names() {
        for bad in ["", ".", "..", "a/b", "a\0"] {
            assert!(pack("/var", &s(&[bad])).is_err(), "{bad:?} 应被拒");
        }
        assert!(pack("relative", &s(&["a"])).is_err());
        assert!(pack("/var", &[]).is_err());
    }

    #[test]
    fn failure_reason_is_first_stderr_line() {
        assert_eq!(failure_reason(b"\n  rm: cannot remove 'x': Permission denied\nmore", Some(1)), "rm: cannot remove 'x': Permission denied");
        assert_eq!(failure_reason(b"", Some(2)), "命令退出码 2");
    }
}
