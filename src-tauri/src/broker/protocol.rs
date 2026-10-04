// 券商委托协议：broker_order 表读写、状态机常量、返回前端 DTO；sidecar JSON-RPC 消息见 sidecar.rs。
use crate::ai::now_millis;
use rusqlite::Connection;
use serde::Serialize;

// ===== 状态常量 =====
pub const SUBMITTING: &str = "submitting";
pub const SUBMITTED: &str = "submitted";
pub const PART_FILLED: &str = "part_filled";
pub const FILLED: &str = "filled";
pub const CANCELLED: &str = "cancelled";
pub const ERROR: &str = "error";
pub const REJECTED: &str = "rejected";

/// 状态机合法迁移：只允许向前推进或进入撤单/错误终态。
pub fn can_transition(from: &str, to: &str) -> bool {
    if from == to {
        return true;
    }
    match (from, to) {
        (SUBMITTING, SUBMITTED) => true,
        (SUBMITTING, ERROR) | (SUBMITTING, REJECTED) | (SUBMITTING, CANCELLED) => true,
        (SUBMITTED, PART_FILLED) | (SUBMITTED, FILLED) => true,
        (SUBMITTED, CANCELLED) | (SUBMITTED, ERROR) => true,
        (PART_FILLED, FILLED) => true,
        (PART_FILLED, CANCELLED) | (PART_FILLED, ERROR) => true,
        _ => false,
    }
}

/// 返回前端的委托信息。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BrokerOrderInfo {
    pub id: i64,
    pub sig_id: String,
    pub broker_kind: String,
    pub broker_account: String,
    pub broker_order_id: String,
    pub code: String,
    pub side: String,
    pub price: f64,
    pub vol: i64,
    pub status: String,
    pub filled_vol: i64,
    pub filled_avg_price: f64,
    pub error_msg: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row_to_info(r: &rusqlite::Row) -> rusqlite::Result<BrokerOrderInfo> {
    Ok(BrokerOrderInfo {
        id: r.get("id")?,
        sig_id: r.get("sig_id")?,
        broker_kind: r.get("broker_kind")?,
        broker_account: r.get("broker_account")?,
        broker_order_id: r.get("broker_order_id")?,
        code: r.get("code")?,
        side: r.get("side")?,
        price: r.get("price")?,
        vol: r.get("vol")?,
        status: r.get("status")?,
        filled_vol: r.get("filled_vol")?,
        filled_avg_price: r.get("filled_avg_price")?,
        error_msg: r.get("error_msg")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

/// 新建委托（submitting）。sig_id 唯一，重复提交返回错误。
#[allow(clippy::too_many_arguments)]
pub fn insert(
    conn: &Connection,
    sig_id: &str,
    kind: &str,
    account: &str,
    code: &str,
    side: &str,
    price: f64,
    vol: i64,
) -> Result<i64, String> {
    let now = now_millis();
    conn.execute(
        "INSERT INTO broker_order
           (sig_id,broker_kind,broker_account,code,side,price,vol,status,
            filled_vol,filled_avg_price,error_msg,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,0,'',?9,?9)",
        rusqlite::params![sig_id, kind, account, code, side, price, vol, SUBMITTING, now],
    )
    .map_err(|e| format!("写入券商委托失败: {e}"))?;
    Ok(conn.last_insert_rowid())
}

/// 更新委托进度（含状态机校验）。
pub fn update(
    conn: &Connection,
    sig_id: &str,
    to_status: &str,
    filled_vol: Option<i64>,
    filled_avg_price: Option<f64>,
    broker_order_id: Option<&str>,
    error_msg: Option<&str>,
) -> Result<(), String> {
    let cur: String = conn
        .query_row(
            "SELECT status FROM broker_order WHERE sig_id=?1",
            rusqlite::params![sig_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("读取委托状态失败: {e}"))?;
    if !can_transition(&cur, to_status) {
        return Err(format!("非法委托状态迁移：{cur} → {to_status}"));
    }
    let now = now_millis();
    // 固定 SQL：未提供的字段用 COALESCE 保留原值（Option::None → NULL）。
    conn.execute(
        "UPDATE broker_order SET
            status=?1,
            updated_at=?2,
            filled_vol=COALESCE(?3, filled_vol),
            filled_avg_price=COALESCE(?4, filled_avg_price),
            broker_order_id=COALESCE(?5, broker_order_id),
            error_msg=COALESCE(?6, error_msg)
         WHERE sig_id=?7",
        rusqlite::params![
            to_status,
            now,
            filled_vol,
            filled_avg_price,
            broker_order_id,
            error_msg,
            sig_id
        ],
    )
    .map_err(|e| format!("更新委托失败: {e}"))?;
    Ok(())
}

pub fn get_by_sig(conn: &Connection, sig_id: &str) -> Option<BrokerOrderInfo> {
    let mut stmt = conn
        .prepare("SELECT * FROM broker_order WHERE sig_id=?1")
        .ok()?;
    stmt.query_row(rusqlite::params![sig_id], row_to_info).ok()
}

pub fn list(conn: &Connection, status: Option<String>, limit: i64) -> Vec<BrokerOrderInfo> {
    let sql = if status.is_some() {
        "SELECT * FROM broker_order WHERE status=?1 ORDER BY id DESC LIMIT ?2"
    } else {
        "SELECT * FROM broker_order ORDER BY id DESC LIMIT ?1"
    };
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = if let Some(st) = status {
        stmt.query_map(rusqlite::params![st, limit], row_to_info)
    } else {
        stmt.query_map(rusqlite::params![limit], row_to_info)
    };
    rows.map(|r| r.flatten().collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memdb() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE broker_order (
                id INTEGER PRIMARY KEY AUTOINCREMENT, sig_id TEXT UNIQUE, broker_kind TEXT,
                broker_account TEXT, broker_order_id TEXT, code TEXT, side TEXT, price REAL,
                vol INTEGER, status TEXT, filled_vol INTEGER, filled_avg_price REAL,
                error_msg TEXT, created_at INTEGER, updated_at INTEGER);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn full_lifecycle_transitions() {
        let c = memdb();
        insert(&c, "SG1", "mock", "", "600519", "BUY", 100.0, 200).unwrap();
        assert!(update(&c, "SG1", SUBMITTED, None, None, Some("BID1"), None).is_ok());
        assert!(update(&c, "SG1", PART_FILLED, Some(100), Some(100.0), None, None).is_ok());
        assert!(update(&c, "SG1", FILLED, Some(200), Some(100.0), None, None).is_ok());
        let info = get_by_sig(&c, "SG1").unwrap();
        assert_eq!(info.status, FILLED);
        assert_eq!(info.filled_vol, 200);
        // filled 后不能再迁移
        assert!(update(&c, "SG1", CANCELLED, None, None, None, None).is_err());
    }

    #[test]
    fn duplicate_sig_rejected() {
        let c = memdb();
        insert(&c, "SG1", "mock", "", "X", "BUY", 1.0, 100).unwrap();
        assert!(insert(&c, "SG1", "mock", "", "X", "BUY", 1.0, 100).is_err());
    }

    #[test]
    fn illegal_transition_rejected() {
        assert!(!can_transition(FILLED, SUBMITTED));
        assert!(!can_transition(CANCELLED, FILLED));
        assert!(can_transition(SUBMITTED, CANCELLED));
    }
}
