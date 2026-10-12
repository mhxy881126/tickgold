// 统一账本组合层（v2.28）：paper_account / paper_position / paper_order 三表为唯一事实源。
// 手动模拟交易、broker mock 成交、条件单自动确认、autoexec 自动机器人全部经此模块落账，
// 禁止再各自直写三表。费用 / T+1 / 涨跌停口径全应用唯一。
use crate::ai::now_millis;
use rusqlite::{Connection, Transaction};
use serde::Serialize;

// ===== 费用（与历史 paper.ts 口径严格一致）=====
const COMMISSION_RATE: f64 = 0.00025; // 佣金 万2.5（双向，最低 5 元）
const STAMP_RATE: f64 = 0.0005; // 印花税 卖出 千0.5
const TRANSFER_RATE: f64 = 0.00001; // 过户费 十万分之一（双向）

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn parse(s: &str) -> Result<Side, String> {
        match s.to_lowercase().as_str() {
            "buy" => Ok(Side::Buy),
            "sell" => Ok(Side::Sell),
            _ => Err(format!("未知买卖方向：{s}")),
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Side::Buy => "buy",
            Side::Sell => "sell",
        }
    }
}

/// 计算成交费用。side=Buy/Sell，amount=成交金额（价×量）。
pub fn calc_fee(side: Side, amount: f64) -> f64 {
    let commission = (amount * COMMISSION_RATE).max(5.0);
    let stamp = if side == Side::Sell { amount * STAMP_RATE } else { 0.0 };
    let transfer = amount * TRANSFER_RATE;
    commission + stamp + transfer
}

// ===== 数据结构 =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionView {
    pub code: String,
    pub name: String,
    pub vol: i64,
    pub avail_vol: i64,
    pub cost_amount: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FillResult {
    pub order_id: String,
    pub amount: f64,
    pub fee: f64,
    pub cash: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioSnapshot {
    pub init_cash: f64,
    pub cash: f64,
    pub market_value: f64,
    pub total_assets: f64,
    pub total_pnl: f64,
    pub total_pnl_pct: f64,
    pub float_pnl: f64,
    pub day_pnl: f64,
    pub positions: Vec<PositionView>,
}

/// 建仓入参。limit_prices=Some((涨停,跌停)) 时做涨跌停拦截；sig_id 用于关联信号/委托（可空）。
#[derive(Debug, Clone)]
pub struct FillReq<'a> {
    pub code: &'a str,
    pub name: &'a str,
    pub side: Side,
    pub price: f64,
    pub vol: i64,
    pub sig_id: &'a str,
    pub trade_date: &'a str,
    pub limit_prices: Option<(f64, f64)>,
}

// ===== 账户初始化 =====

/// 确保账户行存在（已存在不改动）。
pub fn ensure_account(conn: &Connection, init_cash: f64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO paper_account(id, init_cash, cash, created_at)
         VALUES(1,?1,?1,?2) ON CONFLICT(id) DO NOTHING",
        rusqlite::params![init_cash, now_millis()],
    )
    .map_err(|e| format!("初始化模拟账户失败: {e}"))?;
    Ok(())
}

/// 读取现金；账户未初始化返回 None。
pub fn load_cash(conn: &Connection) -> Result<Option<(f64, f64)>, String> {
    let r = conn
        .query_row(
            "SELECT init_cash, cash FROM paper_account WHERE id=1",
            [],
            |r| Ok((r.get::<_, f64>(0)?, r.get::<_, f64>(1)?)),
        )
        .map_err(|e| format!("读取模拟账户失败: {e}"))?;
    Ok(Some(r))
}

/// 读取全部持仓。
pub fn load_positions(conn: &Connection) -> Result<Vec<PositionView>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT code,name,vol,avail_vol,cost_amount FROM paper_position ORDER BY code",
        )
        .map_err(|e| format!("读取持仓失败: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PositionView {
                code: r.get(0)?,
                name: r.get(1)?,
                vol: r.get(2)?,
                avail_vol: r.get(3)?,
                cost_amount: r.get(4)?,
            })
        })
        .map_err(|e| format!("读取持仓失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取持仓行失败: {e}"))?);
    }
    Ok(out)
}

