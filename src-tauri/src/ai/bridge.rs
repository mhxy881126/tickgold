// 信号人工确认桥：双脑信号不自动下单，落 signal_ticket 待人工确认，
// 确认后生成下单指令（复制 / 导出 / 唤起券商软件），全程 signal_audit 审计。
// 边界：本模块只到「生成指令 + 唤起软件」，真实下单由人在券商软件内完成；不接券商交易接口。
use crate::ai::{maindb, now_millis};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::process::Command;
use tauri::{AppHandle, Emitter, State};

// ===== 信号输入 =====

pub struct SignalInput {
    pub code: String,
    pub name: String,
    pub side: String, // BUY / SELL
    pub source: String,
    pub model_version: String,
    pub strategy: String,
    pub confidence: f64,
    pub ref_price: f64,
    pub vol: i64,
    pub reason: String,
    pub trade_date: String,
}

// ===== 审计 / 去重 / 数量 =====

fn audit(conn: &Connection, sig_id: &str, action: &str, detail: &str, actor: &str) {
    let _ = conn.execute(
        "INSERT INTO signal_audit(sig_id,action,detail,actor,created_at)
         VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![sig_id, action, detail, actor, now_millis()],
    );
}

fn has_pending(conn: &Connection, code: &str, side: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM signal_ticket WHERE code=?1 AND side=?2 AND status='pending'",
        rusqlite::params![code, side],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

/// 建议买入数量：按预算向下取整到 100 股。
pub fn suggest_buy_vol(price: f64, budget: f64) -> i64 {
    if price <= 0.0 || budget <= 0.0 {
        return 0;
    }
    ((budget / (price * 100.0)).floor() * 100.0) as i64
}

/// 创建信号票（内含去重）。返回 Some(sig_id)；重复 / 非法价返回 None。
pub fn create_ticket(conn: &Connection, input: SignalInput) -> Option<String> {
    if has_pending(conn, &input.code, &input.side) || input.ref_price <= 0.0 {
        return None;
    }
    let now = now_millis();
    let sig_id = format!(
        "SG{}{:06}",
        input.trade_date.replace('-', ""),
        now.rem_euclid(1_000_000)
    );
    let amount = input.ref_price * input.vol as f64;
    let ok = conn
        .execute(
            "INSERT INTO signal_ticket
               (sig_id,trade_date,created_at,code,name,side,source,model_version,strategy,
                confidence,ref_price,price,vol,amount,reason,status,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'pending',?16)",
            rusqlite::params![
                sig_id, input.trade_date, now, input.code, input.name, input.side, input.source,
                input.model_version, input.strategy, input.confidence, input.ref_price,
                input.ref_price, input.vol, amount, input.reason, now
            ],
        )
        .is_ok();
    if !ok {
        return None;
    }
    audit(
        conn,
        &sig_id,
        "created",
        &format!(
            "{} {} 置信{:.0}% 参考{:.2}",
            input.source,
            input.side,
            input.confidence * 100.0,
            input.ref_price
        ),
        "brain",
    );
    Some(sig_id)
}

// ===== 下单指令模板 =====

pub fn build_order_text(
    side: &str,
    code: &str,
    name: &str,
    price: f64,
    vol: i64,
    broker: &str,
) -> String {
    build_order_text_tpl("", side, code, name, price, vol, broker)
}

/// 按自定义模板渲染指令；template 为空（或全空白）时回退内置默认格式。
/// 占位符：{side} 中文方向、{sideEn} 英文方向、{code}、{name}、{price} 两位小数、
/// {vol}、{amount} 整数元、{broker}、{date}；未识别占位符原样保留以便发现书写错误。
pub fn build_order_text_tpl(
    template: &str,
    side: &str,
    code: &str,
    name: &str,
    price: f64,
    vol: i64,
    broker: &str,
) -> String {
    let action_cn = if side == "SELL" { "卖出" } else { "买入" };
    let amount = price * vol as f64;
    if template.trim().is_empty() {
        format!(
            "{action_cn} {code} {name} 价格 {price:.2} 数量 {vol}（约 {amount:.0} 元） · {broker}"
        )
    } else {
        let price_s = format!("{price:.2}");
        let amount_s = format!("{amount:.0}");
        let vol_s = vol.to_string();
        let date_s = beijing_today_dashed();
        let mut out = template.to_string();
        for (k, v) in [
            ("{side}", action_cn), // action_cn 本身就是 &str
            ("{sideEn}", side),
            ("{code}", code),
            ("{name}", name),
            ("{price}", price_s.as_str()),
            ("{vol}", vol_s.as_str()),
            ("{amount}", amount_s.as_str()),
            ("{broker}", broker),
            ("{date}", date_s.as_str()),
        ] {
            out = out.replace(k, v);
        }
        out
    }
}

// ===== 列表 =====

pub fn list_tickets(conn: &Connection, status: Option<String>, limit: Option<i64>) -> Vec<Value> {
    let limit = limit.unwrap_or(200).clamp(1, 1000);
    let mut sql = String::from(
        "SELECT id,sig_id,trade_date,created_at,code,name,side,source,model_version,strategy,\
                confidence,ref_price,price,vol,amount,reason,status,action_kind,broker,\
                order_text,decided_by,decided_at FROM signal_ticket",
    );
    let sfilter: Option<String> =
        status.filter(|v| !v.is_empty() && v.to_lowercase() != "all");
    if sfilter.is_some() {
        sql.push_str(" WHERE status=?1");
    }
    sql.push_str(&format!(" ORDER BY id DESC LIMIT {limit}"));

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let mapped = stmt.query_map(rusqlite::params_from_iter(sfilter.iter()), |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "sigId": r.get::<_, String>(1)?,
            "tradeDate": r.get::<_, String>(2)?,
            "createdAt": r.get::<_, i64>(3)?,
            "code": r.get::<_, String>(4)?,
            "name": r.get::<_, String>(5)?,
            "side": r.get::<_, String>(6)?,
            "source": r.get::<_, String>(7)?,
            "modelVersion": r.get::<_, String>(8)?,
            "strategy": r.get::<_, String>(9)?,
            "confidence": r.get::<_, f64>(10).unwrap_or(0.0),
            "refPrice": r.get::<_, f64>(11).unwrap_or(0.0),
            "price": r.get::<_, f64>(12).unwrap_or(0.0),
            "vol": r.get::<_, i64>(13).unwrap_or(0),
            "amount": r.get::<_, f64>(14).unwrap_or(0.0),
            "reason": r.get::<_, String>(15).unwrap_or_default(),
            "status": r.get::<_, String>(16).unwrap_or_default(),
            "actionKind": r.get::<_, String>(17).unwrap_or_default(),
            "broker": r.get::<_, String>(18).unwrap_or_default(),
            "orderText": r.get::<_, String>(19).unwrap_or_default(),
            "decidedBy": r.get::<_, String>(20).unwrap_or_default(),
            "decidedAt": r.get::<_, i64>(21).unwrap_or(0),
        }))
    });
    match mapped {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

/// 写操作后把 WAL 回灌主库（PASSIVE 不阻塞），确保只读 / 外部连接立即可见最新状态。
/// 背景：signal_ticket 的写入在 checkpoint 前仅存在于 -wal，主库本体为空/为旧值，
/// SQLITE_OPEN_READ_ONLY 连接在 Windows 上可能读不到最新 WAL，导致确认后 UI 仍显示待确认。
fn checkpoint(conn: &Connection) {
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
}

// ===== 确认 =====

pub struct ConfirmOpts {
    pub price: Option<f64>,
    pub vol: Option<i64>,
    pub action_kind: Option<String>,
    pub broker: Option<String>,
    pub actor: Option<String>,
    pub order_template: Option<String>,
}

pub fn confirm(conn: &Connection, id: i64, opts: ConfirmOpts) -> Result<Value, String> {
    let (sig_id, code, name, side, ref_price, cur_vol) = conn
        .query_row(
            "SELECT sig_id,code,name,side,ref_price,vol FROM signal_ticket WHERE id=?1",
            rusqlite::params![id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, f64>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;

    let price = opts.price.filter(|p| *p > 0.0).unwrap_or(ref_price);
    let vol = opts.vol.filter(|v| *v > 0).unwrap_or(cur_vol);
    let action_kind = opts
        .action_kind
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "copy".to_string());
    let broker = opts
        .broker
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "同花顺".to_string());
    let actor = opts
        .actor
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "local".to_string());
    if vol <= 0 {
        return Err("数量无效，请先填写数量（100 的整数倍）".to_string());
    }
    let amount = price * vol as f64;
    let order_text = build_order_text_tpl(
        &opts.order_template.clone().unwrap_or_default(),
        &side, &code, &name, price, vol, &broker,
    );
    let now = now_millis();
    conn.execute(
        "UPDATE signal_ticket SET status='confirmed',price=?1,vol=?2,amount=?3,\
                action_kind=?4,broker=?5,order_text=?6,decided_by=?7,decided_at=?8,updated_at=?9 \
         WHERE id=?10",
        rusqlite::params![
            price, vol, amount, action_kind, broker, order_text, actor, now, now, id
        ],
    )
    .map_err(|e| e.to_string())?;
    audit(
        conn,
        &sig_id,
        "confirmed",
        &format!("{action_kind} {broker} {price:.2} x{vol}"),
        &actor,
    );
    Ok(json!({
        "id": id, "sigId": sig_id, "orderText": order_text,
        "price": price, "vol": vol, "amount": amount,
        "actionKind": action_kind, "broker": broker,
    }))
}

