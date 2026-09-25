// 预警引擎：前端管理规则（SQLite CRUD），start_alert_engine 把规则快照下发到后端；
// 后端定时批量拉行情，判断价格上穿 / 跌破（边沿触发）、涨跌幅阈值、量比 / 涨速、
// 涨跌停封板 / 炸板、换手率 / 成交额，冷却去重后 emit("alert:triggered")。
use super::{now_millis, Quote};
use super::spider::{is_trading_time, limit_prices};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

// ===== 数据结构 =====
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AlertRule {
    pub id: String,
    pub code: String,
    pub name: String,
    pub up_price: Option<f64>,
    pub down_price: Option<f64>,
    pub up_pct: Option<f64>,
    pub down_pct: Option<f64>,
    #[serde(default)]
    pub min_volume_ratio: Option<f64>, // 量比 ≥
    #[serde(default)]
    pub rise_speed: Option<f64>, // 涨速 ≥ %（窗口内涨幅）
    #[serde(default)]
    pub down_speed: Option<f64>, // 跳水 ≥ %（窗口内跌幅，正数）
    #[serde(default)]
    pub speed_window_sec: Option<i64>, // 涨速 / 跳水窗口（秒），默认 300
    #[serde(default)]
    pub min_turnover: Option<f64>, // 换手率 ≥ %
    #[serde(default)]
    pub min_amount: Option<f64>, // 成交额 ≥ 亿元
    #[serde(default)]
    pub seal_limit_up: Option<bool>, // 涨停封板
    #[serde(default)]
    pub seal_limit_down: Option<bool>, // 跌停封板
    #[serde(default)]
    pub broken_limit: Option<bool>, // 涨停炸板（封板后打开）
    pub cooldown_sec: i64,
    pub enabled: bool,
    #[serde(default)]
    pub last_fired_at: Option<i64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AlertEvent {
    pub time: i64,
    pub id: String,
    pub code: String,
    pub name: String,
    pub kind: String, // price_up / price_down / pct_up / pct_down / vr_up / speed_up /
                      // speed_down / turnover_up / amount_up / limit_seal_up / limit_seal_dn / limit_broken
    pub label: String,
    pub message: String,
    pub price: f64,
    pub pct: f64,
    pub target: f64,
    pub tone: String, // up / down
}

/// 引擎控制器
pub struct AlertEngine {
    pub running: AtomicBool,
    pub rules: Mutex<Vec<AlertRule>>,
    /// "id:kind" -> 上次触发 ms（冷却去重）
    pub fired: Mutex<HashMap<String, i64>>,
    /// code -> [(ts_ms, price)]，本地计算涨速 / 跳水用
    pub price_hist: Mutex<HashMap<String, Vec<(i64, f64)>>>,
    /// code -> 上一轮价格（价格上穿 / 跌破的边沿判定）
    pub prev_price: Mutex<HashMap<String, f64>>,
    /// code -> "seal_up" / "seal_dn" / "open_broken" / ""（封板 / 炸板边沿判定）
    pub seal_state: Mutex<HashMap<String, String>>,
}
impl AlertEngine {
    pub fn new() -> Self {
        AlertEngine {
            running: AtomicBool::new(false),
            rules: Mutex::new(Vec::new()),
            fired: Mutex::new(HashMap::new()),
            price_hist: Mutex::new(HashMap::new()),
            prev_price: Mutex::new(HashMap::new()),
            seal_state: Mutex::new(HashMap::new()),
        }
    }
}

/// 单次检测
async fn check_once(app: &AppHandle, engine: &AlertEngine) {
    let rules = engine.rules.lock().unwrap().clone();
    let active: Vec<AlertRule> = rules.into_iter().filter(|r| r.enabled).collect();
    if active.is_empty() {
        return;
    }
    let uniq: Vec<String> = active
        .iter()
        .map(|r| r.code.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let qs = match super::tencent::quotes(&uniq).await {
        Ok(q) => q,
        Err(_) => return,
    };
    let qmap: HashMap<String, Quote> = qs.into_iter().map(|q| (q.code.clone(), q)).collect();
    let now = now_millis();
    let mut events: Vec<AlertEvent> = Vec::new();

    // 记录价格历史（本地涨速 / 跳水用），按规则中最大窗口清理
    let max_window = active
        .iter()
        .filter(|r| r.rise_speed.is_some() || r.down_speed.is_some())
        .map(|r| r.speed_window_sec.unwrap_or(300))
        .max()
        .unwrap_or(0);
    {
        let mut hist = engine.price_hist.lock().unwrap();
        for q in qmap.values() {
            let entry = hist.entry(q.code.clone()).or_default();
            entry.push((now, q.price));
            if max_window > 0 {
                let cutoff = now - (max_window + 60) * 1000;
                entry.retain(|(ts, _)| *ts >= cutoff);
            }
        }
    }

    // 涨跌停封板 / 炸板：按 code 计算边沿，本轮发生的边沿收集起来供规则读取
    // edge: "seal_up"（刚封涨停）/ "seal_dn"（刚封跌停）/ "broken"（封涨停后打开）
    let mut limit_edges: HashMap<String, Vec<&'static str>> = HashMap::new();
    {
        let mut state = engine.seal_state.lock().unwrap();
        for (code, q) in &qmap {
            let (lu, ld) = limit_prices(code, &q.name, q.prev_close);
            let eps = 0.001;
            let cur = if q.price >= lu - eps {
                "seal_up"
            } else if q.price <= ld + eps {
                "seal_dn"
            } else if q.high >= lu - eps {
                "open_broken"
            } else {
                ""
            };
            let prev = state.get(code).map(|s| s.as_str()).unwrap_or("");
            let mut edges: Vec<&'static str> = Vec::new();
            if cur == "seal_up" && prev != "seal_up" {
                edges.push("seal_up");
            }
            if cur == "seal_dn" && prev != "seal_dn" {
                edges.push("seal_dn");
            }
            if cur == "open_broken" && prev == "seal_up" {
                edges.push("broken");
            }
            state.insert(code.clone(), cur.to_string());
            if !edges.is_empty() {
                limit_edges.insert(code.clone(), edges);
            }
        }
    }

    for r in &active {
        let Some(q) = qmap.get(&r.code) else { continue };
        // (kind,label,target,actual,tone)
        let mut conds: Vec<(&str, &str, f64, f64, &str)> = Vec::new();

        // 价格上穿 / 跌破：基于上一轮价格的真正边沿（启动首轮不触发）
        let prev_p = engine.prev_price.lock().unwrap().get(&r.code).copied();
        if let Some(t) = r.up_price {
            if let Some(pp) = prev_p {
                if pp < t && q.price >= t {
                    conds.push(("price_up", "价格上穿", t, q.price, "up"));
                }
            }
        }
        if let Some(t) = r.down_price {
            if let Some(pp) = prev_p {
                if pp > t && q.price <= t {
                    conds.push(("price_down", "价格跌破", t, q.price, "down"));
                }
            }
        }

        // 涨跌幅阈值
        if let Some(t) = r.up_pct {
            if q.pct >= t {
                conds.push(("pct_up", "涨幅突破", t, q.pct, "up"));
            }
        }
        if let Some(t) = r.down_pct {
            if q.pct <= t {
                conds.push(("pct_down", "跌幅触及", t, q.pct, "down"));
            }
        }
        // 量比放大
        if let Some(t) = r.min_volume_ratio {
            if q.volume_ratio >= t && q.volume_ratio > 0.0 {
                conds.push(("vr_up", "量比放大", t, q.volume_ratio, "up"));
            }
        }
        // 涨速（窗口内本地计算，向上）
        if let Some(t) = r.rise_speed {
            let win = r.speed_window_sec.unwrap_or(300);
            let base = engine
                .price_hist
                .lock()
                .unwrap()
                .get(&r.code)
                .and_then(|h| {
                    h.iter()
                        .filter(|(ts, _)| *ts <= now - win * 1000)
                        .map(|(_, p)| *p)
                        .last()
                });
            if let Some(old) = base {
                if old > 0.0 {
                    let spd = (q.price - old) / old * 100.0;
                    if spd >= t {
                        conds.push(("speed_up", "快速拉升", t, spd, "up"));
                    }
                }
            }
        }
        // 跳水（窗口内本地计算，向下，与涨速对称）
        if let Some(t) = r.down_speed {
            let win = r.speed_window_sec.unwrap_or(300);
            let base = engine
                .price_hist
                .lock()
                .unwrap()
                .get(&r.code)
                .and_then(|h| {
                    h.iter()
                        .filter(|(ts, _)| *ts <= now - win * 1000)
                        .map(|(_, p)| *p)
                        .last()
                });
            if let Some(old) = base {
                if old > 0.0 {
                    let spd = (q.price - old) / old * 100.0;
                    if spd <= -t {
                        conds.push(("speed_down", "快速跳水", t, -spd, "down"));
                    }
                }
            }
        }
        // 换手率放大
        if let Some(t) = r.min_turnover {
            if q.turnover >= t && q.turnover > 0.0 {
                conds.push(("turnover_up", "换手放大", t, q.turnover, "up"));
            }
        }
        // 成交额达标（亿元）
        if let Some(t) = r.min_amount {
            let actual_yi = q.amount / 100_000_000.0;
            if t > 0.0 && actual_yi >= t {
                conds.push(("amount_up", "成交额达标", t, actual_yi, "up"));
            }
        }
        // 涨停封板 / 跌停封板 / 涨停炸板（边沿）
        if let Some(edges) = limit_edges.get(&r.code) {
            let (lu, ld) = limit_prices(&r.code, &q.name, q.prev_close);
            if r.seal_limit_up.unwrap_or(false) && edges.contains(&"seal_up") {
                conds.push(("limit_seal_up", "涨停封板", lu, q.price, "up"));
            }
            if r.seal_limit_down.unwrap_or(false) && edges.contains(&"seal_dn") {
                conds.push(("limit_seal_dn", "跌停封板", ld, q.price, "down"));
            }
            if r.broken_limit.unwrap_or(false) && edges.contains(&"broken") {
                conds.push(("limit_broken", "涨停炸板", lu, q.price, "down"));
            }
        }

        for (kind, label, target, actual, tone) in conds {
            let key = format!("{}:{}", r.id, kind);
            let last = engine.fired.lock().unwrap().get(&key).copied().unwrap_or(0);
            if now - last < r.cooldown_sec * 1000 {
                continue;
            }
            engine.fired.lock().unwrap().insert(key, now);

            let win_min = r.speed_window_sec.unwrap_or(300) as f64 / 60.0;
            let message = match kind {
                "price_up" | "price_down" => format!(
                    "{} {}，现价 {}，目标 {}",
                    r.name,
                    label,
                    format!("{:.2}", q.price),
                    format!("{:.2}", target)
                ),
                "vr_up" => format!("{} 量比放大至 {:.2}，阈值 {:.2}", r.name, actual, target),
                "speed_up" => format!(
                    "{} {:.0} 分钟内快速拉升 {:.2}%，阈值 {:.2}%",
                    r.name, win_min, actual, target
                ),
                "speed_down" => format!(
                    "{} {:.0} 分钟内快速跳水 {:.2}%，阈值 {:.2}%",
                    r.name, win_min, actual, target
                ),
                "turnover_up" => format!(
                    "{} 换手率放大至 {:.2}%，阈值 {:.2}%",
                    r.name, actual, target
                ),
                "amount_up" => format!(
                    "{} 成交额达 {:.2} 亿，阈值 {:.2} 亿",
                    r.name, actual, target
                ),
                "limit_seal_up" => format!(
                    "{} 涨停封板，现价 {}（涨停价 {}）",
                    r.name,
                    format!("{:.2}", q.price),
                    format!("{:.2}", target)
                ),
                "limit_seal_dn" => format!(
                    "{} 跌停封板，现价 {}（跌停价 {}）",
                    r.name,
                    format!("{:.2}", q.price),
                    format!("{:.2}", target)
                ),
                "limit_broken" => format!(
                    "{} 涨停炸板，现价 {}，涨停价 {}",
                    r.name,
                    format!("{:.2}", q.price),
                    format!("{:.2}", target)
                ),
                _ => format!(
                    "{} {}，{}{}%，阈值 {}%",
                    r.name,
                    label,
                    if tone == "up" { "涨幅" } else { "跌幅" },
                    format!("{:.2}", actual),
                    format!("{:.2}", target)
                ),
            };
            events.push(AlertEvent {
                time: now,
                id: r.id.clone(),
                code: r.code.clone(),
                name: r.name.clone(),
                kind: kind.to_string(),
                label: label.to_string(),
                message,
                price: q.price,
                pct: q.pct,
                target,
                tone: tone.to_string(),
            });
        }
    }

    // 记录本轮回看价（下一轮价格穿越边沿用）
    {
        let mut pp = engine.prev_price.lock().unwrap();
        for q in qmap.values() {
            pp.insert(q.code.clone(), q.price);
        }
    }

    for e in events {
        let _ = app.emit("alert:triggered", e);
    }
}

/// 后台主循环
pub async fn run_loop(app: AppHandle, engine: Arc<AlertEngine>) {
    while engine.running.load(Ordering::Acquire) {
        let trading = is_trading_time();
        check_once(&app, &engine).await;
        let wait_secs = if trading { 5 } else { 60 };
        for _ in 0..wait_secs {
            if !engine.running.load(Ordering::Acquire) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}
