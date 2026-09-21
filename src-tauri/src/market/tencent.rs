// 腾讯数据源：实时行情（GBK，qt.gtimg.cn）、K线（UTF-8，web.ifzq.gtimg.cn）、搜索（GBK，smartbox）
use super::{
    cnc_symbol, http, now_millis, KBar, OrderBook, OrderLevel, Quote, StockItem,
};
use serde_json::Value;

// ===== 实时行情 =====
pub async fn quotes(codes: &[String]) -> Result<Vec<Quote>, String> {
    let symbols: Vec<String> = codes.iter().map(|c| cnc_symbol(c)).collect();
    let url = format!("https://qt.gtimg.cn/q={}", symbols.join(","));
    let resp = http()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let (txt, _, _) = encoding_rs::GBK.decode(&bytes);
    let now = now_millis();
    let mut out = Vec::new();

    for line in txt.lines() {
        let Some((_, right)) = line.split_once('=') else { continue };
        let payload = right.trim().trim_end_matches(';').trim_matches('"');
        let f: Vec<&str> = payload.split('~').collect();
        if f.len() < 50 { continue };
        let p = |i: usize| f[i].parse::<f64>().unwrap_or(0.0);
        let name = f[1].to_string();
        let code = f[2].to_string();
        let price = p(3);
        let prev_close = p(4);
        let open = p(5);
        let volume = p(6); // 手
        let high = p(33);
        let low = p(34);
        let amount = p(37) * 1e4; // 万元 -> 元
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
            volume,
            amount,
            time: now,
            source: "tencent".to_string(),
            turnover: p(38),
            pe: p(39),
            pb: p(46),
            amplitude: p(43),
            volume_ratio: p(49),
            circ_mv: p(44),
            total_mv: p(45),
        });
    }
    Ok(out)
}

