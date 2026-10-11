// 多年历史 K 线库（v2.27，迁移 v48）：hist_kline + trade_calendar。
// 回填走东财 push2his 多节点容灾，失败回退腾讯（不复权）；批量并发 Semaphore(8)。
// 复权口径：qfq=前复权（默认，回测标准）、hfq=后复权、none=不复权。
// 合规：数据仅用于本地复盘/回测，不外传。
use super::{http, secid_prefix, KBar};
use crate::ai::maindb;
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::State;

/// period 口径：与现有 K 线一致，101=日，102=周，103=月。
pub const PERIOD_DAILY: i64 = 101;

/// 增量更新时，向前重拉的窗口（自然日）：前复权价格会在除权后整体平移，
/// 重拉近一年可覆盖最近一次除权造成的历史价变化。
const QFQ_REFRESH_DAYS: i64 = 400;

// ==================== 状态 ====================

/// 回填任务状态：支持中断、进度查询。
#[derive(Default)]
pub struct HistState {
    pub running: AtomicBool,
    pub stop: AtomicBool,
    pub total: AtomicUsize,
    pub done: AtomicUsize,
    pub ok: AtomicUsize,
    pub fail: AtomicUsize,
    pub last_code: Mutex<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistProgress {
    pub running: bool,
    pub total: usize,
    pub done: usize,
    pub ok: usize,
    pub fail: usize,
    pub last_code: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistBar {
    pub date: String,
    pub period: i64,
    pub adj: String,
    pub open: f64,
    pub close: f64,
    pub high: f64,
    pub low: f64,
    pub volume: f64,
    pub amount: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistStats {
    pub rows: i64,
    pub codes: i64,
    pub earliest: Option<String>,
    pub latest: Option<String>,
    pub calendar_days: i64,
    pub db_size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillResult {
    pub requested: usize,
    pub ok: usize,
    pub fail: usize,
    pub stopped: bool,
    pub failures: Vec<String>,
}

// ==================== 建表 SQL（与迁移 v48 保持一致，供测试） ====================

#[cfg(test)]
const CREATE_SQL: &str = "
CREATE TABLE IF NOT EXISTS hist_kline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  period INTEGER NOT NULL,
  adj TEXT NOT NULL DEFAULT 'qfq',
  date TEXT NOT NULL,
  open REAL NOT NULL,
  close REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  volume REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  UNIQUE(code, period, adj, date)
);
CREATE INDEX IF NOT EXISTS idx_hist_kline_lookup ON hist_kline(code, period, adj, date);
CREATE TABLE IF NOT EXISTS trade_calendar (
  date TEXT PRIMARY KEY,
  is_open INTEGER NOT NULL DEFAULT 1
);
";

// ==================== 抓取 ====================

/// push2his 节点池（与 push2 同理，多边缘容灾）。
const HIS_HOSTS: &[&str] = &[
    "push2his.eastmoney.com",
    "70.push2his.eastmoney.com",
    "92.push2his.eastmoney.com",
];

fn klt_of(period: i64) -> i64 {
    match period {
        102 => 102,
        103 => 103,
        _ => 101,
    }
}

/// 东财 push2his 拉取历史 K 线。beg/end 为 YYYYMMDD（beg=0 表示全部）。
/// 返回 KBar（timestamp 字段承载 YYYYMMDD 整数，便于复用）+ date 字符串由调用方从行解析。
async fn fetch_eastmoney(
    code: &str,
    period: i64,
    adj: &str,
    beg: i64,
) -> Result<Vec<HistBar>, String> {
    let secid = format!("{}.{}", secid_prefix(code), code);
    let fqt = match adj {
        "hfq" => 2,
        "none" => 0,
        _ => 1,
    };
    let klt = klt_of(period);
    let path_query = format!(
        "/api/qt/stock/kline/get?secid={secid}&fields1=f1,f2,f3,f4,f5,f6\
         &fields2=f51,f52,f53,f54,f55,f56,f57,f58\
         &klt={klt}&fqt={fqt}&beg={beg}&end=20500101"
    );

    let mut last = String::from("无可用节点");
    for host in HIS_HOSTS {
        let url = format!("https://{host}{path_query}");
        let resp = match http()
            .get(&url)
            .header("Referer", "https://quote.eastmoney.com/")
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last = format!("{host}: {e}");
                continue;
            }
        };
        let v: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                last = format!("{host}: 解析失败 {e}");
                continue;
            }
        };
        let lines = match v["data"]["klines"].as_array() {
            Some(lines) => lines,
            None => {
                last = format!("{host}: klines 为空");
                continue;
            }
        };
        let mut out = Vec::with_capacity(lines.len());
        for line in lines {
            let Some(s) = line.as_str() else { continue };
            let Some(bar) = parse_kline_row(s, period, adj) else { continue };
            out.push(bar);
        }
        if out.is_empty() {
            last = format!("{host}: 无有效行");
            continue;
        }
        return Ok(out);
    }
    Err(format!("东财历史K线所有节点失败；{last}"))
}

