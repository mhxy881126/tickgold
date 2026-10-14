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
    #[allow(dead_code)]
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
        m if (570..690).contains(&m) => Phase::Morning, // 9:30–11:30
        m if (690..780).contains(&m) => Phase::Midday,  // 11:30–13:00
        m if (780..900).contains(&m) => Phase::Afternoon, // 13:00–15:00
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
            return Err(format!(
                "已过禁止开仓时间（{} 后不开新仓）",
                min_to_hhmm(params.no_open_after_min)
            ));
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
        let pos = account
            .positions
            .get(&order.code)
            .copied()
            .unwrap_or_default();
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

// ===== v3.0.0-rc 账户级风控：日亏 / 回撤 / 连亏，全通道唯一账户闸门 =====

/// 账户级闸门输入（调用方从账本 / meta 组装）。
#[derive(Clone, Debug, Default)]
pub struct AccountRiskInput {
    /// 当日已实现盈亏（portfolio::realized_pnl_of_day）。
    pub day_realized_pnl: f64,
    /// 日亏百分比基数（paper_account.init_cash）。
    pub base_equity: f64,
    /// 当前总权益。
    pub equity: f64,
    /// 历史最高权益（meta: risk_peak_equity）。
    pub peak_equity: f64,
    /// 最近卖出单已实现盈亏（倒序，最近在前）。
    pub recent_realized: Vec<f64>,
}

/// 账户级风控参数（事实源：BrokerConfig）。
#[derive(Clone, Debug)]
pub struct AccountRiskParams {
    pub daily_loss_limit_pct: f64,
    pub max_drawdown_limit_pct: f64,
    pub consecutive_loss_limit: i32,
}

impl Default for AccountRiskParams {
    fn default() -> Self {
        AccountRiskParams {
            daily_loss_limit_pct: 5.0,
            max_drawdown_limit_pct: 20.0,
            consecutive_loss_limit: 3,
        }
    }
}

impl AccountRiskParams {
    pub fn from_config(c: &crate::broker::config::BrokerConfig) -> Self {
        AccountRiskParams {
            daily_loss_limit_pct: c.daily_loss_limit_pct,
            max_drawdown_limit_pct: c.max_drawdown_limit_pct,
            consecutive_loss_limit: c.consecutive_loss_limit,
        }
    }
}

/// 账户级闸门。仅对开仓（BUY）调用；判定口径与原 autoexec 逻辑一致，边界相等放行。
pub fn check_account(inp: &AccountRiskInput, p: &AccountRiskParams) -> Result<(), String> {
    // 1) 单日亏损
    if inp.base_equity > 0.0 {
        let loss_pct = inp.day_realized_pnl / inp.base_equity * 100.0;
        if loss_pct < -p.daily_loss_limit_pct {
            return Err(format!(
                "单日亏损 {:.2}% 超过限制 {}%，停止开新仓",
                loss_pct, p.daily_loss_limit_pct
            ));
        }
    }
    // 2) 回撤熔断（超限仅停开新仓，卖出离场永不锁死）
    if inp.peak_equity > 0.0 {
        let dd_pct = (inp.peak_equity - inp.equity) / inp.peak_equity * 100.0;
        if dd_pct > p.max_drawdown_limit_pct {
            return Err(format!(
                "账户回撤 {:.2}% 超过限制 {}%，停止开新仓",
                dd_pct, p.max_drawdown_limit_pct
            ));
        }
    }
    // 3) 连续亏损
    let mut losses = 0;
    for v in &inp.recent_realized {
        if *v < 0.0 {
            losses += 1;
        } else {
            break;
        }
    }
    if losses >= p.consecutive_loss_limit {
        return Err(format!(
            "连续亏损 {} 笔，达到限制 {} 笔，暂停开新仓",
            losses, p.consecutive_loss_limit
        ));
    }
    Ok(())
}

/// 全通道唯一入口：BUY 先过账户级闸门，再过订单级闸门；SELL 只过订单级（保证可止损离场）。
#[allow(clippy::too_many_arguments)]
pub fn gate(
    order: &RiskOrder,
    account: &AccountSnapshot,
    market: Option<MarketSnapshot>,
    op: &RiskParams,
    ai: &AccountRiskInput,
    ap: &AccountRiskParams,
    phase: Phase,
    minute_of_day: i32,
    allow_anytime: bool,
) -> Result<(), String> {
    if order.side == "BUY" {
        check_account(ai, ap)?;
    }
    check(
        order,
        account,
        market,
        op,
        phase,
        minute_of_day,
        allow_anytime,
    )
}

