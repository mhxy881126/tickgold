// 数据备份 / 恢复中心（v2.29，P2-3 增强）
// 备份对象（均位于数据目录）：
//   - stock-dock.db（主库，含 broker_order 等全部业务表）
//   - ai.db（知识库 / 向量库）
//   - broker_config.json（券商对接配置）
//   - config.json（前端从 localStorage 导出，由 write_config 写入）
// 每个备份集为 backups/full-<ts>/ 目录，并含 manifest.json（逐文件大小 + SHA256）。
// 恢复前先按 manifest 做完整性硬校验；通过后暂存文件，由退出脚本替换并重启，
// 旧文件加 .pre-restore 留证，便于回滚。
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub(crate) async fn backup_full_create(app: AppHandle) -> Result<BackupSetInfo, String> {
    create(app).await
}

#[tauri::command]
pub(crate) fn backup_full_list(app: AppHandle) -> Result<Vec<BackupSetInfo>, String> {
    list(app)
}

#[tauri::command]
pub(crate) async fn backup_write_config(
    app: AppHandle,
    id: String,
    content: String,
) -> Result<(), String> {
    write_config(app, id, content).await
}

#[tauri::command]
pub(crate) async fn backup_read_config(app: AppHandle, id: String) -> Result<String, String> {
    read_config(app, id).await
}

#[tauri::command]
pub(crate) async fn backup_full_restore(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    restore(app, id).await
}

#[tauri::command]
pub(crate) async fn backup_full_delete(app: AppHandle, id: String) -> Result<(), String> {
    remove(app, id).await
}

/// 重启后取回暂存的配置快照（恢复流程遗留），取出后删除暂存文件。
#[tauri::command]
pub(crate) async fn backup_take_pending_config(app: AppHandle) -> Result<String, String> {
    let p = data_dir(&app)?.join("config.restore-staging");
    if !p.exists() {
        return Ok(String::new());
    }
    let content = tokio::fs::read_to_string(&p)
        .await
        .map_err(|e| e.to_string())?;
    let _ = tokio::fs::remove_file(&p).await;
    Ok(content)
}

const MAIN_DB: &str = "stock-dock.db";
const AI_DB: &str = "ai.db";
const BROKER_CFG: &str = "broker_config.json";
const CONFIG_JSON: &str = "config.json";
const MANIFEST: &str = "manifest.json";
const KEEP_SETS: usize = 8;
const BACKUP_VERSION: u32 = 1;

