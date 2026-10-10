// 本地条件单：持久化在主库 conditional_order 表（迁移 v47）。
// 触发条件 trigger 对齐 market/alert 字段与算子；命中后的落单/执行由 C2 接入
// （bridge 落 signal_ticket → broker_submit）。本文件只负责定义与 CRUD。
// 合规：实盘仅落待确认，不自动下单；默认 auto_confirm=false。
use crate::ai::{maindb, now_millis};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use tauri::State;

// ===== 状态常量 =====
pub const ACTIVE: &str = "active";
pub const TRIGGERED: &str = "triggered";
pub const EXPIRED: &str = "expired";
pub const CANCELLED: &str = "cancelled";
pub const DONE: &str = "done";
pub const ERROR: &str = "error";

/// 同毫秒建单去重自增序列。
static SEQ: AtomicU64 = AtomicU64::new(1);

/// 触发条件叶子（与 market/alert、前端 Leaf 同构；数组内为 AND）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CoTrigger {
    pub field: String,
    pub op: String,
    pub value: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// 条件单 DTO。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConditionalOrder {
    pub id: i64,
    pub co_id: String,
    pub trade_date: String,
    pub code: String,
    pub name: String,
    pub side: String,
    pub trigger: Vec<CoTrigger>,
    pub price_mode: String,
    pub limit_price: f64,
    pub vol: i64,
    pub ttl: String,
    pub expire_at: i64,
    pub auto_confirm: bool,
    pub status: String,
    pub ticket_id: String,
    pub note: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub triggered_at: i64,
}

/// 建表 SQL（与 lib.rs 迁移 v47 保持一致，供测试）。
pub const CREATE_SQL: &str = "CREATE TABLE IF NOT EXISTS conditional_order (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  co_id TEXT NOT NULL UNIQUE,
  trade_date TEXT DEFAULT '',
  code TEXT NOT NULL,
  name TEXT DEFAULT '',
  side TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  price_mode TEXT DEFAULT 'trigger',
  limit_price REAL DEFAULT 0,
  vol INTEGER NOT NULL,
  ttl TEXT DEFAULT 'day',
  expire_at INTEGER DEFAULT 0,
  auto_confirm INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  ticket_id TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER DEFAULT 0,
  triggered_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_co_status ON conditional_order(status);
CREATE INDEX IF NOT EXISTS idx_co_code ON conditional_order(code);";

// ===== 北京日期（UTC+8，不依赖 chrono；算法同 autoexec）=====
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 12 { y } else { y + 1 };
    (y as i32, m as u32, d as u32)
}
fn beijing_today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        + 8 * 3600;
    let (y, m, d) = civil_from_days((secs / 86400) as i64);
    format!("{y}-{:02}-{:02}", m, d)
}

/// 对外暴露北京当日日期（dashed），供预警循环做过期判定，避免重复实现历法。
pub fn today_dashed() -> String {
    beijing_today()
}

fn row_to_order(r: &rusqlite::Row) -> rusqlite::Result<ConditionalOrder> {
    let trigger_json: String = r.get("trigger_json")?;
    let trigger: Vec<CoTrigger> =
        serde_json::from_str(&trigger_json).unwrap_or_default();
    Ok(ConditionalOrder {
        id: r.get("id")?,
        co_id: r.get("co_id")?,
        trade_date: r.get("trade_date")?,
        code: r.get("code")?,
        name: r.get("name")?,
        side: r.get("side")?,
        trigger,
        price_mode: r.get("price_mode")?,
        limit_price: r.get("limit_price")?,
        vol: r.get("vol")?,
        ttl: r.get("ttl")?,
        expire_at: r.get("expire_at")?,
        auto_confirm: r.get::<_, i64>("auto_confirm")? != 0,
        status: r.get("status")?,
        ticket_id: r.get("ticket_id")?,
        note: r.get("note")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        triggered_at: r.get("triggered_at")?,
    })
}

fn gen_co_id(now: i64) -> String {
    let n = SEQ.fetch_add(1, AtomicOrdering::SeqCst);
    format!("CO_{now}_{n}")
}

/// 建单入参（命令层组装）。
pub struct CreateInput {
    pub code: String,
    pub name: String,
    pub side: String,
    pub trigger: Vec<CoTrigger>,
    pub price_mode: String,
    pub limit_price: f64,
    pub vol: i64,
    pub ttl: String,
    pub expire_at: i64,
    pub auto_confirm: bool,
    pub note: String,
}

