// 技术指标纯函数：输入 K线，输出最新一期指标值（供预警评估复用）
import type { KBar } from "../api/types";

/** 简单移动平均（最新值），数据不足返回 null */
export function ma(closes: number[], period: number): number | null {
  if (period <= 0 || closes.length < period) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
  return sum / period;
}

/** 指数移动平均序列 */
function emaSeries(closes: number[], period: number): number[] {
  if (closes.length === 0 || period <= 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    out.push(closes[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

/** 指数移动平均（最新值），数据不足返回 null */
export function ema(closes: number[], period: number): number | null {
  const s = emaSeries(closes, period);
  return s.length ? s[s.length - 1] : null;
}

export interface MacdResult {
  dif: number;
  dea: number;
  macd: number; // 柱 = 2*(DIF-DEA)
}

/** MACD（最新值），数据不足返回 null */
export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9
): MacdResult | null {
  if (closes.length < slow) return null;
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const difArr = closes.map((_, i) => ef[i] - es[i]);
  const deaArr = emaSeries(difArr, signal);
  const i = closes.length - 1;
  const dif = difArr[i];
  const dea = deaArr[i];
  return { dif, dea, macd: 2 * (dif - dea) };
}

export interface KdjResult {
  k: number;
  d: number;
  j: number;
}

/** KDJ（最新值），数据不足时以可用长度计算 */
export function kdj(bars: KBar[], period = 9): KdjResult | null {
  if (bars.length === 0) return null;
  const kArr: number[] = [];
  const dArr: number[] = [];
  let prevK = 50;
  let prevD = 50;
  for (let i = 0; i < bars.length; i++) {
    const start = Math.max(0, i - period + 1);
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = start; j <= i; j++) {
      if (bars[j].high > hh) hh = bars[j].high;
      if (bars[j].low < ll) ll = bars[j].low;
    }
    const rsv = hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100;
    const k = (2 / 3) * prevK + (1 / 3) * rsv;
    const d = (2 / 3) * prevD + (1 / 3) * k;
    kArr.push(k);
    dArr.push(d);
    prevK = k;
    prevD = d;
  }
  const i = bars.length - 1;
  const k = kArr[i];
  const d = dArr[i];
  return { k, d, j: 3 * k - 2 * d };
}

/** RSI（最新值），数据不足返回 null */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}
