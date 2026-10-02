// 快脑 System 1：盘中对「结构化决策包」输出 BUY / NO_BUY / HOLD / SELL + 概率，不生成文本。
// 双模：
//   ① RuleBrain 内置纯规则多因子评分（零依赖、可解释、可单测，默认）；
//   ② LayaClient 本地 HTTP sidecar（非自回归分类器，约 33–150ms），健康检查 / 调用失败自动降级规则。
// 设计铁律：快脑只对定长 features 分类，不读新闻、不改因子；硬止损由执行层绕过快脑直接处理。
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub const RULE_MODEL_VERSION: &str = "rule-tickgold-v1";

/// 快脑一次决策结果（probs 为四类概率 JSON）。
#[derive(Clone, Debug)]
pub struct FastDecision {
    pub label: String,
    pub confidence: f64,
    pub probs: Value,
    pub mode: String,
    pub model_version: String,
    pub infer_ms: f64,
}

// ===== 因子标准化工具：把原始因子映射到 [-1,1] 的"看多/看空"标准分 =====

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

/// 线性：lo→-1，hi→+1（值越大越正向）。
fn lin(v: f64, lo: f64, hi: f64) -> f64 {
    if (hi - lo).abs() < 1e-9 {
        return 0.0;
    }
    clamp((v - lo) / (hi - lo) * 2.0 - 1.0, -1.0, 1.0)
}

/// 倒序线性：lo→+1，hi→-1（值越小越正向）。
fn lin_inv(v: f64, lo: f64, hi: f64) -> f64 {
    -lin(v, lo, hi)
}

/// 钟形：在 best 处 +1，向 lo / hi 两端降到 -1（如量比、换手存在"过热"区间）。
fn peak(v: f64, lo: f64, best: f64, hi: f64) -> f64 {
    if v <= best {
        lin(v, lo, best)
    } else {
        lin_inv(v, best, hi)
    }
}

fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

fn fget(f: &Value, key: &str) -> f64 {
    f[key].as_f64().unwrap_or(0.0)
}

/// 加权汇总一组 (权重, 标准分)，返回综合分 ∈[-1,1]。
fn blend(items: &[(f64, f64)]) -> f64 {
    let (mut s, mut w) = (0.0, 0.0);
    for (weight, x) in items {
        s += weight * x;
        w += weight.abs();
    }
    if w > 0.0 {
        clamp(s / w, -1.0, 1.0)
    } else {
        0.0
    }
}

/// 买入场景综合分（无持仓 / 买入指令）：越大越倾向 BUY。
fn buy_score(f: &Value) -> f64 {
    blend(&[
        (1.0, lin(fget(f, "pct"), -2.0, 7.0)),                 // 涨跌幅 0~7% 健康
        (0.8, lin(fget(f, "speed5m"), -1.0, 2.0)),             // 5 分钟涨速
        (0.9, peak(fget(f, "volumeRatio"), 1.0, 2.5, 5.0)),    // 量比 1.5~3 健康、>5 过热
        (0.7, peak(fget(f, "turnover"), 3.0, 9.0, 18.0)),      // 换手 适度活跃
        (1.0, lin_inv(fget(f, "distToLimit"), 0.0, 6.0)),      // 距涨停越近越强
        (0.8, lin(fget(f, "pullback"), -3.0, 0.0)),            // 分时回撤小为强
        (1.2, lin_inv(fget(f, "blastCount"), 0.0, 3.0)),       // 炸板 0 为好
        (1.0, lin(fget(f, "marketEmotion"), 30.0, 80.0)),      // 市场情绪
        (0.8, lin(fget(f, "indexChg"), -1.0, 1.5)),            // 指数环境
        (0.9, lin_inv(fget(f, "themeRank"), 1.0, 8.0)),        // 题材盘中排名
        (0.7, lin(fget(f, "catalystFreshness"), 0.2, 0.9)),    // 催化新鲜度
        (0.9, lin(fget(f, "mainNetInflowYi"), -1.0, 3.0)),     // 主力净流入（亿）
    ])
}

