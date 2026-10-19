// P2-1 统一券商通道契约（BrokerChannel）
// 目的：让所有交易通道——同花顺 UI 自动化（client）、miniQMT/QMT、券商 OpenAPI、
// 通达信本地协议——实现同一套接口，上层 BrokerManager 不再耦合具体通道实现，
// 便于切换通道、补单 / 对账 / 撤单在不同通道间复用。
//
// 设计约定：
//   1. 风控闸门（止损、仓位、白名单、熔断、人工确认）在调用方 BrokerManager；
//      通道实现只负责与后端的可靠交互，不做最终放行决定。
//   2. 查询方法返回“当前最新快照”，错误必须显式返回（Result::Err），禁止静默吞掉。
//   3. 下单 ticket 由调用方构造并已通过风控；通道返回是否被后端受理。
//
// 说明：此处使用原生 `async fn in trait`（简洁、无额外依赖）。若后续需要运行时
// 多态（Box<dyn BrokerChannel>），可引入 async-trait，或用 enum 通道分发，签名不变。
use crate::broker::config::BrokerConfig;
use serde::{Deserialize, Serialize};

// ===== 统一数据传输对象（DTO）=====

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAsset {
    pub account: String,
    pub cash: f64,
    pub frozen: f64,
    pub market_value: f64,
    pub total_asset: f64,
    pub day_pnl: f64,
    pub float_pnl: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPosition {
    pub code: String,
    pub name: String,
    pub vol: i64,
    pub available_vol: i64,
    pub cost_price: f64,
    pub now_price: f64,
    pub market_value: f64,
    pub float_pnl: f64,
    pub float_pnl_pct: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChannelTrade {
    pub code: String,
    pub name: String,
    /// buy / sell
    pub side: String,
    pub price: f64,
    pub vol: i64,
    pub amount: f64,
    pub order_id: String,
    pub trade_time: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChannelOrder {
    pub order_id: String,
    pub code: String,
    pub name: String,
    /// buy / sell
    pub side: String,
    pub price: f64,
    pub vol: i64,
    pub filled_vol: i64,
    /// 委托状态：pending / partial / filled / canceled / rejected
    pub status: String,
    pub order_time: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrderTicket {
    pub code: String,
    /// buy / sell
    pub side: String,
    /// limit / market
    pub order_type: String,
    pub price: f64,
    pub vol: i64,
    /// 仓位档位（0/1 满、2 半、3 三分之一、4 四分之一），UI 通道使用。
    pub position: Option<i64>,
    pub ref_price: Option<f64>,
    pub client_order_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrderResult {
    pub client_order_id: String,
    pub broker_order_id: String,
    pub accepted: bool,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    /// ths / qmt / openapi / tdx
    pub kind: String,
    pub vendor: String,
    pub account: String,
    pub connected: bool,
    pub live: bool,
}

/// 统一券商通道契约。
#[allow(async_fn_in_trait)]
pub trait BrokerChannel {
    /// 通道类型标识（ths / qmt / openapi / tdx）。
    fn kind(&self) -> &str;
    /// 是否为真实资金通道。
    fn is_live(&self) -> bool;
    /// 建立连接。
    async fn connect(&mut self, cfg: &BrokerConfig) -> Result<ChannelInfo, String>;
    /// 断开连接。
    async fn disconnect(&mut self) -> Result<(), String>;
    /// 查询资金 / 资产。
    async fn query_asset(&self) -> Result<ChannelAsset, String>;
    /// 查询持仓。
    async fn query_positions(&self) -> Result<Vec<ChannelPosition>, String>;
    /// 查询当日成交。
    async fn query_trades(&self) -> Result<Vec<ChannelTrade>, String>;
    /// 查询当日挂单（在途委托）。
    async fn query_pending(&self) -> Result<Vec<ChannelOrder>, String>;
    /// 下单（调用方已完成风控）。
    async fn place_order(&self, ticket: &OrderTicket) -> Result<OrderResult, String>;
    /// 撤销指定委托。
    async fn cancel_order(&self, broker_order_id: &str) -> Result<(), String>;
    /// 撤单全部：A 全撤 / X 撤买 / C 撤卖。
    async fn cancel_all(&self, kind: &str) -> Result<(), String>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用内存通道：验证 BrokerChannel 可被实现且方法契约成立。
    struct MockChannel {
        live: bool,
        connected: bool,
        positions: Vec<ChannelPosition>,
    }

    #[allow(async_fn_in_trait)]
    impl BrokerChannel for MockChannel {
        fn kind(&self) -> &str {
            "mock"
        }
        fn is_live(&self) -> bool {
            self.live
        }
        async fn connect(&mut self, cfg: &BrokerConfig) -> Result<ChannelInfo, String> {
            self.connected = true;
            Ok(ChannelInfo {
                kind: self.kind().to_string(),
                vendor: "mock".to_string(),
                account: cfg.account_id.clone(),
                connected: true,
                live: self.live,
            })
        }
        async fn disconnect(&mut self) -> Result<(), String> {
            self.connected = false;
            Ok(())
        }
        async fn query_asset(&self) -> Result<ChannelAsset, String> {
            if !self.connected {
                return Err("未连接".to_string());
            }
            Ok(ChannelAsset {
                cash: 1000.0,
                total_asset: 2000.0,
                ..Default::default()
            })
        }
        async fn query_positions(&self) -> Result<Vec<ChannelPosition>, String> {
            Ok(self.positions.clone())
        }
        async fn query_trades(&self) -> Result<Vec<ChannelTrade>, String> {
            Ok(vec![])
        }
        async fn query_pending(&self) -> Result<Vec<ChannelOrder>, String> {
            Ok(vec![])
        }
        async fn place_order(&self, t: &OrderTicket) -> Result<OrderResult, String> {
            Ok(OrderResult {
                client_order_id: t.client_order_id.clone(),
                broker_order_id: "B1".to_string(),
                accepted: true,
                message: "已受理".to_string(),
            })
        }
        async fn cancel_order(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
        async fn cancel_all(&self, _kind: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[test]
    fn dto_camel_case_roundtrip() {
        let a = ChannelAsset {
            account: "ACC".into(),
            cash: 100.0,
            total_asset: 500.0,
            ..Default::default()
        };
        let j = serde_json::to_string(&a).unwrap();
        assert!(j.contains("totalAsset"));
        let back: ChannelAsset = serde_json::from_str(&j).unwrap();
        assert_eq!(back.total_asset, 500.0);
    }

    #[tokio::test]
    async fn channel_contract_works() {
        let mut ch = MockChannel {
            live: false,
            connected: false,
            positions: vec![ChannelPosition {
                code: "600519".into(),
                vol: 100,
                available_vol: 100,
                ..Default::default()
            }],
        };
        assert_eq!(ch.kind(), "mock");
        assert!(!ch.is_live());
        // 未连接查询应报错
        assert!(ch.query_asset().await.is_err());
        let cfg = BrokerConfig {
            account_id: "ACC1".into(),
            ..Default::default()
        };
        let info = ch.connect(&cfg).await.unwrap();
        assert!(info.connected && info.account == "ACC1");
        assert_eq!(ch.query_positions().await.unwrap().len(), 1);
        let ticket = OrderTicket {
            client_order_id: "C1".into(),
            code: "600519".into(),
            side: "buy".into(),
            vol: 100,
            ..Default::default()
        };
        let r = ch.place_order(&ticket).await.unwrap();
        assert!(r.accepted && r.broker_order_id == "B1");
        ch.disconnect().await.unwrap();
        assert!(ch.query_asset().await.is_err());
    }
}
