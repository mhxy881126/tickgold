// Host API 执行层：权限校验 + 实际能力调用。QuickJS 与前端 iframe 共用同一实现。
// 注意：所有 host 函数必须 fail-soft，禁止 panic（release 为 panic=abort）。
use crate::ai::bridge::{self, SignalInput};
use crate::ai::maindb;
use crate::plugin::{permission, store};
use serde_json::{json, Value};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub const MAX_HTTP_BYTES: usize = 2 * 1024 * 1024;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 北京（UTC+8）今天 YYYY-MM-DD（Howard Hinnant civil-from-days）。
fn beijing_today() -> String {
    let z = now_secs() + 8 * 3600;
    let days = z.div_euclid(86400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn checkpoint(conn: &rusqlite::Connection) {
    let _ = conn.execute("PRAGMA wal_checkpoint(PASSIVE)", []);
}

fn p_str(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn p_i64(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(|x| x.as_i64()).unwrap_or(0)
}
fn p_f64(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

/// 执行基础 host API（indicator/datasource 由 engine 处理，不在此列）。
pub async fn run_basic(
    app: &AppHandle,
    dir: &Path,
    perms: &[String],
    plugin_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    macro_rules! need {
        ($scope:expr) => {{
            if !permission::has_scope(perms, $scope) {
                return Err(format!("缺少权限：{}", $scope));
            }
        }};
    }

    match method {
        "quotes.get" => {
            need!("quotes:read");
            let codes: Vec<String> = params
                .get("codes")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|c| c.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let q = crate::market::get_quotes(codes).await?;
            Ok(json!(q))
        }
        "kline.get" => {
            need!("kline:read");
            let k = crate::market::get_kline(
                p_str(&params, "code"),
                p_i64(&params, "period"),
                p_i64(&params, "count"),
            )
            .await?;
            Ok(json!(k))
        }
        "kline.minute" => {
            need!("kline:read");
            let k = crate::market::get_minute(p_str(&params, "code")).await?;
            Ok(json!(k))
        }
        "watchlist.list" => {
            need!("watchlist:read");
            let conn = maindb::open_readonly(dir)?;
            let mut stmt = conn
                .prepare("SELECT code,name FROM stocks ORDER BY group_id,sort_order,id")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(json!({
                        "code": r.get::<_, String>(0)?,
                        "name": r.get::<_, String>(1)?
                    }))
                })
                .map_err(|e| e.to_string())?;
            let out: Vec<Value> = rows.flatten().collect();
            Ok(json!(out))
        }
        "signal.create" => {
            need!("signal:create");
            let code = p_str(&params, "code");
            if code.is_empty() {
                return Err("code 不能为空".to_string());
            }
            let side = p_str(&params, "side").to_uppercase();
            let side = if side == "SELL" { "SELL" } else { "BUY" };
            let name = p_str(&params, "name");
            let input = SignalInput {
                code: code.clone(),
                name: if name.is_empty() { code.clone() } else { name },
                side: side.to_string(),
                source: format!("plugin:{plugin_id}"),
                model_version: "plugin".to_string(),
                strategy: "plugin".to_string(),
                confidence: p_f64(&params, "confidence").clamp(0.0, 1.0),
                ref_price: p_f64(&params, "refPrice"),
                vol: p_i64(&params, "vol"),
                reason: p_str(&params, "reason"),
                trade_date: beijing_today(),
            };
            let conn = maindb::open_readwrite(dir)?;
            let sig = bridge::create_ticket(&conn, input)
                .ok_or("信号创建失败（可能已有同向待确认单或参考价非法）")?;
            store::audit(&conn, plugin_id, "signal.create", "signal.create", &sig);
            checkpoint(&conn);
            let _ = app.emit("signal:new", json!({ "sigId": sig.clone() }));
            Ok(json!({ "sigId": sig }))
        }
        "store.get" => {
            need!("store");
            let conn = maindb::open_readonly(dir)?;
            match store::kv_get(&conn, plugin_id, &p_str(&params, "key")) {
                Some(s) => Ok(serde_json::from_str(&s).unwrap_or(Value::String(s))),
                None => Ok(Value::Null),
            }
        }
        "store.set" => {
            need!("store");
            let key = p_str(&params, "key");
            let value = params.get("value").cloned().unwrap_or(Value::Null).to_string();
            let conn = maindb::open_readwrite(dir)?;
            store::kv_set(&conn, plugin_id, &key, &value)?;
            store::audit(&conn, plugin_id, "store.set", "store.set", &key);
            checkpoint(&conn);
            Ok(json!({ "ok": true }))
        }
        "http.fetch" => {
            let url = p_str(&params, "url");
            permission::check_http(perms, &url)?;
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .map_err(|e| e.to_string())?;
            let method = p_str(&params, "method").to_uppercase();
            let req = match method.as_str() {
                "POST" => client.post(&url),
                "GET" | "" => client.get(&url),
                other => return Err(format!("不支持的 HTTP 方法：{other}")),
            };
            let req = if let Some(b) = params.get("body").and_then(|x| x.as_str()) {
                req.body(b.to_string())
            } else {
                req
            };
            let resp = req.send().await.map_err(|e| format!("请求失败：{e}"))?;
            let status = resp.status().as_u16();
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            if bytes.len() > MAX_HTTP_BYTES {
                return Err("响应体超过 2MB 上限".to_string());
            }
            let text = String::from_utf8_lossy(&bytes).to_string();
            let body = serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text));
            store_audit_http(dir, plugin_id, &url, status)?;
            Ok(json!({ "status": status, "body": body }))
        }
        "log.info" | "log.warn" | "log.error" => {
            let msg = p_str(&params, "message");
            match method {
                "log.warn" => log::warn!("[plugin:{plugin_id}] {msg}"),
                "log.error" => log::error!("[plugin:{plugin_id}] {msg}"),
                _ => log::info!("[plugin:{plugin_id}] {msg}"),
            }
            Ok(json!({ "ok": true }))
        }
        other => Err(format!("未知 host 方法：{other}")),
    }
}

fn store_audit_http(dir: &Path, plugin_id: &str, url: &str, status: u16) -> Result<(), String> {
    let conn = maindb::open_readwrite(dir)?;
    store::audit(&conn, plugin_id, "http.fetch", "http.fetch", &format!("{status} {url}"));
    checkpoint(&conn);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beijing_date_well_formed() {
        let s = beijing_today();
        assert_eq!(s.len(), 10);
        assert_eq!(s.as_bytes()[4], b'-');
        assert_eq!(s.as_bytes()[7], b'-');
    }
}
