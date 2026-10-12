// 盘中决策包：在盘后 12 组特征之上，为「单个标的」叠加实时因子，产出快脑定长 features。
// 市场上下文（情绪 / 指数 / 涨停炸板 / 主力资金）由引擎周期性批量刷新，因子组装为纯函数、可单测。
use crate::market::{self, Quote};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// 板块涨跌停幅度（%）。ST 5% 极少进入盯盘池，此处简化处理。
pub fn limit_pct(code: &str) -> f64 {
    if (code.starts_with("688") || code.starts_with("689"))
        || (code.starts_with("300") || code.starts_with("301"))
    {
        20.0
    } else if code.starts_with('4') || code.starts_with('8') || code.starts_with("920") {
        30.0
    } else {
        10.0
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// 涨停价（按昨收与板块规则）。
pub fn limit_up_price(prev_close: f64, code: &str) -> f64 {
    round2(prev_close * (1.0 + limit_pct(code) / 100.0))
}

fn clampf(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

/// 盘中市场上下文（引擎每 ~30–60s 批量刷新；各字段为"尽力版"）。
#[derive(Clone, Default)]
pub struct MarketCtx {
    pub market_emotion: f64,
    pub index_chg: f64,
    pub zt_codes: HashSet<String>,
    pub broken_codes: HashMap<String, u32>, // 炸板次数（含回封）
    pub final_broken: HashSet<String>,     // 最终炸板（断板）
    pub fund_inflow: HashMap<String, f64>, // 主力净流入（亿）
}

/// 单标的盘中组装输入。
pub struct IntradayInput<'a> {
    pub code: String,
    pub quote: &'a Quote,
    pub prev_price_5m: Option<f64>,
    pub holding_pct: f64,
    pub ctx: &'a MarketCtx,
}

/// 纯函数：把实时行情 + 市场上下文 + 持仓组装为快脑 features（key 与 fastbrain 严格对齐）。
pub fn assemble_features(input: &IntradayInput) -> Value {
    let (q, code) = (input.quote, &input.code);
    let limit = limit_up_price(q.prev_close, code);
    let dist = if limit > 0.0 {
        (limit - q.price) / limit * 100.0
    } else {
        0.0
    };
    let pullback = if q.high > 0.0 {
        (q.price - q.high) / q.high * 100.0
    } else {
        0.0
    };
    let speed = match input.prev_price_5m {
        Some(p) if p > 0.0 => (q.price - p) / p * 100.0,
        _ => 0.0,
    };
    let blast = input.ctx.broken_codes.get(code).copied().unwrap_or(0) as f64;
    let broken_limit = if input.ctx.final_broken.contains(code) {
        1.0
    } else {
        0.0
    };
    json!({
        "pct": q.pct,
        "speed5m": speed,
        "volumeRatio": q.volume_ratio,
        "turnover": q.turnover,
        "distToLimit": dist,
        "pullback": pullback,
        "blastCount": blast,
        "marketEmotion": input.ctx.market_emotion,
        "indexChg": input.ctx.index_chg,
        // 题材排名 / 催化新鲜度依赖本地题材关联，当前给中性默认（后续增强点）
        "themeRank": 4.0,
        "catalystFreshness": 0.5,
        "mainNetInflowYi": input.ctx.fund_inflow.get(code).copied().unwrap_or(0.0),
        "brokenLimit": broken_limit,
        "currentHoldingPct": input.holding_pct,
        // 原始行情快照（决策日志回放用）
        "price": q.price,
        "open": q.open,
        "high": q.high,
        "low": q.low,
        "prevClose": q.prev_close,
        "amount": q.amount,
        "limitPrice": limit,
    })
}

/// 日 K 深度技术因子（v2.30 抽取）：autoexec 实盘与 backtest 历史回放共用同一套口径。
/// 输入为截至当日的升序 OHLCV 切片；返回需 merge 进 features 的因子对象。
/// 与 fastbrain 因子 key 严格对齐；数据不足时各指标给中性默认。
pub fn daily_deep_features(
    opens: &[f64],
    closes: &[f64],
    highs: &[f64],
    lows: &[f64],
    volumes: &[f64],
) -> Value {
    let mut f = serde_json::Map::new();
    if closes.is_empty() {
        return Value::Object(f);
    }
    // MACD / RSI
    let (dif, dea, macd_hist) = calc_macd(closes);
    let rsi = calc_rsi(closes, 14);

    // 均线 MA5 / MA10 / MA20 / MA60
    let last_avg = |n: usize| -> f64 {
        if closes.len() >= n {
            closes.iter().rev().take(n).sum::<f64>() / n as f64
        } else {
            closes.last().copied().unwrap_or(0.0)
        }
    };
    let ma5 = last_avg(5);
    let ma10 = last_avg(10);
    let ma20 = last_avg(20);
    let ma60 = last_avg(60);

    let ma_bullish = ma5 > ma10 && ma10 > ma20;
    let ma_bearish = ma5 < ma10 && ma10 < ma20;

    // 最近 20 日最高 / 最低
    let recent20_high = highs.iter().rev().take(20).fold(f64::MIN, |a, &b| a.max(b));
    let recent20_low = lows.iter().rev().take(20).fold(f64::MAX, |a, &b| b.min(a));
    let current_price = closes.last().copied().unwrap_or(0.0);
    let dist_to_resistance = if recent20_high > 0.0 {
        (recent20_high - current_price) / recent20_high * 100.0
    } else {
        0.0
    };
    let dist_to_support = if recent20_low > 0.0 {
        (current_price - recent20_low) / recent20_low * 100.0
    } else {
        0.0
    };

    // K 线形态（最近一根 vs 前一根），口径与 autoexec 完全一致。
    if closes.len() >= 2 {
        let n = closes.len() - 1;
        let (cur_o, cur_c, cur_h, cur_l) = (opens[n], closes[n], highs[n], lows[n]);
        let (prev_o, prev_c) = (opens[n - 1], closes[n - 1]);
        let body = cur_c - cur_o;
        let upper_shadow = cur_h - cur_c.max(cur_o);
        let lower_shadow = cur_c.min(cur_o) - cur_l;
        let body_size = body.abs();
        let total_range = cur_h - cur_l;

        let is_hammer =
            lower_shadow > 2.0 * body_size && upper_shadow < body_size * 0.5 && body_size > 0.0;
        let is_bullish_engulfing =
            body > 0.0 && prev_c < prev_o && cur_o <= prev_c && cur_c >= prev_o;
        let is_bearish_engulfing =
            body < 0.0 && prev_c > prev_o && cur_o >= prev_c && cur_c <= prev_o;
        let is_doji = total_range > 0.0 && body_size < total_range * 0.1;

        f.insert("klineIsHammer".into(), json!(is_hammer));
        f.insert("klineIsBullishEngulfing".into(), json!(is_bullish_engulfing));
        f.insert("klineIsBearishEngulfing".into(), json!(is_bearish_engulfing));
        f.insert("klineIsDoji".into(), json!(is_doji));
    }

    let vol20_avg = if volumes.len() >= 20 {
        volumes.iter().rev().skip(1).take(20).sum::<f64>() / 20.0
    } else {
        volumes.last().copied().unwrap_or(1.0)
    };
    let vol_ratio_20 = if vol20_avg > 0.0 {
        volumes.last().copied().unwrap_or(0.0) / vol20_avg
    } else {
        1.0
    };

    f.insert("macdDif".into(), json!(dif));
    f.insert("macdDea".into(), json!(dea));
    f.insert("macdHist".into(), json!(macd_hist));
    f.insert("rsi14".into(), json!(rsi));
    f.insert("ma5".into(), json!(ma5));
    f.insert("ma10".into(), json!(ma10));
    f.insert("ma20".into(), json!(ma20));
    f.insert("ma60".into(), json!(ma60));
    f.insert("maBullish".into(), json!(ma_bullish));
    f.insert("maBearish".into(), json!(ma_bearish));
    f.insert("recent20High".into(), json!(recent20_high));
    f.insert("recent20Low".into(), json!(recent20_low));
    f.insert("distToResistancePct".into(), json!(dist_to_resistance));
    f.insert("distToSupportPct".into(), json!(dist_to_support));
    f.insert("volRatio20".into(), json!(vol_ratio_20));
    Value::Object(f)
}

/// 计算 EMA（指数移动平均）
fn ema(values: &[f64], period: usize) -> Vec<f64> {
    if values.is_empty() { return vec![]; }
    let k = 2.0 / (period as f64 + 1.0);
    let mut out = Vec::with_capacity(values.len());
    let mut prev = values[0];
    out.push(prev);
    for &v in &values[1..] {
        prev = v * k + prev * (1.0 - k);
        out.push(prev);
    }
    out
}

/// MACD: 返回 (dif, dea, macd_hist)，dif=EMA12-EMA26, dea=EMA9(dif)
pub fn calc_macd(closes: &[f64]) -> (f64, f64, f64) {
    if closes.len() < 35 { return (0.0, 0.0, 0.0); }
    let ema12 = ema(closes, 12);
    let ema26 = ema(closes, 26);
    let difs: Vec<f64> = closes.iter().enumerate().map(|(i, _)| ema12[i] - ema26[i]).collect();
    let deas = ema(&difs, 9);
    let n = closes.len() - 1;
    let dif = difs[n];
    let dea = deas[n];
    let hist = (dif - dea) * 2.0;
    (dif, dea, hist)
}

/// RSI(14): 返回 0~100
pub fn calc_rsi(closes: &[f64], period: usize) -> f64 {
    if closes.len() < period + 1 { return 50.0; }
    let mut gains = 0.0;
    let mut losses = 0.0;
    for i in 1..=period {
        let chg = closes[closes.len() - period - 1 + i] - closes[closes.len() - period - 2 + i];
        if chg > 0.0 { gains += chg; } else { losses -= chg; }
    }
    let avg_gain = gains / period as f64;
    let avg_loss = losses / period as f64;
    if avg_loss < 1e-9 { return 100.0; }
    let rs = avg_gain / avg_loss;
    100.0 - 100.0 / (1.0 + rs)
}

/// 刷新市场上下文：指数 / 涨停池 / 炸板池 / 主力净流入榜；各子任务独立失败，返回尽力版。
pub async fn refresh_market_ctx() -> MarketCtx {
    let mut ctx = MarketCtx::default();

    if let Ok(idx) = market::get_index_quotes().await {
        for q in &idx {
            if q.name.contains("上证") {
                ctx.index_chg = q.pct;
                break;
            }
        }
    }

    let today = market::today_yyyymmdd();
    let zt = market::get_zt_pool(today.clone()).await;
    let zb = market::get_zb_pool(today).await;

    let (mut zt_total, mut zb_total) = (0.0_f64, 0.0_f64);
    if let Ok(pool) = &zt {
        zt_total = pool.total as f64;
        for s in &pool.list {
            ctx.zt_codes.insert(s.code.clone());
            if s.broken > 0 {
                ctx.broken_codes.insert(s.code.clone(), s.broken);
            }
        }
    }
    if let Ok(pool) = &zb {
        zb_total = pool.total as f64;
        for s in &pool.list {
            ctx.final_broken.insert(s.code.clone());
            let b = s.broken.max(1);
            ctx.broken_codes
                .entry(s.code.clone())
                .and_modify(|x| *x = (*x).max(b))
                .or_insert(b);
        }
    }
    // 情绪温度：涨停数加分、炸板数扣分，围绕 40 中性浮动
    ctx.market_emotion = clampf(40.0 + zt_total * 0.6 - zb_total * 1.5, 5.0, 95.0);

    if let Ok(rows) = market::get_rank_board("main".to_string(), 1, 150).await {
        for r in rows {
            ctx.fund_inflow.insert(r.code, r.main_net / 1e8);
        }
    }

    ctx
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quote(price: f64, prev_close: f64, high: f64) -> Quote {
        Quote {
            code: "600000".to_string(),
            name: "测试".to_string(),
            price,
            change: 0.0,
            pct: 3.0,
            open: prev_close,
            high,
            low: prev_close,
            prev_close,
            volume: 0.0,
            amount: 0.0,
            time: 0,
            source: "test".to_string(),
            turnover: 6.0,
            pe: 0.0,
            pb: 0.0,
            amplitude: 4.0,
            volume_ratio: 2.0,
            circ_mv: 0.0,
            total_mv: 0.0,
            inside_vol: 0.0,
            outside_vol: 0.0,
        }
    }

    #[test]
    fn limit_prices_by_board() {
        assert_eq!(limit_pct("600000"), 10.0);
        assert_eq!(limit_pct("300001"), 20.0);
        assert_eq!(limit_pct("688001"), 20.0);
        assert_eq!(limit_pct("830001"), 30.0);
        assert_eq!(limit_up_price(10.0, "600000"), 11.0);
    }

    #[test]
    fn assemble_basic_factors() {
        let ctx = MarketCtx::default();
        let q = quote(10.5, 10.0, 10.6);
        let f = assemble_features(&IntradayInput {
            code: "600000".to_string(),
            quote: &q,
            prev_price_5m: Some(10.2),
            holding_pct: 0.0,
            ctx: &ctx,
        });
        assert_eq!(f["pct"].as_f64(), Some(3.0));
        assert!(f["distToLimit"].as_f64().unwrap() > 0.0);
        assert!(f["pullback"].as_f64().unwrap() < 0.0);
        assert!(f["speed5m"].as_f64().unwrap() > 0.0);
        assert_eq!(f["currentHoldingPct"].as_f64(), Some(0.0));
    }
}
