// 新浪数据源：实时行情（GBK，hq.sinajs.cn）+ K线（UTF-8 JSON，money.finance.sina）
use super::{cnc_symbol, http, now_millis, KBar, NewsItem, Quote, Sector};
use serde::Deserialize;
use serde_json::Value;

pub async fn quotes(codes: &[String]) -> Result<Vec<Quote>, String> {
    let symbols: Vec<String> = codes.iter().map(|c| cnc_symbol(c)).collect();
    let url = format!("https://hq.sinajs.cn/list={}", symbols.join(","));
    let resp = http()
        .get(&url)
        .header("Referer", "https://finance.sina.com.cn")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let (txt, _, _) = encoding_rs::GBK.decode(&bytes);
    let now = now_millis();
    let mut out = Vec::new();

    for line in txt.lines() {
        let Some((left, right)) = line.split_once('=') else { continue };
        let sym = left.trim().trim_start_matches("var hq_str_");
        if sym.len() < 3 { continue };
        let code = sym[2..].to_string();
        let payload = right.trim().trim_end_matches(';').trim_matches('"');
        let f: Vec<&str> = payload.split(',').collect();
        if f.len() < 10 { continue };

        let p = |i: usize| f[i].parse::<f64>().unwrap_or(0.0);
        let name = f[0].to_string();
        let open = p(1);
        let prev_close = p(2);
        let price = p(3);
        let high = p(4);
        let low = p(5);
        let vol_shares = p(8);
        let amount = p(9);
        let change = price - prev_close;
        let pct = if prev_close != 0.0 { change / prev_close * 100.0 } else { 0.0 };

        out.push(Quote {
            code,
            name,
            price,
            change,
            pct,
            open,
            high,
            low,
            prev_close,
            volume: vol_shares / 100.0, // 股 -> 手
            amount,
            time: now,
            source: "sina".to_string(),
            turnover: 0.0,
            pe: 0.0,
            pb: 0.0,
            amplitude: 0.0,
            volume_ratio: 0.0,
            circ_mv: 0.0,
            total_mv: 0.0,
        });
    }
    Ok(out)
}

#[derive(Deserialize)]
struct SinaBar {
    day: String,
    open: String,
    high: String,
    low: String,
    close: String,
    volume: String,
}

// ===== 板块行情（行业 / 概念，UTF-8 JSON） =====
pub async fn sectors(kind: &str) -> Result<Vec<Sector>, String> {
    // industry=申万行业(fenlei0), concept=概念(fenlei1)
    let fl = if kind == "concept" { "1" } else { "0" };
    let url = format!(
        "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk?page=1&num=400&sort=avg_changeratio&asc=0&bankuai=ssl_hy&fenlei={fl}"
    );
    let arr: Vec<Value> = http()
        .get(&url)
        .header("Referer", "https://finance.sina.com.cn/")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let g = |x: &Value, k: &str| {
        x[k].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0)
    };
    let out: Vec<Sector> = arr
        .iter()
        .filter_map(|x| {
            Some(Sector {
                code: x["category"].as_str()?.to_string(),
                name: x["name"].as_str()?.to_string(),
                change_pct: g(x, "avg_changeratio") * 100.0,
                net_amount: g(x, "netamount"),
                in_amount: g(x, "inamount"),
                out_amount: g(x, "outamount"),
                lead_code: x["ts_symbol"].as_str().unwrap_or("").to_string(),
                lead_name: x["ts_name"].as_str().unwrap_or("").to_string(),
                lead_pct: g(x, "ts_changeratio") * 100.0,
            })
        })
        .collect();
    if out.is_empty() {
        return Err("板块返回空".to_string());
    }
    Ok(out)
}

