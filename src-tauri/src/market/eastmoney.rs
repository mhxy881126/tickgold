// 东方财富数据源：批量实时行情 + 股票搜索
use super::{http, now_millis, secid_prefix, Quote, StockItem};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct ListResp {
    data: Option<ListData>,
}
#[derive(Deserialize)]
struct ListData {
    diff: Option<Vec<EmQuote>>,
}
#[derive(Deserialize)]
struct EmQuote {
    #[serde(rename = "f12")]
    code: String,
    #[serde(rename = "f14")]
    name: String,
    // 东财停牌/无数据时这些字段可能是 "-" 或 null，用 Value 宽容解析
    #[serde(rename = "f2")]
    price: Value,
    #[serde(rename = "f3")]
    pct: Value,
    #[serde(rename = "f4")]
    change: Value,
    #[serde(rename = "f5")]
    volume: Value,
    #[serde(rename = "f6")]
    amount: Value,
    #[serde(rename = "f15")]
    high: Value,
    #[serde(rename = "f16")]
    low: Value,
    #[serde(rename = "f17")]
    open: Value,
    #[serde(rename = "f18")]
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
