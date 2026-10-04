// 插件生态（v2.6）：发现 / 安装 / 启停 / 卸载 / RPC 编排 / 开发者模式。
// 安全：内置插件随包分发可信；用户插件 beta 需开发者模式；权限在 host/permission 强制；
// 逻辑插件为同步纯函数，所有 async（行情/HTTP/KV/信号）在 Rust 侧。
pub mod engine;
pub mod host;
pub mod manifest;
pub mod permission;
pub mod store;

use engine::PluginEngine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ai::maindb;

pub struct PluginManager {
    dir: Mutex<PathBuf>,
    engines: Mutex<HashMap<String, Arc<PluginEngine>>>,
}

impl Default for PluginManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginManager {
    pub fn new() -> Self {
        Self {
            dir: Mutex::new(PathBuf::new()),
            engines: Mutex::new(HashMap::new()),
        }
    }

    pub fn init_with_dir(&self, dir: &Path) {
        let _ = std::fs::create_dir_all(plugins_dir(dir));
        *self.dir_locked() = dir.to_path_buf();
    }

    fn dir_locked(&self) -> std::sync::MutexGuard<'_, PathBuf> {
        self.dir.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn engine_map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<PluginEngine>>> {
        self.engines.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn plugins_dir(dir: &Path) -> PathBuf {
    dir.join("plugins")
}
fn dev_flag(dir: &Path) -> PathBuf {
    plugins_dir(dir).join(".dev-mode")
}
fn is_dev(dir: &Path) -> bool {
    dev_flag(dir).exists()
}

fn checkpoint(conn: &rusqlite::Connection) {
    let _ = conn.execute("PRAGMA wal_checkpoint(PASSIVE)", []);
}

/// 简易 FNV-1a（64）→ 十六进制，作为 beta 完整性指纹（正式签名第 2 步）。
fn fnv_hex(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// 内置插件目录（打包后 resource_dir；开发态 src-tauri/resources）。
fn builtin_dir(app: &AppHandle) -> Option<PathBuf> {
    let rel = Path::new("resources").join("plugins");
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join(&rel);
        if p.exists() {
            return Some(p);
        }
    }
    [
        PathBuf::from("src-tauri").join(&rel),
        PathBuf::from("../src-tauri").join(&rel),
    ]
    .into_iter()
    .find(|c| c.exists())
}

/// 扫描一个根目录下的各插件子目录并登记。
fn discover(conn: &rusqlite::Connection, root: &Path, builtin: bool) -> Result<usize, String> {
    if !root.exists() {
        return Ok(0);
    }
    let mut n = 0;
    for ent in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let d = ent.map_err(|e| e.to_string())?.path();
        let hidden = d.file_name().map(|f| f.to_string_lossy().starts_with('.')) == Some(true);
        if !d.is_dir() || hidden {
            continue;
        }
        let mf = d.join("plugin.json");
        if !mf.exists() {
            continue;
        }
        let text = std::fs::read_to_string(&mf).map_err(|e| e.to_string())?;
        let m = manifest::parse_manifest(&text)?;
        let hash = fnv_hex(text.as_bytes());
        store::upsert(conn, &m, d.to_string_lossy().as_ref(), builtin, &hash, false)?;
        n += 1;
    }
    Ok(n)
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for ent in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let e = ent.map_err(|x| x.to_string())?;
        let f = e.path();
        let t = dst.join(e.file_name());
        if f.is_dir() {
            copy_dir(&f, &t)?;
        } else {
            std::fs::copy(&f, &t).map_err(|x| x.to_string())?;
        }
    }
    Ok(())
}

// ===== 启停核心（命令与 reload 共用）=====

async fn do_enable(app: &AppHandle, mgr: &PluginManager, plugin_id: &str) -> Result<(), String> {
    let dir = mgr.dir_locked().clone();
    let dev = is_dev(&dir);
    let conn = maindb::open_readwrite(&dir)?;
    let row = store::get(&conn, plugin_id).ok_or("插件未登记，请先扫描 / 安装")?;
    if !row.builtin && !dev {
        return Err("非内置插件需先在设置开启「开发者模式」（beta）".to_string());
    }
    let src_root = PathBuf::from(&row.source_path);
    let mf_text = std::fs::read_to_string(src_root.join("plugin.json")).map_err(|e| e.to_string())?;
    let m = manifest::parse_manifest(&mf_text)?;
    if let Some(main_rel) = m.main {
        let main_src = std::fs::read_to_string(src_root.join(main_rel)).map_err(|e| e.to_string())?;
        let engine = PluginEngine::start(main_src)
            .await
            .map_err(|e| format!("插件启用失败：{e}"))?;
        mgr.engine_map().insert(plugin_id.to_string(), Arc::new(engine));
    }
    store::set_state(&conn, plugin_id, true, "ready", "")?;
    store::audit(&conn, plugin_id, "enable", "", "");
    checkpoint(&conn);
    let _ = app.emit("plugin:event", json!({ "pluginId": plugin_id, "enabled": true }));
    Ok(())
}