/// 解析东财行："date,open,close,high,low,volume,amount,amplitude"
pub fn parse_kline_row(s: &str, period: i64, adj: &str) -> Option<HistBar> {
    let f: Vec<&str> = s.split(',').collect();
    if f.len() < 7 {
        return None;
    }
    let num = |x: &str| x.parse::<f64>().unwrap_or(0.0);
    Some(HistBar {
        date: f[0].trim().to_string(),
        period,
        adj: adj.to_string(),
        open: num(f[1]),
        close: num(f[2]),
        high: num(f[3]),
        low: num(f[4]),
        volume: num(f[5]),
        amount: num(f[6]),
    })
}

/// 腾讯兜底（不复权）：复用现有日 K 抓取。
async fn fetch_tencent(code: &str, period: i64, years: i64) -> Result<Vec<HistBar>, String> {
    let count = years.max(1) * 250;
    let bars: Vec<KBar> = super::tencent::kline(code, period, count).await?;
    Ok(bars
        .into_iter()
        .map(|b| HistBar {
            date: date_compact_to_dashed(&b.timestamp.to_string()),
            period,
            adj: "none".to_string(),
            open: b.open,
            close: b.close,
            high: b.high,
            low: b.low,
            volume: b.volume,
            amount: 0.0,
        })
        .collect())
}

/// YYYYMMDD -> YYYY-MM-DD；无法解析时原样返回。
fn date_compact_to_dashed(s: &str) -> String {
    if s.len() == 8 && s.chars().all(|c| c.is_ascii_digit()) {
        format!("{}-{}-{}", &s[0..4], &s[4..6], &s[6..8])
    } else {
        s.to_string()
    }
}

// ==================== 入库 ====================

fn upsert_bars(conn: &mut Connection, code: &str, bars: &[HistBar]) -> AppResult<usize> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO hist_kline(code,period,adj,date,open,close,high,low,volume,amount) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) \
             ON CONFLICT(code,period,adj,date) DO UPDATE SET \
               open=excluded.open, close=excluded.close, high=excluded.high, low=excluded.low, \
               volume=excluded.volume, amount=excluded.amount",
        )?;
        for b in bars {
            stmt.execute(params![
                code, b.period, b.adj, b.date, b.open, b.close, b.high, b.low, b.volume, b.amount
            ])?;
        }
    }
    tx.commit()?;
    Ok(bars.len())
}

/// 计算单票回填起始日（YYYYMMDD）：
/// - 库为空：按 years 年前（粗算 365 天）。
/// - 已有数据：取最新日期前推 QFQ_REFRESH_DAYS（修正最近除权的前复权平移）。
fn backfill_beg(conn: &Connection, code: &str, period: i64, adj: &str, years: i64) -> i64 {
    let latest: Option<String> = conn
        .query_row(
            "SELECT MAX(date) FROM hist_kline WHERE code=?1 AND period=?2 AND adj=?3",
            params![code, period, adj],
            |r| r.get(0),
        )
        .unwrap_or(None);
    let Some(latest) = latest else {
        return years_ago_compact(years);
    };
    let compact = latest.replace('-', "");
    let n: i64 = compact.parse().unwrap_or(0);
    // QFQ_REFRESH_DAYS 是自然日：先转天数再相减（整数相减会被月末/年末进位扭曲）。
    let target = civil_compact(days_from_compact(n) - QFQ_REFRESH_DAYS);
    target.max(years_ago_compact(years))
}