/// 校验并写入，返回 co_id。
pub fn insert(conn: &Connection, input: CreateInput) -> Result<String, String> {
    let side = input.side.to_uppercase();
    if side != "BUY" && side != "SELL" {
        return Err("条件单方向必须为 BUY 或 SELL".to_string());
    }
    if input.trigger.is_empty() {
        return Err("触发条件不能为空".to_string());
    }
    if input.vol <= 0 || input.vol % 100 != 0 {
        return Err("委托数量须为 100 股整数倍".to_string());
    }
    if !matches!(input.price_mode.as_str(), "trigger" | "limit" | "market") {
        return Err("委托价方式必须为 trigger/limit/market".to_string());
    }
    if !matches!(input.ttl.as_str(), "day" | "gtc" | "date") {
        return Err("有效期必须为 day/gtc/date".to_string());
    }
    let trigger_json = serde_json::to_string(&input.trigger)
        .map_err(|e| format!("序列化触发条件失败: {e}"))?;
    let now = now_millis();
    let co_id = gen_co_id(now);
    let trade_date = beijing_today();
    conn.execute(
        "INSERT INTO conditional_order
           (co_id,trade_date,code,name,side,trigger_json,price_mode,limit_price,
            vol,ttl,expire_at,auto_confirm,status,ticket_id,note,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'active','',?13,?14,?14)",
        params![
            co_id, trade_date, input.code, input.name, side, trigger_json,
            input.price_mode, input.limit_price, input.vol, input.ttl,
            input.expire_at, input.auto_confirm as i64, input.note, now
        ],
    )
    .map_err(|e| format!("写入条件单失败: {e}"))?;
    Ok(co_id)
}

pub fn list(conn: &Connection, status: Option<String>, limit: i64) -> Vec<ConditionalOrder> {
    let sql = if status.is_some() {
        "SELECT * FROM conditional_order WHERE status=?1 ORDER BY id DESC LIMIT ?2"
    } else {
        "SELECT * FROM conditional_order ORDER BY id DESC LIMIT ?1"
    };
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = if let Some(st) = status {
        stmt.query_map(params![st, limit], row_to_order)
    } else {
        stmt.query_map(params![limit], row_to_order)
    };
    rows.map(|r| r.flatten().collect()).unwrap_or_default()
}

pub fn get_by_co_id(conn: &Connection, co_id: &str) -> Option<ConditionalOrder> {
    conn.query_row(
        "SELECT * FROM conditional_order WHERE co_id=?1",
        params![co_id],
        row_to_order,
    )
    .ok()
}

/// 修改（仅 active）。None 字段保持不变。
#[allow(clippy::too_many_arguments)]
pub fn update(
    conn: &Connection,
    id: i64,
    vol: Option<i64>,
    limit_price: Option<f64>,
    ttl: Option<String>,
    expire_at: Option<i64>,
    auto_confirm: Option<bool>,
    note: Option<String>,
) -> Result<(), String> {
    let cur: String = conn.query_row(
        "SELECT status FROM conditional_order WHERE id=?1",
        params![id],
        |r| r.get(0),
    )
    .map_err(|e| format!("读取条件单失败: {e}"))?;
    if cur != ACTIVE {
        return Err(format!("仅进行中条件单可修改，当前状态：{cur}"));
    }
    if let Some(v) = vol {
        if v <= 0 || v % 100 != 0 {
            return Err("委托数量须为 100 股整数倍".to_string());
        }
    }
    if let Some(t) = &ttl {
        if !matches!(t.as_str(), "day" | "gtc" | "date") {
            return Err("有效期必须为 day/gtc/date".to_string());
        }
    }
    let now = now_millis();
    conn.execute(
        "UPDATE conditional_order SET
            vol=COALESCE(?2,vol),
            limit_price=COALESCE(?3,limit_price),
            ttl=COALESCE(?4,ttl),
            expire_at=COALESCE(?5,expire_at),
            auto_confirm=COALESCE(?6,auto_confirm),
            note=COALESCE(?7,note),
            updated_at=?8
         WHERE id=?1",
        params![
            id,
            vol,
            limit_price,
            ttl,
            expire_at,
            auto_confirm.map(|b| b as i64),
            note,
            now
        ],
    )
    .map_err(|e| format!("更新条件单失败: {e}"))?;
    Ok(())
}

