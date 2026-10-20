// @vitest-environment node
// P3-b 全局选中股：select / 空白归一 / 清空，以及「选中后预填只消费一次」的联动契约。
import { describe, it, expect, beforeEach } from "vitest";
import { selectedCode, selectCode, clearSelectedCode } from "../../src/stores/selection";
import { consumeOrderPrefill, requestOrderPrefill } from "../../src/stores/quickAction";

beforeEach(() => {
  clearSelectedCode();
  consumeOrderPrefill(); // 清掉上一个用例留下的预填
});

describe("selection: 全局选中股", () => {
  it("初始未选中，消费预填为空", () => {
    expect(selectedCode.value).toBeNull();
    expect(consumeOrderPrefill()).toBeNull();
  });

  it("selectCode 写入并返回生效代码", () => {
    expect(selectCode("600519")).toBe("600519");
    expect(selectedCode.value).toBe("600519");
    // 覆盖选中：同一入口可以来回切
    expect(selectCode("300750")).toBe("300750");
    expect(selectedCode.value).toBe("300750");
  });

  it("两侧空白被归一后再选中", () => {
    selectCode("  000001  ");
    expect(selectedCode.value).toBe("000001");
  });

  it("空串 / null / undefined 清空选中", () => {
    selectCode("600519");
    expect(selectCode("   ")).toBeNull();
    expect(selectedCode.value).toBeNull();
    selectCode("600519");
    expect(selectCode(null)).toBeNull();
    expect(selectCode(undefined)).toBeNull();
    expect(selectedCode.value).toBeNull();
  });

  it("clearSelectedCode 清空选中", () => {
    selectCode("601318");
    clearSelectedCode();
    expect(selectedCode.value).toBeNull();
  });

  it("选中后预填只消费一次，且不改变选中股", () => {
    selectCode("600519");
    requestOrderPrefill({ code: "600519", side: "BUY", price: 1680 });
    expect(consumeOrderPrefill()).toEqual({ code: "600519", side: "BUY", price: 1680 });
    expect(consumeOrderPrefill()).toBeNull();
    expect(selectedCode.value).toBe("600519");
  });
});
