import { describe, expect, it } from "vitest";
import {
  DEFAULT_HIT_DAYS,
  MIN_HIT_SAMPLES,
  formatHitRate,
  type HitRate,
} from "../../src/components/battle/hitRateModel";

/** 默认一份「有足够样本」的命中率，用例只覆盖需要变化的字段。 */
function hit(patch: Partial<HitRate> = {}): HitRate {
  return {
    days: DEFAULT_HIT_DAYS,
    plans: 18,
    instructions: 46,
    triggered: 25,
    triggeredPct: 54,
    executed: 12,
    executedPct: 48,
    wins: 7,
    winPct: 58,
    samples: 12,
    ...patch,
  };
}

describe("formatHitRate", () => {
  it("null → 样本不足，计数保留在 title", () => {
    const r = formatHitRate(null);
    expect(r.text).toBe("样本不足");
    expect(r.title).toContain(`近${DEFAULT_HIT_DAYS}日`);
    expect(r.title).toContain("成交 0 笔");
    expect(r.title).toContain("样本不足");
    expect(r.title).toContain("浮盈");
  });

  it("0% 边界仍出数字（不是样本不足）", () => {
    const r = formatHitRate(
      hit({
        instructions: 5,
        triggered: 0,
        triggeredPct: 0,
        executed: 0,
        executedPct: 0,
        wins: 0,
        winPct: 0,
        samples: 5,
      }),
    );
    expect(r.text).toBe("近20日 触发 0% · 执行 0% · 胜率 0%");
    expect(r.title).toContain("指令 5 条");
  });

  it("100% 边界仍出数字", () => {
    const r = formatHitRate(
      hit({
        triggeredPct: 100,
        executedPct: 100,
        winPct: 100,
        samples: 4,
      }),
    );
    expect(r.text).toContain("触发 100%");
    expect(r.text).toContain("执行 100%");
    expect(r.text).toContain("胜率 100%");
  });

  it("成交样本 <3 → 样本不足，但 title 显示完整计数", () => {
    const r = formatHitRate(
      hit({
        plans: 3,
        instructions: 8,
        triggered: 4,
        triggeredPct: 50,
        executed: 2,
        executedPct: 50,
        wins: 1,
        winPct: 50,
        samples: 2,
      }),
    );
    expect(r.text).toBe("样本不足");
    expect(r.title).toContain("计划 3 个");
    expect(r.title).toContain("指令 8 条");
    expect(r.title).toContain("成交 2 笔");
    expect(r.title).toContain("盈利 1 笔");
  });

  it("百分比为 null → 样本不足（即使成交数够）", () => {
    const r = formatHitRate(hit({ triggeredPct: null, winPct: null }));
    expect(r.text).toBe("样本不足");
  });

  it("自定义 days 生效，缺省 days 回退 20", () => {
    expect(formatHitRate(hit({ days: 5 })).text).toContain("近5日");
    expect(formatHitRate(hit({ days: undefined })).text).toContain("近20日");
  });

  it("非整数百分比按四舍五入展示", () => {
    const r = formatHitRate(hit({ triggeredPct: 66.6, executedPct: 33.3, winPct: 49.5 }));
    expect(r.text).toContain("触发 67%");
    expect(r.text).toContain("执行 33%");
    expect(r.text).toContain("胜率 50%");
  });

  it("样本阈值常量为 3", () => {
    expect(MIN_HIT_SAMPLES).toBe(3);
  });
});
