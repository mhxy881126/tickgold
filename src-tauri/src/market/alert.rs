// 预警引擎：前端管理规则（SQLite CRUD），start_alert_engine 把规则快照下发到后端；
// 后端定时批量拉行情，判断价格上穿 / 跌破、涨跌幅阈值，冷却去重后 emit("alert:triggered")。
use super::{now_millis, Quote};
use super::spider::is_trading_time;
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
    pub kind: String, // price_up / price_down / pct_up / pct_down
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
}
impl AlertEngine {
    pub fn new() -> Self {
        AlertEngine {
            running: AtomicBool::new(false),
            rules: Mutex::new(Vec::new()),
            fired: Mutex::new(HashMap::new()),
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

    for r in &active {
        let Some(q) = qmap.get(&r.code) else { continue };
        // (kind,label,target,actual,tone)
        let mut conds: Vec<(&str, &str, f64, f64, &str)> = Vec::new();
        if let Some(t) = r.up_price {
            if q.price >= t {
                conds.push(("price_up", "价格上穿", t, q.price, "up"));
            }
        }
        if let Some(t) = r.down_price {
            if q.price <= t {
                conds.push(("price_down", "价格跌破", t, q.price, "down"));
            }
        }
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

        for (kind, label, target, actual, tone) in conds {
            let key = format!("{}:{}", r.id, kind);
            let last = engine.fired.lock().unwrap().get(&key).copied().unwrap_or(0);
            if now - last < r.cooldown_sec * 1000 {
                continue;
            }
            engine.fired.lock().unwrap().insert(key, now);

            let message = if kind.starts_with("price") {
                format!(
                    "{} {}，现价 {}，目标 {}",
                    r.name,
                    label,
                    format!("{:.2}", q.price),
                    format!("{:.2}", target)
                )
            } else {
                format!(
                    "{} {}，{}{}%，阈值 {}%",
                    r.name,
                    label,
                    if tone == "up" { "涨幅" } else { "跌幅" },
                    format!("{:.2}", actual),
                    format!("{:.2}", target)
                )
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
