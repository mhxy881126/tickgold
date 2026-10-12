// Level-2 数据源抽象（v2.28 只定接口，不承诺数据）。
//
// 免费源（东财/新浪/腾讯）只提供五档快照与汇总字段；十档盘口、逐笔委托、
// 逐笔成交均属券商 / 数据商 Level-2 行情。本模块定义统一 trait，允许插件
// （QuickJS 或侧车，用户自带 Key）在后续版本提供实现，UI 层无需感知来源。
//
// v2.28 范围：仅接口 + 能力描述 + 插件权限 scope 常量；无任何内置实现，
// get_orderbook 等现有链路不经过本模块。

use super::OrderBook;
use serde::{Deserialize, Serialize};

/// 插件请求 Level-2 数据所需的权限 scope（与 kline:read 等并列登记）。
/// v2.28 仅在插件 manifest 校验中登记，无内置数据源使用。
pub const SCOPE_LEVEL2_READ: &str = "level2:read";

/// 逐笔委托（订单簿新增 / 撤销 / 成交的原子变化）。
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct L2OrderTick {
    /// 交易所委托序号（同 code 内唯一，用于撤单 / 成交关联）
    pub seq: u64,
    pub price: f64,
    pub vol: f64,
    /// add=新增委托 cancel=撤销 trade=逐笔成交
    pub op: String,
    /// buy / sell（trade 时表示主动方向）
    pub side: String,
}

/// Level-2 快照能力描述（UI 据此决定展示十档还是降级五档）。
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct L2Capabilities {
    /// 买卖各 N 档（Level-2 通常 10）
    pub depth: usize,
    /// 是否支持逐笔委托推送
    pub order_ticks: bool,
    /// 是否支持逐笔成交推送
    pub trade_ticks: bool,
    /// 数据源标识（如插件名），用于口径标注
    pub source: String,
}

/// Level-2 行情源。后续版本由插件适配层实现；trait 对象经 Arc 注入。
///
/// 设计约定：
/// - 所有方法为 async 且失败返回 String（与现有 market 模块错误口径一致）；
/// - book() 返回的 OrderBook 档位数须与 capabilities().depth 相符；
/// - 实现方负责自身限频与 Key 管理，应用不内置任何 Level-2 凭证。
#[allow(dead_code)]
pub trait Level2Source: Send + Sync {
    /// 数据源能力（档数 / 逐笔支持情况）。
    fn capabilities(&self) -> L2Capabilities;

    /// 十档（或更深）盘口快照。
    fn book<'a>(
        &'a self,
        code: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<OrderBook, String>> + Send + 'a>>;

    /// 拉取自 since_seq（不含）之后的逐笔委托；传 0 取最新一批。
    fn order_ticks<'a>(
        &'a self,
        code: &'a str,
        since_seq: u64,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<L2OrderTick>, String>> + Send + 'a>,
    >;
}
