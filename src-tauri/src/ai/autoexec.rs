// 自动执行器：盘中 5s 循环，对盯盘对象走「信号 → 风控闸门 → 模拟盘撮合 → 决策日志」闭环。
// 模拟盘全自动；实盘只 emit 信号到灵动岛 / 决策条由人工确认，不接券商。硬止损绕过快脑强制执行。
use crate::ai::bridge;
use crate::ai::fastbrain::{self, FastDecision, RULE_MODEL_VERSION};
use crate::ai::intraday::{self, IntradayInput, MarketCtx};
use crate::ai::maindb;
use crate::market::spider;
use crate::market::{self, Quote};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// 自动执行参数（前端可改）。
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutoExecConfig {
    pub enabled: bool,
    pub brain_mode: String, // rule / laya
    pub laya_url: String,
    pub hard_stop_pct: f64,    // -7
    pub exec_confidence: f64,  // 0.75
    pub watch_confidence: f64, // 0.55
    pub slippage_pct: f64,     // 0.1
    pub max_single_pct: f64,   // 单票占总资产上限
    pub max_total_pct: f64,    // 总仓位上限
    pub no_open_after: String, // 14:55 后禁开仓
    // ===== 新增风控 =====
    pub daily_loss_limit_pct: f64, // 单日亏损限制（%），今天亏了超过就停止交易
    pub max_drawdown_limit_pct: f64, // 最大回撤限制（%），从最高点跌了超过就清仓
    pub consecutive_loss_limit: i32, // 连续亏损暂停（笔数），连亏X笔就暂停
    // ===== 全自动模式 =====
    pub full_auto_mode: bool, // 全自动模式：所有信号都直接下单，不用人工确认
    // ===== 交易模式（新）=====
    pub trade_mode: String, // semi（半自动）/ full（全自动）/ manual（人工确认）
    // ===== 信号桥 =====
    pub bridge_enabled: bool,          // 信号人工确认桥开关（不自动下单）
    pub bridge_default_broker: String, // 目标券商软件名
    pub bridge_broker_path: String,    // 券商可执行/应用路径（空=不唤起）
    pub bridge_default_action: String, // 默认动作 copy/export/hotkey
    pub bridge_ttl_minutes: i64,       // 待确认信号有效期（分钟）
    pub bridge_price_deviate_pct: f64, // 参考价偏离提示阈值（%）
    pub bridge_order_template: String, // 自定义下单指令模板（空=内置默认）
    pub indicators_enabled: std::collections::HashMap<String, bool>, // 规则脑指标开关
    /// RuleBrain 因子权重覆盖；默认空=内置权重。只允许由 tuning_proposal 人工批准写入，
    /// 回测/寻优本身不得直接改此字段（v2.30 进化回灌护栏）。
    #[serde(default)]
    pub weight_overrides: std::collections::HashMap<String, f64>,
}

impl Default for AutoExecConfig {
    fn default() -> Self {
        AutoExecConfig {
            enabled: false,
            brain_mode: "rule".to_string(),
            laya_url: "http://127.0.0.1:8788".to_string(),
            hard_stop_pct: -7.0,
            exec_confidence: 0.75,
            watch_confidence: 0.55,
            slippage_pct: 0.1,
            max_single_pct: 20.0,
            max_total_pct: 80.0,
            no_open_after: "14:55".to_string(),
            // ===== 新增风控默认值 =====
            daily_loss_limit_pct: 5.0,    // 单日亏 5% 就停止
            max_drawdown_limit_pct: 20.0, // 最大回撤 20% 就清仓
            consecutive_loss_limit: 3,    // 连亏 3 笔就暂停
            // ===== 全自动模式默认值 =====
            full_auto_mode: false, // 默认关闭全自动模式
            // ===== 交易模式默认值 =====
            trade_mode: "semi".to_string(), // 默认半自动模式
            // ===== 信号桥 =====
            bridge_enabled: false,
            bridge_default_broker: "同花顺".to_string(),
            bridge_broker_path: String::new(),
            bridge_default_action: "copy".to_string(),
            bridge_ttl_minutes: 30,
            bridge_price_deviate_pct: 1.5,
            bridge_order_template: String::new(),
            indicators_enabled: default_indicators(),
            weight_overrides: std::collections::HashMap::new(),
        }
    }
}

