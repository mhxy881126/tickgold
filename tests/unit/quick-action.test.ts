// @vitest-environment node
// 待处理下单方向：request 覆盖、consume 只生效一次并清空。
import { describe, it, expect, beforeEach } from "vitest";
import {
  pendingOrderSide,
  requestOrder,
  consumeOrderSide,
} from "../../src/stores/quickAction";

beforeEach(() => {
  consumeOrderSide(); // 清掉上一个用例留下的状态
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
