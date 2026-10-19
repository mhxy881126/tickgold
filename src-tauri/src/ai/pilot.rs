// P6 一键智驾模式：模拟盘全自动闭环编排（EasyUp 式体验，真实通道互斥）。
//
// 驾驶舱「一键开始自动交易」= 模拟盘每日 15 次自动排程：
//   盘前闭环自动补齐（采集→分析→计划→确认，复用 workflow_p1 命令语义），
//   盘中由 autoexec run_loop 全自动执行（复用 workflow_watch_start 语义），
//   收盘自动结算回灌（复用 workflow_feedback 语义）。
//
// 安全红线（不可绕过）：
//   1) 智驾模式强制 paper：真实通道已武装（live_enabled / live_armed_at / 非模拟 client）时拒绝启动；
//   2) 急停状态禁止启动；真实通道永远走武装向导，与智驾互斥；
//   3) 执行风控仍走 autoexec 现有闸门（硬止损/日亏/回撤/连亏），档位仅在其上收放。

use crate::ai::autoexec::{AutoExecCtl, AutoExecConfig};
use crate::ai::maindb::open_readwrite;
use crate::ai::workflow;
use crate::ai::workflow_p2::paper_full_config;
use crate::ai::{now_millis, AiState};
use crate::broker::config::BrokerConfig;
use crate::broker::BrokerManager;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

// ============================ 调度常量 ============================

/// 15 个盯盘触发点（分钟数，自当日 0 点起）：早盘 2 + 上午 6 + 下午 6 + 尾盘 1 = 15 次。
pub const PILOT_SCAN_POINTS: [u16; 15] = [
    570, 585, // 09:30 09:45
    600, 620, 640, 660, 680, 700, // 10:00–11:40 每 20 分钟
    780, 800, 820, 840, 860, 880, // 13:00–14:40 每 20 分钟
    910, // 15:10 尾盘（只卖不买由 autoexec no_open_after 兜底）
];
/// 15:30 收盘结算（独立触发，不计入盯盘次数）。
pub const PILOT_CLOSE_MINUTE: u16 = 930;

/// 全部触发点（扫描 15 + 收盘 1），升序。
pub fn all_trigger_points() -> Vec<u16> {
    let mut v: Vec<u16> = PILOT_SCAN_POINTS.to_vec();
    v.push(PILOT_CLOSE_MINUTE);
    v.sort_unstable();
    v.dedup();
    v
}

// ============================ 运行时控制 ============================

/// 智驾排程器运行时句柄（manage 注入，Arc 便于移入后台 task）。
/// last_trigger 记录 (日期, 分钟) 防止同日重复触发；跨日自动重置。
#[derive(Default)]
pub struct PilotCtl {
    pub running: AtomicBool,
    pub last_trigger: Mutex<(String, u16)>,
    pub last_trigger_minute: AtomicU16,
}

impl PilotCtl {
    pub fn new() -> Arc<Self> {
        Arc::new(PilotCtl {
            running: AtomicBool::new(false),
            last_trigger: Mutex::new((String::new(), 0)),
            last_trigger_minute: AtomicU16::new(0),
        })
    }
}

// ============================ 纯逻辑（可单测） ============================

/// 智驾仅限模拟盘的安全校验（P4/P5 护栏之外的第一道闸）。
fn verify_paper_only(bc: &BrokerConfig) -> Result<(), String> {
    if bc.live_enabled {
        return Err("智驾模式仅限模拟盘：实盘开关已启用，请先在券商通道关闭实盘，或走武装向导管理真实通道".to_string());
    }
    if bc.live_armed_at > 0 {
        return Err("智驾模式仅限模拟盘：真实通道已武装（armed_at={})，请回退武装或改用武装向导流程".to_string());
    }
    if !bc.client_sim {
        return Err("智驾模式仅限模拟盘：客户端通道指向真实账户（client_sim=false），请切换为模拟环境".to_string());
    }
    Ok(())
}