async fn do_disable(app: &AppHandle, mgr: &PluginManager, plugin_id: &str) -> Result<(), String> {
    let dir = mgr.dir_locked().clone();
    let arc = mgr.engine_map().remove(plugin_id);
    if let Some(arc) = arc {
        if let Ok(engine) = Arc::try_unwrap(arc) {
            engine.shutdown().await;
        }
    }
    let conn = maindb::open_readwrite(&dir)?;
    store::set_state(&conn, plugin_id, false, "disabled", "")?;
    store::audit(&conn, plugin_id, "disable", "", "");
    checkpoint(&conn);
    let _ = app.emit("plugin:event", json!({ "pluginId": plugin_id, "enabled": false }));
    Ok(())
}

// ================= Tauri 命令 =================

#[tauri::command]
pub fn plugin_list(mgr: State<'_, PluginManager>) -> Result<Vec<store::PluginRow>, String> {
    let dir = mgr.dir_locked().clone();
    let conn = maindb::open_readonly(&dir)?;
    Ok(store::list(&conn))
}

#[tauri::command]
pub fn plugin_scan(app: AppHandle, mgr: State<'_, PluginManager>) -> Result<usize, String> {
    let dir = mgr.dir_locked().clone();
    let conn = maindb::open_readwrite(&dir)?;
    let mut n = discover(&conn, &plugins_dir(&dir), false)?;
    if let Some(b) = builtin_dir(&app) {
        n += discover(&conn, &b, true)?;
    }
    checkpoint(&conn);
    Ok(n)
}

#[tauri::command]
pub fn plugin_install(from_path: String, mgr: State<'_, PluginManager>) -> Result<String, String> {
    let dir = mgr.dir_locked().clone();
    let src = PathBuf::from(&from_path);
    if from_path.to_ascii_lowercase().ends_with(".tgplugin") {
        return Err("beta 暂不支持 .tgplugin 压缩包，请先解压为含 plugin.json 的文件夹".to_string());
    }
    if !src.is_dir() {
        return Err("安装源不是文件夹".to_string());
    }
    let mf_text = std::fs::read_to_string(src.join("plugin.json"))
        .map_err(|e| format!("未找到可读的 plugin.json：{e}"))?;
    let m = manifest::parse_manifest(&mf_text)?;
    let dest = plugins_dir(&dir).join(&m.id);
    copy_dir(&src, &dest)?;
    let conn = maindb::open_readwrite(&dir)?;
    let hash = fnv_hex(mf_text.as_bytes());
    store::upsert(&conn, &m, dest.to_string_lossy().as_ref(), false, &hash, false)?;
    store::audit(&conn, &m.id, "install", "", &from_path);
    checkpoint(&conn);
    Ok(m.id)
}

#[tauri::command]
pub async fn plugin_enable(
    plugin_id: String,
    app: AppHandle,
    mgr: State<'_, PluginManager>,
) -> Result<(), String> {
    do_enable(&app, mgr.inner(), &plugin_id).await
}

#[tauri::command]
pub async fn plugin_disable(
    plugin_id: String,
    app: AppHandle,
    mgr: State<'_, PluginManager>,
) -> Result<(), String> {
    do_disable(&app, mgr.inner(), &plugin_id).await
}

#[tauri::command]
pub async fn plugin_uninstall(
    plugin_id: String,
    app: AppHandle,
    mgr: State<'_, PluginManager>,
) -> Result<(), String> {
    let dir = mgr.dir_locked().clone();
    let conn0 = maindb::open_readonly(&dir)?;
    let row = store::get(&conn0, &plugin_id).ok_or("插件未登记")?;
    if row.builtin {
        return Err("内置插件不可卸载（可停用）".to_string());
    }
    drop(conn0);

    do_disable(&app, mgr.inner(), &plugin_id).await?;

    let target = plugins_dir(&dir).join(&plugin_id);
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("删除插件目录失败：{e}"))?;
    }
    let conn = maindb::open_readwrite(&dir)?;
    store::delete(&conn, &plugin_id)?;
    store::audit(&conn, &plugin_id, "uninstall", "", "");
    checkpoint(&conn);
    let _ = app.emit("plugin:event", json!({ "pluginId": plugin_id, "removed": true }));
    Ok(())
}

#[tauri::command]
pub fn plugin_get_dev_mode(mgr: State<'_, PluginManager>) -> Result<bool, String> {
    let dir = mgr.dir_locked().clone();
    Ok(is_dev(&dir))
}

