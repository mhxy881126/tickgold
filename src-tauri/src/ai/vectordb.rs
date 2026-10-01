// AI 边车库 ai.db：分块/向量/会话/配置/索引游标。Rust 自管 user_version。
use rusqlite::Connection;
use std::path::Path;

pub struct AiDb(pub Connection);

const V1: &str = "
CREATE TABLE IF NOT EXISTS kb_chunk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  chunk_index INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL UNIQUE,
  model_hash TEXT NOT NULL DEFAULT '',
  dim INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,
  embedded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_source ON kb_chunk(source_type, source_ref);
";

const V2: &str = "
CREATE TABLE IF NOT EXISTS ai_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT NOT NULL DEFAULT '[]',
  refs TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_message_session ON ai_message(session_id, id);
";

const V3: &str = "
CREATE TABLE IF NOT EXISTS ai_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
";

const V4: &str = "
CREATE TABLE IF NOT EXISTS ai_index_state (
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  cursor_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_type, source_ref)
);
";

/// 打开（不存在则创建）边车库并迁移到最新版本。
pub fn open(path: &Path) -> Result<AiDb, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    migrate(&conn)?;
    Ok(AiDb(conn))
}

fn migrate(c: &Connection) -> Result<(), String> {
    let mut version: i64 =
        c.query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
    let batches: Vec<(i64, &str)> = vec![(1, V1), (2, V2), (3, V3), (4, V4)];
    for (v, sql) in batches {
        if version < v {
            c.execute_batch(sql).map_err(|e| format!("ai.db migration v{v} failed: {e}"))?;
            c.execute_batch(&format!("PRAGMA user_version = {v}"))
                .map_err(|e| e.to_string())?;
            version = v;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db(name: &str) -> AiDb {
        let p = std::env::temp_dir().join(format!("tickgold-ai-test-{}-{}.db", name, crate::ai::now_millis()));
        let _ = std::fs::remove_file(&p);
        open(&p).unwrap()
    }

    #[test]
    fn migrate_to_v4_and_idempotent() {
        let db = tmp_db("migrate");
        let v: i64 = db.0.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 4);
        for t in ["kb_chunk", "ai_session", "ai_message", "ai_config", "ai_index_state"] {
            let n: i64 = db
                .0
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [t],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "table {t} missing");
        }
        // 二次 open 不报错且不重建（user_version 仍 4）
        let path = std::env::temp_dir();
        let mut found = None;
        for e in std::fs::read_dir(path).unwrap() {
            let p = e.unwrap().path();
            if let Some(n) = p.file_name().and_then(|n| n.to_str()) {
                if n.starts_with("tickgold-ai-test-migrate-") && n.ends_with(".db") {
                    found = Some(p);
                }
            }
        }
        let db2 = open(&found.unwrap()).unwrap();
        let v2: i64 = db2.0.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v2, 4);
    }
}