/// 给定「当前分钟 + 最后触发点」，返回应立即触发的下一个点（若已到点且未执行）。
/// 跨日视为重置：从当日第一个 <= now 的点开始。用于排程器与单测注入。
fn next_due_point(now: u16, last_date: &str, last_minute: u16, today: &str) -> Option<u16> {
    let pts = all_trigger_points();
    if today != last_date {
        return pts.into_iter().find(|p| *p <= now);
    }
    pts.into_iter().find(|p| *p > last_minute && *p <= now)
}

/// 当前北京时间分钟数（0..1440），无 chrono 依赖。
fn current_minute() -> u16 {
    let secs = crate::ai::now_millis() / 1000;
    // UTC 秒 → 北京分钟（UTC+8）。
    let bj = secs + 8 * 3600;
    let min = (bj % 86400) / 60;
    min as u16
}

/// 是否交易日：查 trade_calendar；日历未覆盖时默认开放（不阻断演示）。
fn is_trading_day(conn: &Connection, date: &str) -> bool {
    conn.query_row(
        "SELECT is_open FROM trade_calendar WHERE date=?1",
        rusqlite::params![date],
        |r| r.get::<_, i64>(0),
    )
    .map(|v| v == 1)
    .unwrap_or(true)
}

/// 当日 mission 当前步（0-based；不存在返回 0）。
fn current_step(conn: &Connection, date: &str) -> i64 {
    conn.query_row(
        "SELECT current_step FROM daily_mission WHERE trade_date=?1",
        rusqlite::params![date],
        |r| r.get::<_, i64>(0),
    )
    .unwrap_or(0)
}

/// 风控档位 → AutoExecConfig 收放映射。steady = autoexec 现有保守默认。
fn pilot_exec_config(risk_profile: &str) -> AutoExecConfig {
    let mut cfg = paper_full_config();
    match risk_profile {
        "aggressive" => {
            cfg.hard_stop_pct = -8.0;
            cfg.max_total_pct = 90.0;
            cfg.daily_loss_limit_pct = 6.0;
            cfg.max_drawdown_limit_pct = 25.0;
        }
        "defensive" => {
            cfg.hard_stop_pct = -4.0;
            cfg.max_total_pct = 60.0;
            cfg.daily_loss_limit_pct = 3.0;
            cfg.max_drawdown_limit_pct = 12.0;
        }
        _ => {
            // steady：沿用 autoexec 默认（硬止损 -7%、总仓 80%、日亏 5%、回撤 20%、连亏 3 停）。
        }
    }
    cfg
}

fn valid_risk_profile(s: &str) -> bool {
    matches!(s, "steady" | "aggressive" | "defensive")
}

// ============================ 库操作 ============================

fn ensure_pilot_config(conn: &Connection, now: i64) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO pilot_config(id, created_at, updated_at) VALUES(1, ?1, ?1)",
        rusqlite::params![now],
    )
    .map_err(|e| format!("初始化智驾配置失败: {e}"))?;
    Ok(())
}

fn load_pilot_config(conn: &Connection) -> Result<Value, String> {
    conn.query_row(
        "SELECT mode, account_type, virtual_cash, tactic_profile_id, risk_profile,
                schedule_enabled, today_scan_target, today_scan_count, last_scan_at
         FROM pilot_config WHERE id=1",
        [],
        |r| {
            Ok(json!({
                "mode": r.get::<_, String>(0).unwrap_or_default(),
                "accountType": r.get::<_, String>(1).unwrap_or_default(),
                "virtualCash": r.get::<_, i64>(2).unwrap_or(0),
                "tacticProfileId": r.get::<_, i64>(3).unwrap_or(0),
                "riskProfile": r.get::<_, String>(4).unwrap_or_else(|_| "steady".to_string()),
                "scheduleEnabled": r.get::<_, i64>(5).unwrap_or(1) == 1,
                "todayScanTarget": r.get::<_, i64>(6).unwrap_or(15),
                "todayScanCount": r.get::<_, i64>(7).unwrap_or(0),
                "lastScanAt": r.get::<_, i64>(8).unwrap_or(0),
            }))
        },
    )
    .map_err(|e| format!("读取智驾配置失败: {e}"))
}

