//! 云同步的加密，规格见 docs/specs/sync.md「加密和钥匙」。
//!
//! - 同步密码 → Argon2id → 32 字节根钥匙 → HKDF-SHA256 拆成包裹钥匙（锁保险箱钥匙，只在本机内存里）
//!   和登录凭据（发给服务器，服务器拿它解不开任何东西）。
//! - 保险箱钥匙用包裹钥匙锁好后存到服务器；改同步密码只需重新包裹，不用重新加密全部数据。
//! - 每条同步记录用记录钥匙（从保险箱钥匙派生）加密，附加数据绑定记录的全部身份，
//!   服务器挪不了、改不了时间戳，也伪造不了删除。
//!
//! 和保险箱一样只做内存里的计算，能编成 WASM。

use std::collections::BTreeMap;

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::alphabet;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD as B64};
use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::{KEY_LEN, Vault, VaultKey};

/// 同步记录里存机密的集合。这个集合的记录只能经保险箱加解密，原文不交给前端
pub const SECRET_COLLECTION: &str = "secret";
/// 保险箱编号存成的条目（值是 32 个十六进制字符）。放成条目而不是文件的顶层字段：
/// 旧版本软件写回文件时会丢掉不认识的顶层字段，条目却原样保留。`sync.` 开头，本来就不参与同步
pub const VAULT_ID_ENTRY: &str = "sync.vault-id";

const KDF_ALG: &str = "argon2id";
/// 盐的长度：自己生成时用 16 字节；服务器给的允许 16～64 字节
const SALT_LEN: usize = 16;
const SALT_MAX_LEN: usize = 64;

const INFO_KEK: &[u8] = b"evershell/sync/v1/kek";
const INFO_AUTH: &[u8] = b"evershell/sync/v1/auth";
const INFO_RECORD: &[u8] = b"evershell/sync/v1/record";
const INFO_DIGEST: &[u8] = b"evershell/sync/v1/digest";
/// 校验值的输入前缀，后面接 `0x00` 和保险箱编号
const KEY_CHECK_MSG: &[u8] = b"evershell/sync/v1/key-check";
const WRAP_AAD_PREFIX: &[u8] = b"evershell/sync/v1/wrap";
const RECORD_AAD_PREFIX: &[u8] = b"evershell/sync/v1/record";

/// 服务器给的参数只在这个范围内才用，免得被设成能把内存吃光或算上几分钟的数
const M_KIB_MIN: u32 = 8 * 1024;
const M_KIB_MAX: u32 = 1024 * 1024;
const T_MAX: u32 = 10;
const P_MAX: u32 = 4;

/// 服务器存的盐不一定带补齐的 `=`，解码时两种都收
const B64_LENIENT: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("同步密码不能为空")]
    EmptyPassword,
    #[error("密码派生参数不受支持：{0}")]
    UnsupportedKdf(String),
    #[error("密码派生用的盐格式错误")]
    BadSalt,
    #[error("密码派生失败：{0}")]
    Kdf(String),
    #[error("无法解开云端的保险箱钥匙：同步密码不正确，或云端数据已损坏")]
    WrongPassword,
    #[error("同步记录的标识含有非法字符")]
    BadAad,
    #[error("无法解密同步数据：钥匙不正确，或数据已被修改")]
    Decrypt,
    #[error("系统随机数生成器不可用：{0}")]
    Random(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// 同步密码派生用的参数，随账号存在服务器上。字段名和前端的 `KdfParams` 一致
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    /// 只认 `argon2id`；用字符串收，认不出时给出能看懂的报错，而不是反序列化失败
    pub alg: String,
    /// 内存，KiB
    pub m_kib: u32,
    /// 轮数
    pub t: u32,
    /// 线程数
    pub p: u32,
}

impl Default for KdfParams {
    /// 64 MiB、3 轮、1 线程（规格「加密和钥匙」）
    fn default() -> Self {
        Self {
            alg: KDF_ALG.to_owned(),
            m_kib: 64 * 1024,
            t: 3,
            p: 1,
        }
    }
}

