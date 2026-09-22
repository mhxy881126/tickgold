// 新浪数据源：实时行情（GBK，hq.sinajs.cn）+ K线（UTF-8 JSON，money.finance.sina）
use super::{cnc_symbol, http, now_millis, FundFlow, FundLevel, KBar, Quote, Sector};
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

// ===== 资金流向（当日实时，UTF-8 JSON） =====
pub async fn fund_flow(code: &str) -> Result<FundFlow, String> {
    let sym = cnc_symbol(code);
    let url = format!(
        "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssi_ssfx_flzjtj?daima={sym}"
    );
    let v: Value = http()
        .get(&url)
        .header("Referer", "https://finance.sina.com.cn/")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    // r0 特大单 r1 大单 r2 中单 r3 小单
    let g = |key: &str| {
        v[key].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0)
    };
    let names = ["特大单", "大单", "中单", "小单"];
    let mut levels: Vec<FundLevel> = Vec::new();
    for (i, nm) in names.iter().enumerate() {
        let in_f = g(&format!("r{i}_in"));
        let out_f = g(&format!("r{i}_out"));
        levels.push(FundLevel {
            name: nm.to_string(),
            net: in_f - out_f,
            in_flow: in_f,
            out_flow: out_f,
        });
    }
    // 主力 = 特大+大（0,1），散户 = 中+小（2,3）
    let main_in = levels[0].in_flow + levels[1].in_flow;
    let main_out = levels[0].out_flow + levels[1].out_flow;
    let main_net = main_in - main_out;
    let retail_in = levels[2].in_flow + levels[3].in_flow;
    let retail_out = levels[2].out_flow + levels[3].out_flow;
    let retail_net = retail_in - retail_out;
    let pct = |net: f64, i: f64, o: f64| {
        if i + o != 0.0 { net / (i + o) * 100.0 } else { 0.0 }
    };

    Ok(FundFlow {
        code: code.to_string(),
        name: v["name"].as_str().unwrap_or("").to_string(),
        main_net,
        main_in,
        main_out,
        main_net_pct: pct(main_net, main_in, main_out),
        retail_net,
        retail_in,
        retail_out,
        retail_net_pct: pct(retail_net, retail_in, retail_out),
        net_amount: g("netamount"),
        levels,
    })
}

// ===== 板块行情（行业 / 概念，UTF-8 JSON） =====
pub async fn sectors(kind: &str) -> Result<Vec<Sector>, String> {
    // industry=申万行业(fenlei0), concept=概念(fenlei1)
    let fl = if kind == "concept" { "1" } else { "0" };
    let url = format!(
        "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk?page=1&num=200&sort=avg_changeratio&asc=0&bankuai=ssl_hy&fenlei={fl}"
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

/// period: 1/5/15/30/60 分钟, 101 日, 102 周, 103 月
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