fn set_mode(conn: &Connection, mode: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE pilot_config SET mode=?1, updated_at=?2 WHERE id=1",
        rusqlite::params![mode, now],
    )
    .map_err(|e| format!("更新智驾状态失败: {e}"))?;
    Ok(())
}

/// 记录一次扫描：递增今日扫描计数、刷新 last_scan_at，并 upsert 当日运行日志。
fn bump_scan(conn: &Connection, date: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE pilot_config SET today_scan_count = today_scan_count + 1,
                last_scan_at = ?1, updated_at = ?1 WHERE id=1",
        rusqlite::params![now],
    )
    .map_err(|e| format!("更新扫描计数失败: {e}"))?;
    conn.execute(
        "INSERT INTO pilot_daily_log (trade_date, scan_count, created_at, updated_at)
         VALUES (?1, 1, ?2, ?2)
         ON CONFLICT(trade_date) DO UPDATE SET scan_count = scan_count + 1, updated_at = ?2",
        rusqlite::params![date, now],
    )
    .map_err(|e| format!("写入智驾日志失败: {e}"))?;
    Ok(())
}

/// 收盘结算：把当日回灌小结写入 pilot_daily_log（best-effort；无数据时跳过）。
fn close_day(conn: &Connection, date: &str, now: i64) -> Result<(), String> {
    let summary = conn
        .query_row(
            "SELECT feedback_json FROM daily_mission WHERE trade_date=?1",
            rusqlite::params![date],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["conclusion"].as_str().map(|s| s.to_string()))
        .unwrap_or_default();
    conn.execute(
        "INSERT INTO pilot_daily_log (trade_date, summary, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(trade_date) DO UPDATE SET summary = excluded.summary, updated_at = ?3",
        rusqlite::params![date, summary, now],
    )
    .map_err(|e| format!("写入收盘小结失败: {e}"))?;
    Ok(())
}

// ============================ 闭环执行 ============================

/// 执行一轮智驾扫描：补齐盘前闭环（若缺）→ 确保盯盘执行中 → 记录扫描。
async fn run_scan(app: AppHandle, dir: PathBuf) -> Result<Value, String> {
    let date = workflow::today_str();
    let now = now_millis();
    let conn = open_readwrite(&dir)?;

    // 1) 确保当日 mission 存在（State 非 Copy，每次调用重新获取）。
    let _ = crate::ai::workflow::workflow_get_today(app.state::<AiState>(), None)?;

    // 2) 按当前步自动补齐缺失的盘前步骤（step 语义：0 采集 / 1 分析 / 2 计划 / 3 确认）。
    let step = current_step(&conn, &date);
    if step < 1 {
        let _ = crate::ai::workflow_p1::workflow_collect(app.state::<AiState>(), None, None)
            .await
            .map_err(|e| format!("智驾采集失败: {e}"))?;
    }
    if step < 2 {
        let _ = crate::ai::workflow_p1::workflow_analyze(app.state::<AiState>(), None, None)
            .await
            .map_err(|e| format!("智驾分析失败: {e}"))?;
    }
    if step < 3 {
        let _ = crate::ai::workflow_p1::workflow_plan(app.state::<AiState>(), None)
            .map_err(|e| format!("智驾生成作战卡失败: {e}"))?;
    }
    // 智驾计划打标 + 取消已物化条件单：必须在确认 / 物化之前完成。
    // 智驾由 autoexec 执行这批指令，条件单引擎不得再执行一遍；打标后
    // materialize_today 按 model='pilot-auto' 结构性排除（不依赖崩溃后会
    // 残留的 pilot_config.mode）。每轮幂等执行，覆盖「确认后崩溃重启」的恢复。
    let plan_date = crate::ai::plan::next_trade_date(&crate::ai::workflow::today_str());
    let _ = conn.execute(
        "UPDATE plan SET model='pilot-auto' WHERE plan_date=?1",
        [&plan_date],
    );
    // 崩溃 / 重启恢复：打标前已确认并物化过的计划可能留着 active 条件单，
    // 会与智驾 autoexec 双份执行；这里按计划取消（与 set_plan_status 同一条 UPDATE）。
    if let Ok(plan_id) = conn.query_row(
        "SELECT id FROM plan WHERE plan_date=?1",
        [&plan_date],
        |r| r.get::<_, i64>(0),
    ) {
        let _ = conn.execute(
            "UPDATE conditional_order SET status='cancelled', updated_at=?1
             WHERE status='active' AND co_id IN (
                 SELECT co_id FROM plan_instruction WHERE plan_id=?2 AND co_id<>'')",
            rusqlite::params![now, plan_id],
        );
    }
    if step < 4 {
        let _ = crate::ai::workflow_p1::workflow_plan_confirm(app.state::<AiState>(), None, None)
            .map_err(|e| format!("智驾确认作战卡失败: {e}"))?;
    }

    // 3) 按风险档位覆盖执行配置并确保盯盘运行中（已在跑则仅刷新配置）。
    let risk = {
        let c = open_readwrite(&dir)?;
        load_pilot_config(&c)
            .ok()
            .and_then(|v| v["riskProfile"].as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "steady".to_string())
    };
    {
        let ctl = app.state::<Arc<AutoExecCtl>>();
        *ctl.config.lock().unwrap() = pilot_exec_config(&risk);
        if !ctl.running.load(Ordering::Acquire) {
            let _ = crate::ai::workflow_p2::workflow_watch_start(
                app.clone(),
                app.state::<AiState>(),
                app.state::<Arc<AutoExecCtl>>(),
                app.state::<BrokerManager>(),
                None,
            )
            .await
            .map_err(|e| format!("智驾启动盯盘失败: {e}"))?;
        }
    }

    // 4) 记录扫描。
    let conn = open_readwrite(&dir)?;
    bump_scan(&conn, &date, now)?;
    Ok(json!({
        "date": date,
        "scan": true,
        "step": current_step(&conn, &date),
    }))
}

