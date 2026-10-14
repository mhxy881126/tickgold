// 券商对接编排：BrokerManager（配置 / 模拟账户 / sidecar / 紧急停止），Tauri 命令，
// 委托状态机推进、signal_audit 审计、事件广播。合规：只处理 confirmed 单、实盘默认关、风控前置。
pub mod conditional;
pub mod config;
pub mod portfolio;
pub mod protocol;
pub mod risk;
pub mod sidecar;

use crate::ai::{maindb, now_millis};
use crate::market;
use config::BrokerConfig;
use rusqlite::Connection;
use sidecar::SidecarHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Listener, Manager, State};

/// 券商对接共享句柄（manage）。
pub struct BrokerManager {
    pub config: Mutex<BrokerConfig>,
    pub sidecar: Mutex<Option<SidecarHandle>>,
    pub kill_switch: AtomicBool,
    pub connected: AtomicBool,
    // QMT sidecar 最近一次 asset 回报缓存（含 floatPnl/dayPnl 等扩展字段）
    pub asset_cache: Mutex<serde_json::Value>,
    /// 市场上下文缓存（情绪, 上证涨跌%, 刷新时刻），TTL 60s；autoexec 与仪表盘共用。
    pub market_ctx: Mutex<(f64, f64, std::time::Instant)>,
    /// QMT 持仓缓存（key=裸码）：全量回报替换、增量回报 upsert。
    pub position_cache: Mutex<std::collections::HashMap<String, risk::QmtPosition>>,
    /// 持仓是否已完成首次全量同步（空仓账户缓存亦为空，须以此区分"尚未同步"）。
    pub position_synced: AtomicBool,
}

impl BrokerManager {
    pub fn new() -> Self {
        let c = BrokerConfig::default();
        BrokerManager {
            config: Mutex::new(c),
            sidecar: Mutex::new(None),
            kill_switch: AtomicBool::new(false),
            connected: AtomicBool::new(false),
            asset_cache: Mutex::new(serde_json::json!({})),
            market_ctx: Mutex::new((
                50.0,
                0.0,
                std::time::Instant::now() - std::time::Duration::from_secs(120),
            )),
            position_cache: Mutex::new(std::collections::HashMap::new()),
            position_synced: AtomicBool::new(false),
        }
    }

