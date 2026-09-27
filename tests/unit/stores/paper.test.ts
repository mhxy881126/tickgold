import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { Quote } from "../../../src/api/types";

const { dbMock, fetchQuotesMock } = vi.hoisted(() => ({
  dbMock: { select: vi.fn(), execute: vi.fn() },
  fetchQuotesMock: vi.fn(),
}));
vi.mock("../../../src/db/database", () => ({
  db: () => dbMock,
  ensureDb: vi.fn(async () => dbMock),
}));
vi.mock("../../../src/api/market", () => ({
  fetchQuotes: (codes: string[]) => fetchQuotesMock(codes),
}));

import { usePaperStore } from "../../../src/stores/paper";

function quote(code: string, price: number): Quote {
  return {
    code, name: code === "600519" ? "贵州茅台" : "平安银行",
    price, change: 0, pct: 1, open: price, high: price, low: price,
    prevClose: price, volume: 100, amount: price * 10000, time: 1,
    source: "eastmoney", turnover: 1, pe: 10, pb: 1, amplitude: 1,
    volumeRatio: 1, circMv: 1, totalMv: 1,
  };
}

// reloadAll() 依次查询：账户 / 持仓 / 订单
function mockReload(
  acc: { init_cash: number; cash: number }[] = [{ init_cash: 1_000_000, cash: 1_000_000 }],
  pos: Record<string, unknown>[] = [],
  ord: Record<string, unknown>[] = []
) {
  dbMock.select
    .mockResolvedValueOnce(acc)
    .mockResolvedValueOnce(pos)
    .mockResolvedValueOnce(ord);
}

beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
  (globalThis as any).window = globalThis;
  dbMock.execute.mockResolvedValue({ lastInsertId: undefined, rowsAffected: 1 });
  fetchQuotesMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("paper store", () => {
  it("starts empty and unloaded", () => {
    const s = usePaperStore();
    expect(s.account.cash).toBe(1_000_000);
    expect(s.positions).toEqual([]);
    expect(s.orders).toEqual([]);
    expect(s.priceMap).toEqual({});
    expect(s.loaded).toBe(false);
  });

  it("rejects a buy with an invalid price", async () => {
    const s = usePaperStore();
    await expect(s.buy("600519", "贵州茅台", 0, 100)).rejects.toThrow("行情无效");
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it("rejects a buy with a quantity that is not a multiple of 100", async () => {
    const s = usePaperStore();
    await expect(s.buy("600519", "贵州茅台", 10, 150)).rejects.toThrow("100 股整数倍");
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it("rejects a buy when cash is insufficient", async () => {
    dbMock.select.mockResolvedValueOnce([{ value: null }]); // settle meta
    mockReload([{ init_cash: 1_000_000, cash: 100 }]);
    const s = usePaperStore();
    await s.load();
    await expect(s.buy("600519", "贵州茅台", 1000, 100)).rejects.toThrow("可用资金不足");
  });

  it("executes a buy: deducts amount+fee, opens position with availVol 0 and writes an order", async () => {
    mockReload();
    const s = usePaperStore();
    await s.buy("600519", "贵州茅台", 10, 1000);

    // amount 10000；佣金 max(2.5,5)=5，过户费 0.1，印花税 0 → fee 5.1
    const cashCall = dbMock.execute.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].startsWith("UPDATE paper_account SET cash = cash -")
    );
    expect(cashCall?.[1][0]).toBeCloseTo(10005.1, 6);

    const posCall = dbMock.execute.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO paper_position")
    );
    expect(posCall?.[0]).toContain("avail_vol"); // SQL 中 avail_vol 为字面量 0
    expect(posCall?.[1][0]).toBe("600519");
    expect(posCall?.[1][2]).toBe(1000);
    expect(posCall?.[1][3]).toBeCloseTo(10005.1, 6); // cost_amount = amount+fee（avail_vol 在 SQL 中写死 0）
    expect(posCall?.[1][4]).toEqual(expect.any(Number)); // updated_at

    const orderCall = dbMock.execute.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO paper_order")
    );
    expect(orderCall?.[0]).toContain("'buy'"); // side 为 SQL 字面量
    expect(orderCall?.[1][3]).toBe(10); // price
    expect(orderCall?.[1][4]).toBe(1000); // vol
    expect(orderCall?.[1][5]).toBe(10000); // amount
    expect(orderCall?.[1][6]).toBeCloseTo(5.1, 6); // fee
  });

  it("rejects a sell with an invalid price", async () => {
    const s = usePaperStore();
    s.positions.push({ code: "600519", name: "贵州茅台", vol: 1000, availVol: 1000, costAmount: 10005.1 });
    await expect(s.sell("600519", 0, 100)).rejects.toThrow("行情无效");
  });

  it("rejects selling a stock with no position", async () => {
    const s = usePaperStore();
    await expect(s.sell("000001", 10, 100)).rejects.toThrow("无该股票持仓");
  });

  it("rejects selling more than the T+1 available volume", async () => {
    const s = usePaperStore();
    s.positions.push({ code: "600519", name: "贵州茅台", vol: 2000, availVol: 1000, costAmount: 20010.2 });
    await expect(s.sell("600519", 11, 2000)).rejects.toThrow("超过可卖");
  });

  it("executes a partial sell: credits proceeds net of fees and reduces the position", async () => {
    mockReload();
    const s = usePaperStore();
    s.positions.push({ code: "600519", name: "贵州茅台", vol: 2000, availVol: 2000, costAmount: 20010.2 });
    await s.sell("600519", 11, 1000);

    // amount 11000；佣金 5 + 印花税 5.5 + 过户费 0.11 → fee 10.61，proceeds 10989.39
    const cashCall = dbMock.execute.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].startsWith("UPDATE paper_account SET cash = cash +")
    );
    expect(cashCall?.[1][0]).toBeCloseTo(10989.39, 6);

    const posCall = dbMock.execute.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].startsWith("UPDATE paper_position SET vol=")
    );
    expect(posCall?.[1][0]).toBe(1000);
    expect(posCall?.[1][1]).toBeCloseTo(10005.1, 6); // costAmount 减半
  });

  it("deletes the position when the whole lot is sold", async () => {
    mockReload();
    const s = usePaperStore();
    s.positions.push({ code: "600519", name: "贵州茅台", vol: 1000, availVol: 1000, costAmount: 10005.1 });
    await s.sell("600519", 11, 1000);

    const delCall = dbMock.execute.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].startsWith("DELETE FROM paper_position")
    );
    expect(delCall?.[1]).toEqual(["600519"]);
    expect(
      dbMock.execute.mock.calls.some(
        (c) => typeof c[0] === "string" && c[0].startsWith("UPDATE paper_position SET vol=")
      )
    ).toBe(false);
  });

  // settle() 是 load() 的内部步骤，这里通过 load 间接验证（settle 未对外暴露）
  it("load settles T+1 positions across a natural day and records the date", async () => {
    const today = new Date();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const todayStr = `${today.getFullYear()}-${m}-${d}`;
    dbMock.select
      .mockResolvedValueOnce([{ value: "2020-01-01" }]) // settle meta：跨日
      .mockResolvedValueOnce([{ init_cash: 1_000_000, cash: 1_000_000 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const s = usePaperStore();
    await s.load();

    expect(dbMock.execute).toHaveBeenCalledWith("UPDATE paper_position SET avail_vol = vol");
    const upsert = dbMock.execute.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("paper_settle_date")
    );
    expect(upsert?.[1][0]).toBe(todayStr);
    s.stop();
  });

  it("load skips settlement when the recorded settle date is already today", async () => {
    const today = new Date();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    dbMock.select
      .mockResolvedValueOnce([{ value: `${today.getFullYear()}-${m}-${d}` }])
      .mockResolvedValueOnce([{ init_cash: 1_000_000, cash: 1_000_000 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const s = usePaperStore();
    await s.load();

    expect(dbMock.execute).not.toHaveBeenCalledWith("UPDATE paper_position SET avail_vol = vol");
    s.stop();
  });

  it("resets positions, orders and cash, then reloads", async () => {
    mockReload();
    const s = usePaperStore();
    s.positions.push({ code: "600519", name: "贵州茅台", vol: 1000, availVol: 1000, costAmount: 10005.1 });
    await s.reset();

    expect(dbMock.execute).toHaveBeenCalledWith("DELETE FROM paper_position");
    expect(dbMock.execute).toHaveBeenCalledWith("DELETE FROM paper_order");
    expect(dbMock.execute).toHaveBeenCalledWith(
      "UPDATE paper_account SET cash=init_cash WHERE id=1"
    );
    expect(s.priceMap).toEqual({});
  });

  it("loads everything, refreshes quotes and polls every 3s; stop() clears the timer", async () => {
    vi.useFakeTimers();
    dbMock.select
      .mockResolvedValueOnce([{ value: null }]) // settle meta
      .mockResolvedValueOnce([{ init_cash: 1_000_000, cash: 900_000 }])
      .mockResolvedValueOnce([
        { code: "600519", name: "贵州茅台", vol: 1000, availVol: 1000, costAmount: 1_000_000 },
      ])
      .mockResolvedValueOnce([{ id: "PO1" }]);
    fetchQuotesMock.mockResolvedValue([quote("600519", 1100)]);

    const s = usePaperStore();
    await s.load();

    expect(s.loaded).toBe(true);
    expect(s.account.cash).toBe(900_000);
    expect(s.positions).toHaveLength(1);
    expect(fetchQuotesMock).toHaveBeenCalledTimes(1);
    expect(s.priceMap["600519"].price).toBe(1100);

    vi.advanceTimersByTime(3000);
    expect(fetchQuotesMock).toHaveBeenCalledTimes(2);

    s.stop();
    vi.advanceTimersByTime(9000);
    expect(fetchQuotesMock).toHaveBeenCalledTimes(2);
  });

  it("load skips fetching quotes when there are no positions", async () => {
    dbMock.select
      .mockResolvedValueOnce([{ value: null }]) // settle meta
      .mockResolvedValueOnce([{ init_cash: 1_000_000, cash: 1_000_000 }])
      .mockResolvedValueOnce([]) // positions
      .mockResolvedValueOnce([]); // orders
    const s = usePaperStore();
    await s.load();
    expect(s.priceMap).toEqual({});
    expect(fetchQuotesMock).not.toHaveBeenCalled();
    s.stop();
  });

  it("computes market value falling back to cost when there is no live quote", () => {
    const s = usePaperStore();
    s.positions.push({ code: "600519", name: "贵州茅台", vol: 1000, availVol: 1000, costAmount: 1_000_000 });
    expect(s.marketValue).toBe(1_000_000); // cost 1000/股
    expect(s.totalAssets).toBe(2_000_000);
    expect(s.totalPnl).toBe(1_000_000);
    expect(s.pnlPct).toBeCloseTo(100, 6);
  });

  it("computes market value and floating PnL from live quotes", () => {
    const s = usePaperStore();
    s.positions.push({ code: "600519", name: "贵州茅台", vol: 1000, availVol: 1000, costAmount: 1_000_000 });
    s.priceMap = { "600519": quote("600519", 1100) };
    expect(s.marketValue).toBe(1_100_000);
    expect(s.floatPnl).toBe(100_000);
  });

  it("floating PnL treats missing quotes as a zero price (unrealized loss of cost)", () => {
    const s = usePaperStore();
    s.positions.push({ code: "600519", name: "贵州茅台", vol: 1000, availVol: 1000, costAmount: 1_000_000 });
    expect(s.floatPnl).toBe(-1_000_000);
  });
});
