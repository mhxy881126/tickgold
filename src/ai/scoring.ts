// ===== 多因子股票评分引擎 =====
// 6 大类、15+ 因子的加权评分模型，输出 BUY/SELL/SCAN + 具体分数 + 命中信号
// 纯函数，无 DOM / 无状态，可在 node 下单测。
import type { Quote } from "../api/types";

export type SignalLevel = "BUY_STRONG" | "BUY" | "SCAN" | "SELL" | "SELL_STRONG";

export interface StockScore {
  code: string;
  name: string;
  price: number;
  pct: number;
  score: number;
  maxScore: number;
  signals: string[];
  risks: string[];
  recommendation: SignalLevel;
  // 各分项得分（用于调试/展示）
  breakdown: {
    trend: number;
    volume: number;
    volatility: number;
    valuation: number;
    sentiment: number;
    riskPenalty: number;
  };
}

export interface ScoringConfig {
  // === 阈值 ===
  buyThreshold: number;        // ≥ 此分 → BUY
  buyStrongThreshold: number;  // ≥ 此分 → BUY_STRONG
  sellThreshold: number;       // ≤ 此分 → SELL
  sellStrongThreshold: number; // ≤ 此分 → SELL_STRONG

  // === 权重：各类因子的总分 ===
  trendWeight: number;      // 价格趋势（涨跌幅/均线位置）
  volumeWeight: number;     // 量能（成交额/量比/换手率）
  volatilityWeight: number; // 波动率（振幅/量价配合）
  valuationWeight: number;  // 估值（PE/PB/市值）
  sentimentWeight: number;  // 市场情绪加成

  // === 涨跌幅区间分 ===
  pctGoldenLow: number;   // 黄金区下限（%）
  pctGoldenHigh: number;  // 黄金区上限（%）
  pctMildLow: number;     // 温和上涨下限
  pctMildHigh: number;    // 温和上涨上限
  pctHighRisk: number;    // 高位风险阈值（%，涨停不追）
  pctStopLoss: number;    // 止损阈值（%，下跌超此值）

  // === 量能阈值 ===
  amountStrong: number;   // 成交额充足（亿元）
  amountMild: number;     // 成交额尚可（亿元）
  volumeRatioStrong: number; // 量比充足
  turnoverActive: number; // 换手率活跃（%）

  // === 波动率 ===
  ampLow: number;         // 低振幅上限（%）
  ampHigh: number;        // 高振幅下限（%）

  // === 风险扣分 ===
  stPenalty: number;      // ST/问题股扣分
  limitUpPenalty: number; // 涨停不追扣分
  limitDownPenalty: number; // 跌停不卖扣分
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  buyThreshold: 4,
  buyStrongThreshold: 8,
  sellThreshold: -3,
  sellStrongThreshold: -7,

  trendWeight: 5,
  volumeWeight: 3,
  volatilityWeight: 2,
  valuationWeight: 2,
  sentimentWeight: 2,

  pctGoldenLow: 2,
  pctGoldenHigh: 6,
  pctMildLow: 0.5,
  pctMildHigh: 2,
  pctHighRisk: 9.3,
  pctStopLoss: -3,

  amountStrong: 3,     // 3 亿
  amountMild: 1,       // 1 亿
  volumeRatioStrong: 2,
  turnoverActive: 5,

  ampLow: 2,
  ampHigh: 8,

  stPenalty: -8,
  limitUpPenalty: -3,
  limitDownPenalty: -5,
};

// ===== 4 套预设策略对应的评分配置 =====
export const STRATEGY_PRESETS: Record<string, Partial<ScoringConfig>> = {
  conservative: {
    // 稳健型：高阈值、低仓位、严风控
    buyThreshold: 7,
    buyStrongThreshold: 11,
    sellThreshold: -3,
    sellStrongThreshold: -6,
    trendWeight: 4,
    volumeWeight: 3,
    volatilityWeight: 3,
    valuationWeight: 3,
    sentimentWeight: 1,
    pctGoldenLow: 1.5,
    pctGoldenHigh: 4,
    pctHighRisk: 8,
  },
  balanced: {
    // 均衡型：默认配置
    ...DEFAULT_SCORING_CONFIG,
  },
  aggressive: {
    // 进取型：低阈值、集中仓位、高弹性
    buyThreshold: 4,
    buyStrongThreshold: 7,
    sellThreshold: -6,
    sellStrongThreshold: -10,
    trendWeight: 6,
    volumeWeight: 3,
    volatilityWeight: 1,
    valuationWeight: 1,
    sentimentWeight: 3,
    pctGoldenLow: 3,
    pctGoldenHigh: 8,
    pctHighRisk: 9.8,
  },
  scalping: {
    // 短线打板：超短、高换手、追强
    buyThreshold: 5,
    buyStrongThreshold: 8,
    sellThreshold: -3,
    sellStrongThreshold: -6,
    trendWeight: 6,
    volumeWeight: 4,
    volatilityWeight: 2,
    valuationWeight: 0,
    sentimentWeight: 3,
    pctGoldenLow: 4,
    pctGoldenHigh: 9,
    pctHighRisk: 10,
    amountStrong: 5,
    turnoverActive: 8,
  },
};

