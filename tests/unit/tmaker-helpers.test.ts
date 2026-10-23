import { describe, it, expect } from "vitest";
import { recentDailyBars } from "../../src/composables/useTmaker";
import type { KBar } from "../../src/api/types";

function bar(ts: number, low: number, high: number, close: number): KBar {
  return { timestamp: ts, open: close, high, low, close, volume: 1000 };
}

/** 今天（UTC）的毫秒时间戳 */
function todayTs(hour = 10): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0, 0);
}

const DAY = 24 * 3600 * 1000;

describe("recentDailyBars 近5日完整交易日（剔除当日）", () => {
  it("升序 6 根（不含今日）→ 取最近 5 根", () => {
    const bars = Array.from({ length: 6 }, (_, i) =>
      bar(todayTs() - (6 - i) * DAY, 10 + i, 12 + i, 11 + i),
    );
    const out = recentDailyBars(bars, 5);
    expect(out.length).toBe(5);
    expect(out[0].timestamp).toBe(bars[1].timestamp); // 丢掉最老一根
    expect(out[4].timestamp).toBe(bars[5].timestamp);
  });

  it("乱序输入 → 先升序再取", () => {
    const a = bar(todayTs() - 5 * DAY, 1, 2, 1.5);
    const b = bar(todayTs() - 3 * DAY, 3, 4, 3.5);
    const c = bar(todayTs() - 1 * DAY, 5, 6, 5.5);
    const out = recentDailyBars([b, a, c], 5);
    expect(out.map((x) => x.close)).toEqual([1.5, 3.5, 5.5]);
  });

  it("含今日K → 剔除今日后取最近 5 根", () => {
    const bars = [
      ...Array.from({ length: 6 }, (_, i) => bar(todayTs() - (6 - i) * DAY, 10 + i, 12 + i, 11 + i)),
      bar(todayTs(14), 20, 21, 20.5), // 今日未收盘K
    ];
    const out = recentDailyBars(bars, 5);
    expect(out.length).toBe(5);
    expect(out.every((x) => x.close < 20)).toBe(true); // 不含今日
  });

  it("不足 5 根 → 返回全部", () => {
    const bars = [bar(todayTs() - 2 * DAY, 1, 2, 1.5), bar(todayTs() - 1 * DAY, 2, 3, 2.5)];
    const out = recentDailyBars(bars, 5);
    expect(out.length).toBe(2);
  });

  it("空数组 → 空", () => {
    expect(recentDailyBars([], 5)).toEqual([]);
  });
});
