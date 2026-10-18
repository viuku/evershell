//! 前端调用的命令。参数格式与 apps/desktop/src/tauri-backend.ts 对应。

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{Duration, Instant};

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use ssh_core::{Auth, FileEntry, HostKeyProblem, MonitorSnapshot, ShellEvent, TransferProgress};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, JavaScriptChannelId, Request};
use tauri::{AppHandle, Manager, State, Webview};

use crate::secrets::Secrets;
use crate::session::{self, ConnectParams, SessionManager};

/// 原始字节请求（write / upload）的元数据放在请求头里，正文留给字节本身
const SESSION_HEADER: &str = "x-session";
/// 远端路径，percent 编码（HTTP 头只能放 ASCII）
const PATH_HEADER: &str = "x-path";
/// 进度 Channel 的序列化形式（`__CHANNEL__:<id>`）
const PROGRESS_HEADER: &str = "x-progress";
/// save_download 的文件名（percent 编码）
const NAME_HEADER: &str = "x-name";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOpts {
    host: String,
    port: u16,
    user: String,
    auth: AuthOpts,
    cols: u32,
    rows: u32,
    known_hosts: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum AuthOpts {
    Password {
        password: String,
    },
    Key {
        private_key: String,
        passphrase: Option<String>,
    },
}

#[derive(Serialize)]
pub struct ConnectReply {
    id: String,
    fingerprint: Option<String>,
}

/// 连接失败。指纹问题单独给出结构化信息，界面据此弹确认框或警告（tauri-backend.ts 的 connectError）
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConnectError {
    Message { message: String },
    HostKey { problem: Box<HostKeyProblem> },
}

impl From<session::Error> for ConnectError {
    fn from(e: session::Error) -> Self {
        match e {
            session::Error::Ssh(ssh_core::Error::HostKey(problem)) => Self::HostKey { problem },
            e => Self::Message { message: e.to_string() },
        }
    }
}

#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, SessionManager>,
    opts: ConnectOpts,
    on_event: Channel<InvokeResponseBody>,
) -> Result<ConnectReply, ConnectError> {
    let params = ConnectParams {
        host: opts.host,
        port: opts.port,
        user: opts.user,
        auth: match opts.auth {
            AuthOpts::Password { password } => Auth::Password(password),
            AuthOpts::Key { private_key, passphrase } => Auth::PrivateKey {
                pem: private_key,
                passphrase,
            },
        },
        cols: opts.cols,
        rows: opts.rows,
        known_hosts: opts.known_hosts,
    };
    let connected = state
        .connect(params, move |ev| {
            // 输出走原始字节，前端拿到 ArrayBuffer；退出事件是一条小 JSON。同一条 Channel 保证顺序
            let body = match ev {
                ShellEvent::Data(bytes) => InvokeResponseBody::Raw(bytes),
                ShellEvent::Exit { code, reason } => InvokeResponseBody::Json(
                    serde_json::json!({ "exit": code, "reason": reason }).to_string(),
                ),
            };
            if let Err(e) = on_event.send(body) {
                log::debug!("前端已不在，丢弃事件: {e}");
            }
        })
        .await?;
    Ok(ConnectReply {
        id: connected.id,
        fingerprint: connected.fingerprint,
    })
}

#[tauri::command]
pub fn ssh_write(state: State<'_, SessionManager>, request: Request<'_>) -> Result<(), String> {
    let id = header(&request, SESSION_HEADER).ok_or("缺少会话 id")?;
    let InvokeBody::Raw(data) = request.body() else {
        return Err("write 只接受原始字节".into());
    };
    state.write(id, data.clone()).map_err(|e| e.to_string())
}

