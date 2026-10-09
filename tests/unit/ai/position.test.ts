import { describe, it, expect } from "vitest";
import { kellyFraction, halfKelly, planPosition } from "../../../src/ai/position";

describe("凯利公式", () => {
  it("p=0.6,b=2 → f=0.4，半凯利 0.2", () => {
    expect(kellyFraction(0.6, 2)).toBeCloseTo(0.4);
    expect(halfKelly(0.6, 2)).toBeCloseTo(0.2);
  });
  it("劣势期望（p=0.3）→ 0（不下注）", () => {
    expect(kellyFraction(0.3, 2)).toBe(0);
  });
  it("b<=0 安全返回 0", () => {
    expect(kellyFraction(0.9, 0)).toBe(0);
  });
});

describe("planPosition", () => {
  it("大盘偏多、高置信 → 单票≤25%，股数向下取整100", () => {
    const p = planPosition({
      code: "600001", price: 10, confidence: 0.8,
      cash: 100000, totalAssets: 100000, holdings: [], marketRegime: "up",
    });
    expect(p.targetPct).toBeCloseTo(0.25, 5);
    expect(p.vol).toBe(2500);
    expect(p.vol % 100).toBe(0);
  });
  it("大盘走弱 + 已有持仓 → 受总仓上限0.3压缩", () => {
    const p = planPosition({
      code: "600002", price: 10, confidence: 0.8,
      cash: 100000, totalAssets: 100000,
      holdings: [{ code: "600009", value: 15000 }],
      marketRegime: "down",
    });
    expect(p.targetPct).toBeLessThanOrEqual(0.15 + 1e-9);
  });
  it("现金不足 → vol=0", () => {
    const p = planPosition({
      code: "600003", price: 10, confidence: 0.8,
      cash: 500, totalAssets: 100000, holdings: [], marketRegime: "up",
    });
    expect(p.vol).toBe(0);
  });
});