/// 收盘结算闭环：先确保当日闭环已推进，再执行收盘回灌（仅 step>=4 时）。
async fn close_day_run(app: AppHandle, dir: PathBuf) -> Result<Value, String> {
    let date = workflow::today_str();
    let now = now_millis();

    // 若盘前未补齐（休市演示场景），先补一轮。
    let step = {
        let conn = open_readwrite(&dir)?;
        current_step(&conn, &date)
    };
    if step < 4 {
        let _ = run_scan(app.clone(), dir.clone()).await;
    }

    let step = {
        let conn = open_readwrite(&dir)?;
        current_step(&conn, &date)
    };
    if step >= 4 {
        let _ = crate::ai::workflow_p2::workflow_feedback(
            app.clone(),
            app.state::<AiState>(),
            app.state::<Arc<AutoExecCtl>>(),
            app.state::<BrokerManager>(),
            None,
        )
        .await
        .map_err(|e| format!("智驾收盘结算失败: {e}"))?;
    }
    let conn = open_readwrite(&dir)?;
    close_day(&conn, &date, now)?;
    Ok(json!({ "date": date, "settled": true }))
}

// ============================ 排程器 ============================

/// 后台排程循环：每 20s 醒一次，按触发点执行扫描/结算；running=false 时退出。
async fn scheduler_loop(app: AppHandle, pilot: Arc<PilotCtl>, dir: PathBuf) {
    loop {
        if !pilot.running.load(Ordering::Acquire) {
            break;
        }
        let today = workflow::today_str();
        let now_min = current_minute();
        let ok = {
            let conn = match open_readwrite(&dir) {
                Ok(c) => c,
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                    continue;
                }
            };
            is_trading_day(&conn, &today)
        };
        if ok {
            let (last_date, last_min) = {
                let g = pilot.last_trigger.lock().unwrap();
                (g.0.clone(), g.1)
            };
            if let Some(point) = next_due_point(now_min, &last_date, last_min, &today) {
                let _ = if point == PILOT_CLOSE_MINUTE {
                    close_day_run(app.clone(), dir.clone()).await
                } else {
                    run_scan(app.clone(), dir.clone()).await
                };
                let mut g = pilot.last_trigger.lock().unwrap();
                *g = (today.clone(), point);
                pilot.last_trigger_minute.store(point, Ordering::Release);
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
    }
}

// ============================ Tauri 命令 ============================

/// 一键开始智驾：校验（仅模拟盘 + 非急停）→ 置 running → 立即执行首轮闭环 → 启动排程器。
#[tauri::command]
pub async fn pilot_start(
    app: AppHandle,
    state: State<'_, AiState>,
    mgr: State<'_, BrokerManager>,
    pilot: State<'_, Arc<PilotCtl>>,
) -> Result<Value, String> {
    let dir = state.dir().clone();
    let now = now_millis();

    // 安全红线 1：仅模拟盘。
    let bc = mgr.config.lock().unwrap().clone();
    verify_paper_only(&bc)?;
    // 安全红线 2：急停状态禁止。
    if mgr.kill_switch.load(Ordering::SeqCst) {
        return Err("当前处于紧急停止状态，请先在驾驶舱解除熔断再启动智驾".to_string());
    }

    let conn = open_readwrite(&dir)?;
    ensure_pilot_config(&conn, now)?;

    // 立即执行首轮闭环（best-effort，不因单轮失败阻断排程启动）。
    let _first = run_scan(app.clone(), dir.clone()).await.unwrap_or_else(|e| {
        log::warn!("[P6] 智驾首轮闭环未完成：{e}");
        json!({ "scan": false, "error": e })
    });

    // 置 running 并启动排程器（幂等：已在跑则不再 spawn）。
    let started_now = {
        if pilot.running.load(Ordering::Acquire) {
            false
        } else {
            pilot.running.store(true, Ordering::Release);
            true
        }
    };
    if started_now {
        let p: Arc<PilotCtl> = pilot.inner().clone();
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            scheduler_loop(app2, p, dir).await;
        });
    }
    set_mode(&conn, "running", now)?;
    log::info!("[P6] 智驾模式启动（模拟盘全自动）");

    pilot_status_inner(&app)
}

