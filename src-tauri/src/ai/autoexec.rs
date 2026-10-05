// 自动执行器：盘中 5s 循环，对盯盘对象走「信号 → 风控闸门 → 模拟盘撮合 → 决策日志」闭环。
// 模拟盘全自动；实盘只 emit 信号到灵动岛 / 决策条由人工确认，不接券商。硬止损绕过快脑强制执行。
use crate::ai::fastbrain::{self, FastDecision, RULE_MODEL_VERSION};
use crate::ai::intraday::{self, IntradayInput, MarketCtx};
use crate::ai::bridge;
use crate::ai::maindb;
use crate::market::spider;
use crate::market::{self, Quote};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

/// 自动执行参数（前端可改）。
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutoExecConfig {
    pub enabled: bool,
    pub brain_mode: String,   // rule / laya
    pub laya_url: String,
    pub hard_stop_pct: f64,   // -7
    pub exec_confidence: f64, // 0.75
    pub watch_confidence: f64,// 0.55
    pub slippage_pct: f64,    // 0.1
    pub max_single_pct: f64,  // 单票占总资产上限
    pub max_total_pct: f64,   // 总仓位上限
    pub no_open_after: String,// 14:55 后禁开仓
    pub bridge_enabled: bool,         // 信号人工确认桥开关（不自动下单）
    pub bridge_default_broker: String,// 目标券商软件名
    pub bridge_broker_path: String,   // 券商可执行/应用路径（空=不唤起）
    pub bridge_default_action: String,// 默认动作 copy/export/hotkey
    pub bridge_ttl_minutes: i64,      // 待确认信号有效期（分钟）
    pub bridge_price_deviate_pct: f64,// 参考价偏离提示阈值（%）
    pub bridge_order_template: String,  // 自定义下单指令模板（空=内置默认）
    pub indicators_enabled: std::collections::HashMap<String, bool>,  // 规则脑指标开关
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
            bridge_enabled: false,
            bridge_default_broker: "同花顺".to_string(),
            bridge_broker_path: String::new(),
            bridge_default_action: "copy".to_string(),
            bridge_ttl_minutes: 30,
            bridge_price_deviate_pct: 1.5,
            bridge_order_template: String::new(),
            indicators_enabled: default_indicators(),
        }
    }
}

