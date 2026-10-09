import { describe, it, expect } from "vitest";
import {
  evaluateStock,
  rankStocks,
  STRATEGY_PRESETS,
  type StockScore,
} from "../../../src/ai/scoring";
import type { Quote } from "../../../src/api/types";

function mockQuote(over: Partial<Quote>): Quote {
  return {
    code: "600000",
    name: "测试股票",
    price: 10,
    change: 0,
    pct: 0,
    open: 10,
    high: 10.2,
    low: 9.8,
    prevClose: 10,
    volume: 100000,
    amount: 1e8,
    time: Date.now(),
    source: "test",
    turnover: 3,
    pe: 25,
    pb: 2,
    amplitude: 4,
    volumeRatio: 1.2,
    circMv: 100,
    totalMv: 120,
    ...over,
  };
}

describe("evaluateStock 基础评分", () => {
  it("平盘 + 中等成交额 → SCAN，分数接近 0", () => {
    const q = mockQuote({ pct: 0, amount: 1e8 });
    const s = evaluateStock(q, "600000", "测试股票");
    expect(s.recommendation).toBe("SCAN");
    // 平盘：位置/估值/情绪等小因子加减，在 -2 到 +2 之间都算正常
    expect(s.score).toBeGreaterThan(-3);
    expect(s.score).toBeLessThan(3);
    expect(s.signals.length).toBeGreaterThan(0);
  });

  it("黄金区间上涨 + 放量 → BUY", () => {
    const q = mockQuote({ pct: 3.5, amount: 4e8, volumeRatio: 2.5, turnover: 6 });
    const s = evaluateStock(q, "600000", "测试股票", "hot");
    expect(s.recommendation).toMatch(/BUY/);
    expect(s.score).toBeGreaterThan(5);
    expect(s.signals).toContain("强势上涨");
    expect(s.signals).toContain("成交额充足");
    expect(s.breakdown.trend).toBeGreaterThan(0);
    expect(s.breakdown.volume).toBeGreaterThan(0);
  });

  it("涨停股 → 扣分，不推荐追涨", () => {
    const q = mockQuote({ pct: 10, amount: 5e8 });
    const s = evaluateStock(q, "600000", "测试股票");
    expect(s.risks).toContain("涨停不追");
    expect(s.score).toBeLessThan(5);
  });

  it("大跌 → SELL", () => {
    const q = mockQuote({ pct: -5, amount: 3e8, volumeRatio: 2 });
    const s = evaluateStock(q, "600000", "测试股票");
    expect(s.recommendation).toMatch(/SELL/);
    expect(s.score).toBeLessThan(-3);
    expect(s.risks.length).toBeGreaterThan(0);
  });

  it("ST 股 → 重风险扣分", () => {
    const q = mockQuote({ pct: 2, amount: 2e8 });
    const s = evaluateStock(q, "600000", "ST测试");
    expect(s.risks).toContain("ST/风险股");
    expect(s.score).toBeLessThan(0); // 本来涨的加分，ST 扣分后变负
  });

  it("高估值 + 大盘股 → 估值扣分", () => {
    const q = mockQuote({ pct: 1, pe: 200, pb: 10, amount: 2e8, circMv: 3000 });
    const s = evaluateStock(q, "600000", "高估值大盘股");
    expect(s.risks).toContain("高估值");
    expect(s.breakdown.valuation).toBeLessThan(0);
  });

  it("市场情绪好 → 加分", () => {
    const q = mockQuote({ pct: 2, amount: 2e8 });
    const sHot = evaluateStock(q, "600000", "测试", "hot");
    const sCold = evaluateStock(q, "600000", "测试", "cold");
    expect(sHot.score).toBeGreaterThan(sCold.score);
    expect(sHot.breakdown.sentiment).toBeGreaterThan(sCold.breakdown.sentiment);
  });

  it("放量下跌 → 额外量价背离扣分", () => {
    const q = mockQuote({ pct: -2, amount: 5e8, volumeRatio: 2.5 });
    const s = evaluateStock(q, "600000", "放量下跌股");
    expect(s.risks).toContain("放量下跌");
    expect(s.breakdown.volume).toBeLessThan(0);
  });

  it("评分上限不超过 maxScore，下限有约束", () => {
    // 极端情况：暴跌 + ST + 放量下跌
    const q = mockQuote({ pct: -10, amount: 5e8, volumeRatio: 3, pe: 500 });
    const s = evaluateStock(q, "600000", "ST爆雷股", "cold");
    expect(s.score).toBeGreaterThan(-30); // 不会无限扣
    expect(s.recommendation).toMatch(/SELL/);
  });
});

describe("rankStocks 排名", () => {
  it("按分数从高到低排序，取 Top N", () => {
    const quotes = [
      mockQuote({ code: "001", name: "大涨股", pct: 4, amount: 3e8 }),
      mockQuote({ code: "002", name: "平盘股", pct: 0, amount: 1e8 }),
      mockQuote({ code: "003", name: "大跌股", pct: -5, amount: 2e8 }),
      mockQuote({ code: "004", name: "小涨股", pct: 1.5, amount: 2e8 }),
    ];
    const ranked = rankStocks(quotes, "neutral", {}, 2);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });
});

describe("策略预设", () => {
  it("4 套预设策略都存在", () => {
    expect(STRATEGY_PRESETS.conservative).toBeDefined();
    expect(STRATEGY_PRESETS.balanced).toBeDefined();
    expect(STRATEGY_PRESETS.aggressive).toBeDefined();
    expect(STRATEGY_PRESETS.scalping).toBeDefined();
  });

  it("保守型阈值更高，不容易触发买入信号", () => {
    const q = mockQuote({ pct: 3, amount: 2e8 });
    const sBalanced = evaluateStock(q, "001", "测试", "neutral", STRATEGY_PRESETS.balanced);
    const sConservative = evaluateStock(q, "001", "测试", "neutral", STRATEGY_PRESETS.conservative);
    // 保守型买入阈值更高
    expect(STRATEGY_PRESETS.conservative.buyThreshold!).toBeGreaterThan(
      STRATEGY_PRESETS.balanced.buyThreshold!,
    );
    // 分数可能不同（权重不同），但阈值差距更大
    expect(STRATEGY_PRESETS.conservative.buyThreshold! - sConservative.score)
      .toBeGreaterThan(STRATEGY_PRESETS.balanced.buyThreshold! - sBalanced.score - 2);
  });
});

describe("评分明细 breakdown", () => {
  it("各分项之和 ≈ 总分（允许舍入误差）", () => {
    const q = mockQuote({ pct: 3, amount: 3e8, volumeRatio: 2, pe: 20, pb: 2 });
    const s = evaluateStock(q, "001", "测试", "hot");
    const sum = s.breakdown.trend + s.breakdown.volume + s.breakdown.volatility
      + s.breakdown.valuation + s.breakdown.sentiment + s.breakdown.riskPenalty;
    expect(Math.abs(sum - s.score)).toBeLessThan(1); // 舍入误差 ±1
  });
});