// ===== 排行榜（沪深A股） =====
/// sort: gainers=涨幅榜 losers=跌幅榜 amount=成交额榜
pub async fn rank(sort: &str, pz: i64) -> Result<Vec<Quote>, String> {
    // o=0 降序, o=1 升序
    let o = match sort {
        "losers" => 1,
        _ => 0,
    };
    let t = match sort {
        "amount" => "rankash/amt",
        _ => "rankash/chr",
    };
    let url = format!(
        "https://stock.gtimg.cn/data/view/rank.php?t={t}&p=1&o={o}&l={pz}&v=list_data"
    );
    let resp = http()
        .get(&url)
        .header("Referer", "https://stockapp.finance.qq.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let (txt, _, _) = encoding_rs::GBK.decode(&bytes);
    parse_rank(&txt)
}

/// 腾讯 rank.php 返回 list_data=[["sh600519","贵州茅台",1688.00,1.24,...],...]
fn parse_rank(txt: &str) -> Result<Vec<Quote>, String> {
    let Some(start) = txt.find("=[") else {
        return Err("榜单格式不对".to_string());
    };
    let body = txt[start + 2..].trim_end_matches(';').trim_end();
    let body = body.trim_end_matches(']');
    let now = now_millis();
    let mut out = Vec::new();
    for item in body.split("],[") {
        let item = item.trim().trim_start_matches('[').trim_end_matches(']');
        let f: Vec<&str> = item.split(',').collect();
        if f.len() < 7 {
            continue;
        }
        // f[0]=sh600519, f[1]=名称, f[2]=现价, f[3]=涨跌幅%, f[4]=涨跌额, f[5]=成交量(手), f[6]=成交额(万)
        let code = f[0].trim().trim_start_matches("sh").trim_start_matches("sz").trim_start_matches("bj").to_string();
        if code.len() != 6 {
            continue;
        }
        let name = f[1].trim_matches('"').to_string();
        let price: f64 = f[2].parse().unwrap_or(0.0);
        let pct: f64 = f[3].parse().unwrap_or(0.0);
        let change: f64 = f[4].parse().unwrap_or(0.0);
        let volume: f64 = f[5].parse().unwrap_or(0.0);
        let amount_wan: f64 = f[6].parse().unwrap_or(0.0);
        out.push(Quote {
            code,
            name,
            price,
            change,
            pct,
            open: 0.0,
            high: 0.0,
            low: 0.0,
            prev_close: 0.0,
            volume,
            amount: amount_wan * 1e4,
            time: now,
            source: "tencent".to_string(),
            turnover: 0.0,
            pe: 0.0,
            pb: 0.0,
            amplitude: 0.0,
            volume_ratio: 0.0,
            circ_mv: 0.0,
            total_mv: 0.0,
        });
    }
    if out.is_empty() {
        return Err("腾讯榜单返回空".to_string());
    }
    Ok(out)
}

// ===== 五档盘口（单股） =====
pub async fn orderbook(code: &str) -> Result<OrderBook, String> {
    let sym = cnc_symbol(code);
    let url = format!("https://qt.gtimg.cn/q={sym}");
    let resp = http().get(&url).send().await.map_err(|e| e.to_string())?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let (txt, _, _) = encoding_rs::GBK.decode(&bytes);
    let line = txt.lines().next().unwrap_or("");
    let Some((_, right)) = line.split_once('=') else {
        return Err("盘口数据为空".to_string());
    };
    let payload = right.trim().trim_end_matches(';').trim_matches('"');
    let f: Vec<&str> = payload.split('~').collect();
    if f.len() < 38 {
        return Err("盘口字段不足".to_string());
    }
    let p = |i: usize| f[i].parse::<f64>().unwrap_or(0.0);
    // 腾讯 f[9..19] 卖1-5价量，f[19..29] 买1-5价量
    let asks: Vec<OrderLevel> = (0..5)
        .map(|i| OrderLevel { price: p(9 + i * 2), vol: p(10 + i * 2) })
        .collect();
    let bids: Vec<OrderLevel> = (0..5)
        .map(|i| OrderLevel { price: p(19 + i * 2), vol: p(20 + i * 2) })
        .collect();
    Ok(OrderBook {
        name: f[1].to_string(),
        code: f[2].to_string(),
        price: p(3),
        prev_close: p(4),
        open: p(5),
        volume: p(6),
        high: p(33),
        low: p(34),
        amount: p(37) * 1e4,
        asks,
        bids,
    })
}

// ===== K线 =====
/// period: 1/5/15/30/60 分钟, 101 日, 102 周, 103 月
pub async fn kline(code: &str, period: i64, count: i64) -> Result<Vec<KBar>, String> {
    let sym = cnc_symbol(code);

    if period < 100 {
        // 分钟线 mkline
        let mk = match period {
            1 => "m1",
            5 => "m5",
            15 => "m15",
            30 => "m30",
            60 => "m60",
            _ => "m5",
        };
        let url = format!(
            "https://ifzq.gtimg.cn/appstock/app/kline/mkline?param={},{},,{}",
            sym, mk, count
        );
        let v: Value = http()
            .get(&url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let rows = v["data"][sym][mk]
            .as_array()
            .ok_or("分钟K解析为空")?;
        return Ok(parse_rows(rows, period));
    }

    // 日/周/月：fqkline（前复权）
    let kp = match period {
        102 => "week",
        103 => "month",
        _ => "day",
    };
    let url = format!(
        "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={},{},,,{},qfq",
        sym, kp, count
    );
    let v: Value = http()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let node = &v["data"][sym];
    let qkey = format!("qfq{}", kp);
    let rows = node
        .get(&qkey)
        .or_else(|| node.get(kp))
        .and_then(|x| x.as_array())
        .ok_or("日K解析为空")?;
    Ok(parse_rows(rows, period))
}

/// 腾讯行：[date, open, close, high, low, volume, ...]
fn parse_rows(rows: &[Value], period: i64) -> Vec<KBar> {
    rows.iter()
        .filter_map(|r| {
            let a = r.as_array()?;
            if a.len() < 6 {
                return None;
            }
            let s = |i: usize| a[i].as_str().unwrap_or("0");
            Some(KBar {
                timestamp: tencent_ts(s(0), period),
                open: s(1).parse().unwrap_or(0.0),
                close: s(2).parse().unwrap_or(0.0),
                high: s(3).parse().unwrap_or(0.0),
                low: s(4).parse().unwrap_or(0.0),
                volume: s(5).parse().unwrap_or(0.0),
            })
        })
        .collect()
}

/// 腾讯时间串 -> ms：支持 "YYYY-MM-DD"、"YYYY-MM-DD HH:MM"、紧凑 "YYYYMMDDHHMM"
fn tencent_ts(s: &str, period: i64) -> i64 {
    use std::time::{Duration, UNIX_EPOCH};
    let s = s.trim();
    let norm = if s.contains('-') {
        s.to_string()
    } else if s.len() >= 12 {
        format!(
            "{}-{}-{} {}:{}",
            &s[0..4],
            &s[4..6],
            &s[6..8],
            &s[8..10],
            &s[10..12]
        )
    } else if s.len() == 8 {
        format!("{}-{}-{}", &s[0..4], &s[4..6], &s[6..8])
    } else {
        s.to_string()
    };
    let (d, t) = match norm.split_once(' ') {
        Some(x) => x,
        None => (norm.as_str(), if period >= 100 { "15:00" } else { "00:00" }),
    };
    let ymd: Vec<&str> = d.split('-').collect();
    let hm: Vec<&str> = t.split(':').collect();
    if ymd.len() != 3 {
        return 0;
    }
    let gi = |v: &[&str], i: usize, d: i64| v.get(i).and_then(|x| x.parse().ok()).unwrap_or(d);
    let y = gi(&ymd, 0, 1970);
    let mo = gi(&ymd, 1, 1);
    let dd = gi(&ymd, 2, 1);
    let h = gi(&hm, 0, 0);
    let mi = gi(&hm, 1, 0);
    let days = (y - 1970) * 365 + (y - 1969) / 4 + (mo - 1) * 30 + (dd - 1);
    let secs = days * 86400 + h * 3600 + mi * 60;
    (UNIX_EPOCH + Duration::from_secs(secs as u64))
        .duration_since(UNIX_EPOCH)
        .map(|x| x.as_millis() as i64)
        .unwrap_or(0)
}

// ===== 当日分时（同花顺式分时图数据源）=====
/// 返回当日分时数据，映射为 KBar（open=close=high=low=price，volume=当分钟量）
pub async fn minute(code: &str) -> Result<Vec<KBar>, String> {
    let sym = cnc_symbol(code);
    let url = format!("https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={sym}");
    let v: Value = http()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let node = &v["data"][sym]["data"];
    let date_str = node["date"].as_str().unwrap_or("");
    let arr = node["data"].as_array().ok_or("分时数据为空")?;
    let mut out = Vec::new();
    let mut prev_vol = 0.0f64;
    for item in arr {
        let s = item.as_str().ok_or("分时项格式错")?;
        let parts: Vec<&str> = s.split_whitespace().collect();
        if parts.len() < 4 { continue; }
        let hhmm = parts[0];
        let price: f64 = parts[1].parse().unwrap_or(0.0);
        let cumvol: f64 = parts[3].parse().unwrap_or(0.0);
        let vol = (cumvol - prev_vol).max(0.0);
        prev_vol = cumvol;
        let ts = minute_ts(date_str, hhmm);
        out.push(KBar {
            timestamp: ts,
            open: price,
            close: price,
            high: price,
            low: price,
            volume: vol,
        });
    }
    if out.is_empty() {
        return Err("分时返回空".to_string());
    }
    Ok(out)
}

/// "20260918" + "0930" -> ms
fn minute_ts(date: &str, hhmm: &str) -> i64 {
    use std::time::{Duration, UNIX_EPOCH};
    if date.len() != 8 || hhmm.len() != 4 {
        return 0;
    }
    let y: i64 = date[0..4].parse().unwrap_or(1970);
    let mo: i64 = date[4..6].parse().unwrap_or(1);
    let d: i64 = date[6..8].parse().unwrap_or(1);
    let h: i64 = hhmm[0..2].parse().unwrap_or(0);
    let mi: i64 = hhmm[2..4].parse().unwrap_or(0);
    let days = (y - 1970) * 365 + (y - 1969) / 4 + (mo - 1) * 30 + (d - 1);
    let secs = days * 86400 + h * 3600 + mi * 60;
    (UNIX_EPOCH + Duration::from_secs(secs as u64))
        .duration_since(UNIX_EPOCH)
        .map(|x| x.as_millis() as i64)
        .unwrap_or(0)
}

// ===== 搜索（smartbox，GBK） =====
pub async fn search(keyword: &str) -> Result<Vec<StockItem>, String> {
    let url = format!(
        "https://smartbox.gtimg.cn/s3/?t=all&q={}",
        urlencode(keyword)
    );
    let resp = http()
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    // smartbox 返回 ASCII，中文以 \uXXXX 转义
    let txt = String::from_utf8_lossy(&bytes);
    let line = txt.lines().next().unwrap_or("");
    let Some((_, right)) = line.split_once('=') else {
        return Ok(vec![]);
    };
    let payload = right.trim().trim_matches('"');

    let mut out = Vec::new();
    // 多条记录以 ';' 分隔：sh~600519~\u8d35...~gzmt~GP-A
    for rec in payload.split(';') {
        let f: Vec<&str> = rec.split('~').collect();
        if f.len() < 3 { continue };
        let prefix = f[0];
        let code = f[1];
        let name = unescape_unicode(f[2]);
        if code.len() == 6 && code.bytes().all(|c| c.is_ascii_digit()) {
            let market = match prefix {
                "sh" => "SH",
                "sz" => "SZ",
                "bj" => "BJ",
                _ => "BJ",
            };
            out.push(StockItem {
                code: code.to_string(),
                name,
                market: market.to_string(),
            });
        }
    }
    Ok(out)
}

/// 还原字符串中的 \uXXXX 转义（其余部分为 ASCII）
fn unescape_unicode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if i + 6 <= b.len() && b[i] == b'\\' && b[i + 1] == b'u' {
            if let Ok(hex) = std::str::from_utf8(&b[i + 2..i + 6]) {
                if let Ok(cp) = u32::from_str_radix(hex, 16) {
                    if let Some(ch) = char::from_u32(cp) {
                        out.push(ch);
                        i += 6;
                        continue;
                    }
                }
            }
        }
        out.push(b[i] as char);
        i += 1;
    }
    out
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
