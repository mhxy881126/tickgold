// 数据治理（v2.29）：体积统计 / 孤儿文件清理 / 主库 VACUUM。
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const DB_NAME: &str = "stock-dock.db";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSizeInfo {
    name: String,
    size: u64,
    kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    data_dir: String,
    total_bytes: u64,
    files: Vec<FileSizeInfo>,
    /// 主库各表行数（治理前展示）
    table_rows: Vec<(String, i64)>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn classify(name: &str) -> &'static str {
    if name == DB_NAME {
        "main-db"
    } else if name == "ai.db" {
        "ai-db"
    } else if name.ends_with(".db-wal") || name.ends_with(".db-shm") {
        "wal"
    } else if name.contains(".pre-restore-") {
        "restore-proof"
    } else if name.ends_with(".restore-staging") {
        "staging"
    } else if name == "backups" {
        "backups-dir"
    } else {
        "other"
    }
}

fn dir_size(p: &Path) -> u64 {
    let mut total = 0;
    if let Ok(rd) = std::fs::read_dir(p) {
        for ent in rd.flatten() {
            let path = ent.path();
            if path.is_dir() {
                total += dir_size(&path);
            } else if let Ok(md) = ent.metadata() {
                total += md.len();
            }
        }
    }
    total
}

/// 体积统计：数据目录顶层文件 + backups 目录合计 + 主库表行数。
#[tauri::command]
pub(crate) fn storage_stats(app: AppHandle) -> Result<StorageStats, String> {
    let dir = data_dir(&app)?;
    let mut files = Vec::new();
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let path = ent.path();
            let name = ent.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if name == "backups" {
                    let sz = dir_size(&path);
                    files.push(FileSizeInfo {
                        name,
                        size: sz,
                        kind: "backups-dir".into(),
                    });
                    total += sz;
                }
                continue;
            }
            if let Ok(md) = ent.metadata() {
                files.push(FileSizeInfo {
                    name: name.clone(),
                    size: md.len(),
                    kind: classify(&name).into(),
                });
                total += md.len();
            }
        }
    }
    files.sort_by_key(|f| std::cmp::Reverse(f.size));

    // 主库表行数
    let mut table_rows: Vec<(String, i64)> = Vec::new();
    if let Ok(conn) = rusqlite::Connection::open(dir.join(DB_NAME)) {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ts_%' ORDER BY name",
        ) {
            let names: Vec<String> = stmt
                .query_map([], |r| r.get(0))
                .into_iter()
                .flatten()
                .flatten()
                .collect();
            for tname in names {
                let sql = format!("SELECT COUNT(*) FROM \"{tname}\"");
                if let Ok(c) = conn.query_row(&sql, [], |r| r.get::<_, i64>(0)) {
                    table_rows.push((tname, c));
                }
            }
        }
    }
    Ok(StorageStats {
        data_dir: dir.to_string_lossy().to_string(),
        total_bytes: total,
        files,
        table_rows,
    })
}

/// 孤儿清理：删除恢复留证文件（*.pre-restore-*）、遗留暂存（*.restore-staging）、
/// 临时恢复脚本。返回删除文件数与释放字节数。
#[tauri::command]
pub(crate) fn storage_cleanup_orphans(app: AppHandle) -> Result<(usize, u64), String> {
    let dir = data_dir(&app)?;
    let mut removed = 0usize;
    let mut bytes = 0u64;

    if let Ok(rd) = std::fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            let is_orphan = name.contains(".pre-restore-") || name.ends_with(".restore-staging");
            if is_orphan {
                if let Ok(md) = ent.metadata() {
                    bytes += md.len();
                }
                if std::fs::remove_file(ent.path()).is_ok() {
                    removed += 1;
                }
            }
        }
    }

    // 临时目录下遗留的恢复脚本
    let tmp = std::env::temp_dir();
    if let Ok(rd) = std::fs::read_dir(&tmp) {
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            if name.starts_with("tg-restore-")
                && name.ends_with(".bat")
                && std::fs::remove_file(ent.path()).is_ok()
            {
                removed += 1;
            }
        }
    }

    Ok((removed, bytes))
}

