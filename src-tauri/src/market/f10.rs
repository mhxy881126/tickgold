// F10 个股资料：公司概况 / 财务指标（新浪 F10，GBK HTML）+ 筹码分布（日K自算）。
use crate::market::{http, KBar};
use encoding_rs::GBK;
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Kv {
    pub key: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompanyProfile {
    pub code: String,
    pub name: String,
    pub en_name: String,
    pub market: String,
    pub list_date: String,
    pub issue_price: String,
    pub underwriter: String,
    pub establish_date: String,
    pub reg_capital: String,
    pub org_type: String,
    pub secretary: String,
    pub phone: String,
    pub fax: String,
    pub email: String,
    pub website: String,
    pub postcode: String,
    pub reg_address: String,
    pub office_address: String,
    pub intro: String,
    pub main_business: String,
    pub fields: Vec<Kv>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FinanceRow {
    pub name: String,
    pub values: Vec<Option<f64>>,
}
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FinanceGroup {
    pub name: String,
    pub rows: Vec<FinanceRow>,
}
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct FinanceReport {
    pub periods: Vec<String>,
    pub groups: Vec<FinanceGroup>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChipDistribution {
    pub current_price: f64,
    pub avg_cost: f64,
    pub profit_ratio: f64,
    pub low90: f64,
    pub high90: f64,
    pub concentration90: f64,
    pub low70: f64,
    pub high70: f64,
    pub concentration70: f64,
    pub prices: Vec<f64>,
    pub chips: Vec<f64>,
}

// ===== 通用辅助 =====
fn clean(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

async fn fetch_gbk(url: &str) -> Result<String, String> {
    let resp = tokio::time::timeout(Duration::from_secs(20), http().get(url).send())
        .await
        .map_err(|_| "请求超时".to_string())?
        .map_err(|e| e.to_string())?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let (txt, _, _) = GBK.decode(&bytes);
    Ok(txt.into_owned())
}

fn el_text(el: &ElementRef) -> String {
    let parts: Vec<&str> = el.text().collect();
    clean(&parts.join(""))
}

fn current_year() -> i32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let z = (secs / 86400) as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    yoe as i32 + era as i32 * 400
}

// ===== 公司概况 =====
pub async fn get_profile(code: String) -> Result<CompanyProfile, String> {
    let url = format!(
        "https://vip.stock.finance.sina.com.cn/corp/go.php/vCI_CorpInfo/stockid/{}.phtml",
        code
    );
    let html = fetch_gbk(&url).await?;
    Ok(parse_profile(&code, &html))
}

fn parse_profile(code: &str, html: &str) -> CompanyProfile {
    let doc = Html::parse_document(html);
    let tr_sel = Selector::parse("table#comInfo1 tr").unwrap();
    let td_sel = Selector::parse("td").unwrap();
    let mut fields: Vec<Kv> = Vec::new();
    for tr in doc.select(&tr_sel) {
        let tds: Vec<ElementRef> = tr.select(&td_sel).collect();
        let mut pending: Option<String> = None;
        for td in tds {
            let cls = td.value().attr("class").unwrap_or("");
            let txt = el_text(&td);
            if cls == "ct" {
                pending = Some(txt.trim_end_matches('：').trim_end_matches(':').to_string());
            } else if let Some(k) = pending.take() {
                if !k.is_empty() {
                    fields.push(Kv { key: k, value: txt });
                }
            }
        }
    }
    let get = |k: &str| -> String {
        fields
            .iter()
            .find(|f| f.key == k)
            .map(|f| f.value.clone())
            .unwrap_or_default()
    };
    CompanyProfile {
        code: code.to_string(),
        name: get("公司名称"),
        en_name: get("公司英文名称"),
        market: get("上市市场"),
        list_date: get("上市日期"),
        issue_price: get("发行价格"),
        underwriter: get("主承销商"),
        establish_date: get("成立日期"),
        reg_capital: get("注册资本"),
        org_type: get("机构类型"),
        secretary: get("董事会秘书"),
        phone: get("公司电话"),
        fax: get("公司传真"),
        email: get("公司电子邮箱"),
        website: get("公司网址"),
        postcode: get("邮政编码"),
        reg_address: get("注册地址"),
        office_address: get("办公地址"),
        intro: get("公司简介"),
        main_business: get("主营业务"),
        fields,
    }
}

// ===== 财务指标 =====
pub async fn get_finance(code: String) -> Result<FinanceReport, String> {
    let year = current_year();
    let url = format!(
        "https://vip.stock.finance.sina.com.cn/corp/go.php/vFD_FinancialGuideLine/stockid/{}/ctrl/{}/displaytype/4.phtml",
        code, year
    );
    let html = fetch_gbk(&url).await?;
    let rep = parse_finance(&html);
    let n: usize = rep.groups.iter().map(|g| g.rows.len()).sum();
    if n < 3 {
        let url2 = format!(
            "https://vip.stock.finance.sina.com.cn/corp/go.php/vFD_FinancialGuideLine/stockid/{}/ctrl/{}/displaytype/4.phtml",
            code,
            year - 1
        );
        if let Ok(h2) = fetch_gbk(&url2).await {
            return Ok(parse_finance(&h2));
        }
    }
    Ok(rep)
}

fn parse_num(s: &str) -> Option<f64> {
    let t = s.replace(',', "");
    let t = t.trim();
    if t.is_empty() || t == "--" || t == "-" {
        None
    } else {
        t.parse::<f64>().ok()
    }
}

fn parse_finance(html: &str) -> FinanceReport {
    let doc = Html::parse_document(html);
    let tr_sel = Selector::parse("table#BalanceSheetNewTable0 tbody tr").unwrap();
    let td_sel = Selector::parse("td").unwrap();
    let mut periods: Vec<String> = Vec::new();
    let mut groups: Vec<FinanceGroup> = Vec::new();
    let mut cur = FinanceGroup {
        name: "核心指标".to_string(),
        rows: Vec::new(),
    };
    for tr in doc.select(&tr_sel) {
        let tds: Vec<ElementRef> = tr.select(&td_sel).collect();
        if tds.is_empty() {
            continue;
        }
        // 分组标题行（单格 colspan）
        let is_group = tds.len() == 1 || tds[0].value().attr("colspan").is_some();
        if is_group {
            let gname = el_text(&tds[0]);
            if !gname.is_empty() {
                if !cur.rows.is_empty() || !groups.is_empty() {
                    groups.push(std::mem::take(&mut cur));
                }
                cur.name = gname;
            }
            continue;
        }
        let first = el_text(&tds[0]);
        if first.contains("报告日期") {
            periods = tds[1..].iter().map(el_text).collect();
            continue;
        }
        let values = tds[1..].iter().map(|td| parse_num(&el_text(td))).collect();
        cur.rows.push(FinanceRow { name: first, values });
    }
    if cur.name != "核心指标" || !cur.rows.is_empty() {
        groups.push(cur);
    }
    FinanceReport { periods, groups }
}

// ===== 筹码分布（日K自算：三角分布 + 历史衰减）=====
pub async fn get_chips(code: String) -> Result<ChipDistribution, String> {
    let bars = crate::market::get_kline(code, 101, 260).await?;
    compute_chips(&bars)
}

fn compute_chips(all: &[KBar]) -> Result<ChipDistribution, String> {
    if all.len() < 30 {
        return Err("日K数据不足，无法计算筹码分布".to_string());
    }
    // 取最近 140 个交易日作为筹码窗口
    let win: &[KBar] = if all.len() > 140 {
        &all[all.len() - 140..]
    } else {
        all
    };
    let mut lo = f64::MAX;
    let mut hi = f64::MIN;
    for b in win {
        if b.low < lo {
            lo = b.low;
        }
        if b.high > hi {
            hi = b.high;
        }
    }
    let bins = 120usize;
    let step = (hi - lo) / bins as f64;
    if step <= 0.0 {
        return Err("价格区间异常".to_string());
    }
    let mut chips = vec![0f64; bins];
    let decay = 0.96; // 经验日衰减（约对应每日 4% 换手），远期货逐步淡出
    for b in win {
        for c in chips.iter_mut() {
            *c *= decay;
        }
        let avg = (b.high + b.low + 2.0 * b.close) / 4.0;
        let il = (((b.low - lo) / step).floor() as i64).max(0) as usize;
        let ih = (((b.high - lo) / step).ceil() as i64).min(bins as i64 - 1) as usize;
        let mut w = vec![0f64; bins];
        let mut wsum = 0f64;
        for i in il..=ih {
            let p = lo + (i as f64 + 0.5) * step;
            let tri = if p <= avg {
                if avg > b.low {
                    (p - b.low) / (avg - b.low)
                } else {
                    1.0
                }
            } else if b.high > avg {
                (b.high - p) / (b.high - avg)
            } else {
                1.0
            };
            w[i] = tri.max(0.0);
            wsum += w[i];
        }
        if wsum > 0.0 {
            for i in il..=ih {
                chips[i] += w[i] / wsum * b.volume;
            }
        }
    }
    let total: f64 = chips.iter().sum();
    if total <= 0.0 {
        return Err("筹码计算为空".to_string());
    }
    let prices: Vec<f64> = (0..bins).map(|i| lo + (i as f64 + 0.5) * step).collect();
    let cur = win.last().unwrap().close;
    let mut avg_cost = 0f64;
    let mut below = 0f64;
    for i in 0..bins {
        avg_cost += prices[i] * chips[i];
        if prices[i] <= cur {
            below += chips[i];
        }
    }
    avg_cost /= total;
    let cdf = |q: f64| -> f64 {
        let target = total * q;
        let mut acc = 0f64;
        for i in 0..bins {
            acc += chips[i];
            if acc >= target {
                return prices[i];
            }
        }
        prices[bins - 1]
    };
    let low90 = cdf(0.05);
    let high90 = cdf(0.95);
    let low70 = cdf(0.15);
    let high70 = cdf(0.85);
    Ok(ChipDistribution {
        current_price: cur,
        avg_cost,
        profit_ratio: below / total * 100.0,
        low90,
        high90,
        concentration90: (high90 - low90) / (high90 + low90) * 100.0,
        low70,
        high70,
        concentration70: (high70 - low70) / (high70 + low70) * 100.0,
        prices,
        chips,
    })
}
