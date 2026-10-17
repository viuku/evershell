//! 密码、私钥等机密存进系统钥匙串（macOS Keychain / Windows 凭据管理器 / Linux Secret Service）。
//! 服务名用应用标识（tauri.conf.json 的 identifier），同一台机器上的条目按 id 区分。

use keyring::{Entry, Error as KeyringError};

#[derive(Clone)]
pub struct Secrets {
    service: String,
}

impl Secrets {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, id: &str) -> Result<Entry, String> {
        if id.is_empty() {
            return Err("机密 id 不能为空".into());
        }
        Entry::new(&self.service, id).map_err(|e| format!("无法访问系统钥匙串：{e}"))
    }

    /// 不存在时返回 None
    pub fn get(&self, id: &str) -> Result<Option<String>, String> {
        match self.entry(id)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(e) => Err(format!("读取钥匙串失败：{e}")),
        }
    }

    pub fn set(&self, id: &str, secret: &str) -> Result<(), String> {
        self.entry(id)?
            .set_password(secret)
            .map_err(|e| format!("写入钥匙串失败：{e}"))
    }

    /// 不存在时视为成功
    pub fn remove(&self, id: &str) -> Result<(), String> {
        match self.entry(id)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(e) => Err(format!("删除钥匙串条目失败：{e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 会真的往系统钥匙串写一条测试数据（服务名带 .test 后缀，用完即删），所以默认忽略。
    /// 手动运行：cargo test -p evershell-desktop --lib keychain_roundtrip -- --ignored
    #[test]
    #[ignore]
    fn keychain_roundtrip() {
        let secrets = Secrets::new("dev.evershell.desktop.test");
        let id = format!("test-{}", std::process::id());
        assert_eq!(secrets.get(&id).unwrap(), None);
        secrets.set(&id, "s3cret 密码").unwrap();
        assert_eq!(secrets.get(&id).unwrap().as_deref(), Some("s3cret 密码"));
        secrets.set(&id, "updated").unwrap();
        assert_eq!(secrets.get(&id).unwrap().as_deref(), Some("updated"));
        secrets.remove(&id).unwrap();
        assert_eq!(secrets.get(&id).unwrap(), None);
        // 删不存在的条目也不报错
        secrets.remove(&id).unwrap();
    }

    #[test]
    fn empty_id_is_rejected_without_touching_keychain() {
        let secrets = Secrets::new("dev.evershell.desktop.test");
        assert!(secrets.get("").is_err());
        assert!(secrets.set("", "x").is_err());
        assert!(secrets.remove("").is_err());
    }
}
