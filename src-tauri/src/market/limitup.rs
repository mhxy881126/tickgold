// 涨停雷达：全市场快照，统计涨停/跌停/炸板、连板梯队与市场情绪温度，定时 emit 给前端。
use super::{now_millis, Quote};
use super::spider::{is_trading_time, limit_prices};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

// ===== 对外数据结构 =====
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StockBrief {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub pct: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LimitStock {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub pct: f64,
    pub boards: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LadderGroup {
    pub boards: u32,
    pub count: usize,
    pub items: Vec<LimitStock>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RadarData {
    pub trading: bool,
    pub updated: i64,
    pub total: usize,
    pub up_count: usize,
    pub down_count: usize,
    pub flat_count: usize,
    pub limit_up: usize,
    pub limit_down: usize,
    pub broken: usize,
    pub broken_rate: f64,
    pub max_boards: u32,
    pub sentiment: f64,
    pub mood: String,
    pub ladder: Vec<LadderGroup>,
    pub limit_up_list: Vec<LimitStock>,
    pub broken_list: Vec<StockBrief>,
    pub limit_down_list: Vec<StockBrief>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RadarStatus {
    pub scanning: bool,
    pub trading: bool,
    pub time: i64,
}

/// 控制器（Arc manage）
pub struct LimitRadar {
    pub running: AtomicBool,
}
impl LimitRadar {
    pub fn new() -> Self {
        LimitRadar { running: AtomicBool::new(false) }
    }
}

fn brief(q: &Quote) -> StockBrief {
    StockBrief { code: q.code.clone(), name: q.name.clone(), price: q.price, pct: q.pct }
}

/// 涨停幅度（小数）
fn limit_rate(code: &str, name: &str) -> f64 {
    if name.contains("ST") {
        0.05
    } else if code.starts_with("688") || code.starts_with("300") || code.starts_with("301") {
        0.20
    } else if code.starts_with('4') || code.starts_with('8') || code.starts_with("920") {
        0.30
    } else {
        0.10
    }
}

// ===== 全市场代码（新浪分页，缓存 30 分钟）=====
async fn all_codes(cache: &Arc<Mutex<(i64, Vec<Quote>)>>) -> Vec<Quote> {
    {
        let g = cache.lock().unwrap();
        if now_millis() - g.0 < 1800 * 1000 && !g.1.is_empty() {
            return g.1.clone();
        }
    }
    let mut all = Vec::new();
    for page in 1..=10 {
        match super::sina::rank_page("gainers", page, 1000).await {
            Ok(rows) => {
                let n = rows.len();
                all.extend(rows);
                if n < 1000 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if !all.is_empty() {
        *cache.lock().unwrap() = (now_millis(), all.clone());
    }
    all
}

// ===== 全市场腾讯快照（并发受限）=====
async fn market_snapshot(codes: &[String]) -> HashMap<String, Quote> {
    let sem = Arc::new(Semaphore::new(10));
    let mut set = JoinSet::new();
    for chunk in codes.chunks(45) {
        let permit = sem.clone().acquire_owned().await.unwrap();
        let c = chunk.to_vec();
        set.spawn(async move {
            let _p = permit;
            super::tencent::quotes(&c).await
        });
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

// ===== 连板数（日K，缓存到最近交易日）=====
async fn count_boards(
    code: &str,
    name: &str,
    cache: Arc<Mutex<HashMap<String, (i64, u32)>>>,
) -> u32 {
    let kb = match super::tencent::kline(code, 101, 20).await {
        Ok(k) => k,
        Err(_) => return 1,
    };
    if kb.is_empty() {
        return 1;
    }
    let last_ts = kb.last().unwrap().timestamp;
    {
        let g = cache.lock().unwrap();
        if let Some((d, b)) = g.get(code) {
            if d == &last_ts {
                return *b;
            }
        }
    }
    let rate = limit_rate(code, name);
    let mut boards = 1u32; // 今日封住（调用前提）
    let n = kb.len();
    let mut i = (n as isize) - 2;
    while i >= 1 {
        let cur = &kb[i as usize];
        let prev = &kb[(i - 1) as usize];
        if prev.close > 0.0 {
            let chg = (cur.close - prev.close) / prev.close * 100.0;
            if chg >= rate * 100.0 - 0.3 {
                boards += 1;
                i -= 1;
            } else {
                break;
            }
        } else {
            break;
        }
    }
    cache.lock().unwrap().insert(code.to_string(), (last_ts, boards));
    boards
}

// ===== 一次完整扫描 =====
async fn scan(
    code_cache: &Arc<Mutex<(i64, Vec<Quote>)>>,
    board_cache: &Arc<Mutex<HashMap<String, (i64, u32)>>>,
    trading: bool,
) -> RadarData {
    let all = all_codes(code_cache).await;
    let codes: Vec<String> = all.iter().map(|q| q.code.clone()).collect();
    let snap = market_snapshot(&codes).await;

    let mut up = 0usize;
    let mut down = 0usize;
    let mut flat = 0usize;
    let mut sealed: Vec<&Quote> = Vec::new();
    let mut broken: Vec<StockBrief> = Vec::new();
    let mut limit_down: Vec<StockBrief> = Vec::new();

    for q in snap.values() {
        if q.price <= 0.0 || q.prev_close <= 0.0 {
            continue;
        }
        if q.pct > 0.01 {
            up += 1;
        } else if q.pct < -0.01 {
            down += 1;
        } else {
            flat += 1;
        }
        let (lu, ld) = limit_prices(&q.code, &q.name, q.prev_close);
        let eps = 0.01;
        if q.high >= lu - eps {
            if q.price >= lu - eps {
                sealed.push(q);
            } else {
                broken.push(brief(q));
            }
        }
        if q.low <= ld + eps && q.price <= ld + eps {
            limit_down.push(brief(q));
        }
    }

    // 并发算连板
    let sem = Arc::new(Semaphore::new(8));
    let mut set = JoinSet::new();
    for q in &sealed {
        let permit = sem.clone().acquire_owned().await.unwrap();
        let code = q.code.clone();
        let name = q.name.clone();
        let cache = board_cache.clone();
        set.spawn(async move {
            let _p = permit;
            let b = count_boards(&code, &name, cache).await;
            (code, b)
        });
    }
    let mut bm: HashMap<String, u32> = HashMap::new();
    while let Some(r) = set.join_next().await {
        if let Ok((c, b)) = r {
            bm.insert(c, b);
        }
    }

    let mut lu_stocks: Vec<LimitStock> = sealed
        .iter()
        .map(|q| LimitStock {
            code: q.code.clone(),
            name: q.name.clone(),
            price: q.price,
            pct: q.pct,
            boards: *bm.get(&q.code).unwrap_or(&1),
        })
        .collect();
    lu_stocks.sort_by(|a, b| b.boards.cmp(&a.boards).then(b.pct.partial_cmp(&a.pct).unwrap()));

    // 连板梯队（>=2 板），板高降序
    let mut groups: BTreeMap<u32, Vec<LimitStock>> = BTreeMap::new();
    for s in &lu_stocks {
        if s.boards >= 2 {
            groups.entry(s.boards).or_default().push(s.clone());
        }
    }
    let ladder: Vec<LadderGroup> = groups
        .into_iter()
        .rev()
        .map(|(boards, items)| LadderGroup { boards, count: items.len(), items })
        .collect();

    broken.sort_by(|a, b| b.pct.partial_cmp(&a.pct).unwrap_or(std::cmp::Ordering::Equal));
    limit_down.sort_by(|a, b| a.pct.partial_cmp(&b.pct).unwrap_or(std::cmp::Ordering::Equal));

    let n_lu = lu_stocks.len();
    let n_br = broken.len();
    let n_ld = limit_down.len();
    let broken_rate = if n_lu + n_br > 0 {
        n_br as f64 / (n_lu + n_br) as f64 * 100.0
    } else {
        0.0
    };
    let max_boards = lu_stocks.first().map(|s| s.boards).unwrap_or(0);
    let total = (up + down + flat) as f64;
    let s_limit = ((n_lu as f64) - (n_ld as f64)) * 0.6;
    let s_limit = s_limit.clamp(-25.0, 25.0);
    let breadth = if total > 0.0 {
        (up as f64 - down as f64) / total * 25.0
    } else {
        0.0
    };
    let s_broken = -broken_rate * 0.25;
    let s_height = ((max_boards as f64) - 1.0).max(0.0).min(8.0) * 1.5;
    let sentiment = (50.0 + s_limit + breadth + s_broken + s_height).clamp(2.0, 99.0);
    let mood = if sentiment < 20.0 {
        "冰点"
    } else if sentiment < 40.0 {
        "低迷"
    } else if sentiment < 60.0 {
        "中性"
    } else if sentiment < 80.0 {
        "活跃"
    } else {
        "亢奋"
    };

    RadarData {
        trading,
        updated: now_millis(),
        total: total as usize,
        up_count: up,
        down_count: down,
        flat_count: flat,
        limit_up: n_lu,
        limit_down: n_ld,
        broken: n_br,
        broken_rate,
        max_boards,
        sentiment,
        mood: mood.to_string(),
        ladder,
        limit_up_list: lu_stocks,
        broken_list: broken,
        limit_down_list: limit_down,
    }
}

// ===== 后台主循环 =====
pub async fn run_loop(app: AppHandle, ctl: Arc<LimitRadar>) {
    let code_cache = Arc::new(Mutex::new((0i64, Vec::<Quote>::new())));
    let board_cache = Arc::new(Mutex::new(HashMap::<String, (i64, u32)>::new()));
    let mut did_off = false;

    while ctl.running.load(Ordering::Acquire) {
        let trading = is_trading_time();
        if trading {
            did_off = false;
            let _ = app.emit(
                "radar:status",
                RadarStatus { scanning: true, trading, time: now_millis() },
            );
            let data = scan(&code_cache, &board_cache, true).await;
            let _ = app.emit("radar:data", data);
            let _ = app.emit(
                "radar:status",
                RadarStatus { scanning: false, trading, time: now_millis() },
            );
            for _ in 0..55 {
                if !ctl.running.load(Ordering::Acquire) {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        } else {
            if !did_off {
                let _ = app.emit(
                    "radar:status",
                    RadarStatus { scanning: true, trading, time: now_millis() },
                );
                let data = scan(&code_cache, &board_cache, false).await;
                let _ = app.emit("radar:data", data);
                let _ = app.emit(
                    "radar:status",
                    RadarStatus { scanning: false, trading, time: now_millis() },
                );
                did_off = true;
            }
            for _ in 0..120 {
                if !ctl.running.load(Ordering::Acquire) {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}
