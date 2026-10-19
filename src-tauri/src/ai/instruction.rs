// P1-a：计划指令 → 条件单物化、状态推导；状态不落库，读取时计算。
// 本文件提供触发映射、状态推导、物化与只读指令列表（供 workflow_instructions 复用）。

use crate::ai::now_millis;
use crate::broker::conditional::CoTrigger;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};

/// 已触发 / 已挂票 / 已结束的指令禁止改触发条件：否则会撤掉已成交路径（P1-b spec §七）。
const TRIGGERED_EDIT_ERROR: &str = "已触发，不能修改触发条件";

/// 触发条件可编辑键（P1-b spec §三）：未列出的键一律忽略，避免前端误传把 `alert_rule` 写脏。
const EDITABLE_RULE_KEYS: [&str; 16] = [
    "upPrice",
    "downPrice",
    "upPct",
    "downPct",
    "minVolumeRatio",
    "minTurnover",
    "minAmount",
    "riseSpeed",
    "speedWindowSec",
    "downSpeed",
    "sealLimitUp",
    "sealLimitDown",
    "brokenLimit",
    "vol",
    "side",
    "autoConfirm",
];

/// 数值型编辑键：类型错误直接报错，避免 `"1710"` 这类脏值被静默忽略。
const NUMERIC_RULE_KEYS: [&str; 14] = [
    "upPrice",
    "downPrice",
    "upPct",
    "downPct",
    "minVolumeRatio",
    "minTurnover",
    "minAmount",
    "riseSpeed",
    "speedWindowSec",
    "downSpeed",
    "sealLimitUp",
    "sealLimitDown",
    "brokenLimit",
    "vol",
];

