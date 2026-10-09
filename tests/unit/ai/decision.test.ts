import { describe, it, expect } from "vitest";
import type { KBar } from "../../../src/api/types";
import { decide } from "../../../src/ai/decision";

function bar(close: number, volume = 1000): KBar {
  return { timestamp: 0, open: close, close, high: close + 0.05, low: close - 0.05, volume };
}
/** 温和多头 60 根，最后一根按 pct 跳升、放量 */
function uptrend(pct: number, lastVol = 2000): KBar[] {
  const base = Array.from({ length: 60 }, (_, i) => bar(10 + i * 0.05, 1000));
  const prev = base[59].close;
  base.push(bar(Number((prev * (1 + pct / 100)).toFixed(3)), lastVol));
  return base;
}

it("放量平台突破(涨6%)、大盘偏多 → BUY", () => {
  const d = decide({
    code: "600001", name: "突破股", daily: uptrend(6),
    quote: { pct: 6, volumeRatio: 2 }, marketRegime: "up",
    themeStrength: 0.8, moneyStrength: 0.8,
  });
  expect(d.setup).toBe("breakout");
  expect(d.score).toBeGreaterThanOrEqual(68);
  expect(d.action).toBe("BUY");
});

it("单日涨幅>8% 追高 → WATCH", () => {
  const d = decide({
    code: "600001", name: "追高股", daily: uptrend(9),
    quote: { pct: 9, volumeRatio: 2.5 }, marketRegime: "up",
  });
  expect(d.action).toBe("WATCH");
});

it("大盘走弱 → 只观察、不开新仓", () => {
  const d = decide({
    code: "600001", name: "X", daily: uptrend(6),
    quote: { pct: 6, volumeRatio: 2 }, marketRegime: "down",
  });
  expect(d.action).toBe("WATCH");
});

it("持有且趋势破位 → SELL", () => {
  const daily = Array.from({ length: 60 }, (_, i) => bar(20 - i * 0.05, 1000));
  const d = decide({
    code: "600001", name: "弱势股", daily,
    quote: { pct: -1 }, marketRegime: "flat", held: true,
  });
  expect(d.action).toBe("SELL");
});

it("无买点的平稳股 → WATCH", () => {
  const daily = Array.from({ length: 60 }, () => bar(10, 1000));
  const d = decide({
    code: "600001", name: "平淡股", daily,
    quote: { pct: 0, volumeRatio: 0.8 }, marketRegime: "flat",
  });
  expect(d.action).toBe("WATCH");
});
