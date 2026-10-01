// 慢脑配置：ai_config 单行 JSON；云 Key 走 SecretStore（生产系统凭据箱）。
use crate::ai::now_millis;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: String,          // "ollama" | "cloud"
    pub base_url: String,
    pub chat_model: String,
    pub embed_model: String,
    pub temperature: f32,
    pub enable_auto_index: bool,
}

impl Default for AiConfig {
    fn default() -> Self {
        AiConfig {
            provider: "ollama".to_string(),
            base_url: "http://127.0.0.1:11434/v1".to_string(),
            chat_model: "qwen2.5:7b".to_string(),
            embed_model: "nomic-embed-text".to_string(),
            temperature: 0.3,
            enable_auto_index: true,
        }
    }
}

pub fn load_config(c: &Connection) -> Result<AiConfig, String> {
    let row: Option<String> = c
        .query_row("SELECT json FROM ai_config WHERE id=1", [], |r| r.get(0))
        .ok();
    match row {
        Some(json) => serde_json::from_str(&json).map_err(|e| format!("配置解析失败: {e}")),
        None => Ok(AiConfig::default()),
    }
}

pub fn save_config(c: &Connection, cfg: &AiConfig) -> Result<(), String> {
    let json = serde_json::to_string(cfg).map_err(|e| e.to_string())?;
    c.execute(
        "INSERT INTO ai_config(id,json,updated_at) VALUES(1,?1,?2)
         ON CONFLICT(id) DO UPDATE SET json=?1, updated_at=?2",
        rusqlite::params![json, now_millis()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub trait SecretStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, secret: &str) -> Result<(), String>;
    fn erase(&self) -> Result<(), String>;
}

/// 测试用内存凭据。
pub struct MemSecret(pub Arc<Mutex<Option<String>>>);
impl MemSecret {
    pub fn new() -> Self {
        MemSecret(Arc::new(Mutex::new(None)))
    }
}
impl SecretStore for MemSecret {
    fn get(&self) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn set(&self, secret: &str) -> Result<(), String> {
        *self.0.lock().unwrap() = Some(secret.to_string());
        Ok(())
    }
    fn erase(&self) -> Result<(), String> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

/// 系统凭据箱（Windows 凭据管理器 / macOS Keychain / Linux Secret Service）。
pub struct KeyringSecret {
    pub service: String,
    pub user: String,
}
impl SecretStore for KeyringSecret {
    fn get(&self) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(&self.service, &self.user).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn set(&self, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(&self.service, &self.user).map_err(|e| e.to_string())?;
        entry.set_password(secret).map_err(|e| e.to_string())
    }
    fn erase(&self) -> Result<(), String> {
        let entry = keyring::Entry::new(&self.service, &self.user).map_err(|e| e.to_string())?;
        match entry.delete_password() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::vectordb::open;

    // 并行测试同毫秒撞名会打开同一个临时库（评审亲测 25 passed/1 failed）；
    // 追加进程内原子序号保证唯一（与 tools.rs SEED_SEQ 同一修法）。
    static CFG_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn db() -> crate::ai::vectordb::AiDb {
        let seq = CFG_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let p = std::env::temp_dir()
            .join(format!("tickgold-ai-test-cfg-{}-{}.db", now_millis(), seq));
        open(&p).unwrap()
    }

    #[test]
    fn default_config_when_absent() {
        let db = db();
        let cfg = load_config(&db.0).unwrap();
        assert_eq!(cfg.provider, "ollama");
        assert_eq!(cfg.base_url, "http://127.0.0.1:11434/v1");
        assert!(cfg.enable_auto_index);
    }

    #[test]
    fn save_and_reload_roundtrip_camelcase() {
        let db = db();
        let mut cfg = AiConfig::default();
        cfg.provider = "cloud".to_string();
        cfg.base_url = "https://api.deepseek.com/v1".to_string();
        cfg.temperature = 0.1;
        save_config(&db.0, &cfg).unwrap();
        let back = load_config(&db.0).unwrap();
        assert_eq!(back.provider, "cloud");
        assert_eq!(back.base_url, "https://api.deepseek.com/v1");
        // 存储为 camelCase JSON
        let raw: String = db
            .0
            .query_row("SELECT json FROM ai_config WHERE id=1", [], |r| r.get(0))
            .unwrap();
        assert!(raw.contains("baseUrl"));
        assert!(!raw.contains("base_url"));
    }

    #[test]
    fn mem_secret_lifecycle() {
        let s = MemSecret::new();
        assert_eq!(s.get().unwrap(), None);
        s.set("sk-test").unwrap();
        assert_eq!(s.get().unwrap().as_deref(), Some("sk-test"));
        s.erase().unwrap();
        assert_eq!(s.get().unwrap(), None);
    }
}
