// 腾讯数据源：实时行情（GBK，qt.gtimg.cn）、K线（UTF-8，web.ifzq.gtimg.cn）、搜索（GBK，smartbox）
use super::{cnc_symbol, http, now_millis, KBar, Quote, StockItem};
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
        if f.len() < 38 { continue };
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
        });
    }
    Ok(out)
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