impl KdfParams {
    /// 参数来自服务器，属于不可信输入，用之前先检查
    pub fn validate(&self) -> Result<()> {
        if self.alg != KDF_ALG {
            return Err(Error::UnsupportedKdf("仅支持 argon2id 算法".into()));
        }
        if !(M_KIB_MIN..=M_KIB_MAX).contains(&self.m_kib) {
            return Err(Error::UnsupportedKdf("内存须在 8 MiB～1 GiB 之间".into()));
        }
        if !(1..=T_MAX).contains(&self.t) {
            return Err(Error::UnsupportedKdf(format!("轮数须在 1～{T_MAX} 之间")));
        }
        if !(1..=P_MAX).contains(&self.p) {
            return Err(Error::UnsupportedKdf(format!("线程数须在 1～{P_MAX} 之间")));
        }
        Ok(())
    }
}

/// 账号名去掉首尾空白、转小写后再用。FinalShell 出过大小写不一致导致解不开的问题
pub fn normalize_account(account: &str) -> String {
    account.trim().to_lowercase()
}

/// 注册、改密码时新生成的盐
pub fn new_salt() -> Result<[u8; SALT_LEN]> {
    let mut salt = [0u8; SALT_LEN];
    crate::random(&mut salt).map_err(random_error)?;
    Ok(salt)
}

pub fn encode_salt(salt: &[u8]) -> String {
    B64.encode(salt)
}

/// 解码服务器给的盐（base64），并检查长度
pub fn decode_salt(text: &str) -> Result<Vec<u8>> {
    let salt = B64_LENIENT.decode(text.trim()).map_err(|_| Error::BadSalt)?;
    if !(SALT_LEN..=SALT_MAX_LEN).contains(&salt.len()) {
        return Err(Error::BadSalt);
    }
    Ok(salt)
}

/// 包裹钥匙：锁保险箱钥匙用，只在本机内存里，丢弃时清零
pub struct Kek(Zeroizing<[u8; KEY_LEN]>);

/// 同步密码派生出的两把钥匙
pub struct Derived {
    pub kek: Kek,
    /// 登录凭据，原样发给服务器
    pub auth_key: Zeroizing<[u8; KEY_LEN]>,
}

impl Derived {
    pub fn auth_key_base64(&self) -> String {
        B64.encode(&self.auth_key[..])
    }
}

/// 同步密码 → Argon2id → 根钥匙 → HKDF 拆成包裹钥匙和登录凭据。账号不参与派生，它绑在包裹的附加数据里
pub fn derive(password: &str, salt: &[u8], params: &KdfParams) -> Result<Derived> {
    if password.is_empty() {
        return Err(Error::EmptyPassword);
    }
    params.validate()?;
    if !(SALT_LEN..=SALT_MAX_LEN).contains(&salt.len()) {
        return Err(Error::BadSalt);
    }
    let argon = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(params.m_kib, params.t, params.p, Some(KEY_LEN)).map_err(|e| Error::Kdf(e.to_string()))?,
    );
    let mut root = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(password.as_bytes(), salt, &mut root[..])
        .map_err(|e| Error::Kdf(e.to_string()))?;
    Ok(Derived {
        kek: Kek(expand(&root[..], INFO_KEK)),
        auth_key: expand(&root[..], INFO_AUTH),
    })
}

/// 用包裹钥匙锁保险箱钥匙，返回 base64(nonce ‖ 密文 ‖ 标签)
pub fn wrap_key(kek: &Kek, account: &str, key: &VaultKey) -> Result<String> {
    crate::seal(&crate::cipher(&kek.0), &key.0[..], &wrap_aad(account)).map_err(random_error)
}

