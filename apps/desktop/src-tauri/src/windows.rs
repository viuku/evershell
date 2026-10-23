//! 主窗口以外的独立窗口：编辑器（docs/specs/remote-edit.md）、连接管理器（docs/specs/manager-window.md）。
//!
//! 各自同一时刻只有一个。文件读写、连接都在主窗口做，独立窗口和主窗口用 `editor-msg`、`manager-msg`
//! 事件收发消息；这里只管开窗口，以及关窗口时别把编辑器里没保存的修改丢了。
//!
//! 连接管理器在启动后就悄悄建好、藏着（`manager_window_preload`），点开时只是亮出来，关闭也只是藏起来：
//! 新建一个窗口要启动一个网页、把界面代码加载一遍，要等一会儿，所有者嫌慢（2026-10-23）。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::window::Color;
use tauri::{AppHandle, CloseRequestApi, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const MAIN: &str = "main";
pub const EDITOR: &str = "editor";
pub const MANAGER: &str = "manager";
/// 独立窗口和主窗口之间的消息，内容由前端定（packages/ui/src/core/remote-edit.ts、manager-link.ts）
const EDITOR_MSG: &str = "editor-msg";
const MANAGER_MSG: &str = "manager-msg";
/// 要关主窗口时，编辑窗口里还有没保存的：让它问一下
const QUIT_EVENT: &str = "editor-quit-requested";

#[derive(Default)]
pub struct EditorState {
    /// 编辑窗口里有没保存的修改（编辑窗口自己报上来）
    dirty: AtomicBool,
    /// 用户已经在编辑窗口里选了保存或不保存，接下来的关闭不再拦
    quitting: AtomicBool,
}

/// `#rrggbb` → 颜色；格式不对返回 None
fn parse_color(hex: &str) -> Option<Color> {
    let hex = hex.trim().strip_prefix('#')?;
    if hex.len() != 6 || !hex.is_ascii() {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some(Color(byte(0)?, byte(2)?, byte(4)?, 255))
}

/// 一个独立窗口长什么样
struct Spec {
    label: &'static str,
    title: &'static str,
    size: (f64, f64),
    min: (f64, f64),
}

const EDITOR_SPEC: Spec = Spec { label: EDITOR, title: "编辑器", size: (980.0, 680.0), min: (520.0, 360.0) };
const MANAGER_SPEC: Spec = Spec { label: MANAGER, title: "连接管理器", size: (940.0, 640.0), min: (640.0, 400.0) };

fn reveal(w: &WebviewWindow) {
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

/// 打开某个独立窗口，已经有了（开着或藏着）就亮出来、切到前面。和主窗口加载同一个页面，前端按窗口标签决定显示哪个界面。
/// `visible` 为 false 时只建好、先藏着。
/// `background` 是界面现在的底色：网页还没画出来时系统默认铺白底，深色模式下一开窗口会白一下，
/// 设了底色就露出这个颜色，看不出来
fn open_window(app: &AppHandle, spec: &Spec, background: Option<String>, visible: bool) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(spec.label) {
        if visible {
            reveal(&w);
        }
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App("index.html".into()))
        .title(spec.title)
        .inner_size(spec.size.0, spec.size.1)
        .min_inner_size(spec.min.0, spec.min.1)
        .visible(visible);
    let builder = match background.as_deref().and_then(parse_color) {
        Some(color) => builder.background_color(color),
        None => builder,
    };
    // 和主窗口一样隐藏系统标题栏（tauri.macos.conf.json），顶上那条和主窗口标签栏一样高，红绿灯叠在左边
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 21.0));
    builder.build().map_err(|e| format!("打不开{}窗口：{e}", spec.title))?;
    Ok(())
}

/// 打开编辑窗口，已经开着就切到前面
#[tauri::command]
pub async fn editor_window_open(app: AppHandle, background: Option<String>) -> Result<(), String> {
    open_window(&app, &EDITOR_SPEC, background, true)
}

