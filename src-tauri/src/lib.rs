mod logging;
mod market;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
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
async fn get_hist_minute(code: String, date: String) -> Result<Vec<market::KBar>, String> {
    market::get_hist_minute(code, date).await
}

#[tauri::command]
async fn get_orderbook(code: String) -> Result<market::OrderBook, String> {
    market::get_orderbook(code).await
}

#[tauri::command]
async fn get_trades(code: String, n: i64) -> Result<Vec<market::TradeTick>, String> {
    market::get_trades(code, n).await
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
async fn get_news_flash(page: i64, size: i64) -> Result<Vec<market::NewsItem>, String> {
    market::get_news_flash(page, size).await
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
async fn get_market_restricted(
    start: String,
    end: String,
    page: i64,
    size: i64,
) -> Result<market::eastmoney::MarketRestrictedPage, String> {
    market::eastmoney::market_restricted(&start, &end, page, size).await
}

// ===== 集合竞价 / 涨停池明细 =====
#[tauri::command]
async fn get_auction() -> Result<market::eastmoney::AuctionData, String> {
    market::get_auction().await
}

#[tauri::command]
async fn get_zt_pool(date: String) -> Result<market::eastmoney::ZtPool, String> {
    market::get_zt_pool(date).await
}

#[tauri::command]
async fn get_zb_pool(date: String) -> Result<market::eastmoney::ZtPool, String> {
    market::get_zb_pool(date).await
}

// ===== 龙虎榜复盘 =====
#[tauri::command]
async fn get_lhb_list(date: String) -> Result<market::eastmoney::LhbList, String> {
    market::eastmoney::lhb_list(&date).await
}

#[tauri::command]
async fn get_lhb_detail(
    code: String,
    date: String,
) -> Result<market::eastmoney::LhbDetail, String> {
    market::eastmoney::lhb_detail(&code, &date).await
}

#[tauri::command]
async fn get_seat_back(code: String) -> Result<market::eastmoney::SeatBack, String> {
    market::eastmoney::seat_back(&code).await
}

#[tauri::command]
async fn get_seat_trades(
    code: String,
    size: i64,
    page: i64,
) -> Result<market::eastmoney::SeatTrades, String> {
    market::eastmoney::seat_trades(&code, size, page).await
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
    log::info!("短线精灵引擎已启动");
    Ok("started".to_string())
}

#[tauri::command]
fn stop_spider(ctl: tauri::State<'_, Arc<market::spider::SpiderCtl>>) -> Result<String, String> {
    ctl.running.store(false, Ordering::Release);
    log::info!("短线精灵引擎已停止");
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
    log::info!("涨停雷达引擎已启动");
    Ok("started".to_string())
}

#[tauri::command]
fn stop_radar(ctl: tauri::State<'_, Arc<market::limitup::LimitRadar>>) -> Result<String, String> {
    ctl.running.store(false, Ordering::Release);
    log::info!("涨停雷达引擎已停止");
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
    log::info!("预警引擎已启动");
    Ok("started".to_string())
}

#[tauri::command]
fn stop_alert_engine(
    engine: tauri::State<'_, Arc<market::alert::AlertEngine>>,
) -> Result<String, String> {
    engine.running.store(false, Ordering::Release);
    log::info!("预警引擎已停止");
    Ok("stopped".to_string())
}

// ===== 自绘标题栏窗口控制（Rust 端直接操作，绕过前端 ACL 与 drag-region 对点击的干扰）=====
#[tauri::command]
fn win_minimize(app: tauri::AppHandle) -> Result<(), String> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    w.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn win_toggle_maximize(app: tauri::AppHandle) -> Result<bool, String> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    if w.is_maximized().map_err(|e| e.to_string())? {
        w.unmaximize().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        w.maximize().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
fn win_close(app: tauri::AppHandle) -> Result<(), String> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    // 不销毁窗口，隐藏到托盘；这样可从托盘 / 左键托盘重新打开（真正退出走托盘“退出”）
    w.hide().map_err(|e| e.to_string())
}

#[tauri::command]
fn win_is_maximized(app: tauri::AppHandle) -> Result<bool, String> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    w.is_maximized().map_err(|e| e.to_string())
}

// ===== 数据导出：rfd 原生保存对话框选路径，再写入文件（无需 dialog/fs 插件）=====
#[tauri::command]
async fn save_export_file(default_name: String, content: String) -> Result<bool, String> {
    let file = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .save_file()
        .await
        .ok_or_else(|| "已取消保存".to_string())?;
    let path = file.path().to_path_buf();
    tokio::fs::write(&path, content.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

// ===== Rust 分级日志：读取 / 清空 / 动态调级（前端可合并前后端日志导出）=====
#[tauri::command]
fn rust_logs(min_level: Option<String>) -> Result<Vec<logging::LogItem>, String> {
    Ok(logging::records(min_level))
}

#[tauri::command]
fn rust_clear_logs() -> Result<(), String> {
    logging::clear();
    Ok(())
}

#[tauri::command]
fn rust_set_log_level(level: String) -> Result<bool, String> {
    Ok(logging::set_level(&level))
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

/// 切换指定窗口显隐，并把对应托盘勾选项与窗口实际可见性对齐
fn toggle_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    check: &CheckMenuItem<R>,
) {
    let Some(w) = app.get_webview_window(label) else {
        return;
    };
    let vis = w.is_visible().unwrap_or(false);
    if vis {
        let _ = w.hide();
    } else {
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = check.set_checked(!vis);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init();
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
                        Migration {
                            version: 10,
                            description: "create saved workbench layouts",
                            sql: "CREATE TABLE IF NOT EXISTS layout (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                name TEXT NOT NULL,
                                cards TEXT NOT NULL,
                                created_at INTEGER NOT NULL,
                                updated_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 11,
                            description: "add min_volume_ratio to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN min_volume_ratio REAL;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 12,
                            description: "add rise_speed to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN rise_speed REAL;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 13,
                            description: "add speed_window_sec to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN speed_window_sec INTEGER;",
                            kind: MigrationKind::Up,
                        },
                        // ===== v0.51 本地时序库：盘中分时 + 收盘日级（日级长期保留）=====
                        Migration {
                            version: 14,
                            description: "create ts_market (market sentiment intraday)",
                            sql: "CREATE TABLE IF NOT EXISTS ts_market (
                                day TEXT NOT NULL,
                                ts INTEGER NOT NULL,
                                total INTEGER,
                                up_count INTEGER,
                                down_count INTEGER,
                                flat_count INTEGER,
                                limit_up INTEGER,
                                limit_down INTEGER,
                                broken INTEGER,
                                broken_rate REAL,
                                max_boards INTEGER,
                                sentiment REAL,
                                PRIMARY KEY (day, ts)
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 15,
                            description: "create ts_index (index intraday)",
                            sql: "CREATE TABLE IF NOT EXISTS ts_index (
                                day TEXT NOT NULL,
                                ts INTEGER NOT NULL,
                                code TEXT NOT NULL,
                                name TEXT,
                                price REAL,
                                pct REAL,
                                amount REAL,
                                PRIMARY KEY (day, ts, code)
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 16,
                            description: "create ts_sector (sector intraday)",
                            sql: "CREATE TABLE IF NOT EXISTS ts_sector (
                                day TEXT NOT NULL,
                                ts INTEGER NOT NULL,
                                kind TEXT,
                                code TEXT NOT NULL,
                                name TEXT,
                                change_pct REAL,
                                net_amount REAL,
                                lead_code TEXT,
                                lead_name TEXT,
                                lead_pct REAL,
                                PRIMARY KEY (day, ts, code)
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 17,
                            description: "create ts_day (market sentiment daily)",
                            sql: "CREATE TABLE IF NOT EXISTS ts_day (
                                day TEXT PRIMARY KEY,
                                close_ts INTEGER,
                                total INTEGER,
                                up_count INTEGER,
                                down_count INTEGER,
                                flat_count INTEGER,
                                limit_up INTEGER,
                                limit_down INTEGER,
                                broken INTEGER,
                                broken_rate REAL,
                                max_boards INTEGER,
                                sentiment REAL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 18,
                            description: "create ts_index_day (index daily)",
                            sql: "CREATE TABLE IF NOT EXISTS ts_index_day (
                                day TEXT,
                                code TEXT,
                                name TEXT,
                                price REAL,
                                pct REAL,
                                amount REAL,
                                PRIMARY KEY (day, code)
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 19,
                            description: "create ts_sector_day (sector daily)",
                            sql: "CREATE TABLE IF NOT EXISTS ts_sector_day (
                                day TEXT,
                                kind TEXT,
                                code TEXT,
                                name TEXT,
                                change_pct REAL,
                                net_amount REAL,
                                lead_code TEXT,
                                lead_name TEXT,
                                lead_pct REAL,
                                PRIMARY KEY (day, code)
                            );",
                            kind: MigrationKind::Up,
                        },
                        // ===== v0.52 画线工具：按 股票+周期 作用域持久化 =====
                        Migration {
                            version: 20,
                            description: "create drawing (chart drawings persisted per scope)",
                            sql: "CREATE TABLE IF NOT EXISTS drawing (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                scope TEXT NOT NULL,
                                name TEXT NOT NULL,
                                points TEXT NOT NULL,
                                sort INTEGER NOT NULL DEFAULT 0,
                                updated_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 21,
                            description: "create index idx_drawing_scope",
                            sql: "CREATE INDEX IF NOT EXISTS idx_drawing_scope ON drawing(scope);",
                            kind: MigrationKind::Up,
                        },
                        // ===== v0.53 指标模板：保存 / 复用指标参数与配色 =====
                        Migration {
                            version: 22,
                            description: "create ind_template (named indicator templates)",
                            sql: "CREATE TABLE IF NOT EXISTS ind_template (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                name TEXT NOT NULL UNIQUE,
                                payload TEXT NOT NULL,
                                created_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        // ===== v0.61 预警增强：alerts 新增条件列 =====
                        Migration {
                            version: 23,
                            description: "add down_speed to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN down_speed REAL;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 24,
                            description: "add min_turnover to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN min_turnover REAL;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 25,
                            description: "add min_amount to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN min_amount REAL;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 26,
                            description: "add seal_limit_up to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN seal_limit_up INTEGER;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 27,
                            description: "add seal_limit_down to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN seal_limit_down INTEGER;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 28,
                            description: "add broken_limit to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN broken_limit INTEGER;",
                            kind: MigrationKind::Up,
                        },
                        // ===== 触发历史持久化（前端写入，便于复盘）=====
                        Migration {
                            version: 29,
                            description: "create alert_event (alert trigger history)",
                            sql: "CREATE TABLE IF NOT EXISTS alert_event (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                rule_id TEXT,
                                code TEXT,
                                name TEXT,
                                kind TEXT,
                                label TEXT,
                                message TEXT,
                                price REAL,
                                pct REAL,
                                target REAL,
                                tone TEXT,
                                triggered_at INTEGER
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 30,
                            description: "create index idx_alert_event_time",
                            sql: "CREATE INDEX IF NOT EXISTS idx_alert_event_time ON alert_event(triggered_at);",
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
            // ===== 主窗口：标题栏融入工作台 =====
            if let Some(main) = app.get_webview_window("main") {
                // 显式设置图标，确保 Windows 任务栏正确显示
                if let Some(icon) = app.default_window_icon().cloned() {
                    let _ = main.set_icon(icon);
                }

                // Windows/Linux —— 去掉原生标题栏（前端自绘最小化 / 最大化 / 关闭）
                #[cfg(not(target_os = "macos"))]
                let _ = main.set_decorations(false);

                // macOS —— 保留原生红绿灯，仅隐藏标题栏背景、内嵌入自绘顶栏
                #[cfg(target_os = "macos")]
                {
                    use tauri::TitleBarStyle;
                    // 红绿灯保持默认位置，由前端 .topbar.mac 左间距避让（不依赖运行时定位 API）
                    let _ = main.set_title_bar_style(TitleBarStyle::Overlay);
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

            // ===== 系统托盘：勾选式菜单，分别控制主窗口 / 灵动岛显隐 =====
            // with_id(manager, id, text, enabled, checked, accelerator)
            let main_item =
                CheckMenuItem::with_id(app, "toggle_main", "主窗口", true, true, None::<&str>)?;
            let island_item = CheckMenuItem::with_id(
                app,
                "toggle_island",
                "灵动岛",
                true,
                true,
                None::<&str>,
            )?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "退出 TickGold", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&main_item, &island_item, &sep, &quit])?;

            // 菜单项内部为 Arc，克隆句柄供事件闭包使用
            let main_c = main_item.clone();
            let island_c = island_item.clone();
            let main_c2 = main_item.clone();

            TrayIconBuilder::with_id("main-tray")
                .tooltip("TickGold · 金睛盯盘 (Alt+` 老板键)")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "toggle_main" => toggle_window(app, "main", &main_c),
                    "toggle_island" => toggle_window(app, "island", &island_c),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(move |tray, event| {
                    // 左键单击托盘图标：切换主窗口显隐
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        toggle_window(app, "main", &main_c2);
                    }
                })
                .build(app)?;
            Ok(())
        })
                .invoke_handler(tauri::generate_handler![
            get_quotes,
            get_kline,
            get_minute,
            get_hist_minute,
            get_orderbook,
            get_trades,
            get_fund_flow,
            get_sectors,
            get_screener,
            search_stocks,
            get_index_quotes,
            get_rank_page,
            get_news_flash,
            check_latest,
            get_f10_profile,
            get_f10_finance,
            get_f10_chips,
            get_ipo_list,
            get_restricted_queue,
            get_market_restricted,
            get_auction,
            get_zt_pool,
            get_zb_pool,
            get_lhb_list,
            get_lhb_detail,
            get_seat_back,
            get_seat_trades,
            start_spider,
            stop_spider,
            start_radar,
            stop_radar,
            start_alert_engine,
            stop_alert_engine,
            win_minimize,
            win_toggle_maximize,
            win_close,
            win_is_maximized,
            save_export_file,
            rust_logs,
            rust_clear_logs,
            rust_set_log_level
        ])
        .run(tauri::generate_context!())
        .expect("error while running stock-dock");
}
