// 短线精灵 / 异动实时流：定时拉取活跃股池快照，与上一快照 diff 检测异动，经 Tauri 事件推送到前端。
use super::{now_millis, Quote};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::task::JoinSet;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpiderEvent {
    pub time: i64,
    pub code: String,
    pub name: String,
    pub price: f64,
    pub pct: f64,
    pub kind: String,
    pub label: String,
    pub desc: String,
    pub tone: String, // up / down / neutral
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpiderStatus {
    pub trading: bool,
    pub pool_size: usize,
    pub time: i64,
}

/// 控制器（以 Arc 形式 manage，便于后台任务持有）
pub struct SpiderCtl {
    pub running: AtomicBool,
    pub watch: Mutex<Vec<String>>,
}
impl SpiderCtl {
    pub fn new() -> Self {
        SpiderCtl {
            running: AtomicBool::new(false),
            watch: Mutex::new(vec![]),
        }
    }
}

// ===== 北京时间 / 交易时段 =====
pub(crate) fn beijing() -> (u64, u32, u32) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        + 8 * 3600;
    let days = secs / 86400;
    let tod = secs % 86400;
    let wd = (days + 4) % 7; // 0=Sun ... 4=Thu ... 6=Sat（1970-01-01 为周四）
    let h = (tod / 3600) as u32;
    let m = ((tod % 3600) / 60) as u32;
    (wd, h, m)
}

pub(crate) fn is_trading_time() -> bool {
    let (wd, h, m) = beijing();
    if !(1..=5).contains(&wd) {
        return false;
    }
    let hm = h * 100 + m;
    (915..=1131).contains(&hm) || (1259..=1505).contains(&hm)
}

// ===== 涨跌停价估算 =====
pub(crate) fn limit_prices(code: &str, name: &str, prev_close: f64) -> (f64, f64) {
    let rate = if name.contains("ST") {
        0.05
    } else if code.starts_with("688") || code.starts_with("300") || code.starts_with("301") {
        0.20
    } else if code.starts_with('4') || code.starts_with('8') || code.starts_with("920") {
        0.30
    } else {
        0.10
    };
    let up = (prev_close * (1.0 + rate) * 100.0).round() / 100.0;
    let dn = (prev_close * (1.0 - rate) * 100.0).round() / 100.0;
    (up, dn)
}

// ===== 股池构建（自选 + 涨幅榜 + 成交额榜，去重）=====
async fn build_pool(watch: &[String]) -> Vec<String> {
    let mut set: HashSet<String> = HashSet::new();
    for c in watch {
        if c.len() == 6 {
            set.insert(c.clone());
        }
    }
    for sort in ["gainers", "amount"] {
        if let Ok(rows) = super::sina::rank_page(sort, 1, 80).await {
            for q in rows {
                set.insert(q.code);
            }
        }
    }
    set.into_iter().collect()
}

// ===== 快照（分批并发，腾讯批量行情）=====
async fn snapshot(pool: &[String]) -> HashMap<String, Quote> {
    let mut set = JoinSet::new();
    for chunk in pool.chunks(40) {
        let c = chunk.to_vec();
        set.spawn(async move { super::tencent::quotes(&c).await });
    }
    let mut map = HashMap::new();
    while let Some(r) = set.join_next().await {
        if let Ok(Ok(qs)) = r {
            for q in qs {
                map.insert(q.code.clone(), q);
            }
        }
    }
    map
}

// ===== 异动检测 =====
fn detect(prev: &HashMap<String, Quote>, curr: &HashMap<String, Quote>) -> Vec<SpiderEvent> {
    let now = now_millis();
    let mut evs = Vec::new();
    let mk = |kind: &str, label: &str, desc: String, tone: &str, q: &Quote| SpiderEvent {
        time: now,
        code: q.code.clone(),
        name: q.name.clone(),
        price: q.price,
        pct: q.pct,
        kind: kind.to_string(),
        label: label.to_string(),
        desc,
        tone: tone.to_string(),
    };

    for (code, c) in curr {
        let Some(p) = prev.get(code) else { continue }; // 首轮建立基线，不比较
        let (lu, ld) = limit_prices(code, &c.name, c.prev_close);
        let eps = 0.001;

        // 封 / 开 涨停板
        let c_up = c.price >= lu - eps;
        let p_up = p.price >= lu - eps;
        if c_up && !p_up {
            evs.push(mk("limit_up", "封涨停板", format!("封涨停板 {}", c.price), "up", c));
        } else if !c_up && p_up {
            evs.push(mk("limit_up_open", "涨停打开", format!("涨停打开 {}", c.price), "down", c));
        }

        // 封 / 开 跌停板
        let c_dn = c.price <= ld + eps && c.price > 0.0;
        let p_dn = p.price <= ld + eps && p.price > 0.0;
        if c_dn && !p_dn {
            evs.push(mk("limit_down", "封跌停板", format!("封跌停板 {}", c.price), "down", c));
        } else if !c_dn && p_dn {
            evs.push(mk("limit_down_open", "跌停打开", format!("跌停打开 {}", c.price), "up", c));
        }

        // 快速拉升 / 下跌（区间涨跌幅变化）
        let dpct = c.pct - p.pct;
        if dpct >= 0.8 {
            evs.push(mk("surge", "快速拉升", format!("快速拉升 +{:.2}%", dpct), "up", c));
        } else if dpct <= -0.8 {
            evs.push(mk("plunge", "快速下跌", format!("快速下跌 {:.2}%", dpct), "down", c));
        }

        // 大单（区间成交额增量 ≥ 3000 万，按价格方向定买卖）
        let d_amt = c.amount - p.amount;
        if d_amt >= 3000.0 * 1e4 {
            if c.price + eps >= p.price {
                evs.push(mk("big_buy", "大单买入", format!("大单买入 {:.0}万", d_amt / 1e4), "up", c));
            } else {
                evs.push(mk("big_sell", "大单卖出", format!("大单卖出 {:.0}万", d_amt / 1e4), "down", c));
            }
        }

        // 量比放大（上穿 3，触发一次）
        if c.volume_ratio >= 3.0 && p.volume_ratio < 3.0 {
            evs.push(mk("volume", "量比放大", format!("量比放大 {:.1}", c.volume_ratio), "neutral", c));
        }
    }
    evs
}

// ===== 后台主循环 =====
pub async fn run_loop(app: AppHandle, ctl: Arc<SpiderCtl>) {
    let mut pool: Vec<String> = Vec::new();
    let mut prev: HashMap<String, Quote> = HashMap::new();
    let mut tick: u32 = 0;

    while ctl.running.load(Ordering::Acquire) {
        let trading = is_trading_time();

        if trading {
            if pool.is_empty() || tick % 12 == 0 {
                let watch = ctl.watch.lock().map(|g| g.clone()).unwrap_or_default();
                pool = build_pool(&watch).await;
            }
            let curr = snapshot(&pool).await;
            let evs = detect(&prev, &curr);
            prev = curr;
            let _ = app.emit("spider:events", evs);
            let _ = app.emit(
                "spider:status",
                SpiderStatus { trading, pool_size: pool.len(), time: now_millis() },
            );
            tick += 1;
            for _ in 0..15 {
                if !ctl.running.load(Ordering::Acquire) {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        } else {
            let _ = app.emit(
                "spider:status",
                SpiderStatus { trading, pool_size: pool.len(), time: now_millis() },
            );
            prev.clear();
            for _ in 0..30 {
                if !ctl.running.load(Ordering::Acquire) {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}
