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
    // ===== v3.0.0-rc 账户级风控阈值（全通道唯一事实源）=====
    /// 单日亏损限制（%），当日已实现亏损超过即停开新仓。
    #[serde(default = "default_daily_loss")]
    pub daily_loss_limit_pct: f64,
    /// 累计回撤限制（%），从权益峰值回撤超过即停开新仓。
    #[serde(default = "default_drawdown")]
    pub max_drawdown_limit_pct: f64,
    /// 连续亏损笔数限制，达到即暂停开新仓。
    #[serde(default = "default_consecutive")]
    pub consecutive_loss_limit: i32,
    /// 实盘单笔金额上限（绝对值硬兜底）；0 = 实盘锁定，须显式设置才放开。
    #[serde(default)]
    pub live_max_order_amount: f64,

    // ===== P3 客户端自动化通道（kind="client"）：同花顺模拟/真实客户端 UI 自动化 =====
    /// 客户端厂商：ths（同花顺）；预留 eastmoney（东方财富）。
    #[serde(default = "default_client_vendor")]
    pub client_vendor: String,
    /// 是否模拟环境（同花顺模拟炒股，虚拟资金）。true=不碰真钱、无需 live_enabled；false=真实账户（后续 P4）。
    #[serde(default = "default_client_sim")]
    pub client_sim: bool,
    /// 客户端 / 独立下单程序路径（如 xiadan.exe）。
    #[serde(default)]
    pub client_path: String,
    /// 控件/图像模板目录（随客户端版本校准）。
    #[serde(default)]
    pub client_template_dir: String,
    /// true=全自动：自动填单并点确认（模拟环境默认）；false=半自动：仅填单，截图等待人工确认。
    #[serde(default = "default_client_auto_confirm")]
    pub client_auto_confirm: bool,
    /// 相邻下单最小间隔（毫秒）限速冷却，防止 UI 自动化连发。
    #[serde(default = "default_client_min_interval")]
    pub client_min_interval_ms: u64,
    /// dry-run：不连接真实客户端，sidecar 内部模拟整套事件（无客户端/开发机验证用）。
    #[serde(default = "default_client_dry_run")]
    pub client_dry_run: bool,
    /// tesseract.exe 路径（同花顺复制表格验证码 OCR；留空则验证码转人工输入）。
    #[serde(default)]
    pub client_tesseract: String,

    // ===== P10-1 HTTP API 服务（对齐 THSAutoTrader 接口；默认关闭，仅本机） =====
    /// HTTP API 服务端口（0=关闭；开启后仅监听 127.0.0.1）。
    #[serde(default)]
    pub client_api_port: u16,
    /// HTTP API 访问令牌（留空=本机免密；设置后所有请求需携带）。
    #[serde(default)]
    pub client_api_token: String,
    /// P12-2 通道手动标注：窗口类型识别失败时用户手动指定 "sim"/"live"（None=自动识别/未标注）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_channel_manual: Option<String>,

    // ===== P4 真实通道安全护栏（默认全部锁定，必须显式武装后才允许真实委托）=====
    /// 实盘单日累计买入金额上限（绝对值硬兜底）。真实通道「当日已提买入合计 + 本笔」不得超过；0 = 锁定。
    #[serde(default)]
    pub live_max_daily_amount: f64,
    /// 实盘标的白名单（裸 6 位代码，统一去后缀比较）。真实通道仅允许下单白名单内标的；默认空 = 全部禁止。
    #[serde(default)]
    pub live_codes_whitelist: Vec<String>,
    /// 同花顺 GUI 真实通道武装前，必须已完成模拟盘真机演练（client 真实通道强制前置，用户自我声明 + 审计）。
    #[serde(default)]
    pub live_sim_drill_passed: bool,
    /// 最近一次实盘武装时间戳（Unix 秒，审计用；0 = 未武装）。
    #[serde(default)]
    pub live_armed_at: i64,

    // ===== P1-4 追价硬上限 + 报撤频率熔断 =====
    /// 同一标的最多追价次数（撤单重报），超过即拒。
    #[serde(default = "default_max_chase_times")]
    pub max_chase_times: i32,
    /// 追价相对原委托价的最大偏离（%），超过即拒。
    #[serde(default = "default_max_chase_pct")]
    pub max_chase_pct: f64,
    /// 60 秒滑动窗口内允许的报单+撤单笔数上限，超过触发频率熔断。
    #[serde(default = "default_max_order_rate")]
    pub max_order_rate_per_min: i32,
}

fn default_client_vendor() -> String {
    "ths".to_string()
}
fn default_client_sim() -> bool {
    true
}
fn default_client_auto_confirm() -> bool {
    true
}
fn default_client_min_interval() -> u64 {
    1200
}
fn default_client_dry_run() -> bool {
    true
}

