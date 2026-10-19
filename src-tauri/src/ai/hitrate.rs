// P1-c 命中率：近 N 个有计划的交易日，统计作战卡指令的触发率 / 执行率 / 胜率。
//
// 口径（spec §四）：
// - 指令范围：`plan_instruction.tier IN ('candidate','trigger')`；
// - 触发：已关联条件单且状态 != 'active'，或已有确认/完成的信号票；
// - 执行：触发过的指令里，已有 confirmed/done 信号票或已有券商委托；
// - 胜率：`broker_order.status='filled'` 的成交按方向与**当前价**比较浮盈
//   （BUY 现价 > 成交均价，SELL 现价 < 成交均价），无成交样本时 winPct = null。
//
// 状态全部在读取时推导，不落库；行情只在命令调用时批量取一次，不轮询。
use crate::ai::maindb::open_readwrite;
use crate::ai::AiState;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use tauri::State;

/// 一条候选/触发指令的命中率输入行（左联条件单 → 信号票 → 券商委托后的扁平结果）。
#[derive(Debug, Clone)]
pub struct HitRow {
    pub code: String,
    /// 委托方向（优先 broker_order.side，缺失回退条件单方向）；只用于胜率判定。
    pub side: String,
    /// broker_order.status（无委托为空串）。
    pub order_status: String,
    /// broker_order.filled_avg_price（无成交为 0）。
    pub filled_avg_price: f64,
    /// 是否已有 confirmed/done 信号票（触发后确认过的票；pending 票不算执行）。
    pub has_ticket: bool,
    /// conditional_order.status（未物化 / 未关联为空串）。
    pub co_status: String,
}

/// 百分比：整数 0–100；分母为 0 返回 null（前端显示「样本不足」）。
fn pct(num: usize, den: usize) -> Value {
    if den == 0 {
        return Value::Null;
    }
    json!(((num as f64) * 100.0 / (den as f64)).round() as i64)
}

/// 纯计算：输入指令行 + 最新价，输出计数与百分比（不含 days / plans）。
///
/// 分母口径：触发率分母 = 全部指令；执行率分母 = 已触发指令；胜率分母 = 成交样本数。
pub fn compute(rows: &[HitRow], prices: &HashMap<String, f64>) -> Value {
    let mut triggered = 0usize;
    let mut executed = 0usize;
    let mut samples = 0usize;
    let mut wins = 0usize;

    for r in rows {
        // 条件单为空串表示未物化；"active" 表示还在等触发。
        let co_linked = !r.co_status.trim().is_empty();
        let is_triggered = (co_linked && r.co_status != "active") || r.has_ticket;
        if is_triggered {
            triggered += 1;
        }
        let has_order = !r.order_status.trim().is_empty();
        // 执行只统计已触发过的指令（真实数据中委托必然晚于触发，此处同时兜底脏数据）。
        if is_triggered && (r.has_ticket || has_order) {
            executed += 1;
        }
        if r.order_status == "filled" {
            samples += 1;
            // 行情失败 / 停牌（价格缺失或 <= 0）不计盈利；成交价缺失同样不计。
            let current = prices.get(&r.code).copied().filter(|p| *p > 0.0);
            if let (Some(cur), true) = (current, r.filled_avg_price > 0.0) {
                let sell = r.side.trim().eq_ignore_ascii_case("SELL");
                let win = if sell {
                    cur < r.filled_avg_price
                } else {
                    cur > r.filled_avg_price
                };
                if win {
                    wins += 1;
                }
            }
        }
    }

    json!({
        "instructions": rows.len(),
        "triggered": triggered,
        "triggeredPct": pct(triggered, rows.len()),
        "executed": executed,
        "executedPct": pct(executed, triggered),
        "wins": wins,
        "winPct": pct(wins, samples),
        "samples": samples,
    })
}

