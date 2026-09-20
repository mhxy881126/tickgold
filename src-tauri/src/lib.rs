mod market;

use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_sql::{Migration, MigrationKind};

struct BossHidden(Mutex<bool>);

#[tauri::command]
async fn get_quotes(codes: Vec<String>) -> Result<Vec<market::Quote>, String> {
    market::get_quotes(codes).await
}

#[tauri::command]
async fn get_kline(code: String, period: i64, count: i64) -> Result<Vec<market::KBar>, String> {
    market::get_kline(code, period, count).await
}

#[tauri::command]
async fn get_minute(code: String) -> Result<Vec<market::KBar>, String> {
    market::get_minute(code).await
}

#[tauri::command]
async fn search_stocks(keyword: String) -> Result<Vec<market::StockItem>, String> {
    market::search_stocks(keyword).await
}

#[tauri::command]
async fn get_index_quotes() -> Result<Vec<market::Quote>, String> {
    market::get_index_quotes().await
}

#[tauri::command]
async fn get_rank(sort: String, pz: i64) -> Result<Vec<market::Quote>, String> {
    market::get_rank(sort, pz).await
}

/// 老板键：切换所有窗口显隐
fn boss_toggle(app: &tauri::AppHandle) {
    let state = app.state::<BossHidden>();
    let mut hidden = state.0.lock().unwrap();
    *hidden = !*hidden;
    let now_hidden = *hidden;
    drop(hidden);

    for (_, w) in app.webview_windows() {
        if now_hidden {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(
                    "sqlite:stock-dock.db",
                    vec![
                        Migration {
                            version: 1,
                            description: "create meta",
                            sql: "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 2,
                            description: "create groups",
                            sql: "CREATE TABLE IF NOT EXISTS groups (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                name TEXT NOT NULL,
                                sort_order INTEGER NOT NULL DEFAULT 0,
                                created_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 3,
                            description: "create stocks",
                            sql: "CREATE TABLE IF NOT EXISTS stocks (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                code TEXT NOT NULL UNIQUE,
                                name TEXT NOT NULL DEFAULT '',
                                group_id INTEGER NOT NULL DEFAULT 1,
                                sort_order INTEGER NOT NULL DEFAULT 0,
                                created_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 4,
                            description: "create alerts",
                            sql: "CREATE TABLE IF NOT EXISTS alerts (
                                id TEXT PRIMARY KEY,
                                code TEXT NOT NULL,
                                name TEXT NOT NULL DEFAULT '',
                                up_price REAL,
                                down_price REAL,
                                up_pct REAL,
                                down_pct REAL,
                                cooldown_sec INTEGER NOT NULL DEFAULT 300,
                                enabled INTEGER NOT NULL DEFAULT 1,
                                last_fired_at INTEGER
                            );",
                            kind: MigrationKind::Up,
                        },
                    ],
                )
                .build(),
        )
        .manage(BossHidden(Mutex::new(false)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["Alt+`"])
                .expect("invalid shortcut")
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        boss_toggle(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // ===== 灵动岛悬浮窗 =====
            let island = WebviewWindowBuilder::new(app, "island", WebviewUrl::App("index.html".into()))
                .title("灵动岛")
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .shadow(false)
                .transparent(true)
                .inner_size(300.0, 52.0)
                .build()?;

            // 定位到右上角
            if let Some(monitor) = island.primary_monitor()? {
                let size = monitor.size();
                let scale = monitor.scale_factor();
                let x = size.width as f64 / scale - 312.0;
                let _ = island.set_position(LogicalPosition::new(x, 12.0));
            }

            // ===== 系统托盘 =====
            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let show_island = MenuItem::with_id(app, "show_island", "显示灵动岛", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &show_island, &quit])?;
            TrayIconBuilder::with_id("main-tray")
                .tooltip("灵动盯盘 (Alt+` 老板键)")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "show_island" => {
                        if let Some(w) = app.get_webview_window("island") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_quotes,
            get_kline,
            get_minute,
            search_stocks,
            get_index_quotes,
            get_rank
        ])
        .run(tauri::generate_context!())
        .expect("error while running stock-dock");
}
