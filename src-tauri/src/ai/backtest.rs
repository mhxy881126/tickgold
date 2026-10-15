// 回测引擎（v2.30，迁移 v51）：在 hist_kline 上逐日回放，复用
//   - intraday::daily_deep_features（与 autoexec 实盘同一套技术因子口径）
//   - fastbrain::RuleBrain（同一信号模型，支持权重覆盖供参数寻优）
//   - broker::portfolio::calc_fee（与模拟盘同一费用口径）
// 撮合：信号在 T 日收盘生成（信息截至收盘），T+1 日开盘成交，避免前视；
//   T+1 交收、涨跌停拦截、成交量参与率约束。仅本地离线计算，不外传数据。
use crate::ai::maindb;
use crate::ai::{fastbrain::RuleBrain, intraday};
use crate::broker::portfolio::{calc_fee, Side};
use crate::error::{AppError, AppResult};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::State;

// ==================== 入参 / 出参 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestReq {
    /// 回测标的池（股票代码）。
    pub codes: Vec<String>,
    /// 区间 YYYY-MM-DD。
    pub start: String,
    pub end: String,
    #[serde(default = "default_init_cash")]
    pub init_cash: f64,
    /// 买入信号置信度门槛。
    #[serde(default = "default_buy_threshold")]
    pub buy_threshold: f64,
    /// 卖出信号置信度门槛。
    #[serde(default = "default_sell_threshold")]
    pub sell_threshold: f64,
    /// 最大同时持仓只数。
    #[serde(default = "default_max_positions")]
    pub max_positions: usize,
    /// 单票目标仓位占权益 %。
    #[serde(default = "default_max_single_pct")]
    pub max_single_pct: f64,
    /// 成交量参与率上限 %（买入量不得超过当日成交量的该比例）。
    #[serde(default = "default_participation")]
    pub participation_pct: f64,
    /// 滑点 %（开盘价向不利方向偏移）。
    #[serde(default)]
    pub slippage_pct: f64,
    /// 基准指数代码（如 000300 / 000001）；空则不带基准。
    #[serde(default)]
    pub benchmark: String,
    /// 方案名称。
    #[serde(default)]
    pub name: String,
    /// RuleBrain 因子权重覆盖（参数寻优用）。
    #[serde(default)]
    pub weights: Option<HashMap<String, f64>>,
}

fn default_init_cash() -> f64 {
    1_000_000.0
}
fn default_buy_threshold() -> f64 {
    0.6
}
fn default_sell_threshold() -> f64 {
    0.6
}
fn default_max_positions() -> usize {
    5
}
fn default_max_single_pct() -> f64 {
    20.0
}
fn default_participation() -> f64 {
    10.0
}

