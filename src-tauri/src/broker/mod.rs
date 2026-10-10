// 券商对接编排：BrokerManager（配置 / 模拟账户 / sidecar / 紧急停止），Tauri 命令，
// 委托状态机推进、signal_audit 审计、事件广播。合规：只处理 confirmed 单、实盘默认关、风控前置。
pub mod conditional;
pub mod config;
pub mod mock;
pub mod protocol;
pub mod risk;
pub mod sidecar;

use crate::ai::{maindb, now_millis};
use config::BrokerConfig;
use mock::MockBroker;
use rusqlite::Connection;
use sidecar::SidecarHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Listener, Manager, State};

/// 券商对接共享句柄（manage）。
pub struct BrokerManager {
    pub config: Mutex<BrokerConfig>,
    pub mock: Mutex<MockBroker>,
    pub sidecar: Mutex<Option<SidecarHandle>>,
    pub kill_switch: AtomicBool,
    pub connected: AtomicBool,
    // QMT sidecar 最近一次 asset 回报缓存（含 floatPnl/dayPnl 等扩展字段）
    pub asset_cache: Mutex<serde_json::Value>,
}

impl BrokerManager {
    pub fn new() -> Self {
        let c = BrokerConfig::default();
        let cash = c.mock_init_cash;
        BrokerManager {
            config: Mutex::new(c),
            mock: Mutex::new(MockBroker::new(cash)),
            sidecar: Mutex::new(None),
            kill_switch: AtomicBool::new(false),
            connected: AtomicBool::new(false),
            asset_cache: Mutex::new(serde_json::json!({})),
        }
    }

    /// setup 阶段按数据目录加载持久化配置并重置模拟账户。
    pub fn init_with_dir(&self, dir: &Path) {
        let cfg = config::load(dir);
        let cash = cfg.mock_init_cash;
        *self.config.lock().unwrap() = cfg;
        self.mock.lock().unwrap().reset(cash);
    }
}

// ===== 审计 / 检查点 =====

fn audit(conn: &Connection, sig_id: &str, action: &str, detail: &str, actor: &str) {
    let _ = conn.execute(
        "INSERT INTO signal_audit(sig_id,action,detail,actor,created_at)
         VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![sig_id, action, detail, actor, now_millis()],
    );
}

fn checkpoint(conn: &Connection) {
    let _ = conn.query_row::<i64, _, _>("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(0));
}

/// 推进委托状态 + 审计 + 事件（mock 与 sidecar 共用）。
#[allow(clippy::too_many_arguments)]
fn progress(
    conn: &Connection,
    app: &AppHandle,
    sig_id: &str,
    status: &str,
    filled_vol: Option<i64>,
    avg_price: Option<f64>,
    broker_order_id: Option<&str>,
    error_msg: Option<&str>,
    audit_detail: &str,
) -> Result<(), String> {
    protocol::update(
        conn, sig_id, status, filled_vol, avg_price, broker_order_id, error_msg,
    )?;
    audit(conn, sig_id, &format!("broker_{status}"), audit_detail, "broker");
    checkpoint(conn);
    let _ = app.emit(
        "broker:event",
        serde_json::json!({ "sigId": sig_id, "status": status }),
    );
    Ok(())
}

/// A 股裸代码加交易所后缀（QMT 格式）。
fn with_suffix(code: &str) -> String {
    match code.chars().next() {
        Some('6') | Some('9') => format!("{code}.SH"),
        Some('0') | Some('3') | Some('2') => format!("{code}.SZ"),
        Some('8') | Some('4') => format!("{code}.BJ"),
        _ => code.to_string(),
    }
}

/// 解析 sidecar 脚本路径：优先打包资源目录，其次源码目录（开发态）。
fn resolve_script_path(app: &AppHandle) -> Result<PathBuf, String> {
    let rel = Path::new("broker").join("sidecar_qmt.py");
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("resources").join(&rel);
        if p.exists() {
            return Ok(p);
        }
        let p2 = res.join(&rel);
        if p2.exists() {
            return Ok(p2);
        }
    }
    // 开发态候选：src-tauri/resources/broker/sidecar_qmt.py
    for cand in [
        PathBuf::from("src-tauri/resources").join(&rel),
        PathBuf::from("../src-tauri/resources").join(&rel),
    ] {
        if cand.exists() {
            return Ok(cand);
        }
    }
    Err("未找到 sidecar_qmt.py（资源未打包？）".to_string())
}

// ===== sidecar 回报统一处理（第 2 步联调，框架已就绪）=====

