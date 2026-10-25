//! 一键导入：到别的 SSH 软件默认存配置的位置读文件，交给前端的解析器（packages/ui/src/core/importers）。
//! 前端只能调用、不能传路径，能读哪些位置由这里的表决定。连接和快捷命令各一张表，
//! 规格见 docs/specs/one-click-import.md、docs/specs/command-import.md。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 单个文件的上限，和前端 import-files.ts 的 MAX_FILE_BYTES 一致；超过的跳过
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// 只取一部分的 JSON 配置（FinalShell 的 config.json 带着几千条历史命令）可以大一些，交出去的只是其中一块
const MAX_JSON_BYTES: u64 = 16 * 1024 * 1024;
/// 一个来源最多读的文件数、总字节数、看过的目录项数。配置都很小，超了多半是位置不对，整个不读
const MAX_FILES: usize = 2000;
const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
/// 文件夹最多往下几层（FinalShell 和 SecureCRT 的文件夹可以嵌套）
const MAX_DEPTH: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
    Linux,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// 系统目录。Mac 上 `data` 是 ~/Library/Application Support；Windows 上 `data` 是 %APPDATA%，`local_data` 是 %LOCALAPPDATA%
pub struct Dirs {
    pub home: PathBuf,
    pub data: PathBuf,
    pub local_data: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
enum Kind {
    File,
    /// 整个文件夹（含子文件夹），只读这些扩展名；空表示不限
    Dir(&'static [&'static str]),
    /// 一个 JSON 文件，只把顶层这几项交给前端。FinalShell 的 config.json 里还有它自己的密码和私钥列表，不能整个交出去
    JsonPart(&'static [&'static str]),
}

#[derive(Debug)]
struct Location {
    /// 和前端 core/importers/types.ts 的 ImportSource 一致
    source: &'static str,
    /// 依次查，用第一个存在的；都不存在时给用户看第一个
    candidates: Vec<PathBuf>,
    kind: Kind,
}

/// 各平台查哪些位置。依据和手动导入的说明一样，见 packages/ui/src/core/importers/sources.ts
fn locations(platform: Platform, dirs: &Dirs) -> Vec<Location> {
    let home = &dirs.home;
    let openssh = Location {
        source: "openssh",
        candidates: vec![home.join(".ssh").join("config")],
        kind: Kind::File,
    };
    // Unix 版 PuTTY 优先用 ~/.putty，没有才用 XDG 的 ~/.config/putty
    let putty = Location {
        source: "putty",
        candidates: vec![
            home.join(".putty").join("sessions"),
            home.join(".config").join("putty").join("sessions"),
        ],
        kind: Kind::Dir(&[]),
    };
    match platform {
        Platform::Mac => vec![
            Location {
                source: "finalshell",
                candidates: vec![home.join("Library").join("FinalShell").join("conn")],
                kind: Kind::Dir(&["json"]),
            },
            putty,
            Location {
                source: "securecrt",
                candidates: vec![dirs.data.join("VanDyke").join("SecureCRT").join("Config").join("Sessions")],
                kind: Kind::Dir(&["ini"]),
            },
            openssh,
        ],
        // 还没在 Windows 上跑过。PuTTY 存在注册表里；Xshell 的目录带版本号，做 Windows 版时再加
        Platform::Windows => vec![
            Location {
                source: "finalshell",
                candidates: vec![dirs.local_data.join("finalshell").join("conn")],
                kind: Kind::Dir(&["json"]),
            },
            Location {
                source: "mobaxterm",
                candidates: vec![dirs.data.join("MobaXterm").join("MobaXterm.ini")],
                kind: Kind::File,
            },
            Location {
                source: "securecrt",
                candidates: vec![dirs.data.join("VanDyke").join("Config").join("Sessions")],
                kind: Kind::Dir(&["ini"]),
            },
            openssh,
        ],
        Platform::Linux => vec![putty, openssh],
    }
}

/// 快捷命令在各平台查哪些位置。依据见 packages/ui/src/core/importers/commands/ 下各解析器的文件头
fn command_locations(platform: Platform, dirs: &Dirs) -> Vec<Location> {
    let home = &dirs.home;
    // SecureCRT 8.7 起所有按钮栏都在这一个文件里；Electerm 只认它自己导出的文件，不在表里
    let button_bar = "ButtonBarV5.ini";
    match platform {
        Platform::Mac => vec![
            Location {
                source: "finalshell",
                candidates: vec![home.join("Library").join("FinalShell").join("config.json")],
                kind: Kind::JsonPart(&["quick_commands"]),
            },
            Location {
                source: "securecrt",
                candidates: vec![dirs.data.join("VanDyke").join("SecureCRT").join("Config").join(button_bar)],
                kind: Kind::File,
            },
        ],
        Platform::Windows => vec![
            Location {
                source: "finalshell",
                candidates: vec![dirs.local_data.join("finalshell").join("config.json")],
                kind: Kind::JsonPart(&["quick_commands"]),
            },
            Location {
                source: "securecrt",
                candidates: vec![dirs.data.join("VanDyke").join("Config").join(button_bar)],
                kind: Kind::File,
            },
        ],
        Platform::Linux => vec![],
    }
}

