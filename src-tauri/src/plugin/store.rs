// 插件持久化：plugin_registry / plugin_kv / plugin_audit 的 DB 操作。
use rusqlite::Connection;
use serde::Serialize;

use crate::ai::now_millis;
use crate::plugin::manifest::Manifest;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRow {
    pub plugin_id: String,
    pub name: String,
    pub version: String,
    pub api_version: i64,
    pub builtin: bool,
    pub source_path: String,
    pub enabled: bool,
    pub signed: bool,
    pub hash: String,
    pub permissions: Vec<String>,
    pub status: String, // disabled / ready / error
    pub error_msg: String,
}

fn read_row(conn: &Connection, plugin_id: &str) -> Option<PluginRow> {
    conn.query_row(
        "SELECT plugin_id,name,version,api_version,builtin,source_path,enabled,signed,hash,
                permissions,status,error_msg
         FROM plugin_registry WHERE plugin_id=?1",
        rusqlite::params![plugin_id],
        |r| {
            let perm_json: String = r.get(9)?;
            let perms: Vec<String> = serde_json::from_str(&perm_json).unwrap_or_default();
            Ok(PluginRow {
                plugin_id: r.get(0)?,
                name: r.get(1)?,
                version: r.get(2)?,
                api_version: r.get(3)?,
                builtin: r.get::<_, i64>(4)? != 0,
                source_path: r.get(5)?,
                enabled: r.get::<_, i64>(6)? != 0,
                signed: r.get::<_, i64>(7)? != 0,
                hash: r.get(8)?,
                permissions: perms,
                status: r.get(10)?,
                error_msg: r.get(11)?,
            })
        },
    )
    .ok()
}

pub fn list(conn: &Connection) -> Vec<PluginRow> {
    let ids: Vec<String> = {
        let mut s = conn
            .prepare("SELECT plugin_id FROM plugin_registry ORDER BY builtin DESC, name ASC")
            .ok();
        match s.as_mut() {
            Some(st) => st
                .query_map([], |r| r.get::<_, String>(0))
                .into_iter()
                .flatten()
                .flatten()
                .collect(),
            None => vec![],
        }
    };
    ids.iter().filter_map(|id| read_row(conn, id)).collect()
}

pub fn get(conn: &Connection, plugin_id: &str) -> Option<PluginRow> {
    read_row(conn, plugin_id)
}

/// 登记（存在则更新 manifest 快照，保留 enabled 状态）。
pub fn upsert(
    conn: &Connection,
    m: &Manifest,
    source_path: &str,
    builtin: bool,
    hash: &str,
    signed: bool,
) -> Result<(), String> {
    let now = now_millis();
    let perm_json = serde_json::to_string(&m.permissions).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT INTO plugin_registry
           (plugin_id,name,version,api_version,builtin,source_path,enabled,signed,signature,hash,
            permissions,status,error_msg,installed_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,0,?7,'',?8,?9,'disabled','',?10,?10)
         ON CONFLICT(plugin_id) DO UPDATE SET
           name=excluded.name, version=excluded.version, api_version=excluded.api_version,
           source_path=excluded.source_path, signed=excluded.signed, hash=excluded.hash,
           permissions=excluded.permissions, updated_at=excluded.updated_at",
        rusqlite::params![
            m.id,
            m.name,
            m.version,
            m.api_version,
            builtin as i64,
            source_path,
            signed as i64,
            hash,
            perm_json,
            now
        ],
    )
    .map(|_| ())
    .map_err(|e| format!("登记插件失败: {e}"))
}

pub fn set_state(
    conn: &Connection,
    plugin_id: &str,
    enabled: bool,
    status: &str,
    error_msg: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE plugin_registry SET enabled=?1,status=?2,error_msg=?3,updated_at=?4
         WHERE plugin_id=?5",
        rusqlite::params![enabled as i64, status, error_msg, now_millis(), plugin_id],
    )
    .map(|_| ())
    .map_err(|e| format!("更新插件状态失败: {e}"))
}

pub fn delete(conn: &Connection, plugin_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM plugin_registry WHERE plugin_id=?1 AND builtin=0",
        rusqlite::params![plugin_id])
        .map(|_| ())
        .map_err(|e| format!("删除插件登记失败: {e}"))?;
    let _ = conn.execute("DELETE FROM plugin_kv WHERE plugin_id=?1", rusqlite::params![plugin_id]);
    Ok(())
}

// ===== 插件私有 KV（按 plugin_id 隔离）=====

pub fn kv_get(conn: &Connection, plugin_id: &str, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
        rusqlite::params![plugin_id, key],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

pub fn kv_set(conn: &Connection, plugin_id: &str, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO plugin_kv(plugin_id,key,value,updated_at) VALUES(?1,?2,?3,?4)
         ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        rusqlite::params![plugin_id, key, value, now_millis()],
    )
    .map(|_| ())
    .map_err(|e| format!("写入插件 KV 失败: {e}"))
}

// ===== 审计 =====

pub fn audit(conn: &Connection, plugin_id: &str, action: &str, method: &str, detail: &str) {
    let _ = conn.execute(
        "INSERT INTO plugin_audit(plugin_id,action,method,detail,created_at)
         VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![plugin_id, action, method, detail, now_millis()],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::manifest::parse_manifest;

    fn memdb() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE plugin_registry(
                id INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id TEXT UNIQUE, name TEXT, version TEXT,
                api_version INTEGER, builtin INTEGER, source_path TEXT, enabled INTEGER, signed INTEGER,
                signature TEXT, hash TEXT, permissions TEXT, status TEXT, error_msg TEXT,
                installed_at INTEGER, updated_at INTEGER);
             CREATE TABLE plugin_kv(id INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id TEXT, key TEXT,
                value TEXT, updated_at INTEGER, UNIQUE(plugin_id,key));
             CREATE TABLE plugin_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id TEXT,
                action TEXT, method TEXT, detail TEXT, created_at INTEGER);",
        )
        .unwrap();
        c
    }

    #[test]
    fn upsert_list_and_state() {
        let c = memdb();
        let m = parse_manifest(r#"{"id":"a.b","name":"X","version":"1","permissions":["store"]}"#).unwrap();
        upsert(&c, &m, "/p/a.b", false, "h", false).unwrap();
        assert_eq!(list(&c).len(), 1);
        set_state(&c, "a.b", true, "ready", "").unwrap();
        let row = get(&c, "a.b").unwrap();
        assert!(row.enabled && row.status == "ready");
    }

    #[test]
    fn kv_isolated_and_roundtrip() {
        let c = memdb();
        kv_set(&c, "p1", "k", "v1").unwrap();
        kv_set(&c, "p2", "k", "v2").unwrap();
        assert_eq!(kv_get(&c, "p1", "k").unwrap(), "v1");
        assert_eq!(kv_get(&c, "p2", "k").unwrap(), "v2");
        assert!(kv_get(&c, "p1", "missing").is_none());
    }

    #[test]
    fn builtin_cannot_be_deleted() {
        let c = memdb();
        let m = parse_manifest(r#"{"id":"a.b","name":"X","version":"1"}"#).unwrap();
        upsert(&c, &m, "/p", true, "h", false).unwrap();
        delete(&c, "a.b").unwrap();
        assert!(get(&c, "a.b").is_some());
    }
}