/// 规则脑 12 个指标默认全启用。
fn default_indicators() -> std::collections::HashMap<String, bool> {
    let m: std::collections::HashMap<String, bool> = [
        ("pct", true),
        ("speed5m", true),
        ("volumeRatio", true),
        ("turnover", true),
        ("distToLimit", true),
        ("pullback", true),
        ("blastCount", true),
        ("marketEmotion", true),
        ("indexChg", true),
        ("themeRank", true),
        ("catalystFreshness", true),
        ("mainNetInflowYi", true),
        ("macdHist", true),
        ("rsi14", true),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), *v))
    .collect();
    m
}

/// 共享控制句柄（manage）。
pub struct AutoExecCtl {
    pub running: AtomicBool,
    pub config: Mutex<AutoExecConfig>,
}

impl AutoExecCtl {
    pub fn new() -> Arc<Self> {
        Arc::new(AutoExecCtl {
            running: AtomicBool::new(false),
            config: Mutex::new(AutoExecConfig::default()),
        })
    }
}

/// 盯盘对象。
struct WatchItem {
    code: String,
    name: String,
    strategy: String,
    instr_id: Option<i64>,
    position_hint_pct: f64,
}

#[derive(Clone, Copy)]
struct PosInfo {
    vol: i64,
    avail: i64,
    cost_amount: f64,
}

// ===== 时间（北京时间，无 chrono）=====

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 12 { y } else { y + 1 };
    (y as i32, m as u32, d as u32)
}

fn beijing_now() -> (String, String) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        + 8 * 3600;
    let (y, m, d) = civil_from_days((secs / 86400) as i64);
    let tod = secs % 86400;
    let (h, mi, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    (
        format!("{y}-{:02}-{:02}", m, d),
        format!("{:02}:{:02}:{:02}", h, mi, s),
    )
}

fn today_dashed() -> String {
    beijing_now().0
}
fn now_hms() -> String {
    beijing_now().1
}

// 费用统一走 broker::portfolio::calc_fee（全应用唯一口径，禁止再本地复制一份）。
// v3.0.0-rc：账户级/订单级风控统一走 broker::risk 闸门，禁止本地再实现日亏/连亏判断。
use crate::broker::config as broker_config;
use crate::broker::portfolio::{self, Side};
use crate::broker::risk;

fn parse_hint(s: &str) -> f64 {
    let mut num = String::new();
    let mut found = false;
    for c in s.chars() {
        if c.is_ascii_digit() || (c == '.' && found) {
            num.push(c);
            found = true;
        } else if found {
            break;
        }
    }
    num.parse().unwrap_or(10.0)
}

/// 收集盯盘对象：open 指令 + 持仓。
fn collect_watch(conn: &Connection) -> Vec<WatchItem> {
    let mut map: HashMap<String, WatchItem> = HashMap::new();

    if let Ok(mut stmt) = conn.prepare(
        "SELECT i.id,i.code,i.name,i.position_hint,p.profile_key
         FROM plan_instruction i JOIN plan p ON i.plan_id=p.id
         WHERE i.status='open'",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3).unwrap_or_default(),
                r.get::<_, String>(4).unwrap_or_default(),
            ))
        }) {
            for row in rows.flatten() {
                let (id, code, name, hint, prof) = row;
                map.entry(code.clone()).or_insert(WatchItem {
                    code,
                    name,
                    strategy: prof,
                    instr_id: Some(id),
                    position_hint_pct: parse_hint(&hint),
                });
            }
        }
    }

    if let Ok(mut stmt) = conn.prepare("SELECT code,name FROM paper_position WHERE vol>0") {
        if let Ok(rows) =
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        {
            for row in rows.flatten() {
                let (code, name) = row;
                map.entry(code.clone()).or_insert(WatchItem {
                    code,
                    name,
                    strategy: "持仓".to_string(),
                    instr_id: None,
                    position_hint_pct: 0.0,
                });
            }
        }
    }

    map.into_values().collect()
}

fn load_positions(conn: &Connection) -> HashMap<String, PosInfo> {
    let mut m = HashMap::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT code,vol,avail_vol,cost_amount FROM paper_position WHERE vol>0")
    {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                PosInfo {
                    vol: r.get(1)?,
                    avail: r.get(2)?,
                    cost_amount: r.get(3)?,
                },
            ))
        }) {
            for row in rows.flatten() {
                m.insert(row.0, row.1);
            }
        }
    }
    m
}

