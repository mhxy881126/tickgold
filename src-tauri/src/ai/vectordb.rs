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

use serde::Serialize;

#[derive(Serialize)]
pub struct KbStats {
    pub total: i64,
    pub embedded: i64,
    pub bytes_estimate: i64,
    pub by_type: Vec<(String, i64)>,
}

pub fn encode_f32(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}
pub fn decode_f32(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

pub struct NewChunk<'a> {
    pub text: &'a str,
    pub source_type: &'a str,
    pub source_ref: &'a str,
    pub title: &'a str,
    pub chunk_index: i64,
    pub content_hash: &'a str,
    pub model_hash: &'a str,
    pub embedding: Option<&'a [f32]>,
}

pub fn insert_chunk_ignore(c: &Connection, n: &NewChunk) -> Result<bool, String> {
    let (dim, blob, embedded) = match n.embedding {
        Some(v) if !v.is_empty() => (v.len() as i64, Some(encode_f32(v)), 1),
        _ => (0, None, 0),
    };
    let affected = c
        .execute(
            "INSERT OR IGNORE INTO kb_chunk
             (text,source_type,source_ref,title,chunk_index,content_hash,model_hash,dim,embedding,embedded,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            rusqlite::params![
                n.text,
                n.source_type,
                n.source_ref,
                n.title,
                n.chunk_index,
                n.content_hash,
                n.model_hash,
                dim,
                blob,
                embedded,
                crate::ai::now_millis()
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(affected > 0)
}

pub struct ChunkHit {
    pub id: i64,
    pub text: String,
    pub source_type: String,
    pub source_ref: String,
    pub title: String,
    pub chunk_index: i64,
    pub score: f32,
}

/// 暴力余弦 top-k（万级分块毫秒级）；只搜 dim 与查询一致且已嵌入的行。
pub fn search(
    c: &Connection,
    q: &[f32],
    k: i64,
    source_type: Option<&str>,
) -> Result<Vec<ChunkHit>, String> {
    if q.is_empty() {
        return Ok(vec![]);
    }
    let mut sql = String::from(
        "SELECT id,text,source_type,source_ref,title,chunk_index,embedding
         FROM kb_chunk WHERE embedded=1 AND dim=?1",
    );
    if source_type.is_some() {
        sql.push_str(" AND source_type=?2");
    }
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let mapper = |row: &rusqlite::Row| {
        let blob: Vec<u8> = row.get(6)?;
        Ok((
            ChunkHit {
                id: row.get(0)?,
                text: row.get(1)?,
                source_type: row.get(2)?,
                source_ref: row.get(3)?,
                title: row.get(4)?,
                chunk_index: row.get(5)?,
                score: 0.0,
            },
            blob,
        ))
    };
    let rows: Vec<(ChunkHit, Vec<u8>)> = match source_type {
        Some(t) => stmt
            .query_map(rusqlite::params![q.len() as i64, t], mapper)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?,
        None => stmt
            .query_map(rusqlite::params![q.len() as i64], mapper)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?,
    };
    let mut scored: Vec<ChunkHit> = rows
        .into_iter()
        .map(|(mut h, blob)| {
            h.score = cosine(q, &decode_f32(&blob));
            h
        })
        .collect();
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(k.max(1) as usize);
    Ok(scored)
}

pub fn delete_by_source_ref(
    c: &Connection,
    source_type: &str,
    source_ref: &str,
) -> Result<usize, String> {
    c.execute(
        "DELETE FROM kb_chunk WHERE source_type=?1 AND source_ref=?2",
        rusqlite::params![source_type, source_ref],
    )
    .map_err(|e| e.to_string())
}

pub fn list_sources(
    c: &Connection,
    source_type: &str,
) -> Result<Vec<(String, i64)>, String> {
    let mut stmt = c
        .prepare(
            "SELECT source_ref, count(*) FROM kb_chunk WHERE source_type=?1
             GROUP BY source_ref ORDER BY max(created_at) DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, i64)> = stmt
        .query_map(rusqlite::params![source_type], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn stats(c: &Connection) -> Result<KbStats, String> {
    let total: i64 = c.query_row("SELECT count(*) FROM kb_chunk", [], |r| r.get(0)).unwrap_or(0);
    let embedded: i64 =
        c.query_row("SELECT count(*) FROM kb_chunk WHERE embedded=1", [], |r| r.get(0)).unwrap_or(0);
    let bytes_estimate: i64 = c
        .query_row("SELECT COALESCE(sum(length(embedding)),0) FROM kb_chunk", [], |r| r.get(0))
        .unwrap_or(0);
    let mut stmt = c
        .prepare("SELECT source_type, count(*) FROM kb_chunk GROUP BY source_type")
        .map_err(|e| e.to_string())?;
    let by_type = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(KbStats { total, embedded, bytes_estimate, by_type })
}

pub struct PendingChunk {
    pub id: i64,
    pub text: String,
}
pub fn list_pending(c: &Connection, limit: i64) -> Result<Vec<PendingChunk>, String> {
    let mut stmt = c
        .prepare("SELECT id,text FROM kb_chunk WHERE embedded=0 ORDER BY id LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows: Vec<PendingChunk> = stmt
        .query_map(rusqlite::params![limit], |r| {
            Ok(PendingChunk { id: r.get(0)?, text: r.get(1)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn set_embedding(
    c: &Connection,
    id: i64,
    model_hash: &str,
    v: &[f32],
) -> Result<(), String> {
    c.execute(
        "UPDATE kb_chunk SET embedding=?1, dim=?2, model_hash=?3, embedded=1 WHERE id=?4",
        rusqlite::params![encode_f32(v), v.len() as i64, model_hash, id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// ===== 会话 / 消息 =====
#[derive(Serialize)]
pub struct SessionRow {
    pub id: i64,
    pub title: String,
    pub created_at: i64,
    pub last_at: i64,
}

pub fn create_session(c: &Connection, title: &str) -> Result<i64, String> {
    let now = crate::ai::now_millis();
    c.execute(
        "INSERT INTO ai_session(title,created_at,last_at) VALUES(?1,?2,?2)",
        rusqlite::params![title, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(c.last_insert_rowid())
}

pub fn touch_session(c: &Connection, id: i64, title: &str) -> Result<(), String> {
    c.execute(
        "UPDATE ai_session SET last_at=?1, title=CASE WHEN title='' THEN ?2 ELSE title END WHERE id=?3",
        rusqlite::params![crate::ai::now_millis(), title, id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn list_sessions(c: &Connection) -> Result<Vec<SessionRow>, String> {
    let mut stmt = c
        .prepare("SELECT id,title,created_at,last_at FROM ai_session ORDER BY last_at DESC")
        .map_err(|e| e.to_string())?;
    let rows: Vec<SessionRow> = stmt
        .query_map([], |r| {
            Ok(SessionRow { id: r.get(0)?, title: r.get(1)?, created_at: r.get(2)?, last_at: r.get(3)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn delete_session(c: &Connection, id: i64) -> Result<(), String> {
    c.execute("DELETE FROM ai_message WHERE session_id=?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    c.execute("DELETE FROM ai_session WHERE id=?1", rusqlite::params![id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub struct MsgRow {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub tool_calls: String,
    pub refs: String,
    pub created_at: i64,
}

pub fn insert_message(
    c: &Connection,
    session: i64,
    role: &str,
    content: &str,
    tool_calls: &str,
    refs: &str,
) -> Result<i64, String> {
    let now = crate::ai::now_millis();
    c.execute(
        "INSERT INTO ai_message(session_id,role,content,tool_calls,refs,created_at)
         VALUES(?1,?2,?3,?4,?5,?6)",
        rusqlite::params![session, role, content, tool_calls, refs, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(c.last_insert_rowid())
}

pub fn list_messages(c: &Connection, session: i64, limit: i64) -> Result<Vec<MsgRow>, String> {
    let mut stmt = c
        .prepare(
            "SELECT id,role,content,tool_calls,refs,created_at FROM ai_message
             WHERE session_id=?1 ORDER BY id DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let mut rows: Vec<MsgRow> = stmt
        .query_map(rusqlite::params![session, limit], |r| {
            Ok(MsgRow {
                id: r.get(0)?, role: r.get(1)?, content: r.get(2)?,
                tool_calls: r.get(3)?, refs: r.get(4)?, created_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    rows.reverse();
    Ok(rows)
}

// ===== 入库游标 =====
pub fn get_cursor(
    c: &Connection,
    source_type: &str,
    source_ref: &str,
) -> Result<Option<String>, String> {
    Ok(c.query_row(
        "SELECT cursor_hash FROM ai_index_state WHERE source_type=?1 AND source_ref=?2",
        rusqlite::params![source_type, source_ref],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten())
}

pub fn set_cursor(
    c: &Connection,
    source_type: &str,
    source_ref: &str,
    cursor_hash: &str,
) -> Result<(), String> {
    c.execute(
        "INSERT INTO ai_index_state(source_type,source_ref,cursor_hash,updated_at)
         VALUES(?1,?2,?3,?4)
         ON CONFLICT(source_type,source_ref) DO UPDATE SET cursor_hash=?3, updated_at=?4",
        rusqlite::params![source_type, source_ref, cursor_hash, crate::ai::now_millis()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
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

    #[test]
    fn chunk_dedupe_and_cosine_ranking() {
        let db = tmp_db("cosine");
        // 二维空间：q=(1,0)，a=(1,0) 最近、b=(0,1) 正交。
        let h1 = crate::ai::fnv1a_hex("文档A");
        let h2 = crate::ai::fnv1a_hex("文档B");
        assert!(insert_chunk_ignore(
            &db.0,
            &NewChunk {
                text: "正交文档", source_type: "manual_doc", source_ref: "b.md",
                title: "B", chunk_index: 0, content_hash: &h2,
                model_hash: "m1", embedding: Some(&[0.0, 1.0]),
            }
        )
        .unwrap());
        assert!(insert_chunk_ignore(
            &db.0,
            &NewChunk {
                text: "同向文档", source_type: "manual_doc", source_ref: "a.md",
                title: "A", chunk_index: 0, content_hash: &h1,
                model_hash: "m1", embedding: Some(&[1.0, 0.0]),
            }
        )
        .unwrap());
        // 同 hash 再插：忽略
        assert!(!insert_chunk_ignore(
            &db.0,
            &NewChunk {
                text: "同向文档", source_type: "manual_doc", source_ref: "a.md",
                title: "A", chunk_index: 0, content_hash: &h1,
                model_hash: "m1", embedding: Some(&[1.0, 0.0]),
            }
        )
        .unwrap());

        let hits = search(&db.0, &[1.0, 0.0], 5, Some("manual_doc")).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].source_ref, "a.md");
        assert!(hits[0].score > 0.99);
        assert!(hits[1].score.abs() < 1e-6);

        // 维度不一致的嵌入必须被过滤
        let h3 = crate::ai::fnv1a_hex("三维文档");
        insert_chunk_ignore(
            &db.0,
            &NewChunk {
                text: "三维", source_type: "catalyst", source_ref: "x", title: "",
                chunk_index: 0, content_hash: &h3, model_hash: "m1",
                embedding: Some(&[1.0, 0.0, 0.0]),
            },
        )
        .unwrap();
        let hits2 = search(&db.0, &[1.0, 0.0], 5, None).unwrap();
        assert_eq!(hits2.len(), 2);
    }

    #[test]
    fn pending_embed_set_and_stats() {
        let db = tmp_db("pending");
        let h = crate::ai::fnv1a_hex("待嵌入");
        insert_chunk_ignore(
            &db.0,
            &NewChunk {
                text: "hello", source_type: "catalyst", source_ref: "cat:1", title: "",
                chunk_index: 0, content_hash: &h, model_hash: "", embedding: None,
            },
        )
        .unwrap();
        let pend = list_pending(&db.0, 10).unwrap();
        assert_eq!(pend.len(), 1);
        set_embedding(&db.0, pend[0].id, "m1", &[0.5, 0.5]).unwrap();
        assert_eq!(list_pending(&db.0, 10).unwrap().len(), 0);
        let st = stats(&db.0).unwrap();
        assert_eq!(st.total, 1);
        assert_eq!(st.embedded, 1);
        assert_eq!(st.bytes_estimate, 8);
    }

    #[test]
    fn sessions_and_messages_cascade_delete() {
        let db = tmp_db("sess");
        let sid = create_session(&db.0, "").unwrap();
        insert_message(&db.0, sid, "user", "你好", "[]", "[]").unwrap();
        insert_message(&db.0, sid, "assistant", "在的", "[]", "[]").unwrap();
        touch_session(&db.0, sid, "你好").unwrap();
        let msgs = list_messages(&db.0, sid, 20).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user"); // 升序返回
        let sessions = list_sessions(&db.0).unwrap();
        assert_eq!(sessions[0].title, "你好");
        delete_session(&db.0, sid).unwrap();
        assert_eq!(list_sessions(&db.0).unwrap().len(), 0);
        assert_eq!(list_messages(&db.0, sid, 20).unwrap().len(), 0);
    }

    #[test]
    fn source_listing_and_delete() {
        let db = tmp_db("docs");
        for (i, txt) in ["x", "y"].iter().enumerate() {
            let h = crate::ai::fnv1a_hex(txt);
            insert_chunk_ignore(
                &db.0,
                &NewChunk {
                    text: txt, source_type: "manual_doc", source_ref: "战法.md", title: "战法",
                    chunk_index: i as i64, content_hash: &h, model_hash: "", embedding: None,
                },
            )
            .unwrap();
        }
        let srcs = list_sources(&db.0, "manual_doc").unwrap();
        assert_eq!(srcs, vec![("战法.md".to_string(), 2)]);
        assert_eq!(delete_by_source_ref(&db.0, "manual_doc", "战法.md").unwrap(), 2);
        assert_eq!(stats(&db.0).unwrap().total, 0);
    }
}
