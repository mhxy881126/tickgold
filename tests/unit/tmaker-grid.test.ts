import { describe, expect, it } from "vitest";
import { gridGapPct, gridPlanLong, gridPlanShort } from "../../src/composables/tmaker/grid";

describe("gridGapPct", () => {
  it("0.5×ATR%，0.3-1.5 区间内线性", () => {
    expect(gridGapPct(1.0)).toBeCloseTo(0.5, 10);
    expect(gridGapPct(2.0)).toBeCloseTo(1.0, 10);
  });
  it("ATR 过小钳制到 0.3", () => {
    expect(gridGapPct(0.1)).toBeCloseTo(0.3, 10);
  });
  it("ATR 过大钳制到 1.5", () => {
    expect(gridGapPct(5.0)).toBeCloseTo(1.5, 10);
  });
});

describe("gridPlanLong 正T网格", () => {
  const price = 10.0;
  const atrPct = 1.0; // gap = 0.5%
  const vol = 900; // 每档 300

  it("3 档等分，价格按 0.5% 间距向下", () => {
    const plan = gridPlanLong(price, 9.0, atrPct, vol);
    expect(plan.count).toBe(3);
    expect(plan.totalVol).toBe(900);
    expect(plan.truncated).toBe(false);
    expect(plan.levels[0].price).toBeCloseTo(9.95, 2);
    expect(plan.levels[1].price).toBeCloseTo(9.9, 2);
    expect(plan.levels[2].price).toBeCloseTo(9.85, 2);
    expect(plan.levels.every((l) => l.vol === 300)).toBe(true);
  });

  it("触及支撑自动截断（不挂破位单）", () => {
    const plan = gridPlanLong(price, 9.88, atrPct, vol);
    expect(plan.count).toBe(2);
    expect(plan.truncated).toBe(true);
    expect(plan.levels[0].price).toBeCloseTo(9.95, 2);
    expect(plan.levels[1].price).toBeCloseTo(9.9, 2);
  });

  it("数量不足一手返回空", () => {
    const plan = gridPlanLong(price, 9.0, atrPct, 50);
    expect(plan.count).toBe(0);
    expect(plan.totalVol).toBe(0);
  });

  it("总量按 100 股整数倍均分", () => {
    const plan = gridPlanLong(price, 9.0, atrPct, 1000); // 1000/3 → 300×3=900
    expect(plan.totalVol).toBe(900);
    expect(plan.levels[0].vol).toBe(300);
  });

  it("非法输入返回空", () => {
    expect(gridPlanLong(0, 9, 1, 300).count).toBe(0);
    expect(gridPlanLong(-1, 9, 1, 300).count).toBe(0);
  });
});

describe("gridPlanShort 倒T网格", () => {
  const price = 10.0;
  const atrPct = 1.0;
  const vol = 900;

  it("3 档等分，价格按 0.5% 间距向上", () => {
    const plan = gridPlanShort(price, 11.0, atrPct, vol);
    expect(plan.count).toBe(3);
    expect(plan.levels[0].price).toBeCloseTo(10.05, 2);
    expect(plan.levels[1].price).toBeCloseTo(10.1, 2);
    expect(plan.levels[2].price).toBeCloseTo(10.15, 2);
  });

  it("触及压力自动截断（不挂追高单）", () => {
    const plan = gridPlanShort(price, 10.08, atrPct, vol);
    expect(plan.count).toBe(1);
    expect(plan.truncated).toBe(true);
    expect(plan.levels[0].price).toBeCloseTo(10.05, 2);
  });

  it("数量不足一手返回空", () => {
    const plan = gridPlanShort(price, 11.0, atrPct, 99);
    expect(plan.count).toBe(0);
  });

  it("价格 round2 取整（非整分价格）", () => {
    const plan = gridPlanShort(10.07, 12.0, 0.9, 300); // gap 0.45% → 10.1153 → 10.12
    expect(plan.levels[0].price).toBeCloseTo(10.12, 2);
  });
});
