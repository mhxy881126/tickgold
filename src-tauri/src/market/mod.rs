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
    // 扩展字段（腾讯批量行情提供，用于条件选股；其他源缺省为 0）
    pub turnover: f64,     // 换手率 %
    pub pe: f64,           // 市盈率
    pub pb: f64,           // 市净率
    pub amplitude: f64,    // 振幅 %
    pub volume_ratio: f64, // 量比
    pub circ_mv: f64,      // 流通市值（亿元）
    pub total_mv: f64,     // 总市值（亿元）
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

/// 五档盘口
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrderLevel {
    pub price: f64,
    pub vol: f64,
}
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrderBook {
    pub name: String,
    pub code: String,
    pub price: f64,
    pub prev_close: f64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub volume: f64,
    pub amount: f64,
    pub asks: Vec<OrderLevel>,
    pub bids: Vec<OrderLevel>,
}

/// 单档资金（特大 / 大 / 中 / 小单）
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FundLevel {
    pub name: String,
    pub net: f64, // 净流入（元）
    pub in_flow: f64,
    pub out_flow: f64,
}
/// 个股当日资金流向
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FundFlow {
    pub code: String,
    pub name: String,
    pub main_net: f64, // 主力（特大+大单）净流入
    pub main_in: f64,
    pub main_out: f64,
    pub main_net_pct: f64,
    pub retail_net: f64, // 散户（中+小单）净流入
    pub retail_in: f64,
    pub retail_out: f64,
    pub retail_net_pct: f64,
    pub net_amount: f64, // 全部净流入
    pub levels: Vec<FundLevel>,
}

/// 板块（行业 / 概念）
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Sector {
    pub code: String, // category，如 new_swzz / gn_jycx
    pub name: String,
    pub change_pct: f64, // 板块平均涨跌幅 %
    pub net_amount: f64, // 净流入（元）
    pub in_amount: f64,
    pub out_amount: f64,
    pub lead_code: String, // 领涨股
    pub lead_name: String,
    pub lead_pct: f64, // 领涨股涨幅 %
}

/// 条件选股过滤器（区间为 None 表示不限）
#[derive(Deserialize, Debug, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct ScreenFilter {
    pub price_min: Option<f64>,
    pub price_max: Option<f64>,
    pub pct_min: Option<f64>,
    pub pct_max: Option<f64>,
    pub turnover_min: Option<f64>,
    pub turnover_max: Option<f64>,
    pub vr_min: Option<f64>,
    pub vr_max: Option<f64>,
    pub pe_min: Option<f64>,
    pub pe_max: Option<f64>,
    pub pb_min: Option<f64>,
    pub pb_max: Option<f64>,
    pub mcap_min: Option<f64>, // 流通市值（亿）
    pub mcap_max: Option<f64>,
    pub amp_min: Option<f64>, // 振幅 %
    pub amp_max: Option<f64>,
    pub ma_bull: bool,    // 均线多头排列
    pub macd_golden: bool, // MACD 金叉
    pub volume_up: bool,  // 放量上涨
    pub breakout: bool,   // 突破新高
    pub above_ma20: bool, // 站上 20 日线
    pub limit: i64,
}
impl Default for ScreenFilter {
    fn default() -> Self {
        ScreenFilter {
            price_min: None,
            price_max: None,
            pct_min: None,
            pct_max: None,
            turnover_min: None,
            turnover_max: None,
            vr_min: None,
            vr_max: None,
            pe_min: None,
            pe_max: None,
            pb_min: None,
            pb_max: None,
            mcap_min: None,
            mcap_max: None,
            amp_min: None,
            amp_max: None,
            ma_bull: false,
            macd_golden: false,
            volume_up: false,
            breakout: false,
            above_ma20: false,
            limit: 50,
        }
    }
}

