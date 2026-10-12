// 资金流数据（v2.28）：个股四档资金（超大/大/中/小散）、大盘主力全景（两市分时+多日）、
// 行业/概念资金排名。数据源东方财富，接口失败返回错误由调用方安全降级。
use super::{secid_prefix};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

/// 单日资金流（元；占比 %）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FundFlowDay {
    pub date: String,
    pub main_net: f64,    // 主力净流入 = 超大+大单
    pub super_net: f64,   // 超大单净流入
    pub large_net: f64,   // 大单净流入
    pub medium_net: f64,  // 中单净流入
    pub small_net: f64,   // 小单净流入
    pub main_pct: f64,    // 主力净流入占比 %
    pub close: f64,
    pub pct: f64,         // 涨跌幅 %
}

/// 个股多日四档资金流
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StockFundFlow {
    pub code: String,
    pub name: String,
    pub days: Vec<FundFlowDay>,
}

/// 大盘主力资金全景（沪市 1.000001 + 深市 0.399001 合计）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarketFundPanorama {
    pub main_net_today: f64,      // 今日主力净流入合计（元，最新分时点）
    pub minute_times: Vec<String>, // HH:MM
    pub minute_main: Vec<f64>,    // 分时主力净流入累计（元）
    pub trend: Vec<FundFlowDay>,   // 多日主力趋势（合计）
}

/// 板块资金排名行
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FundRankRow {
    pub code: String,
    pub name: String,
    pub pct: f64,        // 板块涨跌幅 %
    pub main_net: f64,   // 主力净流入（元）
}

// ===== 底层取数 =====

/// push2his 直取（日级历史）；失败再走 push2 多节点
async fn his_json(path: &str) -> Result<Value, String> {
    let url = format!("https://push2his.eastmoney.com{path}");
    match super::http()
        .get(&url)
        .header("Referer", "https://quote.eastmoney.com/")
        .timeout(Duration::from_secs(6))
        .send()
        .await
    {
        Ok(resp) => match resp.json::<Value>().await {
            Ok(v) => return Ok(v),
            Err(e) => log::warn!("push2his 解析失败，转 push2: {e}"),
        },
        Err(e) => log::warn!("push2his 不可达，转 push2: {e}"),
    }
    super::eastmoney::push2_json(path).await
}

/// 解析 fflow daykline 行：
/// f51 日期 f52 主力 f53 小单 f54 中单 f55 大单 f56 超大
/// f57 主力占比 f58 小单占比 f59 中单占比 f60 大单占比 f61 超大占比 f62 收盘 f63 涨跌幅
fn parse_day_line(s: &str) -> Option<FundFlowDay> {
    let f: Vec<&str> = s.split(',').collect();
    if f.len() < 13 {
        return None;
    }
    let num = |i: usize| f[i].parse::<f64>().unwrap_or(0.0);
    Some(FundFlowDay {
        date: f[0].to_string(),
        main_net: num(1),
        small_net: num(2),
        medium_net: num(3),
        large_net: num(4),
        super_net: num(5),
        main_pct: num(6),
        close: num(11),
        pct: num(12),
    })
}

fn daykline_path(secid: &str, days: i64) -> String {
    format!(
        "/api/qt/stock/fflow/daykline/get?secid={secid}&lmt={}\
         &klt=101&fields1=f1,f2,f3,f7\
         &fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63",
        days.clamp(1, 365)
    )
}

// ===== 个股四档资金流 =====
pub async fn fund_flow(code: &str, days: i64) -> Result<StockFundFlow, String> {
    let secid = format!("{}.{}", secid_prefix(code), code);
    let v = his_json(&daykline_path(&secid, days)).await?;
    let d = &v["data"];
    let name = d.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let klines = d.get("klines").and_then(|x| x.as_array()).ok_or("资金流为空")?;
    let mut rows: Vec<FundFlowDay> = klines
        .iter()
        .filter_map(|x| x.as_str())
        .filter_map(parse_day_line)
        .collect();
    if rows.is_empty() {
        return Err("资金流返回空".to_string());
    }
    // 接口默认升序，反转为最近在前
    rows.reverse();
    Ok(StockFundFlow {
        code: code.to_string(),
        name,
        days: rows,
    })
}

// ===== 大盘主力全景 =====

/// 指数日级资金（多日，升序）
async fn index_day(secid: &str, days: i64) -> Result<Vec<FundFlowDay>, String> {
    let v = his_json(&daykline_path(secid, days)).await?;
    let klines = v["data"].get("klines").and_then(|x| x.as_array()).ok_or("指数资金为空")?;
    Ok(klines
        .iter()
        .filter_map(|x| x.as_str())
        .filter_map(parse_day_line)
        .collect())
}

/// 指数分时主力净流入：返回 (时间标签映射, 升序行 (HH:MM, 主力净流入))
async fn index_minute(secid: &str) -> Result<Vec<(String, f64)>, String> {
    let path = format!(
        "/api/qt/stock/fflow/kline/get?secid={secid}&klt=1&lmt=0\
         &fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57"
    );
    let v = super::eastmoney::push2_json(&path).await?;
    let klines = v["data"].get("klines").and_then(|x| x.as_array()).ok_or("指数分时资金为空")?;
    let mut out = Vec::new();
    for item in klines {
        let s = match item.as_str() {
            Some(s) => s,
            None => continue,
        };
        let f: Vec<&str> = s.split(',').collect();
        if f.len() < 2 || f[0].len() < 16 {
            continue;
        }
        // f51 "YYYY-MM-DD HH:MM"
        let hhmm = f[0][11..16].to_string();
        let main = f[1].parse::<f64>().unwrap_or(0.0);
        out.push((hhmm, main));
    }
    Ok(out)
}

