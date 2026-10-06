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
    pub fn decide(pack: &Value, indicators: Option<&std::collections::HashMap<String, bool>>) -> FastDecision {
        let t0 = Instant::now();
        let f = &pack["features"];
        let side = pack["side"].as_str().unwrap_or("buy");
        let holding = fget(f, "currentHoldingPct");

        // 指标开关：禁用的指标权重×0
        let w = |key: &str, base: f64| -> f64 {
            match indicators {
                Some(m) if !m.get(key).copied().unwrap_or(true) => 0.0,
                _ => base,
            }
        };

        let buy_items: Vec<(f64, f64)> = vec![
            (w("pct", 1.0), lin(fget(f, "pct"), -2.0, 7.0)),
            (w("speed5m", 0.8), lin(fget(f, "speed5m"), -1.0, 2.0)),
            (w("volumeRatio", 0.9), peak(fget(f, "volumeRatio"), 1.0, 2.5, 5.0)),
            (w("turnover", 0.7), peak(fget(f, "turnover"), 3.0, 9.0, 18.0)),
            (w("distToLimit", 1.0), lin_inv(fget(f, "distToLimit"), 0.0, 6.0)),
            (w("pullback", 0.8), lin(fget(f, "pullback"), -3.0, 0.0)),
            (w("blastCount", 1.2), lin_inv(fget(f, "blastCount"), 0.0, 3.0)),
            (w("marketEmotion", 1.0), lin(fget(f, "marketEmotion"), 30.0, 80.0)),
            (w("indexChg", 0.8), lin(fget(f, "indexChg"), -1.0, 1.5)),
            (w("themeRank", 0.9), lin_inv(fget(f, "themeRank"), 1.0, 8.0)),
            (w("catalystFreshness", 0.7), lin(fget(f, "catalystFreshness"), 0.2, 0.9)),
            (w("mainNetInflowYi", 0.9), lin(fget(f, "mainNetInflowYi"), -1.0, 3.0)),
            // MACD 金叉：DIF>DEA（hist>0）看多
            (w("macdHist", 0.8), lin(fget(f, "macdHist"), -0.5, 0.5)),
            // RSI 40~65 健康区间
            (w("rsi14", 0.7), peak(fget(f, "rsi14"), 30.0, 55.0, 75.0)),
            // ===== K线深度分析（买入加分项）=====
            // 均线多头排列：MA5>MA10>MA20 = 强上涨趋势
            (w("maBullish", 1.0), lin(fget(f, "maBullish"), 0.0, 1.0)),
            // 均线空头排列：反过来 = 减分
            (w("maBearish", 0.8), lin_inv(fget(f, "maBearish"), 0.0, 1.0)),
            // 距支撑位近：离20天最低点近 = 安全
            (w("distToSupportPct", 0.7), lin_inv(fget(f, "distToSupportPct"), 0.0, 10.0)),
            // 距压力位远：离20天最高点远 = 空间大
            (w("distToResistancePct", 0.6), lin(fget(f, "distToResistancePct"), 0.0, 10.0)),
            // 锤子线：下影线长 = 见底信号
            (w("klineIsHammer", 0.9), lin(fget(f, "klineIsHammer"), 0.0, 1.0)),
            // 看涨吞没：阳包阴 = 反转信号
            (w("klineIsBullishEngulfing", 1.0), lin(fget(f, "klineIsBullishEngulfing"), 0.0, 1.0)),
            // 看跌吞没：阴包阳 = 见顶信号（减分）
            (w("klineIsBearishEngulfing", 0.9), lin_inv(fget(f, "klineIsBearishEngulfing"), 0.0, 1.0)),
            // 放量：今天量比20天平均大 = 资金涌入
            (w("volRatio20", 0.7), peak(fget(f, "volRatio20"), 0.8, 1.5, 3.0)),
        ];

        let sell_items: Vec<(f64, f64)> = vec![
            (w("pct", 1.2), lin_inv(fget(f, "pct"), -7.0, 3.0)),
            (w("speed5m", 1.0), lin_inv(fget(f, "speed5m"), -2.0, 1.0)),
            (w("pullback", 1.1), lin_inv(fget(f, "pullback"), -6.0, 0.0)),
            (w("brokenLimit", 1.3), lin(fget(f, "brokenLimit"), 0.0, 1.0)),
            (w("marketEmotion", 0.8), lin_inv(fget(f, "marketEmotion"), 20.0, 70.0)),
            (w("indexChg", 0.7), lin_inv(fget(f, "indexChg"), -2.0, 1.0)),
            // RSI>75 超买该卖
            (w("rsi14", 0.6), lin_inv(fget(f, "rsi14"), 50.0, 80.0)),
            // ===== K线深度分析（卖出加分项）=====
            // 均线空头排列：下跌趋势 = 该卖
            (w("maBearish", 1.0), lin(fget(f, "maBearish"), 0.0, 1.0)),
            // 看跌吞没：阴包阳 = 见顶信号，该卖
            (w("klineIsBearishEngulfing", 1.1), lin(fget(f, "klineIsBearishEngulfing"), 0.0, 1.0)),
            // 看涨吞没：阳包阴 = 不该卖（减分）
            (w("klineIsBullishEngulfing", 0.8), lin_inv(fget(f, "klineIsBullishEngulfing"), 0.0, 1.0)),
            // 离支撑位远：跌太多了，离支撑位还远，还要跌
            (w("distToSupportPct", 0.6), lin(fget(f, "distToSupportPct"), 0.0, 15.0)),
        ];

        let probs: Value = if side == "sell" || holding > 0.0 {
            let score = blend(&sell_items);
            let p_sell = sigmoid(score * 6.0 - 0.3);
            let p_hold = (1.0 - p_sell) * 0.85;
            let p_buy = (1.0 - p_sell) * 0.15;
            json!({ "SELL": round3(p_sell), "HOLD": round3(p_hold),
                "BUY": round3(p_buy), "NO_BUY": 0.0 })
        } else {
            let score = blend(&buy_items);
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

// ===== 云端大模型客户端（OpenAI 兼容接口） =====

pub struct CloudLlmClient {
    base_url: String,
    api_key: String,
    model: String,
}

impl CloudLlmClient {
    pub fn new(base_url: &str, api_key: &str, model: &str) -> Self {
        CloudLlmClient {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            model: model.to_string(),
        }
    }

    /// 把 features 拼成简短 prompt，让 LLM 输出 JSON 决策。
    pub async fn decide(&self, pack: &Value) -> Result<FastDecision, String> {
        let t0 = Instant::now();
        let f = &pack["features"];
        let side = pack["side"].as_str().unwrap_or("buy");

        let prompt = format!(
            "你是A股短线交易助手。根据以下实时行情数据，给出操作建议。\n\
             当前场景：{}（{}）\n\
             数据：{}\n\n\
             只返回JSON，不要其他内容：\n\
             {{\"label\":\"BUY或SELL或HOLD或NO_BUY\",\"confidence\":0.0到1.0,\"reason\":\"一句话理由\"}}",
            if side == "sell" || fget(f, "currentHoldingPct") > 0.0 { "持仓股卖出判断" } else { "新买入判断" },
            side,
            f
        );

        let body = json!({
            "model": self.model,
            "messages": [
                {"role": "system", "content": "你是严谨的A股量化交易助手，只输出JSON。"},
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.2,
            "max_tokens": 200
        });

        let resp = crate::market::http()
            .post(format!("{}/chat/completions", self.base_url))
            .timeout(Duration::from_millis(3000))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("云端LLM调用失败: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("云端LLM HTTP {}: {}", status, text.chars().take(200).collect::<String>()));
        }

        let v: Value = resp.json().await.map_err(|e| format!("LLM返回解析失败: {e}"))?;
        let content = v["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        // 尝试解析 JSON
        let parsed: Value = serde_json::from_str(content).map_err(|e| {
            format!("LLM输出非JSON: {} | raw: {}", e, content.chars().take(100).collect::<String>())
        })?;

        let label = parsed["label"].as_str().unwrap_or("HOLD").to_uppercase();
        let confidence = parsed["confidence"].as_f64().unwrap_or(0.5).clamp(0.0, 1.0);
        let reason = parsed["reason"].as_str().unwrap_or("").to_string();

        // 构造 probs
        let probs = match label.as_str() {
            "BUY" => json!({ "BUY": round3(confidence), "NO_BUY": round3(1.0-confidence), "HOLD": 0.0, "SELL": 0.0 }),
            "SELL" => json!({ "SELL": round3(confidence), "HOLD": round3(1.0-confidence), "BUY": 0.0, "NO_BUY": 0.0 }),
            "NO_BUY" => json!({ "NO_BUY": round3(confidence), "BUY": round3(1.0-confidence), "HOLD": 0.0, "SELL": 0.0 }),
            _ => json!({ "HOLD": round3(confidence), "BUY": round3((1.0-confidence)*0.5), "SELL": round3((1.0-confidence)*0.5), "NO_BUY": 0.0 }),
        };

        Ok(FastDecision {
            label,
            confidence,
            probs,
            mode: "cloud_llm".to_string(),
            model_version: format!("cloud-{}", self.model),
            infer_ms: t0.elapsed().as_secs_f64() * 1000.0,
        })
    }
}

/// 快脑统一入口：mode="laya" 时先健康检查再调用，任一失败自动降级规则；其余直接规则。
pub async fn fast_decide(pack: Value, mode: &str, laya_url: &str, cloud: Option<(String, String, String)>, indicators: Option<&std::collections::HashMap<String, bool>>) -> FastDecision {
    // 云端大模型模式
    if mode == "cloud_llm" {
        if let Some((base_url, api_key, model)) = cloud {
            if !api_key.is_empty() && !base_url.is_empty() && !model.is_empty() {
                let client = CloudLlmClient::new(&base_url, &api_key, &model);
                match client.decide(&pack).await {
                    Ok(d) => return d,
                    Err(e) => log::warn!("云端LLM决策失败: {}，降级规则快脑", e),
                }
            } else {
                log::warn!("云端LLM配置不完整，降级规则快脑");
            }
        } else {
            log::warn!("未传入云端LLM配置，降级规则快脑");
        }
    }
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
    RuleBrain::decide(&pack, indicators)
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
        let d = RuleBrain::decide(&pack("buy", f), None);
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
        let d = RuleBrain::decide(&pack("buy", f), None);
        assert_ne!(d.label, "BUY", "弱 + 炸板不应给 BUY");
        assert!(d.probs["BUY"].as_f64().unwrap() < 0.2);
    }

    #[test]
    fn held_stock_crashing_or_broken_yields_sell() {
        let f = json!({
            "pct": -6.2, "speed5m": -1.6, "pullback": -5.5, "brokenLimit": 1,
            "marketEmotion": 22, "indexChg": -1.5, "currentHoldingPct": 18
        });
        let d = RuleBrain::decide(&pack("sell", f), None);
        assert_eq!(d.label, "SELL");
        assert!(d.probs["SELL"].as_f64().unwrap() > 0.7);
    }

    #[test]
    fn held_healthy_stock_yields_hold() {
        let f = json!({
            "pct": 1.2, "speed5m": 0.2, "pullback": -0.3, "brokenLimit": 0,
            "marketEmotion": 60, "indexChg": 0.3, "currentHoldingPct": 10
        });
        let d = RuleBrain::decide(&pack("sell", f), None);
        assert_eq!(d.label, "HOLD", "健康持仓不应卖出");
    }
}
