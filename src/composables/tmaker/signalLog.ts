/**
 * P3-4 信号留痕与 MFE/MAE 回灌（纯函数 + localStorage 适配）。
 *
 * 动机：决策台只展示"当前信号"，从不回答"这类信号历史上靠不靠谱"。
 * 每次对外强信号记录特征快照；收盘后用当日分钟数据计算 5/15/30 分钟
 * MFE（最大有利偏移）/ MAE（最大不利偏移）与命中率，回灌信号质量统计。
 *
 * 防未来函数：评估只使用信号时刻【之后】的分钟 bar，绝不回看信号前数据。
 */
import type { Regime } from "./features";

/** 一条信号留痕（对外可执行强信号） */
export interface SignalLogEntry {
  code: string;
  date: string;      // YYYYMMDD
  time: string;      // HH:mm
  dir: "long" | "short";
  score: number;     // 打分卡总分
  regime: Regime;
  bias: number;      // 乖离 %
  biasZ: number;
  price: number;     // 信号参考价
  stop: number;      // 止损价
  target: number;    // 目标价
  at: number;        // ms
}

/** 单信号评估结果（窗口 5/15/30 分钟；命中/止损判定窗口 30 分钟） */
export interface SignalEval {
  hit: boolean;        // 30 分钟内触及目标价
  stopped: boolean;    // 30 分钟内触及止损价
  mfe5: number; mfe15: number; mfe30: number;   // %（long 取窗口内最高，short 取最低）
  mae5: number; mae15: number; mae30: number;   // %（long 取窗口内最低，short 取最高；负数=不利）
  barsUsed: number;    // 实际用到的 bar 数（尾部样本可能不足）
}

/** 信号质量汇总 */
export interface SignalLogStats {
  count: number;
  evaluated: number;
  hitRate: number;      // 30min 命中率 %
  stoppedRate: number;  // 30min 止损触发率 %
  avgMfe15: number;     // 平均 15min MFE %
  avgMae15: number;     // 平均 15min MAE %
  long: { count: number; hitRate: number };
  short: { count: number; hitRate: number };
  byScore: { band: string; count: number; hitRate: number }[]; // 按分数段
  recent: SignalLogEntry[];
}

const LS_KEY = "tmaker-signal-log-v1";
const CAP = 400;

// ============ 记录 ============

export function recordSignal(entry: SignalLogEntry): void {
  const log = loadSignalLog();
  const last = log[0];
  // 同日同时同码同方向 60s 内去重（防同一信号重复落盘）
  if (last && last.code === entry.code && last.date === entry.date && last.dir === entry.dir && entry.at - last.at < 60_000) {
    return;
  }
  log.unshift(entry);
  const capped = log.slice(0, CAP);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(capped));
  } catch {
    /* 隐私/容量限制时静默，不影响主流程 */
  }
}

export function loadSignalLog(): SignalLogEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as SignalLogEntry[];
    return Array.isArray(arr) ? arr.filter((e) => e && e.code && e.dir) : [];
  } catch {
    return [];
  }
}

export function clearSignalLog(): void {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* noop */
  }
}

// ============ 评估 ============

/**
 * 单信号评估：从信号时刻起取 5/15/30 根分钟 bar 算 MFE/MAE。
 * long：MFE=窗口最高相对信号的有利幅度，MAE=窗口最低的不利幅度。
 * short：MFE=窗口最低的有利幅度，MAE=窗口最高的不利幅度。
 * 命中 = 窗口内触及 target；止损 = 窗口内触及 stop。
 */
export function evaluateEntry(e: SignalLogEntry, bars: { timestamp: number; high: number; low: number }[]): SignalEval | null {
  const startIdx = bars.findIndex((b) => b.timestamp >= e.at);
  if (startIdx < 0) return null;
  const window = bars.slice(startIdx, startIdx + 30);
  if (window.length === 0) return null;

  const hi = (n: number) => window.slice(0, n).reduce((m, b) => Math.max(m, b.high), -Infinity);
  const lo = (n: number) => window.slice(0, n).reduce((m, b) => Math.min(m, b.low), Infinity);
  const p = e.price;
  const isLong = e.dir === "long";
  // long：MFE=窗口最高相对信号的有利幅度；MAE=窗口最低的不利幅度（负）
  // short：MFE=窗口最低的有利幅度（价格下跌为有利，正）；MAE=窗口最高的不利幅度（价格上涨为不利，正）
  const mfe = (n: number) => ((isLong ? hi(n) - p : p - lo(n)) / p) * 100;
  const mae = (n: number) => ((isLong ? lo(n) - p : hi(n) - p) / p) * 100;

  const hi30 = hi(30), lo30 = lo(30);
  const hit = isLong ? hi30 >= e.target : lo30 <= e.target;
  const stopped = isLong ? lo30 <= e.stop : hi30 >= e.stop;

  return {
    hit, stopped,
    mfe5: mfe(5), mfe15: mfe(15), mfe30: mfe(30),
    mae5: mae(5), mae15: mae(15), mae30: mae(30),
    barsUsed: window.length,
  };
}

/** 批量评估：days 为 {date: bars}（当日完整分钟数据） */
export function evaluateLog(
  log: SignalLogEntry[],
  days: Map<string, { timestamp: number; high: number; low: number }[]>,
): SignalLogStats {
  const out: SignalLogStats = {
    count: log.length, evaluated: 0, hitRate: 0, stoppedRate: 0,
    avgMfe15: 0, avgMae15: 0,
    long: { count: 0, hitRate: 0 },
    short: { count: 0, hitRate: 0 },
    byScore: [], recent: log.slice(0, 20),
  };
  if (log.length === 0) return out;

  let ev = 0, hits = 0, stops = 0, mfeSum = 0, maeSum = 0;
  let longEval = 0, shortEval = 0;
  const dirHits = { long: 0, short: 0 } as Record<string, number>;
  const scoreBands = new Map<string, { count: number; hits: number }>();

  for (const e of log) {
    const bars = days.get(e.date);
    if (!bars) continue;
    const r = evaluateEntry(e, bars);
    if (!r) continue;
    ev++;
    if (e.dir === "long") longEval++; else shortEval++;
    if (r.hit) { hits++; dirHits[e.dir]++; }
    if (r.stopped) stops++;
    mfeSum += r.mfe15;
    maeSum += r.mae15;
    const band = e.score >= 85 ? "85+" : e.score >= 75 ? "75-84" : "60-74";
    const b = scoreBands.get(band) ?? { count: 0, hits: 0 };
    b.count++; if (r.hit) b.hits++;
    scoreBands.set(band, b);
  }

  out.evaluated = ev;
  out.hitRate = ev ? (hits / ev) * 100 : 0;
  out.stoppedRate = ev ? (stops / ev) * 100 : 0;
  out.avgMfe15 = ev ? mfeSum / ev : 0;
  out.avgMae15 = ev ? maeSum / ev : 0;
  out.long.count = log.filter((e) => e.dir === "long").length;
  out.short.count = log.filter((e) => e.dir === "short").length;
  out.long.hitRate = longEval ? (dirHits.long / longEval) * 100 : 0;
  out.short.hitRate = shortEval ? (dirHits.short / shortEval) * 100 : 0;
  out.byScore = [...scoreBands.entries()]
    .map(([band, v]) => ({ band, count: v.count, hitRate: v.count ? (v.hits / v.count) * 100 : 0 }))
    .sort((a, b) => (a.band < b.band ? 1 : -1));

  return out;
}