/// 解开云端的保险箱钥匙。同步密码不对、账号不对、数据被改都解不开
pub fn unwrap_key(kek: &Kek, account: &str, wrapped: &str) -> Result<VaultKey> {
    let plain = Zeroizing::new(
        crate::open(&crate::cipher(&kek.0), wrapped.trim(), &wrap_aad(account)).map_err(|_| Error::WrongPassword)?,
    );
    if plain.len() != KEY_LEN {
        return Err(Error::WrongPassword);
    }
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    key.copy_from_slice(&plain);
    Ok(VaultKey(key))
}

fn wrap_aad(account: &str) -> Vec<u8> {
    let mut aad = WRAP_AAD_PREFIX.to_vec();
    aad.push(0);
    aad.extend_from_slice(normalize_account(account).as_bytes());
    aad
}

/// 记录钥匙：从保险箱钥匙派生，和保险箱条目分开用途。丢弃时清零
pub struct RecordKey(Zeroizing<[u8; KEY_LEN]>);

impl RecordKey {
    pub fn from_vault_key(key: &VaultKey) -> Self {
        Self(expand(&key.0[..], INFO_RECORD))
    }
}

/// 一条同步记录的身份，整个绑进附加数据。字段名和前端的 `RecordAad` 一致
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordAad {
    pub account: String,
    pub collection: String,
    pub id: String,
    pub hlc: String,
    pub deleted: bool,
}

impl RecordAad {
    /// `evershell/sync/v1/record\0<账号>\0<集合>\0<id>\0<时间戳>\0<1 或 0>`。
    /// 各段用 `\0` 隔开，所以哪一段含 `\0` 都会让拼法有歧义，直接拒绝
    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        let account = normalize_account(&self.account);
        let parts = [account.as_str(), &self.collection, &self.id, &self.hlc];
        if parts.iter().any(|p| p.contains('\0')) {
            return Err(Error::BadAad);
        }
        let mut aad = RECORD_AAD_PREFIX.to_vec();
        for part in parts {
            aad.push(0);
            aad.extend_from_slice(part.as_bytes());
        }
        aad.push(0);
        aad.push(if self.deleted { b'1' } else { b'0' });
        Ok(aad)
    }
}

/// 加密一条同步记录，返回 base64(nonce ‖ 密文 ‖ 标签)。墓碑也加密（空内容），服务器伪造不了删除
pub fn seal_record(key: &RecordKey, aad: &RecordAad, plain: &[u8]) -> Result<String> {
    crate::seal(&crate::cipher(&key.0), plain, &aad.to_bytes()?).map_err(random_error)
}

/// 解密一条同步记录。钥匙不对、附加数据任何一项不同、密文被改都报 [`Error::Decrypt`]
pub fn open_record(key: &RecordKey, aad: &RecordAad, data: &str) -> Result<Zeroizing<Vec<u8>>> {
    crate::open(&crate::cipher(&key.0), data.trim(), &aad.to_bytes()?)
        .map(Zeroizing::new)
        .map_err(|_| Error::Decrypt)
}

impl Vault {
    /// 每条机密的摘要，同步拿它和账本比，发现保险箱的改动：
    /// `hex(HMAC-SHA256(K_digest, id ‖ 0x00 ‖ 原文))` 的前 32 个字符，`K_digest` 由保险箱钥匙经 HKDF 派生。
    /// 对原文算，重新加密（换 nonce、换钥匙后重写同样的内容）不会让它变；
    /// 带钥匙，摘要存进本机存储也没法拿来离线爆破密码。有一条解不开就整个失败
    pub fn digests(&self, key: &VaultKey) -> crate::Result<BTreeMap<&str, String>> {
        let base = digest_mac(key);
        self.entries
            .keys()
            .map(|id| {
                let plain = Zeroizing::new(self.get(key, id)?.unwrap_or_default());
                let mut mac = base.clone();
                mac.update(id.as_bytes());
                mac.update(&[0]);
                mac.update(plain.as_bytes());
                Ok((id.as_str(), mac_hex(mac)))
            })
            .collect()
    }
}

