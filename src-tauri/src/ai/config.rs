// 慢脑配置：ai_config 单行 JSON；云 Key 走 SecretStore（生产系统凭据箱）。
use crate::ai::now_millis;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// 内置云端模型（Pro 激活即用，无需用户配置）。
/// 智谱 GLM-4.5：输入 0.8 元/百万 tokens、输出 2 元/百万 tokens（官方定价）。
pub const BUILTIN_BASE_URL: &str = "https://open.bigmodel.cn/api/paas/v4";
pub const BUILTIN_CHAT_MODEL: &str = "glm-4.5";
pub const BUILTIN_EMBED_MODEL: &str = "embedding-3";
pub const BUILTIN_API_KEY: &str = "d9dbab10ef2a4f158b3b43a4ac7eb29c.Sro93uZJWZs17Hu1";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: String, // "ollama" | "cloud"
    pub base_url: String,
    pub chat_model: String,
    pub embed_model: String,
    pub temperature: f32,
    pub enable_auto_index: bool,
    /// 使用内置云端模型（默认开箱即用；关闭后按 provider/baseUrl/自填 Key 走 BYOK）。
    #[serde(default = "default_true")]
    pub use_builtin: bool,
}

fn default_true() -> bool {
    true
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
            use_builtin: true,
        }
    }
}

/// 生效配置：use_builtin 时强制覆盖为内置智谱端点与模型（忽略历史 ollama 默认值）。
/// BYOK（cloud + 自填 Key）与本地 Ollama 保持原配置。
pub fn effective_cfg(cfg: &AiConfig) -> AiConfig {
    if cfg.use_builtin {
        let mut c = cfg.clone();
        c.base_url = BUILTIN_BASE_URL.to_string();
        c.chat_model = BUILTIN_CHAT_MODEL.to_string();
        c.embed_model = BUILTIN_EMBED_MODEL.to_string();
        c
    } else {
        cfg.clone()
    }
}

/// 生效 API Key：内置 Key / 用户自填云 Key（BYOK）/ 本地 Ollama 无 Key。
pub fn effective_key(cfg: &AiConfig, secret: &impl SecretStore) -> Result<Option<String>, String> {
    if cfg.use_builtin {
        Ok(Some(BUILTIN_API_KEY.to_string()))
    } else if cfg.provider == "cloud" {
        secret
            .get()?
            .ok_or_else(|| "未设置云端 API Key：请关闭内置模型后，在 AI 模型页填写并保存自己的 Key".to_string())
            .map(Some)
    } else {
        Ok(None)
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
#[cfg(test)]
use std::sync::{Arc, Mutex};
#[cfg(test)]
pub struct MemSecret(pub Arc<Mutex<Option<String>>>);
#[cfg(test)]
impl MemSecret {
    pub fn new() -> Self {
        MemSecret(Arc::new(Mutex::new(None)))
    }
}
#[cfg(test)]
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
        let p =
            std::env::temp_dir().join(format!("tickgold-ai-test-cfg-{}-{}.db", now_millis(), seq));
        open(&p).unwrap()
    }

    #[test]
    fn default_config_when_absent() {
        let db = db();
        let cfg = load_config(&db.0).unwrap();
        assert_eq!(cfg.provider, "ollama");
        assert_eq!(cfg.base_url, "http://127.0.0.1:11434/v1");
        assert!(cfg.enable_auto_index);
        // 新用户默认开箱即用内置模型
        assert!(cfg.use_builtin);
    }

    #[test]
    fn save_and_reload_roundtrip_camelcase() {
        let db = db();
        let cfg = AiConfig {
            provider: "cloud".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            temperature: 0.1,
            ..Default::default()
        };
        save_config(&db.0, &cfg).unwrap();
        let back = load_config(&db.0).unwrap();
        assert_eq!(back.provider, "cloud");
        assert_eq!(back.base_url, "https://api.deepseek.com/v1");
        // 存储为 camelCase JSON
        let raw: String =
            db.0.query_row("SELECT json FROM ai_config WHERE id=1", [], |r| r.get(0))
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

    #[test]
    fn builtin_resolves_to_zhipu_and_ignores_stale_fields() {
        let s = MemSecret::new();
        // 旧库可能残留 ollama 默认 base_url/model；use_builtin=true 必须强制覆盖
        let cfg = AiConfig::default();
        assert!(cfg.use_builtin);
        let eff = effective_cfg(&cfg);
        assert_eq!(eff.base_url, BUILTIN_BASE_URL);
        assert_eq!(eff.chat_model, BUILTIN_CHAT_MODEL);
        assert_eq!(eff.embed_model, BUILTIN_EMBED_MODEL);
        assert_eq!(
            effective_key(&cfg, &s).unwrap().as_deref(),
            Some(BUILTIN_API_KEY)
        );
    }

    #[test]
    fn byok_cloud_uses_user_key_and_url() {
        let s = MemSecret::new();
        s.set("sk-user").unwrap();
        let cfg = AiConfig {
            use_builtin: false,
            provider: "cloud".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            chat_model: "deepseek-chat".to_string(),
            ..Default::default()
        };
        let eff = effective_cfg(&cfg);
        assert_eq!(eff.base_url, "https://api.deepseek.com/v1");
        assert_eq!(eff.chat_model, "deepseek-chat");
        assert_eq!(effective_key(&cfg, &s).unwrap().as_deref(), Some("sk-user"));
    }

    #[test]
    fn byok_cloud_without_key_errors() {
        let s = MemSecret::new();
        let cfg = AiConfig {
            use_builtin: false,
            provider: "cloud".to_string(),
            ..Default::default()
        };
        assert!(effective_key(&cfg, &s).is_err());
    }

    #[test]
    fn ollama_mode_keeps_no_key() {
        let s = MemSecret::new();
        let cfg = AiConfig {
            use_builtin: false,
            provider: "ollama".to_string(),
            ..Default::default()
        };
        assert_eq!(effective_key(&cfg, &s).unwrap(), None);
        let eff = effective_cfg(&cfg);
        assert_eq!(eff.base_url, "http://127.0.0.1:11434/v1");
    }
}
