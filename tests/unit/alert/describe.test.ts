import { describe, it, expect } from "vitest";
import {
  leafText,
  treeSummary,
  countLeaves,
  scopeText,
} from "../../../src/alert/describe";
import type { Leaf, TreeNode } from "../../../src/alert/types";

const leaf = (
  field: string,
  op: Leaf["op"],
  value: number,
  params?: Record<string, number>
): Leaf => ({ id: field, field, op, value, params });

describe("leafText", () => {
  it("标量字段带单位", () => {
    expect(leafText(leaf("pct", ">=", 5))).toBe("涨跌幅 ≥ 5%");
  });
  it("未知字段回退 field 名", () => {
    expect(leafText(leaf("foo.bar", ">=", 1))).toBe("foo.bar ≥ 1");
  });
  it("事件字段只显示名称", () => {
    expect(leafText(leaf("evt.sealUp", ">=", 1))).toBe("涨停封板");
  });
  it("指标周期参数后缀", () => {
    expect(leafText(leaf("ind.rsi", "<=", 30, { period: 14 }))).toBe(
      "RSI(14) ≤ 30"
    );
  });
  it("涨速窗口参数后缀（分钟）", () => {
    expect(leafText(leaf("speedPct", ">=", 3, { windowSec: 300 }))).toBe(
      "区间涨速/5分 ≥ 3%"
    );
  });
});

describe("treeSummary", () => {
  it("AND 连接", () => {
    const t: TreeNode = {
      id: "n",
      op: "AND",
      children: [leaf("pct", ">=", 5), leaf("volumeRatio", ">=", 2)],
    };
    expect(treeSummary(t)).toBe("涨跌幅 ≥ 5% 且 量比 ≥ 2");
  });
  it("OR 连接并递归括号", () => {
    const t: TreeNode = {
      id: "root",
      op: "OR",
      children: [
        leaf("pct", ">=", 5),
        {
          id: "sub",
          op: "AND",
          children: [leaf("pct", "<=", -5), leaf("turnover", ">=", 5)],
        },
      ],
    };
    expect(treeSummary(t)).toBe(
      "涨跌幅 ≥ 5% 或 (涨跌幅 ≤ -5% 且 换手率 ≥ 5%)"
    );
  });
  it("空树显示无条件", () => {
    expect(treeSummary({ id: "n", op: "AND", children: [] })).toBe("无条件");
  });
});

describe("countLeaves", () => {
  it("嵌套统计", () => {
    const t: TreeNode = {
      id: "root",
      op: "AND",
      children: [
        leaf("pct", ">=", 1),
        {
          id: "sub",
          op: "OR",
          children: [leaf("pct", ">=", 2), leaf("pct", ">=", 3)],
        },
      ],
    };
    expect(countLeaves(t)).toBe(3);
  });
  it("单叶子为 1", () => {
    expect(countLeaves(leaf("pct", ">=", 1))).toBe(1);
  });
});

describe("scopeText", () => {
  it("全部自选", () => {
    expect(scopeText({ kind: "all" })).toBe("全部自选");
  });
  it("单股", () => {
    expect(scopeText({ kind: "code", code: "600519" })).toBe("600519");
  });
  it("分组：有回调", () => {
    expect(
      scopeText({ kind: "group", groupId: 2 }, () => "短线池")
    ).toBe("短线池");
  });
  it("分组：无回调", () => {
    expect(scopeText({ kind: "group", groupId: 2 })).toBe("分组#2");
  });
});
