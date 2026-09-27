import { describe, it, expect, vi, beforeEach } from "vitest";

// 必须在 import context 前 mock 数据 API
const fetchKLine = vi.fn();
const fetchOrderBook = vi.fn();
const fetchAuction = vi.fn();
vi.mock("../../../src/api/market", () => ({
  fetchKLine: (...a: unknown[]) => fetchKLine(...a),
  fetchOrderBook: (...a: unknown[]) => fetchOrderBook(...a),
  fetchAuction: (...a: unknown[]) => fetchAuction(...a),
}));

import {
  ContextProvider,
  expandScope,
  collectLeaves,
} from "../../../src/alert/context";
import type { AlertRuleV2, Leaf, TreeNode } from "../../../src/alert/types";
import { defaultActions } from "../../../src/alert/types";
import type { Quote } from "../../../src/api/types";

const T0 = new Date(2026, 8, 28, 10, 0, 0).getTime(); // 周一 10:00

function quote(over: Partial<Quote> = {}): Quote {
  return {
    code: "600519",
    name: "贵州茅台",
    price: 100,
    change: 0,
    pct: 0,
    open: 100,
    high: 100,
    low: 100,
    prevClose: 100,
    volume: 1000,
    amount: 0,
    time: T0,
    source: "tencent",
    turnover: 0,
    pe: 10,
    pb: 1,
    amplitude: 0,
    volumeRatio: 1,
    circMv: 1000,
    totalMv: 2000,
    ...over,
  };
}

function rule(tree: TreeNode, scope: AlertRuleV2["scope"] = { kind: "all" }): AlertRuleV2 {
  return {
    id: "r1",
    name: "规则",
    scope,
    tree,
    actions: defaultActions(),
    tone: "auto",
    frequency: "persistent",
    cooldownSec: 300,
    quiet: [],
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
  };
}
const lf = (
  field: string,
  op: Leaf["op"],
  value: number,
  params?: Record<string, number>
): Leaf => ({ id: field + value, field, op, value, params });
const node = (op: "AND" | "OR", children: TreeNode["children"]): TreeNode => ({
  id: "n" + Math.random(),
  op,
  children,
});

beforeEach(() => {
  fetchKLine.mockReset();
  fetchOrderBook.mockReset();
  fetchAuction.mockReset();
});

describe("expandScope", () => {
  it("三种作用域", () => {
    expect(expandScope({ kind: "code", code: "C1" }, ["A"], () => []))
      .toEqual(["C1"]);
    expect(expandScope({ kind: "group", groupId: 3 }, ["A"], (g) =>
      g === 3 ? ["G1", "G2"] : []
    )).toEqual(["G1", "G2"]);
    expect(expandScope({ kind: "all" }, ["A", "B"], () => []))
      .toEqual(["A", "B"]);
  });
});

describe("collectLeaves", () => {
  it("递归收集", () => {
    const r = rule(
      node("AND", [
        lf("pct", ">=", 1),
        node("OR", [lf("pct", ">=", 2), lf("pct", ">=", 3)]),
      ])
    );
    expect(collectLeaves(r).length).toBe(3);
  });
});

describe("ContextProvider 实时行情", () => {
  it("填充标量并可经 resolver 读取，commitPrev 后形成上一轮", async () => {
    const p = new ContextProvider();
    const r = rule(node("AND", [lf("pct", ">=", 5)]), {
      kind: "code",
      code: "600519",
    });
    await p.refresh(
      [{ rule: r, codes: ["600519"] }],
      { "600519": quote({ pct: 6 }) },
      T0
    );
    const resolve = p.resolver("600519");
    expect(resolve(lf("pct", ">=", 5)).cur).toBe(6);
    expect(resolve(lf("pct", ">=", 5)).prev).toBeNull();

    p.commitPrev();
    expect(p.resolver("600519")(lf("pct", ">=", 5)).prev).toBe(6);
    // 无数据的键（未供应的指标）
    expect(p.resolver("600519")(lf("ind.rsi", ">=", 9, { period: 14 })).cur).toBeNull();
  });

  it("封板边沿：首轮 sealUp，随后不重复；打开产生 broken", async () => {
    const p = new ContextProvider();
    const r = rule(node("AND", [lf("evt.sealUp", ">=", 1)]), {
      kind: "code",
      code: "600519",
    });
    const targets = [{ rule: r, codes: ["600519"] }];
    const sealLeaf = lf("evt.sealUp", ">=", 1);
    const brokenLeaf = lf("evt.broken", ">=", 1);

    await p.refresh(targets, { "600519": quote({ price: 110, high: 110 }) }, T0);
    expect(p.resolver("600519")(sealLeaf).cur).toBe(1);

    await p.refresh(targets, { "600519": quote({ price: 110, high: 110 }) }, T0 + 2000);
    expect(p.resolver("600519")(sealLeaf).cur).toBe(0);

    await p.refresh(targets, { "600519": quote({ price: 105, high: 110 }) }, T0 + 4000);
    expect(p.resolver("600519")(brokenLeaf).cur).toBe(1);
  });

  it("涨速：按窗口计算区间涨幅", async () => {
    const p = new ContextProvider();
    const speed = lf("speedPct", ">=", 3, { windowSec: 300 });
    const r = rule(node("AND", [speed]), { kind: "code", code: "600519" });
    const targets = [{ rule: r, codes: ["600519"] }];

    await p.refresh(targets, { "600519": quote({ price: 100 }) }, T0);
    expect(p.resolver("600519")(speed).cur).toBeNull();

    await p.refresh(
      targets,
      { "600519": quote({ price: 103 }) },
      T0 + 360_000
    );
    expect(p.resolver("600519")(speed).cur).toBeCloseTo(3, 5);
  });

  it("停牌/无行情代码跳过", async () => {
    const p = new ContextProvider();
    const r = rule(node("AND", [lf("pct", ">=", 5)]), {
      kind: "code",
      code: "600519",
    });
    await p.refresh([{ rule: r, codes: ["600519"] }], {}, T0);
    expect(p.resolver("600519")(lf("pct", ">=", 5)).cur).toBeNull();
  });

  it("禁用规则不参与", async () => {
    const p = new ContextProvider();
    const r = rule(node("AND", [lf("pct", ">=", 5)]));
    r.enabled = false;
    await p.refresh(
      [{ rule: r, codes: ["600519"] }],
      { "600519": quote({ pct: 9 }) },
      T0
    );
    expect(p.resolver("600519")(lf("pct", ">=", 5)).cur).toBeNull();
  });
});

