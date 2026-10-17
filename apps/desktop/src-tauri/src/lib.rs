//! 桌面端 Rust 侧：把 ssh-core 包成 Tauri 命令。
//! 会话管理（`session`）和钥匙串（`secrets`）不依赖 Tauri，可以单独测试。

mod commands;
pub mod secrets;
pub mod session;

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let context = tauri::generate_context!();
    // 钥匙串条目的服务名用应用标识，和数据目录一致
    let secrets = secrets::Secrets::new(context.config().identifier.clone());
    tauri::Builder::default()
        .manage(session::SessionManager::new())
        .manage(secrets)
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_write,
            commands::ssh_resize,
            commands::ssh_close,
            commands::ssh_monitor_start,
            commands::ssh_monitor_stop,
            commands::sftp_home,
            commands::sftp_list,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_upload,
            commands::sftp_download,
            commands::save_download,
            commands::secret_get,
            commands::secret_set,
            commands::secret_remove,
        ])
        .run(context)
        .expect("Tauri 启动失败");
}
