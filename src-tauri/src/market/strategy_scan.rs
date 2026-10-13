// 战法选股引擎（v2.31）：把验证过的短线打法沉淀为全市场可扫描、可订阅的量化条件。
// 战法：first_board 首板 / multi_board 连板 / reversal 反包 / weak_to_strong 弱转强 /
//      fund_resonance 资金共振 / theme_leader 题材龙头共振。
// 数据全部走多源容灾框架（zt_pool / rank_board / get_kline），本模块不另写 HTTP。
use super::eastmoney::{ZtPool, ZtStock};
use super::{get_kline, get_rank_board, get_zt_pool, today_yyyymmdd, KBar};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const TACTICS: [&str; 6] = [
    "first_board",
    "multi_board",
    "reversal",
    "weak_to_strong",
    "fund_resonance",
    "theme_leader",
];

#[allow(dead_code)] // 选股订阅推送摘要（本版本后半段）使用
pub fn tactic_label(t: &str) -> String {
    match t {
        "first_board" => "首板",
        "multi_board" => "连板",
        "reversal" => "反包",
        "weak_to_strong" => "弱转强",
        "fund_resonance" => "资金共振",
        "theme_leader" => "题材龙头",
        _ => return t.to_string(),
    }
    .to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct StrategyScanReq {
    /// 请求的战法 id；空 = 全部六种。
    #[serde(default)]
    pub tactics: Vec<String>,
    /// 每种战法最多返回条数。
    #[serde(default)]
    pub limit: Option<i64>,
    /// 行业/题材关键词过滤（仅对带行业信息的涨停池股票与自定义过滤生效）。
    #[serde(default)]
    pub theme: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TacticHit {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub pct: f64,
    pub amount: f64,
    pub turnover: f64,
    pub volume_ratio: f64,
    pub speed5: f64,
    pub main_net: f64,
    pub boards: u32,
    pub fund: f64,
    pub first_seal: i64,
    pub broken: u32,
    pub industry: String,
    pub tactics: Vec<String>,
    pub reasons: Vec<String>,
}

/// 一只候选股的全部输入。
pub(crate) struct Candidate<'a> {
    zt: Option<&'a ZtStock>,
    rank_main_net: f64,
    kbars: &'a [KBar],
}

/// 单战法判定：返回命中原因（None=未命中）。纯函数，离线可测。
/// kbars 升序，最后一根为当日；zt=当日涨停池记录（若有）。
pub(crate) fn classify(tactic: &str, c: &Candidate) -> Option<String> {
    let n = c.kbars.len();
    let today = c.kbars.last()?;
    let prev = if n >= 2 { c.kbars.get(n - 2) } else { None };
    match tactic {
        "first_board" => {
            let z = c.zt?;
            if z.boards == 1 {
                Some(format!("首板涨停 · 封单{:.1}亿 · 首封 {}", z.fund / 1e8, hms(z.first_seal)))
            } else {
                None
            }
        }
        "multi_board" => {
            let z = c.zt?;
            if z.boards >= 2 {
                Some(format!("{}连板 · 封单{:.2}亿", z.boards, z.fund / 1e8))
            } else {
                None
            }
        }
        "reversal" => {
            // 昨日阴线/调整，今日阳线实体向上包住昨日最高价。
            let p = prev?;
            let bear_prev = p.close < p.open;
            let bull_today = today.close > today.open;
            if bear_prev && bull_today && today.close >= p.high {
                Some(format!("阳包阴反包 · 收盘{:.2}站上昨日高点{:.2}", today.close, p.high))
            } else {
                None
            }
        }
        "weak_to_strong" => {
            // 昨日走弱（阴线或收跌），今日涨幅 ≥3% 且收盘靠近日内高点。
            let p = prev?;
            let weak_prev = p.close < p.open;
            let day_range = today.high - today.low;
            let close_pos = if day_range > 0.0 {
                (today.close - today.low) / day_range
            } else {
                0.0
            };
            let chg = if p.close > 0.0 {
                (today.close - p.close) / p.close * 100.0
            } else {
                0.0
            };
            if weak_prev && chg >= 3.0 && close_pos >= 0.7 {
                Some(format!("弱转强 · 涨{:.1}% · 收盘位于日高{:.0}%", chg, close_pos * 100.0))
            } else {
                None
            }
        }
        "fund_resonance" => {
            // 今日主力净流入 ≥5000万 且 昨日同步收阳/净流入（用 K 线阳线近似昨日资金态度）。
            let p = prev?;
            let yesterday_up = p.close >= p.open;
            if c.rank_main_net >= 5e7 && yesterday_up && today.close >= today.open {
                Some(format!(
                    "主力两日同向 · 今日净流入{:.2}亿",
                    c.rank_main_net / 1e8
                ))
            } else {
                None
            }
        }
        "theme_leader" => {
            // 当日涨停且为其行业内最高连板（同行业龙头）；boards 相同取封单更大者由调用方处理，
            // 此处 boards≥2 且 broken==0 视为强龙头。
            let z = c.zt?;
            if z.boards >= 2 && z.broken == 0 {
                Some(format!("{} · {}连板一字/硬板龙头", z.industry, z.boards))
            } else {
                None
            }
        }
        _ => None,
    }
}

/// 93105 → "09:31"。
fn hms(v: i64) -> String {
    let h = v / 10000;
    let m = (v / 100) % 100;
    format!("{h:02}:{m:02}")
}

/// 执行全市场扫描。
pub async fn scan(req: &StrategyScanReq) -> Result<Vec<TacticHit>, String> {
    let wanted: Vec<&str> = if req.tactics.is_empty() {
        TACTICS.to_vec()
    } else {
        req.tactics.iter().map(String::as_str).filter(|t| TACTICS.contains(t)).collect()
    };
    if wanted.is_empty() {
        return Ok(Vec::new());
    }

    // 1) 涨停池（板块龙头/首板/连板的权威来源；失败不致命）。
    let zt_pool = get_zt_pool(today_yyyymmdd())
        .await
        .unwrap_or_else(|_| ZtPool { date: String::new(), total: 0, list: Vec::new() });
    let zt_map: HashMap<&str, &ZtStock> =
        zt_pool.list.iter().map(|z| (z.code.as_str(), z)).collect();

    // 2) 涨幅榜前 300（反包/弱转强/资金共振的活跃股池）。
    let rank = get_rank_board("gainers".to_string(), 1, 300, "a".to_string())
        .await
        .unwrap_or_default();
    let rank_map: HashMap<&str, f64> =
        rank.iter().map(|r| (r.code.as_str(), r.main_net)).collect();

    // 3) 候选码并集。
    let mut codes: Vec<String> = zt_map.keys().map(|s| s.to_string()).collect();
    for r in &rank {
        if !zt_map.contains_key(r.code.as_str()) {
            codes.push(r.code.clone());
        }
    }

    // 4) 并发拉日 K（每只 10 根，JoinSet 并发 8）。
    let mut kdata: HashMap<String, Vec<KBar>> = HashMap::new();
    let mut set = tokio::task::JoinSet::new();
    for code in &codes {
        let c = code.clone();
        set.spawn(async move {
            let r = get_kline(c.clone(), 101, 10).await;
            (c, r)
        });
        // 控制在途任务数 ≤ 8。
        while set.len() >= 8 {
            if let Some(Ok((code, Ok(bars)))) = set.join_next().await {
                kdata.insert(code, bars);
            }
        }
    }
    while let Some(Ok((code, Ok(bars)))) = set.join_next().await {
        kdata.insert(code, bars);
    }

    // 5) 逐候选 × 逐战法分类。
    let mut per_tactic_count: HashMap<&str, i64> = HashMap::new();
    let limit = req.limit.unwrap_or(30).clamp(1, 100);
    let mut hits: Vec<TacticHit> = Vec::new();

    // 行业最高连板（题材龙头共振的同行业比较口径）。
    let mut industry_top_boards: HashMap<&str, u32> = HashMap::new();
    for z in &zt_pool.list {
        let e = industry_top_boards.entry(z.industry.as_str()).or_insert(0);
        *e = (*e).max(z.boards);
    }

    for code in &codes {
        let Some(kbars) = kdata.get(code) else { continue };
        let zt = zt_map.get(code.as_str()).copied();
        let rank_main_net = rank_map.get(code.as_str()).copied().unwrap_or(0.0);

        // theme 过滤：有行业信息的必须命中；无行业信息的非池股在 theme 条件下排除。
        if !req.theme.is_empty() {
            let industry = zt.map(|z| z.industry.clone()).unwrap_or_default();
            if !industry.contains(&req.theme) {
                continue;
            }
        }

        let c = Candidate { zt, rank_main_net, kbars };
        let mut tactics_hit: Vec<String> = Vec::new();
        let mut reasons: Vec<String> = Vec::new();
        for t in &wanted {
            // 题材龙头需同行业连板数最高（硬板条件已在 classify 中）。
            if *t == "theme_leader" {
                if let Some(z) = zt {
                    if industry_top_boards.get(z.industry.as_str()).copied() != Some(z.boards) {
                        continue;
                    }
                }
            }
            if let Some(reason) = classify(t, &c) {
                let used = per_tactic_count.get(*t).copied().unwrap_or(0);
                if used >= limit {
                    continue;
                }
                per_tactic_count.insert(*t, used + 1);
                tactics_hit.push(t.to_string());
                reasons.push(reason);
            }
        }
        if tactics_hit.is_empty() {
            continue;
        }

        let (price, amount, turnover, volume_ratio, speed5) =
            if let Some(r) = rank.iter().find(|r| r.code == *code) {
                (r.price, r.amount, r.turnover, r.volume_ratio, r.speed5)
            } else if let Some(z) = zt {
                (z.price, z.amount, z.turnover, 0.0, 0.0)
            } else {
                (0.0, 0.0, 0.0, 0.0, 0.0)
            };
        let (boards, fund, first_seal, broken, industry) = match zt {
            Some(z) => (z.boards, z.fund, z.first_seal, z.broken, z.industry.clone()),
            None => (0, 0.0, 0, 0, String::new()),
        };
        hits.push(TacticHit {
            code: code.clone(),
            name: zt.map(|z| z.name.clone()).unwrap_or_else(|| {
                rank.iter().find(|r| r.code == *code).map(|r| r.name.clone()).unwrap_or_default()
            }),
            price,
            pct: zt.map(|z| z.pct).unwrap_or_else(|| {
                rank.iter().find(|r| r.code == *code).map(|r| r.pct).unwrap_or(0.0)
            }),
            amount,
            turnover,
            volume_ratio,
            speed5,
            main_net: rank_main_net,
            boards,
            fund,
            first_seal,
            broken,
            industry,
            tactics: tactics_hit,
            reasons,
        });
    }

    // 涨停池股票优先，其次按主力净流入降序。
    hits.sort_by(|a, b| {
        b.boards.cmp(&a.boards).then_with(|| b.main_net.partial_cmp(&a.main_net).unwrap_or(std::cmp::Ordering::Equal))
    });
    Ok(hits)
}

#[tauri::command]
pub async fn strategy_scan_run(req: StrategyScanReq) -> Result<Vec<TacticHit>, String> {
    scan(&req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(o: f64, c: f64, h: f64, l: f64) -> KBar {
        KBar { timestamp: 0, open: o, close: c, high: h, low: l, volume: 1.0 }
    }

    #[test]
    fn labels_resolve() {
        assert_eq!(tactic_label("reversal"), "反包");
        assert_eq!(tactic_label("unknown_x"), "unknown_x");
    }

    #[test]
    fn first_and_multi_board_need_zt() {
        let kbars = vec![bar(10.0, 10.5, 10.6, 9.9)];
        let c = Candidate { zt: None, rank_main_net: 0.0, kbars: &kbars };
        assert!(classify("first_board", &c).is_none());
        assert!(classify("multi_board", &c).is_none());
    }

    #[test]
    fn first_board_hit() {
        let zt = ZtStock {
            code: "000001".into(), name: "X".into(), price: 11.0, pct: 10.0, amount: 1e8,
            fund: 8e7, boards: 1, first_seal: 93105, last_seal: 93105, broken: 0,
            turnover: 5.0, industry: "证券".into(), stat_days: 1, stat_count: 1, limit_price: 11.0,
        };
        let kbars = vec![bar(10.0, 11.0, 11.0, 10.0)];
        let c = Candidate { zt: Some(&zt), rank_main_net: 0.0, kbars: &kbars };
        assert!(classify("first_board", &c).is_some());
        assert!(classify("multi_board", &c).is_none());
    }

    #[test]
    fn reversal_pattern() {
        // 昨阴线，今阳线收盘破昨高。
        let kbars = vec![bar(11.0, 10.2, 11.1, 10.1), bar(10.3, 11.2, 11.3, 10.2)];
        let c = Candidate { zt: None, rank_main_net: 0.0, kbars: &kbars };
        assert!(classify("reversal", &c).is_some());
    }

    #[test]
    fn reversal_not_when_no_engulf() {
        let kbars = vec![bar(11.0, 10.2, 11.1, 10.1), bar(10.3, 10.8, 11.0, 10.2)];
        let c = Candidate { zt: None, rank_main_net: 0.0, kbars: &kbars };
        assert!(classify("reversal", &c).is_none());
    }

    #[test]
    fn weak_to_strong_needs_close_near_high() {
        // 昨阴线，今涨约 4% 但收盘在中位 → 不命中。
        let kbars = vec![bar(10.0, 9.5, 10.1, 9.4), bar(9.6, 9.9, 10.2, 9.5)];
        let c = Candidate { zt: None, rank_main_net: 0.0, kbars: &kbars };
        assert!(classify("weak_to_strong", &c).is_none());
        // 收盘靠日高 → 命中。
        let kbars2 = vec![bar(10.0, 9.5, 10.1, 9.4), bar(9.6, 10.1, 10.15, 9.55)];
        let c2 = Candidate { zt: None, rank_main_net: 0.0, kbars: &kbars2 };
        assert!(classify("weak_to_strong", &c2).is_some());
    }

    #[test]
    fn fund_resonance_threshold() {
        let kbars = vec![bar(10.0, 10.4, 10.5, 9.9), bar(10.4, 10.8, 10.9, 10.3)];
        let c = Candidate { zt: None, rank_main_net: 4e7, kbars: &kbars };
        assert!(classify("fund_resonance", &c).is_none()); // 4000万 < 5000万
        let c = Candidate { zt: None, rank_main_net: 6e7, kbars: &kbars };
        assert!(classify("fund_resonance", &c).is_some());
    }

    #[test]
    fn theme_leader_requires_hard_multi_board() {
        let make_zt = |boards: u32, broken: u32| ZtStock {
            code: "300001".into(), name: "L".into(), price: 12.0, pct: 20.0, amount: 2e8,
            fund: 1e8, boards, first_seal: 93000, last_seal: 150000, broken,
            turnover: 6.0, industry: "半导体".into(), stat_days: boards, stat_count: boards,
            limit_price: 12.0,
        };
        let kbars = vec![bar(10.0, 12.0, 12.0, 10.0)];
        let zt = make_zt(3, 1);
        let c = Candidate { zt: Some(&zt), rank_main_net: 0.0, kbars: &kbars };
        assert!(classify("theme_leader", &c).is_none()); // 有炸板
        let zt = make_zt(3, 0);
        let c = Candidate { zt: Some(&zt), rank_main_net: 0.0, kbars: &kbars };
        assert!(classify("theme_leader", &c).is_some());
    }
}
