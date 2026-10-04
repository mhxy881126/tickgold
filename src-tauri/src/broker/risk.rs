// 券商下单二次风控（强制层，纯函数、可单测）：交易时段、数量合法性、涨跌停、资金/持仓、仓位上限。
// sidecar / 柜台错误不替代本地风控；任一不过即拒绝并由上层写审计。
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// 待校验订单。
#[derive(Clone, Debug)]
pub struct RiskOrder {
    pub code: String,
    pub side: String, // BUY / SELL
    pub price: f64,
    pub vol: i64,
}

/// 单只持仓（总量 / 可用量）。
#[derive(Clone, Copy, Debug, Default)]
pub struct Position {
    pub vol: i64,
    pub avail: i64,
}

/// 账户快照。
#[derive(Clone, Debug, Default)]
pub struct AccountSnapshot {
    pub cash: f64,
    pub market_value: f64,
    pub positions: HashMap<String, Position>,
}

impl AccountSnapshot {
    pub fn total_asset(&self) -> f64 {
        self.cash + self.market_value
    }
}

/// 行情快照（涨跌停可缺省，mock 离线时无此数据则跳过涨跌停校验）。
#[derive(Clone, Copy, Debug, Default)]
pub struct MarketSnapshot {
    pub limit_up: Option<f64>,
    pub limit_down: Option<f64>,
}

/// 风控参数。
#[derive(Clone, Debug)]
pub struct RiskParams {
    pub max_single_pct: f64,
    pub max_total_pct: f64,
    pub fee_pct: f64,
    /// 禁止开仓时刻（一天中的分钟数，如 14:55 = 895）。
    pub no_open_after_min: i32,
}

/// 交易时段。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Closed,
    Morning,   // 9:30–11:30
    Midday,    // 11:30–13:00
    Afternoon, // 13:00–15:00
}

/// 根据星期（0=周日…6=周六）与一天中的分钟数判断 A 股连续竞价时段。
pub fn phase_of(weekday: u8, minute_of_day: i32) -> Phase {
    if weekday == 0 || weekday == 6 {
        return Phase::Closed;
    }
    match minute_of_day {
        m if m >= 570 && m < 690 => Phase::Morning,    // 9:30–11:30
        m if m >= 690 && m < 780 => Phase::Midday,     // 11:30–13:00
        m if m >= 780 && m < 900 => Phase::Afternoon,  // 13:00–15:00
        _ => Phase::Closed,
    }
}

/// 当前北京时间：(星期 0–6, 一天中的分钟数)。
pub fn beijing_now_weekday_min() -> (u8, i32) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
        + 8 * 3600;
    let days = secs.div_euclid(86400);
    let tod = secs.rem_euclid(86400);
    // 1970-01-01 为周四（weekday=4）。
    let weekday = ((days + 4).rem_euclid(7)) as u8;
    (weekday, (tod / 60) as i32)
}

fn hhmm_to_min(hhmm: &str) -> i32 {
    let parts: Vec<&str> = hhmm.split(':').collect();
    if parts.len() != 2 {
        return 895;
    }
    let h: i32 = parts[0].trim().parse().unwrap_or(14);
    let m: i32 = parts[1].trim().parse().unwrap_or(55);
    h * 60 + m
}

impl RiskParams {
    pub fn from_config(c: &crate::broker::config::BrokerConfig) -> Self {
        RiskParams {
            max_single_pct: c.max_single_pct,
            max_total_pct: c.max_total_pct,
            fee_pct: c.fee_pct,
            no_open_after_min: hhmm_to_min(&c.no_open_after),
        }
    }
}

/// 风控主入口。`allow_anytime`（mock）跳过交易时段校验。
pub fn check(
    order: &RiskOrder,
    account: &AccountSnapshot,
    market: Option<MarketSnapshot>,
    params: &RiskParams,
    phase: Phase,
    minute_of_day: i32,
    allow_anytime: bool,
) -> Result<(), String> {
    // 1) 交易时段
    if !allow_anytime {
        if phase == Phase::Closed || phase == Phase::Midday {
            return Err("当前非 A 股连续竞价交易时段".to_string());
        }
        // 买入（开仓）受 no_open_after 限制；卖出不受限（便于止损离场）。
        if order.side == "BUY" && minute_of_day >= params.no_open_after_min {
            return Err(format!("已过禁止开仓时间（{} 后不开新仓）", min_to_hhmm(params.no_open_after_min)));
        }
    }

    // 2) 价格 / 数量合法性
    if order.price <= 0.0 {
        return Err("委托价格必须大于 0".to_string());
    }
    if order.vol <= 0 {
        return Err("委托数量必须大于 0".to_string());
    }
    if order.vol % 100 != 0 {
        return Err("A 股委托数量须为 100 的整数倍".to_string());
    }

    // 3) 涨跌停反向拦截（有行情快照时）
    if let Some(mk) = market {
        if order.side == "BUY" {
            if let Some(up) = mk.limit_up {
                if order.price >= up - 1e-9 {
                    return Err("委托价达到涨停价，买入难以成交".to_string());
                }
            }
        } else if let Some(dn) = mk.limit_down {
            if order.price <= dn + 1e-9 {
                return Err("委托价达到跌停价，卖出难以成交".to_string());
            }
        }
    }

    let gross = order.price * order.vol as f64;

    if order.side == "BUY" {
        // 4) 资金（含费用余量）
        let cost = gross * (1.0 + params.fee_pct / 100.0);
        if cost > account.cash + 1e-6 {
            return Err(format!(
                "可用资金不足：需 {:.0}（含费），可用 {:.0}",
                cost, account.cash
            ));
        }
        // 5) 单票占比
        let total = account.total_asset();
        if total > 0.0 && gross / total * 100.0 > params.max_single_pct + 1e-6 {
            return Err(format!(
                "超过单票仓位上限：该笔占总资产 {:.1}%，上限 {:.1}%",
                gross / total * 100.0,
                params.max_single_pct
            ));
        }
        // 6) 总仓位
        let new_total_pos = account.market_value + gross;
        if total > 0.0 && new_total_pos / total * 100.0 > params.max_total_pct + 1e-6 {
            return Err(format!(
                "超过总仓位上限：成交后仓位 {:.1}%，上限 {:.1}%",
                new_total_pos / total * 100.0,
                params.max_total_pct
            ));
        }
    } else {
        // 卖出：可用持仓校验
        let pos = account.positions.get(&order.code).copied().unwrap_or_default();
        if order.vol > pos.avail {
            return Err(format!(
                "可用持仓不足：拟卖 {}，可用 {}",
                order.vol, pos.avail
            ));
        }
    }

    Ok(())
}

