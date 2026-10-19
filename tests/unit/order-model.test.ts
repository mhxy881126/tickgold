import { describe, expect, it } from "vitest";
import {
  boardRatio,
  canSubmitQuickOrder,
  limitPrices,
  positionVolume,
} from "../../src/components/battle/orderModel";

describe("orderModel", () => {
  it("涨跌停按板块：主板 10%，创业板/科创板 20%", () => {
    expect(boardRatio("600519")).toBe(1.1);
    expect(boardRatio("300750")).toBe(1.2);
    expect(boardRatio("688981")).toBe(1.2);
    expect(limitPrices("600519", 100)).toEqual({ up: 110, down: 90 });
    expect(limitPrices("300750", 100)).toEqual({ up: 120, down: 80 });
    expect(limitPrices("600519", 0)).toEqual({ up: 0, down: 0 });
  });

  it("仓位档换算手数（向下取整到 100 股）", () => {
    expect(positionVolume(1_000_000, 2, 10)).toBe(50_000);
    expect(positionVolume(100_000, 4, 10)).toBe(2_500);
    expect(positionVolume(100, 2, 10)).toBe(0);
    expect(positionVolume(1_000_000, 3, 33)).toBe(10_100);
  });

  it("提交校验：代码 / 价格 / 数量 / 熔断", () => {
    expect(canSubmitQuickOrder({ code: "600519", price: 10, vol: 100, blocked: false })).toBe(true);
    expect(canSubmitQuickOrder({ code: "60051", price: 10, vol: 100, blocked: false })).toBe(false);
    expect(canSubmitQuickOrder({ code: "600519", price: 0, vol: 100, blocked: false })).toBe(false);
    expect(canSubmitQuickOrder({ code: "600519", price: 10, vol: 0, blocked: false })).toBe(false);
    expect(canSubmitQuickOrder({ code: "600519", price: 10, vol: 100, blocked: true })).toBe(false);
  });
});
