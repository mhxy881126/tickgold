// P2 盯盘执行层（模拟闭环）：盯盘 watch → 执行 execute → 回灌 feedback 后三步自动串。
// 复用现有引擎：ai::autoexec（盘中 5s 循环：快脑信号/硬止损 → 风控闸门 → 模拟盘撮合 → 决策日志）、
// broker::portfolio（统一模拟账本 paper_account/paper_position/paper_order）、
// broker::BrokerManager（kill_switch 急停、实盘开关）。
// 安全红线：全自动仅限模拟盘（实盘开关必须关闭、急停状态禁止启动）；真实券商通道在 P4，本阶段不接入。
// watch/execute/feedback 对应 daily_mission 第 3/4/5 步，严格门禁、不可跳步。
use crate::ai::autoexec::{self, AutoExecCtl, AutoExecConfig};
use crate::ai::maindb::open_readwrite;
use crate::ai::workflow::{
    self, load_feedback, load_mission_state, mission_json, persist_advance, save_feedback,
};
use crate::ai::{now_millis, AiState};
use crate::broker::portfolio;
use crate::broker::BrokerManager;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, State};

// ============================ 配置 ============================

/// 驾驶舱「启动盯盘」的默认执行配置：规则脑 + 模拟盘全自动（full 模式休市也可按最近收盘价演示）。
/// 风控阈值沿用 autoexec 的保守默认（硬止损 -7%、单票 20%、总仓 80%、日亏 5%、回撤 20%、连亏 3 停）。
/// pub(crate)：P6 智驾（pilot.rs）复用同一份全自动配置，避免两处漂移。
pub(crate) fn paper_full_config() -> AutoExecConfig {
    AutoExecConfig {
        enabled: true,
        brain_mode: "rule".to_string(),
        trade_mode: "full".to_string(),
        full_auto_mode: true,
        bridge_enabled: false, // 全自动直接落模拟盘，不经人工确认桥
        ..AutoExecConfig::default()
    }
}

// ============================ 只读统计 ============================

fn scalar_i64(conn: &Connection, sql: &str, date: &str) -> i64 {
    conn.query_row(sql, rusqlite::params![date], |r| r.get::<_, i64>(0))
        .unwrap_or(0)
}

/// 今日快脑信号统计（decision_log）。
fn signal_stats(conn: &Connection, date: &str) -> Value {
    let total = scalar_i64(
        conn,
        "SELECT COUNT(*) FROM decision_log WHERE trade_date=?1",
        date,
    );
    let executed = scalar_i64(
        conn,
        "SELECT COUNT(*) FROM decision_log WHERE trade_date=?1 AND action='executed'",
        date,
    );
    let observe = (total - executed).max(0);
    let mut recent = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT ts,code,name,label,action,confidence,strategy
         FROM decision_log WHERE trade_date=?1 ORDER BY created_at DESC LIMIT 10",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![date], |r| {
            Ok(json!({
                "ts": r.get::<_, String>(0).unwrap_or_default(),
                "code": r.get::<_, String>(1).unwrap_or_default(),
                "name": r.get::<_, String>(2).unwrap_or_default(),
                "label": r.get::<_, String>(3).unwrap_or_default(),
                "action": r.get::<_, String>(4).unwrap_or_default(),
                "confidence": r.get::<_, f64>(5).unwrap_or(0.0),
                "strategy": r.get::<_, String>(6).unwrap_or_default(),
            }))
        }) {
            for v in rows.flatten() {
                recent.push(v);
            }
        }
    }
    json!({ "total": total, "executed": executed, "observe": observe, "recent": recent })
}

