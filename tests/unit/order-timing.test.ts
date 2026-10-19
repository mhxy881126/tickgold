import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ORDER_TIMING_KEY,
  ORDER_TIMING_MAX,
  clearOrderTimings,
  formatMs,
  orderTimingSummary,
  recordOrderTiming,
} from "../../src/broker/timing";

/** 最小 localStorage 替身：Node 环境没有 localStorage，单测按需注入。 */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  const store = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: store as unknown as Storage,
  });
  return map;
}

function installBrokenStorage() {
  const fail = () => {
    throw new Error("storage denied");
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      length: 0,
      clear: fail,
      getItem: fail,
      key: fail,
      removeItem: fail,
      setItem: fail,
    } as unknown as Storage,
  });
}

function removeStorage() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: undefined,
  });
}

beforeEach(() => {
  installStorage();
  clearOrderTimings();
});

afterAll(() => {
  removeStorage();
});

describe("orderTimingSummary / recordOrderTiming", () => {
  it("空态返回 null", () => {
    expect(orderTimingSummary()).toBeNull();
  });

  it("记录一笔后返回最近耗时、中位数、点击与样本数", () => {
    recordOrderTiming({ ms: 1200, clicks: 2, ok: true, at: 1_000 });
    expect(orderTimingSummary()).toEqual({
      lastMs: 1200,
      medianMs: 1200,
      clicks: 2,
      count: 1,
    });
  });

  it("中位数奇数取中间，偶数取两数平均", () => {
    recordOrderTiming({ ms: 300, clicks: 2, ok: true, at: 1 });
    recordOrderTiming({ ms: 100, clicks: 2, ok: true, at: 2 });
    recordOrderTiming({ ms: 200, clicks: 2, ok: true, at: 3 });
    expect(orderTimingSummary()).toEqual({
      lastMs: 200,
      medianMs: 200,
      clicks: 2,
      count: 3,
    });

    recordOrderTiming({ ms: 400, clicks: 2, ok: true, at: 4 });
    // 100/200/300/400 → 中位 (200+300)/2
    expect(orderTimingSummary()?.medianMs).toBe(250);
    expect(orderTimingSummary()?.lastMs).toBe(400);
  });

  it("环形只保留最近 20 条并丢弃最旧", () => {
    for (let i = 1; i <= 25; i++) {
      recordOrderTiming({ ms: i * 10, clicks: 2, ok: true, at: i });
    }
    const raw = JSON.parse(localStorage.getItem(ORDER_TIMING_KEY)!) as { ms: number }[];
    expect(raw).toHaveLength(ORDER_TIMING_MAX);
    expect(raw[0].ms).toBe(60);
    expect(raw[19].ms).toBe(250);
    // 保留 60..250，共 20 条：中位 = (150+160)/2
    expect(orderTimingSummary()).toEqual({
      lastMs: 250,
      medianMs: 155,
      clicks: 2,
      count: 20,
    });
  });

  it("失败样本（ok:false）也记录并参与统计", () => {
    recordOrderTiming({ ms: 500, clicks: 2, ok: true, at: 1 });
    recordOrderTiming({ ms: 1500, clicks: 2, ok: false, at: 2 });
    expect(orderTimingSummary()).toEqual({
      lastMs: 1500,
      medianMs: 1000,
      clicks: 2,
      count: 2,
    });
  });

  it("最近一笔的点击数写入汇总", () => {
    recordOrderTiming({ ms: 100, clicks: 2, ok: true, at: 1 });
    recordOrderTiming({ ms: 200, clicks: 3, ok: true, at: 2 });
    expect(orderTimingSummary()?.clicks).toBe(3);
    expect(orderTimingSummary()?.count).toBe(2);
  });

  it("非法 ms / clicks 不写入", () => {
    recordOrderTiming({ ms: Number.NaN, clicks: 2, ok: true });
    recordOrderTiming({ ms: -1, clicks: 2, ok: true });
    recordOrderTiming({ ms: Number.POSITIVE_INFINITY, clicks: 2, ok: true });
    recordOrderTiming({ ms: 100, clicks: 0, ok: true });
    recordOrderTiming({ ms: 100, clicks: Number.NaN, ok: true });
    expect(orderTimingSummary()).toBeNull();
  });

  it("at 缺省 / 非法时回退当前时间", () => {
    const before = Date.now();
    recordOrderTiming({ ms: 100, clicks: 2, ok: true });
    recordOrderTiming({ ms: 200, clicks: 2, ok: true, at: Number.NaN });
    const raw = JSON.parse(localStorage.getItem(ORDER_TIMING_KEY)!) as { at: number }[];
    expect(raw).toHaveLength(2);
    expect(raw[0].at).toBeGreaterThanOrEqual(before);
    expect(raw[1].at).toBeGreaterThanOrEqual(before);
    expect(Number.isFinite(raw[1].at)).toBe(true);
  });

  it("损坏 JSON / 非法条目被丢弃，后续记录可恢复", () => {
    localStorage.setItem(ORDER_TIMING_KEY, "{not json");
    expect(orderTimingSummary()).toBeNull();

    localStorage.setItem(
      ORDER_TIMING_KEY,
      JSON.stringify([{ ms: "bad" }, { clicks: 2 }, null, { ms: 100, clicks: 2, ok: true, at: 1 }]),
    );
    expect(orderTimingSummary()).toEqual({
      lastMs: 100,
      medianMs: 100,
      clicks: 2,
      count: 1,
    });

    recordOrderTiming({ ms: 500, clicks: 2, ok: true, at: 2 });
    expect(orderTimingSummary()?.count).toBe(2);
  });

  it("localStorage 不存在时静默降级", () => {
    removeStorage();
    expect(() => recordOrderTiming({ ms: 100, clicks: 2, ok: true })).not.toThrow();
    expect(orderTimingSummary()).toBeNull();
    expect(() => clearOrderTimings()).not.toThrow();
  });

  it("localStorage 读写抛错时静默降级", () => {
    installBrokenStorage();
    expect(() => recordOrderTiming({ ms: 100, clicks: 2, ok: true })).not.toThrow();
    expect(orderTimingSummary()).toBeNull();
    expect(() => clearOrderTimings()).not.toThrow();
  });

  it("clearOrderTimings 清空记录", () => {
    recordOrderTiming({ ms: 100, clicks: 2, ok: true, at: 1 });
    expect(orderTimingSummary()).not.toBeNull();
    clearOrderTimings();
    expect(orderTimingSummary()).toBeNull();
    expect(localStorage.getItem(ORDER_TIMING_KEY)).toBeNull();
  });
});

describe("formatMs", () => {
  it("毫秒级不换算", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(1)).toBe("1ms");
    expect(formatMs(850)).toBe("850ms");
    expect(formatMs(999)).toBe("999ms");
  });

  it("秒级保留一位小数", () => {
    expect(formatMs(1000)).toBe("1.0s");
    expect(formatMs(1200)).toBe("1.2s");
    expect(formatMs(1500)).toBe("1.5s");
    expect(formatMs(12_345)).toBe("12.3s");
  });

  it("非法值返回占位符", () => {
    expect(formatMs(-1)).toBe("—");
    expect(formatMs(Number.NaN)).toBe("—");
    expect(formatMs(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("环形容量常量为 20", () => {
    expect(ORDER_TIMING_MAX).toBe(20);
    expect(ORDER_TIMING_KEY).toBe("tickgold_order_timing");
  });
});
