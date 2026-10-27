//! 密码、私钥等机密存进保险箱：应用数据目录下的一个加密文件（格式见 `crates/vault`）。
//! 开锁的保险箱钥匙放系统钥匙串（macOS Keychain / Windows 凭据管理器 / Linux Secret Service），
//! 钥匙串里只有这一条。设计见需求文档 3.5。
//!
//! 钥匙和保险箱第一次用到时读一次，之后缓存在内存里。还没存过任何机密时不碰钥匙串。
//!
//! 云同步（docs/specs/sync.md）也经过这里：机密原文只在这里加解密，不交给前端；
//! 登录别的账号时换成云端的保险箱钥匙（[`Secrets::adopt_key`]）。

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use keyring::{Entry, Error as KeyringError};
use vault::sync::{RecordAad, RecordKey, SECRET_COLLECTION, VAULT_ID_ENTRY};
use vault::{Vault, VaultKey};
use zeroize::Zeroizing;

/// 钥匙串里保险箱钥匙的条目名。机密 id 是 `<连接 id>.password` 这类，撞不上
const KEY_ACCOUNT: &str = "vault-key";
/// 不走 secret 集合同步的条目：主机密钥记录走 known-host 集合，`sync.` 开头的是同步自己的登录凭据
const KNOWN_HOSTS: &str = "known_hosts";
const SYNC_PREFIX: &str = "sync.";
/// 同步要用保险箱钥匙时本机却没有。新建一把会和云端对不上，只能重新登录换回云端那把
const NO_VAULT_KEY: &str = "本机缺少保险箱钥匙，请重新登录云同步";
const NOT_SYNCED: &str = "该条目不参与云同步";
/// 换钥匙时新钥匙加密的保险箱先写在这里，钥匙串换好以后再改名盖过保险箱文件
const ADOPTING_FILE: &str = "vault-adopting.json";

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
        self.lock().set(id, secret)
    }

    /// 不存在时视为成功
    pub fn remove(&self, id: &str) -> Result<(), String> {
        check_id(id)?;
        self.lock().remove(id)
    }

    /// 每条机密的摘要（带钥匙的 HMAC，算法见 `vault::Vault::digests`），同步拿它发现保险箱的改动。
    /// 不含不走 secret 集合的条目；还没有保险箱时为空
    pub fn digests(&self) -> Result<BTreeMap<String, String>, String> {
        let mut inner = self.lock();
        let Some(opened) = inner.open(false)? else {
            return Ok(BTreeMap::new());
        };
        Ok(opened
            .vault
            .digests(&opened.key)
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|(id, _)| syncable(id))
            .map(|(id, digest)| (id.to_owned(), digest))
            .collect())
    }

    /// 把这条机密加密成同步记录，返回 base64；不存在返回 None。
    /// 墓碑（`aad.deleted`）直接加密空内容，不读保险箱：这时条目多半已经删了
    pub fn seal_entry(&self, id: &str, aad: &RecordAad) -> Result<Option<String>, String> {
        check_sync_entry(id, aad)?;
        let mut inner = self.lock();
        if aad.deleted {
            let opened = inner.open(false)?.ok_or(NO_VAULT_KEY)?;
            let key = RecordKey::from_vault_key(&opened.key);
            return vault::sync::seal_record(&key, aad, b"")
                .map(Some)
                .map_err(|e| e.to_string());
        }
        let Some(opened) = inner.open(false)? else {
            return Ok(None);
        };
        let Some(secret) = opened.vault.get(&opened.key, id).map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        let secret = Zeroizing::new(secret);
        let key = RecordKey::from_vault_key(&opened.key);
        vault::sync::seal_record(&key, aad, secret.as_bytes())
            .map(Some)
            .map_err(|e| e.to_string())
    }

    /// 解密同步记录写进保险箱；墓碑（`aad.deleted`）就删掉这条。认证失败返回 false，什么都不改
    pub fn open_entry(&self, id: &str, aad: &RecordAad, data: &str) -> Result<bool, String> {
        check_sync_entry(id, aad)?;
        let mut inner = self.lock();
        let opened = inner.open(false)?.ok_or(NO_VAULT_KEY)?;
        let key = RecordKey::from_vault_key(&opened.key);
        let Ok(plain) = vault::sync::open_record(&key, aad, data) else {
            return Ok(false);
        };
        if aad.deleted {
            inner.remove(id)?;
        } else {
            let secret = Zeroizing::new(String::from_utf8(plain.to_vec()).map_err(|_| "同步的机密不是 UTF-8 文本")?);
            inner.set(id, &secret)?;
        }
        Ok(true)
    }

    /// 第一次登录去重时把机密挪到云端那条记录的 id 下：`to` 已经有了就不覆盖，只删 `from`；
    /// `from` 不存在时什么都不做。一次写入完成，原文不经过前端
    pub fn move_entry(&self, from: &str, to: &str) -> Result<(), String> {
        for id in [from, to] {
            check_id(id)?;
            if !syncable(id) {
                return Err(NOT_SYNCED.into());
            }
        }
        if from == to {
            return Ok(());
        }
        let mut inner = self.lock();
        if !inner.open(false)?.is_some_and(|o| o.vault.contains(from)) {
            return Ok(());
        }
        inner.update(|vault, key| {
            if !vault.contains(to) {
                let secret = Zeroizing::new(vault.get(key, from)?.unwrap_or_default());
                vault.set(key, to, &secret)?;
            }
            vault.remove(from);
            Ok(())
        })?;
        // 和 remove 一样要删开发期的旧钥匙串条目，不然下次读 from 会把它搬回来
        if let Err(e) = inner.keychain.delete(from) {
            log::debug!("删除旧钥匙串条目失败: {e}");
        }
        Ok(())
    }

    /// 保险箱的校验值（由钥匙和保险箱编号算出，算法见 `vault::sync::key_check`）；还没有钥匙时为 None，不新建。
    /// 编号存在条目 `sync.vault-id` 里，要落了盘才稳定：还没有编号的保险箱、还只在内存里的新保险箱，
    /// 在这里补上编号写进文件。注册、登录时引擎就会调它，所以之后记下的值不会再变
    pub fn key_check(&self) -> Result<Option<String>, String> {
        let mut inner = self.lock();
        let path = inner.path.clone();
        let Some(opened) = inner.open(false)? else {
            return Ok(None);
        };
        let key = opened.key.clone();
        let stored = opened.vault.get(&key, VAULT_ID_ENTRY).map_err(|e| e.to_string())?;
        let id = match stored {
            Some(id) => id,
            None => vault::sync::new_vault_id().map_err(|e| e.to_string())?,
        };
        if vault_id_on_disk(&path, &key).as_deref() != Some(id.as_str()) {
            inner.update(|vault, key| vault.set(key, VAULT_ID_ENTRY, &id))?;
        }
        Ok(Some(vault::sync::key_check(&key, &id)))
    }

    /// 同步加解密普通记录用的记录钥匙。本机没有保险箱钥匙时报错，不新建
    pub fn record_key(&self) -> Result<RecordKey, String> {
        let mut inner = self.lock();
        let opened = inner.open(false)?.ok_or(NO_VAULT_KEY)?;
        Ok(RecordKey::from_vault_key(&opened.key))
    }

    /// 返回保险箱钥匙的副本；还没有就生成一把存进钥匙串（空保险箱等第一次写入时才落盘）。
    /// 注册同步时要用同步密码锁住它上传
    pub fn ensure_key(&self) -> Result<VaultKey, String> {
        let mut inner = self.lock();
        let opened = inner.open(true)?.ok_or("无法打开保险箱")?;
        Ok(opened.key.clone())
    }

    /// 换成云端的保险箱钥匙：全部条目用旧钥匙解开、新钥匙加密。分两步，中途退出也不会丢机密：
    /// 新保险箱先写到 `vault-adopting.json`，再换钥匙串里的钥匙（提交点），最后改名盖过保险箱文件；
    /// 中断后下次打开时由 `finish_adopting` 收尾。
    /// 提交点之前失败什么都不变；和当前是同一把时什么都不做；本机还没有保险箱时直接存新钥匙
    pub fn adopt_key(&self, new_key: VaultKey) -> Result<(), String> {
        let mut inner = self.lock();
        let path = inner.path.clone();
        let Some(opened) = inner.open(false)? else {
            inner.keychain.set(KEY_ACCOUNT, &new_key.to_base64())?;
            let vault = Vault::new(&new_key).map_err(|e| e.to_string())?;
            inner.opened = Some(Opened { key: new_key, vault });
            return Ok(());
        };
        if *opened.key.to_base64() == *new_key.to_base64() {
            return Ok(());
        }
        let next = opened.vault.rekey(&opened.key, &new_key).map_err(|e| e.to_string())?;
        let adopting = adopting_path(&path);
        write_file(&adopting, &next.to_bytes())?;
        if let Err(e) = inner.keychain.set(KEY_ACCOUNT, &new_key.to_base64()) {
            // 钥匙串没换成，保险箱文件也没动过。半成品删不掉也没关系，下次打开时会删
            if let Err(rm) = std::fs::remove_file(&adopting) {
                log::warn!("删除换钥匙的临时文件失败: {rm}");
            }
            return Err(e);
        }
        // 钥匙串已经换了，换钥匙就算完成。改名失败时内存里照样用新的，下次写入会直接写保险箱文件，
        // 不写入就退出的话，下次打开时补上改名
        if let Err(e) = std::fs::rename(&adopting, &path) {
            log::warn!("换保险箱钥匙时改名失败，下次打开时补上: {e}");
        }
        inner.opened = Some(Opened { key: new_key, vault: next });
        log::info!("已换用云端的保险箱钥匙");
        Ok(())
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
        let file = self.finish_adopting(key.as_ref(), file);
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

    /// 上次换钥匙（`Secrets::adopt_key`）中途退出时收尾，返回该用的保险箱：
    /// 钥匙串里的钥匙打不开保险箱文件、却能打开 `vault-adopting.json`，说明钥匙串已经换了、只差改名，补上改名；
    /// 否则这份是多余的（钥匙串还没换，或者保险箱文件后来已经写过新的），删掉
    fn finish_adopting(&self, key: Option<&VaultKey>, file: Option<Vault>) -> Option<Vault> {
        let adopting = adopting_path(&self.path);
        let bytes = match read_file(&adopting) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return file,
            Err(e) => {
                log::warn!("读取换钥匙的临时文件失败: {e}");
                return file;
            }
        };
        let current_opens = matches!((key, &file), (Some(key), Some(vault)) if vault.unlocks_with(key));
        if !current_opens
            && let Some(key) = key
            && let Ok(vault) = Vault::parse(&bytes)
            && vault.unlocks_with(key)
        {
            match std::fs::rename(&adopting, &self.path) {
                Ok(()) => log::info!("上次换保险箱钥匙没做完，已补上"),
                // 改不了名也先用着：下次写入会直接写保险箱文件
                Err(e) => log::warn!("补完换钥匙时改名失败，下次打开再试: {e}"),
            }
            return Some(vault);
        }
        if let Err(e) = std::fs::remove_file(&adopting) {
            log::warn!("删除换钥匙的临时文件失败: {e}");
        }
        file
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

    fn set(&mut self, id: &str, secret: &str) -> Result<(), String> {
        self.update(|vault, key| vault.set(key, id, secret))?;
        // 开发期的旧条目留着也读不到（保险箱优先），删不掉不影响这次保存
        if let Err(e) = self.keychain.delete(id) {
            log::debug!("删除旧钥匙串条目失败: {e}");
        }
        Ok(())
    }

    fn remove(&mut self, id: &str) -> Result<(), String> {
        if self.open(false)?.is_some_and(|o| o.vault.contains(id)) {
            self.update(|vault, _| {
                vault.remove(id);
                Ok(())
            })?;
        }
        // 旧条目必须删掉，否则下次 get 会把它搬回保险箱
        self.keychain.delete(id)
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
    // 保险箱编号只由 key_check 写；前端改了它，同步会误以为保险箱被重建过
    if id == VAULT_ID_ENTRY {
        return Err("该条目由云同步保留".into());
    }
    Ok(())
}

fn syncable(id: &str) -> bool {
    id != KNOWN_HOSTS && !id.starts_with(SYNC_PREFIX)
}

/// 机密记录只能是 secret 集合、id 就是条目 id：否则前端能把机密封成普通记录再用 sync_open 解出原文，
/// 或者把别的记录写进保险箱
fn check_sync_entry(id: &str, aad: &RecordAad) -> Result<(), String> {
    check_id(id)?;
    if !syncable(id) {
        return Err(NOT_SYNCED.into());
    }
    if aad.collection != SECRET_COLLECTION || aad.id != id {
        return Err("机密条目和同步记录的标识不匹配".into());
    }
    Ok(())
}

/// 文件里那个保险箱的编号；没有文件、读不了、钥匙打不开、没有编号都算 None
fn vault_id_on_disk(path: &Path, key: &VaultKey) -> Option<String> {
    let bytes = read_file(path).ok()??;
    Vault::parse(&bytes).ok()?.get(key, VAULT_ID_ENTRY).ok()?
}

fn adopting_path(path: &Path) -> PathBuf {
    path.with_file_name(ADOPTING_FILE)
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
    std::fs::rename(path, &backup).map_err(|e| format!("备份无法解密的保险箱失败：{e}"))?;
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
        for id in ["", KEY_ACCOUNT, VAULT_ID_ENTRY] {
            assert!(secrets.get(id).is_err());
            assert!(secrets.set(id, "x").is_err());
            assert!(secrets.remove(id).is_err());
        }
    }

    fn secret_aad(id: &str, deleted: bool) -> RecordAad {
        RecordAad {
            account: "ops".into(),
            collection: SECRET_COLLECTION.into(),
            id: id.into(),
            hlc: "001793125352000-0000-3f9a1c2b7d4e5f60".into(),
            deleted,
        }
    }

    /// 钥匙串里放好这把钥匙，模拟另一台已登录同一个同步账号的设备
    fn device_with_key(dir: &TempDir, key: &VaultKey) -> (Secrets, MemoryKeychain) {
        let keychain = MemoryKeychain::default();
        keychain.set(KEY_ACCOUNT, &key.to_base64()).unwrap();
        (Secrets::new(dir.vault(), keychain.clone()), keychain)
    }

    #[test]
    fn adopt_key_reencrypts_every_entry() {
        let dir = TempDir::new("adopt");
        let keychain = MemoryKeychain::default();
        let secrets = Secrets::new(dir.vault(), keychain.clone());
        for (id, value) in [("srv_1.password", "p1"), (KNOWN_HOSTS, "host ssh-ed25519 AAAA"), ("sync.session", "tok")] {
            secrets.set(id, value).unwrap();
        }
        let old = keychain.items()[KEY_ACCOUNT].clone();

        let new_key = VaultKey::generate().unwrap();
        secrets.adopt_key(new_key.clone()).unwrap();
        assert_eq!(keychain.items()[KEY_ACCOUNT], *new_key.to_base64(), "钥匙串换成了新钥匙");
        assert_eq!(secrets.get("srv_1.password").unwrap().as_deref(), Some("p1"));

        // 重启后用钥匙串里的新钥匙读文件，旧条目都在
        let reopened = Secrets::new(dir.vault(), keychain.clone());
        assert_eq!(reopened.get("srv_1.password").unwrap().as_deref(), Some("p1"));
        assert_eq!(reopened.get(KNOWN_HOSTS).unwrap().as_deref(), Some("host ssh-ed25519 AAAA"));
        assert_eq!(reopened.get("sync.session").unwrap().as_deref(), Some("tok"));
        let file = Vault::parse(&std::fs::read(dir.vault()).unwrap()).unwrap();
        assert!(!file.unlocks_with(&VaultKey::from_base64(&old).unwrap()));
        assert_eq!(dir.files(), ["vault.json"], "没有把旧保险箱当成打不开的挪走");
    }

    #[test]
    fn adopt_same_key_changes_nothing() {
        let dir = TempDir::new("adopt-same");
        let keychain = MemoryKeychain::default();
        let secrets = Secrets::new(dir.vault(), keychain.clone());
        secrets.set("a", "x").unwrap();
        let before = std::fs::read(dir.vault()).unwrap();
        let key = secrets.ensure_key().unwrap();
        secrets.adopt_key(key).unwrap();
        assert_eq!(std::fs::read(dir.vault()).unwrap(), before);
    }

    #[test]
    fn adopt_without_vault_just_stores_key() {
        let dir = TempDir::new("adopt-empty");
        let keychain = MemoryKeychain::default();
        let secrets = Secrets::new(dir.vault(), keychain.clone());
        let key = VaultKey::generate().unwrap();
        secrets.adopt_key(key.clone()).unwrap();
        assert_eq!(keychain.items()[KEY_ACCOUNT], *key.to_base64());
        assert!(dir.files().is_empty(), "空保险箱等第一次写入时才落盘");

        secrets.set("a", "x").unwrap();
        let file = Vault::parse(&std::fs::read(dir.vault()).unwrap()).unwrap();
        assert!(file.unlocks_with(&key));
    }

    #[test]
    fn adopt_write_failure_changes_nothing() {
        let dir = TempDir::new("adopt-write-fail");
        let keychain = MemoryKeychain::default();
        let secrets = Secrets::new(dir.vault(), keychain.clone());
        secrets.set("a", "x").unwrap();
        let before = std::fs::read(dir.vault()).unwrap();
        let old = keychain.items()[KEY_ACCOUNT].clone();
        // 换钥匙的临时文件的位置被目录占着，写文件必然失败
        let blocker = dir.0.join(format!("{ADOPTING_FILE}.tmp"));
        std::fs::create_dir(&blocker).unwrap();

        assert!(secrets.adopt_key(VaultKey::generate().unwrap()).is_err());
        assert_eq!(keychain.items()[KEY_ACCOUNT], old);
        assert_eq!(std::fs::read(dir.vault()).unwrap(), before);
        assert_eq!(secrets.get("a").unwrap().as_deref(), Some("x"));
        std::fs::remove_dir(&blocker).unwrap();
        assert_eq!(Secrets::new(dir.vault(), keychain).get("a").unwrap().as_deref(), Some("x"));
        assert_eq!(dir.files(), ["vault.json"]);
    }

    #[test]
    fn adopt_keychain_failure_changes_nothing() {
        let dir = TempDir::new("adopt-keychain-fail");
        let keychain = MemoryKeychain::default();
        let secrets = Secrets::new(dir.vault(), keychain.clone());
        secrets.set("a", "x").unwrap();
        let before = std::fs::read(dir.vault()).unwrap();
        let old = keychain.items()[KEY_ACCOUNT].clone();

        *keychain.broken.lock().unwrap() = true;
        assert!(secrets.adopt_key(VaultKey::generate().unwrap()).is_err());
        *keychain.broken.lock().unwrap() = false;

        assert_eq!(keychain.items()[KEY_ACCOUNT], old);
        assert_eq!(std::fs::read(dir.vault()).unwrap(), before, "保险箱文件没动过");
        assert_eq!(dir.files(), ["vault.json"], "半成品删掉了");
        assert_eq!(Secrets::new(dir.vault(), keychain).get("a").unwrap().as_deref(), Some("x"));
    }

    /// 模拟换钥匙写完 vault-adopting.json 就退出；`keychain_updated` 为 true 时连钥匙串也换好了，只差改名。
    /// 返回新钥匙
    fn interrupted_adopt(dir: &TempDir, keychain: &MemoryKeychain, keychain_updated: bool) -> VaultKey {
        let old = VaultKey::from_base64(&keychain.items()[KEY_ACCOUNT]).unwrap();
        let new_key = VaultKey::generate().unwrap();
        let vault = Vault::parse(&std::fs::read(dir.vault()).unwrap()).unwrap();
        let next = vault.rekey(&old, &new_key).unwrap();
        write_file(&adopting_path(&dir.vault()), &next.to_bytes()).unwrap();
        if keychain_updated {
            keychain.set(KEY_ACCOUNT, &new_key.to_base64()).unwrap();
        }
        new_key
    }

    #[test]
    fn crash_after_writing_adopting_file_keeps_old_vault() {
        let dir = TempDir::new("crash-before-keychain");
        let keychain = MemoryKeychain::default();
        Secrets::new(dir.vault(), keychain.clone()).set("a", "x").unwrap();
        let old = keychain.items()[KEY_ACCOUNT].clone();
        let before = std::fs::read(dir.vault()).unwrap();
        interrupted_adopt(&dir, &keychain, false);

        let reopened = Secrets::new(dir.vault(), keychain.clone());
        assert_eq!(reopened.get("a").unwrap().as_deref(), Some("x"));
        assert_eq!(keychain.items()[KEY_ACCOUNT], old);
        assert_eq!(std::fs::read(dir.vault()).unwrap(), before);
        assert_eq!(dir.files(), ["vault.json"], "半成品删掉了，旧保险箱没被挪走");
    }

    #[test]
    fn crash_after_keychain_update_finishes_rename() {
        let dir = TempDir::new("crash-after-keychain");
        let keychain = MemoryKeychain::default();
        Secrets::new(dir.vault(), keychain.clone()).set("a", "x").unwrap();
        let new_key = interrupted_adopt(&dir, &keychain, true);

        let reopened = Secrets::new(dir.vault(), keychain.clone());
        assert_eq!(reopened.get("a").unwrap().as_deref(), Some("x"));
        assert_eq!(dir.files(), ["vault.json"], "补上了改名，没有 vault-unreadable");
        let file = Vault::parse(&std::fs::read(dir.vault()).unwrap()).unwrap();
        assert!(file.unlocks_with(&new_key));
        // 之后照常读写
        reopened.set("b", "y").unwrap();
        assert_eq!(Secrets::new(dir.vault(), keychain).get("b").unwrap().as_deref(), Some("y"));
    }

    #[test]
    fn stale_adopting_file_is_removed_when_vault_opens() {
        let dir = TempDir::new("stale-adopting");
        let keychain = MemoryKeychain::default();
        let secrets = Secrets::new(dir.vault(), keychain.clone());
        secrets.set("a", "x").unwrap();
        // 用当前钥匙写一份旧内容：相当于改名失败后保险箱文件又写过新的，这份已经过时
        let key = secrets.ensure_key().unwrap();
        let mut old = Vault::new(&key).unwrap();
        old.set(&key, "a", "old").unwrap();
        write_file(&adopting_path(&dir.vault()), &old.to_bytes()).unwrap();

        let reopened = Secrets::new(dir.vault(), keychain);
        assert_eq!(reopened.get("a").unwrap().as_deref(), Some("x"));
        assert_eq!(dir.files(), ["vault.json"]);
    }

    #[test]
    fn adopt_rename_failure_finishes_on_next_open() {
        let dir = TempDir::new("adopt-rename-fail");
        let keychain = MemoryKeychain::default();
        let secrets = Secrets::new(dir.vault(), keychain.clone());
        secrets.set("a", "x").unwrap();
        // 保险箱文件的位置换成一个目录，改名必然失败（保险箱已经缓存在内存里，不用再读）
        std::fs::remove_file(dir.vault()).unwrap();
        std::fs::create_dir(dir.vault()).unwrap();

        let new_key = VaultKey::generate().unwrap();
        secrets.adopt_key(new_key.clone()).unwrap();
        assert_eq!(keychain.items()[KEY_ACCOUNT], *new_key.to_base64(), "钥匙串换了就算完成");
        assert_eq!(secrets.get("a").unwrap().as_deref(), Some("x"));

        std::fs::remove_dir(dir.vault()).unwrap();
        let reopened = Secrets::new(dir.vault(), keychain);
        assert_eq!(reopened.get("a").unwrap().as_deref(), Some("x"));
        assert_eq!(dir.files(), ["vault.json"]);
    }

    #[test]
    fn digests_skip_known_hosts_and_sync_entries() {
        let dir = TempDir::new("digests");
        let secrets = Secrets::new(dir.vault(), MemoryKeychain::default());
        assert!(secrets.digests().unwrap().is_empty(), "还没有保险箱");

        secrets.set("srv_1.password", "p1").unwrap();
        secrets.set("key_1.privateKey", "k1").unwrap();
        secrets.set(KNOWN_HOSTS, "host ssh-ed25519 AAAA").unwrap();
        secrets.set("sync.session", "tok").unwrap();
        let first = secrets.digests().unwrap();
        assert_eq!(first.keys().collect::<Vec<_>>(), ["key_1.privateKey", "srv_1.password"]);

        // 存同样的内容（重新加密）不变，改了内容才变
        secrets.set("srv_1.password", "p1").unwrap();
        assert_eq!(secrets.digests().unwrap(), first);
        secrets.set("srv_1.password", "p2").unwrap();
        let second = secrets.digests().unwrap();
        assert_ne!(second["srv_1.password"], first["srv_1.password"]);
        assert_eq!(second["key_1.privateKey"], first["key_1.privateKey"]);

        // 换成云端的钥匙后变一次，之后又稳定
        secrets.adopt_key(VaultKey::generate().unwrap()).unwrap();
        let third = secrets.digests().unwrap();
        assert_eq!(third.keys().collect::<Vec<_>>(), ["key_1.privateKey", "srv_1.password"]);
        assert_ne!(third["key_1.privateKey"], second["key_1.privateKey"]);
        assert_eq!(secrets.digests().unwrap(), third);
    }

    #[test]
    fn seal_and_open_entry_between_devices() {
        let key = VaultKey::generate().unwrap();
        let (dir_a, dir_b) = (TempDir::new("entry-a"), TempDir::new("entry-b"));
        let (a, _) = device_with_key(&dir_a, &key);
        let (b, _) = device_with_key(&dir_b, &key);
        let id = "srv_1.password";

        assert_eq!(a.seal_entry(id, &secret_aad(id, false)).unwrap(), None, "不存在返回 None");
        a.set(id, "s3cret 密码").unwrap();
        let data = a.seal_entry(id, &secret_aad(id, false)).unwrap().unwrap();
        assert!(!data.contains("s3cret"));

        assert!(b.open_entry(id, &secret_aad(id, false), &data).unwrap());
        assert_eq!(b.get(id).unwrap().as_deref(), Some("s3cret 密码"));
        // 同一把钥匙、同样的内容：两台设备算出的摘要一样，写入后不会被当成本机改动再传回去
        assert_eq!(b.digests().unwrap()[id], a.digests().unwrap()[id]);

        // 附加数据对不上（比如服务器改了时间戳）：返回 false，什么都不改
        let moved = RecordAad { hlc: "001793125352001-0000-3f9a1c2b7d4e5f60".into(), ..secret_aad(id, false) };
        assert!(!b.open_entry(id, &moved, &data).unwrap());
        let other = "srv_2.password";
        assert!(!b.open_entry(other, &secret_aad(other, false), &data).unwrap());
        assert_eq!(b.get(other).unwrap(), None);

        // 伪造的墓碑解不开，条目还在
        let stranger = RecordKey::from_vault_key(&VaultKey::generate().unwrap());
        let forged = vault::sync::seal_record(&stranger, &secret_aad(id, true), b"").unwrap();
        assert!(!b.open_entry(id, &secret_aad(id, true), &forged).unwrap());
        assert_eq!(b.get(id).unwrap().as_deref(), Some("s3cret 密码"));

        // 真的墓碑删掉这条
        let tomb = vault::sync::seal_record(&RecordKey::from_vault_key(&key), &secret_aad(id, true), b"").unwrap();
        assert!(b.open_entry(id, &secret_aad(id, true), &tomb).unwrap());
        assert_eq!(b.get(id).unwrap(), None);
        // 再收到一次也没事
        assert!(b.open_entry(id, &secret_aad(id, true), &tomb).unwrap());
    }

    #[test]
    fn sync_entry_ids_are_checked() {
        let key = VaultKey::generate().unwrap();
        let dir = TempDir::new("entry-ids");
        let (secrets, _) = device_with_key(&dir, &key);
        secrets.set("a", "x").unwrap();
        for id in [KNOWN_HOSTS, "sync.session", KEY_ACCOUNT, ""] {
            assert!(secrets.seal_entry(id, &secret_aad(id, false)).is_err(), "{id}");
            assert!(secrets.open_entry(id, &secret_aad(id, false), "AAAA").is_err(), "{id}");
        }
        // 必须是 secret 集合、id 必须一致：不然机密能被封成普通记录，再经 sync_open 解出原文
        let plain = RecordAad { collection: "server".into(), ..secret_aad("a", false) };
        assert!(secrets.seal_entry("a", &plain).is_err());
        assert!(secrets.seal_entry("a", &secret_aad("b", false)).is_err());
    }

    #[test]
    fn sync_without_vault_key() {
        let dir = TempDir::new("no-key");
        let keychain = MemoryKeychain::default();
        let secrets = Secrets::new(dir.vault(), keychain.clone());
        assert!(secrets.record_key().is_err(), "没有钥匙时不能悄悄新建一把");
        assert!(secrets.open_entry("a", &secret_aad("a", false), "AAAA").is_err());
        assert!(keychain.items().is_empty());

        // 注册时要包裹钥匙：这时才生成
        let key = secrets.ensure_key().unwrap();
        assert_eq!(keychain.items()[KEY_ACCOUNT], *key.to_base64());
        assert_eq!(*secrets.ensure_key().unwrap().to_base64(), *key.to_base64());
        assert!(secrets.record_key().is_ok());
    }

    #[test]
    fn tombstone_seals_without_reading_the_entry() {
        let key = VaultKey::generate().unwrap();
        let (dir_a, dir_b) = (TempDir::new("tomb-a"), TempDir::new("tomb-b"));
        let (a, _) = device_with_key(&dir_a, &key);
        let (b, _) = device_with_key(&dir_b, &key);
        let id = "srv_1.password";
        b.set(id, "x").unwrap();

        // 发送方已经删掉了这条（保险箱里根本没有），墓碑照样能封
        let tomb = a.seal_entry(id, &secret_aad(id, true)).unwrap().unwrap();
        assert!(b.open_entry(id, &secret_aad(id, true), &tomb).unwrap());
        assert_eq!(b.get(id).unwrap(), None);
        // 条目还在时也一样，而且封墓碑不会删本机的条目
        a.set(id, "y").unwrap();
        assert!(a.seal_entry(id, &secret_aad(id, true)).unwrap().is_some());
        assert_eq!(a.get(id).unwrap().as_deref(), Some("y"));

        // 没有钥匙时封不了，也不会新建钥匙
        let dir_c = TempDir::new("tomb-c");
        let keychain = MemoryKeychain::default();
        let c = Secrets::new(dir_c.vault(), keychain.clone());
        assert!(c.seal_entry(id, &secret_aad(id, true)).is_err());
        assert!(keychain.items().is_empty());
    }

    #[test]
    fn move_entry_cases() {
        let dir = TempDir::new("move");
        let keychain = MemoryKeychain::default();
        let secrets = Secrets::new(dir.vault(), keychain.clone());

        // 还没有保险箱：什么都不做，也不建钥匙
        secrets.move_entry("srv_local.password", "srv_cloud.password").unwrap();
        assert!(keychain.items().is_empty());
        assert!(dir.files().is_empty());

        // to 不存在：挪过去
        secrets.set("srv_local.password", "p").unwrap();
        secrets.move_entry("srv_local.password", "srv_cloud.password").unwrap();
        assert_eq!(secrets.get("srv_local.password").unwrap(), None);
        assert_eq!(secrets.get("srv_cloud.password").unwrap().as_deref(), Some("p"));

        // to 已经有了：不覆盖，只删 from
        secrets.set("srv_local.password", "local").unwrap();
        secrets.move_entry("srv_local.password", "srv_cloud.password").unwrap();
        assert_eq!(secrets.get("srv_local.password").unwrap(), None);
        assert_eq!(secrets.get("srv_cloud.password").unwrap().as_deref(), Some("p"));

        // from 不存在：什么都不做
        let before = std::fs::read(dir.vault()).unwrap();
        secrets.move_entry("srv_gone.password", "srv_cloud.password").unwrap();
        assert_eq!(std::fs::read(dir.vault()).unwrap(), before);

        // 写进了文件
        let reopened = Secrets::new(dir.vault(), keychain);
        assert_eq!(reopened.get("srv_cloud.password").unwrap().as_deref(), Some("p"));
        assert_eq!(reopened.get("srv_local.password").unwrap(), None);

        for (from, to) in [(KNOWN_HOSTS, "a"), ("a", KNOWN_HOSTS), ("sync.session", "a"), ("a", "sync.x"), ("", "a")] {
            assert!(secrets.move_entry(from, to).is_err(), "{from} -> {to}");
        }
    }

    /// 文件里存的保险箱编号，用钥匙串里当前的钥匙解开
    fn file_vault_id(dir: &TempDir, keychain: &MemoryKeychain) -> Option<String> {
        let key = VaultKey::from_base64(&keychain.items()[KEY_ACCOUNT]).unwrap();
        vault_id_on_disk(&dir.vault(), &key)
    }

    #[test]
    fn key_check_follows_vault_key() {
        let dir = TempDir::new("key-check");
        let keychain = MemoryKeychain::default();
        let secrets = Secrets::new(dir.vault(), keychain.clone());
        assert_eq!(secrets.key_check().unwrap(), None);
        assert!(keychain.items().is_empty(), "没有钥匙时不新建");
        assert!(dir.files().is_empty());

        // 注册时 ensure_key 建的保险箱还只在内存里：key_check 把它连同编号写进文件，重启后值不变
        let key = secrets.ensure_key().unwrap();
        let check = secrets.key_check().unwrap().unwrap();
        let id = file_vault_id(&dir, &keychain).expect("编号落了盘");
        assert_eq!(check, vault::sync::key_check(&key, &id));
        assert_eq!(secrets.key_check().unwrap().as_deref(), Some(check.as_str()));
        assert_eq!(Secrets::new(dir.vault(), keychain.clone()).key_check().unwrap().as_deref(), Some(check.as_str()));
        assert!(secrets.digests().unwrap().is_empty(), "编号条目不参与同步");

        // 换钥匙：编号跟着条目一起重新加密，保留下来；校验值只因为钥匙变了而变
        let new_key = VaultKey::generate().unwrap();
        secrets.adopt_key(new_key.clone()).unwrap();
        assert_eq!(file_vault_id(&dir, &keychain).as_deref(), Some(id.as_str()), "换钥匙保留编号");
        assert_eq!(secrets.key_check().unwrap().unwrap(), vault::sync::key_check(&new_key, &id));
        assert_ne!(secrets.key_check().unwrap().unwrap(), check);
    }

    #[test]
    fn rebuilt_vault_with_same_key_changes_key_check() {
        for broken in ["missing", "corrupt"] {
            let dir = TempDir::new(&format!("rebuilt-{broken}"));
            let keychain = MemoryKeychain::default();
            let secrets = Secrets::new(dir.vault(), keychain.clone());
            secrets.set("a", "x").unwrap();
            let check = secrets.key_check().unwrap().unwrap();
            let key = keychain.items()[KEY_ACCOUNT].clone();

            // 钥匙串里还是同一把钥匙，保险箱文件却没了或坏了：换成一个空的新保险箱
            if broken == "missing" {
                std::fs::remove_file(dir.vault()).unwrap();
            } else {
                std::fs::write(dir.vault(), b"{ not json").unwrap();
            }
            let reopened = Secrets::new(dir.vault(), keychain.clone());
            assert_eq!(reopened.get("a").unwrap(), None);
            assert_eq!(keychain.items()[KEY_ACCOUNT], key, "钥匙没变");
            let after = reopened.key_check().unwrap().unwrap();
            assert_ne!(after, check, "{broken}：保险箱重建了，校验值要变");
            // 新的值落了盘，之后稳定
            assert_eq!(Secrets::new(dir.vault(), keychain).key_check().unwrap().as_deref(), Some(after.as_str()));
        }
    }

    #[test]
    fn vault_without_id_gets_one_on_first_key_check() {
        // 加编号之前就有的保险箱：第一次 key_check 补上编号并写进文件，之后包括重启都不变
        let dir = TempDir::new("id-less");
        let keychain = MemoryKeychain::default();
        Secrets::new(dir.vault(), keychain.clone()).set("a", "x").unwrap();
        assert_eq!(file_vault_id(&dir, &keychain), None);

        let secrets = Secrets::new(dir.vault(), keychain.clone());
        let check = secrets.key_check().unwrap().unwrap();
        let id = file_vault_id(&dir, &keychain).expect("补上了编号");
        assert_eq!(secrets.get("a").unwrap().as_deref(), Some("x"));
        assert_eq!(secrets.key_check().unwrap().as_deref(), Some(check.as_str()));
        assert_eq!(Secrets::new(dir.vault(), keychain.clone()).key_check().unwrap().as_deref(), Some(check.as_str()));
        assert_eq!(file_vault_id(&dir, &keychain).as_deref(), Some(id.as_str()));
    }

    #[test]
    fn old_binary_rewrite_keeps_key_check() {
        // main 分支上的版本（所有者在用的正式版、别的工作区的调试版）只认这三个字段，写回文件时其余的都会丢
        #[derive(serde::Serialize, serde::Deserialize)]
        struct OldVault {
            version: u32,
            check: String,
            #[serde(default)]
            entries: BTreeMap<String, String>,
        }
        let dir = TempDir::new("old-binary");
        let keychain = MemoryKeychain::default();
        let secrets = Secrets::new(dir.vault(), keychain.clone());
        secrets.set("a", "x").unwrap();
        let check = secrets.key_check().unwrap().unwrap();

        let old: OldVault = serde_json::from_slice(&std::fs::read(dir.vault()).unwrap()).unwrap();
        std::fs::write(dir.vault(), serde_json::to_vec_pretty(&old).unwrap()).unwrap();

        let reopened = Secrets::new(dir.vault(), keychain);
        assert_eq!(reopened.key_check().unwrap().as_deref(), Some(check.as_str()));
        assert_eq!(reopened.get("a").unwrap().as_deref(), Some("x"));
    }

    #[test]
    fn frontend_cannot_touch_vault_id() {
        let dir = TempDir::new("vault-id-reserved");
        let keychain = MemoryKeychain::default();
        let secrets = Secrets::new(dir.vault(), keychain.clone());
        secrets.set("a", "x").unwrap();
        let check = secrets.key_check().unwrap().unwrap();

        assert!(secrets.get(VAULT_ID_ENTRY).is_err());
        assert!(secrets.set(VAULT_ID_ENTRY, "00000000000000000000000000000000").is_err());
        assert!(secrets.remove(VAULT_ID_ENTRY).is_err());
        assert!(secrets.seal_entry(VAULT_ID_ENTRY, &secret_aad(VAULT_ID_ENTRY, false)).is_err());
        assert!(secrets.open_entry(VAULT_ID_ENTRY, &secret_aad(VAULT_ID_ENTRY, true), "AAAA").is_err());
        assert!(secrets.move_entry(VAULT_ID_ENTRY, "b").is_err());
        assert!(secrets.move_entry("a", VAULT_ID_ENTRY).is_err());
        assert_eq!(secrets.key_check().unwrap().as_deref(), Some(check.as_str()));

        // 同步自己的登录凭据照常存取
        secrets.set("sync.session", "tok").unwrap();
        assert_eq!(secrets.get("sync.session").unwrap().as_deref(), Some("tok"));
        secrets.remove("sync.session").unwrap();
        assert_eq!(secrets.get("sync.session").unwrap(), None);
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