/// YYYYMMDD → 天数（1970-01-01=0），civil_compact 的逆函数（Howard Hinnant days_from_civil）。
fn days_from_compact(c: i64) -> i64 {
    let y0 = c / 10000;
    let m = (c / 100) % 100;
    let d = c % 100;
    let y = if m <= 2 { y0 - 1 } else { y0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// years 年前的 YYYYMMDD 粗算值（借助北京时间逻辑无需 chrono）。
fn years_ago_compact(years: i64) -> i64 {
    let now = crate::ai::now_millis();
    // now 为北京时间毫秒；直接减年毫秒，再反推日历日。
    let target_ms = now - years.max(1) * 365 * 24 * 3600 * 1000;
    let secs = target_ms / 1000;
    let days = secs.div_euclid(86400); // 1970-01-01 = day 0，与 civil_compact 同口径
    civil_compact(days)
}

/// 天数（1970-01-01=0）→ YYYYMMDD（Howard Hinnant civil_from_days）。
fn civil_compact(z: i64) -> i64 {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    y * 10000 + m * 100 + d
}

/// 回填单只个股：东财主、腾讯兜底。
async fn backfill_one(
    conn: Arc<Mutex<Connection>>,
    code: String,
    period: i64,
    adj: String,
    years: i64,
) -> AppResult<usize> {
    let beg = {
        let c = conn.lock().map_err(|e| AppError::External(e.to_string()))?;
        backfill_beg(&c, &code, period, &adj, years)
    };
    let bars = match fetch_eastmoney(&code, period, &adj, beg).await {
        Ok(b) => b,
        Err(e) => {
            if adj == "none" {
                return Err(e.into());
            }
            // 腾讯兜底仅落不复权数据（adj 维度独立，不污染 qfq）。
            log::warn!("{code} 东财回填失败，回退腾讯不复权: {e}");
            fetch_tencent(&code, period, years).await?
        }
    };
    let write_adj = if bars.first().map(|b| b.adj.as_str()) == Some("none") && adj != "none" {
        "none"
    } else {
        adj.as_str()
    };
    let mut c = conn.lock().map_err(|e| AppError::External(e.to_string()))?;
    upsert_bars(&mut c, &code, &with_adj(&bars, write_adj))
}

fn with_adj(bars: &[HistBar], adj: &str) -> Vec<HistBar> {
    bars.iter()
        .map(|b| HistBar { adj: adj.to_string(), ..b.clone() })
        .collect()
}

// ==================== 命令 ====================

/// 批量回填：codes 由前端给出（自选 / 全市场榜单 / 自定义）；并发 8。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn hist_backfill(
    state: State<'_, HistState>,
    ai: State<'_, crate::ai::AiState>,
    codes: Vec<String>,
    years: Option<i64>,
    adj: Option<String>,
    period: Option<i64>,
) -> AppResult<BackfillResult> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err(AppError::business("历史回填已在运行中"));
    }
    state.stop.store(false, Ordering::SeqCst);
    let years = years.unwrap_or(5).clamp(1, 20);
    let adj = adj.unwrap_or_else(|| "qfq".to_string());
    let period = period.unwrap_or(PERIOD_DAILY);
    let total = codes.len();
    state.total.store(total, Ordering::SeqCst);
    state.done.store(0, Ordering::SeqCst);
    state.ok.store(0, Ordering::SeqCst);
    state.fail.store(0, Ordering::SeqCst);

    let conn = Arc::new(Mutex::new(
        maindb::open_readwrite(&ai.dir()).map_err(AppError::from)?,
    ));
    let sem = Arc::new(tokio::sync::Semaphore::new(8));
    let mut set = tokio::task::JoinSet::new();

    for code in codes {
        if state.stop.load(Ordering::SeqCst) {
            break;
        }
        let permit = sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| AppError::External(e.to_string()))?;
        let conn2 = conn.clone();
        let (adj2, code2) = (adj.clone(), code.clone());
        set.spawn(async move {
            let _p = permit;
            let r = backfill_one(conn2, code2.clone(), period, adj2, years).await;
            (code2, r)
        });
    }

    let mut failures = Vec::new();
    while let Some(joined) = set.join_next().await {
        let (code, r) = match joined {
            Ok(v) => v,
            Err(e) => {
                state.done.fetch_add(1, Ordering::SeqCst);
                state.fail.fetch_add(1, Ordering::SeqCst);
                failures.push(format!("join: {e}"));
                continue;
            }
        };
        state.done.fetch_add(1, Ordering::SeqCst);
        *state.last_code.lock().unwrap() = code.clone();
        match r {
            Ok(_) => {
                state.ok.fetch_add(1, Ordering::SeqCst);
            }
            Err(e) => {
                state.fail.fetch_add(1, Ordering::SeqCst);
                failures.push(format!("{code}: {e}"));
            }
        };
    }
    let stopped = state.stop.load(Ordering::SeqCst);
    let (ok, fail) = (
        state.ok.load(Ordering::SeqCst),
        state.fail.load(Ordering::SeqCst),
    );
    state.running.store(false, Ordering::SeqCst);
    Ok(BackfillResult {
        requested: total,
        ok,
        fail,
        stopped,
        failures,
    })
}