// ===== T+1 清算 =====

/// 跨自然日把全部持仓可卖量同步为持有量。返回是否执行了解锁。
pub fn settle(conn: &Connection, today: &str) -> Result<bool, String> {
    let last: String = conn
        .query_row(
            "SELECT value FROM meta WHERE key='paper_settle_date'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default();
    if last == today {
        return Ok(false);
    }
    conn.execute("UPDATE paper_position SET avail_vol=vol", [])
        .map_err(|e| format!("T+1 解锁失败: {e}"))?;
    conn.execute(
        "INSERT INTO meta(key,value) VALUES('paper_settle_date',?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![today],
    )
    .map_err(|e| format!("写入清算日期失败: {e}"))?;
    Ok(true)
}

// ===== 成交（事务）=====

/// 统一成交入口：校验 + 一个事务内落 账户/持仓/委托 三表。
pub fn apply_fill(conn: &mut Connection, req: &FillReq) -> Result<FillResult, String> {
    if req.price.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        return Err("行情无效，无法成交".to_string());
    }
    if req.vol <= 0 || req.vol % 100 != 0 {
        return Err("成交数量须为 100 股整数倍".to_string());
    }
    if let Some((up, dn)) = req.limit_prices {
        match req.side {
            Side::Buy if req.price >= up => {
                return Err("价格触及涨停，买入无法成交".to_string());
            }
            Side::Sell if req.price <= dn => {
                return Err("价格触及跌停，卖出无法成交".to_string());
            }
            _ => {}
        }
    }
    let amount = req.price * req.vol as f64;
    let fee = calc_fee(req.side, amount);
    let now = now_millis();

    let tx = conn
        .transaction()
        .map_err(|e| format!("开启成交事务失败: {e}"))?;
    match req.side {
        Side::Buy => buy_tx(&tx, req, amount, fee, now)?,
        Side::Sell => sell_tx(&tx, req, amount, fee, now)?, // name 以持仓行回查为准
    }
    tx.commit().map_err(|e| format!("提交成交事务失败: {e}"))?;

    let (_, cash) = load_cash(conn)?.ok_or_else(|| "模拟账户不存在".to_string())?;
    Ok(FillResult {
        order_id: order_id_for(req, now),
        amount,
        fee,
        cash,
    })
}

fn order_id_for(req: &FillReq, now: i64) -> String {
    // broker/条件单路径以 sig_id 作委托 id；纯手动路径生成 PO 前缀 id
    //（带 side 首字母，避免同一只票同秒手动买卖 id 冲突）。
    if req.sig_id.is_empty() {
        format!("PO{now}{}{}", &req.code, req.side.as_str())
    } else {
        req.sig_id.to_string()
    }
}

