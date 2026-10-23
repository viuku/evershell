//! 会话管理：每个 SSH 会话一个按序执行的终端操作队列，外加共享的连接句柄。
//!
//! Tauri 的 async 命令在多线程运行时上并发执行，连续两次 write 可能被调换顺序。
//! 所以终端操作只把请求投进队列，由会话专属的任务按投递顺序执行。
//! 监控和 SFTP 走各自的 channel，不经过这个队列，直接用 [`SessionManager::connection`]。
//! 终端输出的回执（[`SessionManager::ack`]）也不进队列，原因见 [`ssh_core::OutputAck`]。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ssh_core::{
    Auth, ConnectConfig, Connection, HostKeyCheck, MonitorDetail, MonitorHandle, MonitorSnapshot, OutputAck, ShellEvent,
    SystemInfo,
};
use tokio::sync::mpsc;

pub type SessionId = String;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Ssh(#[from] ssh_core::Error),
    #[error("会话不存在或已关闭")]
    NotFound,
}

pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: Auth,
    pub cols: u32,
    pub rows: u32,
    /// 服务器指纹记录，OpenSSH known_hosts 格式；对不上时连接在发密码前中止（ssh_core::Error::HostKey）
    pub known_hosts: String,
}

pub struct Connected {
    pub id: SessionId,
    pub fingerprint: Option<String>,
}

enum Op {
    Write(Vec<u8>),
    Resize(u32, u32),
    Close,
}

struct Entry {
    ops: mpsc::UnboundedSender<Op>,
    output: OutputAck,
    conn: Arc<Connection>,
    /// 正在跑的监控采样；会话移除时一起丢弃，循环随之停止
    monitor: Option<MonitorHandle>,
    /// 界面要的采样详情。记在会话上，采样（重新）开始时带上：
    /// 前端的两次 invoke 到达顺序没有保证，改详情可能比开始采样先到
    detail: MonitorDetail,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<SessionId, Entry>>>,
    next_id: AtomicU64,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 建立连接、登录并打开 shell。远端输出和退出事件通过 `on_event` 送出，`Exit` 之后不再有事件。
    /// 输出显示完要调 [`Self::ack`] 回执，否则积压到上限后就不再送新的输出。
    /// 内部会 spawn 任务，必须在 tokio 运行时里调用。
    pub async fn connect<F>(&self, params: ConnectParams, on_event: F) -> Result<Connected, Error>
    where
        F: Fn(ShellEvent) + Send + 'static,
    {
        let stream = ssh_core::connect_tcp(&params.host, params.port).await?;
        let cfg = ConnectConfig::new(HostKeyCheck::KnownHosts {
            host: params.host.clone(),
            port: params.port,
            known_hosts: params.known_hosts,
        });
        let conn = Arc::new(Connection::connect(stream, &params.user, params.auth, &cfg).await?);
        let fingerprint = conn.host_key_fingerprint().map(str::to_owned);
        let (shell, mut events) = conn
            .open_shell("xterm-256color", params.cols, params.rows)
            .await?;

        let id = format!("s{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let (tx, mut rx) = mpsc::unbounded_channel();
        self.sessions.lock().unwrap().insert(
            id.clone(),
            Entry {
                ops: tx,
                output: shell.output_ack(),
                conn: conn.clone(),
                monitor: None,
                detail: MonitorDetail::default(),
            },
        );

        // 操作队列。Close 断开整条连接，shell 随之收到 Exit
        let op_id = id.clone();
        tokio::spawn(async move {
            while let Some(op) = rx.recv().await {
                let result = match op {
                    Op::Write(data) => shell.write(&data).await,
                    Op::Resize(cols, rows) => shell.resize(cols, rows).await,
                    Op::Close => {
                        if let Err(e) = conn.disconnect().await {
                            log::debug!("[{op_id}] 断开时出错: {e}");
                        }
                        break;
                    }
                };
                if let Err(e) = result {
                    log::warn!("[{op_id}] 操作失败，关闭会话: {e}");
                    let _ = conn.disconnect().await;
                    break;
                }
            }
        });

        // 事件转发；会话结束后从表里移除，队列任务随之收到 None 退出，监控也一起停
        let sessions = self.sessions.clone();
        let ev_id = id.clone();
        tokio::spawn(async move {
            while let Some(ev) = events.recv().await {
                let exited = matches!(ev, ShellEvent::Exit { .. });
                on_event(ev);
                if exited {
                    break;
                }
            }
            sessions.lock().unwrap().remove(&ev_id);
            log::info!("[{ev_id}] 会话结束");
        });

        log::info!("[{id}] 已连接 {}:{}", params.host, params.port);
        Ok(Connected { id, fingerprint })
    }

    pub fn write(&self, id: &str, data: Vec<u8>) -> Result<(), Error> {
        self.send(id, Op::Write(data))
    }

    pub fn resize(&self, id: &str, cols: u32, rows: u32) -> Result<(), Error> {
        self.send(id, Op::Resize(cols, rows))
    }

    /// 界面显示完了 `bytes` 字节输出
    pub fn ack(&self, id: &str, bytes: usize) -> Result<(), Error> {
        let sessions = self.sessions.lock().unwrap();
        let entry = sessions.get(id).ok_or(Error::NotFound)?;
        entry.output.ack(bytes);
        Ok(())
    }

    pub fn close(&self, id: &str) -> Result<(), Error> {
        // 输出暂停着的时候 russh 处理不了断开请求，先放开；之后的输出界面也不会再看
        if let Some(entry) = self.sessions.lock().unwrap().get(id) {
            entry.output.release();
        }
        self.send(id, Op::Close)
    }

    /// 会话底层的连接，给监控和 SFTP 用
    pub fn connection(&self, id: &str) -> Result<Arc<Connection>, Error> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .get(id)
            .map(|e| e.conn.clone())
            .ok_or(Error::NotFound)
    }