/// 板块成分股
pub async fn sector_stocks(category: &str, kind: &str) -> Result<Vec<Value>, String> {
    let url = format!(
        "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=50&sort=changepercent&asc=0&node={category}"
    );
    let arr: Vec<Value> = http()
        .get(&url)
        .header("Referer", "https://finance.sina.com.cn/")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(arr)
}
pub async fn kline(code: &str, period: i64, count: i64) -> Result<Vec<KBar>, String> {
    let scale = match period {
        1 | 5 | 15 | 30 | 60 => period,
        101 => 240,
        102 => 1200,
        103 => 2400,
        _ => 240,
    };
    let sym = cnc_symbol(code);
    let url = format!(
        "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol={}&scale={}&ma=no&datalen={}",
        sym, scale, count
    );
    let resp = http()
        .get(&url)
        .header("Referer", "https://finance.sina.com.cn/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let bars: Vec<SinaBar> = resp.json().await.map_err(|e| e.to_string())?;
    let out = bars
        .into_iter()
        .map(|b| KBar {
            timestamp: parse_date(&b.day, period),
            open: b.open.parse().unwrap_or(0.0),
            close: b.close.parse().unwrap_or(0.0),
            high: b.high.parse().unwrap_or(0.0),
            low: b.low.parse().unwrap_or(0.0),
            volume: b.volume.parse().unwrap_or(0.0),
        })
        .collect();
    Ok(out)
}

/// 新浪日期串 -> ms 时间戳（沿用近似换算，足够横轴使用）
fn parse_date(s: &str, period: i64) -> i64 {    use std::time::{Duration, UNIX_EPOCH};
    let (date_part, time_part) = match s.split_once(' ') {
        Some((d, t)) => (d, t),
        None => (s, "00:00"),
    };
    let ymd: Vec<&str> = date_part.split('-').collect();
    if ymd.len() != 3 {
        return 0;
    }
    let hm: Vec<&str> = time_part.split(':').collect();
    let h = hm.first().and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    let m = hm.get(1).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    let y = ymd[0].parse::<i64>().unwrap_or(1970);
    let mo = ymd[1].parse::<i64>().unwrap_or(1);
    let d = ymd[2].parse::<i64>().unwrap_or(1);
    let days = (y - 1970) * 365 + (y - 1969) / 4 + (mo - 1) * 30 + (d - 1);
    let secs = days * 86400 + h * 3600 + m * 60 + if period >= 100 { 15 * 3600 } else { 0 };
    (UNIX_EPOCH + Duration::from_secs(secs as u64))
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 榜单分页（全市场沪深京 A 股，标准 JSON）：
/// sort: gainers=涨幅榜, losers=跌幅榜, amount=成交额榜；page 从 1 开始。
pub async fn rank_page(sort: &str, page: i64, num: i64) -> Result<Vec<Quote>, String> {
    let (sort_key, asc) = match sort {
        "losers" => ("changepercent", 1),
        "amount" => ("amount", 0),
        _ => ("changepercent", 0),
    };
    let url = format!(
        "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page={page}&num={num}&sort={sort_key}&asc={asc}&node=hs_a&symbol=&_s_r_a=page"
    );
    let arr: Vec<Value> = http()
        .get(&url)
        .header("Referer", "https://finance.sina.com.cn/")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| format!("榜单解析失败: {e}"))?;

    let now = now_millis();
    // 新浪数值字段均为字符串
    let f = |v: &Value, k: &str| {
        v[k].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0)
    };
    let out: Vec<Quote> = arr
        .iter()
        .map(|v| {
            let price = f(v, "trade");
            let prev_close = f(v, "settlement");
            Quote {
                code: v["code"].as_str().unwrap_or("").to_string(),
                name: v["name"].as_str().unwrap_or("").to_string(),
                price,
                change: f(v, "pricechange"),
                pct: f(v, "changepercent"),
                open: f(v, "open"),
                high: f(v, "high"),
                low: f(v, "low"),
                prev_close,
                volume: f(v, "volume") / 100.0, // 股 -> 手
                amount: f(v, "amount"),
                time: now,
                source: "sina".to_string(),
                turnover: f(v, "turnoverratio"),
                pe: f(v, "per"),
                pb: f(v, "pb"),
                amplitude: 0.0,
                volume_ratio: 0.0,
                circ_mv: f(v, "nmc") / 10000.0, // 万元 -> 亿元
                total_mv: f(v, "mktcap") / 10000.0,
            }
        })
        .collect();
    Ok(out)
}

// ===== 集合竞价回退源：东财 push2 clist 被限流时，改走新浪全市场榜单 =====
// 复用东财的返回类型，前端无需感知数据源差异；新浪不支持按「开盘缺口」服务端排序，
// 故分页拉全 A，本地由 open/settlement 现算 gap 再排序。
use super::eastmoney::{AuctionData, AuctionStock, RankRow};

async fn sina_hs_a_count() -> Result<i64, String> {
    let url = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=hs_a";
    let txt = http()
        .get(url)
        .header("Referer", "https://finance.sina.com.cn/")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    txt.trim()
        .trim_matches('"')
        .parse::<i64>()
        .map_err(|e| format!("竞价总数解析失败: {e}"))
}

async fn sina_hs_a_page(page: i64) -> Result<Vec<Value>, String> {
    let url = format!(
        "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page={page}&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page"
    );
    http()
        .get(&url)
        .header("Referer", "https://finance.sina.com.cn/")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| format!("竞价第 {page} 页解析失败: {e}"))
}

