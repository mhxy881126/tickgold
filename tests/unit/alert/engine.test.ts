// 引擎集成：watch quotes → 评估 → 三道闸 → 动作分发（纯 node：Vue 响应式可用）
import { describe, it, expect, vi, beforeEach } from "vitest";
import { nextTick, ref, reactive } from "vue";

// ---- mock Pinia stores ----
const map = ref<Record<string, unknown>>({});
const lastUpdate = ref(0);
const rules = ref<any[]>([]);
const loaded = ref(true);
const addEvent = vi.fn(async () => {});

vi.mock("../../../src/stores/quotes", () => ({
  useQuotesStore: () => reactive({ map, lastUpdate }),
}));
vi.mock("../../../src/stores/watchlist", () => ({
  useWatchlistStore: () => ({
    codes: ["600519"],
    stocksOf: () => [{ code: "600519" }],
    nameOf: (c: string) => (c === "600519" ? "贵州茅台" : ""),
  }),
}));
vi.mock("../../../src/stores/alertV2", () => ({
  useAlertV2Store: () => reactive({ rules, loaded, addEvent }),
}));

const playAlert = vi.fn();
vi.mock("../../../src/utils/sound", () => ({
  playAlert: (...a: unknown[]) => playAlert(...a),
}));

// node 环境无 localStorage：补一个内存桩（引擎声音开关读取处依赖）
const memStore = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => memStore.get(k) ?? null,
  setItem: (k: string, v: string) => void memStore.set(k, v),
  removeItem: (k: string) => void memStore.delete(k),
  clear: () => memStore.clear(),
  key: () => null,
  length: 0,
} as Storage;

import { startAlertEngineV2 } from "../../../src/alert/useAlertEngine";
import { alertToasts, islandAlerts, registerNav } from "../../../src/alert/bus";
import type { AlertRuleV2 } from "../../../src/alert/types";
import { defaultActions } from "../../../src/alert/types";

const T0 = new Date(2026, 8, 28, 10, 0, 0).getTime();

function q(price: number, pct: number) {
  return {
    code: "600519",
    name: "贵州茅台",
    price,
    change: 0,
    pct,
    open: price,
    high: price,
    low: price,
    prevClose: 100,
    volume: 1000,
    amount: 0,
    time: T0,
    source: "tencent",
    turnover: 1,
    pe: 10,
    pb: 1,
    amplitude: 0,
    volumeRatio: 1,
    circMv: 1000,
    totalMv: 2000,
  };
}

let rid = 0;
function makeRule(partial: Partial<AlertRuleV2> = {}): AlertRuleV2 {
  return {
    id: "rule_" + rid++,
    name: "规则",
    scope: { kind: "all" },
    tree: {
      id: "n",
      op: "AND",
      children: [{ id: "l", field: "pct", op: ">=", value: 5 }],
    },
    actions: { ...defaultActions(), popup: true, sound: false },
    tone: "auto",
    frequency: "persistent",
    cooldownSec: 300,
    quiet: [],
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
    ...partial,
  };
}

async function tick(now: number, pct: number) {
  vi.spyOn(Date, "now").mockReturnValue(now); // 引擎内部用 Date.now() 取时间
  map.value = { "600519": q(100 + pct, pct) };
  lastUpdate.value = now;
  await nextTick();
  // 等待 watcher 内 async 回调（provider.refresh → addEvent）完成
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  addEvent.mockClear();
  playAlert.mockClear();
  alertToasts.value = [];
  islandAlerts.value = [];
  rules.value = [];
  lastUpdate.value = 0; // 保证各用例首次 tick(T0) 一定触发 watcher
  vi.restoreAllMocks();
  // 注意：不重置 rid——引擎 gates 为全局单例，规则 id 必须跨用例唯一，
  // 否则上一条的冷却/频控标记会污染下一条。
});

startAlertEngineV2(); // 幂等单例

describe("引擎：命中 → 落库 → 动作分发", () => {
  it("跨过阈值：写事件、弹窗、灵动岛；tone 自动按涨跌", async () => {
    rules.value = [makeRule()];
    await tick(T0, 6);

    expect(addEvent).toHaveBeenCalledTimes(1);
    const e = addEvent.mock.calls[0][0];
    expect(e.code).toBe("600519");
    expect(e.tone).toBe("up");
    expect(alertToasts.value.length).toBe(1);
    expect(islandAlerts.value.length).toBe(1);
    expect(playAlert).not.toHaveBeenCalled(); // sound 关
  });

  it("未过阈值不触发", async () => {
    rules.value = [makeRule()];
    await tick(T0, 4);
    expect(addEvent).not.toHaveBeenCalled();
    expect(alertToasts.value.length).toBe(0);
  });

  it("cooldown：同一规则冷却期内不重复轰炸", async () => {
    rules.value = [makeRule({ cooldownSec: 300 })];
    await tick(T0, 6);
    await tick(T0 + 2000, 7);
    expect(addEvent).toHaveBeenCalledTimes(1);
  });

  it("静默时段拦截", async () => {
    rules.value = [
      makeRule({ quiet: [{ start: "09:30", end: "11:30" }] }),
    ];
    await tick(T0, 6);
    expect(addEvent).not.toHaveBeenCalled();
  });

  it("tone 固定为 down 时不自动翻转", async () => {
    rules.value = [makeRule({ tone: "down" })];
    await tick(T0, 6);
    expect(addEvent.mock.calls[0][0].tone).toBe("down");
  });

  it("sound 动作：调用播放", async () => {
    rules.value = [
      makeRule({
        actions: { ...defaultActions(), sound: true, popup: false, island: false },
      }),
    ];
    await tick(T0, 6);
    expect(playAlert).toHaveBeenCalledTimes(1);
  });

  it("openChart/openBook 动作：触发导航回调", async () => {
    const pick = vi.fn();
    const book = vi.fn();
    registerNav({
      pickStock: pick,
      openOrderBook: book,
      openScreener: () => {},
    });
    rules.value = [
      makeRule({
        actions: {
          ...defaultActions(),
          popup: false,
          island: false,
          openChart: true,
          openBook: true,
        },
      }),
    ];
    await tick(T0, 6);
    expect(pick).toHaveBeenCalledWith("600519");
    expect(book).toHaveBeenCalledWith("600519");
  });

  it("无启用规则时安全空转", async () => {
    rules.value = [makeRule({ enabled: false })];
    await tick(T0, 6);
    expect(addEvent).not.toHaveBeenCalled();
  });
});
