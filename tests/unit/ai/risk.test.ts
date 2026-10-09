import { describe, it, expect } from "vitest";
import {
  checkBuyRisk,
  checkSellRisk,
  checkPauseTrading,
  calcTotalValue,
  calcPositionPnlPct,
  calcMaxDrawdownPct,
  DEFAULT_RISK_CONFIG,
  STRATEGY_RISK,
  type AccountState,
  type Position,
} from "../../../src/ai/risk";

function mockAccount(over: Partial<AccountState> = {}): AccountState {
  // 先算基础账户总值
  const positions = over.positions ?? [];
  const cash = over.cash ?? 500_000;
  const posCost = positions.reduce((s, p) => s + p.costAmount, 0);
  const totalValue = cash + posCost;

  const base: AccountState = {
    initCash: totalValue, // 初始资金 = 账户总值（避免意外的大幅回撤）
    cash,
    positions,
    trades: [],
    todayBuyCount: 0,
    todaySellCount: 0,
    dayHighValue: totalValue,
    totalHighValue: totalValue,
  };
  return { ...base, ...over };
}

function mockPos(code: string, price: number, vol: number): Position {
  return {
    code,
    name: code,
    vol,
    costAmount: price * vol,
  };
}

describe("calcTotalValue 账户总值", () => {
  it("现金 + 持仓市值", () => {
    const acc = mockAccount({
      cash: 400_000,
      positions: [mockPos("001", 10, 10000)],
    });
    const v = calcTotalValue(acc, { "001": 12 });
    expect(v).toBe(400_000 + 12 * 10000); // 40w + 12w = 52w
  });

  it("空仓 = 现金", () => {
    const acc = mockAccount({ cash: 800_000, positions: [] });
    expect(calcTotalValue(acc, {})).toBe(800_000);
  });
});

describe("calcPositionPnlPct 持仓盈亏", () => {
  it("盈利", () => {
    const pos = mockPos("001", 10, 1000);
    expect(calcPositionPnlPct(pos, 12)).toBeCloseTo(0.2, 5);
  });
  it("亏损", () => {
    const pos = mockPos("001", 10, 1000);
    expect(calcPositionPnlPct(pos, 9)).toBeCloseTo(-0.1, 5);
  });
});

