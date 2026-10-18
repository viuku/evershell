//! 密码、私钥等机密存进保险箱：应用数据目录下的一个加密文件（格式见 `crates/vault`）。
//! 开锁的保险箱钥匙放系统钥匙串（macOS Keychain / Windows 凭据管理器 / Linux Secret Service），
//! 钥匙串里只有这一条。设计见需求文档 3.5。
//!
//! 钥匙和保险箱第一次用到时读一次，之后缓存在内存里。还没存过任何机密时不碰钥匙串。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use keyring::{Entry, Error as KeyringError};
use vault::{Vault, VaultKey};

/// 钥匙串里保险箱钥匙的条目名。机密 id 是 `<连接 id>.password` 这类，撞不上
const KEY_ACCOUNT: &str = "vault-key";

/// 钥匙串的最小接口：按条目名存取一段文本。正式运行用 [`SystemKeychain`]，测试用内存实现
pub trait Keychain: Send + 'static {
    /// 不存在时返回 None
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    /// 不存在时视为成功
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// 系统钥匙串，服务名用应用标识（tauri.conf.json 的 identifier）
pub struct SystemKeychain {
    service: String,
}

impl SystemKeychain {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, account: &str) -> Result<Entry, String> {
        Entry::new(&self.service, account).map_err(|e| format!("无法访问系统钥匙串：{e}"))
    }
}

impl Keychain for SystemKeychain {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match self.entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(e) => Err(format!("读取钥匙串失败：{e}")),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.entry(account)?
            .set_password(value)
            .map_err(|e| format!("写入钥匙串失败：{e}"))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(e) => Err(format!("删除钥匙串条目失败：{e}")),
        }
    }
}

#[derive(Clone)]
pub struct Secrets {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    path: PathBuf,
    keychain: Box<dyn Keychain>,
    /// 打开过就缓存，之后不再读钥匙串和文件
    opened: Option<Opened>,
}

struct Opened {
    key: VaultKey,
    vault: Vault,
}

