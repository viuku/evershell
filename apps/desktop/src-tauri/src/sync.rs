//! 云同步要的平台能力，和 packages/ui/src/types.ts 的 `SyncPlatform` 一一对应（前端接法见
//! apps/desktop/src/tauri-backend.ts），规格见 docs/specs/sync.md「客户端 › 桌面端 Rust」。
//!
//! 加密算法在 crates/vault/src/sync.rs，这里只管钥匙放哪、在哪个线程算。同步密码派生出的包裹钥匙
//! 和机密原文都不交给前端，前端只拿到登录凭据和密文。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::State;
use vault::sync::{self as crypto, KdfParams, Kek, RecordAad, SECRET_COLLECTION};
use zeroize::Zeroizing;

use crate::secrets::Secrets;

const NO_KEK: &str = "请重新输入同步密码";
/// 取不到本机名称时的默认名，用户可以在同步窗口里改
const FALLBACK_DEVICE_NAME: &str = "这台电脑";

/// 最近一次派生出的包裹钥匙。`sync_adopt_key` 用完就清掉；`sync_wrap_key` 用完不清，注册失败重试时不用再输一遍密码
#[derive(Clone, Default)]
pub struct SyncState {
    pending: Arc<Mutex<Option<PendingKek>>>,
}

/// 包裹的附加数据要带账号，派生时一起记下
struct PendingKek {
    kek: Kek,
    account: String,
}

impl SyncState {
    fn lock(&self) -> MutexGuard<'_, Option<PendingKek>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeriveReply {
    salt: String,
    kdf: KdfParams,
    auth_key: String,
}

#[derive(Deserialize)]
pub struct SealItem {
    aad: RecordAad,
    plain: String,
}

#[derive(Deserialize)]
pub struct OpenItem {
    aad: RecordAad,
    data: String,
}

#[tauri::command]
pub async fn sync_device_name() -> Result<String, String> {
    blocking(|| Ok(device_name())).await
}

/// 不给盐时新生成盐（注册、改密码）；不给参数时用默认参数。Argon2 默认要占 64 MiB 内存，
/// 服务器给的参数最多能到 1 GiB、10 轮，放到阻塞线程里算
#[tauri::command]
pub async fn sync_derive(
    state: State<'_, SyncState>,
    password: String,
    account: String,
    salt: Option<String>,
    kdf: Option<KdfParams>,
) -> Result<DeriveReply, String> {
    let state = state.inner().clone();
    let password = Zeroizing::new(password);
    blocking(move || {
        // 先清掉上一次的：这次失败时不能让后面的 adopt / wrap 用上旧密码派生的钥匙
        *state.lock() = None;
        let account = crypto::normalize_account(&account);
        if account.is_empty() {
            return Err("同步账号不能为空".into());
        }
        let salt = match salt {
            Some(text) => crypto::decode_salt(&text),
            None => crypto::new_salt().map(|s| s.to_vec()),
        }
        .map_err(|e| e.to_string())?;
        let kdf = kdf.unwrap_or_default();
        let derived = crypto::derive(&password, &salt, &kdf).map_err(|e| e.to_string())?;
        let reply = DeriveReply {
            salt: crypto::encode_salt(&salt),
            kdf,
            auth_key: derived.auth_key_base64(),
        };
        *state.lock() = Some(PendingKek {
            kek: derived.kek,
            account,
        });
        Ok(reply)
    })
    .await
}

