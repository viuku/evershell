//! 桌面端 Rust 侧：把 ssh-core 包成 Tauri 命令。
//! 会话管理（`session`）和保险箱（`secrets`）不依赖 Tauri，可以单独测试。

mod commands;
mod local_file;
mod local_import;
pub mod secrets;
pub mod session;
mod windows;

use tauri::{Manager, WindowEvent};

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let context = tauri::generate_context!();
    tauri::Builder::default()
        .manage(session::SessionManager::new())
        .manage(windows::EditorState::default())
        .on_window_event(|window, event| match (window.label(), event) {
            (windows::MAIN, WindowEvent::CloseRequested { api, .. }) => {
                windows::on_main_close_requested(window.app_handle(), api);
            }
            (windows::MANAGER, WindowEvent::CloseRequested { api, .. }) => {
                windows::on_manager_close_requested(window, api);
            }
            (label, WindowEvent::Destroyed) => windows::on_window_destroyed(window.app_handle(), label),
            _ => {}
        })
        .setup(|app| {
            // 保险箱放应用数据目录；钥匙串条目的服务名用应用标识，和数据目录一致
            let path = app.path().app_data_dir()?.join("vault.json");
            let keychain = secrets::SystemKeychain::new(app.config().identifier.clone());
            app.manage(secrets::Secrets::new(path, keychain));
            #[cfg(debug_assertions)]
            windows::open_from_env(app.handle());
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
            commands::ssh_monitor_detail,
            commands::ssh_system_info,
            commands::sftp_home,
            commands::sftp_list,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_stat,
            commands::sftp_read,
            commands::sftp_upload,
            commands::sftp_download,
            commands::save_download,
            commands::import_find_local,
            commands::local_pick_key_file,
            commands::key_inspect,
            commands::secret_get,
            commands::secret_set,
            commands::secret_remove,
            windows::editor_window_open,
            windows::editor_set_dirty,
            windows::editor_quit,
            windows::manager_window_open,
            windows::manager_window_preload,
            windows::window_hide,
            windows::main_window_focus,
            windows::main_close_confirmed,
        ])
        .run(context)
        .expect("Tauri 启动失败");
}