/// 数据目录中被整文件备份的文件（不含前端 localStorage 导出的 config.json）。
const DATA_FILES: [&str; 3] = [MAIN_DB, AI_DB, BROKER_CFG];
/// 描述 / 校验时纳入的全部逻辑文件。
const ALL_LOGICAL: [&str; 4] = [MAIN_DB, AI_DB, BROKER_CFG, CONFIG_JSON];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupFileInfo {
    name: String,
    size: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupSetInfo {
    id: String,
    created_ms: u128,
    verified: bool,
    files: Vec<BackupFileInfo>,
    total_bytes: u64,
}

#[derive(Serialize, Deserialize, Clone)]
struct ManifestEntry {
    name: String,
    size: u64,
    sha256: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct Manifest {
    version: u32,
    created_ms: u128,
    files: Vec<ManifestEntry>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn backups_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("backups"))
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(data);
    let digest = h.finalize();
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// 扫描备份集目录，写出 manifest.json（逐文件大小 + SHA256）。
fn build_manifest(dir: &Path) -> Result<(), String> {
    let mut entries: Vec<ManifestEntry> = Vec::new();
    for name in ALL_LOGICAL {
        let p = dir.join(name);
        if p.exists() {
            let data = std::fs::read(&p).map_err(|e| format!("读取 {name} 失败: {e}"))?;
            entries.push(ManifestEntry {
                name: name.to_string(),
                size: data.len() as u64,
                sha256: sha256_hex(&data),
            });
        }
    }
    let m = Manifest {
        version: BACKUP_VERSION,
        created_ms: now_millis(),
        files: entries,
    };
    let json = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(MANIFEST), json).map_err(|e| e.to_string())?;
    Ok(())
}

/// 快速校验：manifest 存在且可解析、每个文件存在且大小一致（不计算 hash，供列表展示）。
fn check_manifest_fast(dir: &Path) -> Result<Manifest, String> {
    let mp = dir.join(MANIFEST);
    if !mp.exists() {
        return Err("备份集缺少 manifest.json".to_string());
    }
    let raw = std::fs::read(&mp).map_err(|e| format!("读取 manifest 失败: {e}"))?;
    let m: Manifest =
        serde_json::from_slice(&raw).map_err(|e| format!("manifest 解析失败: {e}"))?;
    if m.files.is_empty() {
        return Err("manifest 中没有任何文件记录".to_string());
    }
    for f in &m.files {
        let p = dir.join(&f.name);
        let md = std::fs::metadata(&p)
            .map_err(|_| format!("{} 缺失，备份可能已损坏", f.name))?;
        if md.len() != f.size {
            return Err(format!("{} 大小不一致，备份可能已损坏", f.name));
        }
    }
    Ok(m)
}

/// 恢复前硬校验：在快速校验基础上逐文件重算 SHA256，任一不符即拒绝恢复。
fn verify_set(dir: &Path) -> Result<Manifest, String> {
    let m = check_manifest_fast(dir).map_err(|e| format!("{e}，为安全起见拒绝恢复"))?;
    for f in &m.files {
        let data = std::fs::read(dir.join(&f.name))
            .map_err(|e| format!("读取 {} 失败: {}", f.name, e))?;
        if sha256_hex(&data) != f.sha256 {
            return Err(format!("{} 校验和不一致，备份可能已损坏或被篡改", f.name));
        }
    }
    Ok(m)
}

/// 备份集是否通过快速完整性校验（列表展示用）。
fn is_verified(dir: &Path) -> bool {
    check_manifest_fast(dir).is_ok()
}

fn describe_set(dir: &Path) -> Option<BackupSetInfo> {
    let id = dir.file_name()?.to_string_lossy().to_string();
    let created = std::fs::metadata(dir).ok()?.modified().ok()?;
    let created_ms = created
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut files = Vec::new();
    let mut total = 0u64;
    for name in ALL_LOGICAL {
        let p = dir.join(name);
        if let Ok(md) = std::fs::metadata(&p) {
            files.push(BackupFileInfo {
                name: name.to_string(),
                size: md.len(),
            });
            total += md.len();
        }
    }
    if files.is_empty() {
        return None;
    }
    Some(BackupSetInfo {
        id,
        created_ms,
        verified: is_verified(dir),
        files,
        total_bytes: total,
    })
}

/// 创建备份集：复制数据目录中的整文件（config.json 随后由前端通过 write_config 写入）。
pub async fn create(app: AppHandle) -> Result<BackupSetInfo, String> {
    let base = backups_dir(&app)?;
    tokio::fs::create_dir_all(&base)
        .await
        .map_err(|e| e.to_string())?;
    let id = format!("full-{}", now_millis());
    let set_dir = base.join(&id);
    tokio::fs::create_dir_all(&set_dir)
        .await
        .map_err(|e| e.to_string())?;

    let ddir = data_dir(&app)?;
    for name in DATA_FILES {
        let src = ddir.join(name);
        if src.exists() {
            tokio::fs::copy(&src, set_dir.join(name))
                .await
                .map_err(|e| format!("复制 {name} 失败: {e}"))?;
        }
    }

    // 生成 manifest（此时可能还没有 config.json，write_config 后会重建）
    build_manifest(&set_dir)?;

    prune_old_sets(&base).await;

    describe_set(&set_dir).ok_or_else(|| "备份集创建后无法读取".to_string())
}

/// 列出全部备份集（新→旧）。
pub fn list(app: AppHandle) -> Result<Vec<BackupSetInfo>, String> {
    let base = backups_dir(&app)?;
    let mut sets: Vec<(std::time::SystemTime, BackupSetInfo)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&base) {
        for ent in rd.flatten() {
            let p = ent.path();
            if !p.is_dir() {
                continue;
            }
            if let Some(info) = describe_set(&p) {
                if let Ok(md) = ent.metadata() {
                    if let Ok(modified) = md.modified() {
                        sets.push((modified, info));
                    }
                }
            }
        }
    }
    sets.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
    Ok(sets.into_iter().map(|(_, i)| i).collect())
}

async fn prune_old_sets(base: &Path) {
    let Ok(mut rd) = tokio::fs::read_dir(base).await else {
        return;
    };
    let mut items: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    while let Ok(Some(ent)) = rd.next_entry().await {
        let p = ent.path();
        if p.is_dir() {
            if let Ok(md) = ent.metadata().await {
                if let Ok(modified) = md.modified() {
                    items.push((modified, p));
                }
            }
        }
    }
    items.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
    for (_, p) in items.iter().skip(KEEP_SETS) {
        let _ = tokio::fs::remove_dir_all(p).await;
    }
}

