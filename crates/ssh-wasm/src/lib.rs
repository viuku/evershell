//! 网页端 SSH：ssh-core 跑在浏览器里，中转服务只负责 WebSocket ↔ TCP 字节转发，
//! 所以密码和私钥不会经过中转。
#![cfg(target_arch = "wasm32")]

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use js_sys::{Function, Uint8Array};
use serde::Serialize;
use ssh_core::{
    Auth, ConnectConfig, Connection, HostKeyCheck, MonitorDetail, MonitorHandle, OutputAck, Sftp, ShellEvent,
    TransferProgress,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::{mpsc, oneshot};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;
use web_sys::{BinaryType, CloseEvent, MessageEvent, WebSocket};

enum Cmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

/// 一条已登录、已打开 shell 的会话；监控和 SFTP 在同一条连接上走各自的 channel。
#[wasm_bindgen]
pub struct WebSession {
    cmds: mpsc::UnboundedSender<Cmd>,
    output: OutputAck,
    conn: Arc<Connection>,
    fingerprint: Option<String>,
    monitor: RefCell<Option<MonitorHandle>>,
    /// 采样时顺带多取哪些数据；记在会话上，重新开始采样时带上
    detail: Cell<MonitorDetail>,
}

#[wasm_bindgen]
impl WebSession {
    /// `relay_url` 是完整的中转地址（含目标主机和令牌）。
    /// `private_key` 有值时用私钥认证，否则用 `password`。
    /// `on_data(bytes)` 收到的输出显示完要调 [`WebSession::ack`] 回执；`on_exit(code, reason)` 见 ShellEvent::Exit。
    /// `host`、`port` 是 SSH 服务器（查 known_hosts 用），`known_hosts` 是 OpenSSH 格式的指纹记录。
    /// 指纹没通过时抛出 `{ kind: 'hostKey', problem }`（problem 见 types.ts 的 HostKeyProblem），其它错误抛 Error
    #[allow(clippy::too_many_arguments)]
    pub async fn connect(
        relay_url: String,
        host: String,
        port: u16,
        known_hosts: String,
        user: String,
        password: Option<String>,
        private_key: Option<String>,
        passphrase: Option<String>,
        cols: u32,
        rows: u32,
        on_data: Function,
        on_exit: Function,
    ) -> Result<WebSession, JsValue> {
        console_error_panic_hook::set_once();

        let stream = open_relay(&relay_url).await?;
        let auth = match private_key {
            Some(pem) => Auth::PrivateKey { pem, passphrase },
            None => Auth::Password(password.unwrap_or_default()),
        };
        let cfg = ConnectConfig::new(HostKeyCheck::KnownHosts { host, port, known_hosts });
        let conn = match Connection::connect(stream, &user, auth, &cfg).await {
            Ok(c) => Arc::new(c),
            Err(ssh_core::Error::HostKey(problem)) => {
                #[derive(Serialize)]
                struct HostKeyThrow {
                    kind: &'static str,
                    problem: ssh_core::HostKeyProblem,
                }
                return Err(to_js(&HostKeyThrow { kind: "hostKey", problem: *problem })?);
            }
            Err(e) => return Err(js_err(e).into()),
        };
        let fingerprint = conn.host_key_fingerprint().map(str::to_owned);
        let (shell, mut events) = conn
            .open_shell("xterm-256color", cols, rows)
            .await
            .map_err(js_err)?;
        let output = shell.output_ack();

        spawn_local(async move {
            while let Some(event) = events.recv().await {
                match event {
                    ShellEvent::Data(data) => {
                        let _ = on_data.call1(&JsValue::NULL, &Uint8Array::from(&data[..]));
                    }
                    ShellEvent::Exit { code, reason } => {
                        let code = code.map_or(JsValue::NULL, JsValue::from);
                        let reason = reason.map_or(JsValue::NULL, JsValue::from);
                        let _ = on_exit.call2(&JsValue::NULL, &code, &reason);
                    }
                }
            }
        });

        // 所有终端写操作排进同一个队列，保证按键顺序与调用顺序一致
        let (cmds, mut rx) = mpsc::unbounded_channel();
        let queue_conn = conn.clone();
        spawn_local(async move {
            while let Some(cmd) = rx.recv().await {
                let result = match cmd {
                    Cmd::Data(data) => shell.write(&data).await,
                    Cmd::Resize(cols, rows) => shell.resize(cols, rows).await,
                    Cmd::Close => {
                        let _ = queue_conn.disconnect().await;
                        break;
                    }
                };
                if result.is_err() {
                    let _ = queue_conn.disconnect().await;
                    break;
                }
            }
        });

        Ok(WebSession {
            cmds,
            output,
            conn,
            fingerprint,
            monitor: RefCell::new(None),
            detail: Cell::new(MonitorDetail::default()),
        })
    }

    #[wasm_bindgen(getter, js_name = hostKeyFingerprint)]
    pub fn host_key_fingerprint(&self) -> Option<String> {
        self.fingerprint.clone()
    }

    pub fn write(&self, data: &[u8]) {
        let _ = self.cmds.send(Cmd::Data(data.to_vec()));
    }

    pub fn resize(&self, cols: u32, rows: u32) {
        let _ = self.cmds.send(Cmd::Resize(cols, rows));
    }

    /// 界面显示完了 `bytes` 字节输出（见 ssh_core::OutputAck）
    pub fn ack(&self, bytes: u32) {
        self.output.ack(bytes as usize);
    }

    /// 断开整条连接
    pub fn close(&self) {
        *self.monitor.borrow_mut() = None;
        // 输出暂停着的时候 russh 处理不了断开请求，先放开
        self.output.release();
        let _ = self.cmds.send(Cmd::Close);
    }

    /// 开始监控采样，每份快照（见 types.ts 的 MonitorSnapshot）调一次 `on_snapshot`。
    /// 再次调用会替换掉之前的采样。
    #[wasm_bindgen(js_name = startMonitor)]
    pub fn start_monitor(&self, interval_ms: u32, on_snapshot: Function) {
        let interval = Duration::from_millis(interval_ms.max(500) as u64);
        let (handle, mut rx) = self.conn.watch_monitor(interval, self.detail.get());
        *self.monitor.borrow_mut() = Some(handle);
        spawn_local(async move {
            while let Some(snap) = rx.recv().await {
                if let Ok(v) = to_js(&snap) {
                    let _ = on_snapshot.call1(&JsValue::NULL, &v);
                }
            }
        });
    }

    #[wasm_bindgen(js_name = stopMonitor)]
    pub fn stop_monitor(&self) {
        *self.monitor.borrow_mut() = None;
    }

    /// 采样时顺带多取哪些数据（见 types.ts 的 MonitorDetail），在跑的采样马上按新的采一次；
    /// 没在采样时只记下，下次 startMonitor 时用
    #[wasm_bindgen(js_name = setMonitorDetail)]
    pub fn set_monitor_detail(&self, procs: bool, sockets: bool) {
        let detail = MonitorDetail { procs, sockets };
        self.detail.set(detail);
        if let Some(monitor) = self.monitor.borrow().as_ref() {
            monitor.set_detail(detail);
        }
    }

    /// 取一次系统信息，返回 SystemInfo（见 types.ts）
    #[wasm_bindgen(js_name = systemInfo)]
    pub async fn system_info(&self) -> Result<JsValue, JsError> {
        let info = self.conn.system_info().await.map_err(js_err)?;
        to_js(&info)
    }

    #[wasm_bindgen(js_name = homeDir)]
    pub async fn home_dir(&self) -> Result<String, JsError> {
        self.sftp().await?.home_dir().await.map_err(js_err)
    }

    /// 返回 FileEntry 数组（见 types.ts）
    #[wasm_bindgen(js_name = listDir)]
    pub async fn list_dir(&self, path: String) -> Result<JsValue, JsError> {
        let entries = self.sftp().await?.list_dir(&path).await.map_err(js_err)?;
        to_js(&entries)
    }

    pub async fn mkdir(&self, path: String) -> Result<(), JsError> {
        self.sftp().await?.mkdir(&path).await.map_err(js_err)
    }

    pub async fn remove(&self, path: String, is_dir: bool) -> Result<(), JsError> {
        self.sftp().await?.remove(&path, is_dir).await.map_err(js_err)
    }

    pub async fn rename(&self, from: String, to: String) -> Result<(), JsError> {
        self.sftp().await?.rename(&from, &to).await.map_err(js_err)
    }

    /// 返回 FileEntry（见 types.ts），跟着符号链接走
    pub async fn stat(&self, path: String) -> Result<JsValue, JsError> {
        let entry = self.sftp().await?.stat(&path).await.map_err(js_err)?;
        to_js(&entry)
    }

    /// 整个文件读进内存（Uint8Array），超过 `max_bytes` 报错。给编辑器用；`on_progress` 每次收到 `{ done, total }`
    #[wasm_bindgen(js_name = readFile)]
    pub async fn read_file(
        &self,
        path: String,
        max_bytes: u64,
        on_progress: Option<Function>,
    ) -> Result<Vec<u8>, JsError> {
        self.sftp()
            .await?
            .read_file(&path, max_bytes, |p| report(&on_progress, p))
            .await
            .map_err(js_err)
    }

    /// `on_progress` 每次收到 `{ done, total }`
    pub async fn upload(
        &self,
        path: String,
        data: Vec<u8>,
        on_progress: Option<Function>,
    ) -> Result<(), JsError> {
        let sftp = self.sftp().await?;
        let total = data.len() as u64;
        sftp.upload(&path, &data[..], total, |p| report(&on_progress, p))
            .await
            .map_err(js_err)
    }

    /// 返回文件内容（Uint8Array）
    pub async fn download(
        &self,
        path: String,
        on_progress: Option<Function>,
    ) -> Result<Vec<u8>, JsError> {
        let sftp = self.sftp().await?;
        let mut buf = Vec::new();
        sftp.download(&path, &mut buf, |p| report(&on_progress, p))
            .await
            .map_err(js_err)?;
        Ok(buf)
    }
}

impl WebSession {
    async fn sftp(&self) -> Result<Sftp, JsError> {
        self.conn.sftp().await.map_err(js_err)
    }
}

fn report(on_progress: &Option<Function>, p: TransferProgress) {
    if let (Some(f), Ok(v)) = (on_progress, to_js(&p)) {
        let _ = f.call1(&JsValue::NULL, &v);
    }
}

/// 序列化成普通 JS 对象：None 变 null、u64 变 number，与 types.ts 的声明一致
fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsError> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsError::new(&e.to_string()))
}