/// 今日模拟成交统计（paper_order，status=filled）。
fn fill_stats(conn: &Connection, date: &str) -> Value {
    let total = scalar_i64(
        conn,
        "SELECT COUNT(*) FROM paper_order WHERE trade_date=?1 AND status='filled'",
        date,
    );
    let buy = scalar_i64(
        conn,
        "SELECT COUNT(*) FROM paper_order WHERE trade_date=?1 AND status='filled' AND side='buy'",
        date,
    );
    let sell = scalar_i64(
        conn,
        "SELECT COUNT(*) FROM paper_order WHERE trade_date=?1 AND status='filled' AND side='sell'",
        date,
    );
    let buy_amount = conn
        .query_row(
            "SELECT COALESCE(SUM(amount),0) FROM paper_order WHERE trade_date=?1 AND status='filled' AND side='buy'",
            rusqlite::params![date],
            |r| r.get::<_, f64>(0),
        )
        .unwrap_or(0.0);
    let sell_win = scalar_i64(
        conn,
        "SELECT COUNT(*) FROM paper_order WHERE trade_date=?1 AND status='filled' AND side='sell' AND realized_pnl>0",
        date,
    );
    let realized = portfolio::realized_pnl_of_day(conn, date).unwrap_or(0.0);
    let win_rate = win_rate_pct(sell_win, sell);
    let mut recent = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT side,code,name,price,vol,amount,realized_pnl,created_at
         FROM paper_order WHERE trade_date=?1 AND status='filled' ORDER BY created_at DESC LIMIT 10",
    ) {
        if let Ok(rows) = stmt.query_map(rusqlite::params![date], |r| {
            Ok(json!({
                "side": r.get::<_, String>(0).unwrap_or_default(),
                "code": r.get::<_, String>(1).unwrap_or_default(),
                "name": r.get::<_, String>(2).unwrap_or_default(),
                "price": r.get::<_, f64>(3).unwrap_or(0.0),
                "vol": r.get::<_, i64>(4).unwrap_or(0),
                "amount": r.get::<_, f64>(5).unwrap_or(0.0),
                "realizedPnl": r.get::<_, f64>(6).unwrap_or(0.0),
                "createdAt": r.get::<_, i64>(7).unwrap_or(0),
            }))
        }) {
            for v in rows.flatten() {
                recent.push(v);
            }
        }
    }
    json!({
        "total": total,
        "buy": buy,
        "sell": sell,
        "buyAmount": (buy_amount * 100.0).round() / 100.0,
        "sellWin": sell_win,
        "winRate": win_rate,
        "realizedPnl": (realized * 100.0).round() / 100.0,
        "recent": recent,
    })
}

/// 卖出胜率（%）：盈利卖出笔数 / 卖出总笔数；无卖出记 0。
fn win_rate_pct(sell_win: i64, sell_total: i64) -> f64 {
    if sell_total <= 0 {
        return 0.0;
    }
    (sell_win as f64 / sell_total as f64 * 1000.0).round() / 10.0
}

/// 当日作战结论（纯函数，可单测）。
fn feedback_conclusion(fill_total: i64, realized: f64, win_rate: f64, kill: bool) -> String {
    if kill {
        return "盘中触发紧急停止，已强制停止开新仓；请核对风控告警后再解除熔断。".to_string();
    }
    if fill_total == 0 {
        return "今日快脑未给出符合阈值的信号，模拟盘空仓观望——不交易也是纪律的一部分。".to_string();
    }
    let mut s = format!(
        "今日模拟成交 {fill_total} 笔，已实现盈亏 {realized:.0} 元，卖出胜率 {win_rate:.0}%。"
    );
    if realized > 0.0 {
        s.push_str("规则脑当日为正，按战法纪律执行，结果已回灌，供后续胜率进化。");
    } else {
        s.push_str("当日为负属正常波动，继续严守仓位与硬止损，不追高、不补仓。");
    }
    s
}

// ============================ Tauri 命令 ============================

