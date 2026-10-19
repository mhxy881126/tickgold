import { describe, it, expect } from "vitest";
import {
  calcFee,
  marketImpact,
  expectedFillPrice,
  expectedTotalCost,
  DEFAULT_SLIPPAGE,
} from "../../src/lib/cost-model";

describe("calcFee A股费用（与后端一致）", () => {
  it("买入：佣金+过户，无印花", () => {
    // 100000：佣金 25，过户 1 → 26
    expect(calcFee("buy", 100000)).toBeCloseTo(26, 6);
  });
  it("卖出：佣金+印花+过户", () => {
    // 100000：佣金 25，印花 50，过户 1 → 76
    expect(calcFee("sell", 100000)).toBeCloseTo(76, 6);
  });
  it("佣金最低5元", () => {
    // 1000：佣金 5，过户 0.01 → 5.01
    expect(calcFee("buy", 1000)).toBeCloseTo(5.01, 6);
  });
  it("金额非正返回0", () => {
    expect(calcFee("buy", 0)).toBe(0);
    expect(calcFee("sell", -1)).toBe(0);
  });
});

describe("marketImpact 市场冲击", () => {
  it("参与率为0时无冲击", () => {
    expect(marketImpact(0)).toBe(0);
  });
  it("线性+非线性项", () => {
    // participation=0.1：linear=0.1*0.1=0.01；nonlinear=0.2*0.1^1.5≈0.00632
    const v = marketImpact(0.1);
    expect(v).toBeCloseTo(0.01 + 0.2 * Math.pow(0.1, 1.5), 5);
    expect(v).toBeGreaterThan(0.01);
  });
  it("参与率越大冲击加速（非线性）", () => {
    expect(marketImpact(0.5)).toBeGreaterThan(marketImpact(0.1));
    // 大单冲击增速快于线性
    const ratio = marketImpact(0.5) / marketImpact(0.1);
    expect(ratio).toBeGreaterThan(5);
  });
  it("负参与率按0处理", () => {
    expect(marketImpact(-0.2)).toBe(0);
  });
});

describe("expectedFillPrice 预期成交价", () => {
  it("零参与率仅固定滑点", () => {
    // base 0.001
    expect(expectedFillPrice(10, "buy", 0)).toBeCloseTo(10.01, 6);
    expect(expectedFillPrice(10, "sell", 0)).toBeCloseTo(9.99, 6);
  });
  it("买入随参与率进一步抬高", () => {
    const p0 = expectedFillPrice(10, "buy", 0);
    const p1 = expectedFillPrice(10, "buy", 0.3);
    expect(p1).toBeGreaterThan(p0);
  });
  it("卖出随参与率进一步压低", () => {
    const p0 = expectedFillPrice(10, "sell", 0);
    const p1 = expectedFillPrice(10, "sell", 0.3);
    expect(p1).toBeLessThan(p0);
  });
});

describe("expectedTotalCost 单笔预期成本", () => {
  it("买入小单：费用+滑点，成交价上移", () => {
    // 参考价10，1000股，参考量1,000,000（参与率0.001）
    const r = expectedTotalCost(10, "buy", 1000, 1_000_000);
    expect(r.fillPrice).toBeGreaterThan(10);
    expect(r.slippageCost).toBeCloseTo((r.fillPrice - 10) * 1000, 4);
    expect(r.total).toBeCloseTo(r.fee + r.slippageCost, 4);
    // 费用按成交金额计算
    expect(r.fee).toBeCloseTo(calcFee("buy", r.fillPrice * 1000), 4);
  });
  it("参考量为0时参与率0、不报错", () => {
    const r = expectedTotalCost(10, "sell", 1000, 0);
    expect(r.fillPrice).toBeCloseTo(9.99, 4);
    expect(r.total).toBeGreaterThan(0);
  });
});
