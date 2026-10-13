// 连板天梯深化（v2.31）：在 limit_up_record 历史快照上给出可接力性量化口径。
// 四个指标：
//   1. 晋级率 promotion_rate：N 板次日成功封住 N+1 板的比例；
//   2. 隔日溢价 next_premium：N 板次日开盘 / 收盘相对当日收盘的溢价（%）；
//   3. 封单强度 seal_strength：封单资金 / 当日成交额（%）及平均封单资金（亿）；
//   4. 炸板回封率 reseal_rate：当日炸过板但最终回封成功（留在涨停快照）的比例。
// 溢价需要日 K，走多源容灾 get_kline（每只一次覆盖窗口，JoinSet 并发 8）；其余本地只读聚合。
use super::{get_kline, KBar};
use crate::ai::maindb;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

/// 单个连板高度（N 板）的天梯统计。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LadderStat {
    pub boards: i64,
    /// 样本交易日-个股对数。
    pub samples: i64,
    /// 晋级率 %：次日 boards = 当日 boards + 1。
    pub promotion_rate_pct: f64,
    /// 隔日开盘溢价 %（次日开盘 / 当日收盘 − 1）。
    pub next_open_premium_pct: f64,
    /// 隔日收盘溢价 %（次日收盘 / 当日收盘 − 1）。
    pub next_close_premium_pct: f64,
    /// 封单强度 %：封单资金 / 当日成交额。
    pub seal_strength_pct: f64,
    /// 平均封单资金（亿）。
    pub avg_seal_fund_yi: f64,
    /// 炸板回封率 %：尝试封该板高的股票中（炸板池 + 回封成功）最终封住的比例。
    pub reseal_rate_pct: f64,
    /// 该板高的炸板尝试总数（回封成功 + 炸板未回封）；为 0 时前端不展示回封率。
    pub broken_total: i64,
    /// 炸板后回封成功数。
    pub resealed: i64,
}

/// 一条 limit_up_record 快照。
struct Snap {
    date: String,
    code: String,
    boards: i64,
    seal_fund: f64,
    amount: f64,
    broken: i64,
}

/// 一条 broken_limit_record（炸板未回封）。
struct BrokenSnap {
    date: String,
    code: String,
}

