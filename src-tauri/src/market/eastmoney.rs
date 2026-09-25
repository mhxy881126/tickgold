// 东方财富数据源：批量实时行情 + 股票搜索
use super::{
    http, http_permit, now_millis, secid_prefix, OrderBook, OrderLevel, Quote, StockItem, TradeTick,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
struct ListResp {
    data: Option<ListData>,
}
#[derive(Deserialize)]
struct ListData {
    total: Option<i64>,
    diff: Option<Vec<EmQuote>>,
}
#[derive(Deserialize)]
struct EmQuote {
    #[serde(rename = "f12")]
    code: String,
    #[serde(rename = "f14")]
    name: String,
    // 东财停牌/无数据时这些字段可能是 "-" 或 null；fields 裁剪时字段可能整体缺失，
    // 统一用 default（缺失即 Null → nf 取 0），避免反序列化整体失败。
    #[serde(rename = "f2", default)]
    price: Value,
    #[serde(rename = "f3", default)]
    pct: Value,
    #[serde(rename = "f4", default)]
    change: Value,
    #[serde(rename = "f5", default)]
    volume: Value,
    #[serde(rename = "f6", default)]
    amount: Value,
    #[serde(rename = "f15", default)]
    high: Value,
    #[serde(rename = "f16", default)]
    low: Value,
    #[serde(rename = "f17", default)]
    open: Value,
    #[serde(rename = "f18", default)]
    prev_close: Value,
}

/// 东财字段宽容转 f64：数字直接取，"-"/null/字符串一律 0
fn nf(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

pub async fn quotes(codes: &[String]) -> Result<Vec<Quote>, String> {
    let secids: Vec<String> = codes
        .iter()
        .map(|c| format!("{}.{}", secid_prefix(c), c))
        .collect();
    let url = format!(
        "http://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14,f2,f3,f4,f5,f6,f15,f16,f17,f18&secids={}",
        secids.join(",")
    );
    let resp = http()
        .get(&url)
        .header("Referer", "https://quote.eastmoney.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: ListResp = resp.json().await.map_err(|e| e.to_string())?;
    let now = now_millis();
    let out = json
        .data
        .and_then(|d| d.diff)
        .unwrap_or_default()
        .into_iter()
        .map(|q| Quote {
            code: q.code,
            name: q.name,
            price: nf(&q.price),
            change: nf(&q.change),
            pct: nf(&q.pct),
            open: nf(&q.open),
            high: nf(&q.high),
            low: nf(&q.low),
            prev_close: nf(&q.prev_close),
            volume: nf(&q.volume),
            amount: nf(&q.amount),
            time: now,
            source: "eastmoney".to_string(),
            turnover: 0.0,
            pe: 0.0,
            pb: 0.0,
            amplitude: 0.0,
            volume_ratio: 0.0,
            circ_mv: 0.0,
            total_mv: 0.0,
        })
        .collect();
    Ok(out)
}

#[derive(Deserialize)]
struct SearchResp {
    #[serde(rename = "QuotationCodeTable")]
    table: Option<SearchTable>,
}
#[derive(Deserialize)]
struct SearchTable {
    data: Option<Vec<SearchItem>>,
}
#[derive(Deserialize)]
struct SearchItem {
    #[serde(rename = "CodeName")]
    name: String,
    #[serde(rename = "Code")]
    code: String,
    #[serde(rename = "MktNum")]
    mkt: String,
}

pub async fn search(keyword: &str) -> Result<Vec<StockItem>, String> {
    let url = format!(
        "https://searchapi.eastmoney.com/api/suggest/get?input={}&type=14&count=10",
        urlencode(keyword)
    );
    let resp = http()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: SearchResp = resp.json().await.map_err(|e| e.to_string())?;
    let out = json
        .table
        .and_then(|t| t.data)
        .unwrap_or_default()
        .into_iter()
        .filter(|i| i.code.chars().all(|c| c.is_ascii_digit()) && i.code.len() == 6)
        .map(|i| StockItem {
            market: match i.mkt.as_str() {
                "1" => "SH",
                "0" => "SZ",
                _ => "BJ",
            }
            .to_string(),
            code: i.code,
            name: i.name,
        })
        .collect();
    Ok(out)
}

/// 榜单：gainers=涨幅榜 losers=跌幅榜 amount=成交额榜（沪深 A 股）
pub async fn rank(sort: &str, pz: i64) -> Result<Vec<Quote>, String> {
    let (fid, po) = match sort {
        "losers" => ("f3", 0),  // 按涨跌幅升序
        "amount" => ("f6", 1),  // 按成交额降序
        _ => ("f3", 1),         // gainers 默认按涨跌幅降序
    };
    let url = format!(
        "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz={pz}&po={po}&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid={fid}&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14,f2,f3,f4,f5,f6,f15,f16,f17,f18"
    );
    let resp = http()
        .get(&url)
        .header("Referer", "https://quote.eastmoney.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: ListResp = resp.json().await.map_err(|e| e.to_string())?;
    let now = now_millis();
    let out = json
        .data
        .and_then(|d| d.diff)
        .unwrap_or_default()
        .into_iter()
        .map(|q| Quote {
            code: q.code,
            name: q.name,
            price: nf(&q.price),
            change: nf(&q.change),
            pct: nf(&q.pct),
            open: nf(&q.open),
            high: nf(&q.high),
            low: nf(&q.low),
            prev_close: nf(&q.prev_close),
            volume: nf(&q.volume),
            amount: nf(&q.amount),
            time: now,
            source: "eastmoney".to_string(),
            turnover: 0.0,
            pe: 0.0,
            pb: 0.0,
            amplitude: 0.0,
            volume_ratio: 0.0,
            circ_mv: 0.0,
            total_mv: 0.0,
        })
        .collect();
    Ok(out)
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 大盘指数行情（固定 secid：上证/深成/创业板/沪深300/科创50）
pub async fn index_quotes() -> Result<Vec<Quote>, String> {
    let secids = ["1.000001", "0.399001", "0.399006", "1.000300", "1.000688"];
    let url = format!(
        "http://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14,f2,f3,f4,f5,f6,f15,f16,f17,f18&secids={}",
        secids.join(",")
    );
    let resp = http()
        .get(&url)
        .header("Referer", "https://quote.eastmoney.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: ListResp = resp.json().await.map_err(|e| e.to_string())?;
    let now = now_millis();
    let out = json
        .data
        .and_then(|d| d.diff)
        .unwrap_or_default()
        .into_iter()
        .map(|q| Quote {
            code: q.code,
            name: q.name,
            price: nf(&q.price),
            change: nf(&q.change),
            pct: nf(&q.pct),
            open: nf(&q.open),
            high: nf(&q.high),
            low: nf(&q.low),
            prev_close: nf(&q.prev_close),
            volume: nf(&q.volume),
            amount: nf(&q.amount),
            time: now,
            source: "eastmoney".to_string(),
            turnover: 0.0,
            pe: 0.0,
            pb: 0.0,
            amplitude: 0.0,
            volume_ratio: 0.0,
            circ_mv: 0.0,
            total_mv: 0.0,
        })
        .collect();
    Ok(out)
}

// ===== 全市场限售解禁一览（东财数据中心 RPT_LIFT_STAGE）=====
#[derive(serde::Serialize)]
pub struct MarketRestricted {
    pub code: String,
    pub name: String,
    pub date: String,
    pub type_name: String,
    pub shares: f64,       // 实际解禁数量（万股）
    pub able_shares: f64,  // 解禁数量（万股）
    pub market_cap: f64,   // 实际解禁市值（万元）
    pub free_ratio: f64,   // 占解禁前流通市值比例（%）
}

#[derive(serde::Serialize)]
pub struct MarketRestrictedPage {
    pub total: i64,
    pub pages: i64,
    pub data: Vec<MarketRestricted>,
}

#[derive(Deserialize)]
struct LiftResp {
    result: Option<LiftResult>,
}
#[derive(Deserialize)]
struct LiftResult {
    count: Option<i64>,
    pages: Option<i64>,
    data: Option<Vec<LiftItem>>,
}
#[derive(Deserialize)]
struct LiftItem {
    #[serde(rename = "SECURITY_CODE")]
    code: String,
    #[serde(rename = "SECURITY_NAME_ABBR")]
    name: String,
    #[serde(rename = "FREE_DATE")]
    date: Option<String>,
    #[serde(rename = "FREE_SHARES_TYPE")]
    type_name: Option<String>,
    #[serde(rename = "CURRENT_FREE_SHARES")]
    shares: Option<f64>,
    #[serde(rename = "ABLE_FREE_SHARES")]
    able_shares: Option<f64>,
    #[serde(rename = "LIFT_MARKET_CAP")]
    market_cap: Option<f64>,
    #[serde(rename = "FREE_RATIO")]
    free_ratio: Option<f64>,
}

/// 全市场限售解禁明细（按日期范围分页）。start/end 格式 "YYYY-MM-DD"。
pub async fn market_restricted(
    start: &str,
    end: &str,
    page: i64,
    size: i64,
) -> Result<MarketRestrictedPage, String> {
    // > 需百分号编码为 %3E；单引号与括号在 query 中合法
    let filter = format!("(FREE_DATE%3E='{}')(FREE_DATE%3E='{}')", start, end);
    let columns = "SECURITY_CODE,SECURITY_NAME_ABBR,FREE_DATE,CURRENT_FREE_SHARES,ABLE_FREE_SHARES,LIFT_MARKET_CAP,FREE_RATIO,NEW,B20_ADJCHRATE,A20_ADJCHRATE,FREE_SHARES_TYPE,TOTAL_RATIO,NON_FREE_SHARES,BATCH_HOLDER_NUM";
    let url = format!(
        "https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=FREE_DATE,CURRENT_FREE_SHARES&sortTypes=1,1&pageSize={}&pageNumber={}&reportName=RPT_LIFT_STAGE&columns={}&source=WEB&client=WEB&filter={}",
        size, page, columns, filter
    );
    let resp = http()
        .get(&url)
        .header("Referer", "https://data.eastmoney.com/dxf/detail.html")
        .header("Accept", "application/json, text/plain, */*")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: LiftResp = resp.json().await.map_err(|e| e.to_string())?;
    let total = json.result.as_ref().and_then(|r| r.count).unwrap_or(0);
    let pages = json.result.as_ref().and_then(|r| r.pages).unwrap_or(0);
    let data = json
        .result
        .and_then(|r| r.data)
        .unwrap_or_default()
        .into_iter()
        .map(|it| {
            let raw_date = it.date.unwrap_or_default();
            let date = if raw_date.len() >= 10 {
                raw_date[..10].to_string()
            } else {
                raw_date
            };
            MarketRestricted {
                code: it.code,
                name: it.name,
                date,
                type_name: it.type_name.unwrap_or_default(),
                shares: it.shares.unwrap_or(0.0),
                able_shares: it.able_shares.unwrap_or(0.0),
                market_cap: it.market_cap.unwrap_or(0.0),
                free_ratio: it.free_ratio.unwrap_or(0.0),
            }
        })
        .collect();
    Ok(MarketRestrictedPage { total, pages, data })
}

// ===== 涨停板专题池（涨停 / 炸板，push2ex）=====
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ZtStock {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub pct: f64,
    pub amount: f64,
    pub fund: f64,        // 封单金额（元），炸板为 0
    pub boards: u32,      // 连板数
    pub first_seal: i64,  // 首次封板时间（如 93105）
    pub last_seal: i64,   // 最后封板时间
    pub broken: u32,      // 炸板次数
    pub turnover: f64,    // 换手率 %
    pub industry: String, // 所属行业
    pub stat_days: u32,   // N 天
    pub stat_count: u32,  // M 板（N 天 M 板）
    pub limit_price: f64, // 涨停价
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ZtPool {
    pub date: String,
    pub total: usize,
    pub list: Vec<ZtStock>,
}

#[derive(Deserialize)]
struct TopicResp {
    data: Option<TopicData>,
}
#[derive(Deserialize)]
struct TopicData {
    pool: Option<Vec<Value>>,
}

// Value 字段宽容取值
fn vf(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
}
fn vi(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(|x| x.as_i64()).unwrap_or(0)
}
fn vs2(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// 拉取专题池原始数据（涨停 getTopicZTPool / 炸板 getTopicZBPool）
async fn topic_pool(endpoint: &str, date: &str) -> Result<Vec<Value>, String> {
    let ut = "7eea3edcaed734bea9cbfc24409ed989";
    let url = format!(
        "https://push2ex.eastmoney.com/{}?ut={}&dpt=wz.ztzt&Pageindex=0&pagesize=2000&sort=fbt%3Aasc&date={}&_={}",
        endpoint, ut, date, now_millis()
    );
    let resp = http()
        .get(&url)
        .header("Referer", "https://quote.eastmoney.com/ztb/detail")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let j: TopicResp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(j.data.and_then(|d| d.pool).unwrap_or_default())
}

/// 涨停池（按连板数降序、首封时间升序）
pub async fn zt_pool(date: &str) -> Result<ZtPool, String> {
    let pool = topic_pool("getTopicZTPool", date).await?;
    let mut list: Vec<ZtStock> = pool
        .iter()
        .map(|v| {
            let zttj = v.get("zttj").cloned().unwrap_or(Value::Null);
            ZtStock {
                code: vs2(v, "c"),
                name: vs2(v, "n"),
                price: vf(v, "p") / 1000.0,
                pct: vf(v, "zdp"),
                amount: vf(v, "amount"),
                fund: vf(v, "fund"),
                boards: vi(v, "lbc") as u32,
                first_seal: vi(v, "fbt"),
                last_seal: vi(v, "lbt"),
                broken: vi(v, "zbc") as u32,
                turnover: vf(v, "hs"),
                industry: vs2(v, "hybk"),
                stat_days: zttj.get("days").and_then(|x| x.as_i64()).unwrap_or(0) as u32,
                stat_count: zttj.get("ct").and_then(|x| x.as_i64()).unwrap_or(0) as u32,
                limit_price: vf(v, "p") / 1000.0,
            }
        })
        .collect();
    list.sort_by(|a, b| {
        b.boards
            .cmp(&a.boards)
            .then(a.first_seal.cmp(&b.first_seal))
    });
    let total = list.len();
    Ok(ZtPool {
        date: date.to_string(),
        total,
        list,
    })
}

/// 炸板池（ztp=涨停价，按当前涨跌幅降序）
pub async fn zb_pool(date: &str) -> Result<ZtPool, String> {
    let pool = topic_pool("getTopicZBPool", date).await?;
    let mut list: Vec<ZtStock> = pool
        .iter()
        .map(|v| {
            let zttj = v.get("zttj").cloned().unwrap_or(Value::Null);
            ZtStock {
                code: vs2(v, "c"),
                name: vs2(v, "n"),
                price: vf(v, "p") / 1000.0,
                pct: vf(v, "zdp"),
                amount: vf(v, "amount"),
                fund: 0.0,
                boards: zttj.get("ct").and_then(|x| x.as_i64()).unwrap_or(0) as u32,
                first_seal: vi(v, "fbt"),
                last_seal: 0,
                broken: vi(v, "zbc") as u32,
                turnover: vf(v, "hs"),
                industry: vs2(v, "hybk"),
                stat_days: zttj.get("days").and_then(|x| x.as_i64()).unwrap_or(0) as u32,
                stat_count: zttj.get("ct").and_then(|x| x.as_i64()).unwrap_or(0) as u32,
                limit_price: vf(v, "ztp") / 1000.0,
            }
        })
        .collect();
    list.sort_by(|a, b| b.pct.partial_cmp(&a.pct).unwrap_or(std::cmp::Ordering::Equal));
    let total = list.len();
    Ok(ZtPool {
        date: date.to_string(),
        total,
        list,
    })
}

// ===== 集合竞价（全市场开盘缺口排名，clist 分页）=====
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuctionStock {
    pub code: String,
    pub name: String,
    pub open: f64,
    pub prev_close: f64,
    pub gap: f64,    // 开盘涨幅（缺口）%
    pub amount: f64, // 成交额（9:25 时刻即竞价成交额）
    pub price: f64,
    pub pct: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuctionData {
    pub updated: i64,
    pub total: usize,
    pub high_open: Vec<AuctionStock>, // 高开抢筹榜（缺口降序）
    pub low_open: Vec<AuctionStock>,  // 低开出逃榜（缺口升序）
}

/// push2 clist 主机节点：主域被限流时可在编号镜像间故障转移
/// （东财 push2 为多节点负载，编号子域各自接入，封禁通常不连带）
const CLIST_HOSTS: &[&str] = &[
    "82.push2.eastmoney.com",
    "88.push2.eastmoney.com",
    "29.push2.eastmoney.com",
    "push2.eastmoney.com",
];

/// clist 单页实际请求（pz=100，服务端单页硬上限 100），返回 (全市场总数, 本页行情)。
/// 依次尝试多个 push2 节点，任一返回可解析 JSON 即成功；全部失败才报错。
async fn clist_page_once(fs: &str, pn: i32) -> Result<(i64, Vec<EmQuote>), String> {
    // 全局并发闸门：无论上层几个引擎同时全市场翻页，clist 在途请求总数被统一限制（防请求雪崩）
    let _permit = http_permit().await;
    let mut last = String::new();
    for host in CLIST_HOSTS {
        let url = format!(
            "https://{}/api/qt/clist/get?pn={}&pz=100&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3&fs={}&fields=f12,f14,f17,f18,f6,f2,f3",
            host, pn, fs
        );
        let resp = match http()
            .get(&url)
            .header("Referer", "https://quote.eastmoney.com/")
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last = format!("{}: {}", host, e);
                continue;
            }
        };
        match resp.json::<ListResp>().await {
            Ok(j) => {
                let data = j.data;
                let total = data.as_ref().and_then(|d| d.total).unwrap_or(0);
                let diff = data.and_then(|d| d.diff).unwrap_or_default();
                return Ok((total, diff));
            }
            Err(e) => {
                last = format!("{}: decode {}", host, e);
                continue;
            }
        }
    }
    Err(format!("所有 clist 节点均失败；{}", last))
}

/// clist 单页（带 3 次退避重试，缓解 push2 偶发限流 / 连接重置）
async fn clist_page(fs: &str, pn: i32) -> Result<(i64, Vec<EmQuote>), String> {
    let mut last = String::new();
    for attempt in 0..3u32 {
        match clist_page_once(fs, pn).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = e;
                if attempt < 2 {
                    log::warn!(
                        "clist 第 {pn} 页第 {} 次尝试失败: {last}；指数退避后重试",
                        attempt + 1
                    );
                    // 指数退避（500ms / 1000ms）+ 随页码与时间变化的随机抖动，
                    // 避免一批被限流的请求在固定间隔同时重试、再次撞上限流
                    let base = 500u64 * 2u64.pow(attempt);
                    let jitter = (now_millis().unsigned_abs() / 10)
                        .wrapping_add(pn as u64 * 7919)
                        .wrapping_add(attempt as u64 * 104729)
                        % 200;
                    tokio::time::sleep(std::time::Duration::from_millis(base + jitter)).await;
                }
            }
        }
    }
    log::error!("clist 第 {pn} 页 3 次尝试均失败: {last}");
    Err(last)
}

pub async fn auction() -> Result<AuctionData, String> {
    let fs = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
    // 第 1 页：取全市场总数，计算总页数
    let (total, first) = clist_page(fs, 1).await?;
    let pages = ((total.max(0) + 99) / 100) as i32;
    let mut all: Vec<EmQuote> = first;
    // 其余页：每批 8 个并发，避免一次性约 60 并发触发限流
    let mut pn = 2;
    while pn <= pages {
        let batch_end = (pn + 4).min(pages);
        let mut handles = Vec::new();
        for p in pn..=batch_end {
            let fs_owned = fs.to_string();
            handles.push(tokio::spawn(async move {
                clist_page(&fs_owned, p).await
            }));
        }
        for h in handles {
            let (_, page) = h.await.map_err(|e| e.to_string())??;
            all.extend(page);
        }
        pn = batch_end + 1;
        // 批间小延迟，给服务端喘息，降低整段翻页被限流概率
        if pn <= pages {
            tokio::time::sleep(std::time::Duration::from_millis(180)).await;
        }
    }
    let rows: Vec<AuctionStock> = all
        .iter()
        .filter_map(|q| {
            let pc = nf(&q.prev_close);
            let o = nf(&q.open);
            if pc > 0.0 && o > 0.0 {
                Some(AuctionStock {
                    code: q.code.clone(),
                    name: q.name.clone(),
                    open: o,
                    prev_close: pc,
                    gap: (o - pc) / pc * 100.0,
                    amount: nf(&q.amount),
                    price: nf(&q.price),
                    pct: nf(&q.pct),
                })
            } else {
                None
            }
        })
        .collect();
    let total = rows.len();
    let mut high: Vec<AuctionStock> = rows.iter().filter(|r| r.gap > 0.0).cloned().collect();
    high.sort_by(|a, b| b.gap.partial_cmp(&a.gap).unwrap());
    let mut low: Vec<AuctionStock> = rows.iter().filter(|r| r.gap < 0.0).cloned().collect();
    low.sort_by(|a, b| a.gap.partial_cmp(&b.gap).unwrap());
    Ok(AuctionData {
        updated: now_millis(),
        total,
        high_open: high,
        low_open: low,
    })
}

// ===== 龙虎榜复盘（数据中心：每日个股 + 买卖前五席位）=====
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LhbStock {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub pct: f64,
    pub turnover: f64,
    pub net_amt: f64,   // 龙虎榜净买入（元）
    pub buy_amt: f64,
    pub sell_amt: f64,
    pub deal_amt: f64,  // 龙虎榜成交额（元）
    pub free_mv: f64,   // 流通市值（元）
    pub reasons: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LhbList {
    pub date: String,
    pub total: usize,
    pub stocks: Vec<LhbStock>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LhbSeat {
    pub name: String,      // 营业部名称
    pub code: String,      // 营业部代码
    pub buy: f64,
    pub sell: f64,
    pub net: f64,
    pub buy_ratio: f64,    // 买入占总成交比例 %
    pub sell_ratio: f64,
    pub times3: i64,       // 近 3 日上榜次数
    pub tag: String,       // 知名游资 / 机构 / 北向 标签
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LhbReasonGroup {
    pub reason: String,
    pub buyers: Vec<LhbSeat>,
    pub sellers: Vec<LhbSeat>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LhbDetail {
    pub code: String,
    pub name: String,
    pub date: String,
    pub price: f64,
    pub pct: f64,
    pub groups: Vec<LhbReasonGroup>,
}

/// filter 值百分号编码（保留括号，编码 = ' " 等，避免裸 = 破坏 query 键值）
fn enc_filter(f: &str) -> String {
    let mut out = String::new();
    for b in f.bytes() {
        match b {
            b'(' | b')' | b',' | b'.' | b'_' | b'-' | b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z' => {
                out.push(b as char)
            }
            b'=' => out.push_str("%3D"),
            b'\'' => out.push_str("%27"),
            b'"' => out.push_str("%22"),
            b' ' => out.push_str("%20"),
            b'>' => out.push_str("%3E"),
            b'<' => out.push_str("%3C"),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 数据中心通用 GET，返回 data 数组（宽松 Value 解析）
async fn dc_get(
    report: &str,
    columns: &str,
    filter: &str,
    sort_col: &str,
    sort_type: &str,
    size: i64,
    page: i64,
) -> Result<Vec<Value>, String> {
    let url = format!(
        "https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns={}&sortTypes={}&pageSize={}&pageNumber={}&reportName={}&columns={}&source=WEB&client=WEB&filter={}",
        sort_col, sort_type, size, page, report, columns, filter
    );
    let resp = http()
        .get(&url)
        .header("Referer", "https://data.eastmoney.com/stock/lhb.html")
        .header("Accept", "application/json, text/plain, */*")
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v.get("result")
        .and_then(|r| r.get("data"))
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default())
}

/// 最新一个龙虎榜交易日（YYYY-MM-DD）
async fn latest_lhb_date() -> Result<String, String> {
    let rows = dc_get(
        "RPT_DAILYBILLBOARD_DETAILS", "TRADE_DATE", "",
        "TRADE_DATE", "-1", 1, 1,
    )
    .await?;
    let raw = rows
        .first()
        .and_then(|v| v.get("TRADE_DATE"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    if raw.len() >= 10 {
        Ok(raw[..10].to_string())
    } else {
        Err("暂无龙虎榜数据".to_string())
    }
}

const LHB_COLS: &str = "SECURITY_CODE,SECURITY_NAME_ABBR,CLOSE_PRICE,CHANGE_RATE,TURNOVERRATE,BILLBOARD_NET_AMT,BILLBOARD_BUY_AMT,BILLBOARD_SELL_AMT,BILLBOARD_DEAL_AMT,EXPLANATION,FREE_MARKET_CAP,TRADE_DATE";

/// 当日龙虎榜个股列表（同股多原因去重合并）。date 为空取最新交易日。
pub async fn lhb_list(date: &str) -> Result<LhbList, String> {
    let date = if date.is_empty() {
        latest_lhb_date().await?
    } else {
        date.to_string()
    };
    let filter = enc_filter(&format!("(TRADE_DATE='{}')", date));
    let rows = dc_get(
        "RPT_DAILYBILLBOARD_DETAILS", LHB_COLS, &filter,
        "BILLBOARD_NET_AMT", "-1", 500, 1,
    )
    .await?;

    let mut map: std::collections::BTreeMap<String, LhbStock> = Default::default();
    for v in &rows {
        let code = vs2(v, "SECURITY_CODE");
        if code.is_empty() {
            continue;
        }
        let reason = vs2(v, "EXPLANATION");
        let net = vf(v, "BILLBOARD_NET_AMT");
        let e = map.entry(code.clone()).or_insert_with(|| LhbStock {
            code: code.clone(),
            name: vs2(v, "SECURITY_NAME_ABBR"),
            price: vf(v, "CLOSE_PRICE"),
            pct: vf(v, "CHANGE_RATE"),
            turnover: vf(v, "TURNOVERRATE"),
            net_amt: net,
            buy_amt: vf(v, "BILLBOARD_BUY_AMT"),
            sell_amt: vf(v, "BILLBOARD_SELL_AMT"),
            deal_amt: vf(v, "BILLBOARD_DEAL_AMT"),
            free_mv: vf(v, "FREE_MARKET_CAP"),
            reasons: if reason.is_empty() { vec![] } else { vec![reason.clone()] },
        });
        if !reason.is_empty() && !e.reasons.contains(&reason) {
            e.reasons.push(reason);
        }
        // 净买入绝对值更大的记录作为代表数值
        if net.abs() > e.net_amt.abs() {
            e.net_amt = net;
            e.buy_amt = vf(v, "BILLBOARD_BUY_AMT");
            e.sell_amt = vf(v, "BILLBOARD_SELL_AMT");
            e.deal_amt = vf(v, "BILLBOARD_DEAL_AMT");
        }
    }
    let mut stocks: Vec<LhbStock> = map.into_values().collect();
    stocks.sort_by(|a, b| {
        b.net_amt
            .partial_cmp(&a.net_amt)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let total = stocks.len();
    Ok(LhbList {
        date,
        total,
        stocks,
    })
}

/// 知名游资 / 特色席位识别（按营业部名称关键词）
fn seat_tag(name: &str) -> String {
    if name == "机构专用" {
        return "机构".to_string();
    }
    if name.contains("股通专用") {
        return "北向".to_string();
    }
    let rules: &[(&str, &str)] = &[
        ("拉萨", "拉萨天团"),
        ("华鑫证券有限责任公司上海分公司", "量化"),
        ("华鑫证券有限责任公司上海茅台路", "量化"),
        ("华鑫证券有限责任公司上海宛平南路", "炒股养家"),
        ("华鑫证券有限责任公司上海浦雪路", "炒股养家"),
        ("华鑫证券有限责任公司上海莲花路", "炒股养家"),
        ("华泰证券股份有限公司总部", "量化"),
        ("中信证券股份有限公司总部", "量化"),
        ("上海江苏路", "章盟主"),
        ("绍兴", "赵老哥"),
        ("上海溧阳路", "孙哥"),
        ("南京太平南路", "作手新一"),
        ("南京大钟亭", "作手新一"),
        ("杭州上塘路", "上塘路"),
        ("宁波桑田路", "桑田路"),
        ("佛山绿景路", "佛山无影脚"),
        ("陕西", "方新侠"),
        ("成都", "成都系"),
        ("深圳益田路", "深圳系"),
        ("杭州体育场路", "杭州系"),
        ("宁波解放南路", "宁波涨停板"),
    ];
    for (k, t) in rules {
        if name.contains(k) {
            return t.to_string();
        }
    }
    String::new()
}

fn seat_from(v: &Value) -> LhbSeat {
    let name = vs2(v, "OPERATEDEPT_NAME");
    let tag = seat_tag(&name);
    LhbSeat {
        name,
        code: vs2(v, "OPERATEDEPT_CODE"),
        buy: vf(v, "BUY"),
        sell: vf(v, "SELL"),
        net: vf(v, "NET"),
        buy_ratio: vf(v, "TOTAL_BUYRIO"),
        sell_ratio: vf(v, "TOTAL_SELLRIO"),
        times3: vi(v, "TOTAL_BUYER_SALESTIMES_3DAY"),
        tag,
    }
}

/// 个股龙虎榜席位明细（买卖前五，按上榜原因分组）。date 为空取最新交易日。
pub async fn lhb_detail(code: &str, date: &str) -> Result<LhbDetail, String> {
    let date = if date.is_empty() {
        latest_lhb_date().await?
    } else {
        date.to_string()
    };
    let filter = enc_filter(&format!(
        "(TRADE_DATE='{}')(SECURITY_CODE=\"{}\")",
        date, code
    ));
    let buyers = dc_get(
        "RPT_BILLBOARD_DAILYDETAILSBUY", "ALL", &filter,
        "BUY", "-1", 100, 1,
    )
    .await?;
    let sellers = dc_get(
        "RPT_BILLBOARD_DAILYDETAILSSELL", "ALL", &filter,
        "SELL", "-1", 100, 1,
    )
    .await?;

    let mut reason_order: Vec<String> = vec![];
    let mut bmap: std::collections::BTreeMap<String, Vec<LhbSeat>> = Default::default();
    let mut smap: std::collections::BTreeMap<String, Vec<LhbSeat>> = Default::default();
    for v in &buyers {
        let r = vs2(v, "EXPLANATION");
        if !r.is_empty() && !reason_order.contains(&r) {
            reason_order.push(r.clone());
        }
        bmap.entry(r).or_default().push(seat_from(v));
    }
    for v in &sellers {
        let r = vs2(v, "EXPLANATION");
        if !r.is_empty() && !reason_order.contains(&r) {
            reason_order.push(r.clone());
        }
        smap.entry(r).or_default().push(seat_from(v));
    }

    let mut name = String::new();
    let mut price = 0.0;
    let mut pct = 0.0;
    if let Some(v) = buyers.first().or_else(|| sellers.first()) {
        name = vs2(v, "SECURITY_NAME_ABBR");
        price = vf(v, "CLOSE_PRICE");
        pct = vf(v, "CHANGE_RATE");
    }

    let groups: Vec<LhbReasonGroup> = reason_order
        .iter()
        .map(|r| {
            let mut b = bmap.remove(r).unwrap_or_default();
            b.truncate(5);
            let mut s = smap.remove(r).unwrap_or_default();
            s.truncate(5);
            LhbReasonGroup {
                reason: r.clone(),
                buyers: b,
                sellers: s,
            }
        })
        .collect();

    Ok(LhbDetail {
        code: code.to_string(),
        name,
        date,
        price,
        pct,
        groups,
    })
}

// ===== 席位跟庄统计（营业部上榜后表现 + 历史上榜明细）=====
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeatHorizonStat {
    pub avg: f64,    // 上榜后平均涨幅 %
    pub prob: f64,   // 上涨概率 %
    pub times: i64,  // 样本（买入）次数
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeatBackRow {
    pub cycle: String,   // 近一月 / 近三月 / 近六月 / 近一年
    pub d1: SeatHorizonStat,
    pub d2: SeatHorizonStat,
    pub d3: SeatHorizonStat,
    pub d5: SeatHorizonStat,
    pub d10: SeatHorizonStat,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeatBack {
    pub code: String,
    pub name: String,
    pub rows: Vec<SeatBackRow>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeatTrade {
    pub date: String,
    pub code: String,
    pub name: String,
    pub buy: f64,
    pub sell: f64,
    pub net: f64,
    pub pct: f64,
    pub reason: String,
    pub d1: Option<f64>,
    pub d2: Option<f64>,
    pub d3: Option<f64>,
    pub d5: Option<f64>,
    pub d10: Option<f64>,
    pub d20: Option<f64>,
    pub d30: Option<f64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeatTrades {
    pub code: String,
    pub name: String,
    pub total: i64,
    pub trades: Vec<SeatTrade>,
}

/// Value -> Option<f64>（字段为 null 时返回 None）
fn vfo(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64())
}

/// 营业部上榜后表现回测概况（近月/季/半年/一年 × 1/2/3/5/10 日胜率）
pub async fn seat_back(code: &str) -> Result<SeatBack, String> {
    let filter = enc_filter(&format!("(OPERATEDEPT_CODE=\"{}\")", code));
    let rows = dc_get(
        "RPT_TRADE_BACK_PROFILE", "ALL", &filter, "", "", 50, 1,
    )
    .await?;

    let mut sorted = rows.clone();
    sorted.sort_by_key(|v| vs2(v, "STATISTICSCYCLE"));

    let mut name = String::new();
    let mut out: Vec<SeatBackRow> = vec![];
    for v in &sorted {
        if name.is_empty() {
            name = vs2(v, "ORG_NAME_ABBR");
        }
        let h = |n: &str| SeatHorizonStat {
            avg: vf(v, &format!("AVERAGE_INCREASE_{}DAY", n)),
            prob: vf(v, &format!("RISE_PROBABILITY_{}DAY", n)),
            times: vi(v, &format!("TOTAL_BUYER_SALESTIMES_{}DAY", n)),
        };
        out.push(SeatBackRow {
            cycle: vs2(v, "STATISTICSCYCLENAME"),
            d1: h("1"),
            d2: h("2"),
            d3: h("3"),
            d5: h("5"),
            d10: h("10"),
        });
    }
    if name.is_empty() {
        if let Some(v) = rows.first() {
            name = vs2(v, "OPERATEDEPT_NAME");
        }
    }
    Ok(SeatBack {
        code: code.to_string(),
        name,
        rows: out,
    })
}

/// 营业部历史上榜明细（含上榜后 1/2/3/5/10/20/30 日涨跌幅），按日期倒序分页
pub async fn seat_trades(code: &str, size: i64, page: i64) -> Result<SeatTrades, String> {
    let filter = enc_filter(&format!("(OPERATEDEPT_CODE=\"{}\")", code));
    let url = format!(
        "https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE,SECURITY_CODE&sortTypes=-1,1&pageSize={}&pageNumber={}&reportName=RPT_OPERATEDEPT_TRADE_DETAILSNEW&columns=ALL&source=WEB&client=WEB&filter={}",
        size, page, filter
    );
    let resp = http()
        .get(&url)
        .header(
            "Referer",
            format!("https://data.eastmoney.com/stock/lhb/yyb/{}.html", code),
        )
        .header("Accept", "application/json, text/plain, */*")
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let result = v.get("result");
    let total = result
        .and_then(|r| r.get("count"))
        .and_then(|c| c.as_i64())
        .unwrap_or(0);
    let data = result
        .and_then(|r| r.get("data"))
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();

    let mut name = String::new();
    let mut trades: Vec<SeatTrade> = vec![];
    for x in &data {
        if name.is_empty() {
            name = vs2(x, "ORG_NAME_ABBR");
        }
        let raw_dt = vs2(x, "TRADE_DATE");
        let date = if raw_dt.len() >= 10 {
            raw_dt[..10].to_string()
        } else {
            raw_dt
        };
        trades.push(SeatTrade {
            date,
            code: vs2(x, "SECURITY_CODE"),
            name: vs2(x, "SECURITY_NAME_ABBR"),
            buy: vf(x, "ACT_BUY"),
            sell: vf(x, "ACT_SELL"),
            net: vf(x, "NET_AMT"),
            pct: vf(x, "CHANGE_RATE"),
            reason: vs2(x, "EXPLANATION"),
            d1: vfo(x, "D1_CLOSE_ADJCHRATE"),
            d2: vfo(x, "D2_CLOSE_ADJCHRATE"),
            d3: vfo(x, "D3_CLOSE_ADJCHRATE"),
            d5: vfo(x, "D5_CLOSE_ADJCHRATE"),
            d10: vfo(x, "D10_CLOSE_ADJCHRATE"),
            d20: vfo(x, "D20_CLOSE_ADJCHRATE"),
            d30: vfo(x, "D30_CLOSE_ADJCHRATE"),
        });
    }
    if name.is_empty() {
        if let Some(x) = data.first() {
            name = vs2(x, "OPERATEDEPT_NAME");
        }
    }
    Ok(SeatTrades {
        code: code.to_string(),
        name,
        total,
        trades,
    })
}

// ===== 逐笔成交明细（details/get）=====
/// 返回最近 n 条逐笔（时间升序）。方向 f54：2=主动买(外盘)，1=主动卖(内盘)，其余中性。
pub async fn trades(code: &str, n: i64) -> Result<Vec<TradeTick>, String> {
    let secid = format!("{}.{}", secid_prefix(code), code);
    let url = format!(
        "http://push2.eastmoney.com/api/qt/stock/details/get?secid={secid}\
         &fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55&pos=-{n}&np=1&fltt=1&invt=2"
    );
    let v: Value = http()
        .get(&url)
        .header("Referer", "https://quote.eastmoney.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let arr = v["data"]["details"].as_array().ok_or("逐笔数据为空")?;
    let mut out = Vec::new();
    for item in arr {
        let s = item.as_str().unwrap_or("");
        let p: Vec<&str> = s.split(',').collect();
        if p.len() < 4 {
            continue;
        }
        let side = match p[3] {
            "2" => "buy",
            "1" => "sell",
            _ => "neutral",
        };
        out.push(TradeTick {
            time: p[0].to_string(),
            price: p[1].parse().unwrap_or(0.0),
            vol: p[2].parse().unwrap_or(0.0),
            side: side.to_string(),
        });
    }
    if out.is_empty() {
        return Err("逐笔返回空".to_string());
    }
    Ok(out)
}

// ===== 盘口（stock/get，免费源尽力版）=====
/// 免费行情稳定返回 5 档；动态解析实际非空档位（跌停无买盘 / 涨停无卖盘）。
pub async fn orderbook(code: &str) -> Result<OrderBook, String> {
    let secid = format!("{}.{}", secid_prefix(code), code);
    // f11..f40 连续：买1-5(f11-f20)、买6-10候选(f21-f30)、卖1-5(f31-f40)；
    // f43最新价 f44高 f45低 f46开 f47量 f48额 f57代码 f58名称 f60昨收
    let mut fields: Vec<String> = (11..=40).map(|i| format!("f{i}")).collect();
    fields.extend(
        ["f43", "f44", "f45", "f46", "f47", "f48", "f57", "f58", "f60"]
            .iter()
            .map(|s| s.to_string()),
    );
    let url = format!(
        "http://push2.eastmoney.com/api/qt/stock/get?secid={secid}\
         &invt=2&fltt=2&np=1&fields={}",
        fields.join(",")
    );
    let v: Value = http()
        .get(&url)
        .header("Referer", "https://quote.eastmoney.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let d = &v["data"];
    if !d.is_object() {
        return Err("东财盘口为空".to_string());
    }
    // 取字段 fxx 的数值（缺失 / "-" 为 0）
    let fnum = |k: &str| d.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);

    // 买盘：从 f11 起按 (价,量) 对连续扫描，价格>0 加入，遇 0 停（扫到 f30 最多 10 档）
    let mut bids: Vec<OrderLevel> = Vec::new();
    for i in 0..10 {
        let pk = format!("f{}", 11 + i * 2);
        let vk = format!("f{}", 12 + i * 2);
        let price = fnum(&pk);
        if price <= 0.0 {
            break;
        }
        bids.push(OrderLevel { price, vol: fnum(&vk) });
    }
    // 卖盘：从 f31 起扫描（f31-f40 = 5 档）
    let mut asks: Vec<OrderLevel> = Vec::new();
    for i in 0..5 {
        let pk = format!("f{}", 31 + i * 2);
        let vk = format!("f{}", 32 + i * 2);
        let price = fnum(&pk);
        if price <= 0.0 {
            break;
        }
        asks.push(OrderLevel { price, vol: fnum(&vk) });
    }

    let code_s = d
        .get("f57")
        .and_then(|x| x.as_str())
        .unwrap_or(code)
        .to_string();
    Ok(OrderBook {
        name: d.get("f58").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        code: code_s,
        price: fnum("f43"),
        prev_close: fnum("f60"),
        open: fnum("f46"),
        high: fnum("f44"),
        low: fnum("f45"),
        volume: fnum("f47"),
        amount: fnum("f48"),
        asks,
        bids,
    })
}