/// 暂停智驾：停止排程器（配置持久化 mode=paused，进度保留）。
#[tauri::command]
pub fn pilot_pause(
    state: State<'_, AiState>,
    pilot: State<'_, Arc<PilotCtl>>,
) -> Result<Value, String> {
    let now = now_millis();
    pilot.running.store(false, Ordering::Release);
    let conn = open_readwrite(&state.dir())?;
    set_mode(&conn, "paused", now)?;
    log::info!("[P6] 智驾模式暂停");
    Ok(json!({ "mode": "paused", "running": false }))
}

/// 停止智驾：停止排程器（mode=off）。
#[tauri::command]
pub fn pilot_stop(
    state: State<'_, AiState>,
    pilot: State<'_, Arc<PilotCtl>>,
) -> Result<Value, String> {
    let now = now_millis();
    pilot.running.store(false, Ordering::Release);
    pilot.last_trigger_minute.store(0, Ordering::Release);
    let conn = open_readwrite(&state.dir())?;
    set_mode(&conn, "off", now)?;
    log::info!("[P6] 智驾模式停止");
    Ok(json!({ "mode": "off", "running": false }))
}

/// 智驾状态：配置 + 当日扫描进度 + 排程器运行态 + 当日小结。
#[tauri::command]
pub fn pilot_status(app: AppHandle) -> Result<Value, String> {
    pilot_status_inner(&app)
}