/// A 股代码去交易所后缀（600519.SH → 600519；无后缀原样返回）。
pub fn strip_suffix(code: &str) -> String {
    match code.split_once('.') {
        Some((bare, _)) => bare.to_string(),
        None => code.to_string(),
    }
}

/// 系统性风险分级（high/mid/low）：high = 情绪 <20 或上证 ≤-2%；mid = 情绪 <40 或 ≤-0.5%。
pub fn systemic_level(market_emotion: f64, index_chg: f64) -> &'static str {
    if market_emotion < 20.0 || index_chg <= -2.0 {
        "high"
    } else if market_emotion < 40.0 || index_chg <= -0.5 {
        "mid"
    } else {
        "low"
    }
}

// ===== 风险告警（仪表盘展示路径，纯函数）=====

/// 风险告警条目。
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskWarning {
    /// danger（超限，强制横条）/ warn（接近阈值或系统性风险）。
    pub level: String,
    pub code: String,
    pub text: String,
}

/// 告警计算输入（当前账户实测读数）。
#[derive(Clone, Debug, Default)]
pub struct WarningInput {
    pub kill_switch: bool,
    pub position_pct: f64,
    pub max_single_pct: f64,
    pub drawdown_pct: f64,
    pub daily_loss_pct: f64,
    pub consecutive_losses: i32,
    /// systemic_level 返回值（low/mid/high）。
    pub systemic_level: String,
}

/// 依据实测读数与阈值生成告警；同一指标 danger 优先，不重复产生 warn。
pub fn evaluate_warnings(
    inp: &WarningInput,
    limits: &AccountRiskParams,
    max_total_limit: f64,
    max_single_limit: f64,
) -> Vec<RiskWarning> {
    let mut out = Vec::new();
    let mut push = |cond: bool, level: &str, code: &str, text: String| {
        if cond {
            out.push(RiskWarning {
                level: level.to_string(),
                code: code.to_string(),
                text,
            });
        }
    };

    if inp.kill_switch {
        push(
            true,
            "danger",
            "killSwitch",
            "紧急停止已触发，全部交易通道锁定，恢复需手动".to_string(),
        );
    }

    // 总仓位
    if inp.position_pct > max_total_limit {
        push(
            true,
            "danger",
            "position",
            format!(
                "总仓位 {:.1}% 超过上限 {:.1}%",
                inp.position_pct, max_total_limit
            ),
        );
    } else if inp.position_pct > max_total_limit * 0.8 {
        push(
            true,
            "warn",
            "position",
            format!(
                "总仓位 {:.1}% 接近上限 {:.1}%",
                inp.position_pct, max_total_limit
            ),
        );
    }

    // 单票集中度
    if inp.max_single_pct > max_single_limit {
        push(
            true,
            "danger",
            "single",
            format!(
                "单票集中度 {:.1}% 超过上限 {:.1}%",
                inp.max_single_pct, max_single_limit
            ),
        );
    } else if inp.max_single_pct > max_single_limit * 0.8 {
        push(
            true,
            "warn",
            "single",
            format!(
                "单票集中度 {:.1}% 接近上限 {:.1}%",
                inp.max_single_pct, max_single_limit
            ),
        );
    }

    // 累计回撤
    if inp.drawdown_pct > limits.max_drawdown_limit_pct {
        push(
            true,
            "danger",
            "drawdown",
            format!(
                "累计回撤 {:.2}% 超过限制 {}%",
                inp.drawdown_pct, limits.max_drawdown_limit_pct
            ),
        );
    } else if inp.drawdown_pct > limits.max_drawdown_limit_pct * 0.8 {
        push(
            true,
            "warn",
            "drawdown",
            format!(
                "累计回撤 {:.2}% 接近限制 {}%",
                inp.drawdown_pct, limits.max_drawdown_limit_pct
            ),
        );
    }

    // 单日亏损（daily_loss_pct 负数为亏）
    if inp.daily_loss_pct < -limits.daily_loss_limit_pct {
        push(
            true,
            "danger",
            "dayLoss",
            format!(
                "单日亏损 {:.2}% 超过限制 {}%",
                inp.daily_loss_pct, limits.daily_loss_limit_pct
            ),
        );
    } else if inp.daily_loss_pct < -limits.daily_loss_limit_pct * 0.8 {
        push(
            true,
            "warn",
            "dayLoss",
            format!(
                "单日亏损 {:.2}% 接近限制 {}%",
                inp.daily_loss_pct, limits.daily_loss_limit_pct
            ),
        );
    }

    // 连续亏损
    if inp.consecutive_losses >= limits.consecutive_loss_limit {
        push(
            true,
            "danger",
            "consecutive",
            format!(
                "连续亏损 {} 笔达到限制 {} 笔",
                inp.consecutive_losses, limits.consecutive_loss_limit
            ),
        );
    }

    // 系统性风险
    if inp.systemic_level == "high" {
        push(
            true,
            "warn",
            "systemic",
            "市场系统性风险高（情绪冰点或指数大跌），谨慎开新仓".to_string(),
        );
    }

    out
}

