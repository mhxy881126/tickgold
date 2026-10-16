// P0 作战流编排层：每日作战任务（daily_mission）六步状态机。
// 六步闭环：采集 collect → 分析 analyze → 计划 plan → 盯盘 watch → 执行 execute → 回灌 feedback。
// P0 只做可持久化的状态流转与步骤门禁（不接真实引擎；采集/复盘/计划/盯盘/交易/回灌在 P1/P2 接入），
// 前端驾驶舱据此驱动「今日作战流」，保证步骤只能顺序推进、不跳步、不回退。
use crate::ai::maindb::open_readwrite;
use crate::ai::{now_millis, AiState};
use chrono::Local;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

/// 六步 key（顺序即作战流，禁止跳步）。
pub const STEP_KEYS: [&str; 6] =
    ["collect", "analyze", "plan", "watch", "execute", "feedback"];

/// 单步状态：todo 未开始 / doing 进行中 / done 已完成。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StepState {
    pub key: String,
    pub status: String,
    pub snapshot: String,
    pub at: i64,
}

impl StepState {
    fn todo(key: &str) -> Self {
        Self {
            key: key.to_string(),
            status: "todo".into(),
            snapshot: String::new(),
            at: 0,
        }
    }
}

/// 新任务的六步：第一步 doing，其余 todo。
pub fn new_steps() -> Vec<StepState> {
    let mut steps: Vec<StepState> = STEP_KEYS.iter().map(|k| StepState::todo(k)).collect();
    if let Some(first) = steps.first_mut() {
        first.status = "doing".into();
    }
    steps
}

/// 重置后的六步（等同新任务）。
pub fn reset_steps() -> Vec<StepState> {
    new_steps()
}

/// 推进当前步：把第 current_step 步置为 done（写入快照/时间戳），下一步置为 doing。
/// current_step==6（全部完成）时返回错误，保证门禁不越界；顺序由调用方按 current_step 推进，天然不可跳步。
pub fn advance_steps(
    steps: &mut [StepState],
    current_step: i64,
    snapshot: Option<String>,
    now: i64,
) -> Result<i64, String> {
    let n = STEP_KEYS.len() as i64;
    if current_step < 0 || current_step >= n {
        return Err("六步作战流已全部完成，无可推进步骤".to_string());
    }
    let idx = current_step as usize;
    let cur = steps
        .get_mut(idx)
        .ok_or_else(|| "当前步骤状态缺失".to_string())?;
    cur.status = "done".into();
    cur.at = now;
    if let Some(s) = snapshot {
        cur.snapshot = s;
    }
    let next = current_step + 1;
    if next < n {
        steps
            .get_mut(next as usize)
            .ok_or_else(|| "下一步状态缺失".to_string())?
            .status = "doing".into();
    }
    Ok(next)
}

pub(crate) fn today_str() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// 幂等建表（旁路连接早于主连接迁移时自保）。
pub(crate) fn ensure_table(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS daily_mission (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_date TEXT NOT NULL UNIQUE,
            current_step INTEGER NOT NULL DEFAULT 0,
            steps_json TEXT NOT NULL DEFAULT '[]',
            mode TEXT NOT NULL DEFAULT 'mock',
            account_json TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_daily_mission_date ON daily_mission(trade_date);",
    )
    .map_err(|e| format!("初始化 daily_mission 失败: {e}"))
}

struct MissionRow {
    current_step: i64,
    steps_json: String,
    mode: String,
    account_json: String,
    created_at: i64,
    updated_at: i64,
}

