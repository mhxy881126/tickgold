// v2.32 盯盘复盘报告数据包：在 ai::decision::build_pack 基础上补齐
// 当日成交、预警触发、AI 复盘全文与离线绩效快照。全部只读本地库，盘后秒回。
// 前端据此渲染 HTML / Markdown；本层不产出任何荐股措辞。
use crate::ai::decision::build_pack;
use crate::ai::maindb::open_readonly;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;

/// 构建报告数据包。date=None 时沿用 build_pack 的“最近交易日”推断。
pub fn build_report(data_dir: &Path, date: Option<&str>) -> Result<Value, String> {
    // 先取 build_pack（约 80% 聚合），同时确定实际使用的日期。
    let pack = build_pack(data_dir, date)?;
    let day = pack["date"].as_str().unwrap_or("").to_string();

    let c = open_readonly(data_dir)?;

    let orders = today_orders(&c, &day)?;
    let alerts = today_alert_events(&c, &day)?;
    let reviews = today_reviews(&c, &day)?;
    let performance = performance_snapshot(&c, &day)?;

    let mut out = pack;
    // 报告专有补充段。
    if let Some(obj) = out.as_object_mut() {
        obj.insert("todayOrders".into(), orders);
        obj.insert("todayAlertEvents".into(), alerts);
        obj.insert("aiReviews".into(), reviews);
        obj.insert("performance".into(), performance);
        obj.insert(
            "disclaimer".into(),
            json!("本报告仅为个人盯盘记录与数据复盘，不构成任何投资建议。"),
        );
    }
    Ok(out)
}