/// 撤销（仅 active）。
pub fn cancel(conn: &Connection, id: i64) -> Result<(), String> {
    let n = conn.execute(
        "UPDATE conditional_order SET status=?2,updated_at=?3 WHERE id=?1 AND status=?4",
        params![id, CANCELLED, now_millis(), ACTIVE],
    )
    .map_err(|e| format!("撤销条件单失败: {e}"))?;
    if n == 0 {
        return Err("条件单不存在或已不可撤销".to_string());
    }
    Ok(())
}

/// 撤销全部 active，返回撤销数量。
pub fn cancel_all(conn: &Connection) -> Result<i64, String> {
    conn.execute(
        "UPDATE conditional_order SET status=?1,updated_at=?2 WHERE status=?3",
        params![CANCELLED, now_millis(), ACTIVE],
    )
    .map(|n| n as i64)
    .map_err(|e| format!("批量撤销失败: {e}"))
}

/// 命中触发：active → triggered，记录触发时间（WHERE 限定 active，防重复触发）。
pub fn mark_triggered(conn: &Connection, co_id: &str, now: i64) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE conditional_order SET status=?2,triggered_at=?3,updated_at=?3
             WHERE co_id=?1 AND status=?4",
            params![co_id, TRIGGERED, now, ACTIVE],
        )
        .map_err(|e| format!("标记条件单触发失败: {e}"))?;
    if n == 0 {
        return Err("条件单已不在进行中状态（可能已触发/撤销/过期）".to_string());
    }
    Ok(())
}

/// 回填触发后生成的信号票 id。
pub fn set_ticket_id(conn: &Connection, co_id: &str, ticket_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE conditional_order SET ticket_id=?2,updated_at=?3 WHERE co_id=?1",
        params![co_id, ticket_id, now_millis()],
    )
    .map(|_| ())
    .map_err(|e| format!("回填信号票失败: {e}"))
}

/// 过期：ttl=day 且非当日建单，或 ttl=date 且已过 expire_at。返回过期条数。
pub fn expire_due(conn: &Connection, today: &str, now: i64) -> Result<i64, String> {
    let n = conn
        .execute(
            "UPDATE conditional_order SET status=?1,updated_at=?2
             WHERE status=?3 AND (
                (ttl='day' AND trade_date <> ?4) OR
                (ttl='date' AND expire_at > 0 AND expire_at < ?5))",
            params![EXPIRED, now, ACTIVE, today, now],
        )
        .map_err(|e| format!("条件单过期处理失败: {e}"))?;
    Ok(n as i64)
}

