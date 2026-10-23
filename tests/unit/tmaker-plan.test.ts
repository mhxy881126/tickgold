import { describe, expect, it } from "vitest";
import { buildDayPlan, skipReasonsOf } from "../../src/composables/tmaker/plan";

const base = {
  code: "600000", name: "浦发银行", date: "20261026",
  auctionPrice: 10.0, prevClose: 9.9, atrPct: 1.5,
  supportLow: 9.5, resistHigh: 10.4, baseVol: 3000,
  skipReasons: [],
};

describe("buildDayPlan 盘前计划", () => {
  it("竞价价作中枢：低吸 3 档 + 高抛 3 档，每档数量均分且为 100 整数倍", () => {
    const p = buildDayPlan(base);
    expect(p.center).toBe(10.0);
    expect(p.skip).toHaveLength(0);
    const buys = p.levels.filter((l) => l.side === "buy");
    const sells = p.levels.filter((l) => l.side === "sell");
    expect(buys).toHaveLength(3);
    expect(sells).toHaveLength(3);
    expect(buys[0].price).toBeGreaterThan(buys[1].price);   // 低吸档1 高于 档2
    expect(sells[0].price).toBeLessThan(sells[1].price);    // 高抛档1 低于 档2
    expect(buys[0].vol).toBe(500); // 3000/6 档均分
    expect(p.levels.every((l) => l.vol % 100 === 0)).toBe(true);
  });

  it("竞价价缺失 → 回退昨收作中枢", () => {
    const p = buildDayPlan({ ...base, auctionPrice: 0 });
    expect(p.center).toBe(9.9);
  });

  it("不做名单命中 → 只返回原因，不生成档位", () => {
    const p = buildDayPlan({ ...base, skipReasons: ["连续亏损 2 笔，触发熔断休息"] });
    expect(p.skip).toHaveLength(1);
    expect(p.levels).toHaveLength(0);
  });

  it("支撑/压力边界：下破支撑的买入档剔除，上破压力的卖出档剔除", () => {
    // 支撑 9.95 → 低吸档3（-2.25%）≈9.78 < 9.95×0.997 → 剔除；压力 10.05 → 高抛档3 剔除
    const p = buildDayPlan({ ...base, supportLow: 9.95, resistHigh: 10.05, atrPct: 2.0 });
    const buys = p.levels.filter((l) => l.side === "buy");
    const sells = p.levels.filter((l) => l.side === "sell");
    expect(buys.length).toBeLessThan(3);
    expect(sells.length).toBeLessThan(3);
    // 保留档不越界
    for (const b of buys) expect(b.price).toBeGreaterThanOrEqual(9.95 * 0.997);
    for (const s of sells) expect(s.price).toBeLessThanOrEqual(10.05 * 1.003);
  });

  it("竞价贴涨停 → 禁买入档；贴跌停 → 禁卖出档", () => {
    const nearUp = buildDayPlan({ ...base, auctionPrice: 10.88, prevClose: 9.9, limitUpPct: 10 }); // +9.9%
    expect(nearUp.levels.every((l) => l.side === "sell")).toBe(true);
    const nearDown = buildDayPlan({ ...base, auctionPrice: 8.92, prevClose: 9.9, limitDownPct: 10 }); // -9.9%
    expect(nearDown.levels.every((l) => l.side === "buy")).toBe(true);
  });

  it("单档数量不足一手（baseVol 太小）→ 空档", () => {
    const p = buildDayPlan({ ...base, baseVol: 300 });
    // 300/6=50 <100 → 全部剔除
    expect(p.levels).toHaveLength(0);
  });
});

describe("skipReasonsOf 不做名单", () => {
  it("各规则独立触发且数量与原因一致", () => {
    expect(skipReasonsOf({ forcedCloseToday: 3, streakLoss: 0, atrPct: 1.2, amount5d: 5e8 })).toHaveLength(1);
    expect(skipReasonsOf({ forcedCloseToday: 0, streakLoss: 2, atrPct: 0.3, amount5d: 5e8 })).toHaveLength(2);
    expect(skipReasonsOf({ forcedCloseToday: 0, streakLoss: 0, atrPct: 1.2, amount5d: 1e8 })).toHaveLength(1);
    expect(skipReasonsOf({ forcedCloseToday: 0, streakLoss: 0, atrPct: 1.2, amount5d: 5e8 })).toHaveLength(0);
  });
});
