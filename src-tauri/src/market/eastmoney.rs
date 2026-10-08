// 东方财富数据源：批量实时行情 + 股票搜索
use super::{
    http, http_permit, now_millis, secid_prefix, OrderBook, OrderLevel, Quote, StockItem, TradeTick,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

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
    #[serde(rename = "f7", default)]
    amplitude: Value,
    #[serde(rename = "f8", default)]
    turnover: Value,
    #[serde(rename = "f9", default)]
    pe: Value,
    #[serde(rename = "f10", default)]
    volume_ratio: Value,
    #[serde(rename = "f20", default)]
    total_mv: Value,
    #[serde(rename = "f21", default)]
    circ_mv: Value,
    #[serde(rename = "f23", default)]
    pb: Value,
}

/// 东财字段宽容转 f64：数字直接取，"-"/null/字符串一律 0
fn nf(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

/// push2 行情节点池：主域被本地运营商 / 网络边缘间歇性封锁（socket 直接失败）时，
/// 编号子域（N.push2.*）通常接入不同边缘、不被连带封锁。
/// 顺序：把实测可用率较高的编号镜像排在前面，裸主域放最后兜底。
const PUSH2_HOSTS: &[&str] = &[
    "82.push2.eastmoney.com",
    "88.push2.eastmoney.com",
    "1.push2.eastmoney.com",
    "17.push2.eastmoney.com",
    "60.push2.eastmoney.com",
    "90.push2.eastmoney.com",
    "120.push2.eastmoney.com",
    "29.push2.eastmoney.com",
    "push2.eastmoney.com",
];

/// push2 多节点串行故障转移：任一节点返回可解析 JSON 即采用，全部失败才报错。
/// 被封节点多为百毫秒级的快速 socket 失败（而非长超时），所以串行尝试即可在秒级内命中
/// 可用节点，相比「全节点并发竞速」没有 N 倍请求放大，适合行情 / 盘口等高频调用。
/// `path_query` 为以 "/" 开头、含 query 的接口路径。
pub(crate) async fn push2_json(path_query: &str) -> Result<Value, String> {
    let mut last = String::from("无可用 push2 节点");
    for host in PUSH2_HOSTS {
        let url = format!("https://{host}{path_query}");
        match http()
            .get(&url)
            .header("Referer", "https://quote.eastmoney.com/")
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
        {
            Ok(resp) => match resp.json::<Value>().await {
                Ok(v) => return Ok(v),
                Err(e) => last = format!("{host}: 解析失败 {e}"),
            },
            Err(e) => last = format!("{host}: {e}"),
        }
    }
    Err(format!("所有 push2 节点均失败；{last}"))
}

pub async fn quotes(codes: &[String]) -> Result<Vec<Quote>, String> {
    let secids: Vec<String> = codes
        .iter()
        .map(|c| format!("{}.{}", secid_prefix(c), c))
        .collect();
    let path = format!(
        "/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14,f2,f3,f4,f5,f6,f7,f8,f9,f10,f15,f16,f17,f18,f20,f21,f23&secids={}",
        secids.join(",")
    );
    let json: ListResp = serde_json::from_value(push2_json(&path).await?)
        .map_err(|e| e.to_string())?;
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
            turnover: nf(&q.turnover),
            pe: nf(&q.pe),
            pb: nf(&q.pb),
            amplitude: nf(&q.amplitude),
            volume_ratio: nf(&q.volume_ratio),
            circ_mv: nf(&q.circ_mv) / 1e8,
            total_mv: nf(&q.total_mv) / 1e8,
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

// ===== 增强榜单：专用 RankRow（含换手/量比/5分钟涨速/主力净流入/大单净流入）=====
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RankRow {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub pct: f64,
    pub amount: f64,       // 成交额（元）
    pub turnover: f64,     // 换手率 %
    pub volume_ratio: f64, // 量比
    pub speed5: f64,       // 5分钟涨速 %
    pub main_net: f64,     // 主力净流入（元）
    pub big_net: f64,      // 大单净流入（元）
}

#[derive(Deserialize)]
struct RankBoardResp {
    data: Option<RankBoardData>,
}
#[derive(Deserialize)]
struct RankBoardData {
    #[serde(default)]
    diff: Vec<Value>,
}

/// 增强榜单。sort 支持：
/// gainers=涨幅 losers=跌幅 amount=成交额 speed=快速涨幅(5分钟涨速)
/// big=大单净量(大单净流入额) vr=量比榜 turnover=换手率 main=主力净流入
pub async fn rank_board(sort: &str, page: i64, num: i64) -> Result<Vec<RankRow>, String> {
    // (排序字段 fid, 排序方向 po：1=降序 0=升序)
    let (fid, po) = match sort {
        "losers" => ("f3", 0),
        "amount" => ("f6", 1),
        "speed" => ("f22", 1),
        "big" => ("f72", 1),
        "vr" => ("f10", 1),
        "turnover" => ("f8", 1),
        "main" => ("f62", 1),
        _ => ("f3", 1), // gainers 默认
    };
    let pn = page.max(1);
    // 多个 push2 节点并发竞速：任一先返回可解析 JSON 即采用，其余请求丢弃。
    // 主域被网络阻断时无需逐节点串行等超时（最坏 40s），整体只受单请求 8s 超时约束。
    let mut set = tokio::task::JoinSet::new();
    for &host in CLIST_HOSTS {
        let url = format!(
            "https://{host}/api/qt/clist/get?pn={pn}&pz={num}&po={po}&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid={fid}&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14,f2,f3,f6,f8,f10,f22,f62,f72"
        );
        set.spawn(async move {
            let resp = http()
                .get(&url)
                .header("Referer", "https://quote.eastmoney.com/")
                .timeout(std::time::Duration::from_secs(4))
                .send()
                .await
                .map_err(|e| format!("{host}: {e}"))?;
            let json: RankBoardResp =
                resp.json().await.map_err(|e| format!("{host}: decode {e}"))?;
            Ok::<Vec<Value>, String>(json.data.map(|d| d.diff).unwrap_or_default())
        });
    }
    let mut last = String::from("所有 clist 节点均失败");
    let mut rows: Vec<Value> = Vec::new();
    let mut ok = false;
    while let Some(res) = set.join_next().await {
        match res {
            Ok(Ok(v)) => {
                set.abort_all();
                rows = v;
                ok = true;
                break;
            }
            Ok(Err(e)) => last = e,
            Err(e) => last = format!("join: {e}"),
        }
    }
    if !ok {
        return Err(last);
    }
    let g = |v: &Value, key: &str| -> f64 { v.get(key).map(nf).unwrap_or(0.0) };
    let out = rows
        .iter()
        .map(|v| RankRow {
            code: v.get("f12").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            name: v.get("f14").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            price: g(v, "f2"),
            pct: g(v, "f3"),
            amount: g(v, "f6"),
            turnover: g(v, "f8"),
            volume_ratio: g(v, "f10"),
            speed5: g(v, "f22"),
            main_net: g(v, "f62"),
            big_net: g(v, "f72"),
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
    let path = format!(
        "/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14,f2,f3,f4,f5,f6,f15,f16,f17,f18&secids={}",
        secids.join(",")
    );
    let json: ListResp = serde_json::from_value(push2_json(&path).await?)
        .map_err(|e| e.to_string())?;
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

/// clist / rank_board 复用统一的 push2 多节点池
const CLIST_HOSTS: &[&str] = PUSH2_HOSTS;

/// clist 单页实际请求（pz=100，服务端单页硬上限 100），返回 (全市场总数, 本页行情)。
/// 依次尝试多个 push2 节点，任一返回可解析 JSON 即成功；全部失败才报错。
async fn clist_page_once(fs: &str, pn: i32) -> Result<(i64, Vec<EmQuote>), String> {
    clist_page_sorted_once(fs, "f3", 1, pn).await
}

/// clist 单页（自定义排序字段/升降序），返回本页行情。
/// fid: 排序字段（f3=涨跌幅, f6=成交额）；po: 1=降序, 0=升序。
async fn clist_page_sorted_once(fs: &str, fid: &str, po: i32, pn: i32) -> Result<(i64, Vec<EmQuote>), String> {
    let _permit = http_permit().await;
    let mut last = String::new();
    for host in CLIST_HOSTS {
        let url = format!(
            "https://{}/api/qt/clist/get?pn={}&pz=100&po={}&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid={}&fs={}&fields=f12,f14,f17,f18,f6,f2,f3",
            host, pn, po, fid, fs
        );
        let resp = match http()
            .get(&url)
            .header("Referer", "https://quote.eastmoney.com/")
            .timeout(std::time::Duration::from_secs(4))
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

/// clist 单页（带 3 次退避重试）
async fn clist_page(fs: &str, pn: i32) -> Result<(i64, Vec<EmQuote>), String> {
    clist_page_sorted(fs, "f3", 1, pn).await
}

/// clist 单页（自定义排序 + 3 次退避重试）
async fn clist_page_sorted(fs: &str, fid: &str, po: i32, pn: i32) -> Result<(i64, Vec<EmQuote>), String> {
    let mut last = String::new();
    for attempt in 0..3u32 {
        match clist_page_sorted_once(fs, fid, po, pn).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = e;
                if attempt < 2 {
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
    Err(last)
}

pub async fn auction() -> Result<AuctionData, String> {
    let fs = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
    // 只取前1页榜单（100条），2个并发请求
    let fs_h = fs.to_string();
    let fs_l = fs.to_string();
    let (h, l) = tokio::join!(
        clist_page_sorted_once(&fs_h, "f3", 1, 1),
        clist_page_sorted_once(&fs_l, "f3", 0, 1),
    );
    let mut seen = std::collections::HashSet::new();
    let mut high: Vec<AuctionStock> = Vec::new();
    let mut low: Vec<AuctionStock> = Vec::new();
    for (res, is_high) in [(h, true), (l, false)] {
        if let Ok((_, quotes)) = res {
            for q in quotes {
                if !seen.insert(q.code.clone()) { continue; }
                if let Some(s) = to_auction_stock(&q) {
                    if is_high && s.gap > 0.0 { high.push(s); }
                    else if !is_high && s.gap < 0.0 { low.push(s); }
                }
            }
        }
    }
    high.sort_by(|a, b| b.gap.partial_cmp(&a.gap).unwrap());
    low.sort_by(|a, b| a.gap.partial_cmp(&b.gap).unwrap());
    let total = high.len() + low.len();
    Ok(AuctionData {
        updated: now_millis(),
        total,
        high_open: high,
        low_open: low,
    })
}

fn to_auction_stock(q: &EmQuote) -> Option<AuctionStock> {
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
    let path = format!(
        "/api/qt/stock/details/get?secid={secid}\
         &fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55&pos=-{n}&np=1&fltt=1&invt=2"
    );
    let v: Value = push2_json(&path).await?;
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
    let path = format!(
        "/api/qt/stock/get?secid={secid}\
         &invt=2&fltt=2&np=1&fields={}",
        fields.join(",")
    );
    let v: Value = push2_json(&path).await?;
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

// ===== 个股题材标签（clist f127=所属行业 f128=所属概念；多节点串行故障转移）=====
/// 单只个股的行业 + 概念标签（f127/f128 由东财 clist 直接返回，概念名为逗号分隔文本）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StockThemeTags {
    pub code: String,
    pub industry: String,
    pub concepts: Vec<String>,
}

#[derive(Deserialize)]
struct TagsResp {
    data: Option<TagsData>,
}
#[derive(Deserialize)]
struct TagsData {
    diff: Option<Vec<TagsRow>>,
}
#[derive(Deserialize)]
struct TagsRow {
    #[serde(rename = "f12")]
    code: String,
    #[serde(rename = "f127", default)]
    industry: Value,
    #[serde(rename = "f128", default)]
    concepts: Value,
}

/// 标签文本宽容取值：字段缺失 / null / "-" 一律按空处理。
fn tag_str(v: &Value) -> String {
    match v.as_str() {
        Some(s) => {
            let t = s.trim();
            if t.is_empty() || t == "-" {
                String::new()
            } else {
                t.to_string()
            }
        }
        None => String::new(),
    }
}

/// 拆分 f128 概念文本：兼容英文逗号/中文逗号/顿号分隔；
/// 每个概念内部去除嵌入空白；丢弃空串并按出现顺序去重。
pub(crate) fn split_concepts(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in s.split(|c| c == ',' || c == '，' || c == '、') {
        // split_whitespace 同时吃掉前导/尾随与内部多余空白，再以单空格拼回
        let name = part.split_whitespace().collect::<Vec<_>>().join(" ");
        if !name.is_empty() && !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// 仅接受 6 位纯数字 A 股代码，防止未校验输入拼进 URL。
fn is_valid_a_code(c: &str) -> bool {
    c.len() == 6 && c.bytes().all(|b| b.is_ascii_digit())
}

/// 题材标签专用 secid 前缀：沿用全局 6/9/5→1、其余→0，但北交所新号段 920xxx 归 0
/// （东财深 / 京共用 0 前缀；全局 secid_prefix 把所有 9 开头都算 1，会漏掉 920 北交所股）。
pub(crate) fn theme_secid_prefix(code: &str) -> &'static str {
    if code.starts_with("920") {
        "0"
    } else {
        secid_prefix(code)
    }
}

/// 单批（≤50 个 secid）题材标签请求：82/88/29 三节点串行故障转移，15s 单请求超时。
/// 任一节点返回可解析 JSON（含空 diff）即成功，全部失败才报错。
async fn tags_chunk_once(fs: &str) -> Result<Vec<TagsRow>, String> {
    let nodes = ["82", "88", "29"];
    let mut last = String::from("所有题材标签节点均失败");
    for node in nodes {
        let url = format!(
            "https://{}.push2.eastmoney.com/api/qt/clist/get?pn=1&pz=50&po=1&np=1&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fs={}&fields=f12,f14,f127,f128",
            node, fs
        );
        let got = tokio::time::timeout(
            Duration::from_secs(15),
            http().get(&url).header("Referer", "https://quote.eastmoney.com/").send(),
        )
        .await;
        match got {
            Ok(Ok(resp)) => {
                let text = match resp.text().await {
                    Ok(t) => t,
                    Err(e) => {
                        last = format!("{node}: 读取失败 {e}");
                        continue;
                    }
                };
                match serde_json::from_str::<TagsResp>(&text) {
                    Ok(j) => return Ok(j.data.and_then(|d| d.diff).unwrap_or_default()),
                    Err(e) => last = format!("{node}: 解析失败 {e}"),
                }
            }
            Ok(Err(e)) => last = format!("{node}: {e}"),
            Err(_) => last = format!("{node}: 请求超时(15s)"),
        }
    }
    Err(last)
}

/// 批量个股题材标签：每批 ≤50 个 secid，跨批结果按 code 合并（行业取首个非空，概念并集去重）。
/// 输入先经 6 位数字守卫过滤并去重；响应缺失的代码仍返回空标签占位，不报错。
pub async fn stock_theme_tags(codes: &[String]) -> Result<Vec<StockThemeTags>, String> {
    // 输入守卫 + 去重（保持首次出现顺序）
    let mut valid: Vec<String> = Vec::with_capacity(codes.len());
    for c in codes {
        if is_valid_a_code(c) && !valid.contains(c) {
            valid.push(c.clone());
        }
    }
    if valid.is_empty() {
        return Ok(vec![]);
    }

    // code -> (industry, concepts)
    let mut map: std::collections::HashMap<String, (String, Vec<String>)> = std::collections::HashMap::new();
    for chunk in valid.chunks(50) {
        let secids: Vec<String> = chunk
            .iter()
            .map(|c| format!("{}.{}", theme_secid_prefix(c), c))
            .collect();
        let fs = secids.join(",");
        let rows = tags_chunk_once(&fs).await?;
        for r in rows {
            if !is_valid_a_code(&r.code) {
                continue;
            }
            let industry = tag_str(&r.industry);
            let concepts = split_concepts(&tag_str(&r.concepts));
            let entry = map.entry(r.code.clone()).or_insert_with(|| (String::new(), Vec::new()));
            if entry.0.is_empty() && !industry.is_empty() {
                entry.0 = industry;
            }
            for c in concepts {
                if !entry.1.contains(&c) {
                    entry.1.push(c);
                }
            }
        }
    }

    // 按输入顺序输出；未返回的代码给空标签（停牌/被剔除字段时概念腿安全降级为空）
    let out = valid
        .iter()
        .map(|c| match map.remove(c) {
            Some((industry, concepts)) => StockThemeTags {
                code: c.clone(),
                industry,
                concepts,
            },
            None => StockThemeTags {
                code: c.clone(),
                industry: String::new(),
                concepts: vec![],
            },
        })
        .collect();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::secid_prefix;

    const FIXTURE: &str = r#"{"data":{"diff":[
      {"f12":"600519","f14":"贵州茅台","f127":"白酒","f128":"超级品牌,白酒，电商概念、融资融券"},
      {"f12":"300750","f14":"宁德时代","f127":"电池","f128":" 新能源 ， 动力电池，新能源 ，"},
      {"f12":"000001","f14":"平安银行","f127":"-","f128":""},
      {"f12":"000002","f14":"万科A","f128":"房地产，物业管理"},
      {"f12":"688981","f127":null,"f128":null}
    ]}}"#;

    fn parse_fixture() -> Vec<TagsRow> {
        serde_json::from_str::<TagsResp>(FIXTURE)
            .unwrap()
            .data
            .unwrap()
            .diff
            .unwrap()
    }

    #[test]
    fn fixture_rows_parse_all() {
        let rows = parse_fixture();
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0].code, "600519");
    }

    #[test]
    fn concepts_split_on_three_separators_and_dedup() {
        // 英文逗号 / 中文逗号 / 顿号
        assert_eq!(
            split_concepts("超级品牌,白酒，电商概念、融资融券"),
            vec!["超级品牌", "白酒", "电商概念", "融资融券"]
        );
        // 嵌入空白被规范化；重复概念去重；尾随分隔符不产生空串
        assert_eq!(
            split_concepts(" 新能源 ， 动力电池，新能源 ，"),
            vec!["新能源", "动力电池"]
        );
        // 空文本 / 仅分隔符
        assert!(split_concepts("").is_empty());
        assert!(split_concepts("，,、 ").is_empty());
    }

    #[test]
    fn missing_and_dash_fields_default_empty() {
        let rows = parse_fixture();
        // "-" 行业归一化为空；空 f128 无概念
        assert_eq!(tag_str(&rows[2].industry), "");
        assert_eq!(split_concepts(&tag_str(&rows[2].concepts)), Vec::<String>::new());
        // f127 缺失（只有 f128）时行业为空、概念正常
        assert_eq!(tag_str(&rows[3].industry), "");
        assert_eq!(
            split_concepts(&tag_str(&rows[3].concepts)),
            vec!["房地产", "物业管理"]
        );
        // f127/f128 显式 null
        assert_eq!(tag_str(&rows[4].industry), "");
        assert_eq!(split_concepts(&tag_str(&rows[4].concepts)), Vec::<String>::new());
    }

    #[test]
    fn bad_fixture_shapes_fail_decode() {
        assert!(serde_json::from_str::<TagsResp>("not json").is_err());
        // 空 data 是合法响应（节点成功但无数据），diff 缺省为 None -> 空 Vec
        let v: Vec<TagsRow> = serde_json::from_str::<TagsResp>(r#"{"data":{}}"#)
            .unwrap()
            .data
            .and_then(|d| d.diff)
            .unwrap_or_default();
        assert!(v.is_empty());
    }

    #[test]
    fn code_guard_and_dedup_input() {
        assert!(is_valid_a_code("600519"));
        assert!(is_valid_a_code("920675"));
        assert!(!is_valid_a_code(""));
        assert!(!is_valid_a_code("60051"));
        assert!(!is_valid_a_code("BK0477"));
        assert!(!is_valid_a_code("60051A"));
    }

    #[test]
    fn secid_prefix_rules() {
        use super::theme_secid_prefix as tp;
        // 全局规则：6/9/5 开头沪市前缀 1
        assert_eq!(secid_prefix("600519"), "1");
        assert_eq!(secid_prefix("688981"), "1");
        assert_eq!(secid_prefix("900001"), "1");
        assert_eq!(secid_prefix("510300"), "1");
        assert_eq!(secid_prefix("000001"), "0");
        // 题材标签专用：沪深主板 / 创业板一致，920 北交所纠正为 0
        assert_eq!(tp("600519"), "1");
        assert_eq!(tp("000001"), "0");
        assert_eq!(tp("300750"), "0");
        assert_eq!(tp("301001"), "0");
        assert_eq!(tp("430047"), "0");
        assert_eq!(tp("830799"), "0");
        assert_eq!(tp("920675"), "0");
        assert_eq!(tp("900001"), "1"); // 9 开头但非 920，仍是沪市 B 股
    }
}
