import { describe, it, expect } from "vitest";
import type { KBar } from "../../../src/api/types";
import {
  sma, ema, macd, kdj, rsi, trendOf, detectSetup, technicalHealth, regimeOfIndex,
} from "../../../src/ai/indicators";

function bar(close: number, volume = 1000): KBar {
  return { timestamp: 0, open: close, close, high: close + 0.05, low: close - 0.05, volume };
}

describe("sma / ema", () => {
  it("sma 已知值，前 p-1 为 NaN", () => {
    const r = sma([1, 2, 3, 4, 5], 3);
    expect(r[4]).toBeCloseTo(4);
    expect(r[2]).toBeCloseTo(2);
    expect(r[1]).toBeNaN();
  });
  it("ema 等长且尾部有效", () => {
    const r = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
    expect(r).toHaveLength(10);
    expect(r[9]).toBeGreaterThan(r[2]);
  });
});

describe("macd / kdj / rsi", () => {
  const closes = Array.from({ length: 40 }, (_, i) => 10 + i * 0.2);
  it("macd 等长，上涨序列 dif>0", () => {
    const m = macd(closes);
    expect(m).toHaveLength(40);
    expect(m[39].dif).toBeGreaterThan(0);
  });
  it("kdj 输出 k/d/j", () => {
    const k = kdj(closes.map((c) => bar(c)));
    expect(k[39].j).toBeGreaterThan(-200);
  });
  it("rsi 上涨序列偏高", () => {
    const r = rsi(closes);
    expect(r[39]).toBeGreaterThan(60);
  });
});

describe("trendOf", () => {
  it("严格递增 → 多头排列、direction up", () => {
    const t = trendOf(Array.from({ length: 60 }, (_, i) => bar(10 + i * 0.5)));
    expect(t.bullAlign).toBe(true);
    expect(t.direction).toBe("up");
    expect(t.aboveMa20).toBe(true);
  });
  it("严格递减 → direction down", () => {
    const t = trendOf(Array.from({ length: 60 }, (_, i) => bar(100 - i * 0.5)));
    expect(t.direction).toBe("down");
    expect(t.bullAlign).toBe(false);
  });
});

describe("detectSetup", () => {
  it("放量创20日新高 → breakout", () => {
    const bars = [
      ...Array.from({ length: 25 }, () => bar(10, 1000)),
      bar(11, 2000),
    ];
    const s = detectSetup(bars, 2);
    expect(s.setup).toBe("breakout");
    expect(s.quality).toBeGreaterThan(0.8);
  });
  it("平稳无缩量 → none", () => {
    const s = detectSetup(Array.from({ length: 26 }, () => bar(10, 1000)), 1);
    expect(s.setup).toBe("none");
  });
  it("K线不足 → none", () => {
    expect(detectSetup([bar(10), bar(11)]).setup).toBe("none");
  });
});

describe("technicalHealth / regimeOfIndex", () => {
  it("多头序列健康度高", () => {
    expect(technicalHealth(Array.from({ length: 60 }, (_, i) => bar(10 + i * 0.3))).score).toBeGreaterThan(70);
  });
  it("regime：递增 up、递减 down、平稳 flat", () => {
    expect(regimeOfIndex(Array.from({ length: 60 }, (_, i) => bar(10 + i * 0.2)))).toBe("up");
    expect(regimeOfIndex(Array.from({ length: 60 }, (_, i) => bar(100 - i * 0.2)))).toBe("down");
    expect(regimeOfIndex(Array.from({ length: 60 }, () => bar(10, 1000)))).toBe("flat");
  });
});