#[allow(clippy::too_many_arguments)]
fn buy_tx(
    tx: &Transaction,
    req: &FillReq,
    amount: f64,
    fee: f64,
    now: i64,
) -> Result<(), String> {
    let total = amount + fee;
    let cash: f64 = tx
        .query_row("SELECT cash FROM paper_account WHERE id=1", [], |r| r.get(0))
        .map_err(|e| format!("读取资金失败: {e}"))?;
    if cash < total - 1e-6 {
        return Err("可用资金不足".to_string());
    }
    tx.execute(
        "UPDATE paper_account SET cash=cash-?1 WHERE id=1",
        rusqlite::params![total],
    )
    .map_err(|e| format!("扣减资金失败: {e}"))?;
    // T+1：当日买入 avail_vol 不增加。
    tx.execute(
        "INSERT INTO paper_position(code,name,vol,avail_vol,cost_amount,updated_at)
         VALUES(?1,?2,?3,0,?4,?5)
         ON CONFLICT(code) DO UPDATE SET
           name=excluded.name, vol=vol+excluded.vol,
           cost_amount=cost_amount+excluded.cost_amount, updated_at=excluded.updated_at",
        rusqlite::params![req.code, req.name, req.vol, total, now],
    )
    .map_err(|e| format!("写入持仓失败: {e}"))?;
    insert_order(tx, req, req.name, amount, fee, 0.0, now)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn sell_tx(
    tx: &Transaction,
    req: &FillReq,
    amount: f64,
    fee: f64,
    now: i64,
) -> Result<(), String> {
    let (vol, avail, cost_amount, pos_name): (i64, i64, f64, String) = tx
        .query_row(
            "SELECT vol,avail_vol,cost_amount,name FROM paper_position WHERE code=?1",
            rusqlite::params![req.code],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|_| "无该股票持仓".to_string())?;
    if req.vol > avail {
        return Err("卖出数量超过可卖（T+1）".to_string());
    }
    let new_vol = vol - req.vol;
    let cost_reduce = cost_amount * (req.vol as f64 / vol as f64);
    let proceeds = amount - fee;
    let name = if req.name.is_empty() { &pos_name } else { req.name };
    if new_vol <= 0 {
        tx.execute("DELETE FROM paper_position WHERE code=?1", rusqlite::params![req.code])
            .map_err(|e| format!("删除持仓失败: {e}"))?;
    } else {
        tx.execute(
            "UPDATE paper_position SET vol=?1, cost_amount=cost_amount-?2, updated_at=?3
             WHERE code=?4",
            rusqlite::params![new_vol, cost_reduce, now, req.code],
        )
        .map_err(|e| format!("更新持仓失败: {e}"))?;
    }
    tx.execute(
        "UPDATE paper_account SET cash=cash+?1 WHERE id=1",
        rusqlite::params![proceeds],
    )
    .map_err(|e| format!("增加资金失败: {e}"))?;
    // 已实现盈亏 = 卖出净收入 − 对应成本（扣费口径，买/卖费用全部计入）
    let realized_pnl = proceeds - cost_reduce;
    insert_order(tx, req, name, amount, fee, realized_pnl, now)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_order(
    tx: &Transaction,
    req: &FillReq,
    name: &str,
    amount: f64,
    fee: f64,
    realized_pnl: f64,
    now: i64,
) -> Result<(), String> {
    let id = order_id_for(req, now);
    tx.execute(
        "INSERT INTO paper_order(id,code,name,side,price,vol,amount,fee,status,created_at,trade_date,sig_id,realized_pnl)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'filled',?9,?10,?11,?12)",
        rusqlite::params![
            id,
            req.code,
            name,
            req.side.as_str(),
            req.price,
            req.vol,
            amount,
            fee,
            now,
            req.trade_date,
            req.sig_id,
            realized_pnl
        ],
    )
    .map_err(|e| format!("写入成交记录失败: {e}"))?;
    Ok(())
}

// ===== 注入持仓 / 重置 =====

/// 注入"昨日及以前"持仓（可卖量=持有量，T+1 已解锁），供 mock_seed_position 使用。
pub fn seed_position(
    conn: &mut Connection,
    code: &str,
    name: &str,
    vol: i64,
    price: f64,
) -> Result<(), String> {
    if vol <= 0 || price.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        return Err("注入数量/价格无效".to_string());
    }
    let amount = price * vol as f64;
    let now = now_millis();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启注入事务失败: {e}"))?;
    tx.execute(
        "INSERT INTO paper_position(code,name,vol,avail_vol,cost_amount,updated_at)
         VALUES(?1,?2,?3,?3,?4,?5)
         ON CONFLICT(code) DO UPDATE SET
           name=excluded.name, vol=excluded.vol, avail_vol=excluded.vol,
           cost_amount=excluded.cost_amount, updated_at=excluded.updated_at",
        rusqlite::params![code, name, vol, amount, now],
    )
    .map_err(|e| format!("注入持仓失败: {e}"))?;
    tx.commit().map_err(|e| format!("提交注入事务失败: {e}"))?;
    Ok(())
}

/// 重置账本：清空持仓/成交，init_cash 与 cash 均设为 cash（供 mock_reset 使用）。
pub fn reset_to(conn: &Connection, cash: f64) -> Result<(), String> {
    if cash.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        return Err("初始资金须大于 0".to_string());
    }
    conn.execute("DELETE FROM paper_position", [])
        .map_err(|e| format!("清空持仓失败: {e}"))?;
    conn.execute("DELETE FROM paper_order", [])
        .map_err(|e| format!("清空成交失败: {e}"))?;
    conn.execute(
        "UPDATE paper_account SET init_cash=?1, cash=?1 WHERE id=1",
        rusqlite::params![cash],
    )
    .map_err(|e| format!("重置资金失败: {e}"))?;
    Ok(())
}

