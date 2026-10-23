/**
 * 做T信号引擎 · 特征层（P1）：全部纯函数，可独立单测。
 *
 * 输入来自 useTmaker 已拉取的数据（分时 / 五档 / 逐笔 / 日K / 盘口增强 / 大盘），
 * 输出结构化因子，供 Regime 识别与打分卡使用。数据缺省时按保守值降级（不误触发）。
 */
import type { KBar, OrderBook, TradeTick, PriceBucket } from "../../api/types";

// ==================== 基础统计 ====================

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** 标准化 z-score（σ=0 时返回 0） */
export function zscore(value: number, m: number, sd: number): number {
  if (!(sd > 0)) return 0;
  return (value - m) / sd;
}

/** 一元线性回归斜率（ys 对 xs，xs 等距即可）与拟合优度 R² */
export function linreg(xs: number[], ys: number[]): { slope: number; r2: number } {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { slope: 0, r2: 0 };
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return { slope: 0, r2: 0 };
  const slope = sxy / sxx;
  const r2 = (sxy * sxy) / (sxx * syy);
  return { slope, r2 };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** A 股最小价格变动单位取整（0.01 元） */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ==================== 乖离 z-score（替代固定阈值） ====================

/** 分时乖离序列：每根 K 的 close 相对该根 VWAP 的偏离 % */
export function biasSeriesOf(
  bars: KBar[],
  avgOf: (ts: number) => number | undefined,
): number[] {
  const out: number[] = [];
  for (const b of bars) {
    const avg = avgOf(b.timestamp);
    if (avg && avg > 0) out.push(((b.close - avg) / avg) * 100);
  }
  return out;
}

/** 当前乖离的 z-score（相对当日 bias 分布），以及 μ/σ */
export function biasZOf(
  currentBias: number,
  bars: KBar[],
  avgOf: (ts: number) => number | undefined,
): { z: number; biasMean: number; biasStd: number } {
  const series = biasSeriesOf(bars, avgOf);
  const m = mean(series);
  const sd = stddev(series);
  return { z: zscore(currentBias, m, sd), biasMean: m, biasStd: sd };
}

// ==================== ATR 波动率（日线） ====================

/** ATR(period)：日线 True Range 均值 */
export function atr(bars: KBar[], period = 14): number {
  if (bars.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (!trs.length) return 0;
  const slice = trs.slice(-period);
  return mean(slice);
}

/** ATR 相对最新收盘价的比例 % */
export function atrPctOf(bars: KBar[], period = 14): number {
  const a = atr(bars, period);
  if (!(a > 0)) return 0;
  const last = bars[bars.length - 1]?.close;
  if (!(last > 0)) return 0;
  return (a / last) * 100;
}

// ==================== VWAP 斜率 / 单边度 ====================

/**
 * 最近 N 根分时 VWAP 线性回归斜率（bp/分钟，1bp=0.01%）。
 * 输入为按时间升序的 VWAP 值序列。
 */
export function vwapSlopeBpMin(avgSeries: number[], lookback = 5): number {
  const n = Math.min(avgSeries.length, lookback);
  if (n < 3) return 0;
  const xs = Array.from({ length: n }, (_, i) => i);
  const ys = avgSeries.slice(-n);
  const { slope } = linreg(xs, ys);
  const base = Math.abs(ys[ys.length - 1]) > 0 ? ys[ys.length - 1] : 1;
  return (slope / base) * 10000; // 每"根"变化比例 ×10000 bp
}

/**
 * 价格在 VWAP 单侧连续根数（正=现价在 VWAP 上方，负=下方；0=刚好穿越）。
 */
export function sideStreakOf(
  bars: KBar[],
  avgOf: (ts: number) => number | undefined,
): number {
  let streak = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    const avg = avgOf(bars[i].timestamp);
    if (!(avg && avg > 0)) break;
    const above = bars[i].close >= avg;
    if (streak === 0) streak = above ? 1 : -1;
    else if ((above && streak > 0) || (!above && streak < 0)) {
      streak += above ? 1 : -1;
    } else break;
  }
  return streak;
}

/** 最近 N 根分时 close 对时间的线性回归 R²（单边度；越高越单边） */
export function minuteR2(bars: KBar[], lookback = 30): number {
  const n = Math.min(bars.length, lookback);
  if (n < 3) return 0;
  const xs = Array.from({ length: n }, (_, i) => i);
  const ys = bars.slice(-n).map((b) => b.close);
  return linreg(xs, ys).r2;
}

// ==================== 盘口微观 ====================

/** 五档盘口失衡：= (买盘合计 - 卖盘合计) / (买盘合计 + 卖盘合计)，-1..1 */
export function bookImbalance(ob: OrderBook | null): number {
  const b = ob?.bidTotal ?? 0;
  const a = ob?.askTotal ?? 0;
  if (b + a <= 0) return 0;
  return (b - a) / (b + a);
}

/** 买卖价差率 %：=(ask1 - bid1) / mid × 100；档位缺失返回 Infinity（表示不可做） */
export function bidAskSpreadPct(ob: OrderBook | null): number {
  const ask = ob?.asks?.[0]?.price ?? 0;
  const bid = ob?.bids?.[0]?.price ?? 0;
  if (ask <= 0 || bid <= 0) return Infinity;
  const mid = (ask + bid) / 2;
  if (!(mid > 0)) return Infinity;
  return ((ask - bid) / mid) * 100;
}

/** 逐笔主动净量（手）：主买 - 主卖；bigVol 以上为大单单列 */
export function activeNetVol(
  trades: TradeTick[],
  bigVol = 500,
): { net: number; bigNet: number; buy: number; sell: number } {
  let net = 0, bigNet = 0, buy = 0, sell = 0;
  for (const t of trades) {
    if (t.side === "buy") {
      net += t.vol;
      buy += t.vol;
      if (t.vol >= bigVol) bigNet += t.vol;
    } else if (t.side === "sell") {
      net -= t.vol;
      sell += t.vol;
      if (t.vol >= bigVol) bigNet -= t.vol;
    }
  }
  return { net, bigNet, buy, sell };
}

// ==================== 分价筹码峰 ====================

/**
 * 分价筹码峰：成交量最大的 topN 档位中，取现价下方最近的支撑位与上方最近的压力位。
 * priceDist 按价格升序（EastMoney 口径）；vol 单位手。
 */
export function priceClusters(
  priceDist: PriceBucket[],
  price: number,
  topN = 3,
): { support: number; resist: number; top: PriceBucket[] } {
  const sorted = [...priceDist].sort((a, b) => b.vol - a.vol).slice(0, topN);
  let support = 0, resist = 0;
  for (const b of sorted) {
    if (b.price < price && b.price > support) support = b.price;
    if (b.price > price && (resist === 0 || b.price < resist)) resist = b.price;
  }
  return { support, resist, top: sorted };
}

// ==================== 相对强弱 ====================

/** 个股相对大盘涨跌幅差 %（正=强于大盘） */
export function relativeStrength(stockPct: number, marketPct: number): number {
  return stockPct - marketPct;
}

// ==================== 市况识别（Regime Gate） ====================

export type Regime = "up" | "down" | "range" | "extreme";

export interface RegimeInputs {
  bias: number;          // 现价相对 VWAP 乖离 %
  maxBias: number;       // 乖离极端阈值（消息驱动）
  vwapSlope5: number;    // bp/分钟
  sideStreak: number;    // 单侧连续根数
  r2: number;            // 分时 R²
  marketPct: number;     // 大盘涨跌 %
  marketCrash: number;   // 大盘急跌阈值（负）
}

/** 市况判定：extreme > 单边 > 震荡 */
export function regimeOf(i: RegimeInputs): Regime {
  if (Math.abs(i.bias) > i.maxBias || i.marketPct <= i.marketCrash) return "extreme";
  const strongSlopeUp = i.vwapSlope5 > 0.6 && i.sideStreak >= 4;
  const strongSlopeDown = i.vwapSlope5 < -0.6 && i.sideStreak <= -4;
  const driftUp = i.r2 > 0.7 && i.vwapSlope5 > 0.8;
  const driftDown = i.r2 > 0.7 && i.vwapSlope5 < -0.8;
  if (strongSlopeUp || driftUp) return "up";
  if (strongSlopeDown || driftDown) return "down";
  return "range";
}

/** 某市况下允许做某方向（extreme 一律禁开新仓；单边只做顺方向） */
export function regimeAllows(regime: Regime, dir: "long" | "short"): boolean {
  if (regime === "extreme") return false;
  if (regime === "up") return dir === "long";
  if (regime === "down") return dir === "short";
  return true; // range 双向
}

// ==================== 打分卡（替代布尔与） ====================

export type SignalGrade = "strong" | "prep" | "wait";

export interface ScoreFactors {
  biasZ: number;           // 乖离 z-score（long 期望偏负、short 期望偏正）
  bookImb: number;         // 盘口失衡 -1..1（long 期望正、short 期望负）
  actNet: number;          // 逐笔主动净量（手）（long 期望正、short 期望负）
  turnUp: boolean;         // 分时止跌
  turnDown: boolean;       // 分时滞涨
  nearSupportPct: number;  // 距近5日支撑 %（正=在上方，long 期望小）
  nearVwapPct: number;     // 距 VWAP %（long 期望 ≤0）
  nearResistPct: number;   // 距近5日压力 %（负=在下方，short 期望小）
  relStrength: number;     // 相对大盘 %（long 期望 ≥0 附近、short 期望 ≤0 附近）
  atrPct: number;          // 日线 ATR %（波动太小降分）
}

export interface ScoreParts {
  bias: number;
  book: number;
  volume: number;
  position: number;
  strength: number;
}

export interface ScoreResult {
  total: number;
  parts: ScoreParts;
  missing: string[]; // 最大失分项（供 reasons 展示）
}

// 权重：regime 由闸门一票否决，不入分
const W = { bias: 30, book: 20, volume: 15, position: 20, strength: 15 };

/** 线性分段评分：x 落在 [good, bad] 之间 max→0 */
function bandMax(x: number, good: number, bad: number, max: number): number {
  if (good === bad) return x <= good ? max : 0;
  const t = clamp((x - good) / (bad - good), 0, 1);
  return max * (1 - t);
}

export function scoreLong(f: ScoreFactors): ScoreResult {
  // 乖离：z 越负越好（回踩）；太负（>2σ）反而警惕（满分 30）
  const bias =
    f.biasZ <= 0 ? bandMax(f.biasZ, -0.8, -1.8, 30) : bandMax(f.biasZ, 0.2, 1.5, 30);
  // 盘口：失衡越正越配合买入（满分 20）
  const book = bandMax(-f.bookImb, -0.15, 0.35, 20);
  // 量能：主动净量为正 + 止跌拐头（满分 15）
  let volume = bandMax(-f.actNet / 100, -1, 3, 15);
  if (f.turnUp) volume = Math.min(15, volume + 6);
  // 位置：距支撑近 + 在 VWAP 下方（满分 20）
  const position =
    0.6 * bandMax(f.nearSupportPct, 0.5, 3, 20) + 0.4 * bandMax(f.nearVwapPct, 0.2, 1.2, 20);
  // 相对强弱：不强不弱（0 附近）最好，过强有追高风险（满分 15）
  const strength = bandMax(Math.abs(f.relStrength), 0.3, 1.8, 15);
  const parts = {
    bias: Math.round(bias),
    book: Math.round(book),
    volume: Math.round(volume),
    position: Math.round(position),
    strength: Math.round(strength),
  };
  return { total: 0, parts, missing: [] };
}

export function scoreShort(f: ScoreFactors): ScoreResult {
  // 乖离：z 越正越好（冲高）
  const bias =
    f.biasZ >= 0 ? bandMax(-f.biasZ, -0.8, -1.8, 30) : bandMax(-f.biasZ, 0.2, 1.5, 30);
  // 盘口：失衡越负越配合卖出（满分 20）
  const book = bandMax(f.bookImb, -0.15, 0.35, 20);
  // 量能：主动净量为负 + 滞涨拐头（满分 15）
  let volume = bandMax(f.actNet / 100, -1, 3, 15);
  if (f.turnDown) volume = Math.min(15, volume + 6);
  // 位置：距压力近 + 在 VWAP 上方（满分 20）
  const position =
    0.6 * bandMax(-f.nearResistPct, 0.5, 3, 20) + 0.4 * bandMax(-f.nearVwapPct, 0.2, 1.2, 20);
  const strength = bandMax(Math.abs(f.relStrength), 0.3, 1.8, 15);
  const parts = {
    bias: Math.round(bias),
    book: Math.round(book),
    volume: Math.round(volume),
    position: Math.round(position),
    strength: Math.round(strength),
  };
  return { total: 0, parts, missing: [] };
}

/** 汇总各分项为总分并给出缺失项 */
export function summarize(parts: ScoreParts): ScoreResult {
  const total = parts.bias + parts.book + parts.volume + parts.position + parts.strength;
  const entries: [keyof ScoreParts, number, number][] = [
    ["bias", parts.bias, W.bias],
    ["book", parts.book, W.book],
    ["volume", parts.volume, W.volume],
    ["position", parts.position, W.position],
    ["strength", parts.strength, W.strength],
  ];
  const missing = entries
    .filter(([, v, w]) => w - v >= 8)
    .map(([k, v, w]) => `${k}:${v}/${w}`)
    .slice(0, 2);
  return { total, parts, missing };
}

/** 分级：≥75 强信号 / 60-74 预备 / <60 观望 */
export function gradeOf(total: number): SignalGrade {
  if (total >= 75) return "strong";
  if (total >= 60) return "prep";
  return "wait";
}