// ===== 驳回 / 完成 =====

fn load_sig(conn: &Connection, id: i64) -> Result<String, String> {
    conn.query_row(
        "SELECT sig_id FROM signal_ticket WHERE id=?1",
        rusqlite::params![id],
        |r| r.get::<_, String>(0),
    )
    .map_err(|e| e.to_string())
}

pub fn reject(conn: &Connection, id: i64, reason: &str, actor: &str) -> Result<(), String> {
    let sig_id = load_sig(conn, id)?;
    let now = now_millis();
    conn.execute(
        "UPDATE signal_ticket SET status='rejected',updated_at=?1 WHERE id=?2",
        rusqlite::params![now, id],
    )
    .map_err(|e| e.to_string())?;
    audit(conn, &sig_id, "rejected", reason, actor);
    Ok(())
}

pub fn mark_done(conn: &Connection, id: i64, actor: &str) -> Result<(), String> {
    let sig_id = load_sig(conn, id)?;
    let now = now_millis();
    conn.execute(
        "UPDATE signal_ticket SET status='done',updated_at=?1 WHERE id=?2",
        rusqlite::params![now, id],
    )
    .map_err(|e| e.to_string())?;
    audit(conn, &sig_id, "done", "人工已在券商软件完成下单", actor);
    Ok(())
}

