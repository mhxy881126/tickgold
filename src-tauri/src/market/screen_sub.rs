// 选股订阅（v2.31）：每日定时执行已保存的战法扫描方案，命中结果推送灵动岛/应用内提示。
// 存储：screen_subscription（方案）+ screen_subscription_run（每次执行记录），迁移 v53 建表。
// 调度：常驻 30s tick；到点（北京时间 HH:MM）且当日未跑 → 执行 → 落 run → emit 事件。
// 推送仅应用内事件（screen-sub:run），不注册系统通知（遵循"只允许应用内 Toast"约束）。
use super::strategy_scan::{scan, StrategyScanReq, TacticHit};
use crate::ai::maindb;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub id: i64,
    pub name: String,
    /// 逗号分隔的战法 id；空串 = 全部六种。
    pub tactic: String,
    pub filter_json: String,
    /// HH:MM（北京时间）。
    pub run_time: String,
    pub enabled: bool,
    pub last_run_at: i64,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionRun {
    pub id: i64,
    pub subscription_id: i64,
    pub ran_at: i64,
    pub hit_count: i64,
    pub codes_json: String,
}

/// 新建/更新订阅的入参。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionInput {
    pub id: Option<i64>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub tactic: String,
    #[serde(default)]
    pub filter_json: String,
    #[serde(default)]
    pub run_time: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 北京时间 (时, 分, YYYY-MM-DD, HH:MM)。
fn beijing_now() -> (i64, i64, String, String) {
    let ms = now_millis() + 8 * 3_600_000;
    let secs = ms / 1000;
    let (y, mo, d) = civil(secs / 86400);
    let h = (secs % 86400) / 3600;
    let mi = (secs % 3600) / 60;
    (
        h,
        mi,
        format!("{y:04}-{mo:02}-{d:02}"),
        format!("{h:02}:{mi:02}"),
    )
}

