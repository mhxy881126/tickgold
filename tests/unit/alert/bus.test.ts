import { describe, it, expect, beforeEach } from "vitest";
import {
  alertToasts,
  pushToast,
  dismissToast,
  islandAlerts,
  pushIsland,
  registerNav,
  navPickStock,
  navOpenOrderBook,
  navOpenScreener,
} from "../../../src/alert/bus";

function toast(i: number) {
  return {
    key: `k${i}`,
    title: "t",
    body: "b",
    code: "600519",
    tone: "up",
    at: i,
  };
}
function island(i: number) {
  return {
    id: `k${i}`,
    code: "600519",
    name: "贵州茅台",
    label: "规则",
    message: "m",
    price: 100,
    pct: 5,
    tone: "up",
    at: i,
  };
}

beforeEach(() => {
  alertToasts.value = [];
  islandAlerts.value = [];
});

describe("toast 队列", () => {
  it("最新在前", () => {
    pushToast(toast(1));
    pushToast(toast(2));
    expect(alertToasts.value.map((t) => t.key)).toEqual(["k2", "k1"]);
  });
  it("最多 5 条，丢弃最旧", () => {
    for (let i = 0; i < 7; i++) pushToast(toast(i));
    expect(alertToasts.value.length).toBe(5);
    expect(alertToasts.value[4].key).toBe("k2");
  });
  it("按 key 关闭", () => {
    pushToast(toast(1));
    pushToast(toast(2));
    dismissToast("k1");
    expect(alertToasts.value.map((t) => t.key)).toEqual(["k2"]);
  });
});

describe("island 队列", () => {
  it("最多 20 条", () => {
    for (let i = 0; i < 25; i++) pushIsland(island(i));
    expect(islandAlerts.value.length).toBe(20);
    expect(islandAlerts.value[0].id).toBe("k24");
  });
});

describe("导航", () => {
  it("未注册时安全空转", () => {
    expect(() => {
      navPickStock("600519");
      navOpenOrderBook("600519");
      navOpenScreener();
    }).not.toThrow();
  });
  it("注册后回调到 App", () => {
    const calls: string[] = [];
    registerNav({
      pickStock: (c) => calls.push("pick:" + c),
      openOrderBook: (c) => calls.push("book:" + c),
      openScreener: () => calls.push("screener"),
    });
    navPickStock("600519");
    navOpenOrderBook("600519");
    navOpenScreener();
    expect(calls).toEqual(["pick:600519", "book:600519", "screener"]);
  });
});
