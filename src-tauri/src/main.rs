// 防止 release 构建时控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    stock_dock_lib::run()
}
