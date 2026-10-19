// P1-c 调度器：盘后自动流水线（15:05 后 采集 → 分析 → 计划）+ 8:45 盘前确认提醒。
// 时间统一北京时间（UTC+8）、仅周一至周五；幂等键落 meta 表；失败最多重试 3 次。
// 只读 / 只生成 draft：下一交易日已有计划（任意状态）时盘后流水线直接跳过，
// 绝不覆盖用户手工生成或编辑过的作战卡。
use crate::ai::maindb::open_readwrite;
use crate::ai::plan;
use crate::ai::AiState;
use crate::market::spider::beijing;
use rusqlite::Connection;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

/// 失败重试上限：达到后写 `:failed` 键，失败事件只发一次。
const MAX_ATTEMPTS: i64 = 3;

// ============================ 时段判定（纯函数） ============================

/// 盘后流水线时段：周一至周五 15:05–23:59（含边界）。
///
/// `weekday` 与 `market::spider::beijing()` 同口径：0=周日 … 6=周六。
pub fn should_run_after_close(weekday: u8, hour: i32, minute: i32) -> bool {
    (1..=5).contains(&weekday) && (15 * 60 + 5..=23 * 60 + 59).contains(&(hour * 60 + minute))
}

/// 盘前提醒时段：周一至周五 08:45–09:29（含边界；9:30 开盘后不再补发）。
pub fn should_remind(weekday: u8, hour: i32, minute: i32) -> bool {
    (1..=5).contains(&weekday) && (8 * 60 + 45..=9 * 60 + 29).contains(&(hour * 60 + minute))
}

// ============================ meta 幂等 ============================

/// 抢占幂等键：首次插入成功（影响行数 1）返回 true，已存在返回 false。
/// 只允许在动作成功（或确认无需动作）后调用，失败路径不得写当日完成键。
fn claim_meta(conn: &Connection, key: &str) -> bool {
    conn.execute("INSERT OR IGNORE INTO meta(key,value) VALUES(?1,'1')", [key])
        .map(|n| n == 1)
        .unwrap_or(false)
}

/// 只读判断幂等键是否已写过（不改变任何状态）。
fn meta_claimed(conn: &Connection, key: &str) -> bool {
    conn.query_row("SELECT 1 FROM meta WHERE key=?1", [key], |_| Ok(()))
        .is_ok()
}

/// 失败计数 +1 并返回当前值（首次失败为 1）。
fn bump_attempts(conn: &Connection, key: &str) -> i64 {
    let _ = conn.execute(
        "INSERT INTO meta(key,value) VALUES(?1,'1')
         ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
        [key],
    );
    conn.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .and_then(|v| v.parse::<i64>().ok())
    .unwrap_or(1)
}

// ============================ 盘后自动流水线 ============================

/// 采集 → 分析 → 计划（任一步失败即中止，不写半成品计划）。
///
/// 断点续跑：`workflow_*` 三步有严格门禁（第①步只能 step 0 调、第②步只能 step 1 调），
/// 若第②步网络失败，整轮重试再从第①步开始会被门禁直接拒绝，导致重试永远失败。
/// 因此按当日 mission 当前步只补跑未完成的步骤（与 `pilot.rs` 的补齐逻辑同口径）。
async fn run_pipeline(app: &AppHandle) -> Result<(), String> {
    let date = crate::ai::workflow::today_str();
    let step = {
        let dir = app.state::<AiState>().dir();
        let c = open_readwrite(&dir)?;
        crate::ai::workflow::load_mission_state(&c, &date)?.current_step
    };
    if step <= 0 {
        crate::ai::workflow_p1::workflow_collect(app.state::<AiState>(), None, None)
            .await
            .map_err(|e| format!("盘后采集失败: {e}"))?;
    }
    if step <= 1 {
        crate::ai::workflow_p1::workflow_analyze(app.state::<AiState>(), None, None)
            .await
            .map_err(|e| format!("盘后分析失败: {e}"))?;
    }
    if step > 2 {
        return Err(format!("今日作战流已推进到第 {} 步，无法自动生成作战卡", step + 1));
    }
    crate::ai::workflow_p1::workflow_plan(app.state::<AiState>(), None)
        .map_err(|e| format!("盘后计划生成失败: {e}"))?;
    Ok(())
}