/// 一个来源的查找结果，和前端 types.ts 的 LocalConfigFiles 对应
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfig {
    source: &'static str,
    /// 给用户看的位置，家目录写成 ~
    location: String,
    /// 位置不存在时为空
    files: Vec<LocalFile>,
    /// 位置在、但读不了的原因
    error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LocalFile {
    /// 带所在文件夹名的相对路径，和浏览器选文件夹时一样，如 conn/生产/xxx_connect_config.json
    path: String,
    bytes: Vec<u8>,
}

/// 查本平台存连接的所有位置。读文件是同步的，调用方放到阻塞线程里跑
pub fn find(platform: Platform, dirs: &Dirs) -> Vec<LocalConfig> {
    scan(locations(platform, dirs), platform, dirs)
}

/// 查本平台存快捷命令的所有位置，同 find
pub fn find_commands(platform: Platform, dirs: &Dirs) -> Vec<LocalConfig> {
    scan(command_locations(platform, dirs), platform, dirs)
}

fn scan(locations: Vec<Location>, platform: Platform, dirs: &Dirs) -> Vec<LocalConfig> {
    locations
        .into_iter()
        .map(|loc| {
            let path = loc
                .candidates
                .iter()
                .find(|p| fs::symlink_metadata(p).is_ok())
                .unwrap_or(&loc.candidates[0]);
            let (files, error) = match read(path, &loc.kind) {
                Ok(files) => (files, None),
                Err(e) => (Vec::new(), Some(e)),
            };
            LocalConfig {
                source: loc.source,
                location: display(path, &dirs.home, platform),
                files,
                error,
            }
        })
        .collect()
}

/// 位置不存在返回空列表；存在但读不了返回原因
fn read(path: &Path, kind: &Kind) -> Result<Vec<LocalFile>, String> {
    // 位置本身可以是符号链接（有人把配置放在同步盘里再链过来），所以这里跟着链接走
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(describe(&e)),
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    match kind {
        Kind::File if meta.is_file() => {
            if meta.len() > MAX_FILE_BYTES {
                return Err("文件过大，可能不是配置文件".into());
            }
            let bytes = fs::read(path).map_err(|e| describe(&e))?;
            Ok(vec![LocalFile { path: name, bytes }])
        }
        Kind::JsonPart(keys) if meta.is_file() => {
            if meta.len() > MAX_JSON_BYTES {
                return Err("文件过大，可能不是配置文件".into());
            }
            let bytes = fs::read(path).map_err(|e| describe(&e))?;
            Ok(vec![LocalFile { path: name, bytes: json_part(&bytes, keys)? }])
        }
        Kind::Dir(exts) if meta.is_dir() => {
            let mut walker = Walker {
                exts,
                files: Vec::new(),
                total: 0,
                seen: 0,
            };
            walker.walk(path, &name, 0)?;
            Ok(walker.files)
        }
        // 该是文件的地方是文件夹，或者反过来：当作没找到
        _ => Ok(Vec::new()),
    }
}

struct Walker<'a> {
    exts: &'a [&'a str],
    files: Vec<LocalFile>,
    total: u64,
    seen: usize,
}

impl Walker<'_> {
    fn walk(&mut self, dir: &Path, rel: &str, depth: usize) -> Result<(), String> {
        let mut entries: Vec<_> = fs::read_dir(dir)
            .map_err(|e| describe(&e))?
            .filter_map(Result::ok)
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            self.seen += 1;
            if self.seen > MAX_ENTRIES {
                return Err(too_many());
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') {
                continue;
            }
            // file_type 不跟着链接走：文件夹里的符号链接一律跳过，免得读到别处的文件
            let Ok(file_type) = entry.file_type() else { continue };
            let child = format!("{rel}/{name}");
            if file_type.is_dir() {
                if depth < MAX_DEPTH {
                    self.walk(&entry.path(), &child, depth + 1)?;
                }
            } else if file_type.is_file() && self.wanted(name) {
                let Ok(meta) = entry.metadata() else { continue };
                if meta.len() > MAX_FILE_BYTES {
                    continue;
                }
                if self.files.len() >= MAX_FILES || self.total + meta.len() > MAX_TOTAL_BYTES {
                    return Err(too_many());
                }
                let bytes = fs::read(entry.path()).map_err(|e| describe(&e))?;
                self.total += bytes.len() as u64;
                self.files.push(LocalFile { path: child, bytes });
            }
        }
        Ok(())
    }

    fn wanted(&self, name: &str) -> bool {
        self.exts.is_empty()
            || name
                .rsplit_once('.')
                .is_some_and(|(stem, ext)| !stem.is_empty() && self.exts.iter().any(|e| e.eq_ignore_ascii_case(ext)))
    }
}