// ===== 过期 =====

pub fn expire_stale(conn: &Connection, ttl_minutes: i64) -> Result<i64, String> {
    let ttl = ttl_minutes.max(1) as i64;
    let now = now_millis();
    let cutoff = now - ttl * 60 * 1000;

    let mut sigs: Vec<String> = Vec::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT sig_id FROM signal_ticket WHERE status='pending' AND created_at<?1")
    {
        if let Ok(rows) = stmt.query_map(rusqlite::params![cutoff], |r| r.get::<_, String>(0)) {
            for s in rows.flatten() {
                sigs.push(s);
            }
        }
    }
    let n = conn
        .execute(
            "UPDATE signal_ticket SET status='expired',updated_at=?1 \
             WHERE status='pending' AND created_at<?2",
            rusqlite::params![now, cutoff],
        )
        .map_err(|e| e.to_string())?;
    for s in &sigs {
        audit(conn, s, "expired", "超过有效期未确认", "system");
    }
    Ok(n as i64)
}

// ===== 唤起券商软件（不下单，仅唤起至前台）=====

pub fn launch_broker(path: &str) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("未配置券商软件路径".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new(path.trim())
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("启动失败: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path.trim())
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("启动失败: {e}"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Command::new(path.trim())
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("启动失败: {e}"))
    }
}

// ===== 北京今日日期（自包含，不依赖其他模块）=====

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

fn beijing_today_dashed() -> String {
    let days = (now_millis() / 1000 + 8 * 3600).div_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    format!("{y}-{m:02}-{d:02}")
}