fn min_to_hhmm(min: i32) -> String {
    format!("{:02}:{:02}", min / 60, min % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> RiskParams {
        RiskParams {
            max_single_pct: 20.0,
            max_total_pct: 80.0,
            fee_pct: 0.1,
            no_open_after_min: 895,
        }
    }

    fn account_cash(cash: f64) -> AccountSnapshot {
        AccountSnapshot {
            cash,
            market_value: 0.0,
            positions: HashMap::new(),
        }
    }

    #[test]
    fn weekend_is_closed() {
        assert_eq!(phase_of(0, 600), Phase::Closed); // 周日
        assert_eq!(phase_of(6, 600), Phase::Closed); // 周六
        assert_eq!(phase_of(3, 600), Phase::Morning); // 周三 10:00
        assert_eq!(phase_of(3, 700), Phase::Midday); // 周三 11:40
        assert_eq!(phase_of(3, 800), Phase::Afternoon); // 周三 13:20
        assert_eq!(phase_of(3, 910), Phase::Closed); // 周三 15:10
    }

    #[test]
    fn rejects_outside_hours_when_not_allowed() {
        let o = RiskOrder { code: "600519".into(), side: "BUY".into(), price: 100.0, vol: 100 };
        let a = account_cash(1_000_000.0);
        // 周三 10:00 → Morning，通过
        assert!(check(&o, &a, None, &params(), Phase::Morning, 600, false).is_ok());
        // 收盘后拒绝
        let r = check(&o, &a, None, &params(), Phase::Closed, 910, false);
        assert!(r.is_err());
        // 14:56 买入拒绝
        let r = check(&o, &a, None, &params(), Phase::Afternoon, 896, false);
        assert!(r.is_err());
        // 14:56 卖出允许（时段内）
        let mut sell_a = AccountSnapshot::default();
        sell_a.cash = 0.0;
        sell_a.positions.insert("600519".into(), Position { vol: 1000, avail: 1000 });
        let os = RiskOrder { code: "600519".into(), side: "SELL".into(), price: 100.0, vol: 100 };
        assert!(check(&os, &sell_a, None, &params(), Phase::Afternoon, 896, false).is_ok());
    }

    #[test]
    fn rejects_bad_price_and_odd_lot() {
        let a = account_cash(1_000_000.0);
        let o0 = RiskOrder { code: "X".into(), side: "BUY".into(), price: 0.0, vol: 100 };
        assert!(check(&o0, &a, None, &params(), Phase::Morning, 600, true).is_err());
        let o_odd = RiskOrder { code: "X".into(), side: "BUY".into(), price: 10.0, vol: 150 };
        assert!(check(&o_odd, &a, None, &params(), Phase::Morning, 600, true).is_err());
    }

    #[test]
    fn rejects_limit_up_buy() {
        let a = account_cash(1_000_000.0);
        let o = RiskOrder { code: "X".into(), side: "BUY".into(), price: 11.0, vol: 100 };
        let mk = MarketSnapshot { limit_up: Some(11.0), limit_down: Some(9.0) };
        assert!(check(&o, &a, Some(mk), &params(), Phase::Morning, 600, true).is_err());
    }

    #[test]
    fn rejects_insufficient_cash() {
        let a = account_cash(5000.0);
        let o = RiskOrder { code: "X".into(), side: "BUY".into(), price: 100.0, vol: 100 };
        // 需 10010，仅 5000
        assert!(check(&o, &a, None, &params(), Phase::Morning, 600, true).is_err());
    }

    #[test]
    fn rejects_position_limits() {
        // gross=200000，总资产 1,000,000 → 20% 正好等于上限，通过
        let a = account_cash(1_000_000.0);
        let o = RiskOrder { code: "X".into(), side: "BUY".into(), price: 2000.0, vol: 100 };
        assert!(check(&o, &a, None, &params(), Phase::Morning, 600, true).is_ok());
        // gross=300000 → 30% > 20% 单票上限
        let o2 = RiskOrder { code: "X".into(), side: "BUY".into(), price: 3000.0, vol: 100 };
        assert!(check(&o2, &a, None, &params(), Phase::Morning, 600, true).is_err());
    }

    #[test]
    fn rejects_sell_without_holding() {
        let a = account_cash(1_000_000.0);
        let o = RiskOrder { code: "X".into(), side: "SELL".into(), price: 10.0, vol: 100 };
        assert!(check(&o, &a, None, &params(), Phase::Morning, 600, true).is_err());
    }

    #[test]
    fn mock_allow_anytime_skips_session() {
        let a = account_cash(1_000_000.0);
        let o = RiskOrder { code: "X".into(), side: "BUY".into(), price: 100.0, vol: 100 };
        assert!(check(&o, &a, None, &params(), Phase::Closed, 0, true).is_ok());
    }
}
