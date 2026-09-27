// 交易时段与静默时段纯函数（供预警引擎 / 场景判断复用）
import type { QuietRange } from "../alert/types";

/** 是否工作日（周一至周五，不含节假日；仅按星期近似） */
export function isWeekday(d: Date = new Date()): boolean {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

function hhmm(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** "HH:MM" → 分钟数 */
export function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** 是否处于连续竞价交易时段（工作日 9:30-11:30 / 13:00-15:00） */
export function isTrading(d: Date = new Date()): boolean {
  if (!isWeekday(d)) return false;
  const m = hhmm(d);
  return (m >= 9 * 60 + 30 && m <= 11 * 60 + 30) ||
    (m >= 13 * 60 && m <= 15 * 60);
}

/** 是否集合竞价时段（9:15-9:25） */
export function isAuction(d: Date = new Date()): boolean {
  if (!isWeekday(d)) return false;
  const m = hhmm(d);
  return m >= 9 * 60 + 15 && m < 9 * 60 + 25;
}

/** 是否收盘窗口（14:50-15:00） */
export function isCloseWindow(d: Date = new Date()): boolean {
  if (!isWeekday(d)) return false;
  const m = hhmm(d);
  return m >= 14 * 60 + 50 && m <= 15 * 60;
}

/**
 * 当前是否落在任一静默时段内。支持跨 0 点（start > end，如 22:00-08:00）。
 */
export function inQuietRange(
  ranges: QuietRange[],
  d: Date = new Date()
): boolean {
  const cur = hhmm(d);
  for (const r of ranges) {
    const s = toMinutes(r.start);
    const e = toMinutes(r.end);
    if (s === e) continue;
    if (s < e) {
      if (cur >= s && cur < e) return true;
    } else {
      // 跨 0 点
      if (cur >= s || cur < e) return true;
    }
  }
  return false;
}