fn load_cash(conn: &Connection) -> f64 {
    conn.query_row("SELECT cash FROM paper_account WHERE id=1", [], |r| {
        r.get(0)
    })
    .unwrap_or(1_000_000.0)
}

fn positions_mv(positions: &HashMap<String, PosInfo>, qmap: &HashMap<String, Quote>) -> f64 {
    let mut mv = 0.0;
    for (code, p) in positions {
        if let Some(q) = qmap.get(code) {
            mv += q.price * p.vol as f64;
        }
    }
    mv
}

// ===== 价格历史（算 5 分钟涨速）=====

type PriceHist = HashMap<String, Vec<(Instant, f64)>>;

fn push_price(hist: &mut PriceHist, code: &str, price: f64) {
    let v = hist.entry(code.to_string()).or_default();
    v.push((Instant::now(), price));
    let cutoff = Instant::now() - Duration::from_secs(360);
    v.retain(|(t, _)| *t >= cutoff);
}

fn price_5m_ago(hist: &PriceHist, code: &str) -> Option<f64> {
    let v = hist.get(code)?;
    let now = Instant::now();
    let mut best: Option<(f64, f64)> = None;
    for (t, p) in v {
        let age = now.duration_since(*t).as_secs_f64();
        if age >= 240.0 {
            let d = (age - 300.0).abs();
            if best.map(|(bd, _)| d < bd).unwrap_or(true) {
                best = Some((d, *p));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// 灵动岛推送防抖：每标的 60s 最多 2 次。
fn can_fire(history: &mut HashMap<String, Vec<Instant>>, code: &str) -> bool {
    let now = Instant::now();
    let v = history.entry(code.to_string()).or_default();
    v.retain(|t| now.duration_since(*t).as_secs() < 60);
    if v.len() >= 2 {
        false
    } else {
        v.push(now);
        true
    }
}

/// 14:55 前才允许开仓。
fn can_open_now(cfg: &AutoExecConfig) -> bool {
    // 模拟盘全自动：休市/夜间也允许按最近收盘价继续模拟开仓
    if cfg.trade_mode == "full" {
        return true;
    }
    let (_, h, m) = spider::beijing();
    let cur = h * 60 + m;
    let parts: Vec<u32> = cfg
        .no_open_after
        .split(':')
        .map(|x| x.parse().unwrap_or(0))
        .collect();
    let limit = parts.first().copied().unwrap_or(14) * 60 + parts.get(1).copied().unwrap_or(55);
    cur < limit
}

// ===== 模拟盘撮合 =====

#[allow(clippy::too_many_arguments)]
fn paper_buy(
    conn: &mut Connection,
    item: &WatchItem,
    q: &Quote,
    cfg: &AutoExecConfig,
    bcfg: &broker_config::BrokerConfig,
    total_asset: f64,
    cash: f64,
    total_pos_pct: f64,
) -> Result<String, String> {
    let fill = (q.price * (1.0 + cfg.slippage_pct / 100.0)).max(0.001);
    // 语句级去重：前端轨可能已先买入同票（共用一个 sqlite），重查持仓收窄竞态。
    let held: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(vol),0) FROM paper_position WHERE code=?1",
            [&item.code],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    if held > 0.0 {
        return Err(format!("已持仓 {}，跳过重复开仓", item.code));
    }
    // 仓位上限事实源为 BrokerConfig（全通道唯一），AutoExecConfig 旧字段不再作依据。
    let target_pct = item
        .position_hint_pct
        .min(bcfg.max_single_pct)
        .min((bcfg.max_total_pct - total_pos_pct).max(0.0));
    if target_pct <= 0.0 {
        return Err(format!("仓位上限已满（总仓{:.0}%）", total_pos_pct));
    }
    let target_amount = total_asset * target_pct / 100.0;
    let fee_of = |vol: i64| {
        let a = fill * vol as f64;
        (a, portfolio::calc_fee(Side::Buy, a))
    };
    let mut lots = (target_amount / (fill * 100.0)).floor() as i64;
    let (mut amount, mut fee) = fee_of(lots * 100);
    while lots > 0 && amount + fee > cash {
        lots -= 1;
        let (a, f) = fee_of(lots * 100);
        amount = a;
        fee = f;
    }
    let vol = lots * 100;
    if vol < 100 {
        return Err(format!(
            "资金不足缩量至0（目标{:.1}% 现金{:.0} 价{:.2}）",
            target_pct, cash, fill
        ));
    }
    // 订单级统一闸门（时段由 can_open_now 负责，此处 allow_anytime=true 不重复拦截；
    // 市场涨跌停缺省跳过，与自动撮合既有口径一致）。
    let order = risk::RiskOrder {
        code: item.code.clone(),
        side: "BUY".into(),
        price: fill,
        vol,
    };
    let account = risk::AccountSnapshot {
        cash,
        market_value: (total_asset - cash).max(0.0),
        positions: std::collections::HashMap::new(),
    };
    risk::check(
        &order,
        &account,
        None,
        &risk::RiskParams::from_config(bcfg),
        risk::Phase::Morning,
        0,
        true,
    )?;
    // 落账统一走 portfolio（事务内写 账户/持仓/成交，费用/T+1 同口径）
    let oid = format!("AI{}{}", now_millis(), item.code);
    let req = portfolio::FillReq {
        code: &item.code,
        name: &item.name,
        side: Side::Buy,
        price: fill,
        vol,
        sig_id: &oid,
        trade_date: &today_dashed(),
        limit_prices: None,
    };
    portfolio::apply_fill(conn, &req)?;
    Ok(format!(
        "买入 {} {}股 @{:.2}（含费{:.1}）",
        item.name, vol, fill, fee
    ))
}

#[allow(clippy::too_many_arguments)]
fn paper_sell(
    conn: &mut Connection,
    code: &str,
    name: &str,
    q: &Quote,
    cfg: &AutoExecConfig,
    bcfg: &broker_config::BrokerConfig,
    pos: PosInfo,
    sell_vol: i64,
    // 硬止损传 None（跳过跌停拦截，保证离场永不锁死）；快脑卖出传实时涨跌停。
    market: Option<risk::MarketSnapshot>,
) -> Result<String, String> {
    let fill = (q.price * (1.0 - cfg.slippage_pct / 100.0)).max(0.001);
    let vol = sell_vol.min(pos.avail).min(pos.vol);
    if vol <= 0 {
        return Err("无可卖（T+1，当日买入不可卖）".to_string());
    }
    // 订单级闸门：SELL 只做价格/可用持仓/涨跌停校验，账户级熔断永不拦卖出。
    let order = risk::RiskOrder {
        code: code.to_string(),
        side: "SELL".into(),
        price: fill,
        vol,
    };
    let mut positions = std::collections::HashMap::new();
    positions.insert(
        code.to_string(),
        risk::Position {
            vol: pos.vol,
            avail: pos.avail,
        },
    );
    let account = risk::AccountSnapshot {
        cash: 0.0,
        market_value: 0.0,
        positions,
    };
    risk::check(
        &order,
        &account,
        market,
        &risk::RiskParams::from_config(bcfg),
        risk::Phase::Afternoon,
        0,
        true,
    )?;
    let amount = fill * vol as f64;
    let fee = portfolio::calc_fee(Side::Sell, amount);
    // 落账统一走 portfolio（含已实现盈亏 realized_pnl 记录）
    let oid = format!("AI{}{}", now_millis(), code);
    let req = portfolio::FillReq {
        code,
        name,
        side: Side::Sell,
        price: fill,
        vol,
        sig_id: &oid,
        trade_date: &today_dashed(),
        limit_prices: None,
    };
    portfolio::apply_fill(conn, &req)?;
    Ok(format!("卖出 {name} {vol}股 @{:.2}（费{:.1}）", fill, fee))
}

/// 写决策日志。
#[allow(clippy::too_many_arguments)]
fn log_decision(
    conn: &Connection,
    item: &WatchItem,
    d: &FastDecision,
    action: &str,
    features: &Value,
    hard_stop: bool,
) {
    let mut features = features.clone();
    if hard_stop {
        features["hardStop"] = json!(true);
    }
    let _ = conn.execute(
        "INSERT INTO decision_log
           (trade_date,ts,code,name,strategy,instr_id,label,confidence,probs,features,
            mode,action,model_version,infer_ms,created_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        rusqlite::params![
            today_dashed(),
            now_hms(),
            item.code,
            item.name,
            item.strategy,
            item.instr_id,
            d.label,
            d.confidence,
            d.probs.to_string(),
            features.to_string(),
            d.mode,
            action,
            d.model_version,
            d.infer_ms,
            now_millis()
        ],
    );
}

fn emit_signal(
    app: &AppHandle,
    data_dir: &std::path::Path,
    item: &WatchItem,
    d: &FastDecision,
    action: &str,
    message: &str,
    features: &Value,
) {
    // v2.31：实时信号挂「同型历史命中率」。只读聚合，失败安全降级为缺省（前端标灰）。
    let quality = crate::ai::signal_quality::lookup(
        data_dir,
        &crate::ai::signal_quality::QualityQuery {
            strategy: item.strategy.clone(),
            session: crate::ai::signal_quality::session_of(&now_hms()).to_string(),
            theme: String::new(),
            factors: None,
            side: if d.label == "SELL" {
                "sell".to_string()
            } else {
                "buy".to_string()
            },
        },
    )
    .ok();
    let payload = json!({
        "code": item.code, "name": item.name, "label": d.label,
        "confidence": d.confidence, "action": action, "message": message,
        "mode": d.mode, "ts": now_hms(),
        "quality": quality,
        "factorContributions": d.factor_contributions,
        "features": features,
    });
    let _ = app.emit("fastbrain-signal", payload);
}

/// 信号桥：创建待人工确认票并推送灵动岛（已去重；bridge 关闭则跳过）。
fn bridge_push(
    app: &AppHandle,
    conn: &Connection,
    cfg: &AutoExecConfig,
    input: bridge::SignalInput,
) {
    if !cfg.bridge_enabled {
        return;
    }
    let code = input.code.clone();
    let name = input.name.clone();
    let side = input.side.clone();
    let source = input.source.clone();
    let price = input.ref_price;
    let vol = input.vol;
    if let Some(sid) = bridge::create_ticket(conn, input) {
        let _ = app.emit(
            "signal:new",
            json!({
                "sigId": sid, "code": code, "name": name,
                "side": side, "source": source, "price": price, "vol": vol,
            }),
        );
    }
}

/// 登记内置规则模型版本。
fn ensure_rule_model(conn: &Connection) {
    let exists = conn
        .query_row(
            "SELECT COUNT(*) FROM model_version WHERE kind='fast' AND version=?1",
            rusqlite::params![RULE_MODEL_VERSION],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false);
    if !exists {
        let _ = conn.execute(
            "INSERT INTO model_version(kind,version,provider,active,note,created_at)
             VALUES('fast',?1,'tickgold',1,'内置规则多因子快脑',?2)",
            rusqlite::params![RULE_MODEL_VERSION, now_millis()],
        );
    }
}

/// 主循环。
pub async fn run_loop(app: AppHandle, ctl: Arc<AutoExecCtl>, data_dir: std::path::PathBuf) {
    let mut hist: PriceHist = HashMap::new();
    let mut fire_hist: HashMap<String, Vec<Instant>> = HashMap::new();
    let mut ctx = MarketCtx::default();
    let mut last_ctx = Instant::now() - Duration::from_secs(60);
    let _last_review_date = String::new(); // 上次复盘的日期

    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if !ctl.running.load(Ordering::Acquire) {
            continue;
        }
        let cfg = ctl.config.lock().unwrap().clone();
        if !cfg.enabled {
            continue;
        }
        // 账户级/订单级阈值唯一事实源：BrokerConfig（broker_config.json）。
        let bcfg = broker_config::load(&data_dir);

        // ===== 自动复盘：每天收盘后（15:30 之后）自动运行一次（暂时注释，先确保编译通过）=====
        // let today = today_dashed();
        // let (_, h, m) = spider::beijing();
        // let now_minutes = h * 60 + m;
        // let close_time = 15 * 60 + 30; // 15:30

        // if now_minutes >= close_time && last_review_date != today {
        //     log::info!("开始自动复盘...");
        //     // TODO: 调用 run_review，参数待确认
        //     last_review_date = today;
        // }

        // 模拟盘全自动（full）允许休市/夜间按最近收盘价继续模拟；
        // semi/manual 保持旧行为：休市不循环、不产信号。
        if cfg.trade_mode != "full" && !spider::is_trading_time() {
            continue;
        }

        if last_ctx.elapsed() > Duration::from_secs(45) {
            ctx = intraday::refresh_market_ctx().await;
            last_ctx = Instant::now();
            // 写入 BrokerManager 共享缓存（与风险仪表盘同一事实源，TTL 60s）。
            if let Some(mgr) = app.try_state::<crate::broker::BrokerManager>() {
                *mgr.market_ctx.lock().unwrap() =
                    (ctx.market_emotion, ctx.index_chg, Instant::now());
            }
        }

        // 读：盯盘对象 / 持仓 / 现金
        let (watch, positions, cash) = {
            let conn = match maindb::open_readwrite(&data_dir) {
                Ok(c) => c,
                Err(e) => {
                    log::error!("{e}");
                    continue;
                }
            };
            let w = collect_watch(&conn);
            let p = load_positions(&conn);
            let c = load_cash(&conn);
            (w, p, c)
        };
        if watch.is_empty() {
            continue;
        }

        let codes: Vec<String> = watch.iter().map(|w| w.code.clone()).collect();
        let quotes = match market::get_quotes(codes).await {
            Ok(q) => q,
            Err(e) => {
                log::error!("快脑行情失败: {e}");
                continue;
            }
        };
        let qmap: HashMap<String, Quote> =
            quotes.into_iter().map(|q| (q.code.clone(), q)).collect();
        for (c, q) in &qmap {
            push_price(&mut hist, c, q.price);
        }

        let total_asset = cash + positions_mv(&positions, &qmap);
        let total_pos_pct = if total_asset > 0.0 {
            positions_mv(&positions, &qmap) / total_asset * 100.0
        } else {
            0.0
        };

        // 写：撮合 + 日志
        let mut conn = match maindb::open_readwrite(&data_dir) {
            Ok(c) => c,
            Err(_) => continue,
        };
        ensure_rule_model(&conn);

        // 账户级闸门每轮只算一次（日亏/回撤/连亏），BUY 定 vol 之前先行判定。
        let today = today_dashed();
        let ai_in = crate::broker::build_account_risk_input(
            &conn,
            total_asset,
            crate::broker::read_peak(&conn),
            &today,
        );
        let account_params = risk::AccountRiskParams::from_config(&bcfg);
        let risk_ok = risk::check_account(&ai_in, &account_params).is_ok();

        for item in &watch {
            let Some(q) = qmap.get(&item.code) else {
                continue;
            };
            let pos = positions.get(&item.code).copied();
            let holding_pct = pos
                .map(|p| q.price * p.vol as f64 / total_asset * 100.0)
                .unwrap_or(0.0);

            // 硬止损（持仓，绕过快脑）
            if let Some(p) = pos {
                let cost_px = p.cost_amount / p.vol as f64;
                let stop_px = cost_px * (1.0 + cfg.hard_stop_pct / 100.0);
                if q.price <= stop_px || q.pct <= cfg.hard_stop_pct {
                    let features = intraday::assemble_features(&IntradayInput {
                        code: item.code.clone(),
                        quote: q,
                        prev_price_5m: price_5m_ago(&hist, &item.code),
                        holding_pct,
                        ctx: &ctx,
                    });
                    let d = FastDecision {
                        label: "SELL".to_string(),
                        confidence: 1.0,
                        probs: json!({"SELL":1.0}),
                        mode: "rule".to_string(),
                        model_version: format!("hardstop{}", cfg.hard_stop_pct),
                        infer_ms: 0.0,
                        factor_contributions: Value::Null,
                    };
                    match paper_sell(
                        &mut conn, &item.code, &item.name, q, &cfg, &bcfg, p, p.vol, None,
                    ) {
                        Ok(msg) => {
                            log_decision(&conn, item, &d, "executed", &features, true);
                            emit_signal(&app, &data_dir, item, &d, "executed", &msg, &features);
                            bridge_push(
                                &app,
                                &conn,
                                &cfg,
                                bridge::SignalInput {
                                    code: item.code.clone(),
                                    name: item.name.clone(),
                                    side: "SELL".to_string(),
                                    source: "hardstop".to_string(),
                                    model_version: d.model_version.clone(),
                                    strategy: item.strategy.clone(),
                                    confidence: d.confidence,
                                    ref_price: q.price,
                                    vol: p.vol,
                                    reason: format!("硬止损：{msg}"),
                                    trade_date: today_dashed(),
                                },
                            );
                        }
                        Err(e) => {
                            log_decision(&conn, item, &d, "watch", &features, true);
                            if can_fire(&mut fire_hist, &item.code) {
                                emit_signal(
                                    &app,
                                    &data_dir,
                                    item,
                                    &d,
                                    "watch",
                                    &format!("硬止损命中但{e}，请人工处理"),
                                    &features,
                                );
                            }
                        }
                    }
                    continue;
                }
            }

            let side = if pos.is_some() { "sell" } else { "buy" };
            let mut features = intraday::assemble_features(&IntradayInput {
                code: item.code.clone(),
                quote: q,
                prev_price_5m: price_5m_ago(&hist, &item.code),
                holding_pct,
                ctx: &ctx,
            });
            // 拉日K线算深度技术指标（失败给中性值）；口径统一走 intraday::daily_deep_features。
            if let Ok(kbars) = market::get_kline(item.code.clone(), 101, 60).await {
                let opens: Vec<f64> = kbars.iter().map(|k| k.open).collect();
                let closes: Vec<f64> = kbars.iter().map(|k| k.close).collect();
                let highs: Vec<f64> = kbars.iter().map(|k| k.high).collect();
                let lows: Vec<f64> = kbars.iter().map(|k| k.low).collect();
                let volumes: Vec<f64> = kbars.iter().map(|k| k.volume).collect();
                let deep = intraday::daily_deep_features(&opens, &closes, &highs, &lows, &volumes);
                if let (Some(f), Some(obj)) = (features.as_object_mut(), deep.as_object()) {
                    for (k, v) in obj {
                        f.insert(k.clone(), v.clone());
                    }
                }
            }
            let pack = json!({"side":side,"features":features,"code":item.code,"name":item.name});
            // 读取云端 LLM 配置（如果 brain_mode=cloud_llm）
            let cloud = if cfg.brain_mode == "cloud_llm" {
                let aidb = crate::ai::vectordb::open(&data_dir.join("ai.db")).ok();
                aidb.as_ref().and_then(|db| {
                    let ai_cfg = crate::ai::config::load_config(&db.0).ok()?;
                    let key =
                        crate::ai::config::SecretStore::get(&crate::ai::config::KeyringSecret {
                            service: "tickgold.ai.cloud-key".to_string(),
                            user: "default".to_string(),
                        })
                        .ok()
                        .flatten()?;
                    Some((ai_cfg.base_url, key, ai_cfg.chat_model))
                })
            } else {
                None
            };
            let d = fastbrain::fast_decide(
                pack,
                &cfg.brain_mode,
                &cfg.laya_url,
                cloud,
                Some(&cfg.indicators_enabled),
                Some(&cfg.weight_overrides),
            )
            .await;

            match d.label.as_str() {
                "BUY" if pos.is_none() => {
                    // risk_ok 为本轮统一计算的账户级闸门结果（日亏/回撤/连亏）。

                    // 根据交易模式决定行为
                    let should_auto_buy = match cfg.trade_mode.as_str() {
                        "full" => {
                            d.confidence >= cfg.watch_confidence && can_open_now(&cfg) && risk_ok
                        }
                        "semi" => {
                            d.confidence >= cfg.exec_confidence && can_open_now(&cfg) && risk_ok
                        }
                        "manual" => false, // 人工确认模式：不自动下单
                        _ => d.confidence >= cfg.exec_confidence && can_open_now(&cfg) && risk_ok,
                    };

                    if should_auto_buy {
                        match paper_buy(
                            &mut conn,
                            item,
                            q,
                            &cfg,
                            &bcfg,
                            total_asset,
                            cash,
                            total_pos_pct,
                        ) {
                            Ok(msg) => {
                                log_decision(&conn, item, &d, "executed", &features, false);
                                emit_signal(&app, &data_dir, item, &d, "executed", &msg, &features);
                                let budget = total_asset * bcfg.max_single_pct / 100.0;
                                bridge_push(
                                    &app,
                                    &conn,
                                    &cfg,
                                    bridge::SignalInput {
                                        code: item.code.clone(),
                                        name: item.name.clone(),
                                        side: "BUY".to_string(),
                                        source: "fastbrain".to_string(),
                                        model_version: d.model_version.clone(),
                                        strategy: item.strategy.clone(),
                                        confidence: d.confidence,
                                        ref_price: q.price,
                                        vol: bridge::suggest_buy_vol(q.price, budget),
                                        reason: format!("快脑买入：{msg}"),
                                        trade_date: today_dashed(),
                                    },
                                );
                            }
                            Err(reason) => {
                                log_decision(&conn, item, &d, "drop", &features, false);
                                if can_fire(&mut fire_hist, &item.code) {
                                    emit_signal(
                                        &app,
                                        &data_dir,
                                        item,
                                        &d,
                                        "watch",
                                        &format!("快脑买入但{reason}"),
                                        &features,
                                    );
                                }
                            }
                        }
                    } else if d.confidence >= cfg.watch_confidence
                        && can_fire(&mut fire_hist, &item.code)
                    {
                        // 根据交易模式决定行为
                        let should_auto_buy = match cfg.trade_mode.as_str() {
                            "full" => can_open_now(&cfg) && risk_ok,
                            _ => false, // semi 和 manual 模式：中置信度不自动下单
                        };

                        if should_auto_buy {
                            match paper_buy(
                                &mut conn,
                                item,
                                q,
                                &cfg,
                                &bcfg,
                                total_asset,
                                cash,
                                total_pos_pct,
                            ) {
                                Ok(msg) => {
                                    log_decision(&conn, item, &d, "executed", &features, false);
                                    emit_signal(
                                        &app, &data_dir, item, &d, "executed", &msg, &features,
                                    );
                                }
                                Err(reason) => {
                                    log_decision(&conn, item, &d, "drop", &features, false);
                                    emit_signal(
                                        &app,
                                        &data_dir,
                                        item,
                                        &d,
                                        "watch",
                                        &format!("全自动买入但{reason}"),
                                        &features,
                                    );
                                }
                            }
                        } else {
                            // 半自动/人工确认模式：只发信号到确认桥
                            log_decision(&conn, item, &d, "watch", &features, false);
                            emit_signal(
                                &app,
                                &data_dir,
                                item,
                                &d,
                                "watch",
                                "快脑买入观察信号，请人工确认",
                                &features,
                            );
                            let budget = total_asset * bcfg.max_single_pct / 100.0;
                            bridge_push(
                                &app,
                                &conn,
                                &cfg,
                                bridge::SignalInput {
                                    code: item.code.clone(),
                                    name: item.name.clone(),
                                    side: "BUY".to_string(),
                                    source: "fastbrain".to_string(),
                                    model_version: d.model_version.clone(),
                                    strategy: item.strategy.clone(),
                                    confidence: d.confidence,
                                    ref_price: q.price,
                                    vol: bridge::suggest_buy_vol(q.price, budget),
                                    reason: "快脑买入观察信号".to_string(),
                                    trade_date: today_dashed(),
                                },
                            );
                        }
                    }
                }
                "SELL" if pos.is_some() => {
                    if let Some(p) = pos {
                        // 快脑卖出传实时涨跌停；跌停价卖出会被拦并提示人工处理。
                        let (lup, ldn) = spider::limit_prices(&item.code, &item.name, q.prev_close);
                        let mk = risk::MarketSnapshot {
                            limit_up: Some(lup),
                            limit_down: Some(ldn),
                        };
                        match paper_sell(
                            &mut conn,
                            &item.code,
                            &item.name,
                            q,
                            &cfg,
                            &bcfg,
                            p,
                            p.vol,
                            Some(mk),
                        ) {
                            Ok(msg) => {
                                log_decision(&conn, item, &d, "executed", &features, false);
                                emit_signal(&app, &data_dir, item, &d, "executed", &msg, &features);
                                bridge_push(
                                    &app,
                                    &conn,
                                    &cfg,
                                    bridge::SignalInput {
                                        code: item.code.clone(),
                                        name: item.name.clone(),
                                        side: "SELL".to_string(),
                                        source: "fastbrain".to_string(),
                                        model_version: d.model_version.clone(),
                                        strategy: item.strategy.clone(),
                                        confidence: d.confidence,
                                        ref_price: q.price,
                                        vol: p.vol,
                                        reason: format!("快脑卖出：{msg}"),
                                        trade_date: today_dashed(),
                                    },
                                );
                            }
                            Err(e) => {
                                log_decision(&conn, item, &d, "watch", &features, false);
                                if can_fire(&mut fire_hist, &item.code) {
                                    emit_signal(
                                        &app,
                                        &data_dir,
                                        item,
                                        &d,
                                        "watch",
                                        &format!("快脑卖出但{e}，请人工确认"),
                                        &features,
                                    );
                                }
                            }
                        }
                    }
                }
                _ => {} // HOLD / NO_BUY 不写日志（避免每 5s 大量噪音）
            }
        }
    }
}