/// 打开连接管理器窗口：预先建好的话直接亮出来
#[tauri::command]
pub async fn manager_window_open(app: AppHandle, background: Option<String>) -> Result<(), String> {
    open_window(&app, &MANAGER_SPEC, background, true)
}

/// 主窗口启动后调：把连接管理器窗口先建好、藏着，点开时不用再等它加载
#[tauri::command]
pub async fn manager_window_preload(app: AppHandle, background: Option<String>) -> Result<(), String> {
    open_window(&app, &MANAGER_SPEC, background, false)
}

/// 连接管理器“关掉”时其实是藏起来，下次打开就不用再加载
#[tauri::command]
pub fn window_hide(window: WebviewWindow) {
    let _ = window.hide();
}

/// 点了连接管理器的关闭按钮（红点）：藏起来，不真的关
pub fn on_manager_close_requested(window: &tauri::Window, api: &CloseRequestApi) {
    api.prevent_close();
    let _ = window.hide();
}

/// 把主窗口切到前面（在连接管理器里点了连接，连接是在主窗口里开的）
#[tauri::command]
pub fn main_window_focus(app: AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub fn editor_set_dirty(state: State<'_, EditorState>, dirty: bool) {
    state.dirty.store(dirty, Ordering::Relaxed);
}

/// 编辑窗口里选了保存或不保存之后调：关掉编辑窗口，再关主窗口
#[tauri::command]
pub fn editor_quit(app: AppHandle, state: State<'_, EditorState>) {
    state.quitting.store(true, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window(EDITOR) {
        let _ = w.destroy();
    }
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.close();
    }
}

/// 要关主窗口了。编辑窗口有没保存的就先不关，让编辑窗口问；没有就把独立窗口一起关掉。
/// 主窗口一关，会话就都没了，独立窗口留着也没用
pub fn on_main_close_requested(app: &AppHandle, api: &CloseRequestApi) {
    if let Some(editor) = app.get_webview_window(EDITOR) {
        let state = app.state::<EditorState>();
        if state.dirty.load(Ordering::Relaxed) && !state.quitting.load(Ordering::Relaxed) {
            api.prevent_close();
            let _ = editor.unminimize();
            let _ = editor.set_focus();
            let _ = editor.emit_to(EDITOR, QUIT_EVENT, ());
            return;
        }
        let _ = editor.destroy();
    }
    if let Some(manager) = app.get_webview_window(MANAGER) {
        let _ = manager.destroy();
    }
}

/// 独立窗口没了：告诉主窗口，它攒着的消息、记着的文档都可以忘了
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    let event = match label {
        EDITOR => {
            app.state::<EditorState>().dirty.store(false, Ordering::Relaxed);
            EDITOR_MSG
        }
        MANAGER => MANAGER_MSG,
        _ => return,
    };
    let _ = app.emit_to(MAIN, event, serde_json::json!({ "type": "gone" }));
}

/// 调试版用：环境变量 `EVERSHELL_OPEN=manager` 时，启动 4 秒后（主窗口已经把它预先建好了）把连接管理器亮出来，
/// 给 scripts/mac-preview.sh 截图看样子（不用点界面），也能看出预先建好的窗口是不是一亮就有内容
#[cfg(debug_assertions)]
pub fn open_from_env(app: &AppHandle) {
    if std::env::var("EVERSHELL_OPEN").as_deref() == Ok(MANAGER) {
        let app = app.clone();
        // 桌面端没开 tokio 的计时功能，用一个普通线程等
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(4));
            tauri::async_runtime::block_on(async {
                // 和所有者平时用的深色一样的底色
                let _ = manager_window_open(app, Some("#1c1c1e".into())).await;
            });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hex_colors() {
        assert_eq!(parse_color("#1c1c1e"), Some(Color(0x1c, 0x1c, 0x1e, 255)));
        assert_eq!(parse_color(" #FFFFFF "), Some(Color(255, 255, 255, 255)));
        assert_eq!(parse_color("1c1c1e"), None);
        assert_eq!(parse_color("#fff"), None);
        assert_eq!(parse_color("#gggggg"), None);
        assert_eq!(parse_color("#中文字"), None);
    }
}