fn checkpoint(conn: &Connection) {
    let _ = conn.query_row::<i64, _, _>("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(0));
}

// ===== Tauri 命令 =====

#[tauri::command]
pub fn co_list(
    ai: State<'_, crate::ai::AiState>,
    status: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<ConditionalOrder>, String> {
    let conn = maindb::open_readonly(&ai.dir())?;
    Ok(list(&conn, status, limit.unwrap_or(200)))
}

#[tauri::command]
pub fn co_create(
    ai: State<'_, crate::ai::AiState>,
    code: String,
    name: String,
    side: String,
    trigger: Vec<CoTrigger>,
    vol: i64,
    price_mode: Option<String>,
    limit_price: Option<f64>,
    ttl: Option<String>,
    expire_at: Option<i64>,
    auto_confirm: Option<bool>,
    note: Option<String>,
) -> Result<String, String> {
    let conn = maindb::open_readwrite(&ai.dir())?;
    let co_id = insert(
        &conn,
        CreateInput {
            code,
            name,
            side,
            trigger,
            price_mode: price_mode.unwrap_or_else(|| "trigger".to_string()),
            limit_price: limit_price.unwrap_or(0.0),
            vol,
            ttl: ttl.unwrap_or_else(|| "day".to_string()),
            expire_at: expire_at.unwrap_or(0),
            auto_confirm: auto_confirm.unwrap_or(false),
            note: note.unwrap_or_default(),
        },
    )?;
    checkpoint(&conn);
    Ok(co_id)
}

#[tauri::command]
pub fn co_update(
    ai: State<'_, crate::ai::AiState>,
    id: i64,
    vol: Option<i64>,
    limit_price: Option<f64>,
    ttl: Option<String>,
    expire_at: Option<i64>,
    auto_confirm: Option<bool>,
    note: Option<String>,
) -> Result<(), String> {
    let conn = maindb::open_readwrite(&ai.dir())?;
    let r = update(
        &conn, id, vol, limit_price, ttl, expire_at, auto_confirm, note,
    );
    if r.is_ok() {
        checkpoint(&conn);
    }
    r
}

#[tauri::command]
pub fn co_cancel(ai: State<'_, crate::ai::AiState>, id: i64) -> Result<(), String> {
    let conn = maindb::open_readwrite(&ai.dir())?;
    let r = cancel(&conn, id);
    if r.is_ok() {
        checkpoint(&conn);
    }
    r
}

#[tauri::command]
pub fn co_cancel_all(ai: State<'_, crate::ai::AiState>) -> Result<i64, String> {
    let conn = maindb::open_readwrite(&ai.dir())?;
    let n = cancel_all(&conn)?;
    checkpoint(&conn);
    Ok(n)
}

// ===== 单测 =====

#[cfg(test)]
mod tests {
    use super::*;

    fn memdb() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(CREATE_SQL).unwrap();
        c
    }
    fn sample_trigger() -> Vec<CoTrigger> {
        vec![CoTrigger {
            field: "price".to_string(),
            op: "crossUp".to_string(),
            value: 10.0,
            params: None,
        }]
    }
    fn mk(code: &str, side: &str, vol: i64) -> CreateInput {
        CreateInput {
            code: code.to_string(),
            name: "测试股".to_string(),
            side: side.to_string(),
            trigger: sample_trigger(),
            price_mode: "trigger".to_string(),
            limit_price: 0.0,
            vol,
            ttl: "day".to_string(),
            expire_at: 0,
            auto_confirm: false,
            note: String::new(),
        }
    }

    #[test]
    fn create_and_list_roundtrip() {
        let c = memdb();
        let id1 = insert(&c, mk("600519", "BUY", 200)).unwrap();
        let id2 = insert(&c, mk("000001", "SELL", 300)).unwrap();
        assert_ne!(id1, id2, "co_id 不碰撞");
        let all = list(&c, None, 200);
        assert_eq!(all.len(), 2);
        // trigger JSON 正确还原
        let one = get_by_co_id(&c, &id1).unwrap();
        assert_eq!(one.side, "BUY");
        assert_eq!(one.trigger[0].field, "price");
        assert_eq!(one.status, ACTIVE);
        assert!(!one.auto_confirm, "默认不自动确认");
    }

    #[test]
    fn list_by_status() {
        let c = memdb();
        insert(&c, mk("600519", "BUY", 100)).unwrap();
        let co = list(&c, Some(ACTIVE.to_string()), 200);
        assert_eq!(co.len(), 1);
        assert!(list(&c, Some(DONE.to_string()), 200).is_empty());
    }

    #[test]
    fn cancel_lifecycle() {
        let c = memdb();
        insert(&c, mk("600519", "BUY", 100)).unwrap();
        let o = list(&c, None, 200).remove(0);
        cancel(&c, o.id).unwrap();
        assert_eq!(get_by_co_id(&c, &o.co_id).unwrap().status, CANCELLED);
        // 已撤销不能再改
        assert!(update(&c, o.id, Some(200), None, None, None, None, None).is_err());
        // 再撤销报错
        assert!(cancel(&c, o.id).is_err());
    }

    #[test]
    fn cancel_all_counts() {
        let c = memdb();
        insert(&c, mk("a", "BUY", 100)).unwrap();
        insert(&c, mk("b", "BUY", 100)).unwrap();
        let n = cancel_all(&c).unwrap();
        assert_eq!(n, 2);
        assert_eq!(list(&c, Some(ACTIVE.to_string()), 200).len(), 0);
    }

    #[test]
    fn update_fields_while_active() {
        let c = memdb();
        insert(&c, mk("600519", "BUY", 100)).unwrap();
        let o = list(&c, None, 200).remove(0);
        update(&c, o.id, Some(400), Some(12.5), Some("gtc".to_string()),
            None, Some(true), Some("备注".to_string())).unwrap();
        let o2 = get_by_co_id(&c, &o.co_id).unwrap();
        assert_eq!(o2.vol, 400);
        assert_eq!(o2.limit_price, 12.5);
        assert_eq!(o2.ttl, "gtc");
        assert!(o2.auto_confirm);
        assert_eq!(o2.note, "备注");
    }

    #[test]
    fn rejects_invalid_input() {
        let c = memdb();
        assert!(insert(&c, mk("x", "HOLD", 100)).is_err(), "非法方向");
        assert!(insert(&c, mk("x", "BUY", 150)).is_err(), "非整手");
        let mut bad = mk("x", "BUY", 100);
        bad.trigger = vec![];
        assert!(insert(&c, bad).is_err(), "空触发条件");
    }
}