impl Secrets {
    /// `path` 是保险箱文件，所在目录不存在时第一次写入会自动创建
    pub fn new(path: PathBuf, keychain: impl Keychain) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                path,
                keychain: Box::new(keychain),
                opened: None,
            })),
        }
    }

    /// 不存在时返回 None
    pub fn get(&self, id: &str) -> Result<Option<String>, String> {
        check_id(id)?;
        let mut inner = self.lock();
        if let Some(opened) = inner.open(false)?
            && let Some(secret) = opened.vault.get(&opened.key, id).map_err(|e| e.to_string())?
        {
            return Ok(Some(secret));
        }
        inner.migrate_legacy(id)
    }

    pub fn set(&self, id: &str, secret: &str) -> Result<(), String> {
        check_id(id)?;
        let mut inner = self.lock();
        inner.update(|vault, key| vault.set(key, id, secret))?;
        // 开发期的旧条目留着也读不到（保险箱优先），删不掉不影响这次保存
        if let Err(e) = inner.keychain.delete(id) {
            log::debug!("删除旧钥匙串条目失败: {e}");
        }
        Ok(())
    }

    /// 不存在时视为成功
    pub fn remove(&self, id: &str) -> Result<(), String> {
        check_id(id)?;
        let mut inner = self.lock();
        if inner.open(false)?.is_some_and(|o| o.vault.contains(id)) {
            inner.update(|vault, _| {
                vault.remove(id);
                Ok(())
            })?;
        }
        // 旧条目必须删掉，否则下次 get 会把它搬回保险箱
        inner.keychain.delete(id)
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // 持锁时 panic 过也继续用：缓存要么是完整的旧状态，要么是完整的新状态
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Inner {
    /// 打开保险箱。还没有钥匙时，`create` 为 false 返回 None，为 true 就新建钥匙
    fn open(&mut self, create: bool) -> Result<Option<&mut Opened>, String> {
        if self.opened.is_none() {
            self.opened = self.load(create)?;
        }
        Ok(self.opened.as_mut())
    }

    fn load(&self, create: bool) -> Result<Option<Opened>, String> {
        let key = match self.keychain.get(KEY_ACCOUNT)? {
            Some(text) => VaultKey::from_base64(&text)
                .inspect_err(|_| log::warn!("钥匙串里的保险箱钥匙格式不对，当作没有"))
                .ok(),
            None => None,
        };
        let file = match read_file(&self.path)? {
            None => None,
            Some(bytes) => match Vault::parse(&bytes) {
                Ok(vault) => Some(vault),
                // 新版本软件建的保险箱：原样留着，等用户升级
                Err(e @ vault::Error::UnsupportedVersion(_)) => return Err(e.to_string()),
                Err(e) => {
                    set_aside(&self.path, &e.to_string())?;
                    None
                }
            },
        };
        match (key, file) {
            (Some(key), Some(vault)) if vault.unlocks_with(&key) => Ok(Some(Opened { key, vault })),
            (key, Some(_)) => {
                let reason = if key.is_some() { "钥匙对不上" } else { "钥匙串里没有钥匙" };
                set_aside(&self.path, reason)?;
                self.fresh(key, create)
            }
            (key, None) => self.fresh(key, create),
        }
    }

    /// 新建一个空保险箱（第一次写入时才落盘）。还没有钥匙时，`create` 为 false 就先不建
    fn fresh(&self, key: Option<VaultKey>, create: bool) -> Result<Option<Opened>, String> {
        let key = match key {
            Some(key) => key,
            None if create => {
                let key = VaultKey::generate().map_err(|e| e.to_string())?;
                self.keychain.set(KEY_ACCOUNT, &key.to_base64())?;
                key
            }
            None => return Ok(None),
        };
        let vault = Vault::new(&key).map_err(|e| e.to_string())?;
        Ok(Some(Opened { key, vault }))
    }

    /// 改保险箱并写回文件；写文件失败时内存里也不改
    fn update(&mut self, change: impl FnOnce(&mut Vault, &VaultKey) -> vault::Result<()>) -> Result<(), String> {
        let path = self.path.clone();
        let opened = self.open(true)?.ok_or("无法打开保险箱")?;
        let mut next = opened.vault.clone();
        change(&mut next, &opened.key).map_err(|e| e.to_string())?;
        write_file(&path, &next.to_bytes())?;
        opened.vault = next;
        Ok(())
    }

    /// 开发期每条机密单独存一条钥匙串（条目名就是机密 id）。读到就搬进保险箱、删掉原条目。
    /// 正式发布前没有这种旧数据，届时可以删掉。
    fn migrate_legacy(&mut self, id: &str) -> Result<Option<String>, String> {
        let Some(secret) = self.keychain.get(id)? else {
            return Ok(None);
        };
        self.update(|vault, key| vault.set(key, id, &secret))?;
        if let Err(e) = self.keychain.delete(id) {
            log::warn!("已搬进保险箱，但旧钥匙串条目没删掉: {e}");
        }
        log::info!("已把一条旧钥匙串机密搬进保险箱");
        Ok(Some(secret))
    }
}

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("机密 id 不能为空".into());
    }
    if id == KEY_ACCOUNT {
        return Err("机密 id 和保险箱钥匙重名".into());
    }
    Ok(())
}

fn read_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取保险箱失败：{e}")),
    }
}

/// 先写临时文件再改名，写到一半断电也不会留下半个保险箱
fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let fail = |e: std::io::Error| format!("写入保险箱失败：{e}");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(fail)?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp).map_err(fail)?;
    file.write_all(bytes).map_err(fail)?;
    file.sync_all().map_err(fail)?;
    drop(file);
    std::fs::rename(&tmp, path).map_err(fail)
}