describe("checkBuyRisk 买入风控", () => {
  const priceMap: Record<string, number> = {};
  const now = new Date(2025, 0, 15, 10, 30); // 上午 10:30，非冷静期

  it("正常买入：允许，建议买入量 = 单票预算 / 价格", () => {
    const acc = mockAccount({
      cash: 500_000,
      positions: [mockPos("002", 8, 10000)], // 8w 持仓
    });
    const dec = checkBuyRisk("001", "测试股", 10, acc, priceMap, now);
    expect(dec.allowed).toBe(true);
    if (dec.allowed) {
      expect(dec.suggestedVol).toBeDefined();
      expect(dec.suggestedVol! % 100).toBe(0); // 100 股整数
      expect(dec.suggestedVol!).toBeGreaterThan(100);
    }
  });

  it("持仓数达上限：拒绝", () => {
    const positions = ["001", "002", "003", "004", "005"].map(c => mockPos(c, 10, 1000));
    const acc = mockAccount({ cash: 500_000, positions });
    const dec = checkBuyRisk("006", "新股票", 10, acc, priceMap, now);
    expect(dec.allowed).toBe(false);
    expect(dec.reason).toContain("持仓数达上限");
  });

  it("现金不足一手：拒绝", () => {
    const acc = mockAccount({ cash: 50, positions: [] });
    const dec = checkBuyRisk("001", "测试", 10, acc, priceMap, now);
    expect(dec.allowed).toBe(false);
    expect(dec.reason).toContain("资金不足");
  });

  it("涨停保护：涨幅过大不追", () => {
    const acc = mockAccount({ cash: 500_000, positions: [] });
    const pMap = { "001": 10 }; // 昨收 10
    const dec = checkBuyRisk("001", "涨停股", 11, acc, pMap, now); // 现价 11 = +10%
    expect(dec.allowed).toBe(false);
    expect(dec.reason).toContain("涨停不追买");
  });

  it("交易频率达上限：拒绝", () => {
    const acc = mockAccount({
      cash: 500_000,
      positions: [],
      todayBuyCount: 6,
      todaySellCount: 0,
    });
    const dec = checkBuyRisk("001", "测试", 10, acc, priceMap, now, { maxDailyTrades: 6 });
    expect(dec.allowed).toBe(false);
    expect(dec.reason).toContain("交易次数达上限");
  });

  it("风控暂停中：拒绝", () => {
    const acc = mockAccount({
      cash: 500_000,
      positions: [],
      pausedUntil: now.getTime() + 3600_000,
      pauseReason: "最大回撤触线",
    });
    const dec = checkBuyRisk("001", "测试", 10, acc, priceMap, now);
    expect(dec.allowed).toBe(false);
    expect(dec.reason).toContain("风控暂停");
  });

  it("开盘冷静期：拒绝", () => {
    const openTime = new Date(2025, 0, 15, 9, 35); // 9:35，开盘 5 分钟
    const acc = mockAccount({ cash: 500_000, positions: [] });
    const dec = checkBuyRisk("001", "测试", 10, acc, priceMap, openTime, { openCoolDownMin: 15 });
    expect(dec.allowed).toBe(false);
    expect(dec.reason).toContain("冷静期");
  });

  it("收盘冷静期：拒绝", () => {
    const closeTime = new Date(2025, 0, 15, 14, 50); // 14:50，收盘前 10 分钟
    const acc = mockAccount({ cash: 500_000, positions: [] });
    const dec = checkBuyRisk("001", "测试", 10, acc, priceMap, closeTime, { closeCoolDownMin: 15 });
    expect(dec.allowed).toBe(false);
    expect(dec.reason).toContain("冷静期");
  });

  it("最大回撤触线：拒绝", () => {
    const acc = mockAccount({
      initCash: 1_000_000,
      cash: 300_000,
      // 成本 6000 股 × 100 元 = 60w
      positions: [
        { code: "001", name: "001", vol: 60000, costAmount: 600_000 }
      ],
      totalHighValue: 1_200_000, // 历史最高 120w
      dayHighValue: 1_200_000,
    });
    const pMap = { "001": 9 }; // 现价 9，持仓值 54w，总值 84w，从 120w 回撤 30%
    const dec = checkBuyRisk("002", "新股票", 10, acc, pMap, now, { maxDrawdownPct: -0.1 });
    expect(dec.allowed).toBe(false);
    expect(dec.reason).toContain("最大回撤");
  });
});

describe("checkSellRisk 卖出风控", () => {
  it("止盈触发（移动止盈关闭时）", () => {
    const pos = mockPos("001", 10, 1000);
    const dec = checkSellRisk(pos, 11, 11, {
      takeProfitPct: 0.08,
      trailingStopEnabled: false,
    });
    expect(dec.allowed).toBe(true);
    expect(dec.side).toBe("take_profit");
    expect(dec.reason).toContain("止盈");
  });

  it("止损触发", () => {
    const pos = mockPos("001", 10, 1000);
    const dec = checkSellRisk(pos, 9.5, 10.5, { stopLossPct: -0.04 });
    expect(dec.allowed).toBe(true);
    expect(dec.side).toBe("stop_loss");
    expect(dec.reason).toContain("止损");
  });

  it("移动止盈触发", () => {
    const pos = mockPos("001", 10, 1000);
    // 成本 10，最高涨到 13（+30%），现在 12.5（从高点回撤约 3.8%）
    const dec = checkSellRisk(pos, 12.5, 13, {
      takeProfitPct: 0.15,
      stopLossPct: -0.05,
      trailingStopPct: 0.03,
      trailingStopEnabled: true,
    });
    expect(dec.allowed).toBe(true);
    expect(dec.side).toBe("trailing_stop");
  });

  it("未触发：不允许卖", () => {
    const pos = mockPos("001", 10, 1000);
    const dec = checkSellRisk(pos, 10.2, 10.5, {
      takeProfitPct: 0.08,
      stopLossPct: -0.04,
      trailingStopEnabled: false,
    });
    expect(dec.allowed).toBe(false);
    expect(dec.reason).toContain("未触发");
  });

  it("跌停不卖", () => {
    const pos = mockPos("001", 10, 1000);
    const dec = checkSellRisk(pos, 9, 12, { limitDownProtect: true, stopLossPct: -0.05 });
    expect(dec.allowed).toBe(false);
    expect(dec.reason).toContain("跌停");
  });
});