fn default_daily_loss() -> f64 {
    5.0
}
fn default_drawdown() -> f64 {
    20.0
}
fn default_consecutive() -> i32 {
    3
}
fn default_max_chase_times() -> i32 {
    3
}
fn default_max_chase_pct() -> f64 {
    2.0
}
fn default_max_order_rate() -> i32 {
    20
}

impl Default for BrokerConfig {
    fn default() -> Self {
        BrokerConfig {
            kind: "client".to_string(),
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
            daily_loss_limit_pct: 5.0,
            max_drawdown_limit_pct: 20.0,
            consecutive_loss_limit: 3,
            live_max_order_amount: 0.0,

            // P3 客户端自动化通道默认：同花顺模拟、模拟环境、全自动、真操控模拟盘（非空跑）、限速 1.2s。
            client_vendor: "ths".to_string(),
            client_sim: true,
            client_path: String::new(),
            client_template_dir: String::new(),
            client_auto_confirm: true,
            client_min_interval_ms: 1200,
            client_dry_run: false,
            client_tesseract: String::new(),
            client_api_port: 0,
            client_api_token: String::new(),
            client_channel_manual: None,

            // P4 真实通道默认全部锁定：单日上限 0、白名单空、演练未通过、未武装。
            live_max_daily_amount: 0.0,
            live_codes_whitelist: Vec::new(),
            live_sim_drill_passed: false,
            live_armed_at: 0,
            max_chase_times: 3,
            max_chase_pct: 2.0,
            max_order_rate_per_min: 20,
        }
    }
}

impl BrokerConfig {
    pub fn is_client(&self) -> bool {
        self.kind == "client"
    }
    /// P4 真实通道（会动用真实资金）：QMT 官方接口，或客户端自动化的真实账户（非模拟）。
    /// 命中即必须通过完整实盘武装闸门与强制半自动（GUI 通道）。
    pub fn is_live(&self) -> bool {
        self.kind == "qmt" || (self.is_client() && !self.client_sim)
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
        assert_eq!(c.kind, "client");
        assert!(!c.live_enabled, "实盘必须默认关闭");
    }

    #[test]
    fn client_defaults_are_safe_sim() {
        let c = BrokerConfig::default();
        assert_eq!(c.client_vendor, "ths");
        assert!(c.client_sim, "client 默认必须是模拟环境（不碰真钱）");
        assert!(!c.client_dry_run, "client 默认真操控同花顺模拟盘（非空跑）");
        assert!(c.client_auto_confirm, "模拟环境默认全自动");
        assert_eq!(c.client_min_interval_ms, 1200);
        assert_eq!(c.client_api_port, 0, "HTTP API 服务默认必须关闭");
        assert!(c.client_api_token.is_empty(), "API 令牌默认为空");
        assert!(c.is_client(), "默认通道为同花顺模拟（client）");
        let mut c2 = BrokerConfig {
            kind: "client".to_string(),
            ..Default::default()
        };
        assert!(c2.is_client() && !c2.is_live(), "kind=client 且模拟时不是真实通道");
        c2.client_sim = false;
        assert!(c2.is_live(), "client_sim=false 时为真实通道");
        // P4 真实通道默认全部锁定
        assert!(c.live_max_daily_amount == 0.0, "P4 单日累计上限默认 0 锁定");
        assert!(c.live_codes_whitelist.is_empty(), "P4 白名单默认空=全部禁止");
        assert!(!c.live_sim_drill_passed, "P4 模拟演练默认未通过");
        assert_eq!(c.live_armed_at, 0, "P4 默认未武装");
        assert!(!c.is_live(), "默认 mock 不是真实通道");
        let q = BrokerConfig {
            kind: "qmt".to_string(),
            ..Default::default()
        };
        assert!(q.is_live(), "qmt 为真实通道");
        let mut r = BrokerConfig {
            kind: "client".to_string(),
            ..Default::default()
        };
        r.client_sim = false;
        assert!(r.is_live(), "client 非模拟为真实通道");
        let mut s = BrokerConfig {
            kind: "client".to_string(),
            ..Default::default()
        };
        s.client_sim = true;
        assert!(!s.is_live(), "client 模拟不是真实通道");
    }

    #[test]
    fn save_then_load_roundtrip() {
        let dir = std::env::temp_dir().join(format!("tickgold-broker-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = BrokerConfig {
            account_id: "ACC123".to_string(),
            ..Default::default()
        };
        save(&dir, &c).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.account_id, "ACC123");
        assert_eq!(loaded.kind, "client");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_yields_default() {
        let dir =
            std::env::temp_dir().join(format!("tickgold-broker-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(load(&dir).kind, "client");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