/// 打不开的保险箱改名留着（万一钥匙以后找回来），腾出位置给新的
fn set_aside(path: &Path, reason: &str) -> Result<(), String> {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = path.with_file_name(format!("vault-unreadable-{secs}.json"));
    std::fs::rename(path, &backup).map_err(|e| format!("无法备份打不开的保险箱：{e}"))?;
    log::warn!("保险箱打不开（{reason}），已改名为 {}，换一个新的", backup.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    /// 内存里的钥匙串，克隆后共享同一份数据，测试里可以直接查看
    #[derive(Clone, Default)]
    struct MemoryKeychain {
        items: Arc<Mutex<HashMap<String, String>>>,
        /// 为 true 时所有操作都报错，模拟钥匙串被锁或拒绝授权
        broken: Arc<Mutex<bool>>,
    }

    impl MemoryKeychain {
        fn items(&self) -> HashMap<String, String> {
            self.items.lock().unwrap().clone()
        }

        fn fail_if_broken(&self) -> Result<(), String> {
            if *self.broken.lock().unwrap() {
                Err("钥匙串被锁".into())
            } else {
                Ok(())
            }
        }
    }

    impl Keychain for MemoryKeychain {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            self.fail_if_broken()?;
            Ok(self.items.lock().unwrap().get(account).cloned())
        }

        fn set(&self, account: &str, value: &str) -> Result<(), String> {
            self.fail_if_broken()?;
            self.items.lock().unwrap().insert(account.into(), value.into());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), String> {
            self.fail_if_broken()?;
            self.items.lock().unwrap().remove(account);
            Ok(())
        }
    }

    /// 每个测试一个临时目录，用完删掉
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("evershell-secrets-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            Self(dir)
        }

        fn vault(&self) -> PathBuf {
            self.0.join("vault.json")
        }

        fn files(&self) -> Vec<String> {
            let mut names: Vec<_> = std::fs::read_dir(&self.0)
                .map(|it| it.map(|e| e.unwrap().file_name().into_string().unwrap()).collect())
                .unwrap_or_default();
            names.sort();
            names
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn roundtrip_and_persist() {
        let dir = TempDir::new("roundtrip");
        let keychain = MemoryKeychain::default();
        let secrets = Secrets::new(dir.vault(), keychain.clone());
        assert_eq!(secrets.get("srv_1.password").unwrap(), None);
        secrets.set("srv_1.password", "s3cret 密码").unwrap();
        secrets.set("srv_1.password", "updated").unwrap();
        assert_eq!(secrets.get("srv_1.password").unwrap().as_deref(), Some("updated"));

        // 钥匙串里只有钥匙，文件里没有明文
        assert_eq!(keychain.items().keys().collect::<Vec<_>>(), [KEY_ACCOUNT]);
        let text = std::fs::read_to_string(dir.vault()).unwrap();
        assert!(!text.contains("updated"), "{text}");

        // 重新打开（相当于重启应用）还能读到
        let reopened = Secrets::new(dir.vault(), keychain.clone());
        assert_eq!(reopened.get("srv_1.password").unwrap().as_deref(), Some("updated"));

        reopened.remove("srv_1.password").unwrap();
        assert_eq!(reopened.get("srv_1.password").unwrap(), None);
        // 删不存在的条目也不报错
        reopened.remove("srv_1.password").unwrap();
    }

    #[test]
    fn untouched_until_first_save() {
        let dir = TempDir::new("untouched");
        let keychain = MemoryKeychain::default();
        let secrets = Secrets::new(dir.vault(), keychain.clone());
        assert_eq!(secrets.get("a").unwrap(), None);
        secrets.remove("a").unwrap();
        assert!(keychain.items().is_empty(), "没存过东西就不该建钥匙");
        assert!(dir.files().is_empty());
    }

    #[test]
    fn missing_key_sets_old_vault_aside() {
        let dir = TempDir::new("missing-key");
        let keychain = MemoryKeychain::default();
        Secrets::new(dir.vault(), keychain.clone()).set("a", "x").unwrap();
        keychain.delete(KEY_ACCOUNT).unwrap();

        let secrets = Secrets::new(dir.vault(), keychain.clone());
        assert_eq!(secrets.get("a").unwrap(), None);
        let files = dir.files();
        assert_eq!(files.len(), 1);
        assert!(files[0].starts_with("vault-unreadable-"), "{files:?}");

        // 之后照常能存，用的是新钥匙
        secrets.set("a", "y").unwrap();
        assert_eq!(secrets.get("a").unwrap().as_deref(), Some("y"));
        assert_eq!(dir.files().len(), 2);
    }

    #[test]
    fn mismatched_key_sets_old_vault_aside() {
        let dir = TempDir::new("mismatch");
        let keychain = MemoryKeychain::default();
        Secrets::new(dir.vault(), keychain.clone()).set("a", "x").unwrap();
        let other = VaultKey::generate().unwrap();
        keychain.set(KEY_ACCOUNT, &other.to_base64()).unwrap();

        let secrets = Secrets::new(dir.vault(), keychain.clone());
        assert_eq!(secrets.get("a").unwrap(), None);
        secrets.set("b", "y").unwrap();
        // 钥匙串里的钥匙没被换掉
        assert_eq!(keychain.items()[KEY_ACCOUNT], *other.to_base64());
        assert!(dir.files().iter().any(|f| f.starts_with("vault-unreadable-")));
    }

    #[test]
    fn keychain_error_leaves_everything_alone() {
        let dir = TempDir::new("locked");
        let keychain = MemoryKeychain::default();
        Secrets::new(dir.vault(), keychain.clone()).set("a", "x").unwrap();

        *keychain.broken.lock().unwrap() = true;
        let secrets = Secrets::new(dir.vault(), keychain.clone());
        assert!(secrets.get("a").is_err());
        assert!(secrets.set("b", "y").is_err());
        assert_eq!(dir.files(), ["vault.json"], "钥匙串暂时打不开时不能动保险箱");

        // 钥匙串恢复后照常读到
        *keychain.broken.lock().unwrap() = false;
        assert_eq!(secrets.get("a").unwrap().as_deref(), Some("x"));
    }

    #[test]
    fn newer_vault_format_is_kept() {
        let dir = TempDir::new("newer");
        std::fs::create_dir_all(&dir.0).unwrap();
        std::fs::write(dir.vault(), br#"{"version":99}"#).unwrap();
        let secrets = Secrets::new(dir.vault(), MemoryKeychain::default());
        assert!(secrets.get("a").unwrap_err().contains("升级"));
        assert!(secrets.set("a", "x").is_err());
        assert_eq!(std::fs::read(dir.vault()).unwrap(), br#"{"version":99}"#);
    }

    #[test]
    fn legacy_keychain_entries_move_into_vault() {
        let dir = TempDir::new("legacy");
        let keychain = MemoryKeychain::default();
        keychain.set("srv_1.password", "old-way").unwrap();
        keychain.set("srv_2.password", "to-delete").unwrap();

        let secrets = Secrets::new(dir.vault(), keychain.clone());
        assert_eq!(secrets.get("srv_1.password").unwrap().as_deref(), Some("old-way"));
        let items = keychain.items();
        assert!(!items.contains_key("srv_1.password"), "搬完要删掉旧条目");
        assert!(items.contains_key(KEY_ACCOUNT));
        // 之后从保险箱读
        assert_eq!(secrets.get("srv_1.password").unwrap().as_deref(), Some("old-way"));

        // 删除时连旧条目一起删，不会被搬回来
        secrets.remove("srv_2.password").unwrap();
        assert_eq!(secrets.get("srv_2.password").unwrap(), None);
    }

    #[test]
    fn reserved_and_empty_ids_are_rejected() {
        let dir = TempDir::new("ids");
        let secrets = Secrets::new(dir.vault(), MemoryKeychain::default());
        for id in ["", KEY_ACCOUNT] {
            assert!(secrets.get(id).is_err());
            assert!(secrets.set(id, "x").is_err());
            assert!(secrets.remove(id).is_err());
        }
    }

    /// 会真的往系统钥匙串写一条测试数据（服务名带 .test 后缀，用完即删），所以默认忽略。
    /// 手动运行：cargo test -p evershell-desktop --lib system_keychain_roundtrip -- --ignored
    #[test]
    #[ignore]
    fn system_keychain_roundtrip() {
        let keychain = SystemKeychain::new("dev.evershell.desktop.test");
        let account = format!("test-{}", std::process::id());
        assert_eq!(keychain.get(&account).unwrap(), None);
        keychain.set(&account, "s3cret 密码").unwrap();
        assert_eq!(keychain.get(&account).unwrap().as_deref(), Some("s3cret 密码"));
        keychain.delete(&account).unwrap();
        assert_eq!(keychain.get(&account).unwrap(), None);
        keychain.delete(&account).unwrap();
    }
}