/// 最近 N 个有计划的交易日（`plan_date <= today`，降序）→ (计划数, 指令行)。
fn load_rows(c: &Connection, today: &str, days: i64) -> Result<(usize, Vec<HitRow>), String> {
    let plan_filter = "SELECT id FROM plan WHERE plan_date<=?1 ORDER BY plan_date DESC LIMIT ?2";
    let plans: i64 = c
        .query_row(
            &format!("SELECT COUNT(*) FROM ({plan_filter})"),
            params![today, days],
            |r| r.get(0),
        )
        .map_err(|e| format!("统计命中率计划失败: {e}"))?;
    let mut stmt = c
        .prepare(&format!(
            "SELECT i.code,
                    COALESCE(NULLIF(o.side,''), NULLIF(c.side,''), ''),
                    COALESCE(o.status,''),
                    COALESCE(o.filled_avg_price,0.0),
                    CASE WHEN EXISTS (
                        SELECT 1 FROM signal_ticket t
                        WHERE t.sig_id=c.ticket_id AND c.ticket_id<>''
                          AND t.status IN ('confirmed','done')
                    ) THEN 1 ELSE 0 END,
                    COALESCE(c.status,'')
             FROM plan_instruction i
             JOIN ({plan_filter}) p ON p.id=i.plan_id
             LEFT JOIN conditional_order c ON c.co_id=i.co_id AND i.co_id<>''
             LEFT JOIN broker_order o ON o.sig_id=c.ticket_id AND c.ticket_id<>''
             WHERE i.tier IN ('candidate','trigger')
             ORDER BY i.id"
        ))
        .map_err(|e| format!("查询命中率指令失败: {e}"))?;
    let rows = stmt
        .query_map(params![today, days], |r| {
            Ok(HitRow {
                code: r.get::<_, String>(0)?,
                side: r.get::<_, String>(1)?,
                order_status: r.get::<_, String>(2)?,
                filled_avg_price: r.get::<_, f64>(3)?,
                has_ticket: r.get::<_, i64>(4)? != 0,
                co_status: r.get::<_, String>(5)?,
            })
        })
        .map_err(|e| format!("读取命中率指令失败: {e}"))?;
    let out: Vec<HitRow> = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| format!("解析命中率指令失败: {e}"))?;
    Ok((plans.max(0) as usize, out))
}