pub fn apply_sidecar_event(app: &AppHandle, dir: &Path, v: &serde_json::Value) {
    let event = v["event"].as_str().unwrap_or("");
    match event {
        "connected" => {
            if let Some(m) = try_manager(app) {
                m.connected.store(true, Ordering::SeqCst);
            }
        }
        "disconnected" => {
            if let Some(m) = try_manager(app) {
                m.connected.store(false, Ordering::SeqCst);
            }
        }
        "asset" => {
            // 缓存最近一次资产回报，broker_query_asset（QMT）直接读缓存
            if let Some(m) = try_manager(app) {
                *m.asset_cache.lock().unwrap() = v.clone();
            }
        }
        "order" | "error" => {
            let sig_id = v["client_order_id"].as_str().unwrap_or("").to_string();
            if sig_id.is_empty() {
                return;
            }
            let conn = match maindb::open_readwrite(dir) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("sidecar 回报落库失败：{e}");
                    return;
                }
            };
            if event == "error" {
                let msg = v["message"].as_str().unwrap_or("");
                let _ = progress(&conn, app, &sig_id, protocol::ERROR, None, None, None, Some(msg), msg);
                return;
            }
            let st = match v["status"].as_str().unwrap_or("") {
                "submitted" => protocol::SUBMITTED,
                "part_filled" => protocol::PART_FILLED,
                "filled" => protocol::FILLED,
                "cancelled" => protocol::CANCELLED,
                _ => return,
            };
            let fv = v["filled_vol"].as_i64();
            let ap = v["filled_avg_price"].as_f64();
            let bid = v["broker_order_id"].as_str();
            let _ = progress(&conn, app, &sig_id, st, fv, ap, bid, None, "sidecar 回报");
            if st == protocol::FILLED {
                auto_done_ticket(&conn, app, &sig_id);
            }
        }
        _ => {}
    }
}

fn try_manager(app: &AppHandle) -> Option<State<'_, BrokerManager>> {
    // app.state 通过 Manager trait 获取；State 生命周期绑定 app，此处直接用 try_state。
    Some(app.state::<BrokerManager>())
}

/// 成交满量后联动把信号单标 done。
fn auto_done_ticket(conn: &Connection, app: &AppHandle, sig_id: &str) {
    let now = now_millis();
    let r = conn.execute(
        "UPDATE signal_ticket SET status='done', updated_at=?1 WHERE sig_id=?2 AND status='confirmed'",
        rusqlite::params![now, sig_id],
    );
    if r.is_ok() {
        audit(conn, sig_id, "auto_done", "券商成交满量，自动标记完成", "broker");
        let _ = app.emit("signal:updated", serde_json::json!({ "sigId": sig_id, "status": "done" }));
    }
}

// ===== Tauri 命令 =====

#[tauri::command]
pub fn broker_get_status(mgr: State<'_, BrokerManager>) -> serde_json::Value {
    let cfg = mgr.config.lock().unwrap().clone();
    serde_json::json!({
        "kind": cfg.kind,
        "liveEnabled": cfg.live_enabled,
        "connected": mgr.connected.load(Ordering::SeqCst),
        "killSwitch": mgr.kill_switch.load(Ordering::SeqCst),
        "accountId": cfg.account_id,
    })
}

