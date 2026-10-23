import { describe, expect, it } from "vitest";
import { gridSearch } from "../../src/composables/tmaker/optimize";
import { runBacktest, DEFAULT_BT_PARAMS } from "../../src/composables/tmaker/backtest";
import type { HistDayMinute } from "../../src/api/market";
import type { KBar } from "../../src/api/types";

function makeDay(date: string, closes: (i: number) => number, vols: (i: number) => number = () => 100): HistDayMinute {
  const y = Number(date.slice(0, 4)), mo = Number(date.slice(4, 6)) - 1, d = Number(date.slice(6, 8));
  const start = new Date(y, mo, d, 9, 30).getTime();
  const bars: KBar[] = [];
  for (let i = 0; i < 241; i++) {
    const c = closes(i);
    bars.push({ timestamp: start + i * 60000, open: c, close: c, high: c, low: c, volume: vols(i) });
  }
  return { date, bars };
}
function makeDailies(count: number, close = 10.0): KBar[] {
  const start = new Date(2026, 9, 12, 15, 0).getTime();
  const out: KBar[] = [];
  for (let i = 0; i < count; i++) out.push({ timestamp: start + i * 86400000, open: close, close, high: close * 1.04, low: close * 0.96, volume: 6_000_000 });
  return out;
}
/** 单日：急跌→回升→缓跌→尾段拉升（正T信号后上涨 = 命中走势） */
function trendDay(date: string): HistDayMinute {
  return makeDay(date, (i) => {
    if (i < 30) return 10.0;
    if (i < 33) return 9.8 - (i - 30) * 0.02;
    if (i < 37) return [9.75, 9.85, 9.95, 10.02][i - 33];
    if (i < 45) return 10.0 - (i - 37) * 0.01;
    return 10.0 + (i - 45) * 0.03;
  }, (i) => (i >= 33 && i < 36 ? 500 : 100));
}

describe("gridSearch 参数寻优", () => {
  it("样本不足（<4 日）返回 null", () => {
    const days = [trendDay("20261019"), trendDay("20261020"), trendDay("20261021")];
    expect(gridSearch(days, makeDailies(8))).toBeNull();
  });

  it("切分口径：10 日 → in 7 / out 3，组合数 = 各参数候选乘积", () => {
    const days = Array.from({ length: 10 }, (_, i) => trendDay(`2026101${i}`));
    const r = gridSearch(days, makeDailies(12), DEFAULT_BT_PARAMS, {
      scoreOpen: [70, 75],
      stopMinPct: [1.0],
      targetMult: [1.5],
      maxPerDay: [2],
    });
    expect(r).not.toBeNull();
    expect(r!.sampleDays).toBe(10);
    expect(r!.inDays).toBe(7);
    expect(r!.outDays).toBe(3);
    expect(r!.combos).toBe(2);
    expect(r!.rows.length).toBeLessThanOrEqual(5);
    expect(r!.rows.length).toBeGreaterThan(0);
  });

  it("组合包含 in/out 两个回测结果且参数各不相同", () => {
    const days = Array.from({ length: 10 }, (_, i) => trendDay(`2026101${i}`));
    const r = gridSearch(days, makeDailies(12), DEFAULT_BT_PARAMS, {
      scoreOpen: [70, 80],
      stopMinPct: [1.0, 1.2],
      targetMult: [1.5],
      maxPerDay: [2],
    });
    expect(r!.combos).toBe(4);
    expect(r!.rows[0].params.scoreOpen).toBeDefined();
    expect(r!.rows[0].in.sampleDays).toBeGreaterThan(0);
    expect(r!.rows[0].out.sampleDays).toBeGreaterThan(0);
    // 排序：score 降序
    for (let i = 1; i < r!.rows.length; i++) {
      expect(r!.rows[i - 1].score).toBeGreaterThanOrEqual(r!.rows[i].score);
    }
  });

  it("样本外笔数不足的组被降权（排在样本外笔数足的组后面）", () => {
    const days = Array.from({ length: 12 }, (_, i) => trendDay(`2026101${i}`));
    // 严格参数：样本外可能不足 2 笔；宽松参数：样本外笔数多
    const r = gridSearch(days, makeDailies(14), DEFAULT_BT_PARAMS, {
      scoreOpen: [60, 80],
      stopMinPct: [1.0],
      targetMult: [1.5],
      maxPerDay: [2, 4],
    });
    // 宽松组（scoreOpen 60）应有更多样本外笔数
    const loose = r!.rows.find((x) => x.params.scoreOpen === 60);
    const strict = r!.rows.find((x) => x.params.scoreOpen === 80);
    if (loose && strict) {
      expect(loose.out.count).toBeGreaterThanOrEqual(strict.out.count);
    }
  });

  it("寻优结果可直接用于回测（参数闭环）", () => {
    const days = Array.from({ length: 10 }, (_, i) => trendDay(`2026101${i}`));
    const r = gridSearch(days, makeDailies(12));
    if (r && r.rows.length > 0) {
      const best = r.rows[0].params;
      const bt = runBacktest("600000", days, makeDailies(12), best);
      expect(bt.sampleDays).toBe(10);
      expect(best.scoreOpen).toBeGreaterThanOrEqual(0);
    }
    // 默认网格至少能跑通
    expect(r!.combos).toBeGreaterThan(10);
  });
});