// ===== QMT sidecar 持仓事件解析（无真机环境时的核心可测逻辑）=====

/// QMT 持仓缓存条目（key=裸码）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct QmtPosition {
    pub vol: i64,
    pub avail: i64,
    pub cost: f64,
    pub mv: f64,
}

/// 解析 sidecar position 事件。返回 (裸码 → 持仓条目, 是否全量)。
/// 全量判定：条目数 ≥2 或任一条目带 cost/marketValue（query_position 全量回报）；
/// 否则为单只增量（on_stock_position）。vol==0 的条目由调用方据此 remove。
pub fn parse_position_event(v: &serde_json::Value) -> (Vec<(String, QmtPosition)>, bool) {
    let Some(arr) = v["positions"].as_array() else {
        return (Vec::new(), false);
    };
    let mut out = Vec::new();
    // 空数组即全量回报为空仓账户（区别于尚未同步）。
    let mut full = arr.is_empty();
    for p in arr {
        let raw = p["code"].as_str().unwrap_or("");
        let code = strip_suffix(raw);
        if code.is_empty() {
            continue;
        }
        let cost = p["cost"].as_f64().unwrap_or(0.0);
        let mv = p["marketValue"].as_f64().unwrap_or(0.0);
        if p.get("cost").is_some() || p.get("marketValue").is_some() {
            full = true;
        }
        out.push((
            code,
            QmtPosition {
                vol: p["vol"].as_i64().unwrap_or(0),
                avail: p["avail"].as_i64().unwrap_or(0),
                cost,
                mv,
            },
        ));
    }
    if out.len() >= 2 {
        full = true;
    }
    (out, full)
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
        let o = RiskOrder {
            code: "600519".into(),
            side: "BUY".into(),
            price: 100.0,
            vol: 100,
        };
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
        let sell_a = AccountSnapshot {
            cash: 0.0,
            positions: HashMap::from([(
                "600519".into(),
                Position {
                    vol: 1000,
                    avail: 1000,
                },
            )]),
            ..Default::default()
        };
        let os = RiskOrder {
            code: "600519".into(),
            side: "SELL".into(),
            price: 100.0,
            vol: 100,
        };
        assert!(check(&os, &sell_a, None, &params(), Phase::Afternoon, 896, false).is_ok());
    }

    #[test]
    fn rejects_bad_price_and_odd_lot() {
        let a = account_cash(1_000_000.0);
        let o0 = RiskOrder {
            code: "X".into(),
            side: "BUY".into(),
            price: 0.0,
            vol: 100,
        };
        assert!(check(&o0, &a, None, &params(), Phase::Morning, 600, true).is_err());
        let o_odd = RiskOrder {
            code: "X".into(),
            side: "BUY".into(),
            price: 10.0,
            vol: 150,
        };
        assert!(check(&o_odd, &a, None, &params(), Phase::Morning, 600, true).is_err());
    }

    #[test]
    fn rejects_limit_up_buy() {
        let a = account_cash(1_000_000.0);
        let o = RiskOrder {
            code: "X".into(),
            side: "BUY".into(),
            price: 11.0,
            vol: 100,
        };
        let mk = MarketSnapshot {
            limit_up: Some(11.0),
            limit_down: Some(9.0),
        };
        assert!(check(&o, &a, Some(mk), &params(), Phase::Morning, 600, true).is_err());
    }

    #[test]
    fn rejects_insufficient_cash() {
        let a = account_cash(5000.0);
        let o = RiskOrder {
            code: "X".into(),
            side: "BUY".into(),
            price: 100.0,
            vol: 100,
        };
        // 需 10010，仅 5000
        assert!(check(&o, &a, None, &params(), Phase::Morning, 600, true).is_err());
    }

    #[test]
    fn rejects_position_limits() {
        // gross=200000，总资产 1,000,000 → 20% 正好等于上限，通过
        let a = account_cash(1_000_000.0);
        let o = RiskOrder {
            code: "X".into(),
            side: "BUY".into(),
            price: 2000.0,
            vol: 100,
        };
        assert!(check(&o, &a, None, &params(), Phase::Morning, 600, true).is_ok());
        // gross=300000 → 30% > 20% 单票上限
        let o2 = RiskOrder {
            code: "X".into(),
            side: "BUY".into(),
            price: 3000.0,
            vol: 100,
        };
        assert!(check(&o2, &a, None, &params(), Phase::Morning, 600, true).is_err());
    }

    #[test]
    fn rejects_sell_without_holding() {
        let a = account_cash(1_000_000.0);
        let o = RiskOrder {
            code: "X".into(),
            side: "SELL".into(),
            price: 10.0,
            vol: 100,
        };
        assert!(check(&o, &a, None, &params(), Phase::Morning, 600, true).is_err());
    }

    #[test]
    fn mock_allow_anytime_skips_session() {
        let a = account_cash(1_000_000.0);
        let o = RiskOrder {
            code: "X".into(),
            side: "BUY".into(),
            price: 100.0,
            vol: 100,
        };
        assert!(check(&o, &a, None, &params(), Phase::Closed, 0, true).is_ok());
    }

    // ===== v3.0.0-rc 新增测试 =====

    fn ap() -> AccountRiskParams {
        AccountRiskParams::default()
    }

    fn ai_input(day_pnl: f64, equity: f64, peak: f64, recent: Vec<f64>) -> AccountRiskInput {
        AccountRiskInput {
            day_realized_pnl: day_pnl,
            base_equity: 1_000_000.0,
            equity,
            peak_equity: peak,
            recent_realized: recent,
        }
    }

    #[test]
    fn account_daily_loss_boundary() {
        // -5% 恰好等于限制 → 放行
        assert!(check_account(&ai_input(-50_000.0, 950_000.0, 1_000_000.0, vec![]), &ap()).is_ok());
        // -5.01% → 拒绝
        assert!(
            check_account(&ai_input(-50_100.0, 949_900.0, 1_000_000.0, vec![]), &ap()).is_err()
        );
        // 盈利不受影响
        assert!(
            check_account(&ai_input(10_000.0, 1_010_000.0, 1_010_000.0, vec![]), &ap()).is_ok()
        );
    }

    #[test]
    fn account_drawdown_boundary() {
        // 回撤 20% 恰好 → 放行
        assert!(check_account(&ai_input(0.0, 800_000.0, 1_000_000.0, vec![]), &ap()).is_ok());
        // 回撤 20.1% → 拒绝
        assert!(check_account(&ai_input(0.0, 799_000.0, 1_000_000.0, vec![]), &ap()).is_err());
    }

    #[test]
    fn account_consecutive_losses() {
        // 两负一正 → 计数 2 < 3，放行
        assert!(check_account(
            &ai_input(0.0, 1_000_000.0, 1_000_000.0, vec![-100.0, -200.0, 300.0]),
            &ap()
        )
        .is_ok());
        // 连续三个负 → 拒绝
        assert!(check_account(
            &ai_input(0.0, 1_000_000.0, 1_000_000.0, vec![-100.0, -200.0, -300.0]),
            &ap()
        )
        .is_err());
        // 空列表放行
        assert!(check_account(&ai_input(0.0, 1_000_000.0, 1_000_000.0, vec![]), &ap()).is_ok());
    }

    #[test]
    fn initial_account_not_tripped() {
        assert!(check_account(&AccountRiskInput::default(), &ap()).is_ok());
    }

    #[test]
    fn gate_sell_passes_when_account_tripped() {
        // 账户日亏超限；SELL 仍放行（账户级只拦 BUY）
        let ai = ai_input(-50_100.0, 949_900.0, 1_000_000.0, vec![-1.0, -2.0, -3.0]);
        let sell_a = AccountSnapshot {
            cash: 0.0,
            positions: HashMap::from([(
                "X".into(),
                Position {
                    vol: 1000,
                    avail: 1000,
                },
            )]),
            ..Default::default()
        };
        let os = RiskOrder {
            code: "X".into(),
            side: "SELL".into(),
            price: 100.0,
            vol: 100,
        };
        assert!(gate(
            &os,
            &sell_a,
            None,
            &params(),
            &ai,
            &ap(),
            Phase::Afternoon,
            800,
            false
        )
        .is_ok());
        // BUY 被账户级拦截
        let ob = RiskOrder {
            code: "Y".into(),
            side: "BUY".into(),
            price: 100.0,
            vol: 100,
        };
        let ab = account_cash(1_000_000.0);
        assert!(gate(
            &ob,
            &ab,
            None,
            &params(),
            &ai,
            &ap(),
            Phase::Morning,
            600,
            false
        )
        .is_err());
    }

    #[test]
    fn gate_chains_account_then_order() {
        // 账户级通过、订单级涨停拒单
        let ai = ai_input(0.0, 1_000_000.0, 1_000_000.0, vec![]);
        let a = account_cash(1_000_000.0);
        let o = RiskOrder {
            code: "X".into(),
            side: "BUY".into(),
            price: 11.0,
            vol: 100,
        };
        let mk = MarketSnapshot {
            limit_up: Some(11.0),
            limit_down: Some(9.0),
        };
        assert!(gate(
            &o,
            &a,
            Some(mk),
            &params(),
            &ai,
            &ap(),
            Phase::Morning,
            600,
            false
        )
        .is_err());
    }

    #[test]
    fn systemic_levels() {
        assert_eq!(systemic_level(10.0, 0.0), "high");
        assert_eq!(systemic_level(50.0, -2.5), "high");
        assert_eq!(systemic_level(30.0, 0.0), "mid");
        assert_eq!(systemic_level(50.0, -0.8), "mid");
        assert_eq!(systemic_level(60.0, 0.3), "low");
    }

    #[test]
    fn strip_suffix_cases() {
        assert_eq!(strip_suffix("600519.SH"), "600519");
        assert_eq!(strip_suffix("000001.SZ"), "000001");
        assert_eq!(strip_suffix("830799.BJ"), "830799");
        assert_eq!(strip_suffix("600519"), "600519");
        assert_eq!(strip_suffix(""), "");
    }

    #[test]
    fn warnings_danger_and_warn() {
        // kill switch → danger
        let mut inp = WarningInput {
            kill_switch: true,
            ..Default::default()
        };
        let ws = evaluate_warnings(&inp, &ap(), 80.0, 20.0);
        assert!(ws
            .iter()
            .any(|w| w.level == "danger" && w.code == "killSwitch"));

        // 总仓位 70%（>80% 的 80%=64%）→ warn
        inp = WarningInput {
            position_pct: 70.0,
            ..Default::default()
        };
        let ws = evaluate_warnings(&inp, &ap(), 80.0, 20.0);
        assert!(ws.iter().any(|w| w.level == "warn" && w.code == "position"));

        // 总仓位 85% → danger，不应再产生同指标 warn
        inp = WarningInput {
            position_pct: 85.0,
            ..Default::default()
        };
        let ws = evaluate_warnings(&inp, &ap(), 80.0, 20.0);
        assert_eq!(ws.iter().filter(|w| w.code == "position").count(), 1);
        assert!(ws.iter().any(|w| w.level == "danger"));

        // 系统风险 high → warn
        inp = WarningInput {
            systemic_level: "high".to_string(),
            ..Default::default()
        };
        let ws = evaluate_warnings(&inp, &ap(), 80.0, 20.0);
        assert!(ws.iter().any(|w| w.code == "systemic"));

        // 全部正常 → 空
        inp = WarningInput::default();
        assert!(evaluate_warnings(&inp, &ap(), 80.0, 20.0).is_empty());
    }

    #[test]
    fn parse_position_full_and_incremental() {
        // 全量：2 条目带 cost/mv
        let v = serde_json::json!({"event":"position","positions":[
            {"code":"600519.SH","vol":1000,"avail":1000,"cost":1800.0,"marketValue":1_800_000.0},
            {"code":"000001.SZ","vol":2000,"avail":2000,"cost":12.0,"marketValue":24000.0}
        ]});
        let (items, full) = parse_position_event(&v);
        assert!(full);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].0, "600519");
        assert_eq!(items[0].1.vol, 1000);

        // 增量：单只无 cost
        let v2 = serde_json::json!({"event":"position","positions":[
            {"code":"600519.SH","vol":500,"avail":0}
        ]});
        let (items2, full2) = parse_position_event(&v2);
        assert!(!full2);
        assert_eq!(items2.len(), 1);
        assert_eq!(items2[0].1.avail, 0);

        // 空数组 = 全量回报空仓账户（区别于尚未同步/非 position 事件）
        let v3 = serde_json::json!({"event":"position","positions":[]});
        let (items3, full3) = parse_position_event(&v3);
        assert!(full3);
        assert!(items3.is_empty());

        // 缺 positions 字段 = 非全量，不置同步标记
        let v4 = serde_json::json!({"event":"position"});
        let (_, full4) = parse_position_event(&v4);
        assert!(!full4);
    }
}
