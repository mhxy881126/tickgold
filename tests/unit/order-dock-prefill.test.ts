// @vitest-environment jsdom
// P3-b：OrderDock.applyPrefill 填代码/方向/价格并聚焦价格框；
// 省略 side 时沿用当前方向；确认弹窗打开时忽略预填；setCode / focusSide 保持不变。
import { describe, it, expect, vi, afterEach } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../../src/api/market", () => ({
  fetchOrderBook: vi.fn(async (code: string) => ({
    code,
    name: code === "600519" ? "贵州茅台" : "平安银行",
    price: 1700,
    prevClose: 1660,
    open: 1665,
    high: 1690,
    low: 1660,
    volume: 12000,
    amount: 2e9,
    asks: [],
    bids: [],
    bidTotal: 0,
    askTotal: 0,
    weiBi: 0,
    weiCha: 0,
    insideVol: 0,
    outsideVol: 0,
  })),
}));

import OrderDock from "../../src/components/battle/OrderDock.vue";

const STATUS = {
  kind: "mock",
  liveEnabled: false,
  connected: true,
  killSwitch: false,
  accountId: "SIM",
  clientSim: true,
  windowSim: true,
};

type DockVm = {
  applyPrefill: (p: { code: string; side?: "BUY" | "SELL"; price: number }) => void;
  setCode: (c: string) => void;
  focusSide: (s: "BUY" | "SELL") => void;
};

let wrapper: VueWrapper | null = null;

function mountDock(): { w: VueWrapper; vm: DockVm } {
  const pinia = createPinia();
  setActivePinia(pinia);
  const w = mount(OrderDock, {
    props: { status: STATUS as never, cash: 100_000 },
    global: { plugins: [pinia] },
    attachTo: document.body,
  });
  wrapper = w;
  return { w, vm: w.vm as unknown as DockVm };
}

const inputValue = (w: VueWrapper, testid: string) =>
  (w.get(`[data-testid="${testid}"]`).element as HTMLInputElement).value;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = "";
});

describe("OrderDock.applyPrefill（P3-b）", () => {
  it("填代码/方向/价格并聚焦价格框", async () => {
    const { w, vm } = mountDock();
    vm.applyPrefill({ code: "600519", side: "SELL", price: 1701.5 });
    await flushPromises();

    expect(inputValue(w, "order-code")).toBe("600519");
    expect(inputValue(w, "order-price")).toBe("1701.5");
    expect(w.get('[data-testid="order-sell"]').classes()).toContain("active");
    expect(w.get('[data-testid="order-buy"]').classes()).not.toContain("active");
    expect(document.activeElement).toBe(w.get('[data-testid="order-price"]').element);
  });

  it("省略 side 时沿用当前方向", async () => {
    const { w, vm } = mountDock();
    vm.applyPrefill({ code: "600519", side: "SELL", price: 1701.5 });
    await flushPromises();

    vm.applyPrefill({ code: "000001", price: 12.34 });
    await flushPromises();

    expect(inputValue(w, "order-code")).toBe("000001");
    expect(inputValue(w, "order-price")).toBe("12.34");
    // 方向没有被缺省预填改回 BUY
    expect(w.get('[data-testid="order-sell"]').classes()).toContain("active");
  });

  it("确认弹窗打开时忽略预填（方向/价格已冻结）", async () => {
    const { w, vm } = mountDock();
    await w.get('[data-testid="order-buy"]').trigger("click");
    expect(w.find('[data-testid="order-confirm"]').exists()).toBe(true);
    const before = inputValue(w, "order-price");

    vm.applyPrefill({ code: "600519", side: "SELL", price: 1701.5 });
    await nextTick();
    await flushPromises();

    expect(inputValue(w, "order-price")).toBe(before);
    expect(w.get('[data-testid="order-buy"]').classes()).toContain("active");
  });

  it("保留 setCode / focusSide：填代码与聚焦代码框", async () => {
    const { w, vm } = mountDock();
    vm.setCode("600519");
    await flushPromises();
    expect(inputValue(w, "order-code")).toBe("600519");

    vm.focusSide("SELL");
    await nextTick();
    expect(w.get('[data-testid="order-sell"]').classes()).toContain("active");
    expect(document.activeElement).toBe(w.get('[data-testid="order-code"]').element);
  });
});