impl Default for BacktestReq {
    fn default() -> Self {
        BacktestReq {
            codes: vec![],
            start: String::new(),
            end: String::new(),
            init_cash: default_init_cash(),
            buy_threshold: default_buy_threshold(),
            sell_threshold: default_sell_threshold(),
            max_positions: default_max_positions(),
            max_single_pct: default_max_single_pct(),
            participation_pct: default_participation(),
            slippage_pct: 0.0,
            benchmark: String::new(),
            name: String::new(),
            weights: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trade {
    pub code: String,
    pub name: String,
    pub side: String,
    pub date: String,
    pub price: f64,
    pub vol: i64,
    pub amount: f64,
    pub fee: f64,
    /// 卖出单的已实现盈亏。
    pub pnl: f64,
    /// 持仓自然交易日数（卖出单）。
    pub holding_days: i64,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EquityPoint {
    pub date: String,
    pub equity: f64,
    /// 当日相对权益峰值回撤 %。
    pub drawdown: f64,
    /// 基准归一净值（1 起步）。
    pub benchmark: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PerfStats {
    pub total_return_pct: f64,
    pub annual_return_pct: f64,
    pub benchmark_return_pct: f64,
    pub excess_return_pct: f64,
    pub win_rate_pct: f64,
    pub profit_factor: f64,
    pub max_drawdown_pct: f64,
    pub sharpe: f64,
    pub trade_count: usize,
    pub buy_count: usize,
    pub sell_count: usize,
    pub avg_pnl: f64,
    pub avg_holding_days: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthlyReturn {
    pub month: String,
    pub return_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BacktestResult {
    pub id: Option<i64>,
    pub name: String,
    pub start: String,
    pub end: String,
    pub stats: PerfStats,
    pub equity_curve: Vec<EquityPoint>,
    pub trades: Vec<Trade>,
    pub monthly: Vec<MonthlyReturn>,
    /// 实际生效的关键参数（便于报告归档）。
    pub params: HashMap<String, f64>,
}

// ==================== 数据加载 ====================

#[derive(Debug, Clone)]
struct Bar {
    date: String,
    open: f64,
    close: f64,
    high: f64,
    low: f64,
    volume: f64,
}

/// 选择复权口径：优先 qfq，无数据回退 none（指数等）。
fn pick_adj(conn: &Connection, code: &str) -> AppResult<String> {
    for adj in ["qfq", "none"] {
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM hist_kline WHERE code=?1 AND period=101 AND adj=?2",
            params![code, adj],
            |r| r.get(0),
        )?;
        if n > 0 {
            return Ok(adj.to_string());
        }
    }
    Err(AppError::NotFound(format!(
        "{code} 无本地历史K线，请先回填"
    )))
}

fn load_bars(conn: &Connection, code: &str, from: &str, to: &str) -> AppResult<(String, Vec<Bar>)> {
    let adj = pick_adj(conn, code)?;
    let mut stmt = conn.prepare(
        "SELECT date,open,close,high,low,volume FROM hist_kline \
         WHERE code=?1 AND period=101 AND adj=?2 AND date>=?3 AND date<=?4 ORDER BY date",
    )?;
    let rows = stmt.query_map(params![code, adj, from, to], |r| {
        Ok(Bar {
            date: r.get(0)?,
            open: r.get(1)?,
            close: r.get(2)?,
            high: r.get(3)?,
            low: r.get(4)?,
            volume: r.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok((adj, out))
}

fn load_names(conn: &Connection, codes: &[String]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT code,name FROM stocks WHERE name IS NOT NULL AND name<>''")
    {
        if let Ok(rows) =
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        {
            for r in rows.flatten() {
                map.insert(r.0, r.1);
            }
        }
    }
    for c in codes {
        map.entry(c.clone()).or_insert_with(|| c.clone());
    }
    map
}

/// 热身窗口：指标需要约 60 根 K 线，向前多取一年保证热身充足。
fn warm_start(start: &str) -> String {
    let yr: i32 = start[0..4].parse().unwrap_or(2026) - 1;
    format!("{yr}{}", &start[4..])
}

// ==================== 引擎内部结构 ====================

#[derive(Debug, Clone)]
struct Position {
    code: String,
    name: String,
    vol: i64,
    avail_vol: i64,
    /// 含买入费用的成本总额。
    cost_amount: f64,
    entry_date: String,
    entry_idx: usize,
}

#[derive(Debug, Clone)]
struct Order {
    code: String,
    name: String,
    side: Side,
    vol: i64,
    confidence: f64,
}

struct Engine {
    req: BacktestReq,
    names: HashMap<String, String>,
    series: HashMap<String, Vec<Bar>>,
    /// code -> (date -> 序列下标)
    index: HashMap<String, HashMap<String, usize>>,
    axis: Vec<String>,
    cash: f64,
    positions: Vec<Position>,
    pending: Vec<Order>,
    trades: Vec<Trade>,
    equity_curve: Vec<EquityPoint>,
    bench_series: Vec<Bar>,
}

impl Engine {
    fn bar_on(&self, code: &str, date: &str) -> Option<(usize, &Bar)> {
        let idx = *self.index.get(code)?.get(date)?;
        Some((idx, &self.series[code][idx]))
    }

    fn execute_pending(&mut self, date_idx: usize, date: &str) {
        if self.pending.is_empty() {
            return;
        }
        let orders = std::mem::take(&mut self.pending);
        // T+1：开盘前把往日买入的持仓全部解锁。
        for p in &mut self.positions {
            if p.entry_date.as_str() < date {
                p.avail_vol = p.vol;
            }
        }
        for o in orders {
            let Some((bidx, bar)) = self.bar_on(&o.code, date) else {
                continue;
            };
            // 涨跌停以昨收（即前一根 bar 的收盘）计算。
            let limit = if bidx > 0 {
                let prev_close = self.series[&o.code][bidx - 1].close;
                Some((
                    intraday::limit_up_price(prev_close, &o.code),
                    round2(prev_close * (1.0 - intraday::limit_pct(&o.code) / 100.0)),
                ))
            } else {
                None
            };
            let slip =
                1.0 + self.req.slippage_pct / 100.0 * if o.side == Side::Buy { 1.0 } else { -1.0 };
            let price = (bar.open * slip).max(0.01);
            let day_volume = bar.volume; // 复制后即结束对 bar 的不可变借用

            match o.side {
                Side::Buy => {
                    if self.positions.iter().any(|p| p.code == o.code) {
                        continue; // 信号后已通过其他通道持有时不重复买
                    }
                    if let Some((up, _)) = limit {
                        if price >= up {
                            continue; // 开盘涨停，买不进
                        }
                    }
                    // 仓位金额按当日开盘重算（信号日只确定目标比例）。
                    let equity = self.equity_at(date);
                    let budget = equity * self.req.max_single_pct / 100.0;
                    let cap_vol = (day_volume * self.req.participation_pct / 100.0) as i64;
                    let mut vol = ((budget / price) as i64 / 100) * 100;
                    vol = vol.min(cap_vol);
                    if vol < 100 {
                        continue;
                    }
                    // 资金不足时下调到整手。
                    while vol >= 100 {
                        let amount = price * vol as f64;
                        if self.cash >= amount + calc_fee(Side::Buy, amount) - 1e-6 {
                            break;
                        }
                        vol -= 100;
                    }
                    if vol < 100 {
                        continue;
                    }
                    let amount = price * vol as f64;
                    let fee = calc_fee(Side::Buy, amount);
                    self.cash -= amount + fee;
                    self.trades.push(Trade {
                        code: o.code.clone(),
                        name: o.name.clone(),
                        side: "buy".into(),
                        date: date.into(),
                        price: round2(price),
                        vol,
                        amount: round2(amount),
                        fee: round2(fee),
                        pnl: 0.0,
                        holding_days: 0,
                        confidence: o.confidence,
                    });
                    self.positions.push(Position {
                        code: o.code.clone(),
                        name: o.name.clone(),
                        vol,
                        avail_vol: 0,
                        cost_amount: amount + fee,
                        entry_date: date.to_string(),
                        entry_idx: date_idx,
                    });
                }
                Side::Sell => {
                    let Some(pi) = self.positions.iter().position(|p| p.code == o.code) else {
                        continue;
                    };
                    if let Some((_, dn)) = limit {
                        if price <= dn {
                            continue; // 开盘跌停，卖不出
                        }
                    }
                    // 先取不可变数据。
                    let (pos_vol, avail, cost, pname, entry_idx) = {
                        let p = &self.positions[pi];
                        (
                            p.vol,
                            p.avail_vol,
                            p.cost_amount,
                            p.name.clone(),
                            p.entry_idx,
                        )
                    };
                    let vol = o.vol.min(avail).min(pos_vol);
                    if vol <= 0 {
                        continue;
                    }
                    let amount = price * vol as f64;
                    let fee = calc_fee(Side::Sell, amount);
                    let cost_reduce = cost * (vol as f64 / pos_vol as f64);
                    let realized = amount - fee - cost_reduce;
                    let holding_days = (date_idx - entry_idx) as i64;
                    self.cash += amount - fee;
                    // 更新或移除持仓。
                    let new_vol = pos_vol - vol;
                    if new_vol <= 0 {
                        self.positions.remove(pi);
                    } else {
                        let p = &mut self.positions[pi];
                        p.vol = new_vol;
                        p.avail_vol -= vol;
                        p.cost_amount -= cost_reduce;
                    }
                    self.trades.push(Trade {
                        code: o.code.clone(),
                        name: pname,
                        side: "sell".into(),
                        date: date.into(),
                        price: round2(price),
                        vol,
                        amount: round2(amount),
                        fee: round2(fee),
                        pnl: round2(realized),
                        holding_days,
                        confidence: o.confidence,
                    });
                }
            }
        }
    }

    /// 按当日收盘价估算总权益。
    fn equity_at(&self, date: &str) -> f64 {
        let mut eq = self.cash;
        for p in &self.positions {
            let price = self
                .bar_on(&p.code, date)
                .map(|(_, b)| b.close)
                .unwrap_or_else(|| p.cost_amount / p.vol as f64);
            eq += price * p.vol as f64;
        }
        eq
    }

    /// 组装日级特征：可用因子直接计算；hist_kline 没有的字段给中性标准值。
    fn build_features(&self, code: &str, idx: usize, date: &str) -> Option<serde_json::Value> {
        let bars = &self.series[code];
        if idx < 1 || bars.len() < 2 {
            return None;
        }
        let cur = &bars[idx];
        let prev = &bars[idx - 1];
        if prev.close <= 0.0 {
            return None;
        }
        let win = bars[..=idx].iter().collect::<Vec<_>>();
        let closes: Vec<f64> = win.iter().map(|b| b.close).collect();
        let highs: Vec<f64> = win.iter().map(|b| b.high).collect();
        let lows: Vec<f64> = win.iter().map(|b| b.low).collect();
        let volumes: Vec<f64> = win.iter().map(|b| b.volume).collect();
        let opens: Vec<f64> = win.iter().map(|b| b.open).collect();

        let pct = (cur.close - prev.close) / prev.close * 100.0;
        // speed5m 无分钟数据，以当日日内涨幅（收-开）近似（信息截至收盘，无前视）。
        let speed5m = if cur.open > 0.0 {
            (cur.close - cur.open) / cur.open * 100.0
        } else {
            0.0
        };
        // 日级量比：今日量 / 前 5 日均量。
        let vol5 = if idx >= 5 {
            bars[idx - 5..idx].iter().map(|b| b.volume).sum::<f64>() / 5.0
        } else {
            bars[..idx].iter().map(|b| b.volume).sum::<f64>() / idx.max(1) as f64
        };
        let volume_ratio = if vol5 > 0.0 { cur.volume / vol5 } else { 1.0 };

        let limit = intraday::limit_up_price(prev.close, code);
        let dist_to_limit = if limit > 0.0 {
            (limit - cur.close) / limit * 100.0
        } else {
            0.0
        };
        let pullback = if cur.high > 0.0 {
            (cur.close - cur.high) / cur.high * 100.0
        } else {
            0.0
        };

        // 市场上下文：以基准指数涨幅 + 全池涨跌家数宽度近似。
        let index_chg = self
            .bench_series
            .iter()
            .find(|b| b.date == date)
            .map(|b| {
                (b.close - prev_close_of(&self.bench_series, date))
                    / prev_close_of(&self.bench_series, date)
                    * 100.0
            })
            .unwrap_or_else(|| mean_pct(&self.series, date));
        let breadth = market_breadth(&self.series, date);
        let emotion = ((50.0 + index_chg * 15.0 + (breadth - 0.5) * 70.0).clamp(5.0, 95.0) * 100.0)
            .round()
            / 100.0;

        let holding_pct = self
            .positions
            .iter()
            .find(|p| p.code == code)
            .map(|p| {
                let eq = self.equity_at(date);
                if eq > 0.0 {
                    cur.close * p.vol as f64 / eq * 100.0
                } else {
                    0.0
                }
            })
            .unwrap_or(0.0);

        let mut feats = serde_json::json!({
            "pct": round2(pct),
            "speed5m": round2(speed5m),
            "volumeRatio": round2(volume_ratio),
            "turnover": 6.0,            // hist_kline 无换手：给中性标准值（标准分≈0）
            "distToLimit": round2(dist_to_limit),
            "pullback": round2(pullback),
            "blastCount": 0,
            "marketEmotion": emotion,
            "indexChg": round2(index_chg),
            "themeRank": 4,
            "catalystFreshness": 0.5,
            "mainNetInflowYi": 1.0,     // 无资金流：给中性标准值
            "brokenLimit": 0,
            "currentHoldingPct": round2(holding_pct),
        });

        // 日 K 深度因子（与实盘同口径）。
        let deep = intraday::daily_deep_features(&opens, &closes, &highs, &lows, &volumes);
        if let (Some(obj), Some(dobj)) = (feats.as_object_mut(), deep.as_object()) {
            for (k, v) in dobj {
                obj.insert(k.clone(), v.clone());
            }
        }
        Some(feats)
    }

    fn generate_signals(&mut self, _date_idx: usize, date: &str) {
        // 1) 持仓股卖出判断
        let held: Vec<String> = self.positions.iter().map(|p| p.code.clone()).collect();
        for code in held {
            let Some((idx, _)) = self.bar_on(&code, date) else {
                continue;
            };
            let Some(feats) = self.build_features(&code, idx, date) else {
                continue;
            };
            let pack = serde_json::json!({"side":"sell","features":feats});
            let d = RuleBrain::decide_with(&pack, None, self.req.weights.as_ref());
            if d.label == crate::ai::fastbrain::LABEL_WATCH_DOWN
                && d.confidence >= self.req.sell_threshold
            {
                let (name, vol) = self
                    .positions
                    .iter()
                    .find(|p| p.code == code)
                    .map(|p| (p.name.clone(), p.avail_vol))
                    .unwrap_or((code.clone(), 0));
                if vol > 0 {
                    self.pending.push(Order {
                        code,
                        name,
                        side: Side::Sell,
                        vol,
                        confidence: d.confidence,
                    });
                }
            }
        }

        // 2) 新买入判断（受持仓只数 / 已有挂单约束）
        let free_slots = self.req.max_positions.saturating_sub(
            self.positions.len() + self.pending.iter().filter(|o| o.side == Side::Buy).count(),
        );
        let mut candidates: Vec<(String, String, f64)> = Vec::new();
        let held_or_queued: HashSet<&str> = self
            .positions
            .iter()
            .map(|p| p.code.as_str())
            .chain(self.pending.iter().map(|o| o.code.as_str()))
            .collect();
        for code in &self.req.codes {
            if held_or_queued.contains(code.as_str()) {
                continue;
            }
            let Some((idx, _)) = self.bar_on(code, date) else {
                continue;
            };
            // 热身不足（<60 根）跳过，保证技术因子有效。
            if idx < 60 {
                continue;
            }
            let Some(feats) = self.build_features(code, idx, date) else {
                continue;
            };
            let pack = serde_json::json!({"side":"buy","features":feats});
            let d = RuleBrain::decide_with(&pack, None, self.req.weights.as_ref());
            if d.label == crate::ai::fastbrain::LABEL_WATCH_UP
                && d.confidence >= self.req.buy_threshold
            {
                candidates.push((
                    code.clone(),
                    self.names.get(code).cloned().unwrap_or_default(),
                    d.confidence,
                ));
            }
        }
        // 置信度高者优先占用槽位。
        candidates.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap());
        for (code, name, conf) in candidates.into_iter().take(free_slots) {
            self.pending.push(Order {
                code,
                name,
                side: Side::Buy,
                vol: 0, // 买入量在次日开盘按金额确定
                confidence: conf,
            });
        }
    }

    fn mark_curve(&mut self, date: &str) {
        let equity = self.equity_at(date);
        let peak = self
            .equity_curve
            .iter()
            .map(|p| p.equinity_peak())
            .fold(equity, f64::max);
        let drawdown = if peak > 0.0 {
            (peak - equity) / peak * 100.0
        } else {
            0.0
        };
        let bench = self.bench_nav(date);
        self.equity_curve.push(EquityPoint {
            date: date.to_string(),
            equity: round2(equity),
            drawdown: round2(drawdown),
            benchmark: bench,
        });
    }

    /// 基准在区间首日归一为 1。
    fn bench_nav(&self, date: &str) -> f64 {
        if self.bench_series.is_empty() {
            return 1.0;
        }
        let first = self.bench_series.first().map(|b| b.close).unwrap_or(1.0);
        self.bench_series
            .iter()
            .find(|b| b.date == date)
            .map(|b| b.close / first)
            .unwrap_or_else(|| self.equity_curve.last().map(|p| p.benchmark).unwrap_or(1.0))
    }

    fn run(mut self) -> BacktestResult {
        for (date_idx, date) in self.axis.clone().iter().enumerate() {
            self.execute_pending(date_idx, date);
            self.mark_curve(date);
            self.generate_signals(date_idx, date);
        }
        let stats = compute_stats(&self.equity_curve, &self.trades, self.req.init_cash);
        let monthly = monthly_returns(&self.equity_curve);
        let mut params = HashMap::new();
        params.insert("buyThreshold".into(), self.req.buy_threshold);
        params.insert("sellThreshold".into(), self.req.sell_threshold);
        params.insert("maxPositions".into(), self.req.max_positions as f64);
        params.insert("maxSinglePct".into(), self.req.max_single_pct);
        params.insert("participationPct".into(), self.req.participation_pct);
        params.insert("slippagePct".into(), self.req.slippage_pct);
        BacktestResult {
            id: None,
            name: self.req.name.clone(),
            start: self.req.start.clone(),
            end: self.req.end.clone(),
            stats,
            equity_curve: self.equity_curve,
            trades: self.trades,
            monthly,
            params,
        }
    }
}

impl EquityPoint {
    // 仅供 mark_curve 内取峰：equity 本身即权益序列。
    fn equinity_peak(&self) -> f64 {
        self.equity
    }
}

// ==================== 辅助函数 ====================

fn round2(v: f64) -> f64 {
    if v.is_finite() {
        (v * 100.0).round() / 100.0
    } else {
        0.0
    }
}

fn prev_close_of(series: &[Bar], date: &str) -> f64 {
    match series.iter().position(|b| b.date == date) {
        Some(0) | None => series.first().map(|b| b.close).unwrap_or(1.0),
        Some(i) => series[i - 1].close,
    }
}

fn mean_pct(series: &HashMap<String, Vec<Bar>>, date: &str) -> f64 {
    let (mut s, mut n) = (0.0, 0.0);
    for bars in series.values() {
        if let Some(i) = bars.iter().position(|b| b.date == date) {
            if i > 0 {
                s += (bars[i].close - bars[i - 1].close) / bars[i - 1].close * 100.0;
                n += 1.0;
            }
        }
    }
    if n > 0.0 {
        s / n
    } else {
        0.0
    }
}

/// 当日上涨家数占比。
fn market_breadth(series: &HashMap<String, Vec<Bar>>, date: &str) -> f64 {
    let (mut up, mut n) = (0.0, 0.0);
    for bars in series.values() {
        if let Some(i) = bars.iter().position(|b| b.date == date) {
            if i > 0 {
                if bars[i].close >= bars[i - 1].close {
                    up += 1.0;
                }
                n += 1.0;
            }
        }
    }
    if n > 0.0 {
        up / n
    } else {
        0.5
    }
}

// ==================== 绩效统计（纯函数） ====================

pub fn compute_stats(curve: &[EquityPoint], trades: &[Trade], init_cash: f64) -> PerfStats {
    let n_pts = curve.len();
    let last_eq = curve.last().map(|p| p.equity).unwrap_or(init_cash);
    let total_return = if init_cash > 0.0 {
        (last_eq - init_cash) / init_cash * 100.0
    } else {
        0.0
    };
    // 年化：按实际交易日数。
    let annual = if n_pts > 1 && total_return > -100.0 {
        let years = n_pts as f64 / 252.0;
        ((last_eq / init_cash).powf(1.0 / years) - 1.0) * 100.0
    } else {
        0.0
    };
    let bench_ret = curve
        .last()
        .map(|p| (p.benchmark - 1.0) * 100.0)
        .unwrap_or(0.0);

    // 日收益序列：夏普。
    let mut daily_rets: Vec<f64> = Vec::with_capacity(n_pts);
    for w in curve.windows(2) {
        if w[0].equity > 0.0 {
            daily_rets.push((w[1].equity - w[0].equity) / w[0].equity);
        }
    }
    let sharpe = if daily_rets.len() > 2 {
        let mean = daily_rets.iter().sum::<f64>() / daily_rets.len() as f64;
        let var = daily_rets.iter().map(|r| (r - mean).powi(2)).sum::<f64>()
            / (daily_rets.len() - 1) as f64;
        if var > 1e-12 {
            mean / var.sqrt() * 252.0_f64.sqrt()
        } else {
            0.0
        }
    } else {
        0.0
    };

    // 以卖出单计胜率 / 盈亏比 / 期望 / 持仓周期。
    let sells: Vec<&Trade> = trades.iter().filter(|t| t.side == "sell").collect();
    let wins: f64 = sells.iter().filter(|t| t.pnl > 0.0).map(|_| 1.0).sum();
    let gross_win: f64 = sells.iter().filter(|t| t.pnl > 0.0).map(|t| t.pnl).sum();
    let gross_loss: f64 = sells.iter().filter(|t| t.pnl < 0.0).map(|t| -t.pnl).sum();
    let win_rate = if !sells.is_empty() {
        wins / sells.len() as f64 * 100.0
    } else {
        0.0
    };
    let profit_factor = if gross_loss > 1e-9 {
        gross_win / gross_loss
    } else {
        0.0
    };
    let avg_pnl = if !sells.is_empty() {
        sells.iter().map(|t| t.pnl).sum::<f64>() / sells.len() as f64
    } else {
        0.0
    };
    let avg_hold = if !sells.is_empty() {
        sells.iter().map(|t| t.holding_days as f64).sum::<f64>() / sells.len() as f64
    } else {
        0.0
    };
    let max_dd = curve.iter().map(|p| p.drawdown).fold(0.0, f64::max);
    let buys = trades.iter().filter(|t| t.side == "buy").count();

    PerfStats {
        total_return_pct: round2(total_return),
        annual_return_pct: round2(annual),
        benchmark_return_pct: round2(bench_ret),
        excess_return_pct: round2(total_return - bench_ret),
        win_rate_pct: round2(win_rate),
        profit_factor: round2(profit_factor),
        max_drawdown_pct: round2(max_dd),
        sharpe: round2(sharpe),
        trade_count: trades.len(),
        buy_count: buys,
        sell_count: sells.len(),
        avg_pnl: round2(avg_pnl),
        avg_holding_days: round2(avg_hold),
    }
}

/// 月度收益：以每月首个/末个权益点计算。
pub fn monthly_returns(curve: &[EquityPoint]) -> Vec<MonthlyReturn> {
    let mut groups: Vec<(String, f64, f64)> = Vec::new(); // month, first equity, last equity
    for p in curve {
        let month = p.date[0..7].to_string();
        match groups.last_mut() {
            Some(g) if g.0 == month => g.2 = p.equity,
            _ => groups.push((month, p.equity, p.equity)),
        }
    }
    groups
        .iter()
        .map(|g| MonthlyReturn {
            month: g.0.clone(),
            return_pct: round2(if g.1 > 0.0 {
                (g.2 - g.1) / g.1 * 100.0
            } else {
                0.0
            }),
        })
        .collect()
}

// ==================== 构建引擎 / 命令 ====================

fn build_engine(conn: &Connection, req: BacktestReq) -> AppResult<Engine> {
    if req.codes.is_empty() {
        return Err(AppError::business("回测标的池不能为空"));
    }
    if req.start >= req.end {
        return Err(AppError::business("回测区间非法（start 需早于 end）"));
    }
    let ws = warm_start(&req.start);
    let names = load_names(conn, &req.codes);

    let mut series: HashMap<String, Vec<Bar>> = HashMap::new();
    let mut all_dates: HashSet<String> = HashSet::new();
    for code in &req.codes {
        let (_, bars) = load_bars(conn, code, &ws, &req.end)?;
        for b in &bars {
            if b.date >= req.start && b.date <= req.end {
                all_dates.insert(b.date.clone());
            }
        }
        series.insert(code.clone(), bars);
    }
    // 基准指数（同样落在 hist_kline）。
    let bench_series = if !req.benchmark.is_empty() {
        load_bars(conn, &req.benchmark, &ws, &req.end)
            .map(|(_, b)| b)
            .unwrap_or_default()
            .into_iter()
            .filter(|b| b.date >= req.start && b.date <= req.end)
            .collect()
    } else {
        Vec::new()
    };

    let mut axis: Vec<String> = all_dates.into_iter().collect();
    axis.sort();
    if axis.is_empty() {
        return Err(AppError::business("区间内无任何历史行情，请先回填历史K线"));
    }

    let mut index = HashMap::new();
    for (code, bars) in &series {
        let mut m = HashMap::new();
        for (i, b) in bars.iter().enumerate() {
            m.insert(b.date.clone(), i);
        }
        index.insert(code.clone(), m);
    }

    Ok(Engine {
        req,
        names,
        series,
        index,
        axis,
        cash: 0.0, // 在 run 前由命令设置为 init_cash
        positions: Vec::new(),
        pending: Vec::new(),
        trades: Vec::new(),
        equity_curve: Vec::new(),
        bench_series,
    })
}

/// 运行回测（离线计算，阻塞任务中执行）。
#[tauri::command]
pub async fn backtest_run(
    ai: State<'_, crate::ai::AiState>,
    req: BacktestReq,
app: tauri::AppHandle) -> AppResult<BacktestResult> {
    let use_builtin = crate::ai::config::load_config(
        &crate::ai::vectordb::open(&ai.dir().join("ai.db"))?.0,
    )
    .map(|c| c.use_builtin)
    .unwrap_or(true);
    crate::license::require_pro_ai_ex(&app, use_builtin)?;
    let dir = ai.dir();
    // 自动补数：标的池 + 基准若在 hist_kline 缺失或未覆盖到回测结束日，先在线回填再运行
    {
        let mut codes: Vec<String> = req.codes.clone();
        if !req.benchmark.is_empty() && !codes.contains(&req.benchmark) {
            codes.push(req.benchmark.clone());
        }
        let start_y: i64 = req
            .start
            .chars()
            .take(4)
            .collect::<String>()
            .parse()
            .unwrap_or(2025);
        let now_y = 1970 + crate::ai::now_millis() / 1000 / 86_400 / 365;
        let years = (now_y - start_y + 1).clamp(1, 20);
        let conn = maindb::open_readwrite(&dir)?;
        let conn = std::sync::Arc::new(std::sync::Mutex::new(conn));
        for code in codes {
            let need = {
                let c = conn.lock().unwrap();
                let end = req.end.replace('-', "");
                let n: i64 = c
                    .query_row(
                        "SELECT COUNT(*) FROM hist_kline WHERE code=?1 AND period=101 AND adj IN ('qfq','none') AND date<=?2",
                        rusqlite::params![code, end],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                if n > 0 {
                    let mx: Option<String> = c
                        .query_row(
                            "SELECT MAX(date) FROM hist_kline WHERE code=?1 AND period=101 AND adj IN ('qfq','none')",
                            rusqlite::params![code],
                            |r| r.get(0),
                        )
                        .unwrap_or(None);
                    match mx {
                        Some(mx) => mx.replace('-', "") < end,
                        None => true,
                    }
                } else {
                    true
                }
            };
            if need {
                // qfq 优先（回测口径），失败自动回退 none（指数/无除权数据）
                match crate::market::history::backfill_one(
                    conn.clone(),
                    code.clone(),
                    crate::market::history::PERIOD_DAILY,
                    "qfq".to_string(),
                    years,
                )
                .await
                {
                    Ok(_) => {}
                    Err(e) => {
                        log::warn!("回测自动回填 {code} qfq 失败: {e}");
                        crate::market::history::backfill_one(
                            conn.clone(),
                            code.clone(),
                            crate::market::history::PERIOD_DAILY,
                            "none".to_string(),
                            years,
                        )
                        .await
                        .map_err(|e| AppError::business(format!("回测需历史K线，自动回填 {code} 失败: {e}")))?;
                    }
                }
            }
        }
    }
    tauri::async_runtime::spawn_blocking(move || -> AppResult<BacktestResult> {
        let conn = maindb::open_readonly(&dir)?;
        let mut engine = build_engine(&conn, req)?;
        engine.cash = engine.req.init_cash;
        Ok(engine.run())
    })
    .await
    .map_err(|e| AppError::External(e.to_string()))?
}

// ==================== 结果持久化（迁移 v51） ====================

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMeta {
    id: i64,
    name: String,
    start: String,
    end: String,
    total_return_pct: f64,
    max_drawdown_pct: f64,
    sharpe: f64,
    created_at: i64,
}

/// 保存回测结果，返回 id。
#[tauri::command]
pub fn backtest_save(ai: State<'_, crate::ai::AiState>, result: BacktestResult) -> AppResult<i64> {
    let conn = maindb::open_readwrite(&ai.dir())?;
    let payload = serde_json::to_string(&result)?;
    conn.execute(
        "INSERT INTO backtest_run(name,start,end,params_json,result_json,created_at) \
         VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            result.name,
            result.start,
            result.end,
            serde_json::to_string(&result.params)?,
            payload,
            crate::ai::now_millis()
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn backtest_list(ai: State<'_, crate::ai::AiState>) -> AppResult<Vec<RunMeta>> {
    let conn = maindb::open_readonly(&ai.dir())?;
    let mut stmt = conn.prepare(
        "SELECT id,name,start,end,result_json,created_at FROM backtest_run ORDER BY id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        let id: i64 = r.get(0)?;
        let name: String = r.get(1)?;
        let start: String = r.get(2)?;
        let end: String = r.get(3)?;
        let payload: String = r.get(4)?;
        let created_at: i64 = r.get(5)?;
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap_or(serde_json::json!({}));
        Ok(RunMeta {
            id,
            name,
            start,
            end,
            total_return_pct: v["stats"]["totalReturnPct"].as_f64().unwrap_or(0.0),
            max_drawdown_pct: v["stats"]["maxDrawdownPct"].as_f64().unwrap_or(0.0),
            sharpe: v["stats"]["sharpe"].as_f64().unwrap_or(0.0),
            created_at,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

#[tauri::command]
pub fn backtest_load(ai: State<'_, crate::ai::AiState>, id: i64) -> AppResult<BacktestResult> {
    let conn = maindb::open_readonly(&ai.dir())?;
    let payload: String = conn.query_row(
        "SELECT result_json FROM backtest_run WHERE id=?1",
        params![id],
        |r| r.get(0),
    )?;
    let mut result: BacktestResult = serde_json::from_str(&payload)?;
    result.id = Some(id);
    Ok(result)
}

#[tauri::command]
pub fn backtest_delete(ai: State<'_, crate::ai::AiState>, id: i64) -> AppResult<()> {
    let conn = maindb::open_readwrite(&ai.dir())?;
    conn.execute("DELETE FROM backtest_run WHERE id=?1", params![id])?;
    Ok(())
}

// ==================== 参数寻优：walk-forward ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeReq {
    pub base: BacktestReq,
    /// 训练窗长度（交易日）。
    #[serde(default = "default_train_days")]
    pub train_days: usize,
    /// 测试窗长度（交易日）。
    #[serde(default = "default_test_days")]
    pub test_days: usize,
    /// buyThreshold 候选网格。
    #[serde(default)]
    pub buy_threshold_grid: Vec<f64>,
    /// 单因子权重候选网格（每次只变动一个因子，避免组合爆炸）。
    #[serde(default)]
    pub weight_grids: HashMap<String, Vec<f64>>,
    /// 组合数上限（超出截断）。
    #[serde(default = "default_max_combos")]
    pub max_combos: usize,
}

fn default_train_days() -> usize {
    250
}
fn default_test_days() -> usize {
    60
}
fn default_max_combos() -> usize {
    48
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowRow {
    train_start: String,
    train_end: String,
    test_start: String,
    test_end: String,
    /// 选中的参数。
    best_buy_threshold: f64,
    best_weight_factor: String,
    best_weight_value: f64,
    train_sharpe: f64,
    train_return_pct: f64,
    test_sharpe: f64,
    test_return_pct: f64,
    test_max_drawdown_pct: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeReport {
    windows: Vec<WindowRow>,
    /// 样本外平均夏普。
    avg_oos_sharpe: f64,
    /// 样本外复利收益 %。
    oos_compound_pct: f64,
    /// 样本内平均夏普（对照）。
    avg_is_sharpe: f64,
    combo_count: usize,
}

/// 枚举参数组合：(buyThreshold, 可选单因子权重)；含基线（不含权重覆盖）。
fn enumerate_combos(req: &OptimizeReq) -> Vec<(f64, Option<(String, f64)>)> {
    let thresholds: Vec<f64> = if req.buy_threshold_grid.is_empty() {
        vec![req.base.buy_threshold]
    } else {
        req.buy_threshold_grid.clone()
    };
    let mut out: Vec<(f64, Option<(String, f64)>)> = Vec::new();
    for t in &thresholds {
        out.push((*t, None));
        for (factor, vals) in &req.weight_grids {
            for v in vals {
                out.push((*t, Some((factor.clone(), *v))));
            }
        }
    }
    out.truncate(req.max_combos.max(1));
    out
}

fn run_with_params(
    conn: &Connection,
    base: &BacktestReq,
    start: &str,
    end: &str,
    threshold: f64,
    weight: Option<&(String, f64)>,
) -> AppResult<BacktestResult> {
    let mut r = base.clone();
    r.start = start.to_string();
    r.end = end.to_string();
    r.buy_threshold = threshold;
    if let Some((factor, value)) = weight {
        let mut w = r.weights.clone().unwrap_or_default();
        w.insert(factor.clone(), *value);
        r.weights = Some(w);
    }
    let mut engine = build_engine(conn, r)?;
    engine.cash = engine.req.init_cash;
    Ok(engine.run())
}

/// Walk-forward：滚动训练/测试窗，训练窗选夏普最优参数，测试窗验证，输出样本内外对照。
#[tauri::command]
pub async fn backtest_optimize(
    ai: State<'_, crate::ai::AiState>,
    req: OptimizeReq,
app: tauri::AppHandle) -> AppResult<OptimizeReport> {
    let use_builtin = crate::ai::config::load_config(
        &crate::ai::vectordb::open(&ai.dir().join("ai.db"))?.0,
    )
    .map(|c| c.use_builtin)
    .unwrap_or(true);
    crate::license::require_pro_ai_ex(&app, use_builtin)?;
    let dir = ai.dir();
    tauri::async_runtime::spawn_blocking(move || -> AppResult<OptimizeReport> {
        let conn = maindb::open_readonly(&dir)?;
        // 日期轴取自基准请求（在完整区间上构建一次）。
        let probe = build_engine(&conn, req.base.clone())?;
        let axis = probe.axis.clone();
        let combos = enumerate_combos(&req);

        let mut windows: Vec<WindowRow> = Vec::new();
        let mut cursor = 0usize;
        while cursor + req.train_days + req.test_days <= axis.len() {
            let tr_s = &axis[cursor];
            let tr_e = &axis[cursor + req.train_days - 1];
            let te_s = &axis[cursor + req.train_days];
            let te_e = &axis[cursor + req.train_days + req.test_days - 1];

            // 训练窗网格搜索：best 保存 (sharpe, train_ret, threshold, weight)。
            type BestCombo = (f64, f64, f64, Option<(String, f64)>);
            let mut best: Option<BestCombo> = None;
            for (threshold, weight) in &combos {
                let r = run_with_params(&conn, &req.base, tr_s, tr_e, *threshold, weight.as_ref())?;
                if best
                    .as_ref()
                    .map(|(s, ..)| r.stats.sharpe > *s)
                    .unwrap_or(true)
                {
                    best = Some((
                        r.stats.sharpe,
                        r.stats.total_return_pct,
                        *threshold,
                        weight.clone(),
                    ));
                }
            }
            let Some((is_sharpe, is_ret, best_threshold, weight)) = best else {
                break;
            };

            // 测试窗用选中参数（同一 threshold + weight）。
            let test = run_with_params(
                &conn,
                &req.base,
                te_s,
                te_e,
                best_threshold,
                weight.as_ref(),
            )?;
            windows.push(WindowRow {
                train_start: tr_s.clone(),
                train_end: tr_e.clone(),
                test_start: te_s.clone(),
                test_end: te_e.clone(),
                best_buy_threshold: best_threshold,
                best_weight_factor: weight.as_ref().map(|w| w.0.clone()).unwrap_or_default(),
                best_weight_value: weight.as_ref().map(|w| w.1).unwrap_or(0.0),
                train_sharpe: is_sharpe,
                train_return_pct: is_ret,
                test_sharpe: test.stats.sharpe,
                test_return_pct: test.stats.total_return_pct,
                test_max_drawdown_pct: test.stats.max_drawdown_pct,
            });
            cursor += req.test_days;
        }

        let avg = |k: fn(&WindowRow) -> f64| {
            windows.iter().map(k).sum::<f64>() / windows.len().max(1) as f64
        };
        // 样本外复利：逐窗 (1+r) 连乘。
        let compound = windows
            .iter()
            .fold(1.0, |acc, w| acc * (1.0 + w.test_return_pct / 100.0));
        Ok(OptimizeReport {
            avg_oos_sharpe: round2(avg(|w| w.test_sharpe)),
            oos_compound_pct: round2((compound - 1.0) * 100.0),
            avg_is_sharpe: round2(avg(|w| w.train_sharpe)),
            combo_count: combos.len(),
            windows,
        })
    })
    .await
    .map_err(|e| AppError::External(e.to_string()))?
}

// ==================== 进化回灌：人工审批队列（迁移 v52） ====================
//
// 护栏：回测/寻优结论只能生成「待批调参提案」，weight_overrides 的实际写入
// 只发生在 approve 命令中（人工确认）；批准时留存基线快照，可一键回滚。

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuningPayload {
    /// 因子权重覆盖。
    pub weights: HashMap<String, f64>,
    /// 人工可读的调参理由（如 walk-forward 样本外夏普提升）。
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalView {
    pub id: i64,
    pub backtest_id: Option<i64>,
    pub payload: TuningPayload,
    /// 批准前的 weight_overrides 快照（回滚用）。
    pub baseline: HashMap<String, f64>,
    pub status: String,
    pub decided_at: i64,
    pub created_at: i64,
}

/// 由回测结论生成待批调参提案；不触碰任何实盘配置。
#[tauri::command]
pub fn tuning_proposal_create(
    ai: State<'_, crate::ai::AiState>,
    ctl: State<'_, Arc<crate::ai::autoexec::AutoExecCtl>>,
    backtest_id: Option<i64>,
    payload: TuningPayload,
) -> AppResult<i64> {
    if payload.weights.is_empty() {
        return Err(AppError::business("调参提案的权重为空"));
    }
    let baseline = ctl.config.lock().unwrap().weight_overrides.clone();
    let conn = maindb::open_readwrite(&ai.dir())?;
    conn.execute(
        "INSERT INTO tuning_proposal(backtest_id,payload_json,baseline_json,status,created_at) \
         VALUES(?1,?2,?3,'pending',?4)",
        params![
            backtest_id,
            serde_json::to_string(&payload)?,
            serde_json::to_string(&baseline)?,
            crate::ai::now_millis()
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn tuning_proposal_list(ai: State<'_, crate::ai::AiState>) -> AppResult<Vec<ProposalView>> {
    let conn = maindb::open_readonly(&ai.dir())?;
    let mut stmt = conn.prepare(
        "SELECT id,backtest_id,payload_json,baseline_json,status,decided_at,created_at \
         FROM tuning_proposal ORDER BY id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        let payload_s: String = r.get(2)?;
        let baseline_s: String = r.get(3)?;
        Ok(ProposalView {
            id: r.get(0)?,
            backtest_id: r.get(1)?,
            payload: serde_json::from_str(&payload_s).unwrap_or(TuningPayload {
                weights: HashMap::new(),
                note: String::new(),
            }),
            baseline: serde_json::from_str(&baseline_s).unwrap_or_default(),
            status: r.get(4)?,
            decided_at: r.get(5)?,
            created_at: r.get(6)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 人工批准：把提案权重写入自动执行器配置（唯一合法写入路径）。
#[tauri::command]
pub fn tuning_proposal_approve(
    ai: State<'_, crate::ai::AiState>,
    ctl: State<'_, Arc<crate::ai::autoexec::AutoExecCtl>>,
    id: i64,
) -> AppResult<()> {
    let conn = maindb::open_readwrite(&ai.dir())?;
    let payload_s: String = conn.query_row(
        "SELECT payload_json FROM tuning_proposal WHERE id=?1",
        params![id],
        |r| r.get(0),
    )?;
    let payload: TuningPayload = serde_json::from_str(&payload_s)?;
    {
        let mut cfg = ctl.config.lock().unwrap();
        cfg.weight_overrides = payload.weights;
    }
    conn.execute(
        "UPDATE tuning_proposal SET status='approved', decided_at=?1 WHERE id=?2",
        params![crate::ai::now_millis(), id],
    )?;
    Ok(())
}

/// 人工拒绝：提案作废，不写入任何配置。
#[tauri::command]
pub fn tuning_proposal_reject(ai: State<'_, crate::ai::AiState>, id: i64) -> AppResult<()> {
    let conn = maindb::open_readwrite(&ai.dir())?;
    conn.execute(
        "UPDATE tuning_proposal SET status='rejected', decided_at=?1 WHERE id=?2 AND status='pending'",
        params![crate::ai::now_millis(), id],
    )?;
    Ok(())
}

/// 回滚已批准提案：把配置恢复为批准前基线。
#[tauri::command]
pub fn tuning_proposal_revert(
    ai: State<'_, crate::ai::AiState>,
    ctl: State<'_, Arc<crate::ai::autoexec::AutoExecCtl>>,
    id: i64,
) -> AppResult<()> {
    let conn = maindb::open_readwrite(&ai.dir())?;
    let baseline_s: String = conn.query_row(
        "SELECT baseline_json FROM tuning_proposal WHERE id=?1 AND status='approved'",
        params![id],
        |r| r.get(0),
    )?;
    let baseline: HashMap<String, f64> = serde_json::from_str(&baseline_s)?;
    {
        let mut cfg = ctl.config.lock().unwrap();
        cfg.weight_overrides = baseline;
    }
    conn.execute(
        "UPDATE tuning_proposal SET status='reverted', decided_at=?1 WHERE id=?2",
        params![crate::ai::now_millis(), id],
    )?;
    Ok(())
}

// ==================== 测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    fn curve_from(equities: &[f64], date0: &str) -> Vec<EquityPoint> {
        let y: i32 = date0[0..4].parse().unwrap();
        let m: u32 = date0[5..7].parse().unwrap();
        let mut d: u32 = date0[8..10].parse().unwrap();
        equities
            .iter()
            .map(|&e| {
                let date = format!("{y}-{m:02}-{d:02}");
                d += 1;
                if d > 28 {
                    d = 1;
                }
                EquityPoint {
                    date,
                    equity: e,
                    drawdown: 0.0,
                    benchmark: 1.0,
                }
            })
            .collect()
    }

    #[test]
    fn stats_total_return_and_annualization() {
        let curve = curve_from(&[1_000_000.0, 1_100_000.0], "2026-01-02");
        let s = compute_stats(&curve, &[], 1_000_000.0);
        assert_eq!(s.total_return_pct, 10.0);
        assert!(
            s.annual_return_pct > 1000.0,
            "2 日涨 10% 年化应极大, got {}",
            s.annual_return_pct
        );
    }

    #[test]
    fn stats_win_rate_and_profit_factor() {
        let curve = curve_from(&[1_000_000.0, 1_000_000.0], "2026-01-02");
        let trades = vec![
            Trade {
                code: "A".into(),
                name: "A".into(),
                side: "sell".into(),
                date: "2026-01-03".into(),
                price: 11.0,
                vol: 100,
                amount: 1100.0,
                fee: 1.0,
                pnl: 100.0,
                holding_days: 2,
                confidence: 0.8,
            },
            Trade {
                code: "B".into(),
                name: "B".into(),
                side: "sell".into(),
                date: "2026-01-03".into(),
                price: 9.0,
                vol: 100,
                amount: 900.0,
                fee: 1.0,
                pnl: -50.0,
                holding_days: 2,
                confidence: 0.8,
            },
        ];
        let s = compute_stats(&curve, &trades, 1_000_000.0);
        assert_eq!(s.win_rate_pct, 50.0);
        assert_eq!(s.profit_factor, 2.0); // 100 / 50
        assert_eq!(s.avg_pnl, 25.0);
        assert_eq!(s.avg_holding_days, 2.0);
    }

    #[test]
    fn drawdown_is_reported() {
        let mut curve = curve_from(&[1_000_000.0, 800_000.0, 900_000.0], "2026-01-02");
        // 模拟真实回撤
        curve[1].drawdown = 20.0;
        curve[2].drawdown = 10.0;
        let s = compute_stats(&curve, &[], 1_000_000.0);
        assert_eq!(s.max_drawdown_pct, 20.0);
        assert_eq!(s.total_return_pct, -10.0);
    }

    #[test]
    fn monthly_groups_partition_by_calendar_month() {
        let mut curve = Vec::new();
        for (date, eq) in [
            ("2026-01-02", 100.0),
            ("2026-01-30", 110.0),
            ("2026-02-02", 110.0),
            ("2026-02-27", 99.0),
        ] {
            curve.push(EquityPoint {
                date: date.into(),
                equity: eq,
                drawdown: 0.0,
                benchmark: 1.0,
            });
        }
        let m = monthly_returns(&curve);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].month, "2026-01");
        assert_eq!(m[0].return_pct, 10.0);
        assert_eq!(m[1].month, "2026-02");
        assert_eq!(m[1].return_pct, -10.0);
    }

    #[test]
    fn fee_matches_ledger_for_round_trip() {
        // 买入 10 万费用须与 portfolio.rs 完全一致（26 元）
        assert_eq!(calc_fee(Side::Buy, 100_000.0), 26.0);
        assert_eq!(calc_fee(Side::Sell, 100_000.0), 76.0);
    }

    #[test]
    fn combos_include_baseline_and_factor_variants() {
        let mut req = OptimizeReq {
            base: BacktestReq::default(),
            train_days: 10,
            test_days: 5,
            buy_threshold_grid: vec![0.5, 0.7],
            weight_grids: HashMap::new(),
            max_combos: 48,
        };
        req.weight_grids.insert("pct".into(), vec![0.5, 1.5]);
        let combos = enumerate_combos(&req);
        // 2 thresholds × (1 baseline + 2 factor values) = 6
        assert_eq!(combos.len(), 6);
        assert!(combos.iter().any(|(_, w)| w.is_none()));
        assert!(combos
            .iter()
            .any(|(_, w)| w.as_ref().is_some_and(|p| p.0 == "pct")));
    }

    #[test]
    fn combo_count_is_capped() {
        let req = OptimizeReq {
            base: BacktestReq::default(),
            train_days: 10,
            test_days: 5,
            buy_threshold_grid: vec![0.1, 0.2, 0.3],
            weight_grids: HashMap::new(),
            max_combos: 2,
        };
        assert_eq!(enumerate_combos(&req).len(), 2);
    }

    #[test]
    fn engine_rejects_empty_universe() {
        let c = Connection::open_in_memory().unwrap();
        let r = build_engine(
            &c,
            BacktestReq {
                codes: vec![],
                start: "2026-01-01".into(),
                end: "2026-06-01".into(),
                ..Default::default()
            },
        );
        assert!(r.is_err());
    }

    /// 端到端：构造可预测的上涨序列，引擎应能建仓并最终盈利。
    #[test]
    fn engine_end_to_end_on_synthetic_data() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE hist_kline(
                id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, period INTEGER, adj TEXT,
                date TEXT, open REAL, close REAL, high REAL, low REAL, volume REAL, amount REAL,
                UNIQUE(code,period,adj,date));
             CREATE TABLE stocks(id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT);",
        )
        .unwrap();
        c.execute(
            "INSERT INTO stocks(code,name) VALUES('600000','合成股')",
            [],
        )
        .unwrap();
        // 80 根锯齿周期日 K：5 涨 3 跌循环 + 缓慢趋势，回撤把 RSI 拉回 40..55，
        // RuleBrain 可在回撤结束/重拾上涨日产生 BUY。
        let mut prev_close = 10.0f64;
        for i in 0..80 {
            let day = 2 + i % 28;
            let month = 1 + i / 28;
            let date = format!("2026-{:02}-{:02}", month, day);
            let phase = i % 8;
            let ret = if phase < 5 { 0.012 } else { -0.015 } + 0.001; // +微趋势
            let close = prev_close * (1.0 + ret);
            let open = prev_close;
            let high = close.max(open) * 1.003;
            let low = close.min(open) * 0.997;
            c.execute(
                "INSERT INTO hist_kline(code,period,adj,date,open,close,high,low,volume,amount) \
                 VALUES('600000',101,'qfq',?1,?2,?3,?4,?5,1000000,0)",
                params![date, open, close, high, low],
            )
            .unwrap();
            prev_close = close;
        }
        let req = BacktestReq {
            codes: vec!["600000".into()],
            start: "2026-01-15".into(),
            end: "2026-03-25".into(),
            max_positions: 1,
            buy_threshold: 0.4,
            ..Default::default()
        };
        let mut engine = build_engine(&c, req).unwrap();
        engine.cash = engine.req.init_cash;
        let result = engine.run();
        // 单调上涨：应出现买入且最终因从未给出 SELL 而持有至结束；净值随上涨为正
        assert!(
            result.trades.iter().any(|t| t.side == "buy"),
            "应有买入成交"
        );
        assert!(result.stats.total_return_pct >= 0.0);
        assert!(result.equity_curve.len() > 10);
    }
}