/// 只留顶层的这几项，重新写成 JSON。顶层不是对象时交出一个空对象，前端会说没找到
fn json_part(bytes: &[u8], keys: &[&str]) -> Result<Vec<u8>, String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "不是有效的 JSON 文件".to_string())?;
    let mut part = serde_json::Map::new();
    if let serde_json::Value::Object(mut all) = value {
        for key in keys {
            if let Some(v) = all.remove(*key) {
                part.insert((*key).to_string(), v);
            }
        }
    }
    serde_json::to_vec(&part).map_err(|e| format!("处理配置失败：{e}"))
}

fn too_many() -> String {
    "文件数量过多，可能不是配置文件夹".into()
}

fn describe(e: &io::Error) -> String {
    if e.kind() == io::ErrorKind::PermissionDenied {
        "无读取权限".into()
    } else {
        format!("读取失败：{e}")
    }
}

fn display(path: &Path, home: &Path, platform: Platform) -> String {
    if platform != Platform::Windows
        && let Ok(rest) = path.strip_prefix(home)
    {
        return format!("~/{}", rest.display());
    }
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试一个临时目录，用完删掉
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("evershell-import-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn write(&self, rel: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            path
        }

        fn dirs(&self) -> Dirs {
            Dirs {
                home: self.0.clone(),
                data: self.0.join("Library").join("Application Support"),
                local_data: self.0.join("AppData").join("Local"),
            }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn paths(files: &[LocalFile]) -> Vec<&str> {
        files.iter().map(|f| f.path.as_str()).collect()
    }

    fn by_source<'a>(found: &'a [LocalConfig], source: &str) -> &'a LocalConfig {
        found.iter().find(|c| c.source == source).unwrap()
    }

    #[test]
    fn each_platform_checks_its_own_sources() {
        let dirs = Dirs {
            home: PathBuf::from("/Users/me"),
            data: PathBuf::from("/Users/me/Library/Application Support"),
            local_data: PathBuf::from("/Users/me/Library/Application Support"),
        };
        let sources = |p| locations(p, &dirs).iter().map(|l| l.source).collect::<Vec<_>>();
        assert_eq!(sources(Platform::Mac), ["finalshell", "putty", "securecrt", "openssh"]);
        assert_eq!(sources(Platform::Windows), ["finalshell", "mobaxterm", "securecrt", "openssh"]);
        assert_eq!(sources(Platform::Linux), ["putty", "openssh"]);

        let mac = locations(Platform::Mac, &dirs);
        assert_eq!(mac[0].candidates[0], Path::new("/Users/me/Library/FinalShell/conn"));
        assert_eq!(
            mac[2].candidates[0],
            Path::new("/Users/me/Library/Application Support/VanDyke/SecureCRT/Config/Sessions")
        );
    }

    #[test]
    fn reads_folder_with_root_name_and_subfolders() {
        let t = TempDir::new("tree");
        t.write("conn/b_connect_config.json", b"{}");
        t.write("conn/prod/folder.json", b"{\"id\":\"1\"}");
        t.write("conn/prod/east/a_connect_config.json", b"{}");
        t.write("conn/.DS_Store", b"x");
        t.write("conn/readme.txt", b"x");
        t.write("conn/.hidden/c_connect_config.json", b"{}");
        let files = read(&t.0.join("conn"), &Kind::Dir(&["json"])).unwrap();
        assert_eq!(
            paths(&files),
            ["conn/b_connect_config.json", "conn/prod/east/a_connect_config.json", "conn/prod/folder.json"]
        );
        assert_eq!(files[2].bytes, b"{\"id\":\"1\"}");
    }

    #[test]
    fn skips_big_files_and_links_inside_folders() {
        let t = TempDir::new("skip");
        t.write("Sessions/ok.ini", b"S:\"Hostname\"=a");
        t.write("Sessions/huge.ini", &vec![b'x'; MAX_FILE_BYTES as usize + 1]);
        let secret = t.write("secret.ini", b"not a session");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, t.0.join("Sessions/link.ini")).unwrap();
        let files = read(&t.0.join("Sessions"), &Kind::Dir(&["ini"])).unwrap();
        assert_eq!(paths(&files), ["Sessions/ok.ini"]);
    }

    #[test]
    fn location_itself_may_be_a_link() {
        let t = TempDir::new("rootlink");
        t.write("Dropbox/conn/a.json", b"{}");
        #[cfg(unix)]
        {
            fs::create_dir_all(t.0.join("Library/FinalShell")).unwrap();
            std::os::unix::fs::symlink(t.0.join("Dropbox/conn"), t.0.join("Library/FinalShell/conn")).unwrap();
            let found = find(Platform::Mac, &t.dirs());
            assert_eq!(paths(&by_source(&found, "finalshell").files), ["conn/a.json"]);
        }
    }

    #[test]
    fn too_many_files_is_an_error_not_a_partial_read() {
        let t = TempDir::new("many");
        for i in 0..=MAX_FILES {
            t.write(&format!("sessions/s{i}"), b"HostName=a");
        }
        assert_eq!(read(&t.0.join("sessions"), &Kind::Dir(&[])).unwrap_err(), too_many());
    }

    #[test]
    fn single_file_uses_its_name_as_path() {
        let t = TempDir::new("file");
        t.write(".ssh/config", b"Host a\n");
        let files = read(&t.0.join(".ssh/config"), &Kind::File).unwrap();
        assert_eq!(paths(&files), ["config"]);
        // 该是文件的地方是文件夹：当作没找到
        assert!(read(&t.0.join(".ssh"), &Kind::File).unwrap().is_empty());
    }

    #[test]
    fn missing_locations_are_reported_without_error() {
        let t = TempDir::new("missing");
        t.write(".config/putty/sessions/web", b"HostName=a\nProtocol=ssh\n");
        let found = find(Platform::Mac, &t.dirs());

        let fs_conf = by_source(&found, "finalshell");
        assert_eq!(fs_conf.location, "~/Library/FinalShell/conn");
        assert!(fs_conf.files.is_empty() && fs_conf.error.is_none());

        // PuTTY 第一个位置没有，用第二个
        let putty = by_source(&found, "putty");
        assert_eq!(putty.location, "~/.config/putty/sessions");
        assert_eq!(paths(&putty.files), ["sessions/web"]);
    }

    #[test]
    fn command_locations_per_platform() {
        let dirs = Dirs {
            home: PathBuf::from("/Users/me"),
            data: PathBuf::from("/Users/me/Library/Application Support"),
            local_data: PathBuf::from("/Users/me/Library/Application Support"),
        };
        let mac = command_locations(Platform::Mac, &dirs);
        assert_eq!(mac.iter().map(|l| l.source).collect::<Vec<_>>(), ["finalshell", "securecrt"]);
        assert_eq!(mac[0].candidates[0], Path::new("/Users/me/Library/FinalShell/config.json"));
        assert_eq!(
            mac[1].candidates[0],
            Path::new("/Users/me/Library/Application Support/VanDyke/SecureCRT/Config/ButtonBarV5.ini")
        );
        let win = command_locations(Platform::Windows, &dirs);
        assert_eq!(win.iter().map(|l| l.source).collect::<Vec<_>>(), ["finalshell", "securecrt"]);
        assert!(command_locations(Platform::Linux, &dirs).is_empty());
    }

    #[test]
    fn finalshell_config_only_hands_over_quick_commands() {
        let t = TempDir::new("fs-cmds");
        t.write(
            "Library/FinalShell/config.json",
            br#"{"password":"FAKE-PASSWORD","secret_key_list":[{"private_key":"FAKE-KEY"}],"quick_commands":[{"name":"g","commands":[]}],"theme":"x"}"#,
        );
        let found = find_commands(Platform::Mac, &t.dirs());
        let fs_conf = by_source(&found, "finalshell");
        assert_eq!(fs_conf.location, "~/Library/FinalShell/config.json");
        assert_eq!(paths(&fs_conf.files), ["config.json"]);
        let text = String::from_utf8(fs_conf.files[0].bytes.clone()).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value, serde_json::json!({ "quick_commands": [{ "name": "g", "commands": [] }] }));
        assert!(!text.contains("FAKE"));
    }

    #[test]
    fn json_part_rejects_broken_json_and_tolerates_other_shapes() {
        assert_eq!(json_part(b"{oops", &["quick_commands"]).unwrap_err(), "不是有效的 JSON 文件");
        assert_eq!(json_part(b"[1,2]", &["quick_commands"]).unwrap(), b"{}");
        assert_eq!(json_part(br#"{"theme":1}"#, &["quick_commands"]).unwrap(), b"{}");
    }

    #[test]
    fn serializes_for_the_frontend() {
        let t = TempDir::new("json");
        t.write(".ssh/config", b"Host a");
        let found = find(Platform::Linux, &t.dirs());
        let json = serde_json::to_value(by_source(&found, "openssh")).unwrap();
        assert_eq!(json["location"], "~/.ssh/config");
        assert_eq!(json["files"][0]["path"], "config");
        assert_eq!(json["files"][0]["bytes"][0], b'H');
        assert!(json["error"].is_null());
    }
}