/// 第④步：启动盯盘（模拟盘全自动）。盯盘对象自动继承当日作战卡（open/alerted 指令）+ 持仓。
#[tauri::command]
pub async fn workflow_watch_start(
    app: AppHandle,
    state: State<'_, AiState>,
    ctl: State<'_, Arc<AutoExecCtl>>,
    mgr: State<'_, BrokerManager>,
    trade_date: Option<String>,
) -> Result<Value, String> {
    let date = trade_date.unwrap_or_else(workflow::today_str);
    let dir = state.dir().clone();

    // 安全红线：急停状态 / 实盘开关开启时，禁止全自动模拟。
    if mgr.kill_switch.load(Ordering::SeqCst) {
        return Err("当前处于紧急停止状态，请先解除熔断再启动盯盘".to_string());
    }
    if mgr.config.lock().unwrap().live_enabled {
        return Err("全自动盯盘仅限模拟盘：请先在券商通道关闭实盘开关".to_string());
    }

    let conn = open_readwrite(&dir)?;
    let mut st = load_mission_state(&conn, &date)?;
    if st.current_step != 3 {
        return Err(format!(
            "「启动盯盘」需要在第 4 步进行，当前在第 {} 步，请先完成盘前作战卡确认",
            st.current_step + 1
        ));
    }
    let watch_count = autoexec::collect_watch(&conn).len() as i64;

    // 启动自动执行器（已在运行则只刷新配置，不重复 spawn）。
    let cfg = paper_full_config();
    let started_now = {
        *ctl.config.lock().unwrap() = cfg;
        if ctl.running.load(Ordering::Acquire) {
            false
        } else {
            ctl.running.store(true, Ordering::Release);
            true
        }
    };
    if started_now {
        let c: Arc<AutoExecCtl> = ctl.inner().clone();
        tauri::async_runtime::spawn(async move {
            autoexec::run_loop(app, c, dir).await;
        });
        log::info!("[P2] 作战流启动盯盘（模拟盘全自动），盯盘对象 {watch_count} 只");
    }

    let snapshot = json!({
        "kind": "watch",
        "watchCount": watch_count,
        "startedAt": now_millis(),
        "mode": "paper-full",
    })
    .to_string();
    let mission = persist_advance(&conn, &date, &mut st, Some(snapshot))?;
    Ok(json!({
        "mission": mission,
        "watchCount": watch_count,
        "running": true,
        "mode": "paper-full",
        "killSwitch": false,
    }))
}

/// 第⑤步只读：盘中执行状态（运行态 / 盯盘对象 / 信号 / 成交）。账户权益与风控请前端配合 risk_snapshot。
#[tauri::command]
pub async fn workflow_execute_status(
    state: State<'_, AiState>,
    ctl: State<'_, Arc<AutoExecCtl>>,
    mgr: State<'_, BrokerManager>,
    trade_date: Option<String>,
) -> Result<Value, String> {
    let date = trade_date.unwrap_or_else(workflow::today_str);
    let dir = state.dir().clone();
    let conn = open_readwrite(&dir)?;
    let watch_count = autoexec::collect_watch(&conn).len() as i64;
    let signals = signal_stats(&conn, &date);
    let fills = fill_stats(&conn, &date);
    let cfg = ctl.config.lock().unwrap().clone();
    Ok(json!({
        "running": ctl.running.load(Ordering::Acquire),
        "enabled": cfg.enabled,
        "killSwitch": mgr.kill_switch.load(Ordering::SeqCst),
        "tradeMode": cfg.trade_mode,
        "brainMode": cfg.brain_mode,
        "watchCount": watch_count,
        "signals": signals,
        "fills": fills,
    }))
}

