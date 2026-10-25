//! 认私钥：类型、长度、指纹，给私钥库显示和查重用（docs/specs/key-library.md）。
//!
//! 解析用 russh 的 `decode_secret_key`，和真正连接时同一套，能连上的私钥这里都认得出。

use russh::keys::ssh_key::public::KeyData;
use russh::keys::{Algorithm, EcdsaCurve, HashAlg, decode_secret_key};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeyInfo {
    /// RSA、ED25519、ECDSA、DSA；少见的照 SSH 里的名字
    pub algorithm: String,
    /// 位数：RSA、DSA 按模数，ED25519 是 256，ECDSA 按曲线
    pub bits: u32,
    /// 公钥指纹，形如 `SHA256:…`，和 `ssh-keygen -lf` 一样
    pub fingerprint: String,
    /// 私钥设了口令
    pub encrypted: bool,
}

/// 认不出来的原因，文案直接给用户看
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyProblem {
    #[error("所选文件是公钥（通常为 .pub 文件），请选择不带 .pub 扩展名的私钥文件")]
    PublicKey,
    #[error("该私钥已设置口令，请输入口令")]
    NeedsPassphrase,
    #[error("口令不正确")]
    WrongPassphrase,
    #[error("无法识别该私钥。支持 OpenSSH、PEM（RSA、EC、PKCS#8）和 PuTTY 格式")]
    Unrecognized,
}

/// 认出私钥的类型、长度和指纹。设了口令的私钥要给对口令；没设口令时给的口令不用
pub fn inspect_private_key(text: &str, passphrase: Option<&str>) -> Result<KeyInfo, KeyProblem> {
    let text = text.trim();
    if looks_public(text) {
        return Err(KeyProblem::PublicKey);
    }
    let passphrase = passphrase.filter(|p| !p.is_empty());
    let encrypted = looks_encrypted(text);
    let key = match decode_secret_key(text, passphrase) {
        Ok(key) => key,
        Err(russh::keys::Error::KeyIsEncrypted) => return Err(KeyProblem::NeedsPassphrase),
        Err(_) if encrypted && passphrase.is_none() => return Err(KeyProblem::NeedsPassphrase),
        Err(_) if encrypted => return Err(KeyProblem::WrongPassphrase),
        Err(_) => return Err(KeyProblem::Unrecognized),
    };
    let public = key.public_key();
    Ok(KeyInfo {
        algorithm: algorithm_name(&key.algorithm()),
        bits: bits(public.key_data()),
        fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
        encrypted,
    })
}

/// 公钥：`ssh-ed25519 AAAA…`（authorized_keys、.pub 的样子）或 PEM / RFC 4716 的公钥
fn looks_public(text: &str) -> bool {
    let first = text.lines().next().unwrap_or("");
    first.starts_with("ssh-")
        || first.starts_with("ecdsa-")
        || first.starts_with("sk-")
        || first.contains("PUBLIC KEY-----")
}

/// 设了口令：OpenSSH 格式要解开看，PEM 看文件头，PuTTY 看 Encryption 一行
fn looks_encrypted(text: &str) -> bool {
    if text.contains("ENCRYPTED") {
        return true;
    }
    if text.starts_with("PuTTY-User-Key-File-") {
        return text.lines().any(|l| l.starts_with("Encryption:") && l.trim() != "Encryption: none");
    }
    matches!(decode_secret_key(text, None), Err(russh::keys::Error::KeyIsEncrypted))
}

fn algorithm_name(alg: &Algorithm) -> String {
    match alg {
        Algorithm::Rsa { .. } => "RSA".into(),
        Algorithm::Ed25519 => "ED25519".into(),
        Algorithm::Ecdsa { .. } => "ECDSA".into(),
        Algorithm::Dsa => "DSA".into(),
        Algorithm::SkEd25519 => "ED25519-SK".into(),
        Algorithm::SkEcdsaSha2NistP256 => "ECDSA-SK".into(),
        other => other.as_str().to_owned(),
    }
}

fn bits(data: &KeyData) -> u32 {
    match data {
        KeyData::Rsa(rsa) => rsa.key_size(),
        KeyData::Dsa(dsa) => dsa.p().as_positive_bytes().map_or(0, bit_len),
        KeyData::Ed25519(_) | KeyData::SkEd25519(_) => 256,
        KeyData::Ecdsa(ec) => curve_bits(ec.curve()),
        KeyData::SkEcdsaSha2NistP256(_) => 256,
        _ => 0,
    }
}

