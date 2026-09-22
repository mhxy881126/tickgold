mod market;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;
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
async fn get_orderbook(code: String) -> Result<market::OrderBook, String> {
    market::get_orderbook(code).await
}

#[tauri::command]
async fn get_fund_flow(code: String) -> Result<market::FundFlow, String> {
    market::get_fund_flow(code).await
}

#[tauri::command]
async fn get_sectors(kind: String) -> Result<Vec<market::Sector>, String> {
    market::get_sectors(kind).await
}

#[tauri::command]
async fn get_screener(
    filter: market::ScreenFilter,
) -> Result<Vec<market::ScreenResult>, String> {
    market::get_screener(filter).await
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
async fn get_rank_page(
    sort: String,
    page: i64,
    num: i64,
) -> Result<Vec<market::Quote>, String> {
    market::get_rank_page(sort, page, num).await
}

#[tauri::command]
async fn check_latest() -> Result<market::LatestInfo, String> {
    market::check_latest().await
}

#[tauri::command]
async fn get_f10_profile(code: String) -> Result<market::f10::CompanyProfile, String> {
    market::f10::get_profile(code).await
}

#[tauri::command]
async fn get_f10_finance(code: String) -> Result<market::f10::FinanceReport, String> {
    market::f10::get_finance(code).await
}

#[tauri::command]
async fn get_f10_chips(code: String) -> Result<market::f10::ChipDistribution, String> {
    market::f10::get_chips(code).await
}

#[tauri::command]
async fn get_ipo_list() -> Result<Vec<market::cninfo::IpoItem>, String> {
    market::cninfo::get_ipo_list().await
}

#[tauri::command]
async fn get_restricted_queue(code: String) -> Result<Vec<market::cninfo::RestrictedItem>, String> {
    market::cninfo::get_restricted_queue(code).await
}

#[tauri::command]
async fn start_spider(
    app: tauri::AppHandle,
    watch: Vec<String>,
    ctl: tauri::State<'_, Arc<market::spider::SpiderCtl>>,
) -> Result<String, String> {
    *ctl.watch.lock().unwrap() = watch;
    if ctl.running.load(Ordering::Acquire) {
        return Ok("already running".to_string());
    }
    ctl.running.store(true, Ordering::Release);
    let c: Arc<market::spider::SpiderCtl> = ctl.inner().clone();
    tauri::async_runtime::spawn(async move {
        market::spider::run_loop(app, c).await;
    });
    Ok("started".to_string())
}

#[tauri::command]
fn stop_spider(ctl: tauri::State<'_, Arc<market::spider::SpiderCtl>>) -> Result<String, String> {
    ctl.running.store(false, Ordering::Release);
    Ok("stopped".to_string())
}

#[tauri::command]
async fn start_radar(
    app: tauri::AppHandle,
    ctl: tauri::State<'_, Arc<market::limitup::LimitRadar>>,
) -> Result<String, String> {
    if ctl.running.load(Ordering::Acquire) {
        return Ok("already running".to_string());
    }
    ctl.running.store(true, Ordering::Release);
    let c: Arc<market::limitup::LimitRadar> = ctl.inner().clone();
    tauri::async_runtime::spawn(async move {
        market::limitup::run_loop(app, c).await;
    });
    Ok("started".to_string())
}

#[tauri::command]
fn stop_radar(ctl: tauri::State<'_, Arc<market::limitup::LimitRadar>>) -> Result<String, String> {
    ctl.running.store(false, Ordering::Release);
    Ok("stopped".to_string())
}

#[tauri::command]
async fn start_alert_engine(
    app: tauri::AppHandle,
    rules: Vec<market::alert::AlertRule>,
    engine: tauri::State<'_, Arc<market::alert::AlertEngine>>,
) -> Result<String, String> {
    // 每次规则变更都会重新调用：已运行则只更新规则快照
    *engine.rules.lock().unwrap() = rules;
    if engine.running.load(Ordering::Acquire) {
        return Ok("updated".to_string());
    }
    engine.running.store(true, Ordering::Release);
    let e: Arc<market::alert::AlertEngine> = engine.inner().clone();
    tauri::async_runtime::spawn(async move {
        market::alert::run_loop(app, e).await;
    });
    Ok("started".to_string())
}

#[tauri::command]
fn stop_alert_engine(
    engine: tauri::State<'_, Arc<market::alert::AlertEngine>>,
) -> Result<String, String> {
    engine.running.store(false, Ordering::Release);
    Ok("stopped".to_string())
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
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
                        Migration {
                            version: 5,
                            description: "create paper account",
                            sql: "CREATE TABLE IF NOT EXISTS paper_account (
                                id INTEGER PRIMARY KEY CHECK (id = 1),
                                init_cash REAL NOT NULL,
                                cash REAL NOT NULL,
                                created_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 6,
                            description: "create paper position",
                            sql: "CREATE TABLE IF NOT EXISTS paper_position (
                                code TEXT PRIMARY KEY,
                                name TEXT NOT NULL DEFAULT '',
                                vol INTEGER NOT NULL DEFAULT 0,
                                avail_vol INTEGER NOT NULL DEFAULT 0,
                                cost_amount REAL NOT NULL DEFAULT 0,
                                updated_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 7,
                            description: "create paper order",
                            sql: "CREATE TABLE IF NOT EXISTS paper_order (
                                id TEXT PRIMARY KEY,
                                code TEXT NOT NULL,
                                name TEXT NOT NULL DEFAULT '',
                                side TEXT NOT NULL,
                                price REAL NOT NULL,
                                vol INTEGER NOT NULL,
                                amount REAL NOT NULL,
                                fee REAL NOT NULL DEFAULT 0,
                                status TEXT NOT NULL,
                                created_at INTEGER NOT NULL,
                                trade_date TEXT NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 8,
                            description: "create trading journal",
                            sql: "CREATE TABLE IF NOT EXISTS journal (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                date TEXT NOT NULL,
                                title TEXT NOT NULL DEFAULT '',
                                content TEXT NOT NULL DEFAULT '',
                                mood TEXT,
                                tags TEXT NOT NULL DEFAULT '',
                                code TEXT,
                                created_at INTEGER NOT NULL,
                                updated_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 9,
                            description: "create finance calendar events",
                            sql: "CREATE TABLE IF NOT EXISTS cal_event (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                date TEXT NOT NULL,
                                time TEXT,
                                title TEXT NOT NULL,
                                type TEXT NOT NULL DEFAULT 'other',
                                note TEXT NOT NULL DEFAULT '',
                                code TEXT,
                                remind INTEGER NOT NULL DEFAULT 0,
                                done INTEGER NOT NULL DEFAULT 0,
                                created_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                    ],
                )
                .build(),
        )
        .manage(BossHidden(Mutex::new(false)))
        .manage(Arc::new(market::spider::SpiderCtl::new()))
        .manage(Arc::new(market::limitup::LimitRadar::new()))
        .manage(Arc::new(market::alert::AlertEngine::new()))
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
            // 显式为主窗口设置图标，确保 Windows 任务栏 / 标题栏正确显示（部分环境默认未应用）
            if let Some(icon) = app.default_window_icon().cloned() {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.set_icon(icon);
                }
            }

            // ===== 灵动岛悬浮窗 =====
            let island = WebviewWindowBuilder::new(app, "island", WebviewUrl::App("index.html".into()))
                .title("TickGold Island")
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
                .tooltip("TickGold - 金睛盯盘 (Alt+` 老板键)")
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
            get_orderbook,
            get_fund_flow,
            get_sectors,
            get_screener,
            search_stocks,
            get_index_quotes,
            get_rank_page,
            check_latest,
            get_f10_profile,
            get_f10_finance,
            get_f10_chips,
            get_ipo_list,
            get_restricted_queue,
            start_spider,
            stop_spider,
            start_radar,
            stop_radar,
            start_alert_engine,
            stop_alert_engine
        ])
        .run(tauri::generate_context!())
        .expect("error while running stock-dock");
}
