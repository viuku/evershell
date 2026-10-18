//! 保险箱：保存的密码、私钥这类机密，用一把保险箱钥匙加密后存成一个文件。
//!
//! - 每条机密单独加密（XChaCha20-Poly1305，随机 24 字节 nonce），条目 id 作为附加数据参与认证，
//!   密文挪到别的 id 下会解不开。
//! - 文件里有一条校验密文，钥匙不对时一打开就能发现，不用等读到某条机密才失败。
//! - 钥匙放在哪由调用方决定：桌面端放系统钥匙串，以后开同步时再用主密码另锁一份（见需求文档 3.5）。
//!
//! 这里只做内存里的加解密和序列化，不碰文件系统，所以能编成 WASM 给网页端用。

use std::collections::BTreeMap;
use std::fmt;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// 当前文件格式版本
const VERSION: u32 = 1;
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
/// 附加数据带上用途和格式版本，校验密文和条目密文互相冒充不了
const CHECK_AAD: &[u8] = b"evershell-vault/v1/check";
const ENTRY_AAD_PREFIX: &str = "evershell-vault/v1/entry/";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("保险箱文件格式不对：{0}")]
    Format(String),
    #[error("保险箱是更新版本的 EverShell 创建的（格式版本 {0}），请升级软件")]
    UnsupportedVersion(u32),
    #[error("保险箱钥匙不对，或者文件被改过")]
    WrongKey,
    #[error("保险箱钥匙格式不对")]
    BadKey,
    #[error("系统随机数不可用：{0}")]
    Random(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// 保险箱钥匙：32 字节随机数，丢弃时内存清零
pub struct VaultKey(Zeroizing<[u8; KEY_LEN]>);

impl VaultKey {
    pub fn generate() -> Result<Self> {
        let mut bytes = Zeroizing::new([0u8; KEY_LEN]);
        random(&mut bytes[..])?;
        Ok(Self(bytes))
    }

    /// 编码成文本，存进只收字符串的地方（如系统钥匙串）
    pub fn to_base64(&self) -> Zeroizing<String> {
        Zeroizing::new(B64.encode(&self.0[..]))
    }

    pub fn from_base64(text: &str) -> Result<Self> {
        let bytes = Zeroizing::new(B64.decode(text.trim()).map_err(|_| Error::BadKey)?);
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        if bytes.len() != KEY_LEN {
            return Err(Error::BadKey);
        }
        key.copy_from_slice(&bytes);
        Ok(Self(key))
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new_from_slice(&self.0[..]).expect("钥匙固定 32 字节")
    }
}

impl fmt::Debug for VaultKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("VaultKey(..)")
    }
}

/// 保险箱文件的内容。条目只在 [`Vault::get`] 时单条解密，平时内存里也是密文。
#[derive(Clone, Serialize, Deserialize)]
pub struct Vault {
    version: u32,
    /// 用钥匙加密的空串，用来判断钥匙对不对
    check: String,
    /// 条目 id → base64(nonce ‖ 密文 ‖ 认证标签)
    #[serde(default)]
    entries: BTreeMap<String, String>,
}

impl Vault {
    /// 用这把钥匙新建一个空保险箱
    pub fn new(key: &VaultKey) -> Result<Self> {
        Ok(Self {
            version: VERSION,
            check: seal(key, b"", CHECK_AAD)?,
            entries: BTreeMap::new(),
        })
    }

    /// 解析保险箱文件，只检查格式，不需要钥匙
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        // 先只读版本号：新版本的文件字段可能对不上，要报“请升级”而不是“格式不对”
        #[derive(Deserialize)]
        struct Header {
            version: u32,
        }
        let header: Header = serde_json::from_slice(bytes).map_err(|e| Error::Format(e.to_string()))?;
        if header.version > VERSION {
            return Err(Error::UnsupportedVersion(header.version));
        }
        if header.version != VERSION {
            return Err(Error::Format(format!("不认识的格式版本 {}", header.version)));
        }
        serde_json::from_slice(bytes).map_err(|e| Error::Format(e.to_string()))
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec_pretty(self).expect("字段都是字符串和数字，序列化不会失败")
    }

    /// 这把钥匙能不能打开这个保险箱
    pub fn unlocks_with(&self, key: &VaultKey) -> bool {
        open(key, &self.check, CHECK_AAD).is_ok_and(|plain| plain.is_empty())
    }

    pub fn contains(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 不存在时返回 None
    pub fn get(&self, key: &VaultKey, id: &str) -> Result<Option<String>> {
        let Some(sealed) = self.entries.get(id) else {
            return Ok(None);
        };
        let plain = open(key, sealed, entry_aad(id).as_bytes())?;
        String::from_utf8(plain)
            .map(Some)
            .map_err(|_| Error::Format("条目内容不是 UTF-8 文本".into()))
    }

    pub fn set(&mut self, key: &VaultKey, id: &str, secret: &str) -> Result<()> {
        let sealed = seal(key, secret.as_bytes(), entry_aad(id).as_bytes())?;
        self.entries.insert(id.to_owned(), sealed);
        Ok(())
    }

    /// 返回是否真的删掉了一条
    pub fn remove(&mut self, id: &str) -> bool {
        self.entries.remove(id).is_some()
    }
}

fn entry_aad(id: &str) -> String {
    format!("{ENTRY_AAD_PREFIX}{id}")
}

