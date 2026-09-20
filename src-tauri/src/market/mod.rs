// 行情数据聚合层：东方财富 / 新浪 / 腾讯 三源容灾。
// 调度策略：按优先级逐源尝试（单源超时、返回空或异常即切下一源），并带轻量熔断。
pub mod eastmoney;
pub mod sina;
pub mod tencent;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub change: f64,
    pub pct: f64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    #[serde(rename = "prevClose")]
    pub prev_close: f64,
    pub volume: f64,
    pub amount: f64,
    pub time: i64,
    pub source: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KBar {
    pub timestamp: i64,
    pub open: f64,
    pub close: f64,
    pub high: f64,
    pub low: f64,
    pub volume: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StockItem {
    pub code: String,
    pub name: String,
    pub market: String, // SH / SZ / BJ
}

const QUOTE_TIMEOUT: u64 = 5;
const KLINE_TIMEOUT: u64 = 8;

/// 共享 HTTP 客户端（不在此设全局 timeout，由 tokio timeout 精细控制）
pub fn http() -> Client {
    Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
        .unwrap_or_default()
}

/// 东财 secid 前缀：6/9/5 开头沪市=1，其余=0
pub fn secid_prefix(code: &str) -> &'static str {
    match code.chars().next().unwrap_or('0') {
        '6' | '9' | '5' => "1",
        _ => "0",
    }
}

/// 新浪/腾讯 symbol：6/9/5=sh，4/8=bj（北交所），其余=sz
pub fn cnc_symbol(code: &str) -> String {
    let prefix = match code.chars().next().unwrap_or('0') {
        '6' | '9' | '5' => "sh",
        '4' | '8' => "bj",
        _ => "sz",
    };
    format!("{}{}", prefix, code)
}

pub fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ===== 轻量熔断：连续失败≥2 的源熔断 30s =====
#[derive(Clone, Copy)]
struct Health {
    fails: u32,
    since: Instant,
}
fn health_store() -> &'static Mutex<HashMap<String, Health>> {
    static H: OnceLock<Mutex<HashMap<String, Health>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(HashMap::new()))
}
/// 该源当前是否允许尝试
fn is_open(src: &str) -> bool {
    let m = health_store().lock().unwrap();
    match m.get(src) {
        Some(h) if h.fails >= 2 && h.since.elapsed() < Duration::from_secs(30) => false,
        _ => true,
    }
}
fn record_fail(src: &str) {
    let mut m = health_store().lock().unwrap();
    let e = m.entry(src.to_string()).or_insert(Health {
        fails: 0,
        since: Instant::now(),
    });
    e.fails += 1;
    e.since = Instant::now();
}
fn record_ok(src: &str) {
    let mut m = health_store().lock().unwrap();
    if let Some(e) = m.get_mut(src) {
        e.fails = 0;
    }
}

fn valid_quotes(v: &[Quote]) -> bool {
    !v.is_empty() && v.iter().any(|q| q.price > 0.0)
}

/// 批量实时行情：东财 → 新浪 → 腾讯
pub async fn get_quotes(codes: Vec<String>) -> Result<Vec<Quote>, String> {
    if codes.is_empty() {
        return Ok(vec![]);
    }
    let mut last_err = String::from("所有行情源均不可用");

    if is_open("eastmoney") {
        match tokio::time::timeout(
            Duration::from_secs(QUOTE_TIMEOUT),
            eastmoney::quotes(&codes),
        )
        .await
        {
            Ok(Ok(v)) if valid_quotes(&v) => {
                record_ok("eastmoney");
                return Ok(v);
            }
            Ok(Ok(_)) => record_fail("eastmoney"),
            Ok(Err(e)) => {
                record_fail("eastmoney");
                last_err = format!("东财: {e}");
            }
            Err(_) => {
                record_fail("eastmoney");
                last_err = "东财: 超时".to_string();
            }
        }
    }

    if is_open("sina") {
        match tokio::time::timeout(Duration::from_secs(QUOTE_TIMEOUT), sina::quotes(&codes)).await {
            Ok(Ok(v)) if valid_quotes(&v) => {
                record_ok("sina");
                return Ok(v);
            }
            Ok(Ok(_)) => record_fail("sina"),
            Ok(Err(e)) => {
                record_fail("sina");
                last_err = format!("新浪: {e}");
            }
            Err(_) => {
                record_fail("sina");
                last_err = "新浪: 超时".to_string();
            }
        }
    }

    match tokio::time::timeout(Duration::from_secs(QUOTE_TIMEOUT), tencent::quotes(&codes)).await {
        Ok(Ok(v)) if valid_quotes(&v) => {
            record_ok("tencent");
            Ok(v)
        }
        Ok(Ok(_)) => Err("腾讯: 返回空".to_string()),
        Ok(Err(e)) => Err(format!("全部失败 → {last_err}; 腾讯: {e}")),
        Err(_) => Err(format!("全部失败 → {last_err}; 腾讯: 超时")),
    }
}