/// 返回完整配置（设置面板编辑用）。
#[tauri::command]
pub fn broker_get_config(mgr: State<'_, BrokerManager>) -> BrokerConfig {
    mgr.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn broker_set_config(
    ai: State<'_, crate::ai::AiState>,
    mgr: State<'_, BrokerManager>,
    kind: Option<String>,
    python_path: Option<String>,
    qmt_path: Option<String>,
    account_id: Option<String>,
    max_single_pct: Option<f64>,
    max_total_pct: Option<f64>,
    no_open_after: Option<String>,
    fee_pct: Option<f64>,
    mock_allow_anytime: Option<bool>,
    mock_init_cash: Option<f64>,
) -> Result<(), String> {
    let mut cfg = mgr.config.lock().unwrap().clone();
    if let Some(v) = kind { cfg.kind = v; }
    if let Some(v) = python_path { cfg.python_path = v; }
    if let Some(v) = qmt_path { cfg.qmt_path = v; }
    if let Some(v) = account_id { cfg.account_id = v; }
    if let Some(v) = max_single_pct { cfg.max_single_pct = v; }
    if let Some(v) = max_total_pct { cfg.max_total_pct = v; }
    if let Some(v) = no_open_after { cfg.no_open_after = v; }
    if let Some(v) = fee_pct { cfg.fee_pct = v; }
    if let Some(v) = mock_allow_anytime { cfg.mock_allow_anytime = v; }
    if let Some(v) = mock_init_cash { cfg.mock_init_cash = v; }
    config::save(&ai.dir(), &cfg)?;
    *mgr.config.lock().unwrap() = cfg;
    Ok(())
}

#[tauri::command]
pub fn broker_enable_live(
    ai: State<'_, crate::ai::AiState>,
    mgr: State<'_, BrokerManager>,
    enable: bool,
) -> Result<(), String> {
    let mut cfg = mgr.config.lock().unwrap().clone();
    cfg.live_enabled = enable;
    config::save(&ai.dir(), &cfg)?;
    *mgr.config.lock().unwrap() = cfg;
    log::warn!("券商实盘开关被设置为：{enable}");
    Ok(())
}

#[tauri::command]
pub async fn broker_connect(
    app: AppHandle,
    ai: State<'_, crate::ai::AiState>,
    mgr: State<'_, BrokerManager>,
) -> Result<String, String> {
    if mgr.kill_switch.load(Ordering::SeqCst) {
        return Err("紧急停止已触发，请先解除 Kill Switch".to_string());
    }
    let cfg = mgr.config.lock().unwrap().clone();
    let dir = ai.dir();
    match cfg.kind.as_str() {
        "mock" => {
            mgr.connected.store(true, Ordering::SeqCst);
            Ok("模拟通道已连接".to_string())
        }
        "qmt" => {
            let script = resolve_script_path(&app)?;
            let handle = sidecar::spawn(
                app.clone(),
                &dir,
                &cfg.python_path,
                &script.to_string_lossy(),
                &cfg.qmt_path,
                &cfg.account_id,
            )
            .await?;
            *mgr.sidecar.lock().unwrap() = Some(handle);
            Ok("QMT sidecar 已启动，等待客户端连接确认…".to_string())
        }
        other => Err(format!("未知券商适配器：{other}")),
    }
}

#[tauri::command]
pub async fn broker_disconnect(mgr: State<'_, BrokerManager>) -> Result<(), String> {
    let child = mgr.sidecar.lock().unwrap().as_ref().map(|h| h.child.clone());
    if let Some(c) = child {
        let _ = c.lock().await.kill().await;
    }
    *mgr.sidecar.lock().unwrap() = None;
    mgr.connected.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn broker_list_orders(
    ai: State<'_, crate::ai::AiState>,
    status: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<protocol::BrokerOrderInfo>, String> {
    let conn = maindb::open_readonly(&ai.dir())?;
    Ok(protocol::list(&conn, status, limit.unwrap_or(200)))
}

#[tauri::command]
pub async fn broker_submit(
    app: AppHandle,
    sig_id: String,
) -> Result<protocol::BrokerOrderInfo, String> {
    submit_with_sig(&app, &sig_id).await
}

/// 委托提交核心：人工命令与条件单自动执行共用同一套风控 / 写单 / 成交推进，不重复实现。
pub(crate) async fn submit_with_sig(
    app: &AppHandle,
    sig_id: &str,
) -> Result<protocol::BrokerOrderInfo, String> {
    let mgr = app.state::<BrokerManager>();
    if mgr.kill_switch.load(Ordering::SeqCst) {
        return Err("紧急停止已触发，已禁止新委托".to_string());
    }
    if !mgr.connected.load(Ordering::SeqCst) {
        return Err("券商通道未连接，请先连接".to_string());
    }
    let cfg = mgr.config.lock().unwrap().clone();
    let dir = app.state::<crate::ai::AiState>().dir();

    // 读取 confirmed 信号单
    let conn = maindb::open_readwrite(&dir)?;
    let ticket = conn
        .query_row(
            "SELECT code,name,side,price,vol,status FROM signal_ticket WHERE sig_id=?1",
            rusqlite::params![sig_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, String>(5)?,
                ))
            },
        )
        .map_err(|e| format!("读取信号单失败：{e}"))?;
    let (code, _name, side, price, vol, tstatus) = ticket;
    if tstatus != "confirmed" {
        return Err(format!("仅可发送已确认单据，当前状态：{tstatus}"));
    }

    // 风控
    let order = risk::RiskOrder { code: code.clone(), side: side.clone(), price, vol };
    let (account, market) = match cfg.kind.as_str() {
        "mock" => (mgr.mock.lock().unwrap().snapshot(), None),
        // qmt 账户快照由 sidecar 回报缓存；未同步则拒绝。
        _ => {
            return Err("QMT 账户数据尚未同步，请稍后重试（真实联调在后续步骤）".to_string());
        }
    };
    let params = risk::RiskParams::from_config(&cfg);
    let (weekday, min_of_day) = risk::beijing_now_weekday_min();
    let phase = risk::phase_of(weekday, min_of_day);
    let allow_anytime = cfg.kind == "mock" && cfg.mock_allow_anytime;
    risk::check(&order, &account, market, &params, phase, min_of_day, allow_anytime)?;

    // 写委托
    let account_id = cfg.account_id.clone();
    let kind = cfg.kind.clone();
    protocol::insert(&conn, sig_id, &kind, &account_id, &code, &side, price, vol)?;
    audit(
        &conn,
        sig_id,
        "broker_submitting",
        &format!("{kind} {side} {code} {vol}@{price}"),
        "broker",
    );
    checkpoint(&conn);
    let _ = app.emit("broker:event", serde_json::json!({ "sigId": sig_id, "status": "submitting" }));

    match kind.as_str() {
        "mock" => {
            // 异步模拟成交推进
            let app2 = app.clone();
            let dir2 = dir.clone();
            let code2 = code.clone();
            let side2 = side.clone();
            let sig_id2 = sig_id.to_string();
            tauri::async_runtime::spawn(async move {
                mock_run(&app2, &dir2, &sig_id2, &code2, &side2, price, vol).await;
            });
        }
        "qmt" => {
            let req = sidecar::request(
                &format!("submit-{sig_id}"),
                "submit",
                serde_json::json!({
                    "client_order_id": sig_id,
                    "code": with_suffix(&code),
                    "side": side,
                    "price": price,
                    "vol": vol,
                }),
            );
            let stdin = mgr.sidecar.lock().unwrap().as_ref().map(|h| h.stdin.clone());
            match stdin {
                Some(s) => sidecar::send_to(&s, req).await?,
                None => return Err("QMT sidecar 未运行".to_string()),
            }
        }
        _ => {}
    }

    protocol::get_by_sig(&conn, sig_id).ok_or_else(|| "委托创建后读取失败".to_string())
}

// ===== 条件单触发：落信号票；模拟盘可自动确认并提交，实盘仅落待确认 =====

/// 注册 co:triggered 监听（setup 阶段调用）。
pub fn register_co_listener(app: &AppHandle) {
    let h = app.clone();
    app.listen("co:triggered", move |event| {
        let app = h.clone();
        let ev: crate::market::alert::CoTriggerEvent =
            match serde_json::from_str(event.payload()) {
                Ok(e) => e,
                Err(e) => {
                    log::error!("co:triggered 载荷解析失败: {e}");
                    return;
                }
            };
        tauri::async_runtime::spawn(async move {
            let co_id = ev.co_id.clone();
            match handle_co_triggered(&app, ev).await {
                Ok(()) => {}
                Err(e) => {
                    log::warn!("条件单 {co_id} 落单处理失败: {e}");
                    let _ = app.emit(
                        "co:error",
                        serde_json::json!({ "coId": co_id, "error": e }),
                    );
                }
            }
        });
    });
}

/// 处理一次条件单触发。
async fn handle_co_triggered(
    app: &AppHandle,
    ev: crate::market::alert::CoTriggerEvent,
) -> Result<(), String> {
    let dir = app.state::<crate::ai::AiState>().dir();
    let conn = maindb::open_readwrite(&dir)?;

    // 1) 落信号票（create_ticket 内含同方向 pending 去重）
    let reason = format!("条件单 {} 触发：{}", ev.co_id, ev.matched.join("；"));
    let Some(sig_id) = crate::ai::bridge::create_ticket(
        &conn,
        crate::ai::bridge::SignalInput {
            code: ev.code.clone(),
            name: ev.name.clone(),
            side: ev.side.clone(),
            source: "conditional".to_string(),
            model_version: "conditional-engine".to_string(),
            strategy: format!("co:{}", ev.price_mode),
            confidence: 1.0,
            ref_price: ev.trigger_price,
            vol: ev.vol,
            reason,
            trade_date: crate::broker::conditional::today_dashed(),
        },
    ) else {
        return Err("已存在同方向待确认信号或触发价无效，未重复建票".to_string());
    };

    // 回填条件单 ticket_id
    crate::broker::conditional::set_ticket_id(&conn, &ev.co_id, &sig_id)?;
    let _ = app.emit(
        "signal:updated",
        serde_json::json!({ "sigId": sig_id, "status": "pending" }),
    );

    // 2) 仅模拟盘 + 自动确认 + 已连接 + 未急停才自动推进；其余只留 pending 由人工确认
    let mgr = app.state::<BrokerManager>();
    let cfg = mgr.config.lock().unwrap().clone();
    let auto = ev.auto_confirm
        && cfg.kind == "mock"
        && mgr.connected.load(Ordering::SeqCst)
        && !mgr.kill_switch.load(Ordering::SeqCst);
    if !auto {
        log::info!("条件单 {} 已落待确认票 {sig_id}，等待人工确认", ev.co_id);
        return Ok(());
    }

    // 委托价：limit 用限价（>0），trigger / market 用触发价
    let exec_price = match ev.price_mode.as_str() {
        "limit" if ev.limit_price > 0.0 => ev.limit_price,
        _ => ev.trigger_price,
    };
    let ticket_pk: i64 = conn
        .query_row(
            "SELECT id FROM signal_ticket WHERE sig_id=?1",
            rusqlite::params![sig_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("读取信号票主键失败: {e}"))?;
    crate::ai::bridge::confirm(
        &conn,
        ticket_pk,
        crate::ai::bridge::ConfirmOpts {
            price: Some(exec_price),
            vol: Some(ev.vol),
            action_kind: Some("mock".to_string()),
            broker: Some("模拟盘".to_string()),
            actor: Some("conditional-auto".to_string()),
            order_template: None,
        },
    )?;
    drop(conn); // 释放当前连接，submit_with_sig 自行打开，避免写锁相互等待

    // 3) 提交（内部再做状态检查 / 风控 / 写单 / mock 成交推进）
    submit_with_sig(app, &sig_id).await?;
    log::info!("条件单 {} 已自动确认并提交模拟盘，票号 {sig_id}", ev.co_id);
    Ok(())
}

/// mock 成交推进脚本：submitted → part_filled(half) → filled。
async fn mock_run(
    app: &AppHandle,
    dir: &Path,
    sig_id: &str,
    code: &str,
    side: &str,
    price: f64,
    vol: i64,
) {
    use tauri::Manager;
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    {
        let conn = match maindb::open_readwrite(dir) { Ok(c) => c, Err(_) => return };
        let bid = format!("MOCK{:07}", now_millis().rem_euclid(10_000_000));
        let _ = progress(&conn, app, sig_id, protocol::SUBMITTED, None, None, Some(&bid), None, "模拟已报");
    }
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    let half = (vol / 200) * 100; // 取整到手的半数
    let half = if half > 0 { half } else { vol };
    {
        app.state::<BrokerManager>().mock.lock().unwrap().apply_fill(code, side, price, half);
        let conn = match maindb::open_readwrite(dir) { Ok(c) => c, Err(_) => return };
        let _ = progress(&conn, app, sig_id, protocol::PART_FILLED, Some(half), Some(price), None, None,
            &format!("模拟部分成交 {half}"));
    }
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    let rest = vol - half;
    {
        if rest > 0 {
            app.state::<BrokerManager>().mock.lock().unwrap().apply_fill(code, side, price, rest);
        }
        let conn = match maindb::open_readwrite(dir) { Ok(c) => c, Err(_) => return };
        let _ = progress(&conn, app, sig_id, protocol::FILLED, Some(vol), Some(price), None, None,
            &format!("模拟全部成交 {vol}"));
        auto_done_ticket(&conn, app, sig_id);
    }
}

#[tauri::command]
pub async fn broker_cancel(
    app: AppHandle,
    ai: State<'_, crate::ai::AiState>,
    mgr: State<'_, BrokerManager>,
    sig_id: String,
) -> Result<(), String> {
    let cfg = mgr.config.lock().unwrap().clone();
    let dir = ai.dir();
    match cfg.kind.as_str() {
        "mock" => {
            let conn = maindb::open_readwrite(&dir)?;
            let _ = progress(&conn, &app, &sig_id, protocol::CANCELLED, None, None, None, None, "模拟撤单");
            Ok(())
        }
        "qmt" => {
            let req = sidecar::request(
                &format!("cancel-{sig_id}"),
                "cancel",
                serde_json::json!({ "client_order_id": sig_id }),
            );
            let stdin = mgr.sidecar.lock().unwrap().as_ref().map(|h| h.stdin.clone());
            match stdin {
                Some(s) => sidecar::send_to(&s, req).await,
                None => Err("QMT sidecar 未运行".to_string()),
            }
        }
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn broker_query_asset(mgr: State<'_, BrokerManager>) -> Result<serde_json::Value, String> {
    let cfg = mgr.config.lock().unwrap().clone();
    match cfg.kind.as_str() {
        "mock" => {
            let s = mgr.mock.lock().unwrap().snapshot();
            Ok(serde_json::json!({
                "cash": round2(s.cash),
                "marketValue": round2(s.market_value),
                "totalAsset": round2(s.total_asset()),
            }))
        }
        "qmt" => {
            // 优先返回 sidecar 最近一次 asset 回报缓存
            let cached = mgr.asset_cache.lock().unwrap().clone();
            if !cached.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                return Ok(cached);
            }
            // 缓存为空：向 sidecar 发一次 query_asset，前端下次轮询即可拿到回报
            let stdin = mgr.sidecar.lock().unwrap().as_ref().map(|h| h.stdin.clone());
            if let Some(s) = stdin {
                let req = sidecar::request("query-asset", "query_asset", serde_json::json!({}));
                if let Err(e) = sidecar::send_to(&s, req).await {
                    return Ok(serde_json::json!({ "note": format!("资产查询失败：{e}") }));
                }
                Ok(serde_json::json!({ "note": "正在向 QMT 查询资产…" }))
            } else {
                Ok(serde_json::json!({ "note": "QMT 未连接，暂无资产数据" }))
            }
        }
        _ => Ok(serde_json::json!({ "note": "暂不支持该券商的资产查询" })),
    }
}

#[tauri::command]
pub fn broker_query_position(mgr: State<'_, BrokerManager>) -> serde_json::Value {
    let cfg = mgr.config.lock().unwrap().clone();
    match cfg.kind.as_str() {
        "mock" => {
            let s = mgr.mock.lock().unwrap().snapshot();
            let arr: Vec<_> = s
                .positions
                .iter()
                .map(|(code, p)| serde_json::json!({
                    "code": code, "vol": p.vol, "avail": p.avail,
                }))
                .collect();
            serde_json::json!({ "positions": arr })
        }
        _ => serde_json::json!({ "note": "QMT 持仓由 sidecar 回报（第 2 步）" }),
    }
}

#[tauri::command]
pub async fn broker_kill_switch(
    app: AppHandle,
    mgr: State<'_, BrokerManager>,
    cancel_all: bool,
) -> Result<String, String> {
    mgr.kill_switch.store(true, Ordering::SeqCst);
    let (stdin, child) = {
        let opt = mgr.sidecar.lock().unwrap();
        match opt.as_ref() {
            Some(h) => (Some(h.stdin.clone()), Some(h.child.clone())),
            None => (None, None),
        }
    };
    if cancel_all {
        if let Some(s) = &stdin {
            let _ = sidecar::send_to(s, sidecar::request("kill", "kill", serde_json::json!({}))).await;
        }
    }
    if let Some(c) = child {
        let _ = c.lock().await.kill().await;
    }
    *mgr.sidecar.lock().unwrap() = None;
    mgr.connected.store(false, Ordering::SeqCst);
    let _ = app.emit("broker:kill", serde_json::json!({ "cancelAll": cancel_all }));
    log::error!("Kill Switch 已触发，券商通道断开");
    Ok(if cancel_all {
        "紧急停止：已断开（请在界面确认撤单）".to_string()
    } else {
        "紧急停止：通道已断开".to_string()
    })
}

#[tauri::command]
pub fn broker_release_kill(mgr: State<'_, BrokerManager>) -> Result<(), String> {
    mgr.kill_switch.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn mock_seed_position(
    mgr: State<'_, BrokerManager>,
    code: String,
    vol: i64,
    price: f64,
) -> Result<(), String> {
    mgr.mock.lock().unwrap().seed_position(&code, vol, price);
    Ok(())
}

#[tauri::command]
pub fn mock_reset(mgr: State<'_, BrokerManager>) -> Result<(), String> {
    let cash = mgr.config.lock().unwrap().mock_init_cash;
    mgr.mock.lock().unwrap().reset(cash);
    mgr.connected.store(false, Ordering::SeqCst);
    Ok(())
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffix_mapping() {
        assert_eq!(with_suffix("600519"), "600519.SH");
        assert_eq!(with_suffix("000001"), "000001.SZ");
        assert_eq!(with_suffix("300750"), "300750.SZ");
        assert_eq!(with_suffix("830799"), "830799.BJ");
    }
}