/// 命中率命令：近 N 日（默认 20）触发率 / 执行率 / 胜率。
///
/// 只读本地库；成功后按成交标的一次性批量取当前价（失败只记日志，按无盈利处理）。
#[tauri::command]
pub async fn workflow_hit_rate(ai: State<'_, AiState>, days: Option<i64>) -> Result<Value, String> {
    let days = days.unwrap_or(20).clamp(1, 365);
    let dir = ai.dir();
    let today = crate::broker::conditional::today_dashed();
    let (plans, rows) = {
        let c = open_readwrite(&dir)?;
        // 旧库未迁移（缺 co_id）时无法左联条件单：按空样本返回，不阻断作战台。
        if crate::ai::instruction::plan_instruction_columns_exist(&c) {
            load_rows(&c, &today, days)?
        } else {
            (0, Vec::new())
        }
    };

    // 只有成交单需要现价；去重后按代码排序，保证请求稳定（也便于日志排查）。
    let codes: Vec<String> = rows
        .iter()
        .filter(|r| r.order_status == "filled" && r.filled_avg_price > 0.0)
        .map(|r| r.code.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut prices: HashMap<String, f64> = HashMap::new();
    if !codes.is_empty() {
        match crate::market::tencent::quotes(&codes).await {
            Ok(list) => {
                for q in list {
                    if q.price > 0.0 {
                        prices.insert(q.code, q.price);
                    }
                }
            }
            // 行情失败不整体报错：成交样本仍计数，但没有一条能判为盈利。
            Err(e) => log::warn!("[P1-c] 命中率取现价失败，按无盈利统计: {e}"),
        }
    }

    let mut out = compute(&rows, &prices);
    out["days"] = json!(days);
    out["plans"] = json!(plans);
    Ok(out)
}

// ============================ 单测 ============================

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        code: &str,
        side: &str,
        order_status: &str,
        filled_avg_price: f64,
        has_ticket: bool,
        co_status: &str,
    ) -> HitRow {
        HitRow {
            code: code.into(),
            side: side.into(),
            order_status: order_status.into(),
            filled_avg_price,
            has_ticket,
            co_status: co_status.into(),
        }
    }

    fn prices(items: &[(&str, f64)]) -> HashMap<String, f64> {
        items.iter().map(|(c, p)| ((*c).to_string(), *p)).collect()
    }

    /// 5 条指令：2 触发、1 执行、2 笔成交（1 盈 1 亏）。
    ///
    /// 最后一行的成交委托未关联条件单（脏数据兜底）：不计触发/执行，但仍是胜率样本。
    #[test]
    fn hit_rate_compute_five_rows() {
        let rows = vec![
            row("600001", "", "", 0.0, false, "active"),
            row("600002", "", "", 0.0, false, "active"),
            row("600003", "", "", 0.0, false, "cancelled"),
            row("600004", "BUY", "filled", 10.0, false, "triggered"),
            row("600005", "BUY", "filled", 10.0, false, ""),
        ];
        let p = prices(&[("600004", 11.0), ("600005", 9.0)]);
        let v = compute(&rows, &p);

        assert_eq!(v["instructions"], 5);
        assert_eq!(v["triggered"], 2);
        assert_eq!(v["triggeredPct"], 40);
        assert_eq!(v["executed"], 1);
        assert_eq!(v["executedPct"], 50);
        assert_eq!(v["samples"], 2);
        assert_eq!(v["wins"], 1);
        assert_eq!(v["winPct"], 50);
    }

    #[test]
    fn hit_rate_compute_no_samples_returns_null() {
        let v = compute(&[], &HashMap::new());
        assert_eq!(v["instructions"], 0);
        for key in ["triggeredPct", "executedPct", "winPct"] {
            assert!(v[key].is_null(), "{key} 无样本应为 null，实际 {}", v[key]);
        }
        assert_eq!(v["samples"], 0);

        // 有指令但一条都没触发：执行率 / 胜率分母为 0 → null；触发率 0% 是有效值。
        let rows = vec![
            row("600001", "", "", 0.0, false, "active"),
            row("600002", "", "", 0.0, false, "active"),
        ];
        let v = compute(&rows, &HashMap::new());
        assert_eq!(v["triggeredPct"], 0);
        assert!(v["executedPct"].is_null());
        assert!(v["winPct"].is_null());
    }

    #[test]
    fn hit_rate_compute_sell_direction() {
        // SELL：现价低于成交均价才算盈利（与 BUY 相反）。
        let rows = vec![
            row("600001", "SELL", "filled", 10.0, true, "triggered"),
            row("600002", "SELL", "filled", 10.0, true, "triggered"),
            // BUY 现价低于成交均价：亏。
            row("600003", "BUY", "filled", 10.0, true, "triggered"),
        ];
        let p = prices(&[("600001", 9.0), ("600002", 11.0), ("600003", 9.0)]);
        let v = compute(&rows, &p);
        assert_eq!(v["samples"], 3);
        assert_eq!(v["wins"], 1);
        assert_eq!(v["winPct"], 33);
        assert_eq!(v["triggeredPct"], 100);
        assert_eq!(v["executedPct"], 100);
    }

    #[test]
    fn hit_rate_compute_boundaries_and_missing_price() {
        // 全部盈利 → 100%；行情缺失不产生盈利，但样本仍计数。
        let rows = vec![
            row("600001", "BUY", "filled", 10.0, true, "triggered"),
            row("600002", "BUY", "filled", 10.0, true, "triggered"),
        ];
        let v = compute(&rows, &prices(&[("600001", 11.0), ("600002", 12.0)]));
        assert_eq!(v["winPct"], 100);
        assert_eq!(v["triggeredPct"], 100);

        let v = compute(&rows, &HashMap::new());
        assert_eq!(v["samples"], 2);
        assert_eq!(v["wins"], 0);
        assert_eq!(v["winPct"], 0);

        // 已确认票 = 执行；pending/未确认票（只有触发条件单）不算执行。
        let rows = vec![
            row("600001", "", "", 0.0, true, "triggered"),
            row("600002", "", "", 0.0, false, "triggered"),
        ];
        let v = compute(&rows, &HashMap::new());
        assert_eq!(v["triggered"], 2);
        assert_eq!(v["executed"], 1);
        assert_eq!(v["executedPct"], 50);
    }

    /// SQL 口径：只取 `plan_date <= today` 的最近 N 个计划、只取 candidate/trigger 指令，
    /// 左联条件单 → 信号票 → 委托；未来计划与 watch 指令不参与统计。
    #[test]
    fn hit_rate_load_rows_joins_and_filters() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE plan(id INTEGER PRIMARY KEY AUTOINCREMENT, plan_date TEXT NOT NULL);
             CREATE TABLE plan_instruction(
                 id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER,
                 tier TEXT, code TEXT, co_id TEXT);
             CREATE TABLE conditional_order(
                 id INTEGER PRIMARY KEY AUTOINCREMENT, co_id TEXT UNIQUE,
                 side TEXT, status TEXT, ticket_id TEXT);
             CREATE TABLE signal_ticket(
                 id INTEGER PRIMARY KEY AUTOINCREMENT, sig_id TEXT UNIQUE, status TEXT);
             CREATE TABLE broker_order(
                 id INTEGER PRIMARY KEY AUTOINCREMENT, sig_id TEXT UNIQUE,
                 side TEXT, status TEXT, filled_avg_price REAL);
             INSERT INTO plan(plan_date) VALUES('2026-10-16'),('2026-10-19'),('2026-10-20');
             INSERT INTO plan_instruction(plan_id,tier,code,co_id) VALUES
                 (1,'candidate','600001','C1'),
                 (1,'trigger','600002',''),
                 (1,'watch','600003','C3'),
                 (2,'candidate','600004','C4'),
                 (2,'candidate','600005',''),
                 (3,'candidate','600006','C6');
             INSERT INTO conditional_order(co_id,side,status,ticket_id) VALUES
                 ('C1','BUY','active',''),
                 ('C3','BUY','active',''),
                 ('C4','SELL','triggered','T1'),
                 ('C6','BUY','active','');
             INSERT INTO signal_ticket(sig_id,status) VALUES('T1','confirmed');
             INSERT INTO broker_order(sig_id,side,status,filled_avg_price)
                 VALUES('T1','SELL','filled',10.0);",
        )
        .unwrap();

        let (plans, rows) = load_rows(&c, "2026-10-19", 20).unwrap();
        assert_eq!(plans, 2, "只统计今天及以前的计划");
        let codes: Vec<&str> = rows.iter().map(|r| r.code.as_str()).collect();
        assert_eq!(
            codes,
            vec!["600001", "600002", "600004", "600005"],
            "watch 与未来计划应排除"
        );

        let filled = rows.iter().find(|r| r.code == "600004").unwrap();
        assert_eq!(filled.side, "SELL");
        assert_eq!(filled.order_status, "filled");
        assert_eq!(filled.filled_avg_price, 10.0);
        assert!(filled.has_ticket);
        assert_eq!(filled.co_status, "triggered");

        let active = rows.iter().find(|r| r.code == "600001").unwrap();
        assert!(!active.has_ticket);
        assert_eq!(active.co_status, "active");
        // 未物化指令：co_status 为空串（不能当成 "非 active" 误计触发）。
        let plain = rows.iter().find(|r| r.code == "600002").unwrap();
        assert_eq!(plain.co_status, "");

        // LIMIT 只取最近 1 个计划：较早计划的指令不再参与。
        let (plans, rows) = load_rows(&c, "2026-10-19", 1).unwrap();
        assert_eq!(plans, 1);
        assert_eq!(
            rows.iter().map(|r| r.code.as_str()).collect::<Vec<_>>(),
            vec!["600004", "600005"]
        );
    }
}