    /// setup 阶段按数据目录加载持久化配置。
    pub fn init_with_dir(&self, dir: &Path) {
        let cfg = config::load(dir);
        *self.config.lock().unwrap() = cfg;
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
        conn,
        sig_id,
        status,
        filled_vol,
        avg_price,
        broker_order_id,
        error_msg,
    )?;
    audit(
        conn,
        sig_id,
        &format!("broker_{status}"),
        audit_detail,
        "broker",
    );
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
                // python connected 后不主动推全量：立即拉一次资产 + 持仓。
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(mgr) = app.try_state::<BrokerManager>() {
                        let stdin = mgr
                            .sidecar
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|h| h.stdin.clone());
                        if let Some(stdin) = stdin {
                            let _ = sidecar::send_to(
                                &stdin,
                                sidecar::request(
                                    "connected-query-asset",
                                    "query_asset",
                                    serde_json::json!({}),
                                ),
                            )
                            .await;
                            let _ = sidecar::send_to(
                                &stdin,
                                sidecar::request(
                                    "connected-query-position",
                                    "query_position",
                                    serde_json::json!({}),
                                ),
                            )
                            .await;
                        }
                    }
                });
            }
        }
        "disconnected" => {
            if let Some(m) = try_manager(app) {
                m.connected.store(false, Ordering::SeqCst);
                // 断开后缓存作废，重连由 connected 分支重新全量查询
                m.position_synced.store(false, Ordering::SeqCst);
                *m.asset_cache.lock().unwrap() = serde_json::json!({});
            }
        }
        "asset" => {
            // 缓存最近一次资产回报，broker_query_asset（QMT）直接读缓存
            if let Some(m) = try_manager(app) {
                *m.asset_cache.lock().unwrap() = v.clone();
            }
        }
        "position" => {
            // 全量回报替换缓存；单只增量 upsert（vol=0 移除）。
            if let Some(m) = try_manager(app) {
                let (items, full) = risk::parse_position_event(v);
                let mut cache = m.position_cache.lock().unwrap();
                if full {
                    cache.clear();
                    m.position_synced.store(true, Ordering::SeqCst);
                }
                for (code, p) in items {
                    if p.vol <= 0 {
                        cache.remove(&code);
                    } else {
                        cache.insert(code, p);
                    }
                }
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
                let _ = progress(
                    &conn,
                    app,
                    &sig_id,
                    protocol::ERROR,
                    None,
                    None,
                    None,
                    Some(msg),
                    msg,
                );
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
        audit(
            conn,
            sig_id,
            "auto_done",
            "券商成交满量，自动标记完成",
            "broker",
        );
        let _ = app.emit(
            "signal:updated",
            serde_json::json!({ "sigId": sig_id, "status": "done" }),
        );
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

#[allow(clippy::too_many_arguments)]
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
    // v3.0.0-rc 账户级风控阈值 / 实盘限额
    daily_loss_limit_pct: Option<f64>,
    max_drawdown_limit_pct: Option<f64>,
    consecutive_loss_limit: Option<i32>,
    live_max_order_amount: Option<f64>,
) -> Result<(), String> {
    let mut cfg = mgr.config.lock().unwrap().clone();
    if let Some(v) = kind {
        cfg.kind = v;
    }
    if let Some(v) = python_path {
        cfg.python_path = v;
    }
    if let Some(v) = qmt_path {
        cfg.qmt_path = v;
    }
    if let Some(v) = account_id {
        cfg.account_id = v;
    }
    if let Some(v) = max_single_pct {
        cfg.max_single_pct = v;
    }
    if let Some(v) = max_total_pct {
        cfg.max_total_pct = v;
    }
    if let Some(v) = no_open_after {
        cfg.no_open_after = v;
    }
    if let Some(v) = fee_pct {
        cfg.fee_pct = v;
    }
    if let Some(v) = mock_allow_anytime {
        cfg.mock_allow_anytime = v;
    }
    if let Some(v) = mock_init_cash {
        cfg.mock_init_cash = v;
    }
    if let Some(v) = daily_loss_limit_pct {
        cfg.daily_loss_limit_pct = v;
    }
    if let Some(v) = max_drawdown_limit_pct {
        cfg.max_drawdown_limit_pct = v;
    }
    if let Some(v) = consecutive_loss_limit {
        cfg.consecutive_loss_limit = v;
    }
    if let Some(v) = live_max_order_amount {
        cfg.live_max_order_amount = v;
    }
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
    let child = mgr
        .sidecar
        .lock()
        .unwrap()
        .as_ref()
        .map(|h| h.child.clone());
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

/// 前端模拟交易买入：ensure + settle → 统一闸门 gate → portfolio 落账（统一账本）。
#[tauri::command]
pub async fn portfolio_buy(
    ai: State<'_, crate::ai::AiState>,
    code: String,
    name: String,
    price: f64,
    vol: i64,
) -> Result<portfolio::FillResult, String> {
    let dir = ai.dir();
    let init_cash = init_cash_or_default(&dir)?;
    let cfg = config::load(&dir);
    let today = conditional::today_dashed();
    let mut conn = maindb::open_readwrite(&dir)?;
    portfolio::ensure_account(&conn, init_cash)?;
    portfolio::settle(&conn, &today)?;

    // 全通道唯一闸门（账户级 + 订单级）
    let order = risk::RiskOrder {
        code: code.clone(),
        side: "BUY".into(),
        price,
        vol,
    };
    let account = build_ledger_account(&conn).await?;
    let equity = account.total_asset();
    let ai_in = build_account_risk_input(&conn, equity, read_peak(&conn), &today);
    let market = market_snapshot_of(&code, &name).await;
    let (weekday, min_of_day) = risk::beijing_now_weekday_min();
    let phase = risk::phase_of(weekday, min_of_day);
    let allow_anytime = cfg.kind == "mock" && cfg.mock_allow_anytime;
    if let Err(reason) = risk::gate(
        &order,
        &account,
        market,
        &risk::RiskParams::from_config(&cfg),
        &ai_in,
        &risk::AccountRiskParams::from_config(&cfg),
        phase,
        min_of_day,
        allow_anytime,
    ) {
        log_gate_reject(&conn, "manual", &format!("manual:{code}"), &reason);
        return Err(reason);
    }

    let oid = format!("PO{}{}", now_millis(), code);
    let req = portfolio::FillReq {
        code: &code,
        name: &name,
        side: portfolio::Side::Buy,
        price,
        vol,
        sig_id: &oid,
        trade_date: &today,
        limit_prices: None,
    };
    portfolio::apply_fill(&mut conn, &req)
}

/// 前端模拟交易卖出。
#[tauri::command]
pub async fn portfolio_sell(
    ai: State<'_, crate::ai::AiState>,
    code: String,
    price: f64,
    vol: i64,
) -> Result<portfolio::FillResult, String> {
    let dir = ai.dir();
    let cfg = config::load(&dir);
    let today = conditional::today_dashed();
    let mut conn = maindb::open_readwrite(&dir)?;
    portfolio::settle(&conn, &today)?;

    // 闸门：SELL 跳过账户级熔断（保证止损离场），只做时段/价格/持仓校验
    let order = risk::RiskOrder {
        code: code.clone(),
        side: "SELL".into(),
        price,
        vol,
    };
    let account = build_ledger_account(&conn).await?;
    let market = market_snapshot_of(&code, "").await;
    let (weekday, min_of_day) = risk::beijing_now_weekday_min();
    let phase = risk::phase_of(weekday, min_of_day);
    let allow_anytime = cfg.kind == "mock" && cfg.mock_allow_anytime;
    let ai_in = risk::AccountRiskInput::default();
    if let Err(reason) = risk::gate(
        &order,
        &account,
        market,
        &risk::RiskParams::from_config(&cfg),
        &ai_in,
        &risk::AccountRiskParams::from_config(&cfg),
        phase,
        min_of_day,
        allow_anytime,
    ) {
        log_gate_reject(&conn, "manual", &format!("manual:{code}"), &reason);
        return Err(reason);
    }

    let oid = format!("PO{}{}", now_millis(), code);
    let req = portfolio::FillReq {
        code: &code,
        name: "",
        side: portfolio::Side::Sell,
        price,
        vol,
        sig_id: &oid,
        trade_date: &today,
        limit_prices: None,
    };
    portfolio::apply_fill(&mut conn, &req)
}

fn init_cash_or_default(dir: &Path) -> Result<f64, String> {
    // 初始资金以券商配置 mock_init_cash 为准（用户可自定义），兜底 100 万。
    let cash = config::load(dir).mock_init_cash;
    Ok(if cash > 0.0 { cash } else { 1_000_000.0 })
}

// ===== v3.0.0-rc 闸门共用 helper（手动/submit 同源构造，禁止各处复制）=====

/// 基于统一账本构造账户风控快照（持仓按实时价估值，无价按成本价）。
/// 同步收集后返回不持有 &Connection 的 future（否则 future 非 Send 无法 spawn）。
fn build_ledger_account(
    conn: &Connection,
) -> impl std::future::Future<Output = Result<risk::AccountSnapshot, String>> {
    let (cash, items): (f64, Vec<(String, i64, i64, f64)>) = {
        let positions = portfolio::load_positions(conn).unwrap_or_default();
        let cash: f64 = conn
            .query_row("SELECT cash FROM paper_account WHERE id=1", [], |r| {
                r.get(0)
            })
            .unwrap_or(0.0);
        let items = positions
            .iter()
            .map(|p| (p.code.clone(), p.vol, p.avail_vol, p.cost_amount))
            .collect();
        (cash, items)
    };
    async move {
        let codes: Vec<String> = items.iter().map(|(c, ..)| c.clone()).collect();
        let qs = market::get_quotes(codes).await.unwrap_or_default();
        let qmap: std::collections::HashMap<String, market::Quote> =
            qs.into_iter().map(|q| (q.code.clone(), q)).collect();
        let mut mv = 0.0;
        let mut map = std::collections::HashMap::new();
        for (code, vol, avail, cost_amount) in &items {
            let px = match qmap.get(code) {
                Some(q) if q.price > 0.0 => q.price,
                _ => *cost_amount / *vol as f64,
            };
            mv += px * *vol as f64;
            map.insert(
                code.clone(),
                risk::Position {
                    vol: *vol,
                    avail: *avail,
                },
            );
        }
        Ok(risk::AccountSnapshot {
            cash,
            market_value: mv,
            positions: map,
        })
    }
}

/// 读取历史最高权益（meta，无记录返回 None）。
pub(crate) fn read_peak(conn: &Connection) -> Option<f64> {
    conn.query_row(
        "SELECT value FROM meta WHERE key='risk_peak_equity'",
        [],
        |r| {
            let s: String = r.get(0)?;
            s.parse::<f64>()
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
        },
    )
    .ok()
}

/// 构造账户级闸门输入（日亏/连亏读统一账本，峰值取 meta）。
pub(crate) fn build_account_risk_input(
    conn: &Connection,
    equity: f64,
    peak: Option<f64>,
    today: &str,
) -> risk::AccountRiskInput {
    let base: f64 = conn
        .query_row("SELECT init_cash FROM paper_account WHERE id=1", [], |r| {
            r.get(0)
        })
        .unwrap_or(0.0);
    let day_pnl = portfolio::realized_pnl_of_day(conn, today).unwrap_or(0.0);
    let recent = portfolio::recent_realized(conn, 10).unwrap_or_default();
    risk::AccountRiskInput {
        day_realized_pnl: day_pnl,
        base_equity: base,
        equity,
        peak_equity: peak.filter(|v| *v >= equity).unwrap_or(equity),
        recent_realized: recent,
    }
}

/// 取单只标的实时报价构造涨跌停快照（失败返回 None，跳过涨跌停校验）。
async fn market_snapshot_of(code: &str, name: &str) -> Option<risk::MarketSnapshot> {
    let qs = market::get_quotes(vec![code.to_string()])
        .await
        .unwrap_or_default();
    qs.into_iter().next().map(|q| {
        let (up, dn) = market::spider::limit_prices(code, name, q.prev_close);
        risk::MarketSnapshot {
            limit_up: Some(up),
            limit_down: Some(dn),
        }
    })
}

/// 闸门拒绝即写审计（action=risk_rejected），再由调用方上抛错误。
fn log_gate_reject(conn: &Connection, channel: &str, sig: &str, reason: &str) {
    audit(conn, sig, "risk_rejected", reason, channel);
}

/// 风险仪表盘读数：一本账口径，权益 / 仓位 / 集中度 / 当日盈亏 / 回撤 / 板块 / 情绪，峰值落 meta。
#[tauri::command]
pub async fn risk_snapshot(
    ai: State<'_, crate::ai::AiState>,
    mgr: State<'_, BrokerManager>,
) -> Result<portfolio::RiskSnapshot, String> {
    let dir = ai.dir();
    let cfg = config::load(&dir);
    let today = conditional::today_dashed();

    // 市场上下文：读 60s TTL 缓存，过期才刷新（刷新 await 时不持有任何 guard / conn）。
    let fresh = mgr.market_ctx.lock().unwrap().2.elapsed() <= std::time::Duration::from_secs(60);
    if !fresh {
        let c = crate::ai::intraday::refresh_market_ctx().await;
        *mgr.market_ctx.lock().unwrap() =
            (c.market_emotion, c.index_chg, std::time::Instant::now());
    }
    let (market_emotion, index_chg) = {
        let cached = mgr.market_ctx.lock().unwrap();
        (cached.0, cached.1)
    };

    let init_cash = init_cash_or_default(&dir)?;
    let conn = maindb::open_readwrite(&dir)?;
    portfolio::ensure_account(&conn, init_cash)?;
    portfolio::settle(&conn, &today)?;
    let positions = portfolio::load_positions(&conn)?;
    let codes: Vec<String> = positions.iter().map(|p| p.code.clone()).collect();
    let qs = market::get_quotes(codes).await.unwrap_or_default();
    let price_of: Vec<(String, f64, f64)> = qs
        .iter()
        .map(|q| (q.code.clone(), q.price, q.prev_close))
        .collect();

    // 历史最高权益（累计 / 日内）持久化在 meta；无记录以 None 传入（峰值=当前权益）。
    let peak = read_peak(&conn);
    let day_peak = read_day_peak(&conn, &today);
    let extras = portfolio::RiskExtras {
        today: today.clone(),
        kill_switch: mgr.kill_switch.load(Ordering::SeqCst),
        market_emotion,
        index_chg,
        day_peak,
        limits: risk::AccountRiskParams::from_config(&cfg),
        max_total_limit: cfg.max_total_pct,
        max_single_limit: cfg.max_single_pct,
    };
    let snap = portfolio::build_risk_snapshot(&conn, &price_of, peak, &extras)?;
    // 累计峰值创新高则写回。
    if peak.map(|v| snap.equity > v).unwrap_or(true) {
        conn.execute(
            "INSERT INTO meta(key,value) VALUES('risk_peak_equity',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![format!("{:.4}", snap.equity)],
        )
        .map_err(|e| format!("写入权益峰值失败: {e}"))?;
    }
    // 日内峰值创新高则写回（key 带日期，无迁移、跨日自然另起）。
    if day_peak.map(|v| snap.equity > v).unwrap_or(true) {
        conn.execute(
            "INSERT INTO meta(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![day_peak_key(&today), format!("{:.4}", snap.equity)],
        )
        .map_err(|e| format!("写入日内峰值失败: {e}"))?;
    }
    Ok(snap)
}

/// 日内峰值 meta key。
fn day_peak_key(today: &str) -> String {
    format!("risk_peak_equity_{today}")
}

/// 读取日内权益峰值（meta key risk_peak_equity_<date>）。
fn read_day_peak(conn: &Connection, today: &str) -> Option<f64> {
    conn.query_row(
        "SELECT value FROM meta WHERE key=?1",
        rusqlite::params![day_peak_key(today)],
        |r| {
            let s: String = r.get(0)?;
            s.parse::<f64>()
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
        },
    )
    .ok()
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

    // 风控：账户快照统一读 portfolio 账本（共用 helper）；行情快照取实时报价构造涨跌停价。
    let order = risk::RiskOrder {
        code: code.clone(),
        side: side.clone(),
        price,
        vol,
    };
    let (account, market) = match cfg.kind.as_str() {
        "mock" => {
            let account = build_ledger_account(&conn).await?;
            // 委托标的的涨跌停行情快照（昨收取实时报价）。
            let mk = market_snapshot_of(&code, &_name).await;
            (account, mk)
        }
        "qmt" => {
            // 实盘第一级：必须由用户在设置中显式开启实盘开关。
            if !cfg.live_enabled {
                return Err("实盘交易未启用：请先在券商设置中开启实盘开关".to_string());
            }
            // 账户快照取 sidecar 最近一次回报缓存；guard 在任何 await 前 drop（future 须 Send）。
            let (cash, market_value, pos_cache, pos_synced) = {
                let asset = mgr.asset_cache.lock().unwrap().clone();
                let cash = asset["cash"].as_f64();
                let market_value = asset["marketValue"].as_f64();
                let pos_cache = mgr.position_cache.lock().unwrap().clone();
                (
                    cash,
                    market_value,
                    pos_cache,
                    mgr.position_synced.load(Ordering::SeqCst),
                )
            };
            let (Some(cash), Some(market_value)) = (cash, market_value) else {
                return Err("QMT 资产数据尚未同步，请连接通道后稍后重试".to_string());
            };
            if !pos_synced {
                // 全量回报（哪怕空仓账户的空数组）到达前一律拒绝，保持安全。
                return Err("QMT 持仓数据尚未同步，请连接通道后稍后重试".to_string());
            }
            let positions = pos_cache
                .iter()
                .map(|(k, p)| {
                    (
                        k.clone(),
                        risk::Position {
                            vol: p.vol,
                            avail: p.avail,
                        },
                    )
                })
                .collect();
            let account = risk::AccountSnapshot {
                cash,
                market_value,
                positions,
            };
            let mk = market_snapshot_of(&code, &_name).await;
            (account, mk)
        }
        other => return Err(format!("暂不支持的券商通道：{other}")),
    };
    let params = risk::RiskParams::from_config(&cfg);
    let account_params = risk::AccountRiskParams::from_config(&cfg);
    let equity = account.total_asset();
    let ai_in = build_account_risk_input(
        &conn,
        equity,
        read_peak(&conn),
        &conditional::today_dashed(),
    );
    let (weekday, min_of_day) = risk::beijing_now_weekday_min();
    let phase = risk::phase_of(weekday, min_of_day);
    let allow_anytime = cfg.kind == "mock" && cfg.mock_allow_anytime;
    if let Err(reason) = risk::gate(
        &order,
        &account,
        market,
        &params,
        &ai_in,
        &account_params,
        phase,
        min_of_day,
        allow_anytime,
    ) {
        log_gate_reject(&conn, &cfg.kind, sig_id, &reason);
        return Err(reason);
    }

    // 实盘第一级最小限额：默认 0 = 锁定，须用户显式设置；单笔金额超限拒绝。
    if cfg.kind == "qmt" {
        if cfg.live_max_order_amount <= 0.0 {
            let reason = "实盘已锁定：请先在券商设置中设置单笔金额上限".to_string();
            log_gate_reject(&conn, &cfg.kind, sig_id, &reason);
            return Err(reason);
        }
        let amount = price * vol as f64;
        if amount > cfg.live_max_order_amount {
            let reason = format!(
                "单笔金额 {amount:.0} 元超过实盘上限 {:.0} 元",
                cfg.live_max_order_amount
            );
            log_gate_reject(&conn, &cfg.kind, sig_id, &reason);
            return Err(reason);
        }
    }

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
    let _ = app.emit(
        "broker:event",
        serde_json::json!({ "sigId": sig_id, "status": "submitting" }),
    );

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
            let stdin = mgr
                .sidecar
                .lock()
                .unwrap()
                .as_ref()
                .map(|h| h.stdin.clone());
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
        let ev: crate::market::alert::CoTriggerEvent = match serde_json::from_str(event.payload()) {
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
                    let _ = app.emit("co:error", serde_json::json!({ "coId": co_id, "error": e }));
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
/// 急停（kill_switch）或单据已被撤销时立即停止，不得再推进成交/落账。
async fn mock_run(
    app: &AppHandle,
    dir: &Path,
    sig_id: &str,
    code: &str,
    side: &str,
    price: f64,
    vol: i64,
) {
    let halted = || {
        let mgr = app.state::<BrokerManager>();
        mgr.kill_switch.load(Ordering::SeqCst)
    };
    let cancelled = |dir: &Path| {
        let conn = match maindb::open_readwrite(dir) {
            Ok(c) => c,
            Err(_) => return false,
        };
        matches!(
            conn.query_row(
                "SELECT status FROM broker_order WHERE sig_id=?1",
                rusqlite::params![sig_id],
                |r| r.get::<_, String>(0),
            )
            .as_deref(),
            Ok(protocol::CANCELLED)
        )
    };
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    if halted() || cancelled(dir) {
        return;
    }
    {
        let conn = match maindb::open_readwrite(dir) {
            Ok(c) => c,
            Err(_) => return,
        };
        let bid = format!("MOCK{:07}", now_millis().rem_euclid(10_000_000));
        let _ = progress(
            &conn,
            app,
            sig_id,
            protocol::SUBMITTED,
            None,
            None,
            Some(&bid),
            None,
            "模拟已报",
        );
    }
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    if halted() || cancelled(dir) {
        return;
    }
    let half = (vol / 200) * 100; // 取整到手的半数
    let half = if half > 0 { half } else { vol };
    {
        // 部分成交落统一账本（事务写 paper_account/position/order）
        let mut conn = match maindb::open_readwrite(dir) {
            Ok(c) => c,
            Err(_) => return,
        };
        let fside = portfolio::Side::parse(side).unwrap_or(portfolio::Side::Buy);
        let req = portfolio::FillReq {
            code,
            name: "",
            side: fside,
            price,
            vol: half,
            sig_id: &format!("{sig_id}-p1"),
            trade_date: &conditional::today_dashed(),
            limit_prices: None,
        };
        if let Err(e) = portfolio::apply_fill(&mut conn, &req) {
            log::warn!("模拟部分成交落账失败：{e}");
            return;
        }
        let _ = progress(
            &conn,
            app,
            sig_id,
            protocol::PART_FILLED,
            Some(half),
            Some(price),
            None,
            None,
            &format!("模拟部分成交 {half}"),
        );
    }
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    if halted() || cancelled(dir) {
        return;
    }
    let rest = vol - half;
    {
        let mut conn = match maindb::open_readwrite(dir) {
            Ok(c) => c,
            Err(_) => return,
        };
        if rest > 0 {
            let fside = portfolio::Side::parse(side).unwrap_or(portfolio::Side::Buy);
            let req = portfolio::FillReq {
                code,
                name: "",
                side: fside,
                price,
                vol: rest,
                sig_id: &format!("{sig_id}-p2"),
                trade_date: &conditional::today_dashed(),
                limit_prices: None,
            };
            if let Err(e) = portfolio::apply_fill(&mut conn, &req) {
                log::warn!("模拟剩余成交落账失败：{e}");
                return;
            }
        }
        let _ = progress(
            &conn,
            app,
            sig_id,
            protocol::FILLED,
            Some(vol),
            Some(price),
            None,
            None,
            &format!("模拟全部成交 {vol}"),
        );
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
            let _ = progress(
                &conn,
                &app,
                &sig_id,
                protocol::CANCELLED,
                None,
                None,
                None,
                None,
                "模拟撤单",
            );
            Ok(())
        }
        "qmt" => {
            let req = sidecar::request(
                &format!("cancel-{sig_id}"),
                "cancel",
                serde_json::json!({ "client_order_id": sig_id }),
            );
            let stdin = mgr
                .sidecar
                .lock()
                .unwrap()
                .as_ref()
                .map(|h| h.stdin.clone());
            match stdin {
                Some(s) => sidecar::send_to(&s, req).await,
                None => Err("QMT sidecar 未运行".to_string()),
            }
        }
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn broker_query_asset(
    ai: State<'_, crate::ai::AiState>,
    mgr: State<'_, BrokerManager>,
) -> Result<serde_json::Value, String> {
    let cfg = mgr.config.lock().unwrap().clone();
    let dir = ai.dir();
    match cfg.kind.as_str() {
        "mock" => {
            let conn = maindb::open_readwrite(&dir)?;
            let positions = portfolio::load_positions(&conn)?;
            let codes: Vec<String> = positions.iter().map(|p| p.code.clone()).collect();
            let qs = market::get_quotes(codes).await.unwrap_or_default();
            let price_of: Vec<(String, f64, f64)> = qs
                .iter()
                .map(|q| (q.code.clone(), q.price, q.prev_close))
                .collect();
            let s = portfolio::build_snapshot(&conn, &price_of)?;
            Ok(serde_json::json!({
                "cash": round2(s.cash),
                "marketValue": round2(s.market_value),
                "totalAsset": round2(s.total_assets),
                "floatPnl": round2(s.float_pnl),
                "dayPnl": round2(s.day_pnl),
            }))
        }
        "qmt" => {
            // 优先返回 sidecar 最近一次 asset 回报缓存
            let cached = mgr.asset_cache.lock().unwrap().clone();
            if !cached.as_object().map(|o| o.is_empty()).unwrap_or(true) {
                return Ok(cached);
            }
            // 缓存为空：向 sidecar 发一次 query_asset，前端下次轮询即可拿到回报
            let stdin = mgr
                .sidecar
                .lock()
                .unwrap()
                .as_ref()
                .map(|h| h.stdin.clone());
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
pub async fn broker_query_position(
    ai: State<'_, crate::ai::AiState>,
    mgr: State<'_, BrokerManager>,
) -> Result<serde_json::Value, String> {
    let cfg = mgr.config.lock().unwrap().clone();
    match cfg.kind.as_str() {
        "mock" => {
            let conn = maindb::open_readonly(&ai.dir())?;
            let positions = portfolio::load_positions(&conn)?;
            let arr: Vec<_> = positions
                .iter()
                .map(|p| {
                    serde_json::json!({
                        "code": p.code, "name": p.name,
                        "vol": p.vol, "avail": p.avail_vol,
                    })
                })
                .collect();
            Ok(serde_json::json!({ "positions": arr }))
        }
        "qmt" => {
            if !mgr.position_synced.load(Ordering::SeqCst) {
                // 未同步：主动向 sidecar 查询，前端下次轮询即可拿到回报
                let stdin = mgr
                    .sidecar
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|h| h.stdin.clone());
                if let Some(s) = stdin {
                    let req =
                        sidecar::request("query-position", "query_position", serde_json::json!({}));
                    let _ = sidecar::send_to(&s, req).await;
                }
                return Ok(serde_json::json!({ "note": "正在向 QMT 查询持仓…" }));
            }
            let cache = mgr.position_cache.lock().unwrap();
            let arr: Vec<_> = cache
                .iter()
                .map(|(code, p)| {
                    serde_json::json!({
                        "code": code, "name": "",
                        "vol": p.vol, "avail": p.avail,
                        "cost": p.cost, "marketValue": p.mv,
                    })
                })
                .collect();
            Ok(serde_json::json!({ "positions": arr }))
        }
        other => Ok(serde_json::json!({ "note": format!("暂不支持该券商的持仓查询：{other}") })),
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
            let _ =
                sidecar::send_to(s, sidecar::request("kill", "kill", serde_json::json!({}))).await;
        }
    }
    if let Some(c) = child {
        let _ = c.lock().await.kill().await;
    }
    *mgr.sidecar.lock().unwrap() = None;
    mgr.connected.store(false, Ordering::SeqCst);
    let _ = app.emit(
        "broker:kill",
        serde_json::json!({ "cancelAll": cancel_all }),
    );
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

/// 一键急停（全局唯一实现）：封新委托 → 停自动执行 → 撤全部条件单 → 撤全部在途委托 → 断 sidecar。
/// 恢复为纯手动：解除 kill → 手动重连 → 手动重启自动执行。
pub async fn emergency_halt(app: &AppHandle) -> Result<serde_json::Value, String> {
    let mgr = app.state::<BrokerManager>();
    // 1) 最先封死新委托。
    mgr.kill_switch.store(true, Ordering::SeqCst);

    // 2) 停止自动执行器（running=false 且配置 enabled=false，防止误触启动循环）。
    if let Some(ctl) = app.try_state::<std::sync::Arc<crate::ai::autoexec::AutoExecCtl>>() {
        ctl.running.store(false, Ordering::SeqCst);
        if let Ok(mut cfg) = ctl.config.lock() {
            cfg.enabled = false;
        }
    }

    let dir = app.state::<crate::ai::AiState>().dir();

    // 3)+4) 同步收集：撤条件单数量、在途委托列表；随后 drop 连接再做异步撤单（保证 future Send）。
    let (co_count, in_flight): (i64, Vec<(String, String)>) = {
        let conn = maindb::open_readwrite(&dir)?;
        let co_count = conditional::cancel_all(&conn).unwrap_or(0);
        // 在途：已报/部分成交；含刚提交未回报的 submitting。
        let mut in_flight: Vec<(String, String)> = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT sig_id, broker_kind FROM broker_order
             WHERE status IN ('submitting','submitted','part_filled')",
        ) {
            if let Ok(rows) =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            {
                in_flight = rows.flatten().collect();
            }
        }
        (co_count, in_flight)
    };

    let order_count = in_flight.len() as i64;
    // QMT：逐笔发撤单（sidecar 稍后统一断开）。先取出 stdin 并释放锁，避免 guard 跨 await。
    let qmt_stdin: Option<_> = mgr
        .sidecar
        .lock()
        .unwrap()
        .as_ref()
        .map(|h| h.stdin.clone());
    if let Some(stdin) = &qmt_stdin {
        for (sig_id, broker) in &in_flight {
            if broker == "qmt" {
                let req = sidecar::request(
                    &format!("halt-cancel-{sig_id}"),
                    "cancel",
                    serde_json::json!({ "client_order_id": sig_id }),
                );
                let _ = sidecar::send_to(stdin, req).await;
            }
        }
    }

    // 本地统一标记撤单（mock 直接生效；QMT sidecar 最终状态回报可覆盖）。
    {
        let conn = maindb::open_readwrite(&dir)?;
        for (sig_id, _broker) in &in_flight {
            let _ = progress(
                &conn,
                app,
                sig_id,
                protocol::CANCELLED,
                None,
                None,
                None,
                Some("紧急停止撤单"),
                "紧急停止：撤全部在途委托",
            );
        }
        audit(
            &conn,
            "EMERGENCY_HALT",
            "emergency_halt",
            &format!("急停：撤条件单 {co_count} 笔、在途委托 {order_count} 笔"),
            "user",
        );
        checkpoint(&conn);
    }

    // 5) 断开 sidecar（先发 kill 兜底，再杀进程）。
    let (stdin, child) = {
        let opt = mgr.sidecar.lock().unwrap();
        match opt.as_ref() {
            Some(h) => (Some(h.stdin.clone()), Some(h.child.clone())),
            None => (None, None),
        }
    };
    if let Some(s) = &stdin {
        let _ = sidecar::send_to(
            s,
            sidecar::request("halt-kill", "kill", serde_json::json!({})),
        )
        .await;
    }
    if let Some(c) = child {
        let _ = c.lock().await.kill().await;
    }
    *mgr.sidecar.lock().unwrap() = None;
    mgr.connected.store(false, Ordering::SeqCst);

    let payload = serde_json::json!({ "coCount": co_count, "orderCount": order_count });
    let _ = app.emit("broker:kill", serde_json::json!({ "cancelAll": true }));
    let _ = app.emit("risk:halted", &payload);
    log::error!("一键急停已触发：撤条件单 {co_count}、在途委托 {order_count}，交易通道全锁定");
    Ok(payload)
}

#[tauri::command]
pub async fn broker_emergency_halt(app: AppHandle) -> Result<serde_json::Value, String> {
    emergency_halt(&app).await
}

#[tauri::command]
pub async fn mock_seed_position(
    ai: State<'_, crate::ai::AiState>,
    mgr: State<'_, BrokerManager>,
    code: String,
    vol: i64,
    price: f64,
) -> Result<(), String> {
    let _ = mgr;
    // 注入"昨日及以前"持仓到统一账本；名称取实时报价，无报价用代码占位。
    let name = market::get_quotes(vec![code.clone()])
        .await
        .ok()
        .and_then(|qs| qs.into_iter().find(|q| q.code == code).map(|q| q.name))
        .unwrap_or_default();
    let mut conn = maindb::open_readwrite(&ai.dir())?;
    portfolio::seed_position(&mut conn, &code, &name, vol, price)
}

#[tauri::command]
pub fn mock_reset(
    ai: State<'_, crate::ai::AiState>,
    mgr: State<'_, BrokerManager>,
) -> Result<(), String> {
    let cash = mgr.config.lock().unwrap().mock_init_cash;
    let conn = maindb::open_readwrite(&ai.dir())?;
    portfolio::reset_to(&conn, cash)?;
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