/// 主库 VACUUM：回收删除数据后的空闲页，缩小文件体积。
/// 离线执行（约数百 ms～数秒），返回回收后的文件大小。
#[tauri::command]
pub(crate) async fn storage_vacuum(app: AppHandle) -> Result<u64, String> {
    let dir = data_dir(&app)?;
    let db_path = dir.join(DB_NAME);
    tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
        conn.execute_batch("VACUUM").map_err(|e| e.to_string())?;
        Ok(std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===== 过期数据治理（v2.29）=====
// 主库分时表（ts_market / ts_index / ts_sector）按天删除，日级表长期保留；
// ai.db 的知识库切块按 created_at、会话按 last_at 过期。0 / 负数表示该项不清理。

const AI_DB_NAME: &str = "ai.db";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PurgeTarget {
    key: String,
    label: String,
    cutoff: String,
    rows: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PurgePlan {
    /// 本地日期（YYYY-MM-DD）：早于该日的分时将被清理
    intraday_cutoff: String,
    /// 毫秒时间戳：早于该时刻的知识库切块 / 会话将被清理，0 表示不清理
    ai_cutoff_ms: i64,
    targets: Vec<PurgeTarget>,
    total_rows: i64,
}

const INTRADAY_TABLES: &[(&str, &str)] = &[
    ("ts_market", "市场情绪分时"),
    ("ts_index", "指数分时"),
    ("ts_sector", "板块分时"),
];

/// 公历纪元天数 → (年, 月, 日)，Howard Hinnant civil_from_days。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (y + if m <= 2 { 1 } else { 0 }, m as u32, d as u32)
}

/// 今天（UTC）往前 keep_days 天的日期串 YYYY-MM-DD。
fn cutoff_day(keep_days: i64) -> String {
    let now_days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64 / 86400)
        .unwrap_or(0);
    let (y, m, d) = civil_from_days(now_days - keep_days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn cutoff_ms(keep_days: i64) -> i64 {
    if keep_days <= 0 {
        return 0;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    now - keep_days * 86_400_000
}

fn build_plan(
    app: &AppHandle,
    keep_intraday_days: i64,
    keep_ai_days: i64,
) -> Result<PurgePlan, String> {
    let dir = data_dir(app)?;
    let mut targets = Vec::new();

    let intraday_cutoff = if keep_intraday_days > 0 {
        let day = cutoff_day(keep_intraday_days);
        let conn = rusqlite::Connection::open(dir.join(DB_NAME)).map_err(|e| e.to_string())?;
        for (table, label) in INTRADAY_TABLES {
            let sql = format!("SELECT COUNT(*) FROM {table} WHERE day < ?1");
            let n: i64 = conn
                .query_row(&sql, rusqlite::params![day], |r| r.get(0))
                .unwrap_or(0);
            targets.push(PurgeTarget {
                key: table.to_string(),
                label: label.to_string(),
                cutoff: day.clone(),
                rows: n,
            });
        }
        day
    } else {
        String::new()
    };

    let ai_cutoff_ms = cutoff_ms(keep_ai_days);
    if ai_cutoff_ms > 0 {
        let ai_path = dir.join(AI_DB_NAME);
        if ai_path.exists() {
            let conn = rusqlite::Connection::open(ai_path).map_err(|e| e.to_string())?;
            let chunks: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM kb_chunk WHERE created_at < ?1",
                    rusqlite::params![ai_cutoff_ms],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            targets.push(PurgeTarget {
                key: "kb_chunk".into(),
                label: "知识库切块".into(),
                cutoff: ai_cutoff_ms.to_string(),
                rows: chunks,
            });
            // 孤儿消息（无会话）+ 久未触达会话内的消息
            let msgs: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM ai_message m
                     WHERE m.created_at < ?1
                       AND (NOT EXISTS (SELECT 1 FROM ai_session s WHERE s.id = m.session_id)
                            OR EXISTS (SELECT 1 FROM ai_session s WHERE s.id = m.session_id AND s.last_at < ?1))",
                    rusqlite::params![ai_cutoff_ms],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            targets.push(PurgeTarget {
                key: "ai_message".into(),
                label: "历史对话消息".into(),
                cutoff: ai_cutoff_ms.to_string(),
                rows: msgs,
            });
        }
    }

    let total_rows = targets.iter().map(|t| t.rows).sum();
    Ok(PurgePlan {
        intraday_cutoff,
        ai_cutoff_ms,
        targets,
        total_rows,
    })
}

/// 过期清理预览：返回各目标将删除的行数，不执行删除。
#[tauri::command]
pub(crate) fn storage_purge_preview(
    app: AppHandle,
    keep_intraday_days: i64,
    keep_ai_days: i64,
) -> Result<PurgePlan, String> {
    build_plan(&app, keep_intraday_days, keep_ai_days)
}

/// 执行过期清理：按预览口径删除；消息先删、再删空会话，最后返回删除行数。
#[tauri::command]
pub(crate) fn storage_purge_run(
    app: AppHandle,
    keep_intraday_days: i64,
    keep_ai_days: i64,
) -> Result<PurgePlan, String> {
    let dir = data_dir(&app)?;
    let plan = build_plan(&app, keep_intraday_days, keep_ai_days)?;

    if keep_intraday_days > 0 {
        let conn = rusqlite::Connection::open(dir.join(DB_NAME)).map_err(|e| e.to_string())?;
        for (table, _) in INTRADAY_TABLES {
            let sql = format!("DELETE FROM {table} WHERE day < ?1");
            conn.execute(&sql, rusqlite::params![plan.intraday_cutoff])
                .map_err(|e| e.to_string())?;
        }
    }

    if plan.ai_cutoff_ms > 0 {
        let ai_path = dir.join(AI_DB_NAME);
        if ai_path.exists() {
            let conn = rusqlite::Connection::open(ai_path).map_err(|e| e.to_string())?;
            conn.execute(
                "DELETE FROM kb_chunk WHERE created_at < ?1",
                rusqlite::params![plan.ai_cutoff_ms],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "DELETE FROM ai_message WHERE created_at < ?1
                   AND (NOT EXISTS (SELECT 1 FROM ai_session s WHERE s.id = ai_message.session_id)
                        OR EXISTS (SELECT 1 FROM ai_session s WHERE s.id = ai_message.session_id AND s.last_at < ?1))",
                rusqlite::params![plan.ai_cutoff_ms],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "DELETE FROM ai_session WHERE last_at < ?1",
                rusqlite::params![plan.ai_cutoff_ms],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::civil_from_days;

    /// 已知日期点核对 Howard Hinnant 换算（days since 1970-01-01）。
    #[test]
    fn civil_from_days_known_points() {
        // 1970-01-01 = 0
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2000-01-01 = 10957（含 1972..1996 间 7 个闰日）
        assert_eq!(civil_from_days(10957), (2000, 1, 1));
        // 2024-02-29（闰年）
        assert_eq!(civil_from_days(19782), (2024, 2, 29));
        // 2024-03-01
        assert_eq!(civil_from_days(19783), (2024, 3, 1));
        // 2026-10-12
        assert_eq!(civil_from_days(20738), (2026, 10, 12));
        // 年末边界 2026-12-31
        assert_eq!(civil_from_days(20818), (2026, 12, 31));
    }
}
