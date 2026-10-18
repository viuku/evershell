//! 服务器指纹记录（known_hosts）的校验。格式和 OpenSSH 的 `~/.ssh/known_hosts` 一样，可以原样导入导出。
//!
//! 这里只管“对不对得上”，不管存在哪：记录由界面保存（桌面端放保险箱，防篡改；网页端放浏览器），
//! 连接时整段传进来，见 [`crate::HostKeyCheck`]。
//!
//! 认得 OpenSSH 的这些写法：非 22 端口写成 `[host]:port`；逗号隔开的多个名字；`*` `?` 通配；
//! `!` 排除；`|1|盐|哈希` 形式的哈希主机名（`HashKnownHosts`）；`@revoked` 吊销标记。
//! `@cert-authority`（用证书机构签服务器钥匙）暂不支持，这种行直接跳过。

use data_encoding::BASE64;
use hmac::{Hmac, KeyInit, Mac};
use russh::keys::ssh_key::{Algorithm, PublicKey};
use russh::keys::{HashAlg, PublicKeyBase64, parse_public_key_base64};
use serde::Serialize;
use sha1::Sha1;

/// 一把服务器公钥，给界面显示、也能直接写进 known_hosts
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKey {
    /// 算法名，如 `ssh-ed25519`
    pub algorithm: String,
    /// `SHA256:` 开头的指纹，和 `ssh-keygen -l` 显示的一样
    pub fingerprint: String,
    /// OpenSSH 公钥格式（`算法 base64`），known_hosts 一行里主机名后面的部分
    pub openssh: String,
}

impl HostKey {
    pub fn from_public_key(key: &PublicKey) -> Self {
        let algorithm = key.algorithm().as_str().to_string();
        Self {
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            openssh: format!("{algorithm} {}", key.public_key_base64()),
            algorithm,
        }
    }
}

/// 记录里和这台服务器有关的一行
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownEntry {
    pub key: HostKey,
    /// 记录里原样的这一行。更新指纹时界面按它把旧的删掉
    pub line: String,
    /// 这一行没有通配和排除，删掉不会影响别的服务器
    pub exact: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// 记录里有这把钥匙
    Trusted,
    /// 没记过这台服务器。`other_types` 是记过的其它类型的钥匙（比如记的是 RSA，这次给的是 Ed25519）
    Unknown { other_types: Vec<KnownEntry> },
    /// 记过同类型但不同的钥匙：服务器重装过，或者有人冒充
    Changed { recorded: Vec<KnownEntry> },
    /// 这把钥匙被标记为吊销，任何情况下都不能用
    Revoked,
}

/// known_hosts 里查这台服务器用的名字：22 端口就是主机名，其它端口写成 `[host]:port`
pub fn host_name(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

/// 新记一把钥匙时要加的那一行
pub fn line_for(host: &str, port: u16, key: &HostKey) -> String {
    format!("{} {}", host_name(host, port), key.openssh)
}

/// 用记录校验服务器给出的钥匙
pub fn check(known_hosts: &str, host: &str, port: u16, key: &PublicKey) -> Verdict {
    let name = host_name(host, port).to_ascii_lowercase();
    let mut trusted = false;
    let mut same_type = Vec::new();
    let mut other_types = Vec::new();
    for raw in known_hosts.lines() {
        let Some(line) = Line::parse(raw) else { continue };
        if !host_matches(line.hosts, &name) {
            continue;
        }
        let same_key = line.key.key_data() == key.key_data();
        match line.marker {
            Some("@revoked") if same_key => return Verdict::Revoked,
            Some(_) => {}
            None if same_key => trusted = true,
            None => {
                let entry = KnownEntry {
                    key: HostKey::from_public_key(&line.key),
                    line: raw.to_string(),
                    exact: !line.hosts.contains(['*', '?', '!']),
                };
                if same_family(line.key.algorithm(), &key.algorithm()) {
                    same_type.push(entry);
                } else {
                    other_types.push(entry);
                }
            }
        }
    }
    if trusted {
        Verdict::Trusted
    } else if !same_type.is_empty() {
        Verdict::Changed { recorded: same_type }
    } else {
        Verdict::Unknown { other_types }
    }
}

/// 记录里这台服务器有哪些类型的钥匙。握手时优先让服务器出示这些类型，
/// 免得明明记过（比如从 OpenSSH 导入的 RSA）却因为服务器默认先给 Ed25519 而当成新服务器
pub fn known_algorithms(known_hosts: &str, host: &str, port: u16) -> Vec<Algorithm> {
    let name = host_name(host, port).to_ascii_lowercase();
    let mut out: Vec<Algorithm> = Vec::new();
    for raw in known_hosts.lines() {
        let Some(line) = Line::parse(raw) else { continue };
        if line.marker.is_none() && host_matches(line.hosts, &name) {
            let alg = line.key.algorithm();
            if !out.iter().any(|a| same_family(a.clone(), &alg)) {
                out.push(alg);
            }
        }
    }
    out
}

/// RSA 的钥匙不管用哪种哈希签名都算同一类
pub(crate) fn same_family(a: Algorithm, b: &Algorithm) -> bool {
    match (&a, b) {
        (Algorithm::Rsa { .. }, Algorithm::Rsa { .. }) => true,
        _ => a == *b,
    }
}

struct Line<'a> {
    marker: Option<&'a str>,
    hosts: &'a str,
    key: PublicKey,
}