/// 当日成交流水（统一账本 paper_order）。
fn today_orders(c: &Connection, day: &str) -> Result<Value, String> {
    let mut stmt = c
        .prepare(
            "SELECT code,name,side,price,vol,amount,fee,status,sig_id,realized_pnl,created_at
             FROM paper_order WHERE trade_date=?1 ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([day], |r| {
            Ok(json!({
                "code": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "side": r.get::<_, String>(2)?,
                "price": r.get::<_, f64>(3)?,
                "vol": r.get::<_, i64>(4)?,
                "amount": r.get::<_, f64>(5)?,
                "fee": r.get::<_, f64>(6)?,
                "status": r.get::<_, String>(7)?,
                "sigId": r.get::<_, String>(8).unwrap_or_default(),
                "realizedPnl": r.get::<_, f64>(9).unwrap_or(0.0),
                "createdAt": r.get::<_, i64>(10)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut list = Vec::new();
    for r in rows {
        list.push(r.map_err(|e| e.to_string())?);
    }
    Ok(json!(list))
}

/// 当日预警触发记录（alert_event，前端写入）。
fn today_alert_events(c: &Connection, day: &str) -> Result<Value, String> {
    // triggered_at 为毫秒时间戳，按当日 00:00–24:00（北京时间）窗口过滤。
    let window = match day_window_ms(day) {
        Some(w) => w,
        None => return Ok(json!([])),
    };
    let mut stmt = c
        .prepare(
            "SELECT rule_id,code,name,kind,label,message,price,pct,tone,triggered_at
             FROM alert_event WHERE triggered_at>=?1 AND triggered_at<?2
             ORDER BY triggered_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![window.0, window.1], |r| {
            Ok(json!({
                "ruleId": r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                "code": r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                "name": r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                "kind": r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                "label": r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                "message": r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                "price": r.get::<_, Option<f64>>(6)?.unwrap_or(0.0),
                "pct": r.get::<_, Option<f64>>(7)?.unwrap_or(0.0),
                "tone": r.get::<_, Option<String>>(8)?.unwrap_or_default(),
                "triggeredAt": r.get::<_, Option<i64>>(9)?.unwrap_or(0),
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut list = Vec::new();
    for r in rows {
        list.push(r.map_err(|e| e.to_string())?);
    }
    Ok(json!(list))
}

/// 当日 AI 三层复盘全文（ai_review）。
fn today_reviews(c: &Connection, day: &str) -> Result<Value, String> {
    let mut stmt = c
        .prepare(
            "SELECT id,scope,subject,title,summary,content,model,created_at
             FROM ai_review WHERE trade_date=?1 ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([day], |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "scope": r.get::<_, String>(1)?,
                "subject": r.get::<_, String>(2)?,
                "title": r.get::<_, String>(3).unwrap_or_default(),
                "summary": r.get::<_, String>(4).unwrap_or_default(),
                "content": r.get::<_, String>(5)?,
                "model": r.get::<_, String>(6).unwrap_or_default(),
                "createdAt": r.get::<_, i64>(7)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut list = Vec::new();
    for r in rows {
        list.push(r.map_err(|e| e.to_string())?);
    }
    Ok(json!(list))
}

/// 离线绩效快照：账户、当日已实现盈亏与胜率、持仓成本（不依赖实时行情）。
fn performance_snapshot(c: &Connection, day: &str) -> Result<Value, String> {
    let account: Option<(f64, f64)> = c
        .query_row(
            "SELECT init_cash,cash FROM paper_account WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let (init_cash, cash) = account.unwrap_or((0.0, 0.0));

    // 当日卖出单：已实现盈亏合计 + 胜率（盈利笔数 / 卖出笔数）。
    let mut sell_stmt = c
        .prepare(
            "SELECT realized_pnl FROM paper_order
             WHERE trade_date=?1 AND side='sell'",
        )
        .map_err(|e| e.to_string())?;
    let pnls = sell_stmt
        .query_map([day], |r| r.get::<_, f64>(0))
        .map_err(|e| e.to_string())?;
    let (mut realized, mut wins, mut sells) = (0.0, 0i64, 0i64);
    for p in pnls {
        let v = p.map_err(|e| e.to_string())?;
        realized += v;
        sells += 1;
        if v > 0.0 {
            wins += 1;
        }
    }
    let win_rate = if sells > 0 {
        wins as f64 / sells as f64 * 100.0
    } else {
        0.0
    };

    // 持仓成本（无实时行情，按成本估值，明确标注）。
    let mut pos_stmt = c
        .prepare("SELECT code,name,vol,avail_vol,cost_amount FROM paper_position")
        .map_err(|e| e.to_string())?;
    let positions = pos_stmt
        .query_map([], |r| {
            Ok(json!({
                "code": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "vol": r.get::<_, i64>(2)?,
                "availVol": r.get::<_, i64>(3)?,
                "costAmount": r.get::<_, f64>(4)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut pos_list = Vec::new();
    let mut hold_cost = 0.0;
    for p in positions {
        let v = p.map_err(|e| e.to_string())?;
        hold_cost += v["costAmount"].as_f64().unwrap_or(0.0);
        pos_list.push(v);
    }

    Ok(json!({
        "initCash": init_cash,
        "cash": cash,
        "holdingCost": hold_cost,
        "costBasisEquity": cash + hold_cost, // 现金 + 持仓成本（未计浮动盈亏）
        "dayRealizedPnl": realized,
        "daySells": sells,
        "dayWins": wins,
        "dayWinRate": win_rate,
        "positions": pos_list,
        "valuationNote": "盘后离线口径：持仓按成本价估值，未包含当日未实现浮动盈亏；胜率按当日卖出单已实现盈亏计算。",
    }))
}

/// YYYYMMDD（北京时间）→ 当日 [00:00, 次日00:00) 的 Unix 毫秒窗口。
fn day_window_ms(day: &str) -> Option<(i64, i64)> {
    let y: i64 = day.get(0..4)?.parse().ok()?;
    let m: i64 = day.get(4..6)?.parse().ok()?;
    let d: i64 = day.get(6..8)?.parse().ok()?;
    // 自 1970-01-01 起的天数（ civil_from_days 的逆：days_from_civil，Howard Hinnant）。
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    // 北京(D)00:00 = UTC(D-1)16:00：UTC(D-1)00:00 = (days-1)*86400000，再 +16h。
    let start = (days - 1) * 86_400_000 + 16 * 3_600_000;
    Some((start, start + 86_400_000))
}

#[cfg(test)]
mod tests {
    use super::day_window_ms;

    #[test]
    fn window_covers_beijing_midnight() {
        // 2026-10-13 北京 00:00 = 2026-10-12 16:00 UTC。
        let (s, e) = day_window_ms("20261013").unwrap();
        assert_eq!(s % 86_400_000, 16 * 3_600_000);
        assert_eq!(e - s, 86_400_000);
    }
}