fn seal(key: &VaultKey, plain: &[u8], aad: &[u8]) -> Result<String> {
    let mut nonce = [0u8; NONCE_LEN];
    random(&mut nonce)?;
    let sealed = key
        .cipher()
        .encrypt(&XNonce::from(nonce), Payload { msg: plain, aad })
        .expect("明文长度远小于算法上限");
    let mut out = Vec::with_capacity(NONCE_LEN + sealed.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(B64.encode(out))
}

fn open(key: &VaultKey, sealed: &str, aad: &[u8]) -> Result<Vec<u8>> {
    let raw = B64
        .decode(sealed)
        .map_err(|_| Error::Format("密文不是 base64".into()))?;
    if raw.len() < NONCE_LEN + TAG_LEN {
        return Err(Error::Format("密文太短".into()));
    }
    let (nonce, sealed) = raw.split_at(NONCE_LEN);
    let nonce: [u8; NONCE_LEN] = nonce.try_into().expect("上面检查过长度");
    key.cipher()
        .decrypt(&XNonce::from(nonce), Payload { msg: sealed, aad })
        .map_err(|_| Error::WrongKey)
}

fn random(buf: &mut [u8]) -> Result<()> {
    getrandom::fill(buf).map_err(|e| Error::Random(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_through_file_bytes() {
        let key = VaultKey::generate().unwrap();
        let mut vault = Vault::new(&key).unwrap();
        vault.set(&key, "srv_1.password", "s3cret 密码").unwrap();
        vault.set(&key, "srv_1.privateKey", "-----BEGIN OPENSSH PRIVATE KEY-----\n...").unwrap();

        let reopened = Vault::parse(&vault.to_bytes()).unwrap();
        assert!(reopened.unlocks_with(&key));
        assert_eq!(reopened.get(&key, "srv_1.password").unwrap().as_deref(), Some("s3cret 密码"));
        assert!(reopened.get(&key, "srv_1.privateKey").unwrap().unwrap().starts_with("-----BEGIN"));
        assert_eq!(reopened.get(&key, "srv_2.password").unwrap(), None);
    }

    #[test]
    fn file_does_not_contain_plaintext() {
        let key = VaultKey::generate().unwrap();
        let mut vault = Vault::new(&key).unwrap();
        vault.set(&key, "a", "hunter2-plaintext").unwrap();
        let text = String::from_utf8(vault.to_bytes()).unwrap();
        assert!(!text.contains("hunter2"), "{text}");
        assert!(!text.contains(&*key.to_base64()), "钥匙不能进文件");
    }

    #[test]
    fn wrong_key_is_detected() {
        let key = VaultKey::generate().unwrap();
        let other = VaultKey::generate().unwrap();
        let mut vault = Vault::new(&key).unwrap();
        vault.set(&key, "a", "x").unwrap();
        assert!(!vault.unlocks_with(&other));
        assert!(matches!(vault.get(&other, "a"), Err(Error::WrongKey)));
    }

    #[test]
    fn tampered_or_moved_entry_fails() {
        let key = VaultKey::generate().unwrap();
        let mut vault = Vault::new(&key).unwrap();
        vault.set(&key, "a", "secret-a").unwrap();

        // 把 a 的密文挪到 b 下面：附加数据里有 id，解不开
        let sealed = vault.entries["a"].clone();
        vault.entries.insert("b".into(), sealed.clone());
        assert!(matches!(vault.get(&key, "b"), Err(Error::WrongKey)));

        // 改密文里的一个字节
        let mut raw = B64.decode(&sealed).unwrap();
        raw[NONCE_LEN] ^= 1;
        vault.entries.insert("a".into(), B64.encode(raw));
        assert!(matches!(vault.get(&key, "a"), Err(Error::WrongKey)));
    }

    #[test]
    fn same_secret_encrypts_differently_each_time() {
        let key = VaultKey::generate().unwrap();
        let mut vault = Vault::new(&key).unwrap();
        vault.set(&key, "a", "same").unwrap();
        let first = vault.entries["a"].clone();
        vault.set(&key, "a", "same").unwrap();
        assert_ne!(first, vault.entries["a"]);
    }

    #[test]
    fn remove_entry() {
        let key = VaultKey::generate().unwrap();
        let mut vault = Vault::new(&key).unwrap();
        vault.set(&key, "a", "x").unwrap();
        assert!(vault.contains("a"));
        assert!(vault.remove("a"));
        assert!(!vault.remove("a"));
        assert!(vault.is_empty());
    }

    #[test]
    fn parse_rejects_garbage_and_future_versions() {
        assert!(matches!(Vault::parse(b"not json"), Err(Error::Format(_))));
        assert!(matches!(Vault::parse(br#"{"version":0,"check":""}"#), Err(Error::Format(_))));
        assert!(matches!(
            Vault::parse(br#"{"version":2,"something":"new"}"#),
            Err(Error::UnsupportedVersion(2))
        ));
    }

    #[test]
    fn key_text_roundtrip() {
        let key = VaultKey::generate().unwrap();
        let again = VaultKey::from_base64(&key.to_base64()).unwrap();
        let vault = Vault::new(&key).unwrap();
        assert!(vault.unlocks_with(&again));
        assert!(matches!(VaultKey::from_base64("c2hvcnQ="), Err(Error::BadKey)));
        assert!(matches!(VaultKey::from_base64("%%%"), Err(Error::BadKey)));
        assert_eq!(format!("{key:?}"), "VaultKey(..)");
    }
}