impl<'a> Line<'a> {
    /// 空行、注释、看不懂的行返回 None（OpenSSH 也是跳过）
    fn parse(raw: &'a str) -> Option<Self> {
        let raw = raw.trim();
        if raw.is_empty() || raw.starts_with('#') {
            return None;
        }
        let mut fields = raw.split_whitespace();
        let mut first = fields.next()?;
        let marker = if first.starts_with('@') {
            let m = first;
            first = fields.next()?;
            Some(m)
        } else {
            None
        };
        let _key_type = fields.next()?;
        let key = parse_public_key_base64(fields.next()?).ok()?;
        Some(Self { marker, hosts: first, key })
    }
}

/// 一行的主机名字段能不能匹配上 `name`（已转小写）。规则同 OpenSSH：
/// 任何一个 `!` 开头的排除项匹配上，整行就不算；否则有一项匹配上就算
fn host_matches(field: &str, name: &str) -> bool {
    let mut matched = false;
    for pattern in field.split(',') {
        let (negated, pattern) = match pattern.strip_prefix('!') {
            Some(p) => (true, p),
            None => (false, pattern),
        };
        let hit = match pattern.strip_prefix("|1|") {
            Some(hashed) => hashed_matches(hashed, name),
            None => glob(pattern.to_ascii_lowercase().as_bytes(), name.as_bytes()),
        };
        if hit {
            if negated {
                return false;
            }
            matched = true;
        }
    }
    matched
}

/// `盐|哈希`，哈希 = HMAC-SHA1(盐, 主机名)，两段都是 base64
fn hashed_matches(hashed: &str, name: &str) -> bool {
    let Some((salt, hash)) = hashed.split_once('|') else { return false };
    let (Ok(salt), Ok(hash)) = (BASE64.decode(salt.as_bytes()), BASE64.decode(hash.as_bytes())) else {
        return false;
    };
    let Ok(mac) = Hmac::<Sha1>::new_from_slice(&salt) else { return false };
    mac.chain_update(name.as_bytes()).verify_slice(&hash).is_ok()
}

/// `*` 匹配任意多个字符，`?` 匹配一个
fn glob(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0, 0);
    // 最近一个 * 的位置，以及当时 text 走到哪：失配时回到这里让 * 多吃一个字符
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        match pattern.get(p) {
            Some(b'*') => {
                star = Some((p, t));
                p += 1;
            }
            Some(&c) if c == b'?' || c == text[t] => {
                p += 1;
                t += 1;
            }
            _ => match star {
                Some((sp, st)) => {
                    p = sp + 1;
                    t = st + 1;
                    star = Some((sp, st + 1));
                }
                None => return false,
            },
        }
    }
    pattern[p..].iter().all(|&c| c == b'*')
}

#[cfg(test)]
mod tests {
    use super::*;

    // 下面的哈希行是用 macOS 自带 OpenSSH 的 `ssh-keygen -H` 生成的，证明哈希算法和它一致：
    //   [hashed.example]:2222 → K1；plain.example 和 10.0.0.7 → K2
    const K1: &str = "AAAAC3NzaC1lZDI1NTE5AAAAILa9kv2bnvDCwIWKP2zTz/lfGYZZkJEuIn4upK3OX+mM";
    const K1_FP: &str = "SHA256:b80++hyweMRcsnI867RxrUb1hCQ54IPGjQHofdCdKKE";
    const K2: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJYNW2kgiKqI0cHc/S3tgsHz6vjFf7cxfdYTTnQgoQIt";
    const K2_FP: &str = "SHA256:Do1dDfSQuotMwf+A7PvnugPs321zzVuyLL5sGaKalGY";
    const HASHED: &str = "\
|1|NVeirIHY1bBYvX3YoxPdwNEXMKE=|6Z3Uz0++ULNSWxuV/J10msDudOo= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILa9kv2bnvDCwIWKP2zTz/lfGYZZkJEuIn4upK3OX+mM
|1|UUAInmzDvWhxRXIUGAaWxSjdKYs=|t3aAuOZT8Gu4ExdX3Zr0RrIv8bs= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJYNW2kgiKqI0cHc/S3tgsHz6vjFf7cxfdYTTnQgoQIt
|1|xyawzi5jA0C2HyX1L+Bah4+QqQY=|/kmovN8nfjZJR2WyNtO2T7DD9gQ= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJYNW2kgiKqI0cHc/S3tgsHz6vjFf7cxfdYTTnQgoQIt
";
    // 随手造的 RSA 公钥头不行，用 ssh-key 现场生成一把
    fn rsa() -> PublicKey {
        use russh::keys::ssh_key::private::{KeypairData, RsaKeypair};
        let mut rng = rand::rng();
        let pair = RsaKeypair::random(&mut rng, 2048).unwrap();
        russh::keys::PrivateKey::new(KeypairData::from(pair), "").unwrap().public_key().clone()
    }

