// 盘中决策包：在盘后 12 组特征之上，为「单个标的」叠加实时因子，产出快脑定长 features。
// 市场上下文（情绪 / 指数 / 涨停炸板 / 主力资金）由引擎周期性批量刷新，因子组装为纯函数、可单测。
use crate::market::{self, Quote};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// 板块涨跌停幅度（%）。ST 5% 极少进入盯盘池，此处简化处理。
pub fn limit_pct(code: &str) -> f64 {
    if code.starts_with("688") || code.starts_with("689") {
        20.0
    } else if code.starts_with("300") || code.starts_with("301") {
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