// ===== 已实现盈亏统计（日亏 / 连亏风控）=====

/// 指定交易日卖出单的已实现盈亏合计。
pub fn realized_pnl_of_day(conn: &Connection, trade_date: &str) -> Result<f64, String> {
    conn.query_row(
        "SELECT COALESCE(SUM(realized_pnl),0) FROM paper_order
         WHERE trade_date=?1 AND side='sell'",
        rusqlite::params![trade_date],
        |r| r.get(0),
    )
    .map_err(|e| format!("读取当日盈亏失败: {e}"))
}

/// 最近 limit 笔卖出单的已实现盈亏（按时间倒序：最近在前）。
pub fn recent_realized(conn: &Connection, limit: i64) -> Result<Vec<f64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT realized_pnl FROM paper_order WHERE side='sell'
             ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|e| format!("读取最近成交失败: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params![limit], |r| r.get::<_, f64>(0))
        .map_err(|e| format!("读取最近成交失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取成交行失败: {e}"))?);
    }
    Ok(out)
}

// ===== 组合快照（风险仪表盘）=====

/// price_of: code → (现价, 昨收)。基于统一账本计算全部风险读数。
pub fn build_snapshot(
    conn: &Connection,
    price_of: &[(String, f64, f64)],
) -> Result<PortfolioSnapshot, String> {
    let (init_cash, cash) = load_cash(conn)?.ok_or_else(|| "模拟账户不存在".to_string())?;
    let positions = load_positions(conn)?;
    let find = |code: &str| price_of.iter().find(|(c, _, _)| c == code);
    let mut market_value = 0.0;
    let mut float_pnl = 0.0;
    let mut day_pnl = 0.0;
    for p in &positions {
        let (price, prev_close) = match find(&p.code) {
            Some((_, price, prev_close)) if *price > 0.0 => (*price, *prev_close),
            _ => {
                // 无行情：按成本价估值，不计盈亏。
                let cost_price = p.cost_amount / p.vol as f64;
                market_value += cost_price * p.vol as f64;
                continue;
            }
        };
        market_value += price * p.vol as f64;
        float_pnl += price * p.vol as f64 - p.cost_amount;
        if prev_close > 0.0 {
            day_pnl += (price - prev_close) * p.vol as f64;
        }
    }
    let total_assets = cash + market_value;
    let total_pnl = total_assets - init_cash;
    Ok(PortfolioSnapshot {
        init_cash,
        cash,
        market_value,
        total_assets,
        total_pnl,
        total_pnl_pct: if init_cash > 0.0 { total_pnl / init_cash * 100.0 } else { 0.0 },
        float_pnl,
        day_pnl,
        positions,
    })
}