    fn key(b64: &str) -> PublicKey {
        parse_public_key_base64(b64).unwrap()
    }

    #[test]
    fn fingerprint_and_line_match_openssh() {
        let k = HostKey::from_public_key(&key(K1));
        assert_eq!(k.fingerprint, K1_FP);
        assert_eq!(k.algorithm, "ssh-ed25519");
        assert_eq!(line_for("h.example", 22, &k), format!("h.example ssh-ed25519 {K1}"));
        assert_eq!(line_for("h.example", 2222, &k), format!("[h.example]:2222 ssh-ed25519 {K1}"));
        assert_eq!(HostKey::from_public_key(&key(K2)).fingerprint, K2_FP);
    }

    #[test]
    fn hashed_names_from_ssh_keygen() {
        assert_eq!(check(HASHED, "hashed.example", 2222, &key(K1)), Verdict::Trusted);
        assert_eq!(check(HASHED, "plain.example", 22, &key(K2)), Verdict::Trusted);
        assert_eq!(check(HASHED, "10.0.0.7", 22, &key(K2)), Verdict::Trusted);
        // 端口不同就是另一台
        assert!(matches!(check(HASHED, "hashed.example", 22, &key(K1)), Verdict::Unknown { .. }));
        // 主机名不分大小写
        assert_eq!(check(HASHED, "Plain.Example", 22, &key(K2)), Verdict::Trusted);
        // 同一个名字记的是 K2，来的是 K1：指纹变了
        match check(HASHED, "plain.example", 22, &key(K1)) {
            Verdict::Changed { recorded } => {
                assert_eq!(recorded.len(), 1);
                assert_eq!(recorded[0].key.fingerprint, K2_FP);
                assert!(recorded[0].line.starts_with("|1|UUAI"));
                assert!(recorded[0].exact);
            }
            v => panic!("{v:?}"),
        }
    }

    #[test]
    fn plain_patterns_ports_wildcards_and_negation() {
        let kh = format!(
            "# 注释和空行都跳过\n\n\
             [db.example]:2200,db-alias ssh-ed25519 {K1} 备注\n\
             *.corp.example,!secret.corp.example ssh-ed25519 {K2}\n\
             坏掉的一行\n\
             web?.example ssh-ed25519 {K1}\n"
        );
        assert_eq!(check(&kh, "db.example", 2200, &key(K1)), Verdict::Trusted);
        assert_eq!(check(&kh, "db-alias", 22, &key(K1)), Verdict::Trusted);
        assert!(matches!(check(&kh, "db.example", 22, &key(K1)), Verdict::Unknown { .. }));
        assert_eq!(check(&kh, "a.corp.example", 22, &key(K2)), Verdict::Trusted);
        assert!(matches!(check(&kh, "secret.corp.example", 22, &key(K2)), Verdict::Unknown { .. }));
        assert_eq!(check(&kh, "web1.example", 22, &key(K1)), Verdict::Trusted);
        assert!(matches!(check(&kh, "web10.example", 22, &key(K1)), Verdict::Unknown { .. }));
        // 通配行对不上：算变了，但这一行不能整行删
        match check(&kh, "b.corp.example", 22, &key(K1)) {
            Verdict::Changed { recorded } => assert!(!recorded[0].exact),
            v => panic!("{v:?}"),
        }
    }

    #[test]
    fn revoked_wins_even_if_also_listed() {
        let kh = format!("srv ssh-ed25519 {K1}\n@revoked * ssh-ed25519 {K1}\n");
        assert_eq!(check(&kh, "srv", 22, &key(K1)), Verdict::Revoked);
        assert!(matches!(check(&kh, "other", 22, &key(K1)), Verdict::Revoked));
        // @cert-authority 不支持，跳过，不当成记录
        let kh = format!("@cert-authority * ssh-ed25519 {K1}\n");
        assert!(matches!(check(&kh, "srv", 22, &key(K1)), Verdict::Unknown { .. }));
    }

    #[test]
    fn other_key_type_is_unknown_not_changed() {
        let rsa = rsa();
        let kh = format!("srv {}\n", HostKey::from_public_key(&rsa).openssh);
        match check(&kh, "srv", 22, &key(K1)) {
            Verdict::Unknown { other_types } => assert_eq!(other_types[0].key.algorithm, "ssh-rsa"),
            v => panic!("{v:?}"),
        }
        assert_eq!(check(&kh, "srv", 22, &rsa), Verdict::Trusted);
        assert_eq!(known_algorithms(&kh, "srv", 22).len(), 1);
        assert!(known_algorithms(&kh, "nobody", 22).is_empty());
    }

    #[test]
    fn glob_rules() {
        assert!(glob(b"*", b"anything"));
        assert!(glob(b"a*c", b"abbbc"));
        assert!(glob(b"a*b*c", b"a-b-b-c"));
        assert!(!glob(b"a*c", b"abcd"));
        assert!(glob(b"?b", b"ab"));
        assert!(!glob(b"?", b""));
        assert!(glob(b"", b""));
    }
}
