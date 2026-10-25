//! 让用户在本机选一个文件，由应用自己读出来。
//!
//! 网页里的 `<input type="file">` 是 WKWebView 的网页进程去读，OneDrive、iCloud 里“仅在线”的文件
//! （本机只有占位，读的时候才下载）它读不出来，选了没反应（docs/handbook/pitfalls.md）。
//! 应用自己的进程去读，系统会先把文件下载下来。

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 私钥文件最大多少：最长的 RSA 私钥也只有十几 KB，比这大的多半是选错了文件
const MAX_KEY_BYTES: u64 = 1024 * 1024;

#[derive(Serialize)]
pub struct PickedFile {
    name: String,
    text: String,
}

/// 弹系统的选文件框选一个文件，取消返回 None。要在主线程调，选的时候会一直等着
#[cfg(target_os = "macos")]
pub fn pick_one() -> Result<Option<PathBuf>, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};

    let mtm = MainThreadMarker::new().ok_or("选文件框只能在主线程打开")?;
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setCanChooseFiles(true);
    panel.setCanChooseDirectories(false);
    panel.setAllowsMultipleSelection(false);
    if panel.runModal() != NSModalResponseOK {
        return Ok(None);
    }
    Ok(panel.URL().and_then(|url| url.path()).map(|path| PathBuf::from(path.to_string())))
}

#[cfg(not(target_os = "macos"))]
pub fn pick_one() -> Result<Option<PathBuf>, String> {
    Err("这个系统上还不能选私钥文件，请把私钥内容粘贴进来".into())
}

/// 读选中的私钥文件。文件在云盘里、本机只有占位时，这里会等系统把它下载下来
pub fn read_key_file(path: &Path) -> Result<PickedFile, String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|f| f.take(MAX_KEY_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|e| {
            let hint = if in_cloud_folder(path) { "。文件在云盘里的话，联网后再试一次" } else { "" };
            format!("读不了「{name}」：{e}{hint}")
        })?;
    if bytes.len() as u64 > MAX_KEY_BYTES {
        return Err(format!("「{name}」超过 1 MB，不像私钥文件"));
    }
    let text = String::from_utf8(bytes).map_err(|_| format!("「{name}」不是文本文件，不像私钥文件"))?;
    Ok(PickedFile { name, text })
}

/// Mac 上云盘的文件夹：OneDrive、Google Drive、Dropbox 等在 ~/Library/CloudStorage，iCloud 云盘在 ~/Library/Mobile Documents
fn in_cloud_folder(path: &Path) -> bool {
    let path = path.to_string_lossy();
    path.contains("/Library/CloudStorage/") || path.contains("/Library/Mobile Documents/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str, data: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("evershell-local-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, data).unwrap();
        path
    }

    #[test]
    fn reads_text_key() {
        let path = temp_file("id_ed25519", b"-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");
        let Ok(picked) = read_key_file(&path) else { panic!("应该读得出来") };
        assert_eq!(picked.name, "id_ed25519");
        assert!(picked.text.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
    }

    #[test]
    fn rejects_binary_and_huge_files() {
        let binary = temp_file("photo.jpg", &[0xff, 0xd8, 0xff, 0xe0, 0x00]);
        assert!(read_key_file(&binary).err().unwrap().contains("不是文本文件"));
        let huge = temp_file("big.txt", &vec![b'a'; (MAX_KEY_BYTES + 1) as usize]);
        assert!(read_key_file(&huge).err().unwrap().contains("超过 1 MB"));
    }

    #[test]
    fn missing_file_names_the_file() {
        let err = read_key_file(Path::new("/nonexistent/evershell/id_rsa")).err().unwrap();
        assert!(err.starts_with("读不了「id_rsa」"));
        let err = read_key_file(Path::new("/Users/x/Library/CloudStorage/OneDrive/id_rsa")).err().unwrap();
        assert!(err.ends_with("联网后再试一次"));
    }
}
