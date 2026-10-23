import { describe, expect, it } from "vitest";
import { runBacktest, DEFAULT_BT_PARAMS } from "../../src/composables/tmaker/backtest";
import type { BtParams } from "../../src/composables/tmaker/backtest";
import type { KBar } from "../../src/api/types";
import type { HistDayMinute } from "../../src/api/market";

function makeMinuteDay(date: string, closes: (i: number) => number, vols: (i: number) => number = () => 100): HistDayMinute {
  const y = Number(date.slice(0, 4)), mo = Number(date.slice(4, 6)) - 1, d = Number(date.slice(6, 8));
  const start = new Date(y, mo, d, 9, 30).getTime();
  const bars: KBar[] = [];
  for (let i = 0; i < 241; i++) {
    const c = closes(i);
    bars.push({ timestamp: start + i * 60000, open: c, close: c, high: c, low: c, volume: vols(i) });
  }
  return { date, bars };
}

function makeDailies(count: number, close = 10.0, low = 9.6, high = 10.4): KBar[] {
  const start = new Date(2026, 9, 12, 15, 0).getTime();
  const out: KBar[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ timestamp: start + i * 86400000, open: close, close, high, low, volume: 6_000_000 });
  }
  return out;
}

const flatDay = makeMinuteDay("20261019", () => 10.0);
const dailies = makeDailies(8);

// 信号触发日（正T）：早盘横盘 → 10:00 深跌 → 止跌回升 → 开仓
const signalCloses = (i: number) => {
  if (i < 30) return 10.0;
  if (i < 33) return 9.8 - (i - 30) * 0.01;
  if (i < 36) return 9.78 + (i - 33) * 0.05;
  return 9.9 + Math.sin(i) * 0.01;
};
const signalVols = (i: number) => (i >= 33 && i < 36 ? 500 : 100);
const signalDay = makeMinuteDay("20261019", signalCloses, signalVols);

describe("runBacktest 基础运行", () => {
  it("无信号（平盘横盘）→ 0 笔交易", () => {
    const r = runBacktest("600000", [flatDay], dailies);
    expect(r.count).toBe(0);
    expect(r.trades).toHaveLength(0);
    expect(r.sampleDays).toBe(1);
  });
  it("空输入 → 安全空转", () => {
    const r = runBacktest("600000", [], []);
    expect(r.count).toBe(0);
    expect(r.days).toHaveLength(0);
  });
});

describe("runBacktest 信号触发与平仓规则", () => {
  it("深负乖离 + 止跌拐头 → 正T开仓 → 尾盘强平", () => {
    const r = runBacktest("600000", [signalDay], dailies);
    expect(r.count).toBe(1);
    const t = r.trades[0];
    expect(t.type).toBe("long");
    expect(t.reason).toBe("force");
    expect(t.vol).toBeGreaterThanOrEqual(100);
    expect(t.vol % 100).toBe(0);
    expect(t.fee).toBeGreaterThan(0);
    expect(t.pnl).toBe(t.gross - t.fee);
    expect(r.days[0].forcedClose).toBe(true);
  });

  it("开仓后继续深跌 → 止损平仓（reason=stop）", () => {
    // 急跌→回升(不破VWAP)→缓跌（range 市况，bias 略负）→ 正T开仓 → 单边大跌破止损
    const closes = (i: number) => {
      if (i < 30) return 10.0;
      if (i < 33) return [9.8, 9.75, 9.7][i - 30];
      if (i < 37) return [9.75, 9.82, 9.88, 9.93][i - 33]; // 回升但不破 VWAP
      if (i < 45) return 9.92 - (i - 37) * 0.01;           // 缓跌，bias≈-0.4~-0.7%
      return 9.9 - (i - 45) * 0.03;                        // 单边大跌 → 破止损
    };
    const day = makeMinuteDay("20261019", closes, signalVols);
    const r = runBacktest("600000", [day], dailies);
    expect(r.count).toBe(1);
    expect(r.trades[0].type).toBe("long");
    expect(r.trades[0].reason).toBe("stop");
  });

  it("开仓后大涨 → 目标平仓（reason=target）", () => {
    const closes = (i: number) => {
      if (i < 30) return 10.0;
      if (i < 33) return [9.8, 9.75, 9.7][i - 30];
      if (i < 37) return [9.75, 9.82, 9.88, 9.93][i - 33];
      if (i < 45) return 9.92 - (i - 37) * 0.01;
      return 10.0 + (i - 45) * 0.04;                       // 单边大涨 → 达目标
    };
    const day = makeMinuteDay("20261019", closes, signalVols);
    const r = runBacktest("600000", [day], dailies);
    expect(r.count).toBe(1);
    expect(r.trades[0].type).toBe("long");
    expect(r.trades[0].reason).toBe("target");
  });
});

describe("runBacktest 熔断与统计", () => {
  it("放宽打分线后，单日开仓被 maxPerDay=2 熔断", () => {
    const p: BtParams = { ...DEFAULT_BT_PARAMS, scoreOpen: 0, confirmBars: 1 };
    const closes = (i: number) => {
      const cycle = i % 60;
      if (cycle < 30) return 10.0;
      if (cycle < 33) return 9.8;
      if (cycle < 36) return 9.85;
      return 9.95;
    };
    const vols = (i: number) => (i % 60 >= 33 && i % 60 < 36 ? 500 : 100);
    const day = makeMinuteDay("20261019", closes, vols);
    const r = runBacktest("600000", [day], dailies, p);
    expect(r.count).toBeLessThanOrEqual(2);
  });

  it("跨日汇总：胜率/盈亏比/回撤/分组字段齐备且口径自洽", () => {
    const p: BtParams = { ...DEFAULT_BT_PARAMS, scoreOpen: 0, confirmBars: 1 };
    const day1 = makeMinuteDay("20261019", (i) => (i < 33 ? 10.0 : 9.8 + (i - 33) * 0.02), (i) => (i >= 33 ? 500 : 100));
    const day2 = makeMinuteDay("20261020", (i) => (i < 33 ? 10.0 : 10.2 - (i - 33) * 0.02), (i) => (i >= 33 ? 500 : 100));
    const r = runBacktest("600000", [day1, day2], dailies, p);
    expect(r.count).toBeGreaterThanOrEqual(1);
    expect(r.totalPnl).toBe(r.trades.reduce((s, t) => s + t.pnl, 0));
    expect(r.feeTotal).toBe(r.trades.reduce((s, t) => s + t.fee, 0));
    expect(r.byHour).toHaveLength(4);
    expect(r.byHour.reduce((s, b) => s + b.count, 0)).toBe(r.count);
    expect(r.long.count + r.short.count).toBe(r.count);
    expect(r.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(r.breakEvenWinRate).toBeGreaterThanOrEqual(0);
  });
});
