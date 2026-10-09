// 多因子决策：趋势(多周期) / 买点位置 / 量价 / 资金 / 题材 / 风险 六因子加权打分（0–100），
// 叠加买点纪律（不追高、突破回踩、低吸）与大盘门控，输出动作、置信度、可追溯依据。
// 纯函数，可在 node 单测。
import type { KBar } from "../api/types";
import type { Quote } from "../api/types";
import {
  technicalHealth,
  detectSetup,
  trendOf,
  rsi,
  sma,
  type BuySetup,
} from "./indicators";
import type { MarketRegime } from "./position";
import type { EvolvedParams } from "./evolve";

export type Action = "BUY" | "SELL" | "HOLD" | "WATCH";

export interface FactorScore {
  name: string;
  score: number;   // 0–100
  weight: number;
  note?: string;
}

export interface DecisionInput {
  code: string;
  name: string;
  daily: KBar[];
  quote?: Partial<Quote>;
  /** 60 分 K（多周期，可选） */
  hourly?: KBar[];
  /** 题材 / 板块强度 0–1 */
  themeStrength?: number;
  /** 资金流向强度 0–1（主力净流入 / 龙虎榜） */
  moneyStrength?: number;
  marketRegime: MarketRegime;
  held?: boolean;
  params?: EvolvedParams;
}

export interface Decision {
  code: string;
  name: string;
  score: number;
  action: Action;
  confidence: number;
  setup: BuySetup;
  factors: FactorScore[];
  reasons: string[];
  risks: string[];
}

const WEIGHTS = { trend: 25, setup: 20, volprice: 15, money: 15, theme: 15, risk: 10 };

