// v2.32 盘口增强：分价成交分布、封单额趋势、集合竞价虚拟量曲线。
// 均取自免费公开源（东财 details/get 分笔明细 + 涨停池封单额采样），
// 源不支持 / 返回空时安全降级为对应空序列，不影响主盘口。
use super::eastmoney::{push2_json, ZtStock};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;
use tokio::sync::Mutex;

// ===== 对外结构 =====
/// 分价成交桶：某一成交价上的当日累计成交量（手），拆主动买/卖。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PriceBucket {
    pub price: f64,
    pub vol: f64,
    pub buy_vol: f64,
    pub sell_vol: f64,
}

/// 集合竞价虚拟快照点：09:15–09:25 间的虚拟参考价与累计虚拟匹配量（手）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuctionPoint {
    pub time: String,
    pub price: f64,
    pub match_vol: f64,
}

/// 封单额趋势点：涨停封单金额随时间变化（元）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SealPoint {
    pub time: String,
    pub fund: f64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DepthEnhance {
    pub price_dist: Vec<PriceBucket>,
    pub auction: Vec<AuctionPoint>,
    pub seal_trend: Vec<SealPoint>,
}

// ===== 分笔明细拉取（单次取全量，受源返回上限约束）=====
async fn fetch_details(code: &str) -> Result<Vec<Vec<String>>, String> {
    let secid = format!("{}.{}", super::secid_prefix(code), code);
    // pos 负偏移 + 大 col：尽量一次取当日全部分笔；含集合竞价(dir=4)与连续竞价(dir=1/2)。
    let path = format!(
        "/api/qt/stock/details/get?secid={secid}\
         &fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55\
         &pos=-200000&col=200000&np=1&fltt=1&invt=2"
    );
    let v = push2_json(&path).await?;
    let arr = v["data"]["details"]
        .as_array()
        .ok_or("分笔明细为空")?;
    Ok(arr
        .iter()
        .filter_map(|it| {
            let s = it.as_str()?;
            Some(s.split(',').map(|x| x.to_string()).collect())
        })
        .collect())
}

/// 由全部分笔构造分价成交分布（连续竞价，剔除竞价/盘后）与竞价虚拟曲线。
fn build(rows: &[Vec<String>], seal: Vec<SealPoint>) -> DepthEnhance {
    // 价格 2 位小数 → 以“分”为整数键聚合，规避 f64 哈希。
    let mut buckets: BTreeMap<i64, (f64, f64, f64)> = BTreeMap::new();
    let mut auction: Vec<AuctionPoint> = Vec::new();

    for p in rows {
        if p.len() < 5 {
            continue;
        }
        let (time, price_s, vol_s) = (&p[0], &p[1], &p[2]);
        let price: f64 = price_s.parse().unwrap_or(0.0);
        let vol: f64 = vol_s.parse().unwrap_or(0.0);
        if price <= 0.0 || vol <= 0.0 {
            continue;
        }
        // 集合竞价段：09:15:00–09:25:00，该量列为累计虚拟匹配量。
        if time.as_str() >= "09:15:00" && time.as_str() <= "09:25:00" {
            auction.push(AuctionPoint {
                time: time.clone(),
                price,
                match_vol: vol,
            });
            continue;
        }
        // 连续竞价：09:30:00–15:00:00，按方向累计。
        if time.as_str() < "09:30:00" || time.as_str() > "15:00:00" {
            continue;
        }
        let dir = p[4].as_str();
        let key = (price * 100.0).round() as i64;
        let e = buckets.entry(key).or_insert((price, 0.0, 0.0));
        e.0 = price;
        match dir {
            "2" => e.1 += vol, // 主动买
            "1" => e.2 += vol, // 主动卖
            _ => {}
        }
    }

    let price_dist = buckets
        .into_values()
        .map(|(price, buy, sell)| PriceBucket {
            price,
            vol: buy + sell,
            buy_vol: buy,
            sell_vol: sell,
        })
        .collect();

    DepthEnhance {
        price_dist,
        auction,
        seal_trend: seal,
    }
}

// ===== 结果短缓存：避免放大盘口多标签切换时重复拉取 =====
static ENH_CACHE: OnceLock<Mutex<HashMap<String, (i64, DepthEnhance)>>> = OnceLock::new();

/// 盘口增强聚合入口（前端 command 调用）。任何子项失败都安全降级为空。
pub async fn depth_enhance(code: &str) -> Result<DepthEnhance, String> {
    let cache = ENH_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let now = super::now_millis();
    {
        let g = cache.lock().await;
        if let Some((at, d)) = g.get(code) {
            if now - at < 20_000 {
                return Ok(d.clone());
            }
        }
    }

    let seal = seal_trend(code);
    // 分笔明细失败：仍返回封单趋势 + 两个空序列（安全降级）。
    let data = match fetch_details(code).await {
        Ok(rows) => build(&rows, seal),
        Err(_) => DepthEnhance {
            seal_trend: seal,
            ..Default::default()
        },
    };

    let mut g = cache.lock().await;
    g.insert(code.to_string(), (now, data.clone()));
    Ok(data)
}

// ===== 封单额趋势：涨停雷达每轮采样，进程内时间序列 =====
/// code -> (day, Vec<(ms, fund)>)
type SealStore = HashMap<String, (i32, Vec<(i64, f64)>)>;
static SEAL_STORE: OnceLock<Mutex<SealStore>> = OnceLock::new();

/// 涨停雷达每轮（约 1 分钟）调用：记录当日仍封板个股的封单金额。
pub async fn record_seal_snapshot(pool: &[ZtStock]) {
    let now = super::now_millis();
    let day = beijing_day(now);
    let store = SEAL_STORE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut g = store.lock().await;
    for s in pool {
        if s.fund <= 0.0 {
            continue;
        }
        let e = g.entry(s.code.clone()).or_insert((day, Vec::new()));
        if e.0 != day {
            // 跨交易日：清空旧曲线重新累计。
            e.0 = day;
            e.1.clear();
        }
        let push = match e.1.last() {
            None => true,
            Some((last_ms, last_fund)) => (now - last_ms) >= 60_000 || (*last_fund - s.fund).abs() > 1.0,
        };
        if push {
            e.1.push((now, s.fund));
        }
    }
}

/// 读取某只个股当日封单额趋势（升序，时间为 HH:MM）。
pub fn seal_trend(code: &str) -> Vec<SealPoint> {
    let store = SEAL_STORE.get_or_init(|| Mutex::new(HashMap::new()));
    // 同步读取 try_lock：采样在独立任务、持锁极短；取不到则本轮返回空，安全降级。
    let g = match store.try_lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    let now = super::now_millis();
    let day = beijing_day(now);
    g.get(code)
        .filter(|(d, _)| *d == day)
        .map(|(_, pts)| {
            pts.iter()
                .map(|(ms, fund)| SealPoint {
                    time: hhmm(*ms),
                    fund: *fund,
                })
                .collect()
        })
        .unwrap_or_default()
}

// ===== 北京时间工具（无 chrono，UTC+8）=====
fn beijing_day(ms: i64) -> i32 {
    let secs = ms / 1000 + 8 * 3600;
    (secs / 86400) as i32 // 自 1970 起的天数；仅用于同日比较，无需转年月日
}

fn hhmm(ms: i64) -> String {
    let secs = ms / 1000 + 8 * 3600;
    let h = (secs % 86400) / 3600;
    let m = (secs % 3600) / 60;
    format!("{h:02}:{m:02}")
}
