import { describe, it, expect } from "vitest";
import {
  estimateFee, roundTripFeeRate, roundTripFeeRateOfHands,
  COMMISSION_MIN, COMMISSION_RATE, STAMP_RATE, TRANSFER_RATE,
} from "../../src/utils/fees";

describe("estimateFee 与 Rust calc_fee 同口径", () => {
  it("买 10 万 = 26 元（佣金 25 + 过户 1，无印花税）", () => {
    const f = estimateFee("buy", 100_000);
    expect(f.commission).toBe(25);
    expect(f.stamp).toBe(0);
    expect(f.transfer).toBe(1);
    expect(f.total).toBe(26);
  });

  it("卖 10 万 = 76 元（佣金 25 + 印花税 50 + 过户 1）", () => {
    const f = estimateFee("sell", 100_000);
    expect(f.commission).toBe(25);
    expect(f.stamp).toBe(50);
    expect(f.transfer).toBe(1);
    expect(f.total).toBe(76);
  });

  it("小额触发最低佣金 5 元", () => {
    const f = estimateFee("buy", 10_000);
    expect(f.commission).toBe(COMMISSION_MIN); // 2.5 元 → 最低 5 元
    expect(f.total).toBeCloseTo(5.1, 5); // 5 + 0 + 0.1
  });

  it("金额非法返回 0", () => {
    expect(estimateFee("buy", 0).total).toBe(0);
  });

  it("费率常量与后端一致", () => {
    expect(COMMISSION_RATE).toBe(0.00025);
    expect(STAMP_RATE).toBe(0.0005);
    expect(TRANSFER_RATE).toBe(0.00001);
  });
});

describe("roundTripFeeRate 往返成本率", () => {
  it("1000 股 @10 元 = 0.152%（小额有最低佣金抬升）", () => {
    // amount=10000：买 5.1 + 卖 10.1 = 15.2 → 0.152%
    expect(roundTripFeeRate(1000, 10)).toBeCloseTo(0.152, 3);
  });

  it("1 万手价 3 万元 = 0.112%（大于最低佣金）", () => {
    // amount=30000：买 7.5+0.3=7.8；卖 7.5+15+0.3=22.8；合计 30.6 → 0.102%？复核：
    // 30.6/30000 = 0.00102 → 0.102%
    const rate = roundTripFeeRate(3000, 10);
    expect(rate).toBeCloseTo(30.6 / 30000 * 100, 3);
  });

  it("roundTripFeeRateOfHands 按 1 手计", () => {
    expect(roundTripFeeRateOfHands(10, 1)).toBeCloseTo(roundTripFeeRate(100, 10), 5);
  });

  it("无效输入返回 0", () => {
    expect(roundTripFeeRate(0, 10)).toBe(0);
    expect(roundTripFeeRate(100, 0)).toBe(0);
  });
});