    /// 开始监控采样，快照通过 `on_snapshot` 送出。同一会话再次调用会替换掉之前的采样。
    /// 内部会 spawn 任务，必须在 tokio 运行时里调用；写成 async 是为了让同步的 Tauri 命令
    /// （跑在主线程、没有运行时）调不了它，否则一开监控整个应用就崩。
    pub async fn start_monitor<F>(&self, id: &str, interval: Duration, on_snapshot: F) -> Result<(), Error>
    where
        F: Fn(MonitorSnapshot) + Send + 'static,
    {
        let (conn, detail) = {
            let sessions = self.sessions.lock().unwrap();
            let entry = sessions.get(id).ok_or(Error::NotFound)?;
            (entry.conn.clone(), entry.detail)
        };
        let (handle, mut rx) = conn.watch_monitor(interval, detail);
        tokio::spawn(async move {
            while let Some(snap) = rx.recv().await {
                on_snapshot(snap);
            }
        });
        let mut sessions = self.sessions.lock().unwrap();
        let entry = sessions.get_mut(id).ok_or(Error::NotFound)?;
        // 取详情和存句柄之间界面又改了详情：以最新的为准（一样的话不会多采）
        handle.set_detail(entry.detail);
        entry.monitor = Some(handle);
        Ok(())
    }

    /// 改监控采样顺带多取哪些数据（全部进程、网络连接），在跑的采样马上按新的采一次；
    /// 没在采样时只记下来，下次开始采样时用
    pub fn set_monitor_detail(&self, id: &str, detail: MonitorDetail) -> Result<(), Error> {
        let mut sessions = self.sessions.lock().unwrap();
        let entry = sessions.get_mut(id).ok_or(Error::NotFound)?;
        entry.detail = detail;
        if let Some(monitor) = &entry.monitor {
            monitor.set_detail(detail);
        }
        Ok(())
    }

    /// 取一次系统信息（发行版、内核、CPU 型号）
    pub async fn system_info(&self, id: &str) -> Result<SystemInfo, Error> {
        let conn = self.connection(id)?;
        Ok(conn.system_info().await?)
    }

    pub fn stop_monitor(&self, id: &str) -> Result<(), Error> {
        let mut sessions = self.sessions.lock().unwrap();
        let entry = sessions.get_mut(id).ok_or(Error::NotFound)?;
        entry.monitor = None;
        Ok(())
    }

    fn send(&self, id: &str, op: Op) -> Result<(), Error> {
        let sessions = self.sessions.lock().unwrap();
        let entry = sessions.get(id).ok_or(Error::NotFound)?;
        entry.ops.send(op).map_err(|_| Error::NotFound)
    }
}
