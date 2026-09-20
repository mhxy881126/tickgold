// 新浪数据源：实时行情（GBK，hq.sinajs.cn）+ K线（UTF-8 JSON，money.finance.sina）
use super::{cnc_symbol, http, now_millis, Quote, KBar};
use serde::Deserialize;

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
fn parse_date(s: &str, period: i64) -> i64 {
    use std::time::{Duration, UNIX_EPOCH};
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