/// 保险箱的校验值：`hex(HMAC-SHA256(K_digest, "evershell/sync/v1/key-check" ‖ 0x00 ‖ 保险箱编号))` 的前 32 个字符。
/// 引擎登录时记下它，之后对不上就说明本机保险箱换了钥匙或者被重建过（编号变了），要停下来重新登录，
/// 免得把“机密都没了”当成删除同步出去。由钥匙派生，推不回钥匙
pub fn key_check(key: &VaultKey, vault_id: &str) -> String {
    let mut mac = digest_mac(key);
    mac.update(KEY_CHECK_MSG);
    mac.update(&[0]);
    mac.update(vault_id.as_bytes());
    mac_hex(mac)
}

/// 新的保险箱编号：16 字节随机数，十六进制
pub fn new_vault_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    crate::random(&mut bytes).map_err(random_error)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// 用 `K_digest = HKDF-SHA256(保险箱钥匙, "evershell/sync/v1/digest")` 初始化的 HMAC
fn digest_mac(key: &VaultKey) -> Hmac<Sha256> {
    let digest_key = expand(&key.0[..], INFO_DIGEST);
    <Hmac<Sha256> as KeyInit>::new_from_slice(&digest_key[..]).expect("HMAC 收任意长度的钥匙")
}

/// 前 16 字节，32 个十六进制字符
fn mac_hex(mac: Hmac<Sha256>) -> String {
    mac.finalize().into_bytes()[..16].iter().map(|b| format!("{b:02x}")).collect()
}

fn expand(ikm: &[u8], info: &[u8]) -> Zeroizing<[u8; KEY_LEN]> {
    // 输入已经是 32 字节的均匀随机数，HKDF 的盐可以省掉（RFC 5869 第 3.1 节）
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    Hkdf::<Sha256>::new(None, ikm)
        .expand(info, &mut out[..])
        .expect("32 字节远小于 HKDF 的输出上限");
    out
}

