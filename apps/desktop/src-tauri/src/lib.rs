//! 桌面端 Rust 侧：把 ssh-core 包成 Tauri 命令。
//! 会话管理（`session`）和保险箱（`secrets`）不依赖 Tauri，可以单独测试。

mod commands;
pub mod secrets;
pub mod session;

use tauri::Manager;

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let context = tauri::generate_context!();
    tauri::Builder::default()
        .manage(session::SessionManager::new())
        .setup(|app| {
            // 保险箱放应用数据目录；钥匙串条目的服务名用应用标识，和数据目录一致
            let path = app.path().app_data_dir()?.join("vault.json");
            let keychain = secrets::SystemKeychain::new(app.config().identifier.clone());
            app.manage(secrets::Secrets::new(path, keychain));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_write,
            commands::ssh_ack,
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
