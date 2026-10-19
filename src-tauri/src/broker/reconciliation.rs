// P1-1 / P1-2 通道多源对账：
// 券商 UI 实读持仓（唯一权威源）vs 本地「上次确认快照 + 系统成交流水增量」。
// 一致：账实相符，自动更新快照基线；不一致：数据冲突（以券商为准），由调用方暂停自动化。
// 说明：本对账针对「界面自动化」通道（读数不稳）；模拟盘由系统自行撮合，账实天然一致，不适用。
use crate::ai::maindb;
use crate::broker::risk::QmtPosition;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;

pub const SNAP_KEY: &str = "recon_position_snapshot";

#[derive(Clone, Debug)]
pub struct Diff {
    pub code: String,
    pub local_vol: i64,
    pub broker_vol: i64,
}

#[derive(Clone, Debug)]
pub struct Report {
    pub kind: String, // intraday（即时）/ open（日初）/ close（日终）
    pub matched: bool,
    pub baseline: bool, // 首次建立基线
    pub diffs: Vec<Diff>,
    pub checked: usize,
    pub at: i64,
}

impl Report {
    pub fn to_json(&self) -> Value {
        json!({
            "kind": self.kind,
            "matched": self.matched,
            "baseline": self.baseline,
            "checked": self.checked,
            "at": self.at,
            "diffs": self.diffs.iter().map(|d| json!({
                "code": d.code, "localVol": d.local_vol, "brokerVol": d.broker_vol
            })).collect::<Vec<_>>(),
        })
    }
}

fn get_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key=?1", params![key], |r| r.get(0))
        .ok()
}
fn set_meta(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute(
        "INSERT OR REPLACE INTO meta(key,value) VALUES(?1,?2)",
        params![key, value],
    );
}

/// 自 saved_at 以来系统成交（filled / part_filled），按 code 聚合净持仓变动（BUY 加、SELL 减）。
fn trade_delta(conn: &Connection, since: i64) -> HashMap<String, i64> {
    let mut m: HashMap<String, i64> = HashMap::new();
    let sql = "SELECT code,side,COALESCE(filled_vol,0) FROM broker_order
               WHERE created_at>=?1 AND status IN ('filled','part_filled')";
    if let Ok(mut st) = conn.prepare(sql) {
        if let Ok(rows) = st.query_map(params![since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        }) {
            for (code, side, fv) in rows.flatten() {
                let d = if side.eq_ignore_ascii_case("BUY") { fv } else { -fv };
                *m.entry(code).or_insert(0) += d;
            }
        }
    }
    m
}

/// 执行对账。
/// - `broker`：券商 UI 实读持仓（裸码 → 持仓）；
/// - `kind`：intraday / open / close；`now`：当前毫秒。
pub fn reconcile(
    dir: &Path,
    broker: &HashMap<String, QmtPosition>,
    kind: &str,
    now: i64,
) -> Result<Report, String> {
    let conn = maindb::open_readwrite(dir)?;
    let snap: Option<Value> = get_meta(&conn, SNAP_KEY)
        .and_then(|s| serde_json::from_str(&s).ok());

    // 券商实读：code → vol
    let broker_vol: HashMap<String, i64> =
        broker.iter().map(|(code, p)| (code.clone(), p.vol)).collect();

    // 首次：无快照 → 以券商读数建立基线，不产生冲突。
    if snap.is_none() {
        let baseline = json!({ "saved_at": now, "positions": broker_vol });
        set_meta(&conn, SNAP_KEY, &baseline.to_string());
        return Ok(Report {
            kind: kind.to_string(),
            matched: true,
            baseline: true,
            diffs: vec![],
            checked: broker_vol.len(),
            at: now,
        });
    }
    let snap = snap.unwrap();
    let saved_at = snap["saved_at"].as_i64().unwrap_or(0);

    // 本地预期 = 快照持仓 + 系统成交增量
    let mut expected: HashMap<String, i64> = HashMap::new();
    if let Some(obj) = snap["positions"].as_object() {
        for (code, v) in obj {
            if let Some(vol) = v.as_i64() {
                expected.insert(code.clone(), vol);
            }
        }
    }
    for (code, d) in trade_delta(&conn, saved_at) {
        *expected.entry(code).or_insert(0) += d;
    }

    // 逐代码比对（并集）
    let mut codes: Vec<String> = expected.keys().cloned().collect();
    for c in broker_vol.keys() {
        if !codes.contains(c) {
            codes.push(c.clone());
        }
    }
    codes.sort();
    let mut diffs: Vec<Diff> = Vec::new();
    for code in codes {
        let lv = *expected.get(&code).unwrap_or(&0);
        let bv = *broker_vol.get(&code).unwrap_or(&0);
        if lv != bv {
            diffs.push(Diff {
                code,
                local_vol: lv,
                broker_vol: bv,
            });
        }
    }
    let matched = diffs.is_empty();
    if matched {
        // 一致：以券商读数更新快照基线。
        let updated = json!({ "saved_at": now, "positions": broker_vol });
        set_meta(&conn, SNAP_KEY, &updated.to_string());
    }
    Ok(Report {
        kind: kind.to_string(),
        matched,
        baseline: false,
        diffs,
        checked: broker_vol.len().max(expected.len()),
        at: now,
    })
}

/// 以券商为准重新校准基线（用户确认冲突 / 核对无误后调用）。
pub fn recalibrate(
    dir: &Path,
    broker: &HashMap<String, QmtPosition>,
    now: i64,
) -> Result<(), String> {
    let conn = maindb::open_readwrite(dir)?;
    let vol: HashMap<String, i64> = broker.iter().map(|(c, p)| (c.clone(), p.vol)).collect();
    let baseline = json!({ "saved_at": now, "positions": vol });
    set_meta(&conn, SNAP_KEY, &baseline.to_string());
    Ok(())
}
