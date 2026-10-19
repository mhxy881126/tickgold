// P1-a：计划指令 → 条件单物化、状态推导；状态不落库，读取时计算。
// 本任务提供触发映射、状态推导与物化；读取列表在后续任务补充。

use crate::ai::now_millis;
use crate::broker::conditional::CoTrigger;
use serde_json::Value;
use std::collections::HashSet;

/// 读取计划指令 `alert_rule` 中的数值字段。
fn num(rule: &Value, key: &str) -> Option<f64> {
    rule.get(key).and_then(|v| v.as_f64())
}

/// 突破阈值：价格/涨幅必须 > 0；0 或负值视为未设置。
fn positive(rule: &Value, key: &str) -> Option<f64> {
    num(rule, key).filter(|v| *v > 0.0)
}

/// 回踩阈值：回落幅度必须 < 0（如 `downPct:-5`）；0 或正值视为未设置。
fn negative(rule: &Value, key: &str) -> Option<f64> {
    num(rule, key).filter(|v| *v < 0.0)
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
///
/// 方向互斥：数组内是 AND，同时给上涨与下跌阈值会得到
/// `pct>=5 AND pct<=-5` 这种永假条件，故只取单方向——突破优先，其次回踩：
/// `upPrice`（price gte）→ `upPct`（pct gte）→ `downPrice`（price lte）→
/// `downPct`（pct lte），命中其一即停止，绝不上下同时出叶。
///
/// 方向阈值必须有效：突破价/幅 > 0，回踩价 > 0、回落幅 < 0；0 视为未设置。
/// 否则 `upPrice:0` 会物化成 `price>=0` 的恒真单，一开盘就触发。
pub fn leaves_from_alert_rule(rule: &Value) -> Vec<CoTrigger> {
    let mut out = Vec::new();
    if let Some(v) = positive(rule, "upPrice") {
        out.push(leaf("price", "gte", v, None));
    } else if let Some(v) = positive(rule, "upPct") {
        out.push(leaf("pct", "gte", v, None));
    } else if let Some(v) = positive(rule, "downPrice") {
        out.push(leaf("price", "lte", v, None));
    } else if let Some(v) = negative(rule, "downPct") {
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
#[allow(dead_code)] // Task 3 列表展示接入
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

/// 条件单是否仍存在。
///
/// 说明：`conditional::get_by_co_id` 当前为 `#[cfg(test)]`，而物化需要在正式构建里
/// 判定幂等；本任务文件范围不含 `broker/conditional.rs`，故就地做存在性查询。
fn co_exists(conn: &rusqlite::Connection, co_id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM conditional_order WHERE co_id=?1",
        [co_id],
        |_| Ok(()),
    )
    .is_ok()
}

/// 物化结果统计：新建 / 跳过（观察级或条件不可用或已物化）/ 失败（建单校验或写库失败）。
#[derive(Debug, Default)]
pub struct MaterializeSummary {
    pub created: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// 把作战卡的 candidate/trigger 指令物化为条件单；幂等（已有 co_id 且单据存在则跳过）。
///
/// 单条失败只计入 `failed`，不阻断其余指令；选股数量默认 100 股，非整手则跳过。
pub fn materialize_plan(
    conn: &rusqlite::Connection,
    plan_id: i64,
) -> Result<MaterializeSummary, String> {
    // 只在计划自己的交易日物化：次日计划必须等开盘当天再建条件单，
    // 否则 ttl=day 的单在当天就被 conditional::expire_due 判过期，
    // 智驾盘中的确认也可能当天触发次日单。
    let plan_date: String = conn
        .query_row("SELECT plan_date FROM plan WHERE id=?1", [plan_id], |r| {
            r.get::<_, String>(0)
        })
        .unwrap_or_default();
    if plan_date != crate::broker::conditional::today_dashed() {
        return Ok(MaterializeSummary::default());
    }

    let rows: Vec<(i64, String, String, String, String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id,tier,code,name,alert_rule,co_id FROM plan_instruction
                 WHERE plan_id=?1 ORDER BY sort",
            )
            .map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([plan_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        it.filter_map(|x| x.ok()).collect()
    };

    let mut out = MaterializeSummary::default();
    for (id, tier, code, name, rule_json, co_id) in rows {
        if tier != "candidate" && tier != "trigger" {
            out.skipped += 1;
            continue;
        }
        if !co_id.is_empty() && co_exists(conn, &co_id) {
            out.skipped += 1;
            continue;
        }
        // 代码去空白后再判空/建单，避免 " 600519 " 这类脏数据落到条件单。
        let code = code.trim().to_string();
        if code.is_empty() {
            out.skipped += 1;
            continue;
        }
        let rule: Value =
            serde_json::from_str(&rule_json).unwrap_or_else(|_| serde_json::json!({}));
        let leaves = leaves_from_alert_rule(&rule);
        if leaves.is_empty() {
            out.skipped += 1;
            continue;
        }
        let vol = rule.get("vol").and_then(|v| v.as_i64()).unwrap_or(100);
        if vol <= 0 || vol % 100 != 0 {
            out.skipped += 1;
            continue;
        }
        let side = rule
            .get("side")
            .and_then(|v| v.as_str())
            .unwrap_or("BUY")
            .to_uppercase();
        let input = crate::broker::conditional::CreateInput {
            code,
            name: name.clone(),
            side,
            trigger: leaves.clone(),
            price_mode: "trigger".to_string(),
            limit_price: 0.0,
            vol,
            ttl: "day".to_string(),
            expire_at: now_millis() + 86_400_000,
            auto_confirm: true,
            ticket_id: String::new(),
            note: format!("plan:{plan_id}:{id}"),
        };
        match crate::broker::conditional::insert(conn, input) {
            Ok(co_id_new) => {
                let trigger_json = serde_json::to_string(&leaves).unwrap_or_default();
                let _ = conn.execute(
                    "UPDATE plan_instruction SET co_id=?1,trigger_json=?2,synced_at=?3 WHERE id=?4",
                    rusqlite::params![co_id_new, trigger_json, now_millis(), id],
                );
                out.created += 1;
            }
            Err(e) => {
                log::warn!("materialize instruction {id} failed: {e}");
                out.failed += 1;
            }
        }
    }
    Ok(out)
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
        // 方向互斥：upPrice 胜出后 upPct 不再出叶，故为 4 片而非 5 片
        assert_eq!(leaves.len(), 4);
        assert!(leaves
            .iter()
            .any(|l| l.field == "price" && l.op == "gte" && l.value == 10.5));
        assert!(
            !leaves.iter().any(|l| l.field == "pct"),
            "突破价已覆盖方向，不应再有 pct 叶: {leaves:?}"
        );
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
    fn leaf_mapping_single_direction_never_both() {
        // 规则作战卡同时给上下阈值：只保留突破方向（upPrice → price gte）
        let both_price = json!({"upPrice": 10.5, "downPrice": 9.5});
        let leaves = leaves_from_alert_rule(&both_price);
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].field, "price");
        assert_eq!(leaves[0].op, "gte");
        assert_eq!(leaves[0].value, 10.5);

        // 只有涨跌幅时突破优先：{upPct:5,downPct:-5} 只出 pct gte
        let both_pct = json!({"upPct": 5, "downPct": -5});
        let leaves = leaves_from_alert_rule(&both_pct);
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].field, "pct");
        assert_eq!(leaves[0].op, "gte");
        assert_eq!(leaves[0].value, 5.0);

        // 上下不同维度混用：突破优先于回踩，回踩叶被丢弃
        let mixed = json!({"downPrice": 9.5, "upPct": 5});
        let leaves = leaves_from_alert_rule(&mixed);
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].field, "pct");
        assert_eq!(leaves[0].op, "gte");

        // 仅回踩价：downPrice 独占（price lte）
        let down_price = json!({"downPrice": 9.5});
        let leaves = leaves_from_alert_rule(&down_price);
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].field, "price");
        assert_eq!(leaves[0].op, "lte");
        assert_eq!(leaves[0].value, 9.5);
    }

    #[test]
    fn leaf_mapping_down_pct_only_uses_lte() {
        let leaves = leaves_from_alert_rule(&json!({"downPct": -5}));
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].field, "pct");
        assert_eq!(leaves[0].op, "lte");
        assert_eq!(leaves[0].value, -5.0);
    }

    #[test]
    fn leaf_mapping_up_pct_only_uses_gte() {
        let leaves = leaves_from_alert_rule(&json!({"upPct": 5}));
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].field, "pct");
        assert_eq!(leaves[0].op, "gte");
        assert_eq!(leaves[0].value, 5.0);
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

    fn conn_with_tables() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::broker::conditional::CREATE_SQL)
            .unwrap();
        conn.execute_batch(
            "CREATE TABLE plan(id INTEGER PRIMARY KEY, plan_date TEXT);
             CREATE TABLE plan_instruction(
                id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER, tier TEXT, code TEXT,
                name TEXT, theme TEXT, condition TEXT, action TEXT, position_hint TEXT,
                alert_rule TEXT, status TEXT, sort INTEGER,
                co_id TEXT DEFAULT '', trigger_json TEXT DEFAULT '', synced_at INTEGER DEFAULT 0);",
        )
        .unwrap();
        conn
    }

    fn insert_plan(conn: &rusqlite::Connection, id: i64, plan_date: &str) {
        conn.execute(
            "INSERT INTO plan(id,plan_date) VALUES(?1,?2)",
            rusqlite::params![id, plan_date],
        )
        .unwrap();
    }

    fn co_count(conn: &rusqlite::Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM conditional_order", [], |r| r.get(0))
            .unwrap()
    }

    fn instruction_co_id(conn: &rusqlite::Connection, id: i64) -> String {
        conn.query_row(
            "SELECT co_id FROM plan_instruction WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn materialize_is_idempotent() {
        let conn = conn_with_tables();
        insert_plan(&conn, 1, &crate::broker::conditional::today_dashed());
        conn.execute(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台','{\"upPrice\":1700,\"vol\":200}','open',0)",
            [],
        )
        .unwrap();
        let first = materialize_plan(&conn, 1).unwrap();
        assert_eq!(first.created, 1);
        let second = materialize_plan(&conn, 1).unwrap();
        assert_eq!(second.created, 0);
        assert_eq!(second.skipped, 1);
        let n = co_count(&conn);
        assert_eq!(n, 1);
        let (co_id, trigger_json): (String, String) = conn
            .query_row(
                "SELECT co_id,trigger_json FROM plan_instruction WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(!co_id.is_empty());
        assert!(
            trigger_json.contains("\"field\":\"price\""),
            "触发条件应回写到指令: {trigger_json}"
        );
        // 物化入参：数量取 alertRule.vol，备注带计划与指令来源，便于溯源
        let (vol, note): (i64, String) = conn
            .query_row("SELECT vol,note FROM conditional_order", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(vol, 200);
        assert_eq!(note, "plan:1:1");
    }

    #[test]
    fn materialize_skips_watch_and_invalid_rule() {
        let conn = conn_with_tables();
        insert_plan(&conn, 1, &crate::broker::conditional::today_dashed());
        conn.execute_batch(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'watch','600519','茅台','{\"upPrice\":1700}','open',0);
             INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','000001','平安','{}','open',1);",
        )
        .unwrap();
        let s = materialize_plan(&conn, 1).unwrap();
        assert_eq!(s.created, 0);
        assert_eq!(s.skipped, 2);
        assert_eq!(co_count(&conn), 0);
    }

    #[test]
    fn materialize_skips_future_plan() {
        let conn = conn_with_tables();
        // 非计划日（未来日期）不物化：次日计划必须等开盘当天再建条件单。
        insert_plan(&conn, 1, "2999-01-01");
        conn.execute(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台','{\"upPrice\":1700,\"vol\":200}','open',0)",
            [],
        )
        .unwrap();
        let s = materialize_plan(&conn, 1).unwrap();
        assert_eq!(s.created, 0);
        assert_eq!(s.skipped, 0, "非计划日应直接返回，不逐条扫描");
        assert_eq!(co_count(&conn), 0);
        assert!(instruction_co_id(&conn, 1).is_empty());
    }

    #[test]
    fn materialize_skips_empty_code_and_zero_price() {
        let conn = conn_with_tables();
        insert_plan(&conn, 1, &crate::broker::conditional::today_dashed());
        conn.execute_batch(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','','空代码','{\"upPrice\":1700}','open',0);
             INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','000002','零价','{\"upPrice\":0}','open',1);
             INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','000003','零价有涨幅','{\"upPrice\":0,\"upPct\":5}','open',2);",
        )
        .unwrap();
        let s = materialize_plan(&conn, 1).unwrap();
        // 空代码、只有 upPrice:0 的两条跳过；第三条 upPrice:0 不再遮蔽 upPct，按涨幅物化。
        assert_eq!(s.created, 1);
        assert_eq!(s.skipped, 2);
        assert_eq!(co_count(&conn), 1);
        assert!(instruction_co_id(&conn, 1).is_empty());
        assert!(instruction_co_id(&conn, 2).is_empty());
        let co_id = instruction_co_id(&conn, 3);
        assert!(!co_id.is_empty());
        let trigger: String = conn
            .query_row(
                "SELECT trigger_json FROM conditional_order WHERE co_id=?1",
                [&co_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(trigger.contains("\"field\":\"pct\""), "{trigger}");
        assert!(
            !trigger.contains("\"field\":\"price\""),
            "upPrice:0 不应生成 price>=0 恒真叶: {trigger}"
        );

        // 叶子层：零突破价被忽略后，方向选择继续落到 upPct（只出涨幅叶）。
        let leaves = leaves_from_alert_rule(&json!({"upPrice": 0, "upPct": 5}));
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].field, "pct");
        assert_eq!(leaves[0].op, "gte");
        assert_eq!(leaves[0].value, 5.0);
        // 零值/错方向的阈值一律视为未设置，避免恒真或恒假条件。
        assert!(leaves_from_alert_rule(&json!({"upPrice": 0})).is_empty());
        assert!(leaves_from_alert_rule(&json!({"downPct": 0})).is_empty());
    }

    #[test]
    fn materialize_does_not_touch_other_plans() {
        let conn = conn_with_tables();
        let today = crate::broker::conditional::today_dashed();
        insert_plan(&conn, 1, &today);
        insert_plan(&conn, 2, &today);
        conn.execute_batch(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台','{\"upPrice\":1700}','open',0);
             INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(2,'candidate','000001','平安','{\"upPrice\":10}','open',0);",
        )
        .unwrap();
        let s = materialize_plan(&conn, 1).unwrap();
        assert_eq!(s.created, 1);
        assert_eq!(co_count(&conn), 1);
        assert!(!instruction_co_id(&conn, 1).is_empty());
        assert!(
            instruction_co_id(&conn, 2).is_empty(),
            "只应物化目标计划的指令，不得波及其它计划"
        );
        let note: String = conn
            .query_row("SELECT note FROM conditional_order", [], |r| r.get(0))
            .unwrap();
        assert_eq!(note, "plan:1:1");
    }
}