fn js_err(e: ssh_core::Error) -> JsError {
    JsError::new(&e.to_string())
}

/// 打开到中转服务的 WebSocket，并把它桥接成 ssh-core 需要的字节流。
///
/// 浏览器的 WebSocket 不是 `Send`，不能直接交给 russh，
/// 所以中间放一个内存管道（DuplexStream 是 `Send` 的），两头各用一个本地任务搬运数据。
async fn open_relay(url: &str) -> Result<DuplexStream, JsError> {
    let ws = WebSocket::new(url).map_err(|_| JsError::new("中转地址无效"))?;
    ws.set_binary_type(BinaryType::Arraybuffer);

    let (incoming_tx, mut incoming_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let incoming_tx = Rc::new(RefCell::new(Some(incoming_tx)));
    let (opened_tx, opened_rx) = oneshot::channel::<Result<(), String>>();
    let opened_tx = Rc::new(RefCell::new(Some(opened_tx)));

    let on_open = Closure::<dyn FnMut()>::new({
        let opened_tx = opened_tx.clone();
        move || {
            if let Some(tx) = opened_tx.borrow_mut().take() {
                let _ = tx.send(Ok(()));
            }
        }
    });
    let on_message = Closure::<dyn FnMut(MessageEvent)>::new({
        let incoming_tx = incoming_tx.clone();
        move |e: MessageEvent| {
            if let (Ok(buf), Some(tx)) = (
                e.data().dyn_into::<js_sys::ArrayBuffer>(),
                incoming_tx.borrow().as_ref(),
            ) {
                let _ = tx.send(Uint8Array::new(&buf).to_vec());
            }
        }
    });
    let on_close = Closure::<dyn FnMut(CloseEvent)>::new({
        let opened_tx = opened_tx.clone();
        move |e: CloseEvent| {
            // 断开发送端，管道另一头读到 EOF，SSH 会话随之结束
            incoming_tx.borrow_mut().take();
            if let Some(tx) = opened_tx.borrow_mut().take() {
                // 中转拒绝握手（如令牌错误）时浏览器拿不到 HTTP 状态码，只会给 1006
                let reason = match e.reason() {
                    r if !r.is_empty() => format!("中转连接失败：{r}"),
                    _ if e.code() == 1006 => {
                        "无法连接中转服务器：地址有误、中转服务未启动或令牌错误".to_string()
                    }
                    _ => format!("中转连接失败（错误代码 {}）", e.code()),
                };
                let _ = tx.send(Err(reason));
            }
        }
    });
    ws.set_onopen(Some(on_open.as_ref().unchecked_ref()));
    ws.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
    ws.set_onclose(Some(on_close.as_ref().unchecked_ref()));

    match opened_rx.await {
        Ok(Ok(())) => {}
        Ok(Err(reason)) => return Err(JsError::new(&reason)),
        Err(_) => return Err(JsError::new("中转连接失败")),
    }

    let (ssh_side, bridge) = tokio::io::duplex(256 * 1024);
    let (mut bridge_read, mut bridge_write) = tokio::io::split(bridge);

    spawn_local(async move {
        while let Some(chunk) = incoming_rx.recv().await {
            if bridge_write.write_all(&chunk).await.is_err() {
                break;
            }
        }
        let _ = bridge_write.shutdown().await;
    });

    spawn_local(async move {
        // 回调闭包要和连接活得一样久，放进这个任务里持有
        let _callbacks = (on_open, on_message, on_close);
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match bridge_read.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws.send_with_u8_array(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
        // 浏览器会在 close() 之后异步触发 onclose，那时闭包已随本任务释放，先摘掉回调
        ws.set_onopen(None);
        ws.set_onmessage(None);
        ws.set_onclose(None);
        let _ = ws.close();
    });

    Ok(ssh_side)
}
