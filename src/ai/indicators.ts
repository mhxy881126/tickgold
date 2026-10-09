// 技术指标与多周期 / 买点形态计算：纯函数，KBar[] → 均线 / MACD / KDJ / RSI +
// 趋势结构 + 买点位置（突破 / 回踩 / 低吸）。不碰 DOM，可在 node 单测。
import type { KBar } from "../api/types";
import type { MarketRegime } from "./position";

function clampNum(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// ─── 均线 ───
export function sma(v: number[], p: number): number[] {
  const out = new Array<number>(v.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= p) sum -= v[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

/** EMA（输入无前置 NaN；种子为前 p 个 SMA） */
export function ema(v: number[], p: number): number[] {
  const out = new Array<number>(v.length).fill(NaN);
  if (v.length < p) return out;
  const k = 2 / (p + 1);
  let prev = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = prev;
  for (let i = p; i < v.length; i++) {
    prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// ─── MACD ───
export interface MacdPoint { dif: number; dea: number; macd: number; }
export function macd(closes: number[], fast = 12, slow = 26, sig = 9): MacdPoint[] {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const start = slow - 1;
  const difClean = closes.slice(start).map((_, k) => ef[start + k] - es[start + k]);
  const deaClean = ema(difClean, sig);
  return closes.map((_, i) => {
    if (i < start) return { dif: NaN, dea: NaN, macd: NaN };
    const k = i - start;
    const dif = difClean[k];
    const dea = deaClean[k];
    return { dif, dea, macd: isNaN(dea) ? NaN : (dif - dea) * 2 };
  });
}

// ─── KDJ ───
export interface KdjPoint { k: number; d: number; j: number; }
function smoothSma(v: number[], m: number): number[] {
  const out = new Array<number>(v.length).fill(NaN);
  let prev = 50;
  for (let i = 0; i < v.length; i++) {
    prev = (v[i] + (m - 1) * prev) / m;
    out[i] = prev;
  }
  return out;
}
export function kdj(bars: KBar[], n = 9): KdjPoint[] {
  const rsv = bars.map((b, i) => {
    let hh = -Infinity, ll = Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) {
      hh = Math.max(hh, bars[j].high);
      ll = Math.min(ll, bars[j].low);
    }
    return hh === ll ? 50 : ((b.close - ll) / (hh - ll)) * 100;
  });
  const kArr = smoothSma(rsv, 3);
  const dArr = smoothSma(kArr, 3);
  return bars.map((_, i) => ({ k: kArr[i], d: dArr[i], j: 3 * kArr[i] - 2 * dArr[i] }));
}

// ─── RSI ───
export function rsi(closes: number[], p = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= p) {
      gain += g; loss += l;
      if (i === p) {
        const ag = gain / p, al = loss / p;
        out[i] = al === 0 ? 100 : 100 - 100 / (ag / al + 1);
      }
    } else {
      gain = (gain * (p - 1) + g) / p;
      loss = (loss * (p - 1) + l) / p;
      out[i] = loss === 0 ? 100 : 100 - 100 / (gain / loss + 1);
    }
  }
  return out;
}

// ─── 趋势结构（多周期 / 均线排列）───
export interface TrendSnapshot {
  ma5: number; ma10: number; ma20: number; ma60: number;
  price: number;
  bullAlign: boolean;   // 均线多头排列 ma5>ma10>ma20>ma60
  aboveMa20: boolean;
  direction: "up" | "flat" | "down";
}
export function trendOf(bars: KBar[]): TrendSnapshot {
  const closes = bars.map((b) => b.close);
  const i = closes.length - 1;
  const ma5 = sma(closes, 5)[i];
  const ma10 = sma(closes, 10)[i];
  const ma20 = sma(closes, 20)[i];
  const ma60 = sma(closes, 60)[i];
  const price = closes[i];
  const nums = [ma5, ma10, ma20, ma60];
  const bullAlign = nums.every((x) => !isNaN(x)) && ma5 > ma10 && ma10 > ma20 && ma20 > ma60;
  const aboveMa20 = !isNaN(ma20) && price > ma20;
  const direction =
    !isNaN(ma20) && price > ma20 && ma5 > ma20 ? "up"
    : !isNaN(ma20) && price < ma20 && ma5 < ma20 ? "down"
    : "flat";
  return { ma5, ma10, ma20, ma60, price, bullAlign, aboveMa20, direction };
}

// ─── 买点位置 / 形态 ───
export type BuySetup = "breakout" | "pullback" | "low-buy" | "none";
export interface SetupResult {
  setup: BuySetup;
  quality: number;   // 0–1 形态质量
  notes: string[];
}

function avgVolume(bars: KBar[], n: number, end: number): number {
  let s = 0, c = 0;
  for (let i = end - n; i < end; i++) {
    if (i >= 0) { s += bars[i].volume; c++; }
  }
  return c ? s / c : 0;
}

/**
 * 识别买点：
 * - breakout 放量突破近 20 日高点
 * - pullback 多头中缩量回踩 MA20 企稳
 * - low-buy 支撑位缩量 + 下影线企稳
 */
export function detectSetup(bars: KBar[], volumeRatio?: number): SetupResult {
  if (bars.length < 25) return { setup: "none", quality: 0, notes: ["K 线不足 25 根"] };
  const i = bars.length - 1;
  const b = bars[i];
  const closes = bars.map((x) => x.close);

  let hh = -Infinity, ll = Infinity;
  for (let j = i - 20; j < i; j++) { hh = Math.max(hh, closes[j]); ll = Math.min(ll, bars[j].low); }
  const ma20c = sma(closes, 20)[i];
  const baseVol = avgVolume(bars, 5, i);
  const volExp = (!!volumeRatio && volumeRatio >= 1.5) || b.volume >= baseVol * 1.4;
  const volShrink = b.volume < baseVol * 0.9;

  // ① 突破
  if (b.close > hh) {
    if (volExp) return { setup: "breakout", quality: 0.85, notes: [`放量突破 20 日高点 ${hh.toFixed(2)}`] };
    return { setup: "breakout", quality: 0.5, notes: ["突破 20 日高点但量能不足"] };
  }
  // ② 回踩 MA20
  const trend = trendOf(bars);
  if (trend.direction !== "down" && !isNaN(ma20c)) {
    const dist = (b.close - ma20c) / ma20c;
    if (dist >= -0.02 && dist <= 0.03 && volShrink && b.close >= b.open * 0.99) {
      return { setup: "pullback", quality: 0.72, notes: [`缩量回踩 MA20(${ma20c.toFixed(2)})企稳`] };
    }
  }
  // ③ 低吸（支撑 + 下影）
  const toLow = (b.close - ll) / ll;
  const lowerWick = Math.min(b.open, b.close) - b.low;
  const barRange = Math.max(b.high - b.low, 1e-9);
  if (toLow <= 0.03 && volShrink && lowerWick / barRange > 0.35) {
    return { setup: "low-buy", quality: 0.62, notes: [`支撑位 ${ll.toFixed(2)} 缩量下影企稳`] };
  }
  return { setup: "none", quality: 0, notes: ["无符合纪律的买点"] };
}

/** 综合技术面健康度（0–100）：趋势 + MACD/KDJ/RSI 位置，供多因子决策的趋势维度使用 */
export function technicalHealth(bars: KBar[]): { score: number; notes: string[] } {
  const notes: string[] = [];
  const trend = trendOf(bars);
  let s = 50;
  if (trend.bullAlign) { s += 22; notes.push("均线多头排列"); }
  else if (trend.direction === "down") { s -= 22; notes.push("均线空头"); }
  if (trend.aboveMa20) { s += 10; notes.push("站上 MA20"); } else { s -= 10; notes.push("跌破 MA20"); }

  const closes = bars.map((b) => b.close);
  const i = closes.length - 1;
  const m = macd(closes)[i];
  if (!isNaN(m.dif)) {
    if (m.dif > 0 && m.macd > 0) { s += 10; notes.push("MACD 红柱"); }
    else if (m.dif < 0 && m.macd < 0) { s -= 10; notes.push("MACD 绿柱"); }
  }
  const r = rsi(closes, 14)[i];
  if (!isNaN(r)) {
    if (r >= 80) { s -= 8; notes.push(`RSI 超买 ${r.toFixed(0)}`); }
    else if (r <= 25) { s += 6; notes.push(`RSI 超卖 ${r.toFixed(0)}`); }
  }
  return { score: clampNum(s, 0, 100), notes };
}

// ─── 大盘状态（regime）：由指数 K 线判断 up / flat / down，驱动总仓位与开仓门控 ───
export function regimeOfIndex(bars: KBar[]): MarketRegime {
  if (bars.length < 25) return "flat";
  const closes = bars.map((b) => b.close);
  const i = closes.length - 1;
  const price = closes[i];
  const ma20 = sma(closes, 20)[i];
  const ma60 = sma(closes, 60)[i];
  const ma20prev = sma(closes, 20)[Math.max(0, i - 5)];
  const rising = !isNaN(ma20prev) && ma20 > ma20prev;

  if (!isNaN(ma20) && price > ma20 && rising && (isNaN(ma60) || price > ma60)) return "up";
  if (!isNaN(ma20) && price < ma20 && !rising) return "down";
  return "flat";
}