/// 盘后流水线一轮：为下一交易日生成 draft 作战卡（不自动确认）。
///
/// 幂等：成功后写 `auto_after_close:{today}`；失败累计 `..._attempts:{today}`，
/// 第 3 次失败写 `auto_after_close:{today}:failed` 并 emit 失败事件后当天不再重试。
async fn after_close(app: &AppHandle) -> Result<(), String> {
    let today = crate::broker::conditional::today_dashed();
    let next = plan::next_trade_date(&today);
    let dir = app.state::<AiState>().dir();
    let done_key = format!("auto_after_close:{today}");
    let failed_key = format!("{done_key}:failed");

    {
        let c = open_readwrite(&dir)?;
        if meta_claimed(&c, &done_key) || meta_claimed(&c, &failed_key) {
            return Ok(());
        }
    }
    // 已有计划（任意状态）：用户手工生成 / 编辑过，跳过并记为当日已完成。
    if plan::find_plan_id_by_date(&dir, &next)?.is_some() {
        let c = open_readwrite(&dir)?;
        let _ = claim_meta(&c, &done_key);
        log::info!("[P1-c] {next} 已有作战卡，盘后流水线跳过");
        return Ok(());
    }

    match run_pipeline(app).await {
        Ok(()) => {
            let c = open_readwrite(&dir)?;
            let _ = claim_meta(&c, &done_key);
            if let Err(e) = app.emit("battle:after-close", json!({ "nextDate": &next })) {
                log::warn!("[P1-c] 盘后完成事件发送失败: {e}");
            }
            log::info!("[P1-c] 盘后流水线完成，已生成 {next} 作战卡");
            Ok(())
        }
        Err(e) => {
            let attempts = open_readwrite(&dir)
                .map(|c| bump_attempts(&c, &format!("auto_after_close_attempts:{today}")))
                .unwrap_or(1);
            log::warn!("[P1-c] 盘后流水线失败（第 {attempts}/{MAX_ATTEMPTS} 次）: {e}");
            if attempts >= MAX_ATTEMPTS {
                let first = open_readwrite(&dir)
                    .map(|c| claim_meta(&c, &failed_key))
                    .unwrap_or(false);
                if first {
                    if let Err(err) = app.emit(
                        "battle:after-close-failed",
                        json!({ "error": &e, "attempts": attempts }),
                    ) {
                        log::warn!("[P1-c] 盘后失败事件发送失败: {err}");
                    }
                }
            }
            Err(e)
        }
    }
}

// ============================ 8:45 盘前提醒 ============================

/// 今日作战卡未确认（或未生成）→ emit `battle:reminder`；已确认则只记幂等键。
///
/// 文案与载荷（spec §三）：
/// - 无计划：`{"status":"missing","text":"今日无作战卡，请先生成"}`
/// - 未确认：`{"status":"draft","text":"今日作战卡待确认（N 条指令）"}`
async fn morning_reminder(app: &AppHandle) -> Result<(), String> {
    let today = crate::broker::conditional::today_dashed();
    let key = format!("morning_reminder:{today}");
    let dir = app.state::<AiState>().dir();
    let c = open_readwrite(&dir)?;
    if meta_claimed(&c, &key) {
        return Ok(());
    }

    let plan_row = c
        .query_row("SELECT id,status FROM plan WHERE plan_date=?1", [&today], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .ok();

    let Some((plan_id, status)) = plan_row else {
        let payload = json!({
            "kind": "plan-confirm",
            "planId": 0,
            "planDate": &today,
            "status": "missing",
            "text": "今日无作战卡，请先生成"
        });
        app.emit("battle:reminder", payload)
            .map_err(|e| format!("发送盘前提醒失败: {e}"))?;
        let _ = claim_meta(&c, &key);
        log::info!("[P1-c] {today} 无作战卡，已提醒");
        return Ok(());
    };

    if status == "confirmed" {
        let _ = claim_meta(&c, &key);
        return Ok(());
    }

    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM plan_instruction WHERE plan_id=?1",
            [plan_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let payload = json!({
        "kind": "plan-confirm",
        "planId": plan_id,
        "planDate": &today,
        "status": "draft",
        "text": format!("今日作战卡待确认（{n} 条指令）")
    });
    app.emit("battle:reminder", payload)
        .map_err(|e| format!("发送盘前提醒失败: {e}"))?;
    let _ = claim_meta(&c, &key);
    log::info!("[P1-c] {today} 作战卡待确认（{n} 条指令），已提醒");
    Ok(())
}

// ============================ 调度循环 ============================

/// 盘后流水线进程内互斥：上一轮未结束时 tick 不再重复 spawn。
static RUNNING: AtomicBool = AtomicBool::new(false);

/// 30s tick：盘后窗口 spawn 流水线（不阻塞循环），盘前窗口内联发提醒（纯 DB，很快）。
///
/// 盘后窗口每 30s 都可能命中，故用 `RUNNING` 挡住正在跑的一轮；成功/失败完成后
/// 由 `after_close` 内的 meta 幂等键短路，同一天不会重复生成或重复告警。
pub async fn run_loop(app: AppHandle) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let (wd, h, m) = beijing();
        let (weekday, hour, minute) = (wd as u8, h as i32, m as i32);

        if should_run_after_close(weekday, hour, minute) {
            if RUNNING.swap(true, Ordering::SeqCst) {
                continue;
            }
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                // 失败已在 after_close 内计数 / 告警，这里只负责释放守卫。
                let _ = after_close(&handle).await;
                RUNNING.store(false, Ordering::SeqCst);
            });
        } else if should_remind(weekday, hour, minute) {
            if let Err(e) = morning_reminder(&app).await {
                log::warn!("[P1-c] 盘前提醒失败: {e}");
            }
        }
    }
}

