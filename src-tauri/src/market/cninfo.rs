// 新股 / 解禁日历：巨潮新股发行（AES mcode 签名）+ 新浪个股限售解禁（GBK HTML）。
use crate::market::http;
use aes::Aes128;
use base64::Engine;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockEncryptMut, KeyIvInit};
use cbc::Encryptor;
use encoding_rs::GBK;
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ===== 输出结构 =====
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct IpoItem {
    pub code: String,
    pub name: String,
    pub apply_date: String,      // 申购日 F002D
    pub list_date: String,       // 上市日 F006D
    pub pay_date: String,        // 中签缴款日 F037D
    pub issue_price: Option<f64>, // F008N
    pub pe: Option<f64>,         // F013N 发行市盈率
    pub lot_rate: Option<f64>,   // F006N 中签率（小数）
    pub apply_limit: Option<f64>, // F042N 网上申购上限（万股）
    pub total_qty: Option<f64>,  // F003N 总发行数量（万股）
    pub online_qty: Option<f64>, // F043N 上网发行数量（万股）
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RestrictedItem {
    pub code: String,
    pub name: String,
    pub lift_date: String,
    pub lift_qty: Option<f64>,  // 解禁数量（万股）
    pub lift_value: Option<f64>, // 解禁流通市值（亿元）
    pub batch: Option<i64>,     // 上市批次
    pub notice_date: String,
}

// ===== mcode：AES-128-CBC 加密当前秒级时间戳，再 Base64 =====
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn mcode() -> String {
    let key: [u8; 16] = *b"1234567887654321";
    let iv: [u8; 16] = *b"1234567887654321";
    let secs = now_secs().to_string();
    let ciphertext = Encryptor::<Aes128>::new(&key.into(), &iv.into())
        .encrypt_padded_vec_mut::<Pkcs7>(secs.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(ciphertext)
}

// ===== 巨潮新股发行 =====
#[derive(Deserialize, Default, Debug)]
struct RawIpo {
    #[serde(rename = "SECCODE")] sec_code: Option<String>,
    #[serde(rename = "SECNAME")] sec_name: Option<String>,
    #[serde(rename = "F002D")] f002d: Option<String>,
    #[serde(rename = "F006D")] f006d: Option<String>,
    #[serde(rename = "F037D")] f037d: Option<String>,
    #[serde(rename = "F008N")] f008n: Option<f64>,
    #[serde(rename = "F013N")] f013n: Option<f64>,
    #[serde(rename = "F006N")] f006n: Option<f64>,
    #[serde(rename = "F042N")] f042n: Option<f64>,
    #[serde(rename = "F003N")] f003n: Option<f64>,
    #[serde(rename = "F043N")] f043n: Option<f64>,
}
#[derive(Deserialize, Debug)]
struct IpoResp {
    records: Vec<RawIpo>,
}

pub async fn get_ipo_list() -> Result<Vec<IpoItem>, String> {
    let url = "https://webapi.cninfo.com.cn/api/sysapi/p_sysapi1097?timetype=36&market=ALL";
    let resp = tokio::time::timeout(
        Duration::from_secs(20),
        http().post(url)
            .header("Accept", "*/*")
            .header("Accept-Enckey", mcode())
            .header("Origin", "https://webapi.cninfo.com.cn")
            .header("Referer", "https://webapi.cninfo.com.cn/")
            .header("X-Requested-With", "XMLHttpRequest")
            .send(),
    )
    .await
    .map_err(|_| "请求超时".to_string())?
    .map_err(|e| e.to_string())?;
    let j: IpoResp = resp.json().await.map_err(|e| e.to_string())?;
    let mut items: Vec<IpoItem> = j
        .records
        .iter()
        .filter_map(|r| {
            let code = r.sec_code.clone()?;
            Some(IpoItem {
                code,
                name: r.sec_name.clone().unwrap_or_default(),
                apply_date: r.f002d.clone().unwrap_or_default(),
                list_date: r.f006d.clone().unwrap_or_default(),
                pay_date: r.f037d.clone().unwrap_or_default(),
                issue_price: r.f008n,
                pe: r.f013n,
                lot_rate: r.f006n,
                apply_limit: r.f042n,
                total_qty: r.f003n,
                online_qty: r.f043n,
            })
        })
        .collect();
    items.sort_by(|a, b| b.apply_date.cmp(&a.apply_date));
    Ok(items)
}

// ===== 新浪个股限售解禁 =====
fn sina_symbol(code: &str) -> Option<String> {
    match code.chars().next() {
        Some('6') => Some(format!("sh{}", code)),
        Some('0') | Some('3') => Some(format!("sz{}", code)),
        Some('8') | Some('4') | Some('9') => Some(format!("bj{}", code)),
        _ => None,
    }
}

fn parse_num(s: &str) -> Option<f64> {
    s.trim().replace(",", "").parse::<f64>().ok()
}

pub async fn get_restricted_queue(code: String) -> Result<Vec<RestrictedItem>, String> {
    let sym = sina_symbol(&code).ok_or_else(|| "不支持的代码".to_string())?;
    let url = format!(
        "https://vip.stock.finance.sina.com.cn/q/go.php/vInvestConsult/kind/xsjj/index.phtml?symbol={}",
        sym
    );
    let resp = tokio::time::timeout(
        Duration::from_secs(20),
        http().get(&url)
            .header("Referer", "https://vip.stock.finance.sina.com.cn/")
            .send(),
    )
    .await
    .map_err(|_| "请求超时".to_string())?
    .map_err(|e| e.to_string())?;
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let (html, _, _) = GBK.decode(&bytes);
    Ok(parse_restricted(&html.into_owned()))
}

fn parse_restricted(html: &str) -> Vec<RestrictedItem> {
    let doc = Html::parse_document(html);
    let tr_sel = Selector::parse("table#dataTable tr").unwrap();
    let td_sel = Selector::parse("td").unwrap();
    let mut out: Vec<RestrictedItem> = Vec::new();
    for tr in doc.select(&tr_sel) {
        let tds: Vec<ElementRef> = tr.select(&td_sel).collect();
        if tds.len() < 7 {
            continue;
        }
        let txt = |i: usize| {
            tds.get(i)
                .map(|e| e.text().collect::<Vec<_>>().join(""))
                .unwrap_or_default()
        };
        let code = txt(0).trim().to_string();
        // 跳过表头行
        if code.is_empty() || code == "代码" {
            continue;
        }
        out.push(RestrictedItem {
            code,
            name: txt(1).trim().to_string(),
            lift_date: txt(2).trim().to_string(),
            lift_qty: parse_num(&txt(3)),
            lift_value: parse_num(&txt(4)),
            batch: txt(5).trim().parse().ok(),
            notice_date: txt(6).trim().to_string(),
        });
    }
    out.sort_by(|a, b| b.lift_date.cmp(&a.lift_date));
    out
}
