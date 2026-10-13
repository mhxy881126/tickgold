// Level-2 数据源抽象（v2.28 只定接口，不承诺数据）。
//
// 免费源（东财/新浪/腾讯）只提供五档快照与汇总字段；十档盘口、逐笔委托、
// 逐笔成交均属券商 / 数据商 Level-2 行情。本模块定义统一 trait，允许插件
// （QuickJS 或侧车，用户自带 Key）在后续版本提供实现，UI 层无需感知来源。
//
// v2.28 范围：仅接口 + 能力描述 + 插件权限 scope 常量；无任何内置实现，
// get_orderbook 等现有链路不经过本模块。

use super::{OrderBook, OrderLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

/// 单插件允许渲染的最大档数（远高于常规 Level-2 十档，仅用于防御异常返回）。
pub const MAX_RENDER_DEPTH: usize = 50;

/// 从插件 parseBookResponse 的某个档位数组（asks/bids）解析有效档位。
/// 宽容取值：仅接受 price>0、vol>=0 的数值档；兼容 [{price,vol}] / [[price,vol]]。
fn parse_levels(v: &Value) -> Vec<OrderLevel> {
    let arr = match v.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for item in arr {
        let (price, vol) = if item.is_array() {
            let p = item.get(0).and_then(Value::as_f64);
            let q = item.get(1).and_then(Value::as_f64);
            (p, q)
        } else {
            (
                item.get("price").and_then(Value::as_f64),
                item.get("vol")
                    .and_then(Value::as_f64)
                    .or_else(|| item.get("volume").and_then(Value::as_f64)),
            )
        };
        if let (Some(p), Some(q)) = (price, vol) {
            if p > 0.0 && q >= 0.0 {
                out.push(OrderLevel { price: p, vol: q });
            }
        }
    }
    out
}

/// 把插件返回的更深档位并入免费源 OrderBook：保留基础行情字段，替换 asks/bids，
/// 再按实际档位数重算深度汇总。capabilities/source 仅用于口径标注。
pub fn merge_book(mut base: OrderBook, parsed: &Value, source: &str) -> Result<OrderBook, String> {
    let asks = parse_levels(parsed.get("asks").unwrap_or(&Value::Null));
    let bids = parse_levels(parsed.get("bids").unwrap_or(&Value::Null));
    if asks.is_empty() || bids.is_empty() {
        return Err(format!(
            "{source} 返回的盘口缺少有效 asks/bids（需为 price>0、vol>=0 的档位数组）"
        ));
    }
    base.asks = asks.into_iter().take(MAX_RENDER_DEPTH).collect();
    base.bids = bids.into_iter().take(MAX_RENDER_DEPTH).collect();
    base.fill_depth();
    Ok(base)
}

/// Level-2 行情源（后续版本由插件适配层实现，trait 对象经 Arc 注入）。
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

#[cfg(test)]
mod tests {
    use super::*;

    fn base_book() -> OrderBook {
        let mut b = OrderBook {
            name: "甲".into(), code: "300001".into(), price: 10.0,
            ..Default::default()
        };
        b.bids = vec![OrderLevel { price: 9.9, vol: 10.0 }];
        b.asks = vec![OrderLevel { price: 10.1, vol: 20.0 }];
        b.fill_depth();
        b
    }

    #[test]
    fn merge_replaces_levels_and_recomputes_depth() {
        let parsed: Value = serde_json::json!({
            "bids": [{"price":9.9,"vol":100},{"price":9.8,"vol":50}],
            "asks": [[10.1, 200], [10.2, 80]],
        });
        let out = merge_book(base_book(), &parsed, "demo:l2").unwrap();
        assert_eq!(out.bids.len(), 2);
        assert_eq!(out.asks.len(), 2);
        // 保留基础行情
        assert_eq!(out.price, 10.0);
        // 深度按十档口径重算：bid 150 / ask 280
        assert_eq!(out.bid_total, 150.0);
        assert_eq!(out.ask_total, 280.0);
    }

    #[test]
    fn merge_accepts_array_pair_and_filters_bad_rows() {
        let parsed: Value = serde_json::json!({
            "bids": [[9.9, 10], [0, 5], [9.7, -1]],
            "asks": [[10.1, 20]],
        });
        let out = merge_book(base_book(), &parsed, "demo").unwrap();
        // price<=0 与 vol<0 的档被丢弃，仅剩一有效档
        assert_eq!(out.bids.len(), 1);
    }

    #[test]
    fn merge_errors_when_levels_missing() {
        let parsed: Value = serde_json::json!({ "bids": [], "asks": [] });
        assert!(merge_book(base_book(), &parsed, "demo").is_err());
    }
}