/// 第⑥步：收盘结算——停止自动执行，聚合当日回灌小结，连续完成 execute→feedback 两步闭环。
#[tauri::command]
pub async fn workflow_feedback(
    _app: AppHandle,
    state: State<'_, AiState>,
    ctl: State<'_, Arc<AutoExecCtl>>,
    mgr: State<'_, BrokerManager>,
    trade_date: Option<String>,
) -> Result<Value, String> {
    let date = trade_date.unwrap_or_else(workflow::today_str);
    let dir = state.dir().clone();

    // 停止自动执行器。
    ctl.running.store(false, Ordering::Release);
    {
        let mut cfg = ctl.config.lock().unwrap().clone();
        cfg.enabled = false;
        *ctl.config.lock().unwrap() = cfg;
    }

    let conn = open_readwrite(&dir)?;
    let mut st = load_mission_state(&conn, &date)?;
    if st.current_step != 4 && st.current_step != 5 {
        return Err(format!(
            "「收盘结算」需要在第 5/6 步进行，当前在第 {} 步，请先启动盯盘",
            st.current_step + 1
        ));
    }

    // T+1 清算（best-effort）+ 当日信号/成交聚合。
    let _ = portfolio::settle(&conn, &date);
    let signals = signal_stats(&conn, &date);
    let fills = fill_stats(&conn, &date);
    let positions = portfolio::load_positions(&conn).unwrap_or_default();
    let cash = portfolio::load_cash(&conn)
        .ok()
        .flatten()
        .map(|(_init, cash)| cash)
        .unwrap_or(1_000_000.0);
    let realized = fills["realizedPnl"].as_f64().unwrap_or(0.0);
    let fill_total = fills["total"].as_i64().unwrap_or(0);
    let win_rate = fills["winRate"].as_f64().unwrap_or(0.0);
    let kill = mgr.kill_switch.load(Ordering::SeqCst);

    let feedback = json!({
        "tradeDate": date,
        "finishedAt": now_millis(),
        "signals": signals,
        "fills": fills,
        "openPositions": positions.len() as i64,
        "cash": (cash * 100.0).round() / 100.0,
        "realizedPnl": realized,
        "winRate": win_rate,
        "killSwitch": kill,
        "conclusion": feedback_conclusion(fill_total, realized, win_rate, kill),
    });

    // 先完成 execute（第 5 步），再保存回灌小结并完成 feedback（第 6 步）。
    if st.current_step == 4 {
        let exec_snap = json!({ "kind": "execute", "fills": fill_total, "realizedPnl": realized })
            .to_string();
        persist_advance(&conn, &date, &mut st, Some(exec_snap))?;
    }
    save_feedback(&conn, &date, &feedback)?;
    let mission = persist_advance(
        &conn,
        &date,
        &mut st,
        Some(json!({ "kind": "feedback" }).to_string()),
    )?;
    log::info!("[P2] 作战流收盘结算完成：成交 {fill_total} 笔，已实现盈亏 {realized:.0}");
    Ok(json!({ "mission": mission, "feedback": feedback }))
}

/// 只读回显：重开驾驶舱 / 盘中刷新取回后三步产物（运行态、急停、当日回灌小结）。
#[tauri::command]
pub async fn workflow_p2_products(
    state: State<'_, AiState>,
    ctl: State<'_, Arc<AutoExecCtl>>,
    mgr: State<'_, BrokerManager>,
    trade_date: Option<String>,
) -> Result<Value, String> {
    let date = trade_date.unwrap_or_else(workflow::today_str);
    let dir = state.dir().clone();
    let conn = open_readwrite(&dir)?;
    let st = load_mission_state(&conn, &date)?;
    let mission = mission_json(
        &date,
        st.current_step,
        &st.steps,
        &st.mode,
        &st.account_json,
        st.created_at,
        now_millis(),
    );
    let feedback = load_feedback(&conn, &date);
    Ok(json!({
        "mission": mission,
        "feedback": feedback,
        "running": ctl.running.load(Ordering::Acquire),
        "killSwitch": mgr.kill_switch.load(Ordering::SeqCst),
    }))
}

// ============================ 单测 ============================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win_rate_handles_empty_and_ratio() {
        assert_eq!(win_rate_pct(0, 0), 0.0);
        assert_eq!(win_rate_pct(3, 4), 75.0);
        assert_eq!(win_rate_pct(1, 3), 33.3);
    }

    #[test]
    fn conclusion_empty_day_urges_wait() {
        assert!(feedback_conclusion(0, 0.0, 0.0, false).contains("空仓观望"));
    }

    #[test]
    fn conclusion_kill_switch_wins() {
        // 即便有成交，急停状态优先提示熔断。
        assert!(feedback_conclusion(5, -100.0, 10.0, true).contains("紧急停止"));
    }

    #[test]
    fn conclusion_profit_vs_loss() {
        assert!(feedback_conclusion(4, 2000.0, 66.0, false).contains("为正"));
        assert!(feedback_conclusion(4, -500.0, 25.0, false).contains("为负"));
    }
}
