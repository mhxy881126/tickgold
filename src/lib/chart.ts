// 图表相关纯函数：格式化、涨跌停幅度、K线数据转换、分时均价、日期标签与 K 线归属判定。
// 从 StockChart.vue 抽出，无副作用，便于单元测试。

import type { KLineData } from "klinecharts";
import type { KBar } from "../api/types";

export const pad = (n: number) => String(n).padStart(2, "0");
export const round2 = (v: number) => Math.round(v * 100) / 100;

export function fmtVol(v: number): string {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿手";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万手";
  return v.toFixed(0) + "手";
}

export function fmtAmt(v: number): string {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万";
  return v.toFixed(0);
}

// 板块涨跌停幅度
export function limitRateOf(code: string, name?: string): number {
  const nm = name || "";
  if (nm.includes("ST")) return 0.05;
  if (/^(300|301)/.test(code)) return 0.2;  // 创业板
  if (/^(688|689)/.test(code)) return 0.2;  // 科创板
  if (/^(8|4|920)/.test(code)) return 0.3;  // 北交所
  return 0.1;                               // 主板
}

export function toKData(bars: KBar[]): KLineData[] {
  return bars.map((b) => ({
    timestamp: b.timestamp,
    open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
  }));
}

// ---- 分时均价映射 ----
export function buildAvgMap(bars: KBar[]): Map<number, number> {
  const m = new Map<number, number>();
  let tv = 0, v = 0;
  for (const b of bars) {
    tv += b.close * b.volume; v += b.volume;
    m.set(b.timestamp, v > 0 ? tv / v : b.close);
  }
  return m;
}

export const hhmmUTC = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

export function dateLabel(ts: number) {
  const d = new Date(ts);
  const wk = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${wk[d.getUTCDay()]}`;
}

export function sameDay(ts: number, d: Date) {
  const x = new Date(ts);
  return x.getUTCFullYear() === d.getUTCFullYear() && x.getUTCMonth() === d.getUTCMonth() && x.getUTCDate() === d.getUTCDate();
}

// 判断一根 KBar 是否包含日期 d（日/周/月 K）
export function barContains(b: KBar, d: Date, period: number): boolean {
  const x = new Date(b.timestamp);
  if (period === 101) return sameDay(b.timestamp, d);
  if (period === 103) return x.getUTCFullYear() === d.getUTCFullYear() && x.getUTCMonth() === d.getUTCMonth();
  if (period === 102) {
    const monday = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
    const wd = (monday.getUTCDay() + 6) % 7;
    monday.setUTCDate(monday.getUTCDate() - wd);
    const next = new Date(monday); next.setUTCDate(next.getUTCDate() + 7);
    return d >= monday && d < next;
  }
  return false;
}

// 由成交时间定位所在 K 线索引（bars 显式传入，纯函数）
export function findBarIndex(
  createdAt: number,
  tab: { period?: number },
  bars: KBar[]
): number {
  const od = new Date(createdAt);
  const period = tab.period;
  if (period && period >= 101) {
    return bars.findIndex((b) => barContains(b, od, period));
  }
  let best = -1, bd = Infinity;
  bars.forEach((b, i) => {
    const diff = Math.abs(b.timestamp - createdAt);
    if (diff < bd) { bd = diff; best = i; }
  });
  const tol = (period || 5) * 60 * 1000 * 1.5;
  return bd <= tol ? best : -1;
}