fn curve_bits(curve: EcdsaCurve) -> u32 {
    match curve {
        EcdsaCurve::NistP256 => 256,
        EcdsaCurve::NistP384 => 384,
        EcdsaCurve::NistP521 => 521,
    }
}

/// 大端整数的位数（去掉最高字节前面的 0 位）
fn bit_len(bytes: &[u8]) -> u32 {
    match bytes.first() {
        Some(&b) => bytes.len() as u32 * 8 - b.leading_zeros(),
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData, RsaKeypair};
    use russh::keys::ssh_key::{LineEnding, PrivateKey};

    use super::*;

    fn ed25519() -> PrivateKey {
        PrivateKey::new(KeypairData::from(Ed25519Keypair::random(&mut rand::rng())), "").unwrap()
    }

    fn rsa(bits: usize) -> PrivateKey {
        PrivateKey::new(KeypairData::from(RsaKeypair::random(&mut rand::rng(), bits).unwrap()), "").unwrap()
    }

    #[test]
    fn plain_openssh_key() {
        let key = ed25519();
        let pem = key.to_openssh(LineEnding::LF).unwrap();
        let info = inspect_private_key(&pem, None).unwrap();
        assert_eq!(info.algorithm, "ED25519");
        assert_eq!(info.bits, 256);
        assert_eq!(info.fingerprint, key.public_key().fingerprint(HashAlg::Sha256).to_string());
        assert!(info.fingerprint.starts_with("SHA256:"));
        assert!(!info.encrypted);
        // 没设口令时填了口令也照常认
        assert_eq!(inspect_private_key(&pem, Some("whatever")).unwrap(), info);
    }

    #[test]
    fn encrypted_openssh_key() {
        let key = ed25519();
        let pem = key.encrypt(&mut rand::rng(), "secret").unwrap().to_openssh(LineEnding::LF).unwrap();
        assert_eq!(inspect_private_key(&pem, None), Err(KeyProblem::NeedsPassphrase));
        assert_eq!(inspect_private_key(&pem, Some("")), Err(KeyProblem::NeedsPassphrase));
        assert_eq!(inspect_private_key(&pem, Some("wrong")), Err(KeyProblem::WrongPassphrase));
        let info = inspect_private_key(&pem, Some("secret")).unwrap();
        assert!(info.encrypted);
        assert_eq!(info.fingerprint, key.public_key().fingerprint(HashAlg::Sha256).to_string());
    }

    #[test]
    fn rsa_in_openssh_and_pkcs8() {
        let key = rsa(2048);
        let fp = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let openssh = key.to_openssh(LineEnding::LF).unwrap();
        let info = inspect_private_key(&openssh, None).unwrap();
        assert_eq!((info.algorithm.as_str(), info.bits, info.fingerprint.as_str()), ("RSA", 2048, fp.as_str()));

        let mut pkcs8 = Vec::new();
        russh::keys::encode_pkcs8_pem(&key, &mut pkcs8).unwrap();
        let pkcs8 = String::from_utf8(pkcs8).unwrap();
        assert_eq!(inspect_private_key(&pkcs8, None).unwrap(), info);

        let mut locked = Vec::new();
        russh::keys::encode_pkcs8_pem_encrypted(&key, b"secret", 10, &mut locked).unwrap();
        let locked = String::from_utf8(locked).unwrap();
        assert_eq!(inspect_private_key(&locked, None), Err(KeyProblem::NeedsPassphrase));
        assert_eq!(inspect_private_key(&locked, Some("wrong")), Err(KeyProblem::WrongPassphrase));
        let info = inspect_private_key(&locked, Some("secret")).unwrap();
        assert!(info.encrypted);
        assert_eq!(info.fingerprint, fp);
    }

    #[test]
    fn rejects_public_keys_and_junk() {
        let public = ed25519().public_key().to_openssh().unwrap();
        assert_eq!(inspect_private_key(&public, None), Err(KeyProblem::PublicKey));
        assert_eq!(inspect_private_key("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----", None), Err(KeyProblem::PublicKey));
        assert_eq!(inspect_private_key("hello", None), Err(KeyProblem::Unrecognized));
        assert_eq!(inspect_private_key("", None), Err(KeyProblem::Unrecognized));
    }

    #[test]
    fn bit_length() {
        assert_eq!(bit_len(&[0x80, 0]), 16);
        assert_eq!(bit_len(&[0x01, 0]), 9);
        assert_eq!(bit_len(&[]), 0);
    }
}