// ===== 风险仪表盘（v2.28 一本账·风险卡）=====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionRisk {
    pub code: String,
    pub name: String,
    pub market_value: f64,
    /// 占总资产比例 %。
    pub pct: f64,
    pub float_pnl: f64,
    pub float_pnl_pct: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskSnapshot {
    /// 总权益（= 现金 + 持仓市值）。
    pub equity: f64,
    pub cash: f64,
    pub market_value: f64,
    /// 总仓位 %（持仓市值 / 总权益）。
    pub position_pct: f64,
    /// 单票最大集中度 %。
    pub max_single_pct: f64,
    pub max_single_code: String,
    pub total_pnl: f64,
    pub total_pnl_pct: f64,
    pub float_pnl: f64,
    pub day_pnl: f64,
    /// 当日盈亏占总权益 %。
    pub day_pnl_pct: f64,
    /// 相对历史最高权益的回撤 %。
    pub drawdown_pct: f64,
    /// 历史最高权益。
    pub peak_equity: f64,
    pub positions: Vec<PositionRisk>,
}

/// 基于统一账本计算风险读数。
/// price_of: code → (现价, 昨收)；peak_equity: 外部维护的历史最高权益（无则以当前权益为峰）。
pub fn build_risk_snapshot(
    conn: &Connection,
    price_of: &[(String, f64, f64)],
    peak_equity: Option<f64>,
) -> Result<RiskSnapshot, String> {
    let s = build_snapshot(conn, price_of)?;
    let find = |code: &str| price_of.iter().find(|(c, _, _)| c == code);
    let equity = s.total_assets;

    let mut positions = Vec::with_capacity(s.positions.len());
    for p in &s.positions {
        let cost_price = p.cost_amount / p.vol as f64;
        let (price, _prev) = match find(&p.code) {
            Some((_, price, _)) if *price > 0.0 => (*price, 0.0),
            _ => (cost_price, 0.0),
        };
        let mv = price * p.vol as f64;
        let fp = mv - p.cost_amount;
        positions.push(PositionRisk {
            code: p.code.clone(),
            name: p.name.clone(),
            market_value: mv,
            pct: if equity > 0.0 { mv / equity * 100.0 } else { 0.0 },
            float_pnl: fp,
            float_pnl_pct: if p.cost_amount > 0.0 { fp / p.cost_amount * 100.0 } else { 0.0 },
        });
    }
    positions.sort_by(|a, b| b.market_value.partial_cmp(&a.market_value).unwrap());

    let (max_single_pct, max_single_code) = positions
        .first()
        .map(|p| (p.pct, p.code.clone()))
        .unwrap_or((0.0, String::new()));

    let peak = peak_equity.filter(|v| *v > 0.0 && *v >= equity).unwrap_or(equity);
    Ok(RiskSnapshot {
        equity,
        cash: s.cash,
        market_value: s.market_value,
        position_pct: if equity > 0.0 { s.market_value / equity * 100.0 } else { 0.0 },
        max_single_pct,
        max_single_code,
        total_pnl: s.total_pnl,
        total_pnl_pct: s.total_pnl_pct,
        float_pnl: s.float_pnl,
        day_pnl: s.day_pnl,
        day_pnl_pct: if equity > 0.0 { s.day_pnl / equity * 100.0 } else { 0.0 },
        drawdown_pct: if peak > 0.0 { (peak - equity) / peak * 100.0 } else { 0.0 },
        peak_equity: peak,
        positions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memdb() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE paper_account (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                init_cash REAL NOT NULL, cash REAL NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE paper_position (
                code TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
                vol INTEGER NOT NULL DEFAULT 0, avail_vol INTEGER NOT NULL DEFAULT 0,
                cost_amount REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
             CREATE TABLE paper_order (
                id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
                side TEXT NOT NULL, price REAL NOT NULL, vol INTEGER NOT NULL,
                amount REAL NOT NULL, fee REAL NOT NULL DEFAULT 0, status TEXT NOT NULL,
                created_at INTEGER NOT NULL, trade_date TEXT NOT NULL, sig_id TEXT DEFAULT '',
                realized_pnl REAL NOT NULL DEFAULT 0);",
        )
        .unwrap();
        conn
    }

    fn req<'a>(code: &'a str, side: Side, price: f64, vol: i64) -> FillReq<'a> {
        FillReq {
            code,
            name: "测试股",
            side,
            price,
            vol,
            sig_id: "",
            trade_date: "2026-10-12",
            limit_prices: None,
        }
    }

    #[test]
    fn fee_rules() {
        // 买入 10 万元：佣金 25 + 过户 1 = 26，无印花
        let fb = calc_fee(Side::Buy, 100_000.0);
        assert!((fb - 26.0).abs() < 1e-9, "buy fee={fb}");
        // 卖出 10 万元：佣金 25 + 印花 50 + 过户 1 = 76
        let fs = calc_fee(Side::Sell, 100_000.0);
        assert!((fs - 76.0).abs() < 1e-9, "sell fee={fs}");
        // 佣金最低 5 元
        let f = calc_fee(Side::Buy, 1_000.0);
        assert!((f - 5.01).abs() < 1e-9, "min fee={f}");
    }

    #[test]
    fn buy_then_t1_sell_flow() {
        let mut c = memdb();
        ensure_account(&c, 1_000_000.0).unwrap();
        let r = apply_fill(&mut c, &req("600519", Side::Buy, 100.0, 1000)).unwrap();
        assert!((r.cash - (1_000_000.0 - 100_000.0 - r.fee)).abs() < 1e-6);
        // 当日买入不可卖
        let e = apply_fill(&mut c, &req("600519", Side::Sell, 100.0, 1000));
        assert!(e.is_err());
        // 次日清算后可卖
        assert!(settle(&c, "2026-10-13").unwrap());
        let r2 = apply_fill(&mut c, &req("600519", Side::Sell, 105.0, 1000)).unwrap();
        // cash = 1,000,000 - 100,000 - fee买 + 105,000 - fee卖
        assert!((r2.cash - 900_000.0 - 105_000.0 + r2.fee + r.fee).abs() < 1e-6);
        assert!(load_positions(&c).unwrap().is_empty());
    }

    #[test]
    fn insufficient_cash_rejected() {
        let mut c = memdb();
        ensure_account(&c, 50_000.0).unwrap();
        let e = apply_fill(&mut c, &req("600519", Side::Buy, 100.0, 1000));
        assert!(e.unwrap_err().contains("可用资金不足"));
    }

    #[test]
    fn limit_price_blocks() {
        let mut c = memdb();
        ensure_account(&c, 1_000_000.0).unwrap();
        // prev_close=10，主板涨停 11.0
        let mut r = req("600519", Side::Buy, 11.0, 100);
        r.limit_prices = Some((11.0, 9.0));
        assert!(apply_fill(&mut c, &r).is_err());
        r.price = 10.5;
        assert!(apply_fill(&mut c, &r).is_ok());
    }

    #[test]
    fn settle_idempotent_same_day() {
        let mut c = memdb();
        ensure_account(&c, 1_000_000.0).unwrap();
        apply_fill(&mut c, &req("600519", Side::Buy, 10.0, 100)).unwrap();
        assert!(settle(&c, "2026-10-13").unwrap());
        assert!(!settle(&c, "2026-10-13").unwrap());
    }

    #[test]
    fn snapshot_with_quotes() {
        let mut c = memdb();
        ensure_account(&c, 1_000_000.0).unwrap();
        apply_fill(&mut c, &req("600519", Side::Buy, 100.0, 1000)).unwrap();
        let prices = vec![("600519".to_string(), 110.0, 105.0)];
        let s = build_snapshot(&c, &prices).unwrap();
        assert!((s.market_value - 110_000.0).abs() < 1e-6);
        // float = 110000 - (100000+fee_buy)
        assert!(s.float_pnl > 9_000.0);
        // day = (110-105)*1000 = 5000
        assert!((s.day_pnl - 5_000.0).abs() < 1e-6);
    }
}
