// 涨停雷达：东方财富涨停池/炸板池 + 全市场宽度统计，定时 emit 给前端。
use super::{now_millis, Quote};
use super::spider::{is_trading_time, limit_prices};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

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
    pub hist: Vec<usize>,
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

/// 控制器
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

/// 涨跌幅分布桶（红 5 + 绿 5，共 10 桶）
fn hist_bucket(pct: f64) -> usize {
    if pct >= 7.0 {
        0
    } else if pct >= 5.0 {
        1
    } else if pct >= 3.0 {
        2
    } else if pct >= 1.0 {
        3
    } else if pct >= 0.0 {
        4
    } else if pct >= -1.0 {
        5
    } else if pct >= -3.0 {
        6
    } else if pct >= -5.0 {
        7
    } else if pct >= -7.0 {
        8
    } else {
        9
    }
}

// ===== 日期工具（无 chrono 依赖，UTC+8）=====
fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn date_str_from_millis(ms: i64) -> String {
    let secs = (ms / 1000) + 8 * 3600;
    let mut days = secs / 86400;
    let mut y = 1970i32;
    loop {
        let dy = if is_leap(y) { 366 } else { 365 };
        if days >= dy {
            days -= dy;
            y += 1;
        } else {
            break;
        }
    }
    let mdays = [31, if is_leap(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0usize;
    while days >= mdays[m] {
        days -= mdays[m];
        m += 1;
    }
    format!("{:04}{:02}{:02}", y, m + 1, days + 1)
}

/// 从今天起往前探测最多 7 天，取第一个有涨停数据的交易日的 (涨停池, 炸板池, 跌停池)
async fn fetch_pools() -> (
    super::eastmoney::ZtPool,
    super::eastmoney::ZtPool,
    super::eastmoney::ZtPool,
) {
    let mut ms = now_millis();
    for _ in 0..7 {
        let date = date_str_from_millis(ms);
        let (zt, zb, dt) = tokio::join!(
            super::eastmoney::zt_pool(&date),
            super::eastmoney::zb_pool(&date),
            super::eastmoney::dt_pool(&date),
        );
        if let (Ok(z), Ok(b), Ok(d)) = (zt, zb, dt) {
            if !z.list.is_empty() {
                return (z, b, d);
            }
        }
        ms -= 86400 * 1000;
    }
    (
        super::eastmoney::ZtPool { date: String::new(), total: 0, list: Vec::new() },
        super::eastmoney::ZtPool { date: String::new(), total: 0, list: Vec::new() },
        super::eastmoney::ZtPool { date: String::new(), total: 0, list: Vec::new() },
    )
}

// ===== 公共：从涨停/炸板池构造列表与梯队 =====
struct LimitCore {
    lu_stocks: Vec<LimitStock>,
    broken: Vec<StockBrief>,
    ladder: Vec<LadderGroup>,
    n_lu: usize,
    n_br: usize,
    max_boards: u32,
    broken_rate: f64,
}

fn build_limit_core(zt: &super::eastmoney::ZtPool, zb: &super::eastmoney::ZtPool) -> LimitCore {
    let mut lu_stocks: Vec<LimitStock> = zt
        .list
        .iter()
        .map(|s| LimitStock {
            code: s.code.clone(),
            name: s.name.clone(),
            price: s.price,
            pct: s.pct,
            boards: s.boards,
        })
        .collect();
    lu_stocks.sort_by(|a, b| b.boards.cmp(&a.boards).then(b.pct.partial_cmp(&a.pct).unwrap()));

    let mut broken: Vec<StockBrief> = zb
        .list
        .iter()
        .map(|s| StockBrief {
            code: s.code.clone(),
            name: s.name.clone(),
            price: s.price,
            pct: s.pct,
        })
        .collect();
    broken.sort_by(|a, b| b.pct.partial_cmp(&a.pct).unwrap_or(std::cmp::Ordering::Equal));

    let mut groups: BTreeMap<u32, Vec<LimitStock>> = BTreeMap::new();
    for s in &lu_stocks {
        if s.boards >= 1 {
            groups.entry(s.boards).or_default().push(s.clone());
        }
    }
    let ladder: Vec<LadderGroup> = groups
        .into_iter()
        .rev()
        .map(|(boards, items)| LadderGroup { boards, count: items.len(), items })
        .collect();

    let n_lu = lu_stocks.len();
    let n_br = broken.len();
    let broken_rate = if n_lu + n_br > 0 {
        n_br as f64 / (n_lu + n_br) as f64 * 100.0
    } else {
        0.0
    };
    let max_boards = lu_stocks.first().map(|s| s.boards).unwrap_or(0);

    LimitCore { lu_stocks, broken, ladder, n_lu, n_br, max_boards, broken_rate }
}

fn sentiment_from(core: &LimitCore, n_ld: usize, total: usize, up: usize, down: usize) -> (f64, String) {
    let s_limit = ((core.n_lu as f64) - (n_ld as f64)) * 0.6;
    let s_limit = s_limit.clamp(-25.0, 25.0);
    let breadth_score = if total > 0 {
        (up as f64 - down as f64) / total as f64 * 25.0
    } else {
        0.0
    };
    let s_broken = -core.broken_rate * 0.25;
    let s_height = ((core.max_boards as f64) - 1.0).max(0.0).min(8.0) * 1.5;
    let sentiment = (50.0 + s_limit + breadth_score + s_broken + s_height).clamp(2.0, 99.0);
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
    (sentiment, mood.to_string())
}

// 从跌停池 ZtStock 转 StockBrief
fn dt_to_brief(dt: &super::eastmoney::ZtPool) -> Vec<StockBrief> {
    let mut v: Vec<StockBrief> = dt
        .list
        .iter()
        .map(|s| StockBrief {
            code: s.code.clone(),
            name: s.name.clone(),
            price: s.price,
            pct: s.pct,
        })
        .collect();
    v.sort_by(|a, b| a.pct.partial_cmp(&b.pct).unwrap_or(std::cmp::Ordering::Equal));
    v
}

// ===== 快速扫描：涨停/炸板/跌停三池（并发，<1秒），全市场宽度留空 =====
async fn scan_fast(
    trading: bool,
) -> (
    RadarData,
    super::eastmoney::ZtPool,
    super::eastmoney::ZtPool,
    super::eastmoney::ZtPool,
) {
    let (zt, zb, dt) = fetch_pools().await;
    let core = build_limit_core(&zt, &zb);
    let limit_down = dt_to_brief(&dt);
    let n_ld = limit_down.len();
    let (sentiment, mood) = sentiment_from(&core, n_ld, 0, 0, 0);

    let data = RadarData {
        trading,
        updated: now_millis(),
        total: 0,
        up_count: 0,
        down_count: 0,
        flat_count: 0,
        limit_up: core.n_lu,
        limit_down: n_ld,
        broken: core.n_br,
        broken_rate: core.broken_rate,
        max_boards: core.max_boards,
        sentiment,
        mood,
        hist: vec![0usize; 10],
        ladder: core.ladder.clone(),
        limit_up_list: core.lu_stocks.clone(),
        broken_list: core.broken.clone(),
        limit_down_list: limit_down,
    };
    (data, zt, zb, dt)
}

// ===== 完整扫描：在快速数据基础上补充全市场宽度（涨跌家数/分布） =====
async fn scan_full(
    trading: bool,
    zt: super::eastmoney::ZtPool,
    zb: super::eastmoney::ZtPool,
    dt: super::eastmoney::ZtPool,
) -> RadarData {
    let core = build_limit_core(&zt, &zb);
    let limit_down = dt_to_brief(&dt);
    let n_ld = limit_down.len();
    let all = super::eastmoney::market_breadth().await.unwrap_or_default();

    let mut up = 0usize;
    let mut down = 0usize;
    let mut flat = 0usize;
    let mut hist = vec![0usize; 10];

    for q in &all {
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
        hist[hist_bucket(q.pct)] += 1;
    }

    let total = up + down + flat;
    let (sentiment, mood) = sentiment_from(&core, n_ld, total, up, down);

    RadarData {
        trading,
        updated: now_millis(),
        total,
        up_count: up,
        down_count: down,
        flat_count: flat,
        limit_up: core.n_lu,
        limit_down: n_ld,
        broken: core.n_br,
        broken_rate: core.broken_rate,
        max_boards: core.max_boards,
        sentiment,
        mood,
        hist,
        ladder: core.ladder,
        limit_up_list: core.lu_stocks,
        broken_list: core.broken,
        limit_down_list: limit_down,
    }
}

// ===== 后台主循环：分两阶段 emit =====
pub async fn run_loop(app: AppHandle, ctl: Arc<LimitRadar>) {
    while ctl.running.load(Ordering::Acquire) {
        let trading = is_trading_time();
        // 阶段1：快速数据（涨停/炸板/连板，<1秒）
        let _ = app.emit(
            "radar:status",
            RadarStatus { scanning: true, trading, time: now_millis() },
        );
        let (fast, zt, zb, dt) = scan_fast(trading).await;
        let _ = app.emit("radar:data", fast);
        // 阶段2：补充全市场宽度（3-5秒）
        let full = scan_full(trading, zt, zb, dt).await;
        let _ = app.emit("radar:data", full);
        let _ = app.emit(
            "radar:status",
            RadarStatus { scanning: false, trading, time: now_millis() },
        );
        // 交易时段约 1 分钟一轮，非交易时段 5 分钟一轮
        let wait = if trading { 55 } else { 300 };
        for _ in 0..wait {
            if !ctl.running.load(Ordering::Acquire) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}
