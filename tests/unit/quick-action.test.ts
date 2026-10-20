// @vitest-environment node
// 待处理下单方向 / 预填：request 覆盖、consume 只生效一次并清空。
import { describe, it, expect, beforeEach } from "vitest";
import {
  pendingOrderSide,
  pendingOrderPrefill,
  pendingPrice,
  requestOrder,
  consumeOrderSide,
  requestOrderPrefill,
  consumeOrderPrefill,
} from "../../src/stores/quickAction";

beforeEach(() => {
  consumeOrderSide(); // 清掉上一个用例留下的状态
  consumeOrderPrefill();
});

describe("quickAction: 待处理下单方向", () => {
  it("初始为空", () => {
    expect(pendingOrderSide.value).toBeNull();
    expect(consumeOrderSide()).toBeNull();
  });

  it("request 后 consume 返回方向并清空", () => {
    requestOrder("BUY");
    expect(pendingOrderSide.value).toBe("BUY");
    expect(consumeOrderSide()).toBe("BUY");
    expect(pendingOrderSide.value).toBeNull();
  });

  it("只能消费一次：第二次返回 null", () => {
    requestOrder("SELL");
    expect(consumeOrderSide()).toBe("SELL");
    expect(consumeOrderSide()).toBeNull();
  });

  it("连续 request 以最后一次为准", () => {
    requestOrder("BUY");
    requestOrder("SELL");
    expect(consumeOrderSide()).toBe("SELL");
  });
});

describe("quickAction: 下单条预填（P3-b）", () => {
  it("初始为空", () => {
    expect(pendingOrderPrefill.value).toBeNull();
    expect(pendingPrice.value).toBeNull();
    expect(consumeOrderPrefill()).toBeNull();
  });

  it("request 后保留代码/方向/价格，consume 一次即清空", () => {
    requestOrderPrefill({ code: "600519", side: "SELL", price: 1701.5 });
    expect(pendingPrice.value).toBe(1701.5);
    expect(pendingOrderPrefill.value).toEqual({
      code: "600519",
      side: "SELL",
      price: 1701.5,
    });

    expect(consumeOrderPrefill()).toEqual({
      code: "600519",
      side: "SELL",
      price: 1701.5,
    });
    expect(pendingOrderPrefill.value).toBeNull();
    expect(pendingPrice.value).toBeNull();
    expect(consumeOrderPrefill()).toBeNull();
  });

  it("side 缺省表示沿用当前方向：预填里不出现 side", () => {
    requestOrderPrefill({ code: "000001", price: 12.34 });
    const p = consumeOrderPrefill();
    expect(p).not.toBeNull();
    expect(p?.code).toBe("000001");
    expect(p?.price).toBe(12.34);
    expect(p && "side" in p).toBe(false);
  });

  it("代码归一：两侧空白被去掉", () => {
    requestOrderPrefill({ code: "  300750  ", price: 200 });
    expect(consumeOrderPrefill()).toEqual({ code: "300750", price: 200 });
  });

  it("连续 request 以最后一次为准", () => {
    requestOrderPrefill({ code: "600519", side: "BUY", price: 1680 });
    requestOrderPrefill({ code: "300750", side: "SELL", price: 210 });
    expect(consumeOrderPrefill()).toEqual({ code: "300750", side: "SELL", price: 210 });
  });

  it("非法输入直接忽略：空代码 / 非正价格 / NaN", () => {
    requestOrderPrefill({ code: "", price: 1680 });
    requestOrderPrefill({ code: "600519", price: 0 });
    requestOrderPrefill({ code: "600519", price: -1 });
    requestOrderPrefill({ code: "600519", price: Number.NaN });
    expect(pendingOrderPrefill.value).toBeNull();
    expect(pendingPrice.value).toBeNull();
  });
});
