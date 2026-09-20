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
        "http://push2.eastmoney.com/api/qt/clist/get?pn=1&pz={pz}&po={po}&np=1&fltt=2&invt=2&fid={fid}&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f12,f14,f2,f3,f4,f5,f6,f15,f16,f17,f18"
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
        })
        .collect();
    Ok(out)
}