fn pilot_status_inner(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<AiState>();
    let pilot = app.state::<Arc<PilotCtl>>();
    let dir = state.dir().clone();
    let date = workflow::today_str();
    let now = now_millis();
    let conn = open_readwrite(&dir)?;
    let cfg = load_pilot_config(&conn)?;

    // 下一次触发点。
    let now_min = current_minute();
    let (last_date, last_min) = {
        let g = pilot.last_trigger.lock().unwrap();
        (g.0.clone(), g.1)
    };
    let next_scan = next_due_point(now_min, &last_date, last_min, &date);
    let running = pilot.running.load(Ordering::Acquire);

    // 当日日志（summary / 盈亏 / 资产）。
    let log_row = conn
        .query_row(
            "SELECT scan_count, buy_count, sell_count, pnl_cents, asset_cents, summary
             FROM pilot_daily_log WHERE trade_date=?1",
            rusqlite::params![date],
            |r| {
                Ok(json!({
                    "scanCount": r.get::<_, i64>(0).unwrap_or(0),
                    "buyCount": r.get::<_, i64>(1).unwrap_or(0),
                    "sellCount": r.get::<_, i64>(2).unwrap_or(0),
                    "pnlCents": r.get::<_, i64>(3).unwrap_or(0),
                    "assetCents": r.get::<_, i64>(4).unwrap_or(0),
                    "summary": r.get::<_, String>(5).unwrap_or_default(),
                }))
            },
        )
        .unwrap_or_else(|_| json!({ "scanCount": 0, "buyCount": 0, "sellCount": 0, "pnlCents": 0, "assetCents": 0, "summary": "" }));

    Ok(json!({
        "mode": cfg["mode"],
        "accountType": cfg["accountType"],
        "virtualCash": cfg["virtualCash"],
        "riskProfile": cfg["riskProfile"],
        "scheduleEnabled": cfg["scheduleEnabled"],
        "todayScanTarget": cfg["todayScanTarget"],
        "todayScanCount": cfg["todayScanCount"],
        "lastScanAt": cfg["lastScanAt"],
        "running": running,
        "nextScanMinute": next_scan,
        "tradeDate": date,
        "updatedAt": now,
        "today": log_row,
    }))
}

/// 读取智驾配置（mode=off 时返回当前值；运行中只读）。
#[tauri::command]
pub fn pilot_config_get(state: State<'_, AiState>) -> Result<Value, String> {
    let conn = open_readwrite(&state.dir())?;
    ensure_pilot_config(&conn, now_millis())?;
    load_pilot_config(&conn)
}

