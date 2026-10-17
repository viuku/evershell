// Windows 上 release 版不要弹控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    evershell_desktop_lib::run()
}