describe("checkPauseTrading 暂停交易", () => {
  const now = new Date(2025, 0, 15, 10, 30);

  it("最大回撤触线 → 暂停至明日", () => {
    const acc = mockAccount({
      initCash: 1_000_000,
      cash: 200_000,
      positions: [
        { code: "001", name: "001", vol: 60000, costAmount: 600_000 }
      ],
      totalHighValue: 1_200_000, // 历史最高 120w
      dayHighValue: 1_200_000,
    });
    const pMap = { "001": 9 }; // 持仓值 54w，总值 74w，回撤 ~38%
    const pause = checkPauseTrading(acc, pMap, now, { maxDrawdownPct: -0.1 });
    expect(pause).not.toBeNull();
    expect(pause!.reason).toContain("最大回撤");
    expect(pause!.until).toBeGreaterThan(now.getTime());
  });

  it("正常盈利情况 → 不暂停", () => {
    const acc = mockAccount({
      initCash: 1_000_000,
      cash: 500_000,
      positions: [mockPos("001", 10, 40000)], // 成本 40w
      totalHighValue: 1_000_000,
    });
    // 持仓涨到 10.5，总值 = 50w + 42w = 92w... 还是亏的
    // 换一个：成本 9 元，现价 10 元 → 持仓盈利
    const acc2 = mockAccount({
      initCash: 1_000_000,
      cash: 500_000,
      positions: [
        { code: "001", name: "001", vol: 50000, costAmount: 9 * 50000 }, // 成本 45w
      ],
      totalHighValue: 1_000_000,
      dayHighValue: 950_000,
    });
    // 现价 10 → 持仓值 50w，总值 100w = initCash，今日持平
    const pause = checkPauseTrading(acc2, { "001": 10 }, now);
    expect(pause).toBeNull();
  });
});

describe("STRATEGY_RISK 策略预设", () => {
  it("4 套预设策略都存在", () => {
    expect(STRATEGY_RISK.conservative).toBeDefined();
    expect(STRATEGY_RISK.balanced).toBeDefined();
    expect(STRATEGY_RISK.aggressive).toBeDefined();
    expect(STRATEGY_RISK.scalping).toBeDefined();
  });

  it("保守型止盈止损更紧", () => {
    expect(STRATEGY_RISK.conservative.takeProfitPct!).toBeLessThan(
      STRATEGY_RISK.aggressive.takeProfitPct!,
    );
    expect(STRATEGY_RISK.conservative.stopLossPct!).toBeGreaterThan(
      STRATEGY_RISK.aggressive.stopLossPct!,
    ); // -0.025 > -0.06
  });
});

describe("calcMaxDrawdownPct 最大回撤", () => {
  it("创新高时回撤为 0（无回撤）", () => {
    const acc = mockAccount({
      cash: 600_000,
      positions: [mockPos("001", 10, 50000)],
      totalHighValue: 1_000_000,
    });
    const dd = calcMaxDrawdownPct(acc, { "001": 10 });
    // 总值 = 60w + 50w = 110w > 历史最高 100w，所以没有回撤（0）
    // 注意：函数返回 0 或负数表示回撤，正数表示创新高
    expect(dd).toBeGreaterThanOrEqual(0);
  });

  it("从高点下跌", () => {
    const acc = mockAccount({
      cash: 400_000,
      positions: [mockPos("001", 10, 60000)],
      totalHighValue: 1_200_000,
    });
    const dd = calcMaxDrawdownPct(acc, { "001": 10 });
    // 总值 = 40w + 60w = 100w，从 120w 高点下跌
    expect(dd).toBeCloseTo(-1 / 6, 3); // (100 - 120)/120 = -16.67%
  });
});
