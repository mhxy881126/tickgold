// P1-a：计划指令 → 条件单物化、状态推导；状态不落库，读取时计算。
// 本任务仅提供触发映射与状态推导，materialize/list 在后续任务补充。

use crate::broker::conditional::CoTrigger;
use serde_json::Value;
use std::collections::HashSet;

/// 读取计划指令 `alert_rule` 中的数值字段。
fn num(rule: &Value, key: &str) -> Option<f64> {
    rule.get(key).and_then(|v| v.as_f64())
}

/// 构造条件单触发叶子。
fn leaf(field: &str, op: &str, value: f64, params: Option<Value>) -> CoTrigger {
    CoTrigger {
        field: field.to_string(),
        op: op.to_string(),
        value,
        params,
    }
}

/// 把 `plan_instruction.alert_rule` 映射为条件单叶子（数组内 AND）。
///
/// 支持字段与 `market/alert.rs::eval_leaf` 对齐：price / pct / volumeRatio /
/// turnover / amount / riseSpeed / downSpeed / sealUp / sealDown / broken；
/// 无可用字段时返回空数组（调用方应跳过物化）。
#[allow(dead_code)] // Task 2/3 接入物化与列表
pub fn leaves_from_alert_rule(rule: &Value) -> Vec<CoTrigger> {
    let mut out = Vec::new();
    if let Some(v) = num(rule, "upPrice") {
        out.push(leaf("price", "gte", v, None));
    }
    if let Some(v) = num(rule, "downPrice") {
        out.push(leaf("price", "lte", v, None));
    }
    if let Some(v) = num(rule, "upPct") {
        out.push(leaf("pct", "gte", v, None));
    }
    if let Some(v) = num(rule, "downPct") {
        out.push(leaf("pct", "lte", v, None));
    }
    if let Some(v) = num(rule, "minVolumeRatio") {
        out.push(leaf("volumeRatio", "gte", v, None));
    }
    if let Some(v) = num(rule, "minTurnover") {
        out.push(leaf("turnover", "gte", v, None));
    }
    if let Some(v) = num(rule, "minAmount") {
        out.push(leaf("amount", "gte", v, None));
    }
    if let Some(v) = num(rule, "riseSpeed") {
        let win = rule
            .get("speedWindowSec")
            .and_then(|x| x.as_i64())
            .unwrap_or(300);
        out.push(leaf(
            "riseSpeed",
            "gte",
            v,
            Some(serde_json::json!({ "windowSec": win })),
        ));
    }
    if let Some(v) = num(rule, "downSpeed") {
        out.push(leaf("downSpeed", "gte", v, None));
    }
    for (key, field) in [
        ("sealLimitUp", "sealUp"),
        ("sealLimitDown", "sealDown"),
        ("brokenLimit", "broken"),
    ] {
        if rule.get(key).and_then(|x| x.as_i64()).unwrap_or(0) > 0 {
            out.push(leaf(field, "gte", 1.0, None));
        }
    }
    out
}

/// 读取时推导：条件单 → 信号票 → 委托。状态不落库。
#[allow(dead_code)] // Task 2/3 接入物化与列表
pub fn derive_state(co: Option<&str>, ticket: Option<&str>, order: Option<&str>) -> &'static str {
    match co.unwrap_or("") {
        "" => "watch",
        "cancelled" => "cancelled",
        "expired" => "expired",
        "active" => "pending",
        _ => match ticket.unwrap_or("") {
            "rejected" => "cancelled",
            "done" => "filled",
            "confirmed" => {
                if order == Some("filled") {
                    "filled"
                } else {
                    "submitted"
                }
            }
            "pending" => "triggered",
            _ => {
                if order == Some("filled") {
                    "filled"
                } else {
                    "triggered"
                }
            }
        },
    }
}

/// 检查 `plan_instruction` 是否已具备 P1-a 新增列（旧库未迁移时降级）。
#[allow(dead_code)] // Task 2/3 接入物化与列表
pub fn plan_instruction_columns_exist(conn: &rusqlite::Connection) -> bool {
    let mut stmt = match conn.prepare("PRAGMA table_info(plan_instruction)") {
        Ok(s) => s,
        Err(_) => return false,
    };
    let cols: HashSet<String> = match stmt.query_map([], |r| r.get::<_, String>(1)) {
        Ok(rows) => rows.filter_map(|x| x.ok()).collect(),
        Err(_) => return false,
    };
    cols.contains("co_id") && cols.contains("trigger_json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn leaf_mapping_multi_and_skip() {
        let rule = json!({
            "upPrice": 10.5, "upPct": 3.0, "minVolumeRatio": 2.0,
            "riseSpeed": 1.2, "speedWindowSec": 120, "sealLimitUp": 1, "vol": 300
        });
        let leaves = leaves_from_alert_rule(&rule);
        assert_eq!(leaves.len(), 5);
        assert!(leaves
            .iter()
            .any(|l| l.field == "price" && l.op == "gte" && l.value == 10.5));
        assert!(leaves.iter().any(|l| l.field == "riseSpeed"
            && l.params
                .as_ref()
                .and_then(|p| p.get("windowSec"))
                .and_then(|v| v.as_i64())
                == Some(120)));
        assert!(leaves.iter().any(|l| l.field == "sealUp"));
        assert!(leaves_from_alert_rule(&json!({"vol": 100})).is_empty());
    }

    #[test]
    fn derive_state_matrix() {
        assert_eq!(derive_state(None, None, None), "watch");
        assert_eq!(derive_state(Some("active"), None, None), "pending");
        assert_eq!(derive_state(Some("triggered"), None, None), "triggered");
        assert_eq!(
            derive_state(Some("triggered"), Some("pending"), None),
            "triggered"
        );
        assert_eq!(
            derive_state(Some("triggered"), Some("confirmed"), Some("submitted")),
            "submitted"
        );
        assert_eq!(
            derive_state(Some("triggered"), Some("confirmed"), Some("filled")),
            "filled"
        );
        assert_eq!(derive_state(Some("triggered"), Some("done"), None), "filled");
        assert_eq!(derive_state(Some("cancelled"), None, None), "cancelled");
        assert_eq!(
            derive_state(Some("triggered"), Some("rejected"), None),
            "cancelled"
        );
        assert_eq!(derive_state(Some("expired"), None, None), "expired");
    }

    #[test]
    fn columns_check_reacts_to_p1a_columns() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE plan_instruction(id INTEGER PRIMARY KEY)")
            .unwrap();
        assert!(!plan_instruction_columns_exist(&conn));
        conn.execute_batch(
            "ALTER TABLE plan_instruction ADD COLUMN co_id TEXT DEFAULT '';
             ALTER TABLE plan_instruction ADD COLUMN trigger_json TEXT DEFAULT '';",
        )
        .unwrap();
        assert!(plan_instruction_columns_exist(&conn));
    }
}
