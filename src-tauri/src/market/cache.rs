// 本地历史 K 线文件缓存。
// 作用：①网络失败 / 限流 / 盘后离线时兜底可看；②减少对数据源的重复请求。
// 策略：get_kline 网络成功后异步整段刷新；网络全部失败时读缓存返回。
use super::KBar;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize)]
struct CacheFile {
    updated_at: i64,
    bars: Vec<KBar>,
}

/// 跨平台应用数据目录（与 Tauri app_data_dir 对齐，identifier = com.stockdock.desktop）
#[allow(unreachable_code)]
fn base_dir() -> Option<PathBuf> {
    let id = "com.stockdock.desktop";
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").ok()?;
        return Some(PathBuf::from(appdata).join(id));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        return Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(id),
        );
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let mut dir = std::env::var("XDG_CONFIG_HOME").map(PathBuf::from).ok();
        if dir.is_none() {
            if let Ok(home) = std::env::var("HOME") {
                dir = Some(PathBuf::from(home).join(".config"));
            }
        }
        if let Some(d) = dir {
            return Some(d.join(id));
        }
    }
    None
}

fn kline_path(code: &str, period: i64) -> Option<PathBuf> {
    let mut p = base_dir()?;
    p.push("cache");
    p.push("kline");
    p.push(format!("{}_{}.json", code, period));
    Some(p)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 写缓存（原子替换：先写 .tmp 再 rename，避免半截文件）
pub fn write_kline(code: &str, period: i64, bars: &[KBar]) -> Result<(), String> {
    let path = kline_path(code, period).ok_or_else(|| "no cache dir".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let cf = CacheFile {
        updated_at: now_ms(),
        bars: bars.to_vec(),
    };
    let bytes = serde_json::to_vec(&cf).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 读缓存（空数据视为无）
pub fn read_kline(code: &str, period: i64) -> Option<Vec<KBar>> {
    let path = kline_path(code, period)?;
    let bytes = fs::read(&path).ok()?;
    let cf: CacheFile = serde_json::from_slice(&bytes).ok()?;
    if cf.bars.is_empty() {
        None
    } else {
        Some(cf.bars)
    }
}