#[tauri::command]
pub async fn sync_wrap_key(state: State<'_, SyncState>, secrets: State<'_, Secrets>) -> Result<String, String> {
    let (state, secrets) = (state.inner().clone(), secrets.inner().clone());
    blocking(move || {
        let pending = state.lock();
        let pending = pending.as_ref().ok_or(NO_KEK)?;
        let key = secrets.ensure_key()?;
        crypto::wrap_key(&pending.kek, &pending.account, &key).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn sync_adopt_key(
    state: State<'_, SyncState>,
    secrets: State<'_, Secrets>,
    wrapped: String,
) -> Result<(), String> {
    let (state, secrets) = (state.inner().clone(), secrets.inner().clone());
    blocking(move || {
        let pending = state.lock().take().ok_or(NO_KEK)?;
        let key = crypto::unwrap_key(&pending.kek, &pending.account, &wrapped).map_err(|e| e.to_string())?;
        drop(pending);
        secrets.adopt_key(key)
    })
    .await
}

#[tauri::command]
pub async fn sync_seal(secrets: State<'_, Secrets>, items: Vec<SealItem>) -> Result<Vec<String>, String> {
    let secrets = secrets.inner().clone();
    blocking(move || {
        items.iter().try_for_each(|item| not_secret(&item.aad))?;
        let key = secrets.record_key()?;
        items
            .iter()
            .map(|item| crypto::seal_record(&key, &item.aad, item.plain.as_bytes()).map_err(|e| e.to_string()))
            .collect()
    })
    .await
}

/// 认证失败（钥匙不对、数据被改、附加数据对不上）的那条返回 None，不影响别的
#[tauri::command]
pub async fn sync_open(secrets: State<'_, Secrets>, items: Vec<OpenItem>) -> Result<Vec<Option<String>>, String> {
    let secrets = secrets.inner().clone();
    blocking(move || {
        items.iter().try_for_each(|item| not_secret(&item.aad))?;
        let key = secrets.record_key()?;
        Ok(items
            .iter()
            .map(|item| {
                crypto::open_record(&key, &item.aad, &item.data)
                    .ok()
                    .and_then(|plain| String::from_utf8(plain.to_vec()).ok())
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn sync_secret_digests(secrets: State<'_, Secrets>) -> Result<BTreeMap<String, String>, String> {
    let secrets = secrets.inner().clone();
    blocking(move || secrets.digests()).await
}

#[tauri::command]
pub async fn sync_seal_secret(secrets: State<'_, Secrets>, id: String, aad: RecordAad) -> Result<Option<String>, String> {
    let secrets = secrets.inner().clone();
    blocking(move || secrets.seal_entry(&id, &aad)).await
}

#[tauri::command]
pub async fn sync_open_secret(
    secrets: State<'_, Secrets>,
    id: String,
    aad: RecordAad,
    data: String,
) -> Result<bool, String> {
    let secrets = secrets.inner().clone();
    blocking(move || secrets.open_entry(&id, &aad, &data)).await
}

#[tauri::command]
pub async fn sync_move_secret(secrets: State<'_, Secrets>, from: String, to: String) -> Result<(), String> {
    let secrets = secrets.inner().clone();
    blocking(move || secrets.move_entry(&from, &to)).await
}

#[tauri::command]
pub async fn sync_key_check(secrets: State<'_, Secrets>) -> Result<Option<String>, String> {
    let secrets = secrets.inner().clone();
    blocking(move || secrets.key_check()).await
}

/// 机密记录只能走 sync_seal_secret / sync_open_secret，不然原文会经 sync_open 交到前端
fn not_secret(aad: &RecordAad) -> Result<(), String> {
    if aad.collection == SECRET_COLLECTION {
        return Err("机密记录须经保险箱加解密".into());
    }
    Ok(())
}

/// 读钥匙串、写保险箱文件、跑 Argon2、起子进程都会阻塞，不要占着处理 IPC 的线程
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("同步操作失败：{e}"))?
}

/// 本机默认名称，如“MacBook Pro”：Mac 用「系统设置 › 通用 › 关于本机」里的名称，其他平台用计算机名
fn device_name() -> String {
    #[cfg(target_os = "macos")]
    if let Some(name) = command_output("/usr/sbin/scutil", &["--get", "ComputerName"]) {
        return name;
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(name) = env_name() {
        return name;
    }
    host_name().unwrap_or_else(|| FALLBACK_DEVICE_NAME.to_owned())
}

#[cfg(not(target_os = "macos"))]
fn env_name() -> Option<String> {
    let var = if cfg!(windows) { "COMPUTERNAME" } else { "HOSTNAME" };
    std::env::var(var).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

/// 主机名常带 `.local` 这类后缀，名称里用不着
fn host_name() -> Option<String> {
    let name = command_output("hostname", &[])?;
    Some(name.strip_suffix(".local").unwrap_or(&name).to_owned()).filter(|n| !n.is_empty())
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(program).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_name_is_never_empty() {
        assert!(!device_name().trim().is_empty());
    }

    #[test]
    fn secret_collection_is_refused_for_plain_records() {
        let aad = |collection: &str| RecordAad {
            account: "ops".into(),
            collection: collection.into(),
            id: "x".into(),
            hlc: "001793125352000-0000-3f9a1c2b7d4e5f60".into(),
            deleted: false,
        };
        assert!(not_secret(&aad("server")).is_ok());
        assert!(not_secret(&aad(SECRET_COLLECTION)).is_err());
    }
}