/// 规则脑 12 个指标默认全启用。
fn default_indicators() -> std::collections::HashMap<String, bool> {
    let m: std::collections::HashMap<String, bool> = [
        ("pct", true), ("speed5m", true), ("volumeRatio", true), ("turnover", true),
        ("distToLimit", true), ("pullback", true), ("blastCount", true), ("marketEmotion", true),
        ("indexChg", true), ("themeRank", true), ("catalystFreshness", true), ("mainNetInflowYi", true),
        ("macdHist", true), ("rsi14", true),
    ].iter().map(|(k, v)| (k.to_string(), *v)).collect();
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

// ===== 费用（与 src/stores/paper.ts 严格一致）=====

fn calc_fee(side: &str, amount: f64) -> f64 {
    let commission = (amount * 0.00025).max(5.0);
    let stamp = if side == "sell" { amount * 0.0005 } else { 0.0 };
    let transfer = amount * 0.00001;
    commission + stamp + transfer
}

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
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }) {
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
    conn.query_row("SELECT cash FROM paper_account WHERE id=1", [], |r| r.get(0))
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

fn paper_buy(
    conn: &Connection,
    item: &WatchItem,
    q: &Quote,
    cfg: &AutoExecConfig,
    total_asset: f64,
    cash: f64,
    total_pos_pct: f64,
) -> Result<String, String> {
    let fill = (q.price * (1.0 + cfg.slippage_pct / 100.0)).max(0.001);
    let target_pct = item
        .position_hint_pct
        .min(cfg.max_single_pct)
        .min((cfg.max_total_pct - total_pos_pct).max(0.0));
    if target_pct <= 0.0 {
        return Err(format!("仓位上限已满（总仓{:.0}%）", total_pos_pct));
    }
    let target_amount = total_asset * target_pct / 100.0;
    let fee_of = |vol: i64| {
        let a = fill * vol as f64;
        (a, calc_fee("buy", a))
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
    let total = amount + fee;
    let now = now_millis();
    let oid = format!("AI{now}{}", item.code);
    conn.execute(
        "UPDATE paper_account SET cash=cash-?1 WHERE id=1",
        rusqlite::params![total],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO paper_position(code,name,vol,avail_vol,cost_amount,updated_at)
         VALUES(?1,?2,?3,0,?4,?5)
         ON CONFLICT(code) DO UPDATE SET
           name=excluded.name, vol=vol+excluded.vol,
           cost_amount=cost_amount+excluded.cost_amount, updated_at=excluded.updated_at",
        rusqlite::params![item.code, item.name, vol, total, now],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO paper_order(id,code,name,side,price,vol,amount,fee,status,created_at,trade_date)
         VALUES(?1,?2,?3,'buy',?4,?5,?6,?7,'filled',?8,?9)",
        rusqlite::params![oid, item.code, item.name, fill, vol, amount, fee, now, today_dashed()],
    )
    .map_err(|e| e.to_string())?;
    Ok(format!("买入 {} {}股 @{:.2}（含费{:.1}）", item.name, vol, fill, fee))
}

#[allow(clippy::too_many_arguments)]
fn paper_sell(
    conn: &Connection,
    code: &str,
    name: &str,
    q: &Quote,
    cfg: &AutoExecConfig,
    pos: PosInfo,
    sell_vol: i64,
) -> Result<String, String> {
    let fill = (q.price * (1.0 - cfg.slippage_pct / 100.0)).max(0.001);
    let vol = sell_vol.min(pos.avail).min(pos.vol);
    if vol <= 0 {
        return Err("无可卖（T+1，当日买入不可卖）".to_string());
    }
    let amount = fill * vol as f64;
    let fee = calc_fee("sell", amount);
    let proceeds = amount - fee;
    let new_vol = pos.vol - vol;
    let new_avail = (pos.avail - vol).max(0);
    let cost_reduce = pos.cost_amount * (vol as f64 / pos.vol as f64);
    let now = now_millis();

    if new_vol <= 0 {
        conn.execute("DELETE FROM paper_position WHERE code=?1", rusqlite::params![code])
            .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "UPDATE paper_position SET vol=?1,avail_vol=?2,cost_amount=cost_amount-?3,updated_at=?4 WHERE code=?5",
            rusqlite::params![new_vol, new_avail, cost_reduce, now, code],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "UPDATE paper_account SET cash=cash+?1 WHERE id=1",
        rusqlite::params![proceeds],
    )
    .map_err(|e| e.to_string())?;
    let oid = format!("AI{now}{code}");
    conn.execute(
        "INSERT INTO paper_order(id,code,name,side,price,vol,amount,fee,status,created_at,trade_date)
         VALUES(?1,?2,?3,'sell',?4,?5,?6,?7,'filled',?8,?9)",
        rusqlite::params![oid, code, name, fill, vol, amount, fee, now, today_dashed()],
    )
    .map_err(|e| e.to_string())?;
    Ok(format!("卖出 {} {}股 @{:.2}（费{:.1}）", name, vol, fill, fee))
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

fn emit_signal(app: &AppHandle, item: &WatchItem, d: &FastDecision, action: &str, message: &str) {
    let payload = json!({
        "code": item.code, "name": item.name, "label": d.label,
        "confidence": d.confidence, "action": action, "message": message,
        "mode": d.mode, "ts": now_hms(),
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

    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if !ctl.running.load(Ordering::Acquire) {
            continue;
        }
        let cfg = ctl.config.lock().unwrap().clone();
        if !cfg.enabled {
            continue;
        }
        if !spider::is_trading_time() {
            continue;
        }

        if last_ctx.elapsed() > Duration::from_secs(45) {
            ctx = intraday::refresh_market_ctx().await;
            last_ctx = Instant::now();
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
        let qmap: HashMap<String, Quote> = quotes.into_iter().map(|q| (q.code.clone(), q)).collect();
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
        let conn = match maindb::open_readwrite(&data_dir) {
            Ok(c) => c,
            Err(_) => continue,
        };
        ensure_rule_model(&conn);

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
                    };
                    match paper_sell(&conn, &item.code, &item.name, q, &cfg, p, p.vol) {
                        Ok(msg) => {
                            log_decision(&conn, item, &d, "executed", &features, true);
                            emit_signal(&app, item, &d, "executed", &msg);
                            bridge_push(&app, &conn, &cfg, bridge::SignalInput {
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
                            });
                        }
                        Err(e) => {
                            log_decision(&conn, item, &d, "watch", &features, true);
                            if can_fire(&mut fire_hist, &item.code) {
                                emit_signal(&app, item, &d, "watch", &format!("硬止损命中但{e}，请人工处理"));
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
            // 拉日K线算 MACD/RSI（失败给中性值）
            if let Ok(kbars) = market::get_kline(item.code.clone(), 101, 60).await {
                let closes: Vec<f64> = kbars.iter().map(|k| k.close).collect();
                let (dif, dea, macd_hist) = intraday::calc_macd(&closes);
                let rsi = intraday::calc_rsi(&closes, 14);
                if let Some(f) = features.as_object_mut() {
                    f.insert("macdDif".into(), json!(dif));
                    f.insert("macdDea".into(), json!(dea));
                    f.insert("macdHist".into(), json!(macd_hist));
                    f.insert("rsi14".into(), json!(rsi));
                }
            }
            let pack = json!({"side":side,"features":features,"code":item.code,"name":item.name});
            // 读取云端 LLM 配置（如果 brain_mode=cloud_llm）
            let cloud = if cfg.brain_mode == "cloud_llm" {
                let aidb = crate::ai::vectordb::open(&data_dir.join("ai.db")).ok();
                aidb.as_ref().and_then(|db| {
                    let ai_cfg = crate::ai::config::load_config(&db.0).ok()?;
                    let key = crate::ai::config::SecretStore::get(&crate::ai::config::KeyringSecret {
                        service: "tickgold.ai.cloud-key".to_string(),
                        user: "default".to_string(),
                    }).ok().flatten()?;
                    Some((ai_cfg.base_url, key, ai_cfg.chat_model))
                })
            } else { None };
            let d = fastbrain::fast_decide(pack, &cfg.brain_mode, &cfg.laya_url, cloud, Some(&cfg.indicators_enabled)).await;

            match d.label.as_str() {
                "BUY" if pos.is_none() => {
                    if d.confidence >= cfg.exec_confidence && can_open_now(&cfg) {
                        match paper_buy(&conn, item, q, &cfg, total_asset, cash, total_pos_pct) {
                            Ok(msg) => {
                                log_decision(&conn, item, &d, "executed", &features, false);
                                emit_signal(&app, item, &d, "executed", &msg);
                                let budget = total_asset * cfg.max_single_pct / 100.0;
                                bridge_push(&app, &conn, &cfg, bridge::SignalInput {
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
                                });
                            }
                            Err(reason) => {
                                log_decision(&conn, item, &d, "drop", &features, false);
                                if can_fire(&mut fire_hist, &item.code) {
                                    emit_signal(&app, item, &d, "watch", &format!("快脑买入但{reason}"));
                                }
                            }
                        }
                    } else if d.confidence >= cfg.watch_confidence
                        && can_fire(&mut fire_hist, &item.code)
                    {
                        log_decision(&conn, item, &d, "watch", &features, false);
                        emit_signal(&app, item, &d, "watch", "快脑买入观察信号，请人工确认");
                        let budget = total_asset * cfg.max_single_pct / 100.0;
                        bridge_push(&app, &conn, &cfg, bridge::SignalInput {
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
                        });
                    }
                }
                "SELL" if pos.is_some() => {
                    if let Some(p) = pos {
                        match paper_sell(&conn, &item.code, &item.name, q, &cfg, p, p.vol) {
                            Ok(msg) => {
                                log_decision(&conn, item, &d, "executed", &features, false);
                                emit_signal(&app, item, &d, "executed", &msg);
                                bridge_push(&app, &conn, &cfg, bridge::SignalInput {
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
                                });
                            }
                            Err(e) => {
                                log_decision(&conn, item, &d, "watch", &features, false);
                                if can_fire(&mut fire_hist, &item.code) {
                                    emit_signal(&app, item, &d, "watch", &format!("快脑卖出但{e}，请人工确认"));
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
