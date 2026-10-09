import { describe, it, expect } from "vitest";
import {
  evolveFromStats,
  loadEvolvedParams,
  saveEvolvedParams,
  resetEvolvedParams,
  DEFAULT_BUY_THRESHOLD,
  type StatGroup,
} from "../../../src/ai/evolve";
import { installBrowserGlobals } from "../helpers/browser-globals";

function group(over: Partial<StatGroup>): StatGroup {
  return {
    samples: 20, good: 14, bad: 6, winRate: 70,
    profitFactor: 1.8, expectancy: 0.5, falsePositive: 2, sellTooEarly: 1,
    ...over,
  };
}

describe("evolveFromStats", () => {
  it("高胜率、正期望 → 门槛降、仓位×1.1", () => {
    const p = evolveFromStats({ groups: [group({})], totalLabels: 20 });
    expect(p.samples).toBe(20);
    expect(p.buyThreshold).toBe(DEFAULT_BUY_THRESHOLD - 3); // 65
    expect(p.confidenceScale).toBe(1.1);
  });

  it("低胜率、误报多、负期望 → 门槛升、仓位×0.8", () => {
    const p = evolveFromStats({
      groups: [group({ good: 6, bad: 14, winRate: 30, profitFactor: 0.6, expectancy: -0.4, falsePositive: 8 })],
      totalLabels: 20,
    });
    expect(p.buyThreshold).toBe(DEFAULT_BUY_THRESHOLD + 5); // 73
    expect(p.confidenceScale).toBe(0.8);
  });

  it("样本不足 8 → 维持默认，不过拟合", () => {
    const p = evolveFromStats({ groups: [group({ samples: 3, good: 2, bad: 1 })], totalLabels: 3 });
    expect(p.buyThreshold).toBe(DEFAULT_BUY_THRESHOLD);
    expect(p.confidenceScale).toBe(1);
  });

  it("权重归一化到总和≈100，且每项在 4–40", () => {
    const p = evolveFromStats({ groups: [group({})], totalLabels: 20 });
    const sum = Object.values(p.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(100, 0);
    Object.values(p.weights).forEach((w) => {
      expect(w).toBeGreaterThanOrEqual(4);
      expect(w).toBeLessThanOrEqual(40);
    });
  });
});

describe("持久化", () => {
  it("save → load 还原，reset 回默认", () => {
    installBrowserGlobals();
    const p = evolveFromStats({ groups: [group({})], totalLabels: 20 });
    saveEvolvedParams(p);
    expect(loadEvolvedParams().buyThreshold).toBe(65);
    const r = resetEvolvedParams();
    expect(r.buyThreshold).toBe(DEFAULT_BUY_THRESHOLD);
  });
});