// ===== 手动创建 =====

#[allow(clippy::too_many_arguments)]
pub fn create_manual(
    conn: &Connection,
    code: &str,
    name: &str,
    side: &str,
    price: f64,
    vol: i64,
    reason: &str,
    trade_date: &str,
) -> Result<String, String> {
    if price <= 0.0 || vol <= 0 {
        return Err("请先填写有效价格与数量".to_string());
    }
    create_ticket(
        conn,
        SignalInput {
            code: code.to_string(),
            name: name.to_string(),
            side: side.to_string(),
            source: "manual".to_string(),
            model_version: "manual".to_string(),
            strategy: "手动".to_string(),
            confidence: 1.0,
            ref_price: price,
            vol,
            reason: reason.to_string(),
            trade_date: trade_date.to_string(),
        },
    )
    .ok_or_else(|| "创建失败：可能已有相同方向的待确认信号".to_string())
}

// ===== Tauri 命令 =====

#[tauri::command]
pub fn signal_list(
    state: State<'_, crate::ai::AiState>,
    status: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<Value>, String> {
    let conn = maindb::open_readonly(&state.dir())?;
    Ok(list_tickets(&conn, status, limit))
}

#[tauri::command]
pub fn signal_confirm(
    state: State<'_, crate::ai::AiState>,
    app: AppHandle,
    id: i64,
    price: Option<f64>,
    vol: Option<i64>,
    action_kind: Option<String>,
    broker: Option<String>,
    actor: Option<String>,
    order_template: Option<String>,
) -> Result<Value, String> {
    let conn = maindb::open_readwrite(&state.dir())?;
    let res = confirm(
        &conn,
        id,
        ConfirmOpts {
            price,
            vol,
            action_kind,
            broker,
            actor,
            order_template,
        },
    )?;
    checkpoint(&conn);
    let _ = app.emit("signal:updated", json!({ "id": id, "status": "confirmed" }));
    Ok(res)
}

#[tauri::command]
pub fn signal_reject(
    state: State<'_, crate::ai::AiState>,
    app: AppHandle,
    id: i64,
    reason: Option<String>,
    actor: Option<String>,
) -> Result<(), String> {
    let conn = maindb::open_readwrite(&state.dir())?;
    let res = reject(
        &conn,
        id,
        &reason.unwrap_or_default(),
        &actor.unwrap_or_else(|| "local".to_string()),
    )?;
    checkpoint(&conn);
    let _ = app.emit("signal:updated", json!({ "id": id, "status": "rejected" }));
    Ok(res)
}

#[tauri::command]
pub fn signal_done(
    state: State<'_, crate::ai::AiState>,
    app: AppHandle,
    id: i64,
    actor: Option<String>,
) -> Result<(), String> {
    let conn = maindb::open_readwrite(&state.dir())?;
    let res = mark_done(&conn, id, &actor.unwrap_or_else(|| "local".to_string()))?;
    checkpoint(&conn);
    let _ = app.emit("signal:updated", json!({ "id": id, "status": "done" }));
    Ok(res)
}

#[tauri::command]
pub fn signal_expire(
    state: State<'_, crate::ai::AiState>,
    ttl_minutes: Option<i64>,
) -> Result<i64, String> {
    let conn = maindb::open_readwrite(&state.dir())?;
    let n = expire_stale(&conn, ttl_minutes.unwrap_or(30))?;
    checkpoint(&conn);
    Ok(n)
}

#[tauri::command]
pub fn signal_create_manual(
    state: State<'_, crate::ai::AiState>,
    app: AppHandle,
    code: String,
    name: String,
    side: String,
    price: Option<f64>,
    vol: Option<i64>,
    reason: Option<String>,
) -> Result<String, String> {
    let trade_date = beijing_today_dashed();
    let conn = maindb::open_readwrite(&state.dir())?;
    let px = price.unwrap_or(0.0);
    let vl = vol.unwrap_or(0);
    let sid = create_manual(
        &conn,
        &code,
        &name,
        &side,
        px,
        vl,
        &reason.unwrap_or_default(),
        &trade_date,
    )?;
    checkpoint(&conn);
    // 与自动信号一致：推送灵动岛（置顶 + 自动展开）
    let _ = app.emit(
        "signal:new",
        json!({
            "sigId": sid, "code": code, "name": name,
            "side": side, "source": "manual", "price": px, "vol": vl,
        }),
    );
    Ok(sid)
}

/// 爬虫机器人前端评分信号：落待确认票（source=spider），复用去重。
#[tauri::command]
pub fn signal_create_spider(
    state: State<'_, crate::ai::AiState>,
    app: AppHandle,
    code: String,
    name: String,
    side: String,
    price: f64,
    vol: Option<i64>,
    confidence: Option<f64>,
    reason: Option<String>,
) -> Result<String, String> {
    let trade_date = beijing_today_dashed();
    let conn = maindb::open_readwrite(&state.dir())?;
    let sid = create_ticket(
        &conn,
        SignalInput {
            code: code.clone(),
            name: name.clone(),
            side: side.clone(),
            source: "spider".to_string(),
            model_version: "spider-rule-v1".to_string(),
            strategy: "爬虫盯盘".to_string(),
            confidence: confidence.unwrap_or(0.6).clamp(0.0, 1.0),
            ref_price: price,
            vol: vol.unwrap_or(100).max(100),
            reason: reason.unwrap_or_default(),
            trade_date: trade_date.clone(),
        },
    )
    .ok_or_else(|| "已有相同方向待确认信号或价格无效".to_string())?;
    checkpoint(&conn);
    let _ = app.emit(
        "signal:new",
        json!({
            "sigId": sid, "code": code, "name": name,
            "side": side, "source": "spider", "price": price,
        }),
    );
    Ok(sid)
}

#[tauri::command]
pub fn signal_launch_broker(path: String) -> Result<(), String> {
    launch_broker(&path)
}

#[tauri::command]
pub fn signal_preview_order(
    side: String,
    code: String,
    name: String,
    price: f64,
    vol: i64,
    broker: Option<String>,
    template: Option<String>,
) -> String {
    build_order_text_tpl(
        &template.unwrap_or_default(),
        &side,
        &code,
        &name,
        price,
        vol,
        &broker.unwrap_or_else(|| "同花顺".to_string()),
    )
}

// ===== 单测 =====

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buy_vol_rounds_to_lot() {
        // 价 10、预算 10000 → 10 手 = 1000 股
        assert_eq!(suggest_buy_vol(10.0, 10_000.0), 1000);
        // 预算不足一手 → 0
        assert_eq!(suggest_buy_vol(10.0, 999.0), 0);
        // 非法价
        assert_eq!(suggest_buy_vol(0.0, 10_000.0), 0);
    }

    #[test]
    fn order_text_contains_fields() {
        let t = build_order_text("BUY", "600519", "贵州茅台", 1500.0, 100, "同花顺");
        assert!(t.contains("买入"));
        assert!(t.contains("600519"));
        assert!(t.contains("1500.00"));
        assert!(t.contains("100"));
    }

    #[test]
    fn sell_order_text() {
        let t = build_order_text("SELL", "000001", "平安银行", 12.5, 200, "同花顺");
        assert!(t.contains("卖出"));
        assert!(t.contains("000001"));
    }

    #[test]
    fn custom_template_renders_fields() {
        let tpl = "{sideEn} {code} {name} {price} x{vol} @{broker}";
        let t = build_order_text_tpl(tpl, "BUY", "600519", "贵州茅台", 1500.0, 100, "同花顺");
        assert!(t.contains("BUY"));
        assert!(t.contains("600519"));
        assert!(t.contains("1500.00"));
        assert!(t.contains("@同花顺"));
        // 自定义模板不应出现内置的「约 … 元」
        assert!(!t.contains("约"));
    }

    #[test]
    fn unknown_placeholder_is_kept() {
        let t = build_order_text_tpl("{code} {foo}", "BUY", "600519", "x", 1.0, 100, "b");
        assert!(t.contains("{foo}"));
    }

    #[test]
    fn blank_template_falls_back() {
        let t = build_order_text_tpl("   ", "BUY", "600519", "贵州茅台", 1500.0, 100, "同花顺");
        assert!(t.contains("买入"));
        assert!(t.contains("价格"));
    }
}