/// 选股结果（Quote 字段平铺 + 命中的技术信号）
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScreenResult {
    #[serde(flatten)]
    pub quote: Quote,
    pub signals: Vec<String>,
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

/// 五档盘口：腾讯
pub async fn get_orderbook(code: String) -> Result<OrderBook, String> {
    tokio::time::timeout(Duration::from_secs(QUOTE_TIMEOUT), tencent::orderbook(&code))
        .await
        .map_err(|_| "盘口: 超时".to_string())?
}

/// 资金流向：新浪（当日实时，特大/大/中/小单）
pub async fn get_fund_flow(code: String) -> Result<FundFlow, String> {
    tokio::time::timeout(Duration::from_secs(QUOTE_TIMEOUT), sina::fund_flow(&code))
        .await
        .map_err(|_| "资金流向: 超时".to_string())?
}

/// 板块行情：新浪（kind: industry=行业, concept=概念）
pub async fn get_sectors(kind: String) -> Result<Vec<Sector>, String> {
    tokio::time::timeout(Duration::from_secs(KLINE_TIMEOUT), sina::sectors(&kind))
        .await
        .map_err(|_| "板块: 超时".to_string())?
}

/// 当日分时：腾讯
pub async fn get_minute(code: String) -> Result<Vec<KBar>, String> {
    tokio::time::timeout(Duration::from_secs(KLINE_TIMEOUT), tencent::minute(&code))
        .await
        .map_err(|_| "分时: 超时".to_string())?
}

/// 热门股池（沪深300成分股精选，用于本地榜单）
const HOT_CODES: &[&str] = &[
    "600519","601318","600036","601166","600276","600030","601398","601288","601988","601939",
    "000858","000333","002594","300750","600031","601899","600900","601012","600887","000001",
    "000002","002415","000651","600030","601688","600999","601628","601318","601601","600036",
    "300059","300015","300033","300124","002475","002230","000063","002304","600585","601888",
    "600009","601111","600029","600104","601668","601800","601390","601186","600018","601006",
    "600016","600015","601328","600000","601998","601169","601009","601229","600919","601838",
    "000001","002142","600919","601077","600926","601128","601528","600908","601860","601009",
    "600585","601919","600019","601005","600022","600569","600231","000898","000709","000932",
    "601600","600362","601899","600547","600489","600711","000630","000878","002460","002466",
    "300750","300014","002594","600884","601012","600438","601877","002129","600732","002056",
];

/// 榜单（全市场沪深京 A 股，分页）：sort = gainers/losers/amount，page 从 1 开始
pub async fn get_rank_page(sort: String, page: i64, num: i64) -> Result<Vec<Quote>, String> {
    tokio::time::timeout(
        Duration::from_secs(KLINE_TIMEOUT),
        sina::rank_page(&sort, page, num),
    )
    .await
    .map_err(|_| "榜单: 超时".to_string())?
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

// ===== 条件选股 =====

fn in_range(v: f64, lo: Option<f64>, hi: Option<f64>) -> bool {
    if let Some(l) = lo {
        if v < l {
            return false;
        }
    }
    if let Some(h) = hi {
        if v > h {
            return false;
        }
    }
    true
}

/// 基本面 / 当日行情条件（批量字段，本地即时筛选）
fn basic_match(q: &Quote, f: &ScreenFilter) -> bool {
    in_range(q.price, f.price_min, f.price_max)
        && in_range(q.pct, f.pct_min, f.pct_max)
        && in_range(q.turnover, f.turnover_min, f.turnover_max)
        && in_range(q.volume_ratio, f.vr_min, f.vr_max)
        && in_range(q.pe, f.pe_min, f.pe_max)
        && in_range(q.pb, f.pb_min, f.pb_max)
        && in_range(q.circ_mv, f.mcap_min, f.mcap_max)
        && in_range(q.amplitude, f.amp_min, f.amp_max)
}

// —— 技术指标 ——
fn sma(v: &[f64], n: usize) -> f64 {
    if v.len() < n {
        return 0.0;
    }
    v[v.len() - n..].iter().sum::<f64>() / n as f64
}
fn ema_series(v: &[f64], n: usize) -> Vec<f64> {
    if v.is_empty() {
        return vec![];
    }
    let k = 2.0 / (n as f64 + 1.0);
    let mut out = Vec::with_capacity(v.len());
    let mut e = v[0];
    out.push(e);
    for &x in &v[1..] {
        e = x * k + e * (1.0 - k);
        out.push(e);
    }
    out
}
fn closes(bars: &[KBar]) -> Vec<f64> {
    bars.iter().map(|b| b.close).collect()
}

/// 均线多头排列：MA5>MA10>MA20>MA30 且股价站上 MA5
fn signal_ma_bull(bars: &[KBar]) -> bool {
    if bars.len() < 31 {
        return false;
    }
    let c = closes(bars);
    let ma5 = sma(&c, 5);
    let ma10 = sma(&c, 10);
    let ma20 = sma(&c, 20);
    let ma30 = sma(&c, 30);
    ma5 > ma10 && ma10 > ma20 && ma20 > ma30 && *c.last().unwrap() > ma5
}

/// MACD 金叉：近 3 日内 DIF 上穿 DEA
fn signal_macd(bars: &[KBar]) -> bool {
    if bars.len() < 35 {
        return false;
    }
    let c = closes(bars);
    let e12 = ema_series(&c, 12);
    let e26 = ema_series(&c, 26);
    let dif: Vec<f64> = e12.iter().zip(e26).map(|(a, b)| a - b).collect();
    let dea = ema_series(&dif, 9);
    let n = dif.len();
    for i in (n - 3)..n {
        if i > 0 && dif[i] > dea[i] && dif[i - 1] <= dea[i - 1] {
            return true;
        }
    }
    false
}

/// 放量上涨：今日量 > 5 日均量 ×1.5，且收阳、收盘价高于昨日
fn signal_volume_up(bars: &[KBar]) -> bool {
    let n = bars.len();
    if n < 7 {
        return false;
    }
    let today = &bars[n - 1];
    let prev_vol = bars[n - 6..n - 1].iter().map(|b| b.volume).sum::<f64>() / 5.0;
    today.volume > prev_vol * 1.5 && today.close > today.open && today.close > bars[n - 2].close
}

/// 突破新高：今日收盘 ≥ 近 20 日（不含今日）最高价
fn signal_breakout(bars: &[KBar]) -> bool {
    let n = bars.len();
    if n < 21 {
        return false;
    }
    let recent_high = bars[n - 21..n - 1]
        .iter()
        .map(|b| b.high)
        .fold(f64::MIN, f64::max);
    bars[n - 1].close >= recent_high
}

/// 站上 20 日均线
fn signal_above_ma20(bars: &[KBar]) -> bool {
    if bars.len() < 21 {
        return false;
    }
    let c = closes(bars);
    *c.last().unwrap() > sma(&c, 20)
}

/// 条件选股：股池批量行情 → 基础筛选 → （可选）并发拉日K做技术形态筛选
pub async fn get_screener(f: ScreenFilter) -> Result<Vec<ScreenResult>, String> {
    // 股池（去重）
    let mut codes: Vec<String> = HOT_CODES.iter().map(|s| s.to_string()).collect();
    codes.sort();
    codes.dedup();

    let quotes = tokio::time::timeout(
        Duration::from_secs(QUOTE_TIMEOUT),
        tencent::quotes(&codes),
    )
    .await
    .map_err(|_| "选股: 行情超时".to_string())??;

    let candidates: Vec<Quote> = quotes.into_iter().filter(|q| basic_match(q, &f)).collect();

    let need = f.ma_bull as usize
        + f.macd_golden as usize
        + f.volume_up as usize
        + f.breakout as usize
        + f.above_ma20 as usize;

    let mut results: Vec<ScreenResult> = Vec::new();

    if need == 0 {
        for q in candidates {
            results.push(ScreenResult {
                quote: q,
                signals: vec![],
            });
        }
    } else {
        // 对候选并发拉日K（近 70 日），并发上限 8
        use std::sync::Arc;
        use tokio::sync::Semaphore;
        use tokio::task::JoinSet;
        let sem = Arc::new(Semaphore::new(8));
        let mut set = JoinSet::new();
        for q in candidates {
            let permit = sem.clone().acquire_owned().await.map_err(|e| e.to_string())?;
            set.spawn(async move {
                let _p = permit;
                let r = tencent::kline(&q.code, 101, 70).await;
                (q, r)
            });
        }
        while let Some(joined) = set.join_next().await {
            let (q, r) = joined.map_err(|e| e.to_string())?;
            let bars = match r {
                Ok(b) => b,
                Err(_) => continue,
            };
            let mut sigs: Vec<String> = Vec::new();
            if f.ma_bull && signal_ma_bull(&bars) {
                sigs.push("均线多头".to_string());
            }
            if f.macd_golden && signal_macd(&bars) {
                sigs.push("MACD金叉".to_string());
            }
            if f.volume_up && signal_volume_up(&bars) {
                sigs.push("放量上涨".to_string());
            }
            if f.breakout && signal_breakout(&bars) {
                sigs.push("突破新高".to_string());
            }
            if f.above_ma20 && signal_above_ma20(&bars) {
                sigs.push("站上20日线".to_string());
            }
            // 勾选的技术条件必须全部满足（AND）
            if sigs.len() == need {
                results.push(ScreenResult {
                    quote: q,
                    signals: sigs,
                });
            }
        }
    }

    results.sort_by(|a, b| b.quote.pct.partial_cmp(&a.quote.pct).unwrap());
    results.truncate(f.limit.max(1) as usize);
    if results.is_empty() {
        return Err("没有股票满足所选条件，请放宽条件后重试".to_string());
    }
    Ok(results)
}