function clampNum(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function barPct(bars: KBar[]): number {
  if (bars.length < 2) return 0;
  const prev = bars[bars.length - 2].close;
  const last = bars[bars.length - 1].close;
  return prev > 0 ? ((last - prev) / prev) * 100 : 0;
}

// 量价因子
function volPriceFactor(quote: Partial<Quote> | undefined, pct: number): { score: number; notes: string[]; risks: string[] } {
  const notes: string[] = [];
  const risks: string[] = [];
  let s = 50;
  const vr = quote?.volumeRatio;
  if (vr !== undefined && vr !== null) {
    if (pct > 0 && vr >= 1.5) { s = 85; notes.push(`量比 ${vr.toFixed(1)} 放量`); }
    else if (vr >= 1) { s = 66; notes.push(`量比 ${vr.toFixed(1)}`); }
    else if (pct > 0 && vr < 0.7) { s = 55; }
    else if (pct < 0 && vr >= 1.5) { s = 30; risks.push("放量下跌"); }
  }
  const to = quote?.turnover;
  if (to !== undefined && to !== null) {
    if (pct > 0 && to >= 5 && to <= 15) { s = Math.min(90, s + 8); notes.push(`换手 ${to.toFixed(1)}% 活跃`); }
    else if (to > 20) { s -= 10; risks.push(`换手 ${to.toFixed(0)}% 过高、分歧`); }
  }
  return { score: clampNum(s, 0, 100), notes, risks };
}

// 风险因子（分越高越安全）
function riskFactor(bars: KBar[], quote: Partial<Quote> | undefined, pct: number, regime: MarketRegime): { score: number; risks: string[] } {
  const risks: string[] = [];
  let s = 72;
  const closes = bars.map((b) => b.close);
  const i = closes.length - 1;
  const r = rsi(closes, 14)[i];
  if (!isNaN(r)) {
    if (r >= 80) { s -= 20; risks.push(`RSI 超买 ${r.toFixed(0)}`); }
    else if (r <= 20) { s += 8; }
  }
  const amp = quote?.amplitude;
  if (amp !== undefined && amp !== null) {
    if (amp >= 8) { s -= 15; risks.push(`振幅 ${amp.toFixed(1)}% 过大`); }
  }
  if (pct >= 9.5) { s -= 10; risks.push("临近涨停、追板风险"); }
  if (pct <= -5) { s -= 15; risks.push("跌幅较大"); }
  if (regime === "down") { s -= 20; risks.push("大盘走弱"); }
  return { score: clampNum(s, 0, 100), risks };
}

/** 主决策函数 */
export function decide(input: DecisionInput): Decision {
  const { daily, quote, marketRegime } = input;
  const reasons: string[] = [];
  const risks: string[] = [];
  const pct = quote?.pct ?? barPct(daily);

  // ① 趋势（多周期：日线技术健康度 + 60 分方向微调）
  const th = technicalHealth(daily);
  let trendScore = th.score;
  th.notes.forEach((n) => reasons.push(n));
  if (input.hourly && input.hourly.length > 20) {
    const hc = input.hourly.map((b) => b.close);
    const hm = sma(hc, 20)[hc.length - 1];
    if (!isNaN(hm)) {
      if (hc[hc.length - 1] > hm) trendScore += 5;
      else trendScore -= 5;
    }
  }
  trendScore = clampNum(trendScore, 0, 100);

  // ② 买点位置
  const setupRes = detectSetup(daily, quote?.volumeRatio);
  setupRes.notes.forEach((n) => reasons.push(n));

  // ③ 量价
  const vp = volPriceFactor(quote, pct);
  vp.notes.forEach((n) => reasons.push(n));
  vp.risks.forEach((n) => risks.push(n));

  // ④ 资金（缺省中性 50）
  const moneyScore = clampNum((input.moneyStrength ?? 0.5) * 100, 0, 100);
  if (input.moneyStrength !== undefined) {
    reasons.push(input.moneyStrength >= 0.6 ? "主力资金流入" : input.moneyStrength <= 0.4 ? "主力资金流出" : "资金中性");
  }

  // ⑤ 题材（缺省中性 50）
  const themeScore = clampNum((input.themeStrength ?? 0.5) * 100, 0, 100);
  if (input.themeStrength !== undefined && input.themeStrength >= 0.65) reasons.push("题材强势");

  // ⑥ 风险
  const rf = riskFactor(daily, quote, pct, marketRegime);
  rf.risks.forEach((n) => risks.push(n));

  const pw = input.params?.weights;
  const wOf = (k: string, fb: number): number => (pw ? pw[k] ?? fb : fb);
  const buyThreshold = input.params?.buyThreshold ?? 68;

  const factors: FactorScore[] = [
    { name: "趋势", score: Math.round(trendScore), weight: Math.round(wOf("trend", WEIGHTS.trend)), note: th.notes[0] },
    { name: "买点", score: Math.round(setupRes.quality * 100), weight: Math.round(wOf("setup", WEIGHTS.setup)), note: setupRes.setup },
    { name: "量价", score: Math.round(vp.score), weight: Math.round(wOf("volprice", WEIGHTS.volprice)), note: vp.notes[0] },
    { name: "资金", score: Math.round(moneyScore), weight: Math.round(wOf("money", WEIGHTS.money)) },
    { name: "题材", score: Math.round(themeScore), weight: Math.round(wOf("theme", WEIGHTS.theme)) },
    { name: "风险", score: Math.round(rf.score), weight: Math.round(wOf("risk", WEIGHTS.risk)) },
  ];
  const total = factors.reduce((s, f) => s + f.score * (f.weight / 100), 0);
  const score = Math.round(clampNum(total, 0, 100));

  // ─── 动作判定（三重买入否决 + 买点纪律 + 大盘门控）───
  const trendNow = trendOf(daily);
  const dataOk = daily.length >= 30;                 // 数据充分性
  const stockDown = trendNow.direction === "down";   // 个股自身下降趋势
  let action: Action;
  if (input.held) {
    // 已持有：破位 / 低分 → 卖出，否则持有（具体止盈止损由 risk 层执行）
    action = stockDown || score < 38 ? "SELL" : "HOLD";
  } else {
    const hasSetup = setupRes.setup !== "none";
    // 追高纪律：涨幅 >8% 一律不追；5–8% 仅"高质量放量突破"(quality≥0.8)可买，其余等回踩
    const chaseHigh =
      pct > 8 ? true
      : pct > 5 && !(setupRes.setup === "breakout" && setupRes.quality >= 0.8) ? true
      : false;
    if (marketRegime === "down") action = "WATCH";    // ① 大盘走弱只卖不买
    else if (stockDown) action = "WATCH";            // ② 个股下降趋势不抄底
    else if (!dataOk) action = "WATCH";              // ③ 数据不足保守
    else if (chaseHigh) action = "WATCH";            // 不追高等回踩
    else if (hasSetup && score >= buyThreshold) action = "BUY";
    else action = "WATCH";
  }
  if (action === "WATCH" && marketRegime === "down") reasons.push("大盘走弱，只卖不买");
  if (action === "WATCH" && stockDown) reasons.push("个股处于下降趋势，不抄底");
  if (action === "WATCH" && !dataOk) reasons.push("历史K线不足，数据不充分不贸然买入");
  if (action === "WATCH" && pct > 5) reasons.push("单日涨幅过大，等回踩不追高");

  const confidence = clampNum(0.5 + (score - 50) / 100, 0.5, 0.95);

  return {
    code: input.code,
    name: input.name,
    score,
    action,
    confidence,
    setup: setupRes.setup,
    factors,
    reasons: Array.from(new Set(reasons)).slice(0, 7),
    risks: Array.from(new Set(risks)).slice(0, 5),
  };
}