/// K线：新浪 → 腾讯（东财 push2his 已知不可达，不作为源）
pub async fn get_kline(code: String, period: i64, count: i64) -> Result<Vec<KBar>, String> {
    let mut last_err = String::from("K线源均不可用");

    if is_open("sina_kline") {
        match tokio::time::timeout(
            Duration::from_secs(KLINE_TIMEOUT),
            sina::kline(&code, period, count),
        )
        .await
        {
            Ok(Ok(v)) if !v.is_empty() => {
                record_ok("sina_kline");
                return Ok(v);
            }
            Ok(Ok(_)) => record_fail("sina_kline"),
            Ok(Err(e)) => {
                record_fail("sina_kline");
                last_err = format!("新浪: {e}");
            }
            Err(_) => {
                record_fail("sina_kline");
                last_err = "新浪: 超时".to_string();
            }
        }
    }

    match tokio::time::timeout(
        Duration::from_secs(KLINE_TIMEOUT),
        tencent::kline(&code, period, count),
    )
    .await
    {
        Ok(Ok(v)) if !v.is_empty() => {
            record_ok("tencent_kline");
            Ok(v)
        }
        Ok(Ok(_)) => Err("腾讯: 返回空".to_string()),
        Ok(Err(e)) => Err(format!("K线全部失败 → {last_err}; 腾讯: {e}")),
        Err(_) => Err(format!("K线全部失败 → {last_err}; 腾讯: 超时")),
    }
}

/// 榜单：gainers / losers / amount，默认东财
pub async fn get_rank(sort: String, pz: i64) -> Result<Vec<Quote>, String> {
    match tokio::time::timeout(
        Duration::from_secs(QUOTE_TIMEOUT),
        eastmoney::rank(&sort, pz),
    )
    .await
    {
        Ok(Ok(v)) if valid_quotes(&v) => Ok(v),
        Ok(Ok(_)) => Ok(vec![]),
        Ok(Err(e)) => Err(format!("东财榜单: {e}")),
        Err(_) => Err("东财榜单: 超时".to_string()),
    }
}

/// 大盘指数行情：东财为主，失败静默返回空（指数非核心，不弹错）
pub async fn get_index_quotes() -> Result<Vec<Quote>, String> {
    if is_open("eastmoney_idx") {
        match tokio::time::timeout(
            Duration::from_secs(QUOTE_TIMEOUT),
            eastmoney::index_quotes(),
        )
        .await
        {
            Ok(Ok(v)) if valid_quotes(&v) => {
                record_ok("eastmoney_idx");
                return Ok(v);
            }
            _ => record_fail("eastmoney_idx"),
        }
    }
    Ok(vec![])
}

/// 搜索：东财 → 腾讯
pub async fn search_stocks(keyword: String) -> Result<Vec<StockItem>, String> {
    if !keyword.trim().is_empty() {
        if is_open("eastmoney_search") {
            if let Ok(Ok(v)) = tokio::time::timeout(
                Duration::from_secs(QUOTE_TIMEOUT),
                eastmoney::search(&keyword),
            )
            .await
            {
                if !v.is_empty() {
                    record_ok("eastmoney_search");
                    return Ok(v);
                }
                record_fail("eastmoney_search");
            } else {
                record_fail("eastmoney_search");
            }
        }
    }
    match tencent::search(&keyword).await {
        Ok(v) if !v.is_empty() => Ok(v),
        Ok(_) => Err("未找到匹配股票".to_string()),
        Err(e) => Err(format!("搜索失败: {e}")),
    }
}
