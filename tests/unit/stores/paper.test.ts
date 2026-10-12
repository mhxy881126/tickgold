import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { Quote } from "../../../src/api/types";

const { dbMock, fetchQuotesMock, buyMock, sellMock } = vi.hoisted(() => ({
  dbMock: { select: vi.fn(), execute: vi.fn() },
  fetchQuotesMock: vi.fn(),
  buyMock: vi.fn(),
  sellMock: vi.fn(),
}));
vi.mock("../../../src/db/database", () => ({
  db: () => dbMock,
  ensureDb: vi.fn(async () => dbMock),
}));
vi.mock("../../../src/api/market", () => ({
  fetchQuotes: (codes: string[]) => fetchQuotesMock(codes),
}));
vi.mock("../../../src/broker/api", () => ({
  portfolioBuy: (...a: unknown[]) => buyMock(...a),
  portfolioSell: (...a: unknown[]) => sellMock(...a),
}));

import { usePaperStore } from "../../../src/stores/paper";

function quote(code: string, price: number, prevClose = price): Quote {
  return {
    code, name: code === "600519" ? "贵州茅台" : "平安银行",
    price, change: 0, pct: 1, open: price, high: price, low: price,
    prevClose, volume: 100, amount: price * 10000, time: 1,
    source: "eastmoney", turnover: 1, pe: 10, pb: 1, amplitude: 1,
    volumeRatio: 1, circMv: 1, totalMv: 1, insideVol: 0, outsideVol: 0,
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
  buyMock.mockResolvedValue(undefined);
  sellMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("paper store", () => {
  it("starts empty and unloaded", () => {
    const s = usePaperStore();
    expect(s.account.cash).toBe(0);
    expect(s.positions).toEqual([]);
    expect(s.orders).toEqual([]);
    expect(s.priceMap).toEqual({});
    expect(s.loaded).toBe(false);
  });

  it("rejects a buy with an invalid price", async () => {
    const s = usePaperStore();
    await expect(s.buy("600519", "贵州茅台", 0, 100)).rejects.toThrow("行情无效");
    expect(buyMock).not.toHaveBeenCalled();
  });

  it("rejects a buy with a quantity that is not a multiple of 100", async () => {
    const s = usePaperStore();
    await expect(s.buy("600519", "贵州茅台", 10, 150)).rejects.toThrow("100 股整数倍");
    expect(buyMock).not.toHaveBeenCalled();
  });

  it("buy delegates to the Rust portfolio command, then reloads", async () => {
    mockReload();
    const s = usePaperStore();
    await s.buy("600519", "贵州茅台", 10, 1000);

    expect(buyMock).toHaveBeenCalledWith("600519", "贵州茅台", 10, 1000);
    // reloadAll 做了账户 / 持仓 / 订单三次查询
    expect(dbMock.select).toHaveBeenCalledTimes(3);
  });

  it("rejects a sell with an invalid price", async () => {
    const s = usePaperStore();
    s.positions.push({ code: "600519", name: "贵州茅台", vol: 1000, availVol: 1000, costAmount: 10005.1 });
    await expect(s.sell("600519", 0, 100)).rejects.toThrow("行情无效");
    expect(sellMock).not.toHaveBeenCalled();
  });

  it("rejects selling a stock with no position", async () => {
    const s = usePaperStore();
    await expect(s.sell("000001", 10, 100)).rejects.toThrow("无该股票持仓");
    expect(sellMock).not.toHaveBeenCalled();
  });

  it("rejects selling more than the T+1 available volume", async () => {
    const s = usePaperStore();
    s.positions.push({ code: "600519", name: "贵州茅台", vol: 2000, availVol: 1000, costAmount: 20010.2 });
    await expect(s.sell("600519", 11, 2000)).rejects.toThrow("超过可卖");
    expect(sellMock).not.toHaveBeenCalled();
  });

  it("sell delegates to the Rust portfolio command, then reloads", async () => {
    mockReload();
    const s = usePaperStore();
    s.positions.push({ code: "600519", name: "贵州茅台", vol: 2000, availVol: 2000, costAmount: 20010.2 });
    await s.sell("600519", 11, 1000);

    expect(sellMock).toHaveBeenCalledWith("600519", 11, 1000);
    expect(dbMock.select).toHaveBeenCalledTimes(3);
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

  it("resetWith sets init_cash/cash and reloads", async () => {
    mockReload([{ init_cash: 500_000, cash: 500_000 }]);
    const s = usePaperStore();
    await s.resetWith(500_000);
    const call = dbMock.execute.mock.calls.find((c) =>
      typeof c[0] === "string" && c[0].includes("UPDATE paper_account SET init_cash=")
    );
    expect(call?.[1]).toEqual([500_000, 500_000]);
  });

  it("resetWith rejects non-positive cash", async () => {
    const s = usePaperStore();
    await expect(s.resetWith(0)).rejects.toThrow("初始资金须大于 0");
  });

  it("loads everything, refreshes quotes and polls every 3s; stop() clears the timer", async () => {
    vi.useFakeTimers();
    mockReload(
      [{ init_cash: 1_000_000, cash: 900_000 }],
      [
        { code: "600519", name: "贵州茅台", vol: 1000, availVol: 1000, costAmount: 1_000_000 },
      ],
      [{ id: "PO1" }]
    );
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
    mockReload([{ init_cash: 1_000_000, cash: 1_000_000 }], [], []);
    const s = usePaperStore();
    await s.load();
    expect(s.priceMap).toEqual({});
    expect(fetchQuotesMock).not.toHaveBeenCalled();
    s.stop();
  });

  it("computes market value falling back to cost when there is no live quote", () => {
    const s = usePaperStore();
    s.account = { initCash: 1_000_000, cash: 1_000_000 };
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

  it("dayPnl uses price minus prevClose, ignoring positions without a quote", () => {
    const s = usePaperStore();
    s.positions.push({ code: "600519", name: "贵州茅台", vol: 1000, availVol: 1000, costAmount: 1_000_000 });
    s.priceMap = { "600519": quote("600519", 1100, 1000) };
    expect(s.dayPnl).toBe(100_000);
  });
});