describe("ContextProvider 指标 / 盘口 / 竞价", () => {
  it("指标：拉 K 线计算 RSI 并缓存（TTL 内不重复请求）", async () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({
      timestamp: T0 + i * 86400000,
      open: 10,
      close: 10 + (i % 3),
      high: 11,
      low: 9,
      volume: 100,
    }));
    fetchKLine.mockResolvedValue(bars);

    const p = new ContextProvider();
    const rsiLeaf = lf("ind.rsi", ">=", 70, { period: 14 });
    const r = rule(node("AND", [rsiLeaf]), { kind: "code", code: "600519" });
    const targets = [{ rule: r, codes: ["600519"] }];

    await p.refresh(targets, { "600519": quote() }, T0);
    const v = p.resolver("600519")(rsiLeaf).cur;
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThanOrEqual(0);

    await p.refresh(targets, { "600519": quote() }, T0 + 1000);
    expect(fetchKLine).toHaveBeenCalledTimes(1);
  });

  it("空 K 线跳过", async () => {
    fetchKLine.mockResolvedValue([]);
    const p = new ContextProvider();
    const maLeaf = lf("ind.ma", ">=", 1, { period: 5 });
    const r = rule(node("AND", [maLeaf]), { kind: "code", code: "600519" });
    await p.refresh(
      [{ rule: r, codes: ["600519"] }],
      { "600519": quote() },
      T0
    );
    expect(p.resolver("600519")(maLeaf).cur).toBeNull();
  });

  it("盘口：计算买卖量比", async () => {
    fetchOrderBook.mockResolvedValue({
      name: "贵州茅台",
      code: "600519",
      price: 100,
      prevClose: 100,
      open: 100,
      high: 100,
      low: 100,
      volume: 0,
      amount: 0,
      asks: [{ price: 100.1, vol: 100 }],
      bids: [{ price: 99.9, vol: 200 }],
    });
    const p = new ContextProvider();
    const bookLeaf = lf("book.bidAskRatio", ">=", 1.5);
    const r = rule(node("AND", [bookLeaf]), { kind: "code", code: "600519" });
    await p.refresh(
      [{ rule: r, codes: ["600519"] }],
      { "600519": quote() },
      T0
    );
    expect(p.resolver("600519")(bookLeaf).cur).toBe(2);
  });

  it("竞价时段：填充缺口与成交额（亿元）", async () => {
    const aucNow = new Date(2026, 8, 28, 9, 20, 0).getTime(); // 周一 9:20
    fetchAuction.mockResolvedValue({
      updated: aucNow,
      total: 1,
      highOpen: [
        {
          code: "600519",
          name: "贵州茅台",
          open: 105,
          prevClose: 100,
          gap: 5,
          amount: 2e8,
          price: 105,
          pct: 5,
        },
      ],
      lowOpen: [],
    });
    const p = new ContextProvider();
    const gapLeaf = lf("auction.gap", ">=", 3);
    const amtLeaf = lf("auction.amountYi", ">=", 1);
    const r = rule(node("AND", [gapLeaf, amtLeaf]), {
      kind: "code",
      code: "600519",
    });
    await p.refresh([{ rule: r, codes: ["600519"] }], {}, aucNow);
    expect(p.resolver("600519")(gapLeaf).cur).toBe(5);
    expect(p.resolver("600519")(amtLeaf).cur).toBe(2);
  });
});
