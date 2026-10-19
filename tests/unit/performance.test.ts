import { describe, it, expect } from "vitest";
import { analyzePerformance, daysBetween, type TradeLike } from "../../src/lib/performance";

// 费用与后端 portfolio.rs 对齐：买入 10000 → 5.1；卖出 11000 → 10.61；卖出 9000 → 9.59
function t(p: Partial<TradeLike> & Pick<TradeLike, "code" | "side" | "price" | "vol">): TradeLike {
  const price = p.price;
  const vol = p.vol;
  return {
    code: p.code,
    name: p.name ?? "",
    side: p.side,
    price,
    vol,
    amount: p.amount ?? price * vol,
    fee: p.fee ?? 0,
    createdAt: p.createdAt ?? 0,
    tradeDate: p.tradeDate ?? "",
  };
}

describe("daysBetween", () => {
  it("计算自然日差", () => {
    expect(daysBetween("2026-10-09", "2026-10-10")).toBe(1);
    expect(daysBetween("2026-10-09", "2026-10-12")).toBe(3);
    expect(daysBetween("2026-10-09", "2026-10-09")).toBe(0);
  });
});

describe("analyzePerformance 单笔盈利闭环", () => {
  const trades: TradeLike[] = [
    t({ code: "600519", side: "buy", price: 10, vol: 1000, fee: 5.1, createdAt: 1, tradeDate: "2026-10-09" }),
    t({ code: "600519", side: "sell", price: 11, vol: 1000, fee: 10.61, createdAt: 3, tradeDate: "2026-10-10" }),
  ];
  const s = analyzePerformance(trades, 100000);

  it("配对出一笔闭环", () => {
    expect(s.trades).toBe(1);
    expect(s.roundTrips[0].holdingDays).toBe(1);
    expect(s.roundTrips[0].entryPrice).toBe(10);
    expect(s.roundTrips[0].exitPrice).toBe(11);
    expect(s.roundTrips[0].vol).toBe(1000);
  });
  it("已实现盈亏=卖出净收入-买入成本", () => {
    // cost=10005.1, net=10989.39 → 984.29
    expect(s.realizedPnl).toBeCloseTo(984.29, 2);
    expect(s.roundTrips[0].pnl).toBeCloseTo(984.29, 2);
    expect(s.roundTrips[0].retPct).toBeCloseTo(9.84, 1);
  });
  it("胜负与费用", () => {
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(0);
    expect(s.winRate).toBe(100);
    expect(s.totalFees).toBeCloseTo(15.71, 2);
    expect(s.avgHoldDays).toBe(1);
    expect(s.largestWin).toBeCloseTo(984.29, 2);
  });
  it("盈利路径最大回撤为0", () => {
    expect(s.maxDrawdown).toBeCloseTo(0, 2);
    expect(s.maxDrawdownPct).toBeCloseTo(0, 2);
  });
});

describe("analyzePerformance 一盈一亏（含回撤/盈亏比/月度）", () => {
  const trades: TradeLike[] = [
    t({ code: "600519", side: "buy", price: 10, vol: 1000, fee: 5.1, createdAt: 1, tradeDate: "2026-10-09" }),
    t({ code: "000001", side: "buy", price: 10, vol: 1000, fee: 5.1, createdAt: 2, tradeDate: "2026-10-09" }),
    t({ code: "600519", side: "sell", price: 11, vol: 1000, fee: 10.61, createdAt: 3, tradeDate: "2026-10-10" }),
    t({ code: "000001", side: "sell", price: 9, vol: 1000, fee: 9.59, createdAt: 4, tradeDate: "2026-10-12" }),
  ];
  const s = analyzePerformance(trades, 100000);

  it("胜负各半", () => {
    expect(s.trades).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBe(50);
  });
  it("价差抵消、只剩费用", () => {
    expect(s.realizedPnl).toBeCloseTo(-30.4, 2);
    expect(s.totalFees).toBeCloseTo(30.4, 2);
    expect(s.expectancy).toBeCloseTo(-15.2, 2);
  });
  it("盈亏比/平均盈亏/最大亏损", () => {
    expect(s.grossProfit).toBeCloseTo(984.29, 2);
    expect(s.grossLoss).toBeCloseTo(1014.69, 2);
    expect(s.profitFactor).toBeCloseTo(984.29 / 1014.69, 2);
    expect(s.avgWin).toBeCloseTo(984.29, 2);
    expect(s.avgLoss).toBeCloseTo(1014.69, 2);
    expect(s.largestLoss).toBeCloseTo(-1014.69, 2);
  });
  it("峰后回撤=亏损单金额", () => {
    // peak=100984.29（盈利后），回撤到 99969.6 → 1014.69
    expect(s.maxDrawdown).toBeCloseTo(1014.69, 2);
    expect(s.maxDrawdownPct).toBeCloseTo((1014.69 / 100984.29) * 100, 1);
  });
  it("月度合并归因", () => {
    expect(s.monthly).toHaveLength(1);
    expect(s.monthly[0].month).toBe("2026-10");
    expect(s.monthly[0].pnl).toBeCloseTo(-30.4, 2);
    expect(s.monthly[0].trades).toBe(2);
    expect(s.monthly[0].wins).toBe(1);
    expect(s.monthly[0].losses).toBe(1);
  });
});

describe("analyzePerformance 空数据", () => {
  it("无交易时指标为安全默认", () => {
    const s = analyzePerformance([], 100000);
    expect(s.trades).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.profitFactor).toBeNull();
    expect(s.maxDrawdown).toBe(0);
    expect(s.equityCurve).toHaveLength(1);
  });
});
