import { describe, it, expect } from "vitest";
import { ma, ema, macd, kdj, rsi } from "../../../src/utils/indicators";
import type { KBar } from "../../../src/api/types";

describe("ma 简单移动平均", () => {
  it("窗口内算术平均", () => {
    expect(ma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(ma([1, 2, 3, 4, 5], 3)).toBe(4);
  });
  it("数据不足返回 null", () => {
    expect(ma([1, 2], 3)).toBeNull();
  });
});

describe("ema 指数移动平均", () => {
  it("单点等于自身", () => {
    expect(ema([10], 3)).toBe(10);
  });
  it("数据为空返回 null", () => {
    expect(ema([], 3)).toBeNull();
  });
  it("收敛到常数序列", () => {
    expect(ema([5, 5, 5, 5], 3)).toBeCloseTo(5);
  });
});

describe("macd", () => {
  it("常数序列 DIF/DEA/MACD 均为 0", () => {
    const r = macd([8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8]);
    expect(r).not.toBeNull();
    expect(r!.dif).toBeCloseTo(0, 6);
    expect(r!.dea).toBeCloseTo(0, 6);
    expect(r!.macd).toBeCloseTo(0, 6);
  });
  it("数据不足返回 null", () => {
    expect(macd([1, 2], 12, 26, 9)).toBeNull();
  });
});

describe("kdj", () => {
  function bar(c: number, h = c, l = c): KBar {
    return { timestamp: 0, open: c, close: c, high: h, low: l, volume: 0 };
  }
 it("持续最高价收盘 K 收敛到 100", () => {
    const bars = Array.from({ length: 20 }, () => bar(20, 20, 5));
    const r = kdj(bars, 9);
    expect(r).not.toBeNull();
    expect(r!.k).toBeCloseTo(100, 1);
    expect(r!.j).toBeGreaterThan(r!.k);
  });
  it("空数组返回 null", () => {
    expect(kdj([])).toBeNull();
  });
});

describe("rsi", () => {
  it("持续上涨 RSI=100", () => {
    const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    expect(rsi(closes, 14)).toBe(100);
  });
  it("数据不足返回 null", () => {
    expect(rsi([1, 2], 14)).toBeNull();
  });
  it("涨跌相等 RSI=50", () => {
    // 构造涨、跌各 7 次且幅度相同
    const closes = [100];
    for (let i = 0; i < 7; i++) closes.push(closes[closes.length - 1] + 2);
    for (let i = 0; i < 7; i++) closes.push(closes[closes.length - 1] - 2);
    expect(rsi(closes, 14)).toBeCloseTo(50, 6);
  });
});