pub(crate) fn parse_steps(raw: &str) -> Vec<StepState> {
    serde_json::from_str::<Vec<StepState>>(raw).unwrap_or_else(|_| new_steps())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn mission_json(
    trade_date: &str,
    current_step: i64,
    steps: &[StepState],
    mode: &str,
    account_json: &str,
    created_at: i64,
    updated_at: i64,
) -> Value {
    let account: Value = serde_json::from_str(account_json).unwrap_or(json!({}));
    json!({
        "tradeDate": trade_date,
        "currentStep": current_step,
        "stepCount": STEP_KEYS.len(),
        "allDone": current_step >= STEP_KEYS.len() as i64,
        "mode": mode,
        "account": account,
        "steps": steps,
        "createdAt": created_at,
        "updatedAt": updated_at,
    })
}

/// 读取（不存在则创建）当日任务。
pub(crate) fn load_or_create(c: &Connection, trade_date: &str) -> Result<Value, String> {
    ensure_table(c)?;
    let now = now_millis();
    let row = c.query_row(
        "SELECT current_step, steps_json, mode, account_json, created_at, updated_at
         FROM daily_mission WHERE trade_date=?1",
        [trade_date],
        |r| {
            Ok(MissionRow {
                current_step: r.get(0)?,
                steps_json: r.get(1)?,
                mode: r.get(2)?,
                account_json: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        },
    );
    match row {
        Ok(m) => {
            let steps = parse_steps(&m.steps_json);
            Ok(mission_json(
                trade_date,
                m.current_step,
                &steps,
                &m.mode,
                &m.account_json,
                m.created_at,
                m.updated_at,
            ))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            let steps = new_steps();
            let steps_json = serde_json::to_string(&steps).map_err(|e| e.to_string())?;
            c.execute(
                "INSERT INTO daily_mission(trade_date, current_step, steps_json, mode, account_json, created_at, updated_at)
                 VALUES(?1, 0, ?2, 'mock', '{}', ?3, ?3)",
                rusqlite::params![trade_date, steps_json, now],
            )
            .map_err(|e| format!("创建当日作战任务失败: {e}"))?;
            Ok(mission_json(trade_date, 0, &steps, "mock", "{}", now, now))
        }
        Err(e) => Err(format!("读取当日作战任务失败: {e}")),
    }
}

/// P1 各步命令复用的当前任务状态快照。
pub(crate) struct MissionState {
    pub current_step: i64,
    pub steps: Vec<StepState>,
    pub mode: String,
    pub account_json: String,
    pub created_at: i64,
}

/// 读取当日任务状态（不存在则建），供 P1 采集/分析/计划各步做门禁判断。
pub(crate) fn load_mission_state(c: &Connection, date: &str) -> Result<MissionState, String> {
    ensure_table(c)?;
    let _ = load_or_create(c, date)?;
    let m = c.query_row(
        "SELECT current_step, steps_json, mode, account_json, created_at
         FROM daily_mission WHERE trade_date=?1",
        [date],
        |r| {
            Ok(MissionState {
                current_step: r.get(0)?,
                steps: parse_steps(&r.get::<_, String>(1)?),
                mode: r.get(2)?,
                account_json: r.get(3)?,
                created_at: r.get(4)?,
            })
        },
    )
    .map_err(|e| format!("读取当日作战任务失败: {e}"))?;
    Ok(m)
}

/// 业务成功后推进当前步并持久化，返回最新 mission JSON。
pub(crate) fn persist_advance(
    c: &Connection,
    date: &str,
    st: &mut MissionState,
    snapshot: Option<String>,
) -> Result<Value, String> {
    let now = now_millis();
    let new_current = advance_steps(&mut st.steps, st.current_step, snapshot, now)?;
    let steps_json = serde_json::to_string(&st.steps).map_err(|e| e.to_string())?;
    c.execute(
        "UPDATE daily_mission SET current_step=?1, steps_json=?2, updated_at=?3 WHERE trade_date=?4",
        rusqlite::params![new_current, steps_json, now, date],
    )
    .map_err(|e| format!("推进作战步骤失败: {e}"))?;
    st.current_step = new_current;
    Ok(mission_json(
        date,
        new_current,
        &st.steps,
        &st.mode,
        &st.account_json,
        st.created_at,
        now,
    ))
}

/// 写入当前任务的战场态势包（P1 采集步产物）。
pub(crate) fn save_briefing(c: &Connection, date: &str, briefing: &Value) -> Result<(), String> {
    let raw = serde_json::to_string(briefing).map_err(|e| e.to_string())?;
    c.execute(
        "UPDATE daily_mission SET briefing_json=?1, updated_at=?2 WHERE trade_date=?3",
        rusqlite::params![raw, now_millis(), date],
    )
    .map_err(|e| format!("保存战场态势包失败: {e}"))?;
    Ok(())
}

/// 读取当前任务的战场态势包（无则空对象）。
pub(crate) fn load_briefing(c: &Connection, date: &str) -> Value {
    c.query_row(
        "SELECT briefing_json FROM daily_mission WHERE trade_date=?1",
        [date],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|raw| serde_json::from_str(&raw).ok())
    .unwrap_or_else(|| json!({}))
}

/// 写入当前任务的当日回灌小结（P2 回灌步产物）。
pub(crate) fn save_feedback(c: &Connection, date: &str, feedback: &Value) -> Result<(), String> {
    let raw = serde_json::to_string(feedback).map_err(|e| e.to_string())?;
    c.execute(
        "UPDATE daily_mission SET feedback_json=?1, updated_at=?2 WHERE trade_date=?3",
        rusqlite::params![raw, now_millis(), date],
    )
    .map_err(|e| format!("保存当日回灌小结失败: {e}"))?;
    Ok(())
}

/// 读取当前任务的当日回灌小结（无则空对象）。
pub(crate) fn load_feedback(c: &Connection, date: &str) -> Value {
    c.query_row(
        "SELECT feedback_json FROM daily_mission WHERE trade_date=?1",
        [date],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|raw| serde_json::from_str(&raw).ok())
    .unwrap_or_else(|| json!({}))
}

/// 获取今日作战任务（不存在自动创建，第一步为进行中）。
#[tauri::command]
pub fn workflow_get_today(
    state: State<'_, AiState>,
    trade_date: Option<String>,
) -> Result<Value, String> {
    let date = trade_date.unwrap_or_else(today_str);
    let c = open_readwrite(&state.dir())?;
    load_or_create(&c, &date)
}

/// 推进当前步骤（完成当前步、进入下一步），可附带本步产物快照。
#[tauri::command]
pub fn workflow_advance(
    state: State<'_, AiState>,
    trade_date: Option<String>,
    snapshot: Option<String>,
) -> Result<Value, String> {
    let date = trade_date.unwrap_or_else(today_str);
    let c = open_readwrite(&state.dir())?;
    ensure_table(&c)?;
    // 前端若跳过 get_today 直接推进，先保证当日任务存在。
    let _ = load_or_create(&c, &date)?;
    let now = now_millis();
    let m = c
        .query_row(
            "SELECT current_step, steps_json, mode, account_json, created_at, updated_at
             FROM daily_mission WHERE trade_date=?1",
            [&date],
            |r| {
                Ok(MissionRow {
                    current_step: r.get(0)?,
                    steps_json: r.get(1)?,
                    mode: r.get(2)?,
                    account_json: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            },
        )
        .map_err(|e| format!("读取当日作战任务失败: {e}"))?;
    let mut steps = parse_steps(&m.steps_json);
    let new_current = advance_steps(&mut steps, m.current_step, snapshot, now)?;
    let steps_json = serde_json::to_string(&steps).map_err(|e| e.to_string())?;
    c.execute(
        "UPDATE daily_mission SET current_step=?1, steps_json=?2, updated_at=?3 WHERE trade_date=?4",
        rusqlite::params![new_current, steps_json, now, date],
    )
    .map_err(|e| format!("推进作战步骤失败: {e}"))?;
    Ok(mission_json(
        &date,
        new_current,
        &steps,
        &m.mode,
        &m.account_json,
        m.created_at,
        now,
    ))
}

/// 重置当日作战流（回到第一步进行中）。
#[tauri::command]
pub fn workflow_reset(
    state: State<'_, AiState>,
    trade_date: Option<String>,
) -> Result<Value, String> {
    let date = trade_date.unwrap_or_else(today_str);
    let c = open_readwrite(&state.dir())?;
    ensure_table(&c)?;
    let now = now_millis();
    let steps = reset_steps();
    let steps_json = serde_json::to_string(&steps).map_err(|e| e.to_string())?;
    c.execute(
        "INSERT INTO daily_mission(trade_date, current_step, steps_json, mode, account_json, created_at, updated_at)
         VALUES(?1, 0, ?2, 'mock', '{}', ?3, ?3)
         ON CONFLICT(trade_date) DO UPDATE SET
            current_step=0, steps_json=excluded.steps_json, updated_at=?3",
        rusqlite::params![date, steps_json, now],
    )
    .map_err(|e| format!("重置作战任务失败: {e}"))?;
    Ok(mission_json(&date, 0, &steps, "mock", "{}", now, now))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_mission_first_step_doing() {
        let s = new_steps();
        assert_eq!(s.len(), 6);
        assert_eq!(s[0].status, "doing");
        assert!(s[1..].iter().all(|x| x.status == "todo"));
    }

    #[test]
    fn advance_marks_next_step_doing() {
        let mut s = new_steps();
        let cur = advance_steps(&mut s, 0, None, 1).unwrap();
        assert_eq!(cur, 1);
        assert_eq!(s[0].status, "done");
        assert_eq!(s[0].at, 1);
        assert_eq!(s[1].status, "doing");
        assert_eq!(s[2].status, "todo");
    }

    #[test]
    fn advance_writes_snapshot_on_completed_step() {
        let mut s = new_steps();
        advance_steps(&mut s, 0, Some("战场态势包".into()), 42).unwrap();
        assert_eq!(s[0].snapshot, "战场态势包");
        assert_eq!(s[1].snapshot, "");
    }

    #[test]
    fn advance_walks_all_six_steps_in_order() {
        let mut s = new_steps();
        let mut cur = 0;
        for i in 0..6i64 {
            let ui = i as usize;
            assert_eq!(s[ui].status, "doing"); // 当前步始终为 doing（首轮初始，后续由上一步推进置位）
            cur = advance_steps(&mut s, cur, Some(format!("shot-{i}")), 100 + i).unwrap();
            assert_eq!(cur, i + 1);
            assert_eq!(s[ui].status, "done");
            assert_eq!(s[ui].at, 100 + i);
            assert_eq!(s[ui].snapshot, format!("shot-{i}"));
            if i + 1 < 6 {
                assert_eq!(s[(i + 1) as usize].status, "doing");
            }
        }
        assert_eq!(cur, 6);
        // 全部完成后再推进必须报错（门禁）。
        assert!(advance_steps(&mut s, cur, None, 999).is_err());
        // 负索引同样拒绝。
        assert!(advance_steps(&mut s, -1, None, 999).is_err());
    }

    #[test]
    fn reset_returns_to_first_step() {
        let s = reset_steps();
        assert_eq!(s[0].status, "doing");
        assert!(s[1..].iter().all(|x| x.status == "todo"));
    }
}