/// 取出最近 `max_days` 个有数据交易日的全部涨停快照（按日期升序）。
fn fetch_snaps(conn: &Connection, max_days: i64) -> Result<Vec<Snap>, String> {
    let sql = "SELECT l.trade_date,l.code,l.boards,l.seal_fund,l.amount,l.broken \
         FROM limit_up_record l \
         JOIN (SELECT DISTINCT trade_date FROM limit_up_record \
                ORDER BY trade_date DESC LIMIT ?1) d ON d.trade_date=l.trade_date \
         ORDER BY l.trade_date ASC";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([max_days], |r| {
            Ok(Snap {
                date: r.get(0).unwrap_or_default(),
                code: r.get(1).unwrap_or_default(),
                boards: r.get(2).unwrap_or(1),
                seal_fund: r.get(3).unwrap_or(0.0),
                amount: r.get(4).unwrap_or(0.0),
                broken: r.get(5).unwrap_or(0),
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

/// 取出窗口内全部炸板未回封记录。
fn fetch_broken(conn: &Connection, dates: &[String]) -> Result<Vec<BrokenSnap>, String> {
    if dates.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = dates.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT trade_date,code FROM broken_limit_record WHERE trade_date IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params: Vec<&dyn rusqlite::types::ToSql> =
        dates.iter().map(|d| d as &dyn rusqlite::types::ToSql).collect();
    let rows = stmt
        .query_map(params.as_slice(), |r| {
            Ok(BrokenSnap { date: r.get(0)?, code: r.get(1)? })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

#[derive(Default)]
struct Acc {
    samples: i64,
    promoted: i64,
    failed: i64,
    resealed: i64,
    seal_strength_sum: f64,
    seal_fund_sum: f64,
    open_prem_sum: f64,
    close_prem_sum: f64,
    prem_samples: i64,
}

/// 毫秒时间戳 → YYYY-MM-DD（UTC+8 日历日）。
fn ymd_from_ts(ts_ms: i64) -> String {
    let days = (ts_ms + 8 * 3_600_000).div_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 日序数 → civil 日期（Howard Hinnant 算法）。
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let a = z + 719_468;
    let era = if a >= 0 { a } else { a - 146_096 } / 146_097;
    let doe = a - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// 计算天梯统计。
pub async fn stats(data_dir: &std::path::Path, max_days: i64) -> Result<Vec<LadderStat>, String> {
    let window = max_days.clamp(2, 120);
    let conn = maindb::open_readonly(data_dir)?;
    let snaps = fetch_snaps(&conn, window)?;
    drop(conn);
    if snaps.is_empty() {
        return Ok(Vec::new());
    }

    // 交易日链：当日 → 次一有快照交易日。
    let mut dates: Vec<String> = snaps.iter().map(|s| s.date.clone()).collect();
    dates.sort();
    dates.dedup();
    let next_day_of: HashMap<String, Option<String>> = dates
        .iter()
        .enumerate()
        .map(|(i, d)| (d.clone(), dates.get(i + 1).cloned()))
        .collect();
    let prev_day_of: HashMap<String, Option<String>> = dates
        .iter()
        .enumerate()
        .map(|(i, d)| (d.clone(), if i == 0 { None } else { dates.get(i - 1).cloned() }))
        .collect();
    // (code, date) → boards。
    let boards_on: HashMap<(String, String), i64> = snaps
        .iter()
        .map(|s| ((s.code.clone(), s.date.clone()), s.boards))
        .collect();

    // 炸板未回封记录：按"试图冲击的板高"归桶——前一交易日 boards+1，无前序则视为首板尝试。
    let conn = maindb::open_readonly(data_dir)?;
    let broken_snaps = fetch_broken(&conn, &dates).unwrap_or_default();
    drop(conn);

    // 每只股票拉一次日 K（窗口 +2 根），建 (code, date) → KBar。
    let mut codes: Vec<String> = snaps.iter().map(|s| s.code.clone()).collect();
    codes.sort();
    codes.dedup();
    let mut kbar_on: HashMap<(String, String), KBar> = HashMap::new();
    let mut set = tokio::task::JoinSet::new();
    for code in &codes {
        let c = code.clone();
        let n = window + 2;
        set.spawn(async move {
            let r = get_kline(c.clone(), 101, n).await;
            (c, r)
        });
        while set.len() >= 8 {
            if let Some(Ok((code, Ok(bars)))) = set.join_next().await {
                for b in bars {
                    kbar_on.insert((code.clone(), ymd_from_ts(b.timestamp)), b);
                }
            }
        }
    }
    while let Some(Ok((code, Ok(bars)))) = set.join_next().await {
        for b in bars {
            kbar_on.insert((code.clone(), ymd_from_ts(b.timestamp)), b);
        }
    }

    let mut accs: HashMap<i64, Acc> = HashMap::new();
    for s in &snaps {
        let a = accs.entry(s.boards).or_default();
        a.samples += 1;
        // 快照只保留收盘仍涨停者：broken>0 即盘中炸板后回封成功。
        if s.broken > 0 {
            a.resealed += 1;
        }
        if s.seal_fund > 0.0 {
            a.seal_fund_sum += s.seal_fund;
            if s.amount > 0.0 {
                a.seal_strength_sum += s.seal_fund / s.amount * 100.0;
            }
        }
        let Some(Some(nd)) = next_day_of.get(&s.date) else { continue };
        // 晋级：次日同 code boards = 当日 boards + 1。
        if boards_on.get(&(s.code.clone(), nd.clone())).copied() == Some(s.boards + 1) {
            a.promoted += 1;
        }
        // 隔日溢价：次日 K 开/收 vs 当日 K 收盘。
        if let (Some(today_kb), Some(next_kb)) = (
            kbar_on.get(&(s.code.clone(), s.date.clone())),
            kbar_on.get(&(s.code.clone(), nd.clone())),
        ) {
            if today_kb.close > 0.0 {
                a.open_prem_sum += (next_kb.open / today_kb.close - 1.0) * 100.0;
                a.close_prem_sum += (next_kb.close / today_kb.close - 1.0) * 100.0;
                a.prem_samples += 1;
            }
        }
    }

    // 炸板未回封：按试图冲击的板高（前一日 boards+1，无前序=首板）计入失败分母。
    for b in &broken_snaps {
        let attempted = match prev_day_of.get(&b.date).and_then(|p| p.as_ref()) {
            Some(pd) => boards_on.get(&(b.code.clone(), pd.clone())).copied().unwrap_or(0) + 1,
            None => 1,
        }.max(1);
        accs.entry(attempted).or_default().failed += 1;
    }

    let mut out: Vec<LadderStat> = accs
        .into_iter()
        .map(|(boards, a)| {
            // 回封成功率分母 = 盘中炸板后回封成功 + 炸板未回封（同板高尝试）。
            let broken_total = a.resealed + a.failed;
            LadderStat {
                boards,
                samples: a.samples,
                promotion_rate_pct: if a.samples > 0 {
                    a.promoted as f64 / a.samples as f64 * 100.0
                } else {
                    0.0
                },
                next_open_premium_pct: if a.prem_samples > 0 {
                    a.open_prem_sum / a.prem_samples as f64
                } else {
                    0.0
                },
                next_close_premium_pct: if a.prem_samples > 0 {
                    a.close_prem_sum / a.prem_samples as f64
                } else {
                    0.0
                },
                seal_strength_pct: if a.samples > 0 {
                    a.seal_strength_sum / a.samples as f64
                } else {
                    0.0
                },
                avg_seal_fund_yi: if a.samples > 0 {
                    a.seal_fund_sum / a.samples as f64 / 1e8
                } else {
                    0.0
                },
                reseal_rate_pct: if broken_total > 0 {
                    a.resealed as f64 / broken_total as f64 * 100.0
                } else {
                    0.0
                },
                broken_total,
                resealed: a.resealed,
            }
        })
        .collect();
    out.sort_by_key(|v| std::cmp::Reverse(v.boards));
    Ok(out)
}

#[tauri::command]
pub async fn ladder_stats(
    state: State<'_, crate::ai::AiState>,
    days: Option<i64>,
) -> Result<Vec<LadderStat>, String> {
    stats(&state.dir(), days.unwrap_or(30)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn days_from_civil_ymd(y: i64, m: i64, d: i64) -> i64 {
        let y = if m <= 2 { y - 1 } else { y };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let mp = if m > 2 { m - 3 } else { m + 9 };
        let doy = (153 * mp + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }

    #[test]
    fn civil_days_roundtrip() {
        assert_eq!(civil_from_days(days_from_civil_ymd(2026, 10, 13)), (2026, 10, 13));
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }

    #[test]
    fn ts_to_ymd_utc8() {
        // 2026-10-13 00:30 北京 = 前一日 16:30 UTC → 日历仍应落在 10-13。
        let ts = (days_from_civil_ymd(2026, 10, 12) as f64 + 0.5) * 86_400_000.0 + 8. * 3_600_000.0;
        assert_eq!(ymd_from_ts(ts as i64), "2026-10-13");
    }
}
