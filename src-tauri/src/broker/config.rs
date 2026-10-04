// 券商对接配置：持久化在数据目录 broker_config.json（不硬编码路径 / 不内置 Python）。
// 合规默认：kind=mock（内置模拟）、live_enabled=false（实盘关闭）。
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BrokerConfig {
    /// 适配器：mock（内置模拟，默认）/ qmt（miniQMT + xtquant sidecar）。
    pub kind: String,
    /// 实盘开关。默认 false；切 true 需前端风险二次确认。
    pub live_enabled: bool,
    /// 用户 Python 解释器绝对路径（已安装 xtquant），qmt 模式使用。
    pub python_path: String,
    /// miniQMT 客户端 userdata_mini 绝对路径。
    pub qmt_path: String,
    /// 资金账号。
    pub account_id: String,
    /// 单票占总资产上限（%）。
    pub max_single_pct: f64,
    /// 总仓位上限（%）。
    pub max_total_pct: f64,
    /// 该时刻后禁止新开仓（HH:MM）。
    pub no_open_after: String,
    /// 预留费用比例（%），买入资金校验时留余量。
    pub fee_pct: f64,
    /// mock 模式是否允许任意时间（休市/周末也可联调），默认 true。
    pub mock_allow_anytime: bool,
    /// mock 模式初始资金。
    pub mock_init_cash: f64,
}

impl Default for BrokerConfig {
    fn default() -> Self {
        BrokerConfig {
            kind: "mock".to_string(),
            live_enabled: false,
            python_path: String::new(),
            qmt_path: String::new(),
            account_id: String::new(),
            max_single_pct: 20.0,
            max_total_pct: 80.0,
            no_open_after: "14:55".to_string(),
            fee_pct: 0.1,
            mock_allow_anytime: true,
            mock_init_cash: 1_000_000.0,
        }
    }
}

fn config_path(dir: &Path) -> PathBuf {
    dir.join("broker_config.json")
}

/// 读取配置；文件不存在或解析失败时返回默认（并忽略损坏文件，不阻断启动）。
pub fn load(dir: &Path) -> BrokerConfig {
    let p = config_path(dir);
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            log::warn!("broker_config.json 解析失败（{e}），使用默认配置");
            BrokerConfig::default()
        }),
        Err(_) => BrokerConfig::default(),
    }
}

/// 保存配置；失败返回中文错误。
pub fn save(dir: &Path, cfg: &BrokerConfig) -> Result<(), String> {
    let p = config_path(dir);
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化配置失败: {e}"))?;
    std::fs::write(&p, s).map_err(|e| format!("写入配置失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_safe() {
        let c = BrokerConfig::default();
        assert_eq!(c.kind, "mock");
        assert!(!c.live_enabled, "实盘必须默认关闭");
    }

    #[test]
    fn save_then_load_roundtrip() {
        let dir = std::env::temp_dir().join(format!("tickgold-broker-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut c = BrokerConfig::default();
        c.account_id = "ACC123".to_string();
        save(&dir, &c).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.account_id, "ACC123");
        assert_eq!(loaded.kind, "mock");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_yields_default() {
        let dir = std::env::temp_dir().join(format!("tickgold-broker-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(load(&dir).kind, "mock");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
