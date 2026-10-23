//! 历史分时落库累积（P3-3，迁移 v65）。
//!
//! 免费源（腾讯 day/query）仅提供最近 5 个交易日分时；分钟级回测需要更长样本。
//! 本模块每日收盘后将当日分钟数据归档进本地 SQLite（hist_minute_kline），
//! 应用每次启动也会补拉最近 N 个交易日的缺失数据，日积月累即为回测样本库。
//! 只追加、只读，不触碰任何交易/持仓状态。

use crate::ai::{maindb, now_millis};
use crate::market::{tencent, HistDayMinute};
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;

/// 归档结果（供前端展示："已补 N 日 / 跳过 M 日 / 失败 K 日"）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveResult {
    /// 本次新落库的交易日（YYYYMMDD，升序）
    pub archived: Vec<String>,
    /// 本地已存在、跳过拉取的交易日
    pub skipped: Vec<String>,
    /// 拉取失败的交易日
    pub failed: Vec<String>,
}

// ==================== 写库 ====================

/// 单日分钟 bars 落库（INSERT OR REPLACE，幂等；同一天重复归档安全）。
pub fn upsert_day(
    conn: &Connection,
    code: &str,
    date: &str,
    bars: &[crate::market::KBar],
) -> Result<(), String> {
    if bars.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for b in bars {
        tx.execute(
            "INSERT OR REPLACE INTO hist_minute_kline
               (code, trade_date, minute_ts, open, high, low, close, volume)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![
                code,
                date,
                b.timestamp,
                b.open,
                b.high,
                b.low,
                b.close,
                b.volume
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ==================== 读库 ====================

/// 标的已归档的交易日（升序，YYYYMMDD）。
pub fn archived_dates(dir: &Path, code: &str) -> Result<Vec<String>, String> {
    let conn = maindb::open_readonly(dir)?;
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT trade_date FROM hist_minute_kline
             WHERE code=?1 AND trade_date LIKE '________'
             ORDER BY trade_date ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([code], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 最近 N 个交易日的历史分时（每日期内按分钟时间升序），从本地累积库读取。
pub fn list(dir: &Path, code: &str, days: i64) -> Result<Vec<HistDayMinute>, String> {
    let n = days.clamp(1, 120) as usize;
    let conn = maindb::open_readonly(dir)?;
    // 先取最近 N 个交易日
    let mut dstmt = conn
        .prepare(
            "SELECT DISTINCT trade_date FROM hist_minute_kline
             WHERE code=?1 ORDER BY trade_date DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let dates: Vec<String> = dstmt
        .query_map(rusqlite::params![code, n], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut out = Vec::with_capacity(dates.len());
    for d in dates.iter().rev() {
        let mut stmt = conn
            .prepare(
                "SELECT minute_ts, open, high, low, close, volume
                 FROM hist_minute_kline
                 WHERE code=?1 AND trade_date=?2
                 ORDER BY minute_ts ASC",
            )
            .map_err(|e| e.to_string())?;
        let bars = stmt
            .query_map(rusqlite::params![code, d], |row| {
                Ok(crate::market::KBar {
                    timestamp: row.get(0)?,
                    open: row.get(1)?,
                    high: row.get(2)?,
                    low: row.get(3)?,
                    close: row.get(4)?,
                    volume: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        if !bars.is_empty() {
            out.push(HistDayMinute {
                date: d.clone(),
                bars,
            });
        }
    }
    Ok(out)
}

// ==================== 归档（补数） ====================

/// 对标的执行归档：检查本地已累积日期，缺失日期从腾讯（近 5 个交易日）拉取落库。
/// 幂等：已落库的交易日跳过；重复调用安全。
pub async fn archive(dir: &Path, code: &str, days: i64) -> Result<ArchiveResult, String> {
    let want = days.clamp(1, 5) as usize; // 腾讯免费源仅近 5 日
    let conn = maindb::open_readwrite(dir)?;

    // 已归档日期集合（排除空壳日——bar 数少于 10 视为未归档成功）
    let mut have: std::collections::HashSet<String> = archived_dates(dir, code)?
        .into_iter()
        .collect();

    let mut res = ArchiveResult {
        archived: Vec::new(),
        skipped: Vec::new(),
        failed: Vec::new(),
    };

    // 逐日拉取（腾讯返回最新在前）
    match tencent::hist_minute_days(code, want).await {
        Ok(days_data) => {
            for day in days_data {
                let date = day.date;
                if have.contains(&date) {
                    res.skipped.push(date);
                    continue;
                }
                if day.bars.len() < 10 {
                    // 数据不完整（如停牌日/新股），跳过避免落空壳
                    res.failed.push(date);
                    continue;
                }
                match upsert_day(&conn, code, &date, &day.bars) {
                    Ok(()) => {
                        have.insert(date.clone());
                        res.archived.push(date);
                    }
                    Err(e) => {
                        res.failed.push(date);
                        let _ = e; // 单日失败不阻塞其余日期
                    }
                }
            }
        }
        Err(e) => return Err(e), // 网络/接口整体失败，交给调用方
    }

    let _ = now_millis();
    Ok(res)
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::KBar;

    fn bar(ts: i64, c: f64) -> KBar {
        KBar { timestamp: ts, open: c, close: c, high: c, low: c, volume: 100.0 }
    }

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("tickgold-minhist-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn create_table(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS hist_minute_kline (
                code TEXT NOT NULL, trade_date TEXT NOT NULL, minute_ts INTEGER NOT NULL,
                open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
                volume REAL NOT NULL DEFAULT 0,
                PRIMARY KEY (code, trade_date, minute_ts)
            );",
        )
        .expect("create");
    }

    fn make_db(dir: &std::path::Path) -> Connection {
        let conn = Connection::open(crate::ai::maindb::main_db_path(dir)).expect("open db");
        conn.busy_timeout(std::time::Duration::from_secs(1)).unwrap();
        create_table(&conn);
        conn
    }

    #[test]
    fn upsert_then_list_roundtrip() {
        let dir = tmp_dir("roundtrip");
        let conn = make_db(&dir);

        let bars = vec![bar(1000, 10.0), bar(1001, 10.1)];
        upsert_day(&conn, "600000", "20261020", &bars).unwrap();
        // 幂等：再写一次不报错且不重复
        upsert_day(&conn, "600000", "20261020", &bars).unwrap();
        upsert_day(&conn, "600000", "20261021", &vec![bar(2000, 9.9)]).unwrap();

        let out = list(&dir, "600000", 5).unwrap();
        assert_eq!(out.len(), 2, "两日都应读到");
        assert_eq!(out[0].date, "20261020", "升序返回");
        assert_eq!(out[0].bars.len(), 2);
        assert_eq!(out[1].date, "20261021");
        assert_eq!(out[1].bars[0].close, 9.9);
    }

    #[test]
    fn archived_dates_returns_unique_sorted() {
        let dir = tmp_dir("dates");
        let conn = make_db(&dir);

        upsert_day(&conn, "600000", "20261022", &vec![bar(1, 1.0)]).unwrap();
        upsert_day(&conn, "600000", "20261020", &vec![bar(2, 2.0)]).unwrap();
        upsert_day(&conn, "600000", "20261021", &vec![bar(3, 3.0)]).unwrap();

        let dates = archived_dates(&dir, "600000").unwrap();
        assert_eq!(dates, vec!["20261020", "20261021", "20261022"], "升序且无重复");
        assert!(archived_dates(&dir, "000001").unwrap().is_empty());
    }

    #[test]
    fn list_limits_days() {
        let dir = tmp_dir("limit");
        let conn = make_db(&dir);

        for (i, d) in ["20261016", "20261019", "20261020"].iter().enumerate() {
            upsert_day(&conn, "600000", d, &vec![bar(i as i64, 1.0)]).unwrap();
        }
        let out = list(&dir, "600000", 2).unwrap();
        assert_eq!(out.len(), 2, "只取最近 2 日");
        assert_eq!(out[0].date, "20261019");
        assert_eq!(out[1].date, "20261020");
    }
}