static SCHEDULE_STARTED: AtomicBool = AtomicBool::new(false);

/// 幂等启动盘后流水线 / 盘前提醒调度（重复调用只 spawn 一次）。
pub fn ensure_daily_schedule(app: &AppHandle) {
    if SCHEDULE_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run_loop(handle).await;
    });
    log::info!("[P1-c] 盘后流水线 / 盘前提醒调度已启动（30s tick）");
}

// ============================ 单测 ============================

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_meta() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);")
            .unwrap();
        c
    }

    #[test]
    fn after_close_window_boundaries() {
        // 周一（weekday=1）：15:04 不跑，15:05 起跑，23:59 仍可补跑。
        assert!(!should_run_after_close(1, 15, 4));
        assert!(should_run_after_close(1, 15, 5));
        assert!(should_run_after_close(1, 15, 30));
        assert!(should_run_after_close(1, 23, 59));
        // 非交易时段与周末：都不跑。
        assert!(!should_run_after_close(1, 14, 59));
        assert!(!should_run_after_close(1, 9, 30));
        assert!(!should_run_after_close(6, 10, 0), "周六不跑");
        assert!(!should_run_after_close(0, 15, 30), "周日不跑");
        assert!(!should_run_after_close(7, 15, 30), "weekday 越界不跑");
    }

    #[test]
    fn remind_window_boundaries() {
        // 周一：8:44 不提醒，8:45–9:29 提醒，9:30 起不再提醒。
        assert!(!should_remind(1, 8, 44));
        assert!(should_remind(1, 8, 45));
        assert!(should_remind(1, 9, 0));
        assert!(should_remind(1, 9, 29));
        assert!(!should_remind(1, 9, 30));
        // 周末不提醒（周日 8:50 / 周六 9:00）。
        assert!(!should_remind(0, 8, 50), "周日不提醒");
        assert!(!should_remind(6, 9, 0), "周六不提醒");
        // 盘后窗口不得触发提醒（两个时段互斥）。
        assert!(!should_remind(1, 15, 30));
        assert!(!should_run_after_close(1, 8, 50));
    }

    #[test]
    fn claim_meta_only_once() {
        let c = mem_meta();
        let key = "auto_after_close:2026-10-19";
        assert!(claim_meta(&c, key), "首次抢占应成功");
        assert!(!claim_meta(&c, key), "同 key 第二次应失败");
        assert!(meta_claimed(&c, key));
        // 不同 key 互不影响（同日盘后键与提醒键独立）。
        assert!(claim_meta(&c, "morning_reminder:2026-10-19"));
        assert!(!meta_claimed(&c, "auto_after_close:2026-10-20"));
        // 失败键与完成键相互独立：失败标记不冒充完成。
        assert!(!meta_claimed(&c, "auto_after_close:2026-10-19:failed"));
    }

    #[test]
    fn attempts_increment_and_cap() {
        let c = mem_meta();
        let key = "auto_after_close_attempts:2026-10-19";
        assert_eq!(bump_attempts(&c, key), 1);
        assert_eq!(bump_attempts(&c, key), 2);
        assert_eq!(bump_attempts(&c, key), 3);
        assert!(bump_attempts(&c, key) >= MAX_ATTEMPTS);
    }
}