fn random_error(e: crate::Error) -> Error {
    match e {
        crate::Error::Random(msg) => Error::Random(msg),
        other => Error::Random(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用最小的允许参数，调试版里也很快
    fn small() -> KdfParams {
        KdfParams {
            m_kib: M_KIB_MIN,
            t: 1,
            ..KdfParams::default()
        }
    }

    const SALT: [u8; 16] = *b"evershell-salt-1";

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn aad() -> RecordAad {
        RecordAad {
            account: "ops".into(),
            collection: "server".into(),
            id: "srv_m2x9k3ab12cd".into(),
            hlc: "001793125352000-0000-3f9a1c2b7d4e5f60".into(),
            deleted: false,
        }
    }

    /// 固定参数、固定盐的结果写成常量：以后不小心改了算法、参数或 info，这里会失败，
    /// 否则已经注册的账号就再也登录不上了。常量用 Node 自带的 crypto.argon2Sync + hkdfSync 独立算过一遍
    #[test]
    fn derive_is_stable() {
        let derived = derive("correct horse 电池", &SALT, &small()).unwrap();
        assert_eq!(hex(&derived.kek.0[..]), KEK_HEX);
        assert_eq!(hex(&derived.auth_key[..]), AUTH_HEX);
        assert_eq!(derived.auth_key_base64(), B64.encode(&derived.auth_key[..]));

        let key = VaultKey(Zeroizing::new([7u8; KEY_LEN]));
        assert_eq!(hex(&RecordKey::from_vault_key(&key).0[..]), RECORD_HEX);
    }

    const KEK_HEX: &str = "f041237297267339af72eb17cb835d3cf3e2362170ae387d2ebcb4ef599f2bca";
    const AUTH_HEX: &str = "7ddb78288f2901088be281eefb8942cdbbac46f986a2f4952297af7648a312fc";
    const RECORD_HEX: &str = "f130a3cff07e5e1423dfcc00a1f893ec16602d5744180b0e1bdf796f0063959b";

    #[test]
    fn derive_depends_on_password_salt_and_params() {
        let base = derive("pw", &SALT, &small()).unwrap();
        let other_pw = derive("pw2", &SALT, &small()).unwrap();
        let other_salt = derive("pw", b"evershell-salt-2", &small()).unwrap();
        let other_t = derive("pw", &SALT, &KdfParams { t: 2, ..small() }).unwrap();
        for d in [&other_pw, &other_salt, &other_t] {
            assert_ne!(d.kek.0[..], base.kek.0[..]);
            assert_ne!(d.auth_key[..], base.auth_key[..]);
        }
        assert_ne!(base.kek.0[..], base.auth_key[..], "两把钥匙要分开");
    }

    #[test]
    fn wrap_roundtrip_and_binding() {
        let derived = derive("pw", &SALT, &small()).unwrap();
        let key = VaultKey::generate().unwrap();
        let wrapped = wrap_key(&derived.kek, "Ops", &key).unwrap();
        assert!(!wrapped.contains(&*key.to_base64()));

        // 账号名先规范化：大小写、首尾空白不同也能解开
        let back = unwrap_key(&derived.kek, "  ops ", &wrapped).unwrap();
        assert_eq!(*back.to_base64(), *key.to_base64());

        let wrong_pw = derive("pw2", &SALT, &small()).unwrap();
        assert!(matches!(unwrap_key(&wrong_pw.kek, "ops", &wrapped), Err(Error::WrongPassword)));
        assert!(matches!(unwrap_key(&derived.kek, "other", &wrapped), Err(Error::WrongPassword)));
        assert!(matches!(unwrap_key(&derived.kek, "ops", "%%%"), Err(Error::WrongPassword)));

        // 包裹的不是 32 字节也不收
        let short = crate::seal(&crate::cipher(&derived.kek.0), b"short", &wrap_aad("ops")).unwrap();
        assert!(matches!(unwrap_key(&derived.kek, "ops", &short), Err(Error::WrongPassword)));
    }

    #[test]
    fn record_roundtrip() {
        let key = RecordKey::from_vault_key(&VaultKey::generate().unwrap());
        let sealed = seal_record(&key, &aad(), "{\"name\":\"生产\"}".as_bytes()).unwrap();
        assert_eq!(&open_record(&key, &aad(), &sealed).unwrap()[..], "{\"name\":\"生产\"}".as_bytes());
        // 每次 nonce 不同
        assert_ne!(sealed, seal_record(&key, &aad(), "{\"name\":\"生产\"}".as_bytes()).unwrap());

        // 墓碑：空内容
        let tomb = RecordAad { deleted: true, ..aad() };
        let sealed = seal_record(&key, &tomb, b"").unwrap();
        assert!(open_record(&key, &tomb, &sealed).unwrap().is_empty());

        let other = RecordKey::from_vault_key(&VaultKey::generate().unwrap());
        assert!(matches!(open_record(&other, &tomb, &sealed), Err(Error::Decrypt)));
        assert!(matches!(open_record(&key, &tomb, "not base64!"), Err(Error::Decrypt)));
        assert!(matches!(open_record(&key, &tomb, "AAAA"), Err(Error::Decrypt)));
    }

    #[test]
    fn any_aad_change_fails() {
        let key = RecordKey::from_vault_key(&VaultKey::generate().unwrap());
        let sealed = seal_record(&key, &aad(), b"x").unwrap();
        let changed = [
            RecordAad { account: "ops2".into(), ..aad() },
            RecordAad { collection: "snippet".into(), ..aad() },
            RecordAad { id: "srv_other".into(), ..aad() },
            RecordAad { hlc: "001793125352001-0000-3f9a1c2b7d4e5f60".into(), ..aad() },
            RecordAad { deleted: true, ..aad() },
        ];
        for aad in &changed {
            assert!(matches!(open_record(&key, aad, &sealed), Err(Error::Decrypt)), "{aad:?}");
        }
        // 账号先规范化，大小写不同不算改了
        let upper = RecordAad { account: " OPS".into(), ..aad() };
        assert!(open_record(&key, &upper, &sealed).is_ok());
    }

    #[test]
    fn aad_bytes_layout() {
        assert_eq!(
            aad().to_bytes().unwrap(),
            b"evershell/sync/v1/record\x00ops\x00server\x00srv_m2x9k3ab12cd\x00001793125352000-0000-3f9a1c2b7d4e5f60\x000"
        );
        let tomb = RecordAad { deleted: true, ..aad() };
        assert!(tomb.to_bytes().unwrap().ends_with(b"\x001"));
        // 段里有 \0 时拼法会有歧义（"a\0b" + "c" 和 "a" + "b\0c" 一样），拒绝
        let bad = RecordAad { id: "a\0b".into(), ..aad() };
        assert!(matches!(bad.to_bytes(), Err(Error::BadAad)));
        assert!(matches!(seal_record(&RecordKey::from_vault_key(&VaultKey::generate().unwrap()), &bad, b""), Err(Error::BadAad)));
    }

    #[test]
    fn kdf_params_out_of_range_are_rejected() {
        assert!(KdfParams::default().validate().is_ok());
        let bad = [
            KdfParams { alg: "argon2i".into(), ..KdfParams::default() },
            KdfParams { alg: "scrypt".into(), ..KdfParams::default() },
            KdfParams { m_kib: M_KIB_MIN - 1, ..KdfParams::default() },
            KdfParams { m_kib: M_KIB_MAX + 1, ..KdfParams::default() },
            KdfParams { t: 0, ..KdfParams::default() },
            KdfParams { t: 11, ..KdfParams::default() },
            KdfParams { p: 0, ..KdfParams::default() },
            KdfParams { p: 5, ..KdfParams::default() },
        ];
        for params in &bad {
            assert!(matches!(params.validate(), Err(Error::UnsupportedKdf(_))), "{params:?}");
            assert!(matches!(derive("pw", &SALT, params), Err(Error::UnsupportedKdf(_))), "{params:?}");
        }
        // 边界值都收
        for params in [
            KdfParams { m_kib: M_KIB_MAX, t: 10, p: 4, ..KdfParams::default() },
            KdfParams { m_kib: M_KIB_MIN, t: 1, p: 1, ..KdfParams::default() },
        ] {
            assert!(params.validate().is_ok(), "{params:?}");
        }
    }

    #[test]
    fn kdf_params_json_matches_frontend() {
        let json = serde_json::to_string(&KdfParams::default()).unwrap();
        assert_eq!(json, r#"{"alg":"argon2id","mKib":65536,"t":3,"p":1}"#);
        let back: KdfParams = serde_json::from_str(&json).unwrap();
        assert_eq!(back, KdfParams::default());
        let aad: RecordAad =
            serde_json::from_str(r#"{"account":"a","collection":"c","id":"i","hlc":"h","deleted":true}"#).unwrap();
        assert!(aad.deleted);
    }

    #[test]
    fn salt_and_password_checks() {
        assert_eq!(new_salt().unwrap().len(), SALT_LEN);
        assert_ne!(new_salt().unwrap(), new_salt().unwrap());
        assert_eq!(decode_salt(&encode_salt(&SALT)).unwrap(), SALT);
        // 没有补齐的 = 也收
        assert_eq!(decode_salt(B64.encode(SALT).trim_end_matches('=')).unwrap(), SALT);
        assert!(matches!(decode_salt(&B64.encode([0u8; 8])), Err(Error::BadSalt)));
        assert!(matches!(decode_salt(&B64.encode([0u8; 65])), Err(Error::BadSalt)));
        assert!(matches!(decode_salt("%%%"), Err(Error::BadSalt)));
        assert!(matches!(derive("pw", &[0u8; 8], &small()), Err(Error::BadSalt)));
        assert!(matches!(derive("", &SALT, &small()), Err(Error::EmptyPassword)));
    }

    fn owned(digests: BTreeMap<&str, String>) -> BTreeMap<String, String> {
        digests.into_iter().map(|(k, v)| (k.to_owned(), v)).collect()
    }

    #[test]
    fn digests_follow_plaintext_not_ciphertext() {
        let key = VaultKey::generate().unwrap();
        let mut vault = Vault::new(&key).unwrap();
        vault.set(&key, "a", "x").unwrap();
        vault.set(&key, "b", "x").unwrap();
        let first = owned(vault.digests(&key).unwrap());
        assert_eq!(first.keys().collect::<Vec<_>>(), ["a", "b"]);
        assert!(first.values().all(|d| d.len() == 32 && d.chars().all(|c| c.is_ascii_hexdigit())));
        assert_ne!(first["a"], first["b"], "id 也算进摘要：内容相同、id 不同时摘要不同");

        // 同样的内容重新加密（nonce 变了），摘要不变
        let sealed_before = vault.entries["a"].clone();
        vault.set(&key, "a", "x").unwrap();
        assert_ne!(vault.entries["a"], sealed_before);
        assert_eq!(owned(vault.digests(&key).unwrap()), first);

        // 内容变了才变
        vault.set(&key, "a", "x2").unwrap();
        let second = vault.digests(&key).unwrap();
        assert_ne!(second["a"], first["a"]);
        assert_eq!(second["b"], first["b"]);

        // 换了钥匙，摘要跟着变（换钥匙后引擎刷新一次账本）
        let other = VaultKey::generate().unwrap();
        let rekeyed = vault.rekey(&key, &other).unwrap();
        assert_ne!(rekeyed.digests(&other).unwrap()["b"], first["b"]);
        // 钥匙不对就算不出来
        assert!(matches!(vault.digests(&other), Err(crate::Error::WrongKey)));
    }

    /// 摘要存进各设备的账本，算法改了会让所有机密重新上传一遍。常量用 Node 的 hkdfSync + createHmac 独立算过
    #[test]
    fn digest_is_stable() {
        let key = VaultKey(Zeroizing::new([7u8; KEY_LEN]));
        let mut vault = Vault::new(&key).unwrap();
        vault.set(&key, "srv_1.password", "s3cret 密码").unwrap();
        assert_eq!(vault.digests(&key).unwrap()["srv_1.password"], DIGEST_HEX);
    }

    const DIGEST_HEX: &str = "ef51bdf2639ac4f674503d37149cf625";

    /// 校验值存在各设备的同步状态里，算法改了所有设备都会停下来要求重新登录。常量用 Node 独立算过
    #[test]
    fn key_check_is_stable_and_follows_key_and_vault() {
        let key = VaultKey(Zeroizing::new([7u8; KEY_LEN]));
        let id = "00112233445566778899aabbccddeeff";
        assert_eq!(key_check(&key, id), KEY_CHECK_HEX);
        assert_eq!(key_check(&key.clone(), id), KEY_CHECK_HEX);
        assert_ne!(key_check(&VaultKey::generate().unwrap(), id), KEY_CHECK_HEX, "换钥匙要变");
        assert_ne!(key_check(&key, "ffeeddccbbaa99887766554433221100"), KEY_CHECK_HEX, "保险箱重建要变");
        assert!(!KEY_CHECK_HEX.contains(&hex(&key.0[..])[..32]), "校验值不是钥匙本身");

        let id = new_vault_id().unwrap();
        assert!(id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit()), "{id}");
        assert_ne!(new_vault_id().unwrap(), id);
    }

    const KEY_CHECK_HEX: &str = "a362fdf540a9155ae7ea6fd91ebb72bb";

    #[test]
    fn normalize() {
        assert_eq!(normalize_account("  Ops@Example.COM \n"), "ops@example.com");
    }

}
