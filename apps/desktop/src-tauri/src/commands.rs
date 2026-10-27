//! 前端调用的命令。参数格式与 apps/desktop/src/tauri-backend.ts 对应。

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{Duration, Instant};

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use ssh_core::{
    Auth, FileEntry, FileKind, HostKeyProblem, MonitorDetail, MonitorSnapshot, PermScope, ShellEvent, SystemInfo,
    TransferProgress,
};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, JavaScriptChannelId, Request};
use tauri::{AppHandle, Manager, State, Webview};

use crate::local_file::{self, PickedFile};
use crate::local_import::{self, Dirs, LocalConfig, Platform};
use crate::secrets::Secrets;
use crate::session::{self, ConnectParams, SessionManager};
use crate::unpack;

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

/// 采样时顺带多取哪些数据（进程标签页要全部进程，网络标签页要连接），改了马上采一次。
/// 没在采样时只记下，下次 ssh_monitor_start 时用
#[tauri::command]
pub async fn ssh_monitor_detail(
    state: State<'_, SessionManager>,
    id: String,
    procs: bool,
    sockets: bool,
) -> Result<(), String> {
    state
        .set_monitor_detail(&id, MonitorDetail { procs, sockets })
        .map_err(|e| e.to_string())
}

/// 取一次系统信息（发行版、内核、CPU 型号）
#[tauri::command]
pub async fn ssh_system_info(state: State<'_, SessionManager>, id: String) -> Result<SystemInfo, String> {
    state.system_info(&id).await.map_err(|e| e.to_string())
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

#[tauri::command]
pub async fn sftp_stat(state: State<'_, SessionManager>, id: String, path: String) -> Result<FileEntry, String> {
    let sftp = sftp(&state, &id).await?;
    sftp.stat(&path).await.map_err(|e| e.to_string())
}

/// 编辑器一次最多读进内存多少，前端传的上限再大也按这个算
const READ_LIMIT: u64 = 32 * 1024 * 1024;

/// 整个文件读进内存给编辑器，直接返回原始字节（前端拿到 ArrayBuffer），不转 JSON 数组
#[tauri::command]
pub async fn sftp_read(
    state: State<'_, SessionManager>,
    id: String,
    path: String,
    max_bytes: u64,
    on_progress: Channel<TransferProgress>,
) -> Result<tauri::ipc::Response, String> {
    let sftp = sftp(&state, &id).await?;
    let mut throttle = ProgressThrottle::default();
    let data = sftp
        .read_file(&path, max_bytes.min(READ_LIMIT), |p| {
            if throttle.due(p) {
                let _ = on_progress.send(p);
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(data))
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
        .map_err(|_| "未找到本机的下载目录".to_string())?;
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

/// 下载整个文件夹到"下载"目录，重名时文件夹名加序号，返回本机路径。符号链接不下；
/// 服务器给的名字不像正常文件名的跳过，不会写到下载目录外面（docs/specs/file-ops.md）
#[tauri::command]
pub async fn sftp_download_dir(
    app: AppHandle,
    state: State<'_, SessionManager>,
    id: String,
    path: String,
    on_progress: Channel<TransferProgress>,
) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;

    let sftp = sftp(&state, &id).await?;
    let downloads = download_dir(&app)?;
    // 先列全、算出总大小，进度才有意义；列的时候回调里 total 为 0
    let _ = on_progress.send(TransferProgress { done: 0, total: 0 });
    let entries = sftp.walk(&path).await.map_err(|e| e.to_string())?;
    let total: u64 = entries.iter().filter(|(_, e)| e.kind == FileKind::File).map(|(_, e)| e.size).sum();
    let base = path.trim_end_matches('/');
    let name = base.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or("download");
    let root = create_unique_dir(&downloads, name).await?;

    let mut done = 0u64;
    let mut throttle = ProgressThrottle::default();
    for (rel, entry) in entries {
        let Some(local_rel) = unpack::local_relative(&rel) else {
            log::warn!("{base} 里有名字不正常的项目，已跳过：{rel:?}");
            continue;
        };
        let local = root.join(local_rel);
        match entry.kind {
            FileKind::Dir => {
                tokio::fs::create_dir_all(&local).await.map_err(|e| format!("无法在下载目录创建文件夹：{e}"))?;
            }
            FileKind::File => {
                let mut file =
                    tokio::fs::File::create(&local).await.map_err(|e| format!("无法在下载目录创建文件：{e}"))?;
                let before = done;
                let n = sftp
                    .download(&format!("{base}/{rel}"), &mut file, |p| {
                        let all = TransferProgress { done: before + p.done, total };
                        if throttle.due(all) {
                            let _ = on_progress.send(all);
                        }
                    })
                    .await
                    .map_err(|e| format!("{rel}：{e}"))?;
                file.flush().await.map_err(|e| format!("无法写入下载目录：{e}"))?;
                done += n;
            }
            FileKind::Link => {}
        }
    }
    let _ = on_progress.send(TransferProgress { done: total, total });
    Ok(root.to_string_lossy().into_owned())
}

/// 打包传输：服务器上把 dir 里的 names 打成 .tar.gz，下载到"下载"目录里的隐藏临时文件，
/// 解压出来（`unpack`）后删掉两头的临时包。返回解压出来的每一项。打包时回调里 total 为 0
#[tauri::command]
pub async fn sftp_pack_download(
    app: AppHandle,
    state: State<'_, SessionManager>,
    id: String,
    dir: String,
    names: Vec<String>,
    on_progress: Channel<TransferProgress>,
) -> Result<Vec<String>, String> {
    use tokio::io::AsyncWriteExt;

    let conn = state.connection(&id).map_err(|e| e.to_string())?;
    let sftp = conn.sftp().await.map_err(|e| e.to_string())?;
    let downloads = download_dir(&app)?;
    let _ = on_progress.send(TransferProgress { done: 0, total: 0 });
    let remote = conn.pack(&dir, &names).await.map_err(|e| e.to_string())?;

    let (local, mut file) = create_unique(&downloads, &format!(".evershell-pack-{}.tar.gz", std::process::id())).await?;
    let mut throttle = ProgressThrottle::default();
    let got = sftp
        .download(&remote, &mut file, |p| {
            if throttle.due(p) {
                let _ = on_progress.send(p);
            }
        })
        .await
        .map(drop)
        .map_err(|e| e.to_string());
    let flushed = file.flush().await.map_err(|e| format!("无法写入下载目录：{e}"));
    drop(file);
    // 服务器上的临时包成不成功都删
    let _ = sftp.remove(&remote, false).await;
    if let Err(e) = got.and(flushed) {
        let _ = tokio::fs::remove_file(&local).await;
        return Err(e);
    }

    let archive = local.clone();
    let unpacked = tokio::task::spawn_blocking(move || unpack::unpack_tar_gz(&archive, &downloads))
        .await
        .map_err(|e| format!("解压失败：{e}"));
    let _ = tokio::fs::remove_file(&local).await;
    Ok(unpacked??.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

/// 改权限：mode 是低 12 位，scope 见 `PermScope`
#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, SessionManager>,
    id: String,
    path: String,
    mode: u32,
    scope: PermScope,
) -> Result<(), String> {
    let sftp = sftp(&state, &id).await?;
    sftp.chmod(&path, mode, scope).await.map_err(|e| e.to_string())
}

/// 快速删除：服务器上执行一条 rm -rf（命令在内核里拼，路径加引号）
#[tauri::command]
pub async fn ssh_remove_fast(state: State<'_, SessionManager>, id: String, paths: Vec<String>) -> Result<(), String> {
    let conn = state.connection(&id).map_err(|e| e.to_string())?;
    conn.remove_fast(&paths).await.map_err(|e| e.to_string())
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
        .map_err(|_| "未找到本机的下载目录".to_string())?;
    let (local, mut file) = create_unique(&dir, &name).await?;
    if let Err(e) = file.write_all(data).await {
        drop(file);
        let _ = tokio::fs::remove_file(&local).await;
        return Err(format!("写入文件失败：{e}"));
    }
    Ok(local.to_string_lossy().into_owned())
}

/// 一键导入：读各 SSH 软件默认位置的配置文件。读哪些位置由 local_import.rs 的表决定，前端不能传路径
#[tauri::command]
pub async fn import_find_local(app: AppHandle) -> Result<Vec<LocalConfig>, String> {
    let dirs = local_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || local_import::find(Platform::current(), &dirs))
        .await
        .map_err(|e| format!("查找配置文件时出错：{e}"))
}

/// 一键导入快捷命令：同 import_find_local，读的是另一张位置表；大配置文件只交出命令那一块
#[tauri::command]
pub async fn import_find_local_commands(app: AppHandle) -> Result<Vec<LocalConfig>, String> {
    let dirs = local_dirs(&app)?;
    tauri::async_runtime::spawn_blocking(move || local_import::find_commands(Platform::current(), &dirs))
        .await
        .map_err(|e| format!("查找配置文件时出错：{e}"))
}

fn local_dirs(app: &AppHandle) -> Result<Dirs, String> {
    let path = app.path();
    Ok(Dirs {
        home: path.home_dir().map_err(|_| "未找到本机的用户目录")?,
        data: path.data_dir().map_err(|_| "未找到本机的应用数据目录")?,
        local_data: path.local_data_dir().map_err(|_| "未找到本机的应用数据目录")?,
    })
}

/// 选私钥文件并读出内容，取消返回 None。不用网页的选文件框，原因见 local_file.rs
#[tauri::command]
pub async fn local_pick_key_file(app: AppHandle) -> Result<Option<PickedFile>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(local_file::pick_one());
    })
    .map_err(|e| format!("无法打开文件选择窗口：{e}"))?;
    let Some(path) = rx.await.map_err(|_| "文件选择窗口异常关闭".to_string())?? else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || local_file::read_key_file(&path))
        .await
        .map_err(|e| format!("读取文件时出错：{e}"))?
        .map(Some)
}