fn civil(z: i64) -> (i64, i64, i64) {
    let a = z + 719_468;
    let era = if a >= 0 { a } else { a - 146_096 } / 146_097;
    let doe = a - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

fn row_to_sub(r: &rusqlite::Row) -> rusqlite::Result<Subscription> {
    Ok(Subscription {
        id: r.get(0)?,
        name: r.get(1)?,
        tactic: r.get(2)?,
        filter_json: r.get(3)?,
        run_time: r.get(4)?,
        enabled: r.get::<_, i64>(5)? != 0,
        last_run_at: r.get(6)?,
        created_at: r.get(7)?,
    })
}

const SELECT_COLS: &str =
    "id,name,tactic,filter_json,run_time,enabled,last_run_at,created_at FROM screen_subscription";

pub fn list(conn: &Connection) -> Result<Vec<Subscription>, String> {
    let mut stmt = conn
        .prepare(&format!("{SELECT_COLS} ORDER BY id DESC"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_sub)
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

fn upsert(conn: &Connection, input: &SubscriptionInput) -> Result<i64, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("订阅名称不能为空".into());
    }
    let run_time = if input.run_time.len() == 5 {
        input.run_time.clone()
    } else {
        "15:30".to_string()
    };
    if let Some(id) = input.id {
        conn.execute(
            "UPDATE screen_subscription SET name=?1,tactic=?2,filter_json=?3,run_time=?4,enabled=?5 WHERE id=?6",
            rusqlite::params![
                name,
                input.tactic,
                input.filter_json,
                run_time,
                input.enabled as i64,
                id
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO screen_subscription(name,tactic,filter_json,run_time,enabled,created_at)
             VALUES(?1,?2,?3,?4,?5,?6)",
            rusqlite::params![name, input.tactic, input.filter_json, run_time, input.enabled as i64, now_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }
}

/// 执行一次订阅：跑战法扫描 → 写 run 记录 → 返回命中。
async fn execute_one(
    data_dir: &std::path::Path,
    sub: &Subscription,
) -> Result<(i64, Vec<TacticHit>), String> {
    // filter_json 承载 {limit,theme}；tactic 为逗号分隔。
    let mut filter: serde_json::Value =
        serde_json::from_str(&sub.filter_json).unwrap_or(serde_json::Value::Object(Default::default()));
    let tactics: Vec<String> = sub
        .tactic
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let obj = filter.as_object_mut();
    if let Some(o) = obj {
        o.insert("tactics".into(), serde_json::json!(tactics));
    }
    let req: StrategyScanReq =
        serde_json::from_value(filter).map_err(|e| e.to_string())?;
    let hits = scan(&req).await?;
    let codes: Vec<&str> = hits.iter().take(50).map(|h| h.code.as_str()).collect();
    let codes_json = serde_json::to_string(&codes).unwrap_or_else(|_| "[]".into());
    let run_at = now_millis();

    let conn = maindb::open_readwrite(data_dir)?;
    conn.execute(
        "INSERT INTO screen_subscription_run(subscription_id,ran_at,hit_count,codes_json)
         VALUES(?1,?2,?3,?4)",
        rusqlite::params![sub.id, run_at, hits.len() as i64, codes_json],
    )
    .map_err(|e| e.to_string())?;
    let run_id = conn.last_insert_rowid();
    conn.execute(
        "UPDATE screen_subscription SET last_run_at=?1 WHERE id=?2",
        rusqlite::params![run_at, sub.id],
    )
    .map_err(|e| e.to_string())?;
    Ok((run_id, hits))
}

/// 到点执行：检查每条启用订阅，当日未跑且当前时刻 ≥ run_time 即触发。
pub async fn run_due(app: &AppHandle, data_dir: &std::path::Path) {
    let (_h, _m, today, hhmm) = beijing_now();
    let due: Vec<Subscription> = {
        let Ok(conn) = maindb::open_readonly(data_dir) else { return };
        let Ok(all) = list(&conn) else { return };
        all.into_iter()
            .filter(|s| {
                if !s.enabled || hhmm < s.run_time {
                    return false;
                }
                // 当日已跑（按 last_run_at 的北京日期）则跳过。
                let last_day = if s.last_run_at > 0 {
                    let secs = (s.last_run_at + 8 * 3_600_000) / 1000;
                    let (y, mo, d) = civil(secs / 86400);
                    format!("{y:04}-{mo:02}-{d:02}")
                } else {
                    String::new()
                };
                last_day != today
            })
            .collect()
    };
    for sub in due {
        match execute_one(data_dir, &sub).await {
            Ok((run_id, hits)) => {
                log::info!(
                    "选股订阅[{}] {} 执行完成：{} 条命中",
                    sub.id, sub.name, hits.len()
                );
                let top: Vec<serde_json::Value> = hits
                    .iter()
                    .take(10)
                    .map(|h| {
                        serde_json::json!({
                            "code": h.code, "name": h.name, "pct": h.pct,
                            "tactics": h.tactics,
                        })
                    })
                    .collect();
                let _ = app.emit(
                    "screen-sub:run",
                    serde_json::json!({
                        "subscriptionId": sub.id,
                        "runId": run_id,
                        "name": sub.name,
                        "hitCount": hits.len(),
                        "top": top,
                    }),
                );
            }
            Err(e) => log::warn!("选股订阅[{}] {} 执行失败：{e}", sub.id, sub.name),
        }
    }
}

/// 常驻调度：30 秒检查一次到点订阅。
pub async fn scheduler_loop(app: AppHandle, data_dir: std::path::PathBuf) {
    log::info!("选股订阅调度器已启动");
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        run_due(&app, &data_dir).await;
    }
}

// ===== Tauri 命令 =====

#[tauri::command]
pub fn screen_sub_list(state: State<'_, crate::ai::AiState>) -> Result<Vec<Subscription>, String> {
    let conn = maindb::open_readonly(&state.dir())?;
    list(&conn)
}

#[tauri::command]
pub fn screen_sub_upsert(
    state: State<'_, crate::ai::AiState>,
    input: SubscriptionInput,
) -> Result<i64, String> {
    let conn = maindb::open_readwrite(&state.dir())?;
    upsert(&conn, &input)
}

#[tauri::command]
pub fn screen_sub_delete(
    state: State<'_, crate::ai::AiState>,
    id: i64,
) -> Result<(), String> {
    let conn = maindb::open_readwrite(&state.dir())?;
    conn.execute("DELETE FROM screen_subscription_run WHERE subscription_id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM screen_subscription WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn screen_sub_runs(
    state: State<'_, crate::ai::AiState>,
    subscription_id: i64,
    limit: Option<i64>,
) -> Result<Vec<SubscriptionRun>, String> {
    let lim = limit.unwrap_or(30).clamp(1, 200);
    let conn = maindb::open_readonly(&state.dir())?;
    let mut stmt = conn
        .prepare(
            "SELECT id,subscription_id,ran_at,hit_count,codes_json FROM screen_subscription_run
             WHERE subscription_id=?1 ORDER BY ran_at DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![subscription_id, lim], |r| {
            Ok(SubscriptionRun {
                id: r.get(0)?,
                subscription_id: r.get(1)?,
                ran_at: r.get(2)?,
                hit_count: r.get(3)?,
                codes_json: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

#[tauri::command]
pub async fn screen_sub_run_now(
    state: State<'_, crate::ai::AiState>,
    id: i64,
) -> Result<i64, String> {
    let data_dir = state.dir();
    let sub = {
        let conn = maindb::open_readonly(&data_dir)?;
        let mut stmt = conn
            .prepare(&format!("{SELECT_COLS} WHERE id=?1"))
            .map_err(|e| e.to_string())?;
        stmt.query_row([id], row_to_sub).map_err(|e| e.to_string())?
    };
    let (run_id, hits) = execute_one(&data_dir, &sub).await?;
    Ok(if hits.is_empty() { -run_id } else { run_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_roundtrip() {
        // 2026-10-13 的日序数（与 ladder_stats 同口径）。
        let days = {
            let (y, m, d) = (2026i64, 10i64, 13i64);
            let y = if m <= 2 { y - 1 } else { y };
            let era = if y >= 0 { y } else { y - 399 } / 400;
            let yoe = y - era * 400;
            let mp = if m > 2 { m - 3 } else { m + 9 };
            let doy = (153 * mp + 2) / 5 + d - 1;
            let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
            era * 146_097 + doe - 719_468
        };
        assert_eq!(civil(days), (2026, 10, 13));
    }
}