/// 向备份集写入配置快照（前端 localStorage 导出的 JSON），随后重建 manifest。
pub async fn write_config(app: AppHandle, id: String, content: String) -> Result<(), String> {
    let set_dir = backups_dir(&app)?.join(&id);
    if !set_dir.is_dir() {
        return Err("备份集不存在".to_string());
    }
    tokio::fs::write(set_dir.join(CONFIG_JSON), content.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    // 配置补全后重建 manifest，使校验覆盖 config.json。
    build_manifest(&set_dir)
}

pub async fn read_config(app: AppHandle, id: String) -> Result<String, String> {
    let p = backups_dir(&app)?.join(&id).join(CONFIG_JSON);
    if !p.exists() {
        return Ok(String::new());
    }
    tokio::fs::read_to_string(&p)
        .await
        .map_err(|e| e.to_string())
}

/// 从备份集恢复：先做完整性硬校验，通过后把文件暂存为 *.restore-staging，
/// 再生成等待本进程退出后执行替换、然后重新启动应用的脚本，以分离进程方式启动。
/// 前端收到 Ok 后应调用 process exit。
pub async fn restore(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    let base = backups_dir(&app)?;
    let set_dir = base.join(&id);
    if !set_dir.is_dir() {
        return Err("备份集不存在".to_string());
    }

    // 0) 恢复前硬校验（损坏 / 被篡改即拒绝，不做任何改动）
    let manifest = verify_set(&set_dir)?;

    let ddir = data_dir(&app)?;
    let mut names = Vec::new();

    // 1) 暂存数据文件（数据库 / broker_config），由退出脚本统一替换
    for f in &manifest.files {
        if f.name == CONFIG_JSON {
            continue;
        }
        let src = set_dir.join(&f.name);
        let staging = ddir.join(format!("{}.restore-staging", f.name));
        tokio::fs::copy(&src, &staging)
            .await
            .map_err(|e| format!("暂存 {} 失败: {e}", f.name))?;
        names.push(f.name.clone());
    }
    if names.is_empty() {
        return Err("该备份集不含可恢复的数据文件".to_string());
    }

    // 配置快照暂存（若备份集含 config.json），重启后前端经 take_pending_config 取回。
    // 注意：不加入 names —— 该文件不能被退出脚本当作数据文件移走，需保留到重启后。
    if manifest.files.iter().any(|f| f.name == CONFIG_JSON) {
        let cfg_src = set_dir.join(CONFIG_JSON);
        tokio::fs::copy(&cfg_src, ddir.join("config.restore-staging"))
            .await
            .map_err(|e| format!("暂存配置失败: {e}"))?;
    }

    // 2) 生成退出后替换 + 重启脚本
    let pid = std::process::id();
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let ts = now_millis();
    let script_path = std::env::temp_dir().join(format!("tg-restore-{pid}.bat"));

    let mut bat = String::new();
    bat.push_str("@echo off\r\nchcp 65001 >nul\r\nsetlocal\r\n");
    bat.push_str(&format!(":wait\r\ntasklist /FI \"PID eq {pid}\" 2>nul | find \"{pid}\" >nul\r\nif not errorlevel 1 (\r\n  ping 127.0.0.1 -n 2 >nul\r\n  goto wait\r\n)\r\n"));
    bat.push_str(&format!("set \"DDIR={}\"\r\n", ddir.to_string_lossy()));
    for name in &names {
        bat.push_str(&format!(
            "if exist \"%DDIR%\\{name}\" ren \"%DDIR%\\{name}\" \"{name}.pre-restore-{ts}\"\r\n"
        ));
        bat.push_str(&format!(
            "move /Y \"%DDIR%\\{name}.restore-staging\" \"%DDIR%\\{name}\" >nul\r\n"
        ));
    }
    bat.push_str(&format!("start \"\" \"{}\"\r\n", exe.to_string_lossy()));
    bat.push_str("(goto) 2>nul & del \"%~f0\"\r\n");

    tokio::fs::write(&script_path, bat)
        .await
        .map_err(|e| e.to_string())?;

    // 3) 分离启动脚本（不继承控制台，不阻塞本进程）
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        std::process::Command::new("cmd")
            .args(["/c", &script_path.to_string_lossy()])
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn()
            .map_err(|e| format!("启动恢复脚本失败: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("sh")
            .arg(&script_path)
            .spawn()
            .map_err(|e| format!("启动恢复脚本失败: {e}"))?;
    }

    Ok(names)
}

/// 删除指定备份集。
pub async fn remove(app: AppHandle, id: String) -> Result<(), String> {
    let p = backups_dir(&app)?.join(&id);
    if !p.is_dir() {
        return Err("备份集不存在".to_string());
    }
    // 仅允许删除 backups 下 full- 开头目录，防止路径穿越
    if !id.starts_with("full-") || id.contains("..") || id.contains('/') || id.contains('\\') {
        return Err("非法备份集 ID".to_string());
    }
    tokio::fs::remove_dir_all(&p)
        .await
        .map_err(|e| e.to_string())
}