/// 两市合计：按时间标签对齐求和
fn merge_series(a: Vec<(String, f64)>, b: Vec<(String, f64)>) -> (Vec<String>, Vec<f64>) {
    use std::collections::BTreeMap;
    let mut map: BTreeMap<String, f64> = BTreeMap::new();
    let mut all = a;
    all.extend(b);
    for (t, v) in all {
        *map.entry(t).or_insert(0.0) += v;
    }
    let mut times = Vec::new();
    let mut vals = Vec::new();
    for (t, v) in map {
        times.push(t);
        vals.push(v);
    }
    (times, vals)
}

pub async fn market_panorama(days: i64) -> Result<MarketFundPanorama, String> {
    // 分时（两市并行）
    let minute = {
        let sh = index_minute("1.000001");
        let sz = index_minute("0.399001");
        let (a, b) = tokio::join!(sh, sz);
        match (a, b) {
            (Ok(a), Ok(b)) => Some(merge_series(a, b)),
            (a, b) => {
                log::warn!("大盘分时资金获取失败 sh={:?} sz={:?}", a.err(), b.err());
                None
            }
        }
    };

    // 多日趋势（两市并行）
    let trend = {
        let sh = index_day("1.000001", days);
        let sz = index_day("0.399001", days);
        let (a, b) = tokio::join!(sh, sz);
        match (a, b) {
            (Ok(a), Ok(b)) => merge_days(&a, &b),
            (a, b) => return Err(format!("大盘资金趋势获取失败: {:?} / {:?}", a.err(), b.err())),
        }
    };

    let (minute_times, minute_main, main_net_today) = match minute {
        Some((t, v)) => {
            let last = *v.last().unwrap_or(&0.0);
            (t, v, last)
        }
        None => (vec![], vec![], 0.0),
    };

    Ok(MarketFundPanorama {
        main_net_today,
        minute_times,
        minute_main,
        trend,
    })
}

/// 两市多日资金按日期对齐求和（输出升序）
fn merge_days(a: &[FundFlowDay], b: &[FundFlowDay]) -> Vec<FundFlowDay> {
    use std::collections::BTreeMap;
    // 各档位分别累计
    let mut main_m: BTreeMap<String, f64> = BTreeMap::new();
    let mut super_m = main_m.clone();
    let mut large_m = main_m.clone();
    let mut medium_m = main_m.clone();
    let mut small_m = main_m.clone();
    let mut pct_m: BTreeMap<String, (f64, f64)> = BTreeMap::new(); // (pct和, 计数)
    let add = |m: &mut BTreeMap<String, f64>, rows: &[FundFlowDay], get: fn(&FundFlowDay) -> f64| {
        for r in rows {
            *m.entry(r.date.clone()).or_insert(0.0) += get(r);
        }
    };
    add(&mut main_m, a, |r| r.main_net);
    add(&mut main_m, b, |r| r.main_net);
    add(&mut super_m, a, |r| r.super_net);
    add(&mut super_m, b, |r| r.super_net);
    add(&mut large_m, a, |r| r.large_net);
    add(&mut large_m, b, |r| r.large_net);
    add(&mut medium_m, a, |r| r.medium_net);
    add(&mut medium_m, b, |r| r.medium_net);
    add(&mut small_m, a, |r| r.small_net);
    add(&mut small_m, b, |r| r.small_net);
    for rows in [a, b] {
        for r in rows {
            let e = pct_m.entry(r.date.clone()).or_insert((0.0, 0.0));
            e.0 += r.pct;
            e.1 += 1.0;
        }
    }
    let total = main_m.iter().map(|(d, v)| {
        let den = |m: &BTreeMap<String, f64>| m.get(d).copied().unwrap_or(0.0);
        let pct_avg = pct_m.get(d).map(|(s, n)| s / *n).unwrap_or(0.0);
        // 主力占比按合计净额 / (五档绝对值合计) 无法精确还原，置 0，前端不依赖
        FundFlowDay {
            date: d.clone(),
            main_net: *v,
            super_net: den(&super_m),
            large_net: den(&large_m),
            medium_net: den(&medium_m),
            small_net: den(&small_m),
            main_pct: 0.0,
            close: 0.0,
            pct: pct_avg,
        }
    });
    total.collect()
}

// ===== 行业 / 概念资金排名 =====

/// kind: industry=行业板块(m:90 t:2)，concept=概念板块(m:90 t:3)
pub async fn fund_rank(kind: &str) -> Result<Vec<FundRankRow>, String> {
    let t = match kind {
        "concept" => "3",
        _ => "2",
    };
    let path = format!(
        "/api/qt/clist/get?pn=1&pz=200&po=1&np=1&fltt=2&invt=2\
         &fid=f62&fs=m:90+t:{t}&fields=f12,f14,f3,f62"
    );
    let v = super::eastmoney::push2_json(&path).await?;
    let diff = v["data"].get("diff").and_then(|x| x.as_array()).ok_or("板块资金排名为空")?;
    let get = |x: &Value, k: &str| x.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let mut rows: Vec<FundRankRow> = diff
        .iter()
        .map(|x| FundRankRow {
            code: x.get("f12").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            name: x.get("f14").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            pct: get(x, "f3"),
            main_net: get(x, "f62"),
        })
        .filter(|r| !r.code.is_empty())
        .collect();
    rows.sort_by(|a, b| b.main_net.partial_cmp(&a.main_net).unwrap_or(std::cmp::Ordering::Equal));
    Ok(rows)
}