/// 数量校验：必须为正整数且是 100 股整数倍；兼容前端 JS 数字的整值浮点（如 200.0）。
fn as_lot_vol(v: &Value) -> Option<i64> {
    let n = v
        .as_i64()
        .or_else(|| v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))?;
    (n > 0 && n % 100 == 0).then_some(n)
}

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
/// 过滤类阈值（量比 / 换手 / 成交额 / 涨速 / 跳水）同样只接受 `> 0`：
/// 0 会让 `amount>=0` 之类的条件恒真，等于没设过滤。
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
    if let Some(v) = positive(rule, "minVolumeRatio") {
        out.push(leaf("volumeRatio", "gte", v, None));
    }
    if let Some(v) = positive(rule, "minTurnover") {
        out.push(leaf("turnover", "gte", v, None));
    }
    if let Some(v) = positive(rule, "minAmount") {
        // 与 market/alert.rs 语义一致：value 单位为亿元，eval_leaf 用 amount/1e8 比较。
        out.push(leaf("amount", "gte", v, None));
    }
    if let Some(v) = positive(rule, "riseSpeed") {
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
    if let Some(v) = positive(rule, "downSpeed") {
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

/// 读取计划指令并推导执行状态（只读，状态不落库）。
///
/// 单条 SQL 左联 `conditional_order → signal_ticket → broker_order`，一次取齐
/// 条件单状态、触发时间与成交回填，避免 N+1 查询。旧库未迁移（缺 `co_id` /
/// `trigger_json`）时降级为只读计划字段，全部指令按「仅观察」返回。
pub fn list_instructions(conn: &rusqlite::Connection, plan_id: i64) -> Result<Vec<Value>, String> {
    if !plan_instruction_columns_exist(conn) {
        return list_instructions_legacy(conn, plan_id);
    }
    let mut stmt = conn
        .prepare(
            "SELECT i.id,i.tier,i.code,i.name,i.condition,i.action,i.position_hint,
                    i.co_id,i.trigger_json,
                    c.status,c.triggered_at,
                    t.id,t.status,o.status,o.filled_vol,o.filled_avg_price,
                    c.side,c.vol,c.limit_price,t.price,i.alert_rule
             FROM plan_instruction i
             LEFT JOIN conditional_order c ON c.co_id=i.co_id AND i.co_id<>''
             LEFT JOIN signal_ticket t ON t.sig_id=c.ticket_id AND c.ticket_id<>''
             LEFT JOIN broker_order o ON o.sig_id=t.sig_id
             WHERE i.plan_id=?1 ORDER BY i.sort",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([plan_id], |r| {
            let co = r.get::<_, String>(9).ok();
            let ticket = r.get::<_, String>(12).ok();
            let order = r.get::<_, String>(13).ok();
            // P1-b 行内编辑 / 确认下单所需字段：条件单未建立时回退到 alert_rule 默认值。
            let rule_json = r.get::<_, String>(20).unwrap_or_default();
            let rule: Value =
                serde_json::from_str(&rule_json).unwrap_or_else(|_| serde_json::json!({}));
            let co_side = r.get::<_, String>(16).unwrap_or_default();
            let side = if co_side.trim().is_empty() {
                rule.get("side")
                    .and_then(|v| v.as_str())
                    .unwrap_or("BUY")
                    .to_uppercase()
            } else {
                co_side
            };
            let co_vol = r.get::<_, i64>(17).unwrap_or(0);
            let vol = if co_vol > 0 {
                co_vol
            } else {
                rule.get("vol").and_then(|v| v.as_i64()).unwrap_or(100)
            };
            let limit_price = r.get::<_, f64>(18).unwrap_or(0.0);
            let ticket_price = r.get::<_, f64>(19).unwrap_or(0.0);
            // 确认下单弹窗优先取票面价，未触发时退回条件单限价。
            let price = if ticket_price > 0.0 {
                ticket_price
            } else {
                limit_price
            };
            Ok(serde_json::json!({
                "id": r.get::<_, i64>(0)?,
                "tier": r.get::<_, String>(1)?,
                "code": r.get::<_, String>(2)?,
                "name": r.get::<_, String>(3)?,
                "condition": r.get::<_, String>(4)?,
                "action": r.get::<_, String>(5)?,
                "positionHint": r.get::<_, String>(6)?,
                "coId": r.get::<_, String>(7)?,
                "triggerJson": r.get::<_, String>(8)?,
                "state": derive_state(co.as_deref(), ticket.as_deref(), order.as_deref()),
                "triggeredAt": r.get::<_, i64>(10).unwrap_or(0),
                "filledVol": r.get::<_, i64>(14).unwrap_or(0),
                "filledAvgPrice": r.get::<_, f64>(15).unwrap_or(0.0),
                "ticketId": r.get::<_, i64>(11).unwrap_or(0),
                "ticketStatus": r.get::<_, String>(12).unwrap_or_default(),
                "side": side,
                "vol": vol,
                "price": price,
                "autoConfirm": rule
                    .get("autoConfirm")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// 旧库降级：缺 `co_id`/`trigger_json` 时只返回计划字段，状态恒为「仅观察」。
fn list_instructions_legacy(
    conn: &rusqlite::Connection,
    plan_id: i64,
) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id,tier,code,name,condition,action,position_hint
             FROM plan_instruction WHERE plan_id=?1 ORDER BY sort",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([plan_id], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, i64>(0)?,
                "tier": r.get::<_, String>(1)?,
                "code": r.get::<_, String>(2)?,
                "name": r.get::<_, String>(3)?,
                "condition": r.get::<_, String>(4)?,
                "action": r.get::<_, String>(5)?,
                "positionHint": r.get::<_, String>(6)?,
                "coId": "",
                "triggerJson": "",
                "state": "watch",
                "triggeredAt": 0,
                "filledVol": 0,
                "filledAvgPrice": 0.0,
                "ticketId": 0,
                "ticketStatus": "",
                "side": "BUY",
                "vol": 100,
                "price": 0.0,
                "autoConfirm": true,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// 条件单是否仍在生效（未被取消 / 过期 / 完成）。
///
/// 说明：`conditional::get_by_co_id` 当前为 `#[cfg(test)]`，而物化需要在正式构建里
/// 判定幂等；本任务文件范围不含 `broker/conditional.rs`，故就地做存在性查询。
///
/// 不能只看「co_id 存在」：用户丢弃指令时旧条件单会被取消，重开指令必须重新
/// 物化一张新单，否则会一直停在已取消的死单上（v62 索引也已放开 cancelled 行）。
fn co_is_live(conn: &rusqlite::Connection, co_id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM conditional_order WHERE co_id=?1 \
         AND status NOT IN ('cancelled','expired','done')",
        [co_id],
        |_| Ok(()),
    )
    .is_ok()
}

/// 按物化备注反查仍生效的条件单：v62 唯一索引只约束 active 行，重复插入被拒时
/// 命中的必然是同一 note 的 active 单（旧 cancelled 行不再参与）。
fn co_id_by_note(conn: &rusqlite::Connection, note: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT co_id FROM conditional_order WHERE note=?1 AND status='active'",
        [note],
        |r| r.get::<_, String>(0),
    )
    .map_err(|e| e.to_string())
}

/// 回填指令 → 条件单关联（co_id / trigger_json / synced_at）。
///
/// 新建成功与唯一冲突恢复都必须回填：写失败若不报错，下一轮扫描只能靠
/// v62 唯一索引兜底，等于把错误拖到点外。
fn link_instruction(
    conn: &rusqlite::Connection,
    instr_id: i64,
    co_id: &str,
    trigger_json: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE plan_instruction SET co_id=?1,trigger_json=?2,synced_at=?3 WHERE id=?4",
        rusqlite::params![co_id, trigger_json, now_millis(), instr_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// 物化结果统计：新建 / 跳过（观察级或条件不可用或已物化）/ 失败（建单校验或写库失败）。
#[derive(Debug, Default)]
pub struct MaterializeSummary {
    pub created: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// 把作战卡的 candidate/trigger 指令物化为条件单；幂等（已有 co_id 且条件单仍
/// 生效则跳过，已取消 / 过期 / 完成的旧单会触发重新物化）。
///
/// 单条失败只计入 `failed`，不阻断其余指令；选股数量默认 100 股，非整手则跳过。
pub fn materialize_plan(
    conn: &rusqlite::Connection,
    plan_id: i64,
) -> Result<MaterializeSummary, String> {
    // 只在计划自己的交易日、且计划已确认时物化：次日计划必须等开盘当天再建条件单，
    // 否则 ttl=day 的单在当天就被 conditional::expire_due 判过期；
    // 草稿计划（生成后未复核确认）也不得自动建单。
    let (plan_date, plan_status): (String, String) = conn
        .query_row(
            "SELECT plan_date,status FROM plan WHERE id=?1",
            [plan_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or_default();
    if plan_date != crate::broker::conditional::today_dashed() || plan_status != "confirmed" {
        return Ok(MaterializeSummary::default());
    }

    let rows: Vec<(i64, String, String, String, String, String)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id,tier,code,name,alert_rule,co_id FROM plan_instruction
                 WHERE plan_id=?1 AND status IN ('open','alerted') ORDER BY sort",
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
        if !co_id.is_empty() && co_is_live(conn, &co_id) {
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
        let note = format!("plan:{plan_id}:{id}");
        let trigger_json = serde_json::to_string(&leaves).unwrap_or_default();
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
            // P1-b：条级模拟自动开关；缺省 true（实盘仍由 submit 闸门强制人工确认）。
            auto_confirm: rule
                .get("autoConfirm")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            ticket_id: String::new(),
            note: note.clone(),
        };
        match crate::broker::conditional::insert(conn, input) {
            Ok(co_id_new) => match link_instruction(conn, id, &co_id_new, &trigger_json) {
                Ok(()) => out.created += 1,
                Err(e) => {
                    // 条件单已建但关联未落库：下一轮会撞唯一索引，由回填分支补回。
                    log::warn!("materialize instruction {id} 回写 co_id 失败: {e}");
                    out.failed += 1;
                }
            },
            Err(e) if e.contains("UNIQUE constraint failed") => {
                // v62 兜底：同一 note 的条件单已存在（并发实例 / 上轮回写失败），
                // 按备注取回 co_id 并回填，计 skipped 而不是 failed。
                match co_id_by_note(conn, &note) {
                    Ok(existing) => match link_instruction(conn, id, &existing, &trigger_json) {
                        Ok(()) => out.skipped += 1,
                        Err(e) => {
                            log::warn!("materialize instruction {id} 回填 co_id 失败: {e}");
                            out.failed += 1;
                        }
                    },
                    Err(le) => {
                        log::warn!(
                            "materialize instruction {id} 唯一冲突但按备注查不到条件单: {le}"
                        );
                        out.failed += 1;
                    }
                }
            }
            Err(e) => {
                log::warn!("materialize instruction {id} failed: {e}");
                out.failed += 1;
            }
        }
    }
    Ok(out)
}

/// 行内编辑触发条件（P1-b spec §二/§三）：合并允许键 → 校验 → 取消旧条件单 →
/// 清关联 → 写回 `alert_rule` →（今天 + confirmed 时）立即重新物化。
///
/// 与 `conditional::cancel` 的关键区别：编辑场景**不能**把指令置 `dropped`，否则
/// `materialize_plan` 不再扫描该指令，用户保存后条件单永远不会重建。这里只把旧单置
/// `cancelled` 并清空 `co_id`，保留指令 `open/alerted` 状态供物化重扫。
///
/// 已触发 / 已挂票 / 已结束的指令一律拒绝：编辑会撤掉旧单，可能截断已成交路径。
pub fn update_trigger(
    conn: &rusqlite::Connection,
    instr_id: i64,
    rule: &Value,
) -> Result<(), String> {
    let incoming = rule
        .as_object()
        .ok_or_else(|| "触发条件格式无效".to_string())?;
    let (plan_id, co_id, status, old_rule_json): (i64, String, String, String) = conn
        .query_row(
            "SELECT plan_id,COALESCE(co_id,''),status,COALESCE(alert_rule,'{}')
             FROM plan_instruction WHERE id=?1",
            [instr_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|_| "指令不存在".to_string())?;
    if status == "done" {
        return Err(TRIGGERED_EDIT_ERROR.to_string());
    }
    if !co_id.is_empty() {
        let linked: Option<(String, String)> = conn
            .query_row(
                "SELECT status,COALESCE(ticket_id,'') FROM conditional_order WHERE co_id=?1",
                [&co_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        if let Some((co_status, ticket_id)) = linked {
            if !ticket_id.is_empty()
                || matches!(co_status.as_str(), "triggered" | "submitted" | "done")
            {
                return Err(TRIGGERED_EDIT_ERROR.to_string());
            }
        }
    }

    // 只合并允许键（spec §三）：null 表示清除该条件，未知键原样忽略。
    let mut merged: serde_json::Map<String, Value> = serde_json::from_str::<Value>(&old_rule_json)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    for (k, v) in incoming {
        if !EDITABLE_RULE_KEYS.contains(&k.as_str()) {
            continue;
        }
        if v.is_null() {
            merged.remove(k);
        } else {
            merged.insert(k.clone(), v.clone());
        }
    }
    for key in NUMERIC_RULE_KEYS {
        if let Some(v) = merged.get(key) {
            if !v.is_number() {
                return Err(format!("触发条件 {key} 须为数字"));
            }
        }
    }
    let side_norm = merged
        .get("side")
        .map(|v| v.as_str().unwrap_or("").trim().to_ascii_uppercase());
    if let Some(up) = side_norm {
        if up != "BUY" && up != "SELL" {
            return Err("方向只能是 BUY 或 SELL".to_string());
        }
        merged.insert("side".to_string(), Value::String(up));
    }
    if let Some(v) = merged.get("vol") {
        let lot = as_lot_vol(v).ok_or_else(|| "委托数量须为 100 股整数倍".to_string())?;
        merged.insert("vol".to_string(), Value::from(lot));
    }
    if let Some(v) = merged.get("autoConfirm") {
        if !v.is_boolean() {
            return Err("模拟自动执行开关须为布尔值".to_string());
        }
    }
    let merged = Value::Object(merged);
    if leaves_from_alert_rule(&merged).is_empty() {
        return Err("至少设置一个触发条件".to_string());
    }

    // 取消旧单 / 清关联 / 写规则 / 立即重建放进同一事务：任一步失败都回滚，
    // 避免「旧单已撤、新规则没写」的半成品状态。
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("开启触发条件编辑事务失败: {e}"))?;
    if !co_id.is_empty() {
        tx.execute(
            "UPDATE conditional_order SET status='cancelled',updated_at=?1
             WHERE co_id=?2 AND status='active'",
            rusqlite::params![now_millis(), co_id],
        )
        .map_err(|e| format!("取消旧条件单失败: {e}"))?;
    }
    let rule_json =
        serde_json::to_string(&merged).map_err(|e| format!("序列化触发条件失败: {e}"))?;
    tx.execute(
        "UPDATE plan_instruction SET alert_rule=?1,co_id='',trigger_json='',synced_at=0
         WHERE id=?2",
        rusqlite::params![rule_json, instr_id],
    )
    .map_err(|e| format!("保存触发条件失败: {e}"))?;
    // materialize_plan 自带「今天 + confirmed」门禁：非计划日保存只更新规则，
    // 等计划日当天由物化循环建单。
    // 智驾计划由 autoexec 执行同一批指令，再物化条件单会双份触发——与
    // `materialize_today` 的 `model <> 'pilot-auto'` 结构性排除保持一致。
    let pilot_owned: bool = tx
        .query_row(
            "SELECT COALESCE(model,'') = 'pilot-auto' FROM plan WHERE id=?1",
            [plan_id],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if !pilot_owned {
        materialize_plan(&tx, plan_id)?;
    }
    tx.commit()
        .map_err(|e| format!("提交触发条件编辑事务失败: {e}"))?;
    Ok(())
}

/// 扫描所有「今天 + confirmed」的计划并物化（幂等）。供定时循环与读取路径复用。
///
/// 与 `materialize_plan` 的区别：后者只在拿到具体 plan_id 时做单计划物化，
/// 调用方需自己先按日期筛计划；本函数负责「今天到底有哪些计划该建单」这一层，
/// 让后台循环无需知道计划如何产生。非计划日 / 无确认计划时返回全零汇总。
///
/// 智驾计划按 `plan.model='pilot-auto'` 结构性排除：智驾由 autoexec 执行同一批
/// 指令，若再物化条件单会双份触发。不能靠 `pilot_config.mode` 判定——崩溃 / 重启
/// 后 mode 可能残留 running/paused 而排程器并未在跑，会把物化整天卡死。
pub fn materialize_today(conn: &rusqlite::Connection) -> Result<MaterializeSummary, String> {
    let today = crate::broker::conditional::today_dashed();
    let ids: Vec<i64> = {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM plan WHERE plan_date=?1 AND status='confirmed'
                 AND COALESCE(model,'') <> 'pilot-auto'",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&today], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|x| x.ok()).collect()
    };
    let mut total = MaterializeSummary::default();
    for id in ids {
        match materialize_plan(conn, id) {
            Ok(s) => {
                total.created += s.created;
                total.skipped += s.skipped;
                total.failed += s.failed;
            }
            // 单计划失败不影响其余计划；记日志便于排查（扫描层不返回 Err）。
            Err(e) => log::warn!("materialize plan {id} failed: {e}"),
        }
    }
    Ok(total)
}

/// 后台定时物化：每 30s 一次，覆盖「应用跨午夜一直开着」的场景。
///
/// 放在后台循环而非挂载路径：驾驶舱不 mount 时计划仍会在计划日当天建单；
/// 跨午夜后 `materialize_plan` 的日期门禁自动从「非计划日 no-op」切到「今天物化」。
pub async fn run_materialize_loop(app: tauri::AppHandle) {
    use tauri::Manager;
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        // 急停期间暂停物化：即使库里还残留 open/alerted 指令，也不得在 kill switch
        // 之后重建条件单（急停路径已用 cancel_all_dropping 放弃关联指令，这里是第二道闸）。
        if app
            .state::<crate::broker::BrokerManager>()
            .kill_switch
            .load(Ordering::SeqCst)
        {
            continue;
        }
        let dir = app.state::<crate::ai::AiState>().dir();
        if let Ok(conn) = crate::ai::maindb::open_readwrite(&dir) {
            if let Err(e) = materialize_today(&conn) {
                log::warn!("materialize_today failed: {e}");
            }
        }
    }
}

static MATERIALIZE_LOOP_STARTED: AtomicBool = AtomicBool::new(false);

/// 幂等启动后台物化循环（重复调用只 spawn 一次）。
pub fn ensure_materialize_loop(app: &tauri::AppHandle) {
    if MATERIALIZE_LOOP_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run_materialize_loop(handle).await;
    });
    log::info!("计划定时物化循环已启动（30s）");
}

/// 作战台行内编辑触发条件（P1-b）：保存后取消旧条件单，今日已确认计划立即重建。
///
/// 返回该指令所属计划的最新 `{ plan, instructions }`，前端保存后一次刷新即可；
/// 计划 JSON 与 `workflow_instructions` 同一口径（含原始 instructions 字段）。
#[tauri::command]
pub async fn workflow_instruction_trigger_set(
    ai: tauri::State<'_, crate::ai::AiState>,
    instr_id: i64,
    rule: Value,
) -> Result<Value, String> {
    let dir = ai.dir();
    let conn = crate::ai::maindb::open_readwrite(&dir)?;
    update_trigger(&conn, instr_id, &rule)?;
    let plan_id: i64 = conn
        .query_row(
            "SELECT plan_id FROM plan_instruction WHERE id=?1",
            [instr_id],
            |r| r.get(0),
        )
        .map_err(|_| "指令不存在".to_string())?;
    let plan = crate::ai::plan::plan_to_json(&conn, plan_id)?;
    let instructions = list_instructions(&conn, plan_id)?;
    Ok(serde_json::json!({ "plan": plan, "instructions": instructions }))
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

    /// 列表查询需要的三张关联表：条件单 → 信号票 → 委托。
    fn conn_with_instruction_links() -> rusqlite::Connection {
        let conn = conn_with_tables();
        conn.execute_batch(
            "CREATE TABLE signal_ticket (id INTEGER PRIMARY KEY AUTOINCREMENT,
                 sig_id TEXT NOT NULL UNIQUE, status TEXT DEFAULT 'pending',
                 price REAL DEFAULT 0, vol INTEGER DEFAULT 0);
             CREATE TABLE broker_order (sig_id TEXT NOT NULL UNIQUE, status TEXT DEFAULT 'submitted',
                 filled_vol INTEGER DEFAULT 0, filled_avg_price REAL DEFAULT 0.0);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn list_instructions_derives_state_from_linked_orders() {
        let conn = conn_with_instruction_links();
        insert_plan(&conn, 1, &crate::broker::conditional::today_dashed());
        insert_plan(&conn, 2, "2999-01-01");
        conn.execute_batch(
            "INSERT INTO plan_instruction(id,plan_id,tier,code,name,condition,action,position_hint,alert_rule,status,sort,co_id,trigger_json)
             VALUES(1,1,'candidate','600519','贵州茅台','战法：龙头共振','备选待确认','不设仓位','{}','alerted',0,'CO1','[{\"field\":\"price\",\"op\":\"gte\",\"value\":1680}]');
             INSERT INTO plan_instruction(id,plan_id,tier,code,name,condition,action,position_hint,alert_rule,status,sort,co_id,trigger_json)
             VALUES(2,1,'trigger','300750','宁德时代','涨幅触发','买入','','{}','alerted',1,'CO2','[{\"field\":\"pct\",\"op\":\"gte\",\"value\":3}]');
             INSERT INTO plan_instruction(id,plan_id,tier,code,name,condition,action,position_hint,alert_rule,status,sort,co_id,trigger_json)
             VALUES(3,1,'watch','000001','平安银行','仅观察','','','{\"autoConfirm\":false,\"side\":\"SELL\",\"vol\":300}','open',2,'','');
             INSERT INTO plan_instruction(id,plan_id,tier,code,name,condition,action,position_hint,alert_rule,status,sort,co_id,trigger_json)
             VALUES(4,1,'candidate','000002','万科','止损','','','{}','alerted',3,'CO4','');
             INSERT INTO plan_instruction(id,plan_id,tier,code,name,condition,action,position_hint,alert_rule,status,sort,co_id,trigger_json)
             VALUES(5,2,'candidate','600036','招商银行','其它计划','','','{}','open',0,'','');
             INSERT INTO conditional_order(co_id,trade_date,code,side,trigger_json,vol,status,ticket_id,triggered_at,created_at)
             VALUES('CO1','2026-10-19','600519','BUY','[]',100,'active','',0,1);
             INSERT INTO conditional_order(co_id,trade_date,code,side,trigger_json,vol,status,ticket_id,triggered_at,created_at)
             VALUES('CO2','2026-10-19','300750','BUY','[]',100,'triggered','T2',1750000000000,1);
             INSERT INTO conditional_order(co_id,trade_date,code,side,trigger_json,vol,status,ticket_id,triggered_at,created_at)
             VALUES('CO4','2026-10-19','000002','BUY','[]',100,'cancelled','',0,1);
             INSERT INTO signal_ticket(sig_id,status,price,vol) VALUES('T2','confirmed',12.3,200);
             INSERT INTO broker_order(sig_id,status,filled_vol,filled_avg_price) VALUES('T2','filled',200,12.3);",
        )
        .unwrap();

        let rows = list_instructions(&conn, 1).unwrap();
        assert_eq!(rows.len(), 4, "只返回目标计划的指令，且按 sort 排序");
        assert_eq!(rows[0]["id"].as_i64(), Some(1));
        assert_eq!(rows[0]["state"], "pending", "条件单 active → 待触发");
        assert_eq!(rows[0]["coId"], "CO1");
        assert_eq!(
            rows[0]["triggerJson"],
            "[{\"field\":\"price\",\"op\":\"gte\",\"value\":1680}]"
        );
        assert_eq!(rows[0]["positionHint"], "不设仓位");
        // P1-b 新增字段：未挂票时回退 alert_rule 默认值
        assert_eq!(rows[0]["ticketId"].as_i64(), Some(0));
        assert_eq!(rows[0]["ticketStatus"], "");
        assert_eq!(rows[0]["side"], "BUY");
        assert_eq!(rows[0]["vol"].as_i64(), Some(100), "数量取条件单");
        assert_eq!(rows[0]["price"].as_f64(), Some(0.0), "未触发无票面价");
        assert_eq!(rows[0]["autoConfirm"].as_bool(), Some(true), "缺省自动确认");
        assert_eq!(
            rows[1]["state"], "filled",
            "票 confirmed + 委托 filled → 已成交"
        );
        assert_eq!(rows[1]["ticketId"].as_i64(), Some(1), "ticketId 为信号票主键");
        assert_eq!(rows[1]["ticketStatus"], "confirmed");
        assert_eq!(rows[1]["price"].as_f64(), Some(12.3), "确认弹窗取票面价");
        assert_eq!(rows[1]["filledVol"].as_i64(), Some(200));
        assert_eq!(rows[1]["filledAvgPrice"].as_f64(), Some(12.3));
        assert_eq!(rows[1]["triggeredAt"].as_i64(), Some(1_750_000_000_000));
        assert_eq!(rows[2]["state"], "watch", "无 co_id → 仅观察");
        assert_eq!(rows[2]["side"], "SELL", "未物化时方向取 alert_rule");
        assert_eq!(rows[2]["vol"].as_i64(), Some(300));
        assert_eq!(
            rows[2]["autoConfirm"].as_bool(),
            Some(false),
            "逐条关闭模拟自动"
        );
        assert_eq!(rows[3]["state"], "cancelled", "条件单 cancelled → 已取消");
    }

    #[test]
    fn list_instructions_legacy_schema_degrades_to_watch() {
        // 旧库未迁移（缺 co_id / trigger_json）：降级为只读计划字段，不能整页报错。
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE plan_instruction(id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER,
                tier TEXT, code TEXT, name TEXT, condition TEXT, action TEXT, position_hint TEXT,
                sort INTEGER);
             INSERT INTO plan_instruction(plan_id,tier,code,name,condition,action,position_hint,sort)
             VALUES(7,'candidate','600519','贵州茅台','战法：龙头','备选','不设仓位',0);",
        )
        .unwrap();
        assert!(!plan_instruction_columns_exist(&conn));
        let rows = list_instructions(&conn, 7).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["state"], "watch");
        assert_eq!(rows[0]["coId"], "");
        assert_eq!(rows[0]["triggerJson"], "");
        assert_eq!(rows[0]["triggeredAt"].as_i64(), Some(0));
        assert_eq!(rows[0]["filledVol"].as_i64(), Some(0));
        assert_eq!(rows[0]["filledAvgPrice"].as_f64(), Some(0.0));
    }

    fn conn_with_tables() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::broker::conditional::CREATE_SQL)
            .unwrap();
        // v62：与生产迁移一致的 `plan:%` active 备注唯一索引（重复物化由它兜底，
        // 已取消 / 过期的旧单不在索引内，允许重开后重建同 note 的新单）。
        conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_conditional_plan_note
             ON conditional_order(note) WHERE note LIKE 'plan:%' AND status='active';",
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TABLE plan(id INTEGER PRIMARY KEY, plan_date TEXT, model TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'draft');
             CREATE TABLE plan_instruction(
                id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER, tier TEXT, code TEXT,
                name TEXT, theme TEXT, condition TEXT, action TEXT, position_hint TEXT,
                alert_rule TEXT, status TEXT, sort INTEGER,
                co_id TEXT DEFAULT '', trigger_json TEXT DEFAULT '', synced_at INTEGER DEFAULT 0);",
        )
        .unwrap();
        conn
    }

    /// 既有物化用例默认插入已确认计划；状态门禁用例用 `insert_plan_with_status`。
    fn insert_plan(conn: &rusqlite::Connection, id: i64, plan_date: &str) {
        insert_plan_with_status(conn, id, plan_date, "confirmed");
    }

    fn insert_plan_with_status(
        conn: &rusqlite::Connection,
        id: i64,
        plan_date: &str,
        status: &str,
    ) {
        conn.execute(
            "INSERT INTO plan(id,plan_date,status) VALUES(?1,?2,?3)",
            rusqlite::params![id, plan_date, status],
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
    fn materialize_backfills_existing_co_on_unique_note_conflict() {
        let conn = conn_with_tables();
        insert_plan(&conn, 1, &crate::broker::conditional::today_dashed());
        conn.execute(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台','{\"upPrice\":1700,\"vol\":200}','open',0)",
            [],
        )
        .unwrap();
        // 模拟「条件单已落库、指令 co_id 回写失败」（上轮写库失败或并发实例先建）：
        // v62 唯一索引让本轮重复插入必然失败，此时必须按 note 取回并回填。
        conn.execute(
            "INSERT INTO conditional_order(co_id,trade_date,code,side,trigger_json,vol,status,note,created_at,updated_at)
             VALUES('CO_existing','2026-10-19','600519','BUY','[]',200,'active','plan:1:1',1,1)",
            [],
        )
        .unwrap();
        let s = materialize_plan(&conn, 1).unwrap();
        assert_eq!(s.created, 0);
        assert_eq!(s.skipped, 1, "唯一冲突按已存在处理，计 skipped");
        assert_eq!(s.failed, 0);
        assert_eq!(co_count(&conn), 1, "不得重复建单");
        assert_eq!(
            instruction_co_id(&conn, 1),
            "CO_existing",
            "必须把已有条件单回填到指令"
        );
        let (trigger_json, synced_at): (String, i64) = conn
            .query_row(
                "SELECT trigger_json,synced_at FROM plan_instruction WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(
            trigger_json.contains("\"field\":\"price\""),
            "回填时应刷新触发条件: {trigger_json}"
        );
        assert!(synced_at > 0, "回填应刷新 synced_at");
    }

    #[test]
    fn reopen_dropped_instruction_rematerializes_new_conditional_order() {
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
        let old_co = instruction_co_id(&conn, 1);
        assert!(!old_co.is_empty());

        // 用户丢弃：plan::update_instruction 的真实路径是先取消旧条件单，再落 dropped。
        conn.execute(
            "UPDATE conditional_order SET status='cancelled' WHERE co_id=?1",
            [&old_co],
        )
        .unwrap();
        conn.execute(
            "UPDATE plan_instruction SET status='dropped' WHERE id=1",
            [],
        )
        .unwrap();
        assert_eq!(
            materialize_plan(&conn, 1).unwrap().created,
            0,
            "dropped 指令不得物化"
        );

        // 重开：旧 co_id 指向已取消的死单，必须重新建单，不能被旧单挡住。
        conn.execute("UPDATE plan_instruction SET status='open' WHERE id=1", [])
            .unwrap();
        let second = materialize_plan(&conn, 1).unwrap();
        assert_eq!(second.created, 1, "重开应重新物化一张条件单");
        let new_co = instruction_co_id(&conn, 1);
        assert!(!new_co.is_empty());
        assert_ne!(new_co, old_co, "co_id 必须指向新条件单");
        let old_status: String = conn
            .query_row(
                "SELECT status FROM conditional_order WHERE co_id=?1",
                [&old_co],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old_status, "cancelled", "旧条件单保持取消");
        let new_status: String = conn
            .query_row(
                "SELECT status FROM conditional_order WHERE co_id=?1",
                [&new_co],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(new_status, "active", "新条件单应 active");
        assert_eq!(co_count(&conn), 2, "新旧两张单并存，旧单保留审计痕迹");
        let active: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conditional_order WHERE status='active'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(active, 1, "同一 note 只允许一张 active 单");
    }

    #[test]
    fn manual_cancel_drops_instruction_and_blocks_rematerialize() {
        let conn = conn_with_tables();
        insert_plan(&conn, 1, &crate::broker::conditional::today_dashed());
        conn.execute(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台','{\"upPrice\":1700,\"vol\":200}','open',0)",
            [],
        )
        .unwrap();
        assert_eq!(materialize_plan(&conn, 1).unwrap().created, 1);
        let co_row_id: i64 = conn
            .query_row(
                "SELECT id FROM conditional_order WHERE note='plan:1:1'",
                [],
                |r| r.get(0),
            )
            .unwrap();

        // 用户在 ConditionalOrders 面板手动撤销（co_cancel 走同一 cancel 路径）。
        crate::broker::conditional::cancel(&conn, co_row_id).unwrap();

        let (status, co_id): (String, String) = conn
            .query_row(
                "SELECT status,co_id FROM plan_instruction WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "dropped", "撤销条件单必须同时放弃指令");
        assert!(!co_id.is_empty(), "保留 co_id 便于审计与重开");

        // 30s 物化循环：dropped 不在扫描范围，不得重建同一 note 的条件单。
        let again = materialize_plan(&conn, 1).unwrap();
        assert_eq!(again.created, 0, "手动撤销后不得被物化重建");
        assert_eq!(co_count(&conn), 1, "不得新增条件单");
    }

    #[test]
    fn cancel_all_dropping_releases_linked_instructions() {
        let conn = conn_with_tables();
        insert_plan(&conn, 1, &crate::broker::conditional::today_dashed());
        conn.execute(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台','{\"upPrice\":1700,\"vol\":200}','open',0)",
            [],
        )
        .unwrap();
        assert_eq!(materialize_plan(&conn, 1).unwrap().created, 1);

        // 急停 / 条件单面板「全部撤销」：撤销 CO 的同时放弃计划指令。
        let n = crate::broker::conditional::cancel_all_dropping(&conn).unwrap();
        assert_eq!(n, 1);
        let status: String = conn
            .query_row("SELECT status FROM plan_instruction WHERE id=1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(status, "dropped");
        assert_eq!(
            materialize_plan(&conn, 1).unwrap().created,
            0,
            "批量撤销后不得被物化重建"
        );

        // 回归：急停后 30s 循环（materialize_today）也不得用同一 note 重建 active 条件单。
        let again = materialize_today(&conn).unwrap();
        assert_eq!(again.created, 0, "急停后 30s 物化循环不得重建条件单");
        assert_eq!(co_count(&conn), 1, "不得新增条件单");
        let active: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conditional_order WHERE status='active'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(active, 0, "急停后不得残留或新建 active 条件单");
    }

    #[test]
    fn materialize_today_skips_pilot_owned_plan() {
        let conn = conn_with_tables();
        let today = crate::broker::conditional::today_dashed();
        insert_plan(&conn, 1, &today);
        insert_plan(&conn, 2, &today);
        conn.execute_batch(
            "UPDATE plan SET model='pilot-auto' WHERE id=1;
             INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台','{\"upPrice\":1700,\"vol\":200}','open',0);
             INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(2,'candidate','000001','平安','{\"upPrice\":10}','open',0);",
        )
        .unwrap();

        // 智驾计划按 plan.model 结构性排除：智驾由 autoexec 执行，物化会双份触发。
        let s = materialize_today(&conn).unwrap();
        assert_eq!(s.created, 1, "只物化非智驾计划");
        assert_eq!(co_count(&conn), 1);
        assert!(
            instruction_co_id(&conn, 1).is_empty(),
            "pilot-auto 计划不得物化"
        );
        assert!(
            !instruction_co_id(&conn, 2).is_empty(),
            "普通今日计划仍应物化"
        );
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
    fn materialize_requires_confirmed_plan() {
        let conn = conn_with_tables();
        let today = crate::broker::conditional::today_dashed();
        // 计划日期是今天，但仍是草稿：用户未复核确认，不得自动建单。
        insert_plan_with_status(&conn, 1, &today, "draft");
        conn.execute(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台','{\"upPrice\":1700,\"vol\":200}','open',0)",
            [],
        )
        .unwrap();
        let s = materialize_plan(&conn, 1).unwrap();
        assert_eq!(s.created, 0);
        assert_eq!(s.skipped, 0, "未确认计划应门禁直接返回，不逐条扫描");
        assert_eq!(co_count(&conn), 0);
        assert!(instruction_co_id(&conn, 1).is_empty());
    }

    #[test]
    fn materialize_skips_dropped_instruction() {
        let conn = conn_with_tables();
        insert_plan(&conn, 1, &crate::broker::conditional::today_dashed());
        // dropped（用户丢弃）/ done（已完成）不得物化；alerted（已确认转预警）仍需建单。
        conn.execute_batch(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台','{\"upPrice\":1700}','dropped',0);
             INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','000001','平安','{\"upPrice\":10}','done',1);
             INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','000002','万科','{\"upPrice\":8}','alerted',2);",
        )
        .unwrap();
        let s = materialize_plan(&conn, 1).unwrap();
        assert_eq!(s.created, 1);
        assert_eq!(s.skipped, 0, "状态过滤在查询层，丢弃/完成不计 skipped");
        assert_eq!(co_count(&conn), 1);
        assert!(instruction_co_id(&conn, 1).is_empty());
        assert!(instruction_co_id(&conn, 2).is_empty());
        assert!(
            !instruction_co_id(&conn, 3).is_empty(),
            "已确认转预警（alerted）的指令仍应物化"
        );
    }

    #[test]
    fn materialize_ignores_zero_filters() {
        let conn = conn_with_tables();
        insert_plan(&conn, 1, &crate::broker::conditional::today_dashed());
        conn.execute(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台',
                '{\"upPct\":5,\"minAmount\":0,\"minVolumeRatio\":0,\"minTurnover\":0,\"riseSpeed\":0,\"downSpeed\":0}',
                'open',0)",
            [],
        )
        .unwrap();
        let s = materialize_plan(&conn, 1).unwrap();
        assert_eq!(s.created, 1);
        let co_id = instruction_co_id(&conn, 1);
        assert!(!co_id.is_empty());
        let trigger: String = conn
            .query_row(
                "SELECT trigger_json FROM conditional_order WHERE co_id=?1",
                [&co_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(trigger.contains("\"field\":\"pct\""), "{trigger}");
        for field in [
            "amount",
            "volumeRatio",
            "turnover",
            "riseSpeed",
            "downSpeed",
        ] {
            assert!(
                !trigger.contains(&format!("\"field\":\"{field}\"")),
                "零值过滤字段 {field} 不应出叶: {trigger}"
            );
        }
        // 叶子层：只保留涨幅方向叶，0 值过滤字段一律视为未设置。
        let leaves = leaves_from_alert_rule(&json!({"upPct":5,"minAmount":0,"riseSpeed":0}));
        assert_eq!(leaves.len(), 1);
        assert_eq!(leaves[0].field, "pct");
        assert_eq!(leaves[0].op, "gte");
        assert_eq!(leaves[0].value, 5.0);
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

    #[test]
    fn materialize_today_only_today_confirmed_and_idempotent() {
        let conn = conn_with_tables();
        let today = crate::broker::conditional::today_dashed();
        insert_plan(&conn, 1, &today); // 今天 + confirmed → 应物化
        insert_plan_with_status(&conn, 2, &today, "draft"); // 今天草稿 → 不物化
        insert_plan(&conn, 3, "2999-01-01"); // 非今天（未来）+ confirmed → 不物化
        conn.execute_batch(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台','{\"upPrice\":1700}','open',0);
             INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(2,'candidate','000001','平安','{\"upPrice\":10}','open',0);
             INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(3,'candidate','000002','万科','{\"upPrice\":8}','open',0);",
        )
        .unwrap();

        let first = materialize_today(&conn).unwrap();
        assert_eq!(first.created, 1, "只应物化今天且已确认的计划");
        assert_eq!(first.failed, 0);
        assert_eq!(co_count(&conn), 1);
        assert!(!instruction_co_id(&conn, 1).is_empty());
        assert!(instruction_co_id(&conn, 2).is_empty(), "草稿计划不得物化");
        assert!(instruction_co_id(&conn, 3).is_empty(), "非计划日不得物化");

        // 幂等：再扫一次不新建条件单，已物化指令计入 skipped。
        let second = materialize_today(&conn).unwrap();
        assert_eq!(second.created, 0);
        assert_eq!(second.failed, 0);
        assert_eq!(second.skipped, 1);
        assert_eq!(co_count(&conn), 1, "重复扫描不得重复建单");
    }

    #[test]
    fn update_trigger_rebuilds_conditional_order() {
        let conn = conn_with_instruction_links();
        insert_plan(&conn, 1, &crate::broker::conditional::today_dashed());
        conn.execute(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,condition,action,position_hint,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台','战法：龙头','备选','不设仓位',
                    '{\"upPrice\":1700,\"vol\":200,\"note\":\"保留\"}','open',0)",
            [],
        )
        .unwrap();
        assert_eq!(materialize_plan(&conn, 1).unwrap().created, 1);
        let old_co = instruction_co_id(&conn, 1);
        assert!(!old_co.is_empty());

        update_trigger(&conn, 1, &json!({"upPrice":1710,"side":"sell"})).unwrap();

        let new_co = instruction_co_id(&conn, 1);
        assert!(!new_co.is_empty(), "编辑后应重新物化条件单");
        assert_ne!(new_co, old_co, "co_id 必须指向新条件单");
        let old_status: String = conn
            .query_row(
                "SELECT status FROM conditional_order WHERE co_id=?1",
                [&old_co],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old_status, "cancelled", "旧条件单应取消而非保留");
        let (new_status, side, vol): (String, String, i64) = conn
            .query_row(
                "SELECT status,side,vol FROM conditional_order WHERE co_id=?1",
                [&new_co],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(new_status, "active", "新条件单应生效");
        assert_eq!(side, "SELL", "方向按编辑值归一后物化");
        assert_eq!(vol, 200, "未编辑的数量沿用原规则");
        assert_eq!(co_count(&conn), 2, "新旧两张单并存，旧单留审计痕迹");

        // 指令保持 open（不得像手动撤销那样置 dropped），规则只合并允许键。
        let (status, rule_json): (String, String) = conn
            .query_row(
                "SELECT status,alert_rule FROM plan_instruction WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "open", "编辑不得放弃指令");
        let rule: Value = serde_json::from_str(&rule_json).unwrap();
        assert_eq!(rule["upPrice"], 1710.0);
        assert_eq!(rule["side"], "SELL");
        assert_eq!(rule["vol"], 200);
        assert_eq!(rule["note"], "保留", "未知键原样保留");
        // 读取态回到「待触发」。
        let rows = list_instructions(&conn, 1).unwrap();
        assert_eq!(rows[0]["state"], "pending");
        assert_eq!(rows[0]["coId"].as_str(), Some(new_co.as_str()));
    }

    #[test]
    fn update_trigger_rejects_triggered_instruction() {
        let conn = conn_with_tables();
        insert_plan(&conn, 1, &crate::broker::conditional::today_dashed());
        conn.execute(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台','{\"upPrice\":1700,\"vol\":200}','open',0)",
            [],
        )
        .unwrap();
        assert_eq!(materialize_plan(&conn, 1).unwrap().created, 1);
        let co = instruction_co_id(&conn, 1);
        conn.execute(
            "UPDATE conditional_order SET status='triggered',ticket_id='T1' WHERE co_id=?1",
            [&co],
        )
        .unwrap();

        let err = update_trigger(&conn, 1, &json!({"upPrice":1800})).unwrap_err();
        assert!(err.contains(TRIGGERED_EDIT_ERROR), "实际: {err}");
        assert_eq!(instruction_co_id(&conn, 1), co, "不得清空或换绑 co_id");
        let rule_json: String = conn
            .query_row(
                "SELECT alert_rule FROM plan_instruction WHERE id=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            rule_json.contains("1700"),
            "被拒绝时不得写规则: {rule_json}"
        );
        assert_eq!(co_count(&conn), 1, "被拒绝时不得新建/取消条件单");

        // 只挂票、状态仍 active 同样拒绝。
        conn.execute(
            "UPDATE conditional_order SET status='active' WHERE co_id=?1",
            [&co],
        )
        .unwrap();
        let err = update_trigger(&conn, 1, &json!({"upPrice":1801})).unwrap_err();
        assert!(err.contains(TRIGGERED_EDIT_ERROR), "实际: {err}");

        // submitted 也属于已触发（票字段清空后仍拒绝）。
        conn.execute(
            "UPDATE conditional_order SET status='submitted',ticket_id='' WHERE co_id=?1",
            [&co],
        )
        .unwrap();
        let err = update_trigger(&conn, 1, &json!({"upPrice":1802})).unwrap_err();
        assert!(err.contains(TRIGGERED_EDIT_ERROR), "实际: {err}");
    }

    #[test]
    fn update_trigger_validation() {
        let conn = conn_with_tables();
        insert_plan(&conn, 1, &crate::broker::conditional::today_dashed());
        conn.execute_batch(
            "INSERT INTO plan_instruction(id,plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,1,'candidate','600519','贵州茅台','{\"upPrice\":1700}','open',0);
             INSERT INTO plan_instruction(id,plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(2,1,'candidate','000001','平安','{}','open',1);",
        )
        .unwrap();

        for (rule, want) in [
            (json!({}), "至少设置一个触发条件"),
            (
                json!({"note":"随手备注","unknown":1}),
                "至少设置一个触发条件",
            ),
            (json!({"upPrice":1710,"vol":150}), "100"),
            (json!({"upPrice":1710,"vol":0}), "100"),
            (json!({"upPrice":1710,"side":"HOLD"}), "BUY 或 SELL"),
            (json!({"upPrice":1710,"side":""}), "BUY 或 SELL"),
            (json!({"upPrice":1710,"autoConfirm":"yes"}), "布尔"),
            (json!({"upPrice":"1710"}), "数字"),
        ] {
            let err = update_trigger(&conn, 2, &rule).unwrap_err();
            assert!(err.contains(want), "{rule} -> {err}");
        }
        let rule_json: String = conn
            .query_row(
                "SELECT alert_rule FROM plan_instruction WHERE id=2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rule_json, "{}", "校验失败不得改动已有规则");
        assert_eq!(co_count(&conn), 0, "校验失败不得建单");

        // 只改数量（不重发触发键）也应合并且重建。
        update_trigger(&conn, 1, &json!({"vol":300})).unwrap();
        assert_eq!(co_count(&conn), 1);
        let vol: i64 = conn
            .query_row("SELECT vol FROM conditional_order", [], |r| r.get(0))
            .unwrap();
        assert_eq!(vol, 300, "数量修改上报");
        let rule_json: String = conn
            .query_row(
                "SELECT alert_rule FROM plan_instruction WHERE id=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            rule_json.contains("\"upPrice\":1700"),
            "未编辑的触发条件保留: {rule_json}"
        );
    }

    #[test]
    fn update_trigger_does_not_materialize_pilot_plan() {
        let conn = conn_with_tables();
        insert_plan(&conn, 1, &crate::broker::conditional::today_dashed());
        conn.execute("UPDATE plan SET model='pilot-auto' WHERE id=1", [])
            .unwrap();
        conn.execute(
            "INSERT INTO plan_instruction(plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,'candidate','600519','贵州茅台','{\"upPrice\":1700}','open',0)",
            [],
        )
        .unwrap();

        // 智驾计划由 autoexec 执行同一批指令，编辑不得物化条件单，否则双份触发。
        update_trigger(&conn, 1, &json!({"upPrice":1710})).unwrap();
        assert_eq!(co_count(&conn), 0, "pilot-auto 计划不得物化条件单");
        assert!(instruction_co_id(&conn, 1).is_empty());
    }

    #[test]
    fn materialize_auto_confirm_flag() {
        let conn = conn_with_tables();
        insert_plan(&conn, 1, &crate::broker::conditional::today_dashed());
        conn.execute_batch(
            "INSERT INTO plan_instruction(id,plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(1,1,'candidate','600519','贵州茅台','{\"upPrice\":1700,\"autoConfirm\":false}','open',0);
             INSERT INTO plan_instruction(id,plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(2,1,'candidate','000001','平安','{\"upPrice\":10,\"autoConfirm\":true}','open',1);
             INSERT INTO plan_instruction(id,plan_id,tier,code,name,alert_rule,status,sort)
             VALUES(3,1,'candidate','000002','万科','{\"upPrice\":8}','open',2);",
        )
        .unwrap();
        assert_eq!(materialize_plan(&conn, 1).unwrap().created, 3);
        let flag = |note: &str| -> i64 {
            conn.query_row(
                "SELECT auto_confirm FROM conditional_order WHERE note=?1",
                [note],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(flag("plan:1:1"), 0, "autoConfirm:false 应留人工确认");
        assert_eq!(flag("plan:1:2"), 1);
        assert_eq!(flag("plan:1:3"), 1, "缺省 autoConfirm=true");
    }
}