/// 界面显示完一批终端输出后回执字节数，Rust 侧据此决定要不要继续读，见 ssh_core::OutputAck
#[tauri::command]
pub fn ssh_ack(state: State<'_, SessionManager>, id: String, bytes: usize) -> Result<(), String> {
    state.ack(&id, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_resize(state: State<'_, SessionManager>, id: String, cols: u32, rows: u32) -> Result<(), String> {
    state.resize(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_close(state: State<'_, SessionManager>, id: String) -> Result<(), String> {
    state.close(&id).map_err(|e| e.to_string())
}

/// 开始监控采样，快照持续推给 `on_snapshot`，直到 `ssh_monitor_stop` 或会话关闭。
/// 必须是 async 命令：同步命令跑在主线程，没有 tokio 运行时，spawn 采样任务会直接崩溃。
#[tauri::command]
pub async fn ssh_monitor_start(
    state: State<'_, SessionManager>,
    id: String,
    interval_ms: u64,
    on_snapshot: Channel<MonitorSnapshot>,
) -> Result<(), String> {
    let interval = Duration::from_millis(interval_ms.max(500));
    state
        .start_monitor(&id, interval, move |snap| {
            if let Err(e) = on_snapshot.send(snap) {
                log::debug!("监控快照发送失败: {e}");
            }
        })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ssh_monitor_stop(state: State<'_, SessionManager>, id: String) -> Result<(), String> {
    state.stop_monitor(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_home(state: State<'_, SessionManager>, id: String) -> Result<String, String> {
    let sftp = sftp(&state, &id).await?;
    sftp.home_dir().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_list(state: State<'_, SessionManager>, id: String, path: String) -> Result<Vec<FileEntry>, String> {
    let sftp = sftp(&state, &id).await?;
    sftp.list_dir(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, SessionManager>, id: String, path: String) -> Result<(), String> {
    let sftp = sftp(&state, &id).await?;
    sftp.mkdir(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, SessionManager>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let sftp = sftp(&state, &id).await?;
    sftp.remove(&path, is_dir).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SessionManager>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let sftp = sftp(&state, &id).await?;
    sftp.rename(&from, &to).await.map_err(|e| e.to_string())
}

/// 上传：正文是文件的原始字节，会话 id、远端路径和进度 Channel 放在请求头里
#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, SessionManager>,
    webview: Webview,
    request: Request<'_>,
) -> Result<(), String> {
    let id = header(&request, SESSION_HEADER).ok_or("缺少会话 id")?;
    let path = header(&request, PATH_HEADER).ok_or("缺少远端路径")?;
    let path = percent_decode_str(path)
        .decode_utf8()
        .map_err(|_| "远端路径编码不正确")?
        .into_owned();
    let progress = header(&request, PROGRESS_HEADER)
        .and_then(|s| JavaScriptChannelId::from_str(s).ok())
        .map(|c| c.channel_on::<_, TransferProgress>(webview));
    let InvokeBody::Raw(data) = request.body() else {
        return Err("upload 只接受原始字节".into());
    };

    let sftp = sftp(&state, id).await?;
    let mut throttle = ProgressThrottle::default();
    sftp.upload(&path, &data[..], data.len() as u64, |p| {
        if let (Some(ch), true) = (&progress, throttle.due(p)) {
            let _ = ch.send(p);
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// 下载到用户的"下载"目录，重名时自动加序号，返回保存路径
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, SessionManager>,
    id: String,
    path: String,
    on_progress: Channel<TransferProgress>,
) -> Result<String, String> {
    let sftp = sftp(&state, &id).await?;
    let dir = app
        .path()
        .download_dir()
        .map_err(|_| "找不到本机的下载目录".to_string())?;
    let name = path
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("download");
    let (local, mut file) = create_unique(&dir, name).await?;

    let mut throttle = ProgressThrottle::default();
    let result = sftp
        .download(&path, &mut file, |p| {
            if throttle.due(p) {
                let _ = on_progress.send(p);
            }
        })
        .await;
    drop(file);
    match result {
        Ok(_) => Ok(local.to_string_lossy().into_owned()),
        Err(e) => {
            let _ = tokio::fs::remove_file(&local).await;
            Err(e.to_string())
        }
    }
}

/// 把前端生成的文件（如导出的连接）存进"下载"目录，重名时自动加序号，返回保存路径。
/// WKWebView 不处理 `<a download>`，所以桌面端走这里。
#[tauri::command]
pub async fn save_download(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;

    let name = header(&request, NAME_HEADER).ok_or("缺少文件名")?;
    let name = percent_decode_str(name)
        .decode_utf8()
        .map_err(|_| "文件名编码不正确")?;
    // 只取最后一段，防止文件名里带路径跳出下载目录
    let name = Path::new(name.as_ref())
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .ok_or("文件名无效")?
        .to_owned();
    let InvokeBody::Raw(data) = request.body() else {
        return Err("save_download 只接受原始字节".into());
    };
    let dir = app
        .path()
        .download_dir()
        .map_err(|_| "找不到本机的下载目录".to_string())?;
    let (local, mut file) = create_unique(&dir, &name).await?;
    if let Err(e) = file.write_all(data).await {
        drop(file);
        let _ = tokio::fs::remove_file(&local).await;
        return Err(format!("写入文件失败：{e}"));
    }
    Ok(local.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn secret_get(secrets: State<'_, Secrets>, id: String) -> Result<Option<String>, String> {
    let secrets = secrets.inner().clone();
    blocking(move || secrets.get(&id)).await
}

#[tauri::command]
pub async fn secret_set(secrets: State<'_, Secrets>, id: String, secret: String) -> Result<(), String> {
    let secrets = secrets.inner().clone();
    blocking(move || secrets.set(&id, &secret)).await
}

#[tauri::command]
pub async fn secret_remove(secrets: State<'_, Secrets>, id: String) -> Result<(), String> {
    let secrets = secrets.inner().clone();
    blocking(move || secrets.remove(&id)).await
}

/// 保险箱读写文件、取钥匙串里的钥匙都是阻塞的（钥匙串还可能弹授权框），不要占着 tokio 的工作线程
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("保险箱任务中断：{e}"))?
}

async fn sftp(state: &SessionManager, id: &str) -> Result<ssh_core::Sftp, String> {
    let conn = state.connection(id).map_err(|e| e.to_string())?;
    conn.sftp().await.map_err(|e| e.to_string())
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
    request.headers().get(name).and_then(|v| v.to_str().ok())
}

/// 在 `dir` 下新建一个不与现有文件重名的文件：`a.txt`、`a (1).txt`、`a (2).txt`…
async fn create_unique(dir: &Path, name: &str) -> Result<(PathBuf, tokio::fs::File), String> {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    for n in 0u32.. {
        let candidate = if n == 0 {
            dir.join(name)
        } else {
            dir.join(format!("{stem} ({n}){ext}"))
        };
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
            .await
        {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("无法在下载目录创建文件：{e}")),
        }
    }
    unreachable!()
}

/// 进度每 50ms 最多推一次，但完成时一定推
#[derive(Default)]
struct ProgressThrottle {
    last: Option<Instant>,
}

impl ProgressThrottle {
    fn due(&mut self, p: TransferProgress) -> bool {
        let now = Instant::now();
        let due = p.done >= p.total
            || self
                .last
                .is_none_or(|t| now.duration_since(t) >= Duration::from_millis(50));
        if due {
            self.last = Some(now);
        }
        due
    }
}
