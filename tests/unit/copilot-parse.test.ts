import { describe, expect, it } from "vitest";
import { parseCommand, type CopilotDraft } from "../../src/copilot/parseCommand";

function draftOf(input: string): CopilotDraft {
  const r = parseCommand(input);
  if (!r.ok) throw new Error(`预期解析成功，实际失败：${r.error}`);
  return r.draft;
}

function errorOf(input: string): string {
  const r = parseCommand(input);
  if (r.ok) throw new Error(`预期解析失败，实际成功：${r.draft.summary}`);
  return r.error;
}

describe("Copilot 指令解析（P3-a）", () => {
  it("价格下破：跌破 → price lte，默认 100 股", () => {
    const d = draftOf("600519 跌破1680 买入100股");
    expect(d.code).toBe("600519");
    expect(d.side).toBe("BUY");
    expect(d.vol).toBe(100);
    expect(d.trigger).toEqual([{ field: "price", op: "lte", value: 1680 }]);
    expect(d.summary).toBe("600519 · 买入 100 股 · 价格 ≤1680.00");
  });

  it("价格上破 + sh 前缀 + 手→股", () => {
    const d = draftOf("SH600519 涨到1700 卖出2手");
    expect(d.code).toBe("600519"); // 前缀去掉，与行情/条件单 code 口径一致
    expect(d.side).toBe("SELL");
    expect(d.vol).toBe(200);
    expect(d.trigger).toEqual([{ field: "price", op: "gte", value: 1700 }]);
    expect(d.summary).toBe("600519 · 卖出 200 股 · 价格 ≥1700.00");
  });

  it("涨幅：涨 3% → pct gte，缺省 100 股", () => {
    const d = draftOf("000001 涨幅3% 加仓");
    expect(d.side).toBe("BUY");
    expect(d.vol).toBe(100);
    expect(d.trigger).toEqual([{ field: "pct", op: "gte", value: 3 }]);
    expect(d.summary).toContain("涨跌幅 ≥3.00%");
  });

  it("跌幅：跌 5% → pct lte（落库为负值）", () => {
    const d = draftOf("300750 跌幅 5% 减仓 300股");
    expect(d.side).toBe("SELL");
    expect(d.vol).toBe(300);
    expect(d.trigger).toEqual([{ field: "pct", op: "lte", value: -5 }]);
    expect(d.summary).toContain("涨跌幅 ≤-5.00%");
  });

  it("≥ / <= / 高于 / 低于 等价写法", () => {
    for (const s of ["高于1680", "≥1680", ">=1680", "突破1680"]) {
      expect(draftOf(`600519 ${s} 买入`).trigger).toEqual([
        { field: "price", op: "gte", value: 1680 },
      ]);
    }
    for (const s of ["低于1680", "≤1680", "<=1680"]) {
      expect(draftOf(`600519 ${s} 卖出`).trigger).toEqual([
        { field: "price", op: "lte", value: 1680 },
      ]);
    }
  });

  it("止盈 / 止损 → SELL", () => {
    expect(draftOf("600519 突破1700 止盈100股").side).toBe("SELL");
    expect(draftOf("600519 跌破1600 止损").side).toBe("SELL");
  });

  it("价格与涨跌幅同时出现时价格优先", () => {
    const d = draftOf("600519 跌破1680 跌幅3% 买入100股");
    expect(d.trigger).toEqual([{ field: "price", op: "lte", value: 1680 }]);
  });

  it("缺少代码 → 中文错误", () => {
    expect(errorOf("跌破1680 买入100股")).toBe("请输入 6 位股票代码");
    expect(errorOf("")).toBe("请输入 6 位股票代码");
    expect(errorOf("60051 跌破1680 买入100股")).toBe("请输入 6 位股票代码");
  });

  it("缺少方向 → 中文错误", () => {
    expect(errorOf("600519 跌破1680 100股")).toBe("请说明买入还是卖出");
  });

  it("缺少触发条件 → 中文错误", () => {
    expect(errorOf("600519 买入100股")).toBe("请给出触发价格或涨跌幅");
    // 没有 % 的「跌」不算跌幅触发，避免把「跌破」误当涨跌幅。
    expect(errorOf("600519 买入100股 跌3")).toBe("请给出触发价格或涨跌幅");
  });

  it("数量非 100 整数倍 / 0 → 中文错误", () => {
    expect(errorOf("600519 跌破1680 买入150股")).toBe("数量必须为 100 股整数倍");
    expect(errorOf("600519 跌破1680 买入0股")).toBe("数量必须为 100 股整数倍");
    expect(errorOf("600519 跌破1680 买入1.5手")).toBe("数量必须为 100 股整数倍");
  });

  it("无空格 / 全角数字也能解析", () => {
    expect(draftOf("600519跌破1680买入100股").trigger).toEqual([
      { field: "price", op: "lte", value: 1680 },
    ]);
    expect(draftOf("６００５１９ 跌破１６８０ 买入１００股").code).toBe("600519");
  });
});