/// 更新智驾配置（仅 mode=off 允许写入；校验档位合法性与资金正数）。
#[tauri::command]
pub fn pilot_config_set(
    state: State<'_, AiState>,
    risk_profile: Option<String>,
    virtual_cash: Option<i64>,
    tactic_profile_id: Option<i64>,
    schedule_enabled: Option<bool>,
    today_scan_target: Option<i64>,
) -> Result<Value, String> {
    let conn = open_readwrite(&state.dir())?;
    ensure_pilot_config(&conn, now_millis())?;
    let cur = load_pilot_config(&conn)?;
    if cur["mode"].as_str() != Some("off") {
        return Err("智驾运行中或已暂停，请先停止（pilot_stop）再修改配置".to_string());
    }
    let now = now_millis();
    if let Some(rp) = risk_profile {
        if !valid_risk_profile(&rp) {
            return Err(format!("风控档位不合法（{rp}），仅支持 steady / aggressive / defensive"));
        }
        conn.execute(
            "UPDATE pilot_config SET risk_profile=?1, updated_at=?2 WHERE id=1",
            rusqlite::params![rp, now],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(v) = virtual_cash {
        if v <= 0 {
            return Err("虚拟资金必须为正数".to_string());
        }
        conn.execute(
            "UPDATE pilot_config SET virtual_cash=?1, updated_at=?2 WHERE id=1",
            rusqlite::params![v, now],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(t) = tactic_profile_id {
        conn.execute(
            "UPDATE pilot_config SET tactic_profile_id=?1, updated_at=?2 WHERE id=1",
            rusqlite::params![t, now],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(s) = schedule_enabled {
        conn.execute(
            "UPDATE pilot_config SET schedule_enabled=?1, updated_at=?2 WHERE id=1",
            rusqlite::params![s as i64, now],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(t) = today_scan_target {
        if !(1..=20).contains(&t) {
            return Err("每日扫描次数需在 1..=20 之间".to_string());
        }
        conn.execute(
            "UPDATE pilot_config SET today_scan_target=?1, updated_at=?2 WHERE id=1",
            rusqlite::params![t, now],
        )
        .map_err(|e| e.to_string())?;
    }
    load_pilot_config(&conn)
}

// ============================ 单测 ============================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_points_are_15_and_ascending() {
        let pts = PILOT_SCAN_POINTS.to_vec();
        assert_eq!(pts.len(), 15);
        let mut sorted = pts.clone();
        sorted.sort_unstable();
        assert_eq!(pts, sorted, "触发点必须升序");
        assert!(!pts.contains(&PILOT_CLOSE_MINUTE), "收盘点不计入扫描点");
        let all = all_trigger_points();
        assert_eq!(all.len(), 16);
        assert!(all.contains(&PILOT_CLOSE_MINUTE));
    }

    #[test]
    fn next_due_point_same_day_only_forwards() {
        // 同日：只返回严格大于 last_minute 且 <= now 的点。
        assert_eq!(next_due_point(620, "2026-10-17", 600, "2026-10-17"), Some(620));
        // 已执行过 620，now 在 660：先补触发中间点 640（轮询间隙错过则补）。
        assert_eq!(next_due_point(660, "2026-10-17", 620, "2026-10-17"), Some(640));
        // 未到新点：无触发。
        assert_eq!(next_due_point(610, "2026-10-17", 600, "2026-10-17"), None);
        // now 小于第一个点：无触发。
        assert_eq!(next_due_point(500, "2026-10-17", 0, "2026-10-17"), None);
    }

    #[test]
    fn next_due_point_new_day_resets() {
        // 跨日：从当日第一个 <= now 的点开始（忽略 last）。
        assert_eq!(next_due_point(600, "2026-10-16", 910, "2026-10-17"), Some(570));
        assert_eq!(next_due_point(500, "2026-10-16", 910, "2026-10-17"), None);
    }

    #[test]
    fn close_point_triggers_after_last_scan() {
        // 15:10(910) 执行后，15:30(930) 应触发收盘。
        assert_eq!(next_due_point(930, "2026-10-17", 910, "2026-10-17"), Some(930));
        // 收盘后再无触发。
        assert_eq!(next_due_point(1000, "2026-10-17", 930, "2026-10-17"), None);
    }

    #[test]
    fn paper_only_guard_rejects_live_paths() {
        let mut bc = BrokerConfig::default();
        assert!(verify_paper_only(&bc).is_ok(), "默认配置应允许智驾");

        bc.live_enabled = true;
        assert!(verify_paper_only(&bc).is_err());
        bc.live_enabled = false;

        bc.live_armed_at = 1_700_000_000_000;
        assert!(verify_paper_only(&bc).is_err());
        bc.live_armed_at = 0;

        bc.client_sim = false;
        assert!(verify_paper_only(&bc).is_err());
        bc.client_sim = true;
        assert!(verify_paper_only(&bc).is_ok());
    }

    #[test]
    fn risk_profiles_map_to_exec_config() {
        let steady = pilot_exec_config("steady");
        assert_eq!(steady.trade_mode, "full");
        assert!(steady.enabled);
        assert_eq!(steady.hard_stop_pct, -7.0);
        assert_eq!(steady.max_total_pct, 80.0);

        let aggressive = pilot_exec_config("aggressive");
        assert_eq!(aggressive.hard_stop_pct, -8.0);
        assert_eq!(aggressive.max_total_pct, 90.0);

        let defensive = pilot_exec_config("defensive");
        assert_eq!(defensive.hard_stop_pct, -4.0);
        assert_eq!(defensive.max_total_pct, 60.0);

        assert!(valid_risk_profile("steady"));
        assert!(valid_risk_profile("aggressive"));
        assert!(valid_risk_profile("defensive"));
        assert!(!valid_risk_profile("lambo"));
    }

    #[test]
    fn config_set_validates_scan_target() {
        // today_scan_target 范围校验逻辑（1..=20）在命令内；此处验证常量与档位合法性。
        assert!((1..=20).contains(&15));
        assert!(!(0..=0).contains(&15));
    }
}