/// 卖出场景综合分（持仓股）：越大越倾向 SELL。硬止损不经过此函数。
fn sell_score(f: &Value) -> f64 {
    blend(&[
        (1.2, lin_inv(fget(f, "pct"), -7.0, 3.0)),             // 大跌该卖
        (1.0, lin_inv(fget(f, "speed5m"), -2.0, 1.0)),         // 快速下杀
        (1.1, lin_inv(fget(f, "pullback"), -6.0, 0.0)),        // 自高点大幅回撤
        (1.3, lin(fget(f, "brokenLimit"), 0.0, 1.0)),          // 断板 / 炸板
        (0.8, lin_inv(fget(f, "marketEmotion"), 20.0, 70.0)),  // 情绪转弱
        (0.7, lin_inv(fget(f, "indexChg"), -2.0, 1.0)),        // 指数走弱
    ])
}

/// 规则快脑：纯同步、确定性。
pub struct RuleBrain;

impl RuleBrain {
    pub fn decide(pack: &Value) -> FastDecision {
        let t0 = Instant::now();
        let f = &pack["features"];
        let side = pack["side"].as_str().unwrap_or("buy");
        let holding = fget(f, "currentHoldingPct");

        let probs: Value = if side == "sell" || holding > 0.0 {
            let score = sell_score(f);
            let p_sell = sigmoid(score * 6.0 - 0.3);
            let p_hold = (1.0 - p_sell) * 0.85;
            let p_buy = (1.0 - p_sell) * 0.15;
            json!({ "SELL": round3(p_sell), "HOLD": round3(p_hold),
                "BUY": round3(p_buy), "NO_BUY": 0.0 })
        } else {
            let score = buy_score(f);
            let p_buy = sigmoid(score * 6.0 - 0.5);
            let rest = 1.0 - p_buy;
            let p_nobuy = rest * 0.6;
            let p_hold = rest * 0.4;
            json!({ "BUY": round3(p_buy), "NO_BUY": round3(p_nobuy),
                "HOLD": round3(p_hold), "SELL": 0.0 })
        };

        let (label, confidence) = argmax(&probs);
        FastDecision {
            label,
            confidence,
            probs,
            mode: "rule".to_string(),
            model_version: RULE_MODEL_VERSION.to_string(),
            infer_ms: t0.elapsed().as_secs_f64() * 1000.0,
        }
    }
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// 取概率最大的标签与其概率。
fn argmax(probs: &Value) -> (String, f64) {
    let order = ["BUY", "NO_BUY", "HOLD", "SELL"];
    let mut label = "HOLD".to_string();
    let mut best = -1.0;
    for k in order {
        let p = probs[k].as_f64().unwrap_or(0.0);
        if p > best {
            best = p;
            label = k.to_string();
        }
    }
    (label, (best * 1000.0).round() / 1000.0)
}

// ===== Laya sidecar HTTP 客户端 =====

pub struct LayaClient {
    base_url: String,
}

impl LayaClient {
    pub fn new(base_url: &str) -> Self {
        LayaClient {
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    /// 健康检查，返回往返延迟 ms。
    pub async fn health(&self) -> Result<f64, String> {
        let t0 = Instant::now();
        let resp = crate::market::http()
            .get(format!("{}/health", self.base_url))
            .timeout(Duration::from_millis(700))
            .send()
            .await
            .map_err(|e| format!("Laya 连接失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Laya /health 状态 {}", resp.status()));
        }
        Ok(t0.elapsed().as_secs_f64() * 1000.0)
    }

    /// 调用 sidecar 决策。
    pub async fn decide(&self, pack: &Value) -> Result<FastDecision, String> {
        let t0 = Instant::now();
        let resp = crate::market::http()
            .post(format!("{}/decide", self.base_url))
            .timeout(Duration::from_millis(1400))
            .json(pack)
            .send()
            .await
            .map_err(|e| format!("Laya 调用失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("Laya /decide 状态 {}", resp.status()));
        }
        let v: Value = resp
            .json()
            .await
            .map_err(|e| format!("Laya 返回解析失败: {e}"))?;
        let label = v["label"].as_str().unwrap_or("HOLD").to_string();
        // sidecar 概率字段兼容 prob / probs
        let probs = v["prob"].as_object().map(|_| v["prob"].clone()).unwrap_or_else(|| {
            v["probs"].clone()
        });
        let confidence = v["confidence"]
            .as_f64()
            .unwrap_or_else(|| probs[&label].as_f64().unwrap_or(0.0));
        Ok(FastDecision {
            label,
            confidence,
            probs,
            mode: "laya".to_string(),
            model_version: v["model_version"]
                .as_str()
                .unwrap_or("laya-unknown")
                .to_string(),
            infer_ms: v["infer_ms"]
                .as_f64()
                .unwrap_or_else(|| t0.elapsed().as_secs_f64() * 1000.0),
        })
    }
}

/// 快脑统一入口：mode="laya" 时先健康检查再调用，任一失败自动降级规则；其余直接规则。
pub async fn fast_decide(pack: Value, mode: &str, laya_url: &str) -> FastDecision {
    if mode == "laya" {
        let client = LayaClient::new(laya_url);
        let health = tokio::time::timeout(Duration::from_millis(800), client.health()).await;
        if matches!(health, Ok(Ok(_))) {
            let decided = tokio::time::timeout(Duration::from_millis(1600), client.decide(&pack)).await;
            match decided {
                Ok(Ok(d)) => return d,
                Ok(Err(e)) => log::warn!("{e}，降级规则快脑"),
                Err(_) => log::warn!("Laya 决策超时，降级规则快脑"),
            }
        } else {
            log::warn!("Laya 健康检查未通过，降级规则快脑");
        }
    }
    RuleBrain::decide(&pack)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(side: &str, f: Value) -> Value {
        json!({ "side": side, "features": f })
    }

    #[test]
    fn strong_buy_features_yield_buy() {
        let f = json!({
            "pct": 5.2, "speed5m": 1.2, "volumeRatio": 2.4, "turnover": 8.0,
            "distToLimit": 1.5, "pullback": -0.4, "blastCount": 0,
            "marketEmotion": 72, "indexChg": 0.8, "themeRank": 1,
            "catalystFreshness": 0.85, "mainNetInflowYi": 2.1, "currentHoldingPct": 0
        });
        let d = RuleBrain::decide(&pack("buy", f));
        assert_eq!(d.label, "BUY");
        assert!(d.confidence >= 0.7, "强买入特征 confidence 应较高, got {}", d.confidence);
        assert_eq!(d.mode, "rule");
    }

    #[test]
    fn weak_with_blast_yields_no_buy() {
        let f = json!({
            "pct": -1.5, "speed5m": -0.8, "volumeRatio": 6.5, "turnover": 22.0,
            "distToLimit": 7.0, "pullback": -3.5, "blastCount": 2,
            "marketEmotion": 25, "indexChg": -1.2, "themeRank": 9,
            "catalystFreshness": 0.1, "mainNetInflowYi": -1.5, "currentHoldingPct": 0
        });
        let d = RuleBrain::decide(&pack("buy", f));
        assert_ne!(d.label, "BUY", "弱 + 炸板不应给 BUY");
        assert!(d.probs["BUY"].as_f64().unwrap() < 0.2);
    }

    #[test]
    fn held_stock_crashing_or_broken_yields_sell() {
        let f = json!({
            "pct": -6.2, "speed5m": -1.6, "pullback": -5.5, "brokenLimit": 1,
            "marketEmotion": 22, "indexChg": -1.5, "currentHoldingPct": 18
        });
        let d = RuleBrain::decide(&pack("sell", f));
        assert_eq!(d.label, "SELL");
        assert!(d.probs["SELL"].as_f64().unwrap() > 0.7);
    }

    #[test]
    fn held_healthy_stock_yields_hold() {
        let f = json!({
            "pct": 1.2, "speed5m": 0.2, "pullback": -0.3, "brokenLimit": 0,
            "marketEmotion": 60, "indexChg": 0.3, "currentHoldingPct": 10
        });
        let d = RuleBrain::decide(&pack("sell", f));
        assert_eq!(d.label, "HOLD", "健康持仓不应卖出");
    }
}
