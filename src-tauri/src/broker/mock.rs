// 内置模拟适配器：无需 Python / QMT，维护虚拟账户与 T+1 持仓，驱动离线全链路联调。
// 成交由 mod.rs 的状态推进脚本在 submitted/part_filled/filled 各阶段调用 apply_fill。
use crate::broker::risk::{AccountSnapshot, Position};
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct MockPosition {
    pub vol: i64,
    pub avail: i64, // 可卖（T+1：当日买入不计入）
    pub cost_amount: f64,
}

pub struct MockBroker {
    pub cash: f64,
    pub positions: HashMap<String, MockPosition>,
    /// 每只票最新价（用于估算市值）。
    pub last_price: HashMap<String, f64>,
}

impl MockBroker {
    pub fn new(init_cash: f64) -> Self {
        MockBroker {
            cash: init_cash,
            positions: HashMap::new(),
            last_price: HashMap::new(),
        }
    }

    pub fn reset(&mut self, init_cash: f64) {
        self.cash = init_cash;
        self.positions.clear();
        self.last_price.clear();
    }

    /// 注入"昨日及以前"持仓（可卖），便于联调卖出 / 止损链路。
    pub fn seed_position(&mut self, code: &str, vol: i64, price: f64) {
        self.positions.insert(
            code.to_string(),
            MockPosition {
                vol,
                avail: vol,
                cost_amount: price * vol as f64,
            },
        );
        self.last_price.insert(code.to_string(), price);
    }

    /// 应用一笔成交。
    pub fn apply_fill(&mut self, code: &str, side: &str, price: f64, vol: i64) {
        let gross = price * vol as f64;
        self.last_price.insert(code.to_string(), price);
        if side == "BUY" {
            self.cash -= gross;
            let p = self
                .positions
                .entry(code.to_string())
                .or_insert(MockPosition { vol: 0, avail: 0, cost_amount: 0.0 });
            p.vol += vol;
            p.cost_amount += gross;
            // T+1：当日买入 avail 不增加。
        } else {
            self.cash += gross;
            if let Some(p) = self.positions.get_mut(code) {
                p.vol -= vol;
                p.avail -= vol;
                if p.vol <= 0 {
                    self.positions.remove(code);
                }
            }
        }
    }

    /// 生成风控所需账户快照（市值按最新价估算）。
    pub fn snapshot(&self) -> AccountSnapshot {
        let mut market_value = 0.0;
        let mut positions = HashMap::new();
        for (code, p) in &self.positions {
            let px = self.last_price.get(code).copied().unwrap_or(0.0);
            market_value += px * p.vol as f64;
            positions.insert(
                code.clone(),
                Position { vol: p.vol, avail: p.avail },
            );
        }
        AccountSnapshot {
            cash: self.cash,
            market_value,
            positions,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buy_reduces_cash_and_blocks_t1_sell() {
        let mut m = MockBroker::new(100_000.0);
        m.apply_fill("600519", "BUY", 100.0, 100);
        assert!((m.cash - 90_000.0).abs() < 1e-6);
        let snap = m.snapshot();
        // 当日买入不可卖
        assert_eq!(snap.positions["600519"].avail, 0);
        assert_eq!(snap.positions["600519"].vol, 100);
        assert!((snap.market_value - 10_000.0).abs() < 1e-6);
    }

    #[test]
    fn seeded_position_is_sellable() {
        let mut m = MockBroker::new(100_000.0);
        m.seed_position("600519", 1000, 50.0);
        let snap = m.snapshot();
        assert_eq!(snap.positions["600519"].avail, 1000);
        m.apply_fill("600519", "SELL", 55.0, 1000);
        assert!((m.cash - 155_000.0).abs() < 1e-6);
        assert!(m.positions.is_empty());
    }
}