pub async fn auction() -> Result<AuctionData, String> {
    let total = sina_hs_a_count().await?;
    let pages = (total.max(0) + 99) / 100;
    // 每批 5 页并发，避免一次性约 56 并发；带重试提高整段成功率
    let mut rows: Vec<AuctionStock> = Vec::new();
    let mut pn = 1i64;
    while pn <= pages {
        let batch_end = (pn + 4).min(pages);
        let mut handles = Vec::new();
        for p in pn..=batch_end {
            handles.push(tokio::spawn(async move {
                let mut last = String::new();
                for _ in 0..2 {
                    match sina_hs_a_page(p).await {
                        Ok(v) => return Ok(v),
                        Err(e) => last = e,
                    }
                }
                Err(last)
            }));
        }
        for h in handles {
            let page = h.await.map_err(|e| e.to_string())??;
            // 新浪数值字段多为字符串，但 amount/volume/changepercent 等也可能直接给数字，两者兼容
            let f = |v: &Value, k: &str| match &v[k] {
                Value::String(s) => s.parse::<f64>().unwrap_or(0.0),
                Value::Number(n) => n.as_f64().unwrap_or(0.0),
                _ => 0.0,
            };
            for v in &page {
                let prev_close = f(v, "settlement");
                let open = f(v, "open");
                if prev_close <= 0.0 || open <= 0.0 {
                    continue;
                }
                rows.push(AuctionStock {
                    code: v["code"].as_str().unwrap_or("").to_string(),
                    name: v["name"].as_str().unwrap_or("").to_string(),
                    open,
                    prev_close,
                    gap: (open - prev_close) / prev_close * 100.0,
                    amount: f(v, "amount"),
                    price: f(v, "trade"),
                    pct: f(v, "changepercent"),
                });
            }
        }
        pn = batch_end + 1;
    }

    let count = rows.len();
    let mut high: Vec<AuctionStock> = rows.iter().filter(|r| r.gap > 0.0).cloned().collect();
    high.sort_by(|a, b| b.gap.partial_cmp(&a.gap).unwrap());
    let mut low: Vec<AuctionStock> = rows.iter().filter(|r| r.gap < 0.0).cloned().collect();
    low.sort_by(|a, b| a.gap.partial_cmp(&b.gap).unwrap());
    Ok(AuctionData {
        updated: now_millis(),
        total: count,
        high_open: high,
        low_open: low,
    })
}

// ===== 增强榜单回退源：push2 clist 全节点失败时改走新浪 =====
// 新浪可提供 最新价/涨跌幅/成交额/换手率；量比(f10)、5分钟涨速(f22)、
// 主力/大单净流入(f62/f72) 无对应字段，置 0。
// speed/big/vr/main 四类专用排序新浪不支持，回退按涨跌幅排序（基础列仍有数据）。
pub async fn rank_board(sort: &str, page: i64, num: i64) -> Result<Vec<RankRow>, String> {
    let (sort_key, asc) = match sort {
        "losers" => ("changepercent", 1),
        "amount" => ("amount", 0),
        "turnover" => ("turnoverratio", 0),
        _ => ("changepercent", 0), // gainers 及专用榜单默认
    };
    let pn = page.max(1);
    let url = format!(
        "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page={pn}&num={num}&sort={sort_key}&asc={asc}&node=hs_a&symbol=&_s_r_a=page"
    );
    let arr: Vec<Value> = http()
        .get(&url)
        .header("Referer", "https://finance.sina.com.cn/")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| format!("榜单解析失败: {e}"))?;
    let f = |v: &Value, k: &str| match &v[k] {
        Value::String(s) => s.parse::<f64>().unwrap_or(0.0),
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    };
    let out = arr
        .iter()
        .map(|v| RankRow {
            code: v["code"].as_str().unwrap_or("").to_string(),
            name: v["name"].as_str().unwrap_or("").to_string(),
            price: f(v, "trade"),
            pct: f(v, "changepercent"),
            amount: f(v, "amount"),
            turnover: f(v, "turnoverratio"),
            volume_ratio: 0.0,
            speed5: 0.0,
            main_net: 0.0,
            big_net: 0.0,
        })
        .collect();
    Ok(out)
}

// ===== 盘中快讯（新浪财经 7x24 全球直播，UTF-8 JSON；24 小时有内容） =====
pub async fn news_flash(page: i64, size: i64) -> Result<Vec<NewsItem>, String> {
    let url = format!(
        "https://zhibo.sina.com.cn/api/zhibo/feed?page={page}&page_size={size}&zhibo_id=152&tag_id=0&type=0"
    );
    let v: Value = http()
        .get(&url)
        .header("Referer", "https://zhibo.sina.com.cn/")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let list = v
        .pointer("/result/data/feed/list")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "快讯解析失败".to_string())?;

    let out: Vec<NewsItem> = list
        .iter()
        .filter_map(|x| {
            let id = x["id"].as_i64()?;
            let text = strip_html(x["rich_text"].as_str().unwrap_or(""));
            let mut tags: Vec<String> = Vec::new();
            if let Some(arr) = x["tag"].as_array() {
                for t in arr {
                    if let Some(s) = t.get("name").and_then(|y| y.as_str()) {
                        tags.push(s.to_string());
                    } else if let Some(s) = t.as_str() {
                        tags.push(s.to_string());
                    }
                }
            } else if let Some(s) = x["tag"].as_str() {
                if !s.is_empty() {
                    tags.push(s.to_string());
                }
            }
            Some(NewsItem {
                id,
                time: x["create_time"].as_str().unwrap_or("").to_string(),
                text,
                tags,
                url: x["docurl"].as_str().unwrap_or("").to_string(),
            })
        })
        .collect();
    if out.is_empty() {
        return Err("快讯返回空".to_string());
    }
    Ok(out)
}

/// 去除文本中可能残留的 HTML 标签
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0;
    for ch in s.chars() {
        match ch {
            '<' => depth += 1,
            '>' => {
                if depth > 0 {
                    depth -= 1
                }
            }
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}