/**
 * 主评分函数：输入单只股票 Quote + 市场情绪等级，输出完整评分结果。
 */
export function evaluateStock(
  q: Quote,
  code: string,
  name: string,
  marketSentiment: "hot" | "neutral" | "cold" = "neutral",
  cfg: Partial<ScoringConfig> = {},
): StockScore {
  const c: ScoringConfig = { ...DEFAULT_SCORING_CONFIG, ...cfg };
  const signals: string[] = [];
  const risks: string[] = [];

  // ===== 1. 价格趋势分（满分 trendWeight）=====
  let trendScore = 0;
  const pct = q.pct ?? 0;

  // 黄金上涨区间：温和放量上涨
  if (pct >= c.pctGoldenLow && pct <= c.pctGoldenHigh) {
    trendScore += c.trendWeight * 0.8;
    signals.push("强势上涨");
  } else if (pct > c.pctGoldenHigh && pct <= c.pctHighRisk) {
    trendScore += c.trendWeight * 0.5;
    signals.push("高位上涨");
  } else if (pct >= c.pctMildLow && pct < c.pctGoldenLow) {
    trendScore += c.trendWeight * 0.4;
    signals.push("温和上涨");
  } else if (pct > 0 && pct < c.pctMildLow) {
    trendScore += c.trendWeight * 0.15;
    signals.push("小幅上涨");
  } else if (pct < 0 && pct > c.pctStopLoss) {
    trendScore -= c.trendWeight * 0.3;
    signals.push("小幅回调");
  } else if (pct <= c.pctStopLoss && pct > -7) {
    trendScore -= c.trendWeight * 0.8;
    signals.push("跌破支撑");
    risks.push("跌幅较大");
  } else if (pct <= -7) {
    trendScore -= c.trendWeight;
    signals.push("大跌");
    risks.push("暴跌风险");
  }

  // 涨停不追
  if (pct >= c.pctHighRisk) {
    trendScore += c.limitUpPenalty;
    risks.push("涨停不追");
  }

  // 位置：相对今日高低
  const range = q.high - q.low;
  if (range > 0) {
    const position = (q.price - q.low) / range; // 0=最低, 1=最高
    if (pct > 0 && position > 0.7) {
      trendScore += c.trendWeight * 0.2;
      signals.push("高位运行");
    } else if (pct < 0 && position < 0.3) {
      trendScore -= c.trendWeight * 0.2;
      risks.push("低位弱势");
    }
  }

  trendScore = clamp(trendScore, -c.trendWeight, c.trendWeight);

  // ===== 2. 量能分（满分 volumeWeight）=====
  let volumeScore = 0;
  const amountYi = (q.amount || 0) / 1e8; // 转成亿元
  const isRising = pct > 0;
  const isFalling = pct < 0;

  // 成交额：上涨时加分，下跌时不加分（下跌放量是坏事，后面单独扣）
  if (isRising && amountYi >= c.amountStrong) {
    volumeScore += c.volumeWeight * 0.6;
    signals.push("成交额充足");
  } else if (isRising && amountYi >= c.amountMild) {
    volumeScore += c.volumeWeight * 0.3;
    signals.push("成交额尚可");
  } else if (amountYi < c.amountMild * 0.5 && amountYi > 0) {
    volumeScore -= c.volumeWeight * 0.2;
    risks.push("成交额不足");
  }

  // 量比：上涨时加分，下跌时不加分
  if (q.volumeRatio && q.volumeRatio >= c.volumeRatioStrong) {
    if (isRising) {
      volumeScore += c.volumeWeight * 0.3;
      signals.push("量比放大");
    } else if (isFalling) {
      volumeScore -= c.volumeWeight * 0.2;
      risks.push("放量下跌");
    }
  }

  // 换手率活跃：上涨时加分
  if (isRising && q.turnover && q.turnover >= c.turnoverActive) {
    volumeScore += c.volumeWeight * 0.1;
    signals.push("换手活跃");
  }

  // 量价配合：上涨放量再额外加分
  if (isRising && q.volumeRatio && q.volumeRatio >= 1.5 && amountYi >= c.amountMild) {
    volumeScore += c.volumeWeight * 0.2;
    signals.push("放量上涨");
  }

  volumeScore = clamp(volumeScore, -c.volumeWeight, c.volumeWeight);

  // ===== 3. 波动率分（满分 volatilityWeight）=====
  let volScore = 0;
  const amp = q.amplitude ?? 0;

  if (amp <= c.ampLow) {
    volScore += c.volatilityWeight * 0.3;
    signals.push("低波动");
  } else if (amp >= c.ampHigh) {
    volScore -= c.volatilityWeight * 0.5;
    risks.push("高波动");
  }

  // 振幅大且上涨 = 分歧大，减分；振幅大且下跌 = 恐慌，减分
  if (amp >= c.ampHigh && pct > 0) {
    volScore -= c.volatilityWeight * 0.3;
    risks.push("高位分歧");
  }

  volScore = clamp(volScore, -c.volatilityWeight, c.volatilityWeight);

  // ===== 4. 估值分（满分 valuationWeight）=====
  // 注意：估值只在上涨/横盘时加分（锦上添花），下跌趋势中估值不构成支撑（不加分）
  let valScore = 0;
  const valuationEnabled = pct >= -1; // 跌幅不超过 1% 时才考虑估值加分

  if (valuationEnabled && q.pe && q.pe > 0 && q.pe < 30) {
    valScore += c.valuationWeight * 0.4;
    signals.push("估值合理");
  } else if (q.pe && q.pe > 80) {
    valScore -= c.valuationWeight * 0.3;
    risks.push("高估值");
  }

  if (valuationEnabled && q.pb && q.pb > 0 && q.pb < 3) {
    valScore += c.valuationWeight * 0.3;
    signals.push("市净率低");
  }

  // 市值适中（中盘股更灵活）—— 只在上涨时加分
  if (valuationEnabled && q.circMv && q.circMv > 50 && q.circMv < 500) {
    valScore += c.valuationWeight * 0.3;
    signals.push("市值适中");
  } else if (q.circMv && q.circMv > 2000) {
    valScore -= c.valuationWeight * 0.2;
    risks.push("大盘股弹性低");
  }

  valScore = clamp(valScore, -c.valuationWeight, c.valuationWeight);

  // ===== 5. 市场情绪分（满分 sentimentWeight）=====
  let sentScore = 0;
  if (marketSentiment === "hot") {
    sentScore += c.sentimentWeight * 0.8;
    signals.push("情绪好");
  } else if (marketSentiment === "cold") {
    sentScore -= c.sentimentWeight * 0.5;
    risks.push("情绪差");
  }
  // 中性：0 分，不加不减

  // ===== 6. 风险额外扣分 =====
  let riskPenalty = 0;

  // ST/退市风险
  const isST = name.includes("ST") || name.includes("退");
  if (isST) {
    riskPenalty += c.stPenalty;
    risks.push("ST/风险股");
  }

  // 跌停不卖（但风险很大）
  if (pct <= -9.5) {
    riskPenalty += c.limitDownPenalty;
    risks.push("跌停");
  }

  // ===== 汇总 =====
  const totalScore = Math.round((trendScore + volumeScore + volScore + valScore + sentScore + riskPenalty) * 10) / 10;
  const maxScore = c.trendWeight + c.volumeWeight + c.volatilityWeight + c.valuationWeight + c.sentimentWeight;

  // 评级
  let recommendation: SignalLevel = "SCAN";
  if (totalScore >= c.buyStrongThreshold) {
    recommendation = "BUY_STRONG";
  } else if (totalScore >= c.buyThreshold) {
    recommendation = "BUY";
  } else if (totalScore <= c.sellStrongThreshold) {
    recommendation = "SELL_STRONG";
  } else if (totalScore <= c.sellThreshold) {
    recommendation = "SELL";
  }

  return {
    code,
    name,
    price: q.price,
    pct,
    score: totalScore,
    maxScore,
    signals: signals.slice(0, 6), // 最多 6 个信号
    risks: risks.slice(0, 4),     // 最多 4 个风险
    recommendation,
    breakdown: {
      trend: round1(trendScore),
      volume: round1(volumeScore),
      volatility: round1(volScore),
      valuation: round1(valScore),
      sentiment: round1(sentScore),
      riskPenalty: round1(riskPenalty),
    },
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * 从一批股票中选出 Top N（按评分排序）
 */
export function rankStocks(
  quotes: Quote[],
  marketSentiment: "hot" | "neutral" | "cold",
  cfg: Partial<ScoringConfig> = {},
  topN = 10,
): StockScore[] {
  return quotes
    .map(q => evaluateStock(q, q.code, q.name, marketSentiment, cfg))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