/// 请求中断回填（已发出的请求会跑完，未派发的不再派发）。
#[tauri::command]
pub fn hist_backfill_stop(state: State<'_, HistState>) -> AppResult<()> {
    state.stop.store(true, Ordering::SeqCst);
    Ok(())
}

/// 查询回填进度。
#[tauri::command]
pub fn hist_backfill_status(state: State<'_, HistState>) -> AppResult<HistProgress> {
    Ok(HistProgress {
        running: state.running.load(Ordering::SeqCst),
        total: state.total.load(Ordering::SeqCst),
        done: state.done.load(Ordering::SeqCst),
        ok: state.ok.load(Ordering::SeqCst),
        fail: state.fail.load(Ordering::SeqCst),
        last_code: state.last_code.lock().unwrap().clone(),
    })
}

/// 查询本地历史 K 线（区间，日期 YYYY-MM-DD）。
#[tauri::command]
pub fn hist_query(
    ai: State<'_, crate::ai::AiState>,
    code: String,
    period: Option<i64>,
    adj: Option<String>,
    start: Option<String>,
    end: Option<String>,
) -> AppResult<Vec<HistBar>> {
    let conn = maindb::open_readonly(&ai.dir())?;
    let period = period.unwrap_or(PERIOD_DAILY);
    let adj = adj.unwrap_or_else(|| "qfq".to_string());
    let mut sql = String::from(
        "SELECT date,open,close,high,low,volume,amount FROM hist_kline \
         WHERE code=?1 AND period=?2 AND adj=?3",
    );
    if start.is_some() {
        sql.push_str(" AND date>=?4");
    }
    if end.is_some() {
        sql.push_str(" AND date<=?5");
    }
    sql.push_str(" ORDER BY date");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![code, period, adj, start, end], |r| {
        Ok(HistBar {
            date: r.get(0)?,
            period,
            adj: adj.clone(),
            open: r.get(1)?,
            close: r.get(2)?,
            high: r.get(3)?,
            low: r.get(4)?,
            volume: r.get(5)?,
            amount: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 库统计：行数、标的数、起止日期、交易日历条数、主库文件大小。
#[tauri::command]
pub fn hist_stats(ai: State<'_, crate::ai::AiState>) -> AppResult<HistStats> {
    let dir = ai.dir();
    let conn = maindb::open_readonly(&dir)?;
    let scalar = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0) };
    let db_size_bytes = std::fs::metadata(crate::ai::maindb::main_db_path(&dir))
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(HistStats {
        rows: scalar("SELECT COUNT(*) FROM hist_kline"),
        codes: scalar("SELECT COUNT(DISTINCT code) FROM hist_kline"),
        earliest: conn
            .query_row("SELECT MIN(date) FROM hist_kline", [], |r| r.get(0))
            .unwrap_or(None),
        latest: conn
            .query_row("SELECT MAX(date) FROM hist_kline", [], |r| r.get(0))
            .unwrap_or(None),
        calendar_days: scalar("SELECT COUNT(*) FROM trade_calendar"),
        db_size_bytes,
    })
}

/// 同步交易日历：以上证综指（1.000001）历史日 K 的日期作为交易日。
#[tauri::command]
pub async fn hist_sync_calendar(
    ai: State<'_, crate::ai::AiState>,
    years: Option<i64>,
) -> AppResult<i64> {
    let years = years.unwrap_or(5).clamp(1, 20);
    let bars = match fetch_eastmoney("000001", PERIOD_DAILY, "none", years_ago_compact(years)).await
    {
        Ok(b) => b,
        Err(e) => return Err(AppError::Business(format!("交易日历同步失败: {e}"))),
    };
    let mut conn = maindb::open_readwrite(&ai.dir())?;
    let tx = conn.transaction()?;
    let n = {
        let mut stmt = tx.prepare(
            "INSERT INTO trade_calendar(date,is_open) VALUES(?1,1) \
             ON CONFLICT(date) DO NOTHING",
        )?;
        let mut n = 0i64;
        for b in &bars {
            n += stmt.execute(params![b.date])? as i64;
        }
        n
    };
    tx.commit()?;
    Ok(n)
}

/// 判断给定日期是否为交易日（YYYY-MM-DD）；日历未覆盖时返回 null 由前端提示。
#[tauri::command]
pub fn hist_is_trading_day(
    ai: State<'_, crate::ai::AiState>,
    date: String,
) -> AppResult<Option<bool>> {
    let conn = maindb::open_readonly(&ai.dir())?;
    let v: Option<i64> = conn
        .query_row(
            "SELECT is_open FROM trade_calendar WHERE date=?1",
            params![date],
            |r| r.get(0),
        )
        .ok();
    Ok(v.map(|x| x == 1))
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Connection {
        let p = std::env::temp_dir().join(format!(
            "tickgold-hist-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let c = Connection::open(&p).unwrap();
        c.execute_batch(CREATE_SQL).unwrap();
        c
    }

    #[test]
    fn parses_kline_row() {
        let b = parse_kline_row("2026-01-02,10.5,10.8,11.0,10.4,12345,1.3e8,5.1", 101, "qfq")
            .unwrap();
        assert_eq!(b.date, "2026-01-02");
        assert_eq!(b.open, 10.5);
        assert_eq!(b.close, 10.8);
        assert_eq!(b.volume, 12345.0);
        assert!(parse_kline_row("bad", 101, "qfq").is_none());
    }

    #[test]
    fn upsert_is_idempotent_and_updates() {
        let mut c = temp_db();
        let bar = parse_kline_row("2026-01-02,10.5,10.8,11.0,10.4,12345,1e8,1", 101, "qfq").unwrap();
        assert_eq!(upsert_bars(&mut c, "600519", std::slice::from_ref(&bar)).unwrap(), 1);
        assert_eq!(upsert_bars(&mut c, "600519", std::slice::from_ref(&bar)).unwrap(), 1);
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM hist_kline WHERE code='600519'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 1);

        // 修改 close 后再次 upsert，应被覆盖
        let bar2 = parse_kline_row("2026-01-02,10.5,11.2,11.0,10.4,12345,1e8,1", 101, "qfq")
            .unwrap();
        upsert_bars(&mut c, "600519", &[bar2]).unwrap();
        let close: f64 = c
            .query_row("SELECT close FROM hist_kline WHERE code='600519'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(close, 11.2);
    }

    #[test]
    fn adj_dimensions_are_isolated() {
        let mut c = temp_db();
        let q = parse_kline_row("2026-01-02,10,10,10,10,1,1,1", 101, "qfq").unwrap();
        let n = parse_kline_row("2026-01-02,12,12,12,12,1,1,1", 101, "none").unwrap();
        upsert_bars(&mut c, "600519", &[q, n]).unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM hist_kline WHERE code='600519'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn calendar_dedupes() {
        let c = temp_db();
        c.execute(
            "INSERT INTO trade_calendar(date,is_open) VALUES('2026-01-02',1)\
             ON CONFLICT(date) DO NOTHING",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO trade_calendar(date,is_open) VALUES('2026-01-02',1)\
             ON CONFLICT(date) DO NOTHING",
            [],
        )
        .unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM trade_calendar", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn civil_compact_known_dates() {
        // 1970-01-01 -> day 0 -> 19700101
        assert_eq!(civil_compact(0), 19700101);
        // 2000-01-01 为第 10957 天
        assert_eq!(civil_compact(10957), 20000101);
    }

    #[test]
    fn days_roundtrip_across_years() {
        for c in [19700101i64, 19991231, 20000229, 20160301, 20260930, 20350715] {
            assert_eq!(civil_compact(days_from_compact(c)), c, "roundtrip {c}");
        }
        assert_eq!(days_from_compact(19700101), 0);
        assert_eq!(days_from_compact(20000101), 10957);
    }

    #[test]
    fn backfill_beg_empty_uses_years() {
        let c = temp_db();
        let beg = backfill_beg(&c, "600519", 101, "qfq", 5);
        let s = beg.to_string();
        assert_eq!(s.len(), 8);
        assert!(s.starts_with("202") || s.starts_with("201"));
    }

    #[test]
    fn date_dashed_format() {
        assert_eq!(date_compact_to_dashed("20260102"), "2026-01-02");
        assert_eq!(date_compact_to_dashed("2026-01-02"), "2026-01-02");
    }

    fn mkbar(date: &str, adj: &str) -> HistBar {
        parse_kline_row(&format!("{date},10,10,10,10,1,1,1"), 101, adj).unwrap()
    }

    #[test]
    fn backfill_beg_existing_uses_refresh_window() {
        let mut c = temp_db();
        upsert_bars(&mut c, "600519", &[mkbar("2026-09-30", "qfq")]).unwrap();
        let beg = backfill_beg(&c, "600519", 101, "qfq", 5);
        // 最新 2026-09-30 前推 400 自然日 ≈ 2025-08-26
        assert!((20250820..=20250902).contains(&beg), "got {beg}");
        // 5 年地板不被击穿
        let floor = years_ago_compact(5);
        assert!(beg >= floor);
    }

    #[test]
    fn incremental_upsert_appends_new_dates() {
        let mut c = temp_db();
        upsert_bars(&mut c, "600519", &[mkbar("2026-01-02", "qfq")]).unwrap();
        upsert_bars(
            &mut c,
            "600519",
            &[mkbar("2026-01-05", "qfq"), mkbar("2026-01-06", "qfq")],
        )
        .unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM hist_kline WHERE code='600519'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 3);
    }

    #[test]
    fn with_adj_overrides_dimension() {
        let bars = [mkbar("2026-01-02", "qfq")];
        let out = with_adj(&bars, "hfq");
        assert_eq!(out[0].adj, "hfq");
        assert_eq!(bars[0].adj, "qfq"); // 原始数据不变
    }

    #[test]
    fn period_and_adj_mapping() {
        assert_eq!(klt_of(101), 101);
        assert_eq!(klt_of(102), 102);
        assert_eq!(klt_of(103), 103);
        assert_eq!(klt_of(999), 101); // 未知回落日 K
        // fqt 口径映射与东财约定一致
        let fqt = |adj: &str| match adj {
            "hfq" => 2,
            "none" => 0,
            _ => 1,
        };
        assert_eq!(fqt("qfq"), 1);
        assert_eq!(fqt("hfq"), 2);
        assert_eq!(fqt("none"), 0);
    }
}