/// 认私钥的类型、长度和指纹（私钥库用，docs/specs/key-library.md）。带口令的私钥解开要一会儿，放到阻塞线程里
#[tauri::command]
pub async fn key_inspect(private_key: String, passphrase: Option<String>) -> Result<ssh_core::keys::KeyInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ssh_core::keys::inspect_private_key(&private_key, passphrase.as_deref()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("识别私钥时出错：{e}"))?
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
        .map_err(|e| format!("保险箱操作出错：{e}"))?
}

async fn sftp(state: &SessionManager, id: &str) -> Result<ssh_core::Sftp, String> {
    let conn = state.connection(id).map_err(|e| e.to_string())?;
    conn.sftp().await.map_err(|e| e.to_string())
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
    request.headers().get(name).and_then(|v| v.to_str().ok())
}

fn download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().download_dir().map_err(|_| "未找到本机的下载目录".to_string())
}

/// 在 `dir` 下新建一个不与现有文件重名的文件夹：`nginx`、`nginx (1)`…
async fn create_unique_dir(dir: &Path, name: &str) -> Result<PathBuf, String> {
    for n in 0u32.. {
        let candidate = if n == 0 { dir.join(name) } else { dir.join(format!("{name} ({n})")) };
        match tokio::fs::create_dir(&candidate).await {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("无法在下载目录创建文件夹：{e}")),
        }
    }
    unreachable!()
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
