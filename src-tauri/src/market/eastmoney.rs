// 东方财富数据源：批量实时行情 + 股票搜索
use super::{http, now_millis, secid_prefix, Quote, StockItem};
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
                    tokio::time::sleep(std::time::Duration::from_millis(
                        600 * (attempt as u64 + 1),
                    ))
                    .await;
                }
            }
        }
    }
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
