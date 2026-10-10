import { describe, expect, it } from "vitest";
import {
  CARD_REGISTRY,
  getCapability,
  isStockCode,
  tradingTourCards,
  reviewTourCards,
  cardsByGroup,
} from "../../../src/components/spider/cardRegistry";

describe("cardRegistry", () => {
  it("注册全部 40 张卡，且每张 title 非空", () => {
    const ids = Object.keys(CARD_REGISTRY);
    expect(ids.length).toBe(40);
    ids.forEach((id) => {
      expect(CARD_REGISTRY[id as keyof typeof CARD_REGISTRY].title).toBeTruthy();
    });
  });

  it("isStockCode：6 位数字为真，伪 code / 空 / 位数不对为假", () => {
    expect(isStockCode("601123")).toBe(true);
    expect(isStockCode("000001")).toBe(true);
    expect(isStockCode("sector:传媒")).toBe(false);
    expect(isStockCode("index:上证指数")).toBe(false);
    expect(isStockCode("")).toBe(false);
    expect(isStockCode(undefined)).toBe(false);
    expect(isStockCode("60112")).toBe(false);
  });

  it("getCapability 返回能力与标题，异常输入返回 undefined", () => {
    expect(getCapability("watch")?.title).toBe("自选股");
    expect(getCapability("nope")).toBeUndefined();
    expect(getCapability(null)).toBeUndefined();
  });

  it("交易巡回含数据源卡、不含复盘卡 / spiderbot", () => {
    const tour = tradingTourCards();
    expect(tour).toContain("watch");
    expect(tour).not.toContain("review");
    expect(tour).not.toContain("spiderbot"); // onTour=false
  });

  it("盘后巡回含复盘进化卡、不含交易时段卡", () => {
    const r = reviewTourCards();
    expect(r).toContain("review");
    expect(r).toContain("evolution");
    expect(r).not.toContain("watch");
  });

  it("cardsByGroup 只返回该分组且 onTour 的卡", () => {
    const env = cardsByGroup("env");
    expect(env).toContain("auction");
    env.forEach((id) => expect(CARD_REGISTRY[id].group).toBe("env"));
  });
});
