import { describe, it, expect } from "vitest";
import { evaluateStock } from "../../src/composables/useSpiderBotEngine";
import type { Quote } from "../../src/api/types";

// 情绪初始为 neutral（不加减分），此处只验证涨幅×成交额的基础阈值
function quote(pct: number, amount: number, price = 10): Quote {
  return { pct, amount, price } as unknown as Quote;
}

describe("evaluateStock 评分门槛", () => {
  it("涨幅 2-7% + 中等成交额 → BUY（score≥3）", () => {
    const s = evaluateStock(quote(5.6, 8e7), "601234", "大金重工");
    expect(s.recommendation).toBe("BUY");
    expect(s.score).toBeGreaterThanOrEqual(3);
  });

  it("涨幅 2-7% 但成交额不足 → HOLD（情绪 cold/neutral 不加分）", () => {
    const s = evaluateStock(quote(3.0, 1e6), "600000", "测试股");
    expect(s.recommendation).toBe("HOLD");
  });

  it("温和放量 1-2% + 中等成交额 → HOLD（+1+1=2，不到买入线）", () => {
    const s = evaluateStock(quote(1.5, 8e7), "600001", "温和股");
    expect(s.recommendation).toBe("HOLD");
  });

  it("温和放量 1-2% + 成交额充足 → BUY（+1+2=3）", () => {
    const s = evaluateStock(quote(1.5, 2e8), "600004", "放量股");
    expect(s.recommendation).toBe("BUY");
  });

  it("跌破 -3% → SELL", () => {
    const s = evaluateStock(quote(-4, 8e7), "600002", "下跌股");
    expect(s.recommendation).toBe("SELL");
  });

  it("涨停 >9.5% 不追，评分转负倾向", () => {
    const s = evaluateStock(quote(9.8, 2e8), "600003", "涨停股");
    expect(s.score).toBeLessThan(3);
  });
});