#[tauri::command]
pub fn plugin_set_dev_mode(on: bool, mgr: State<'_, PluginManager>) -> Result<(), String> {
    let dir = mgr.dir_locked().clone();
    let flag = dev_flag(&dir);
    if on {
        std::fs::write(&flag, b"dev").map_err(|e| e.to_string())?;
    } else if flag.exists() {
        std::fs::remove_file(&flag).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn plugin_reload(
    plugin_id: String,
    app: AppHandle,
    mgr: State<'_, PluginManager>,
) -> Result<(), String> {
    let dir = mgr.dir_locked().clone();
    if !is_dev(&dir) {
        return Err("热重载仅在开发者模式下可用".to_string());
    }
    let inner = mgr.inner();
    do_disable(&app, inner, &plugin_id).await?;
    do_enable(&app, inner, &plugin_id).await
}

#[tauri::command]
pub fn plugin_read_asset(
    plugin_id: String,
    rel_path: String,
    mgr: State<'_, PluginManager>,
) -> Result<String, String> {
    let dir = mgr.dir_locked().clone();
    let conn = maindb::open_readonly(&dir)?;
    let row = store::get(&conn, &plugin_id).ok_or("插件未登记")?;
    if Path::new(&rel_path).components().count() != 1 || rel_path.contains("..") {
        return Err("非法资源路径".to_string());
    }
    let lower = rel_path.to_ascii_lowercase();
    const ALLOWED: [&str; 6] = [".js", ".json", ".svg", ".css", ".html", ".txt"];
    if !ALLOWED.iter().any(|e| lower.ends_with(e)) {
        return Err("不允许读取该类型资源".to_string());
    }
    let p = PathBuf::from(&row.source_path).join(&rel_path);
    let bytes = std::fs::read(&p).map_err(|e| format!("读取失败：{e}"))?;
    if bytes.len() > 512 * 1024 {
        return Err("资源超过 512KB".to_string());
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// datasource 实际 HTTP（权限已在调用前 check）。
async fn ds_http(desc: &Value) -> Result<(u16, String), String> {
    let url = desc.get("url").and_then(|x| x.as_str()).ok_or("buildRequest 未返回 url")?;
    let method = desc.get("method").and_then(|x| x.as_str()).unwrap_or("GET").to_uppercase();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = match method.as_str() {
        "POST" => client.post(url),
        "GET" => client.get(url),
        other => return Err(format!("不支持的方法：{other}")),
    };
    if let Some(body) = desc.get("body").and_then(|x| x.as_str()) {
        req = req.body(body.to_string());
    }
    let resp = req.send().await.map_err(|e| format!("数据源请求失败：{e}"))?;
    let status = resp.status().as_u16();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > host::MAX_HTTP_BYTES {
        return Err("响应超过 2MB".to_string());
    }
    Ok((status, String::from_utf8_lossy(&bytes).to_string()))
}

#[tauri::command]
pub async fn plugin_rpc(
    plugin_id: String,
    method: String,
    params: Value,
    app: AppHandle,
    mgr: State<'_, PluginManager>,
) -> Result<Value, String> {
    let dir = mgr.dir_locked().clone();
    let conn = maindb::open_readonly(&dir)?;
    let row = store::get(&conn, &plugin_id).ok_or("插件未登记")?;
    if !row.enabled {
        return Err("插件未启用".to_string());
    }
    let perms = row.permissions.clone();
    drop(conn);

    match method.as_str() {
        "indicator.compute" => {
            if !permission::has_scope(&perms, "kline:read") {
                return Err("缺少权限：kline:read".to_string());
            }
            let ind_id = params.get("indicator").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let code = params.get("code").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let period = params.get("period").and_then(|x| x.as_i64()).unwrap_or(5);
            let count = params.get("count").and_then(|x| x.as_i64()).unwrap_or(60);
            let kline = crate::market::get_kline(code.clone(), period, count).await?;
            let ctx = json!({ "code": code, "kline": kline });
            engine_arc(mgr.inner(), &plugin_id)?.compute(&ind_id, &ctx).await
        }
        "datasource.fetch" => {
            let ds_id = params.get("datasource").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let inner = params.get("params").cloned().unwrap_or(Value::Null);
            let e = engine_arc(mgr.inner(), &plugin_id)?;
            let desc = e.build_request(&ds_id, &inner).await?;
            let url = desc.get("url").and_then(|x| x.as_str()).unwrap_or("").to_string();
            permission::check_http(&perms, &url)?;
            let (status, body) = ds_http(&desc).await?;
            e.parse_response(&ds_id, &json!({ "status": status, "body": body })).await
        }
        other => host::run_basic(&app, &dir, &perms, &plugin_id, other, params).await,
    }
}

fn engine_arc(mgr: &PluginManager, plugin_id: &str) -> Result<Arc<PluginEngine>, String> {
    mgr.engine_map()
        .get(plugin_id)
        .cloned()
        .ok_or_else(|| "插件逻辑未运行（缺少 main.js 或未成功启用）".to_string())
}
