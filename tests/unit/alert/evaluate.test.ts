import { describe, it, expect } from "vitest";
import { evalTree, evalLeaf, type EvalCtx, type Resolve } from "../../../src/alert/evaluate";
import type { Leaf, TreeNode } from "../../../src/alert/types";
import { newId } from "../../../src/alert/types";

function leaf(field: string, op: Leaf["op"], value: number, params?: Record<string, number>): Leaf {
  return { id: newId("l"), field, op, value, params };
}
function node(op: "AND" | "OR", children: (TreeNode | Leaf)[]): TreeNode {
  return { id: newId("n"), op, children };
}

/** 用固定取值表造 resolve；prev 表缺省为 null（模拟首轮） */
function makeResolve(curMap: Record<string, number>, prevMap: Record<string, number> = {}): Resolve {
  return (l) => ({
    cur: curMap[l.id] ?? null,
    prev: prevMap[l.id] ?? null,
  });
}
function ctx(resolve: Resolve): EvalCtx {
  return { now: 1000, code: "000001", resolve };
}

describe("标量运算符", () => {
  const ops: [Leaf["op"], number, number, boolean][] = [
    [">=", 5, 5, true],
    [">=", 5, 4, false],
    ["<=", 5, 5, true],
    ["<=", 5, 6, false],
    [">", 5, 6, true],
    ["<", 5, 4, true],
    ["==", 5, 5, true],
    ["==", 5, 6, false],
  ];
  for (const [op, threshold, cur, expected] of ops) {
    it(`${op} ${threshold} @${cur} → ${expected}`, () => {
      const l = leaf("pct", op, threshold);
      const r = evalLeaf(ctx(makeResolve({ [l.id]: cur })), l);
      expect(!!r).toBe(expected);
    });
  }
});

describe("AND / OR 组合", () => {
  it("AND：全部命中才命中", () => {
    const a = leaf("pct", ">=", 5);
    const b = leaf("volumeRatio", ">=", 2);
    const tree = node("AND", [a, b]);
    expect(evalTree(ctx(makeResolve({ [a.id]: 6, [b.id]: 3 })), tree).hit).toBe(true);
    expect(evalTree(ctx(makeResolve({ [a.id]: 6, [b.id]: 1 })), tree).hit).toBe(false);
  });
  it("OR：任一命中即可", () => {
    const a = leaf("pct", ">=", 5);
    const b = leaf("volumeRatio", ">=", 2);
    const tree = node("OR", [a, b]);
    expect(evalTree(ctx(makeResolve({ [a.id]: 1, [b.id]: 3 })), tree).hit).toBe(true);
    expect(evalTree(ctx(makeResolve({ [a.id]: 1, [b.id]: 1 })), tree).hit).toBe(false);
  });
  it("嵌套：(A AND B) OR C", () => {
    const a = leaf("pct", ">=", 5);
    const b = leaf("turnover", ">=", 5);
    const c = leaf("evt.sealUp", ">=", 1);
    const tree = node("OR", [node("AND", [a, b]), c]);
    expect(evalTree(ctx(makeResolve({ [a.id]: 1, [b.id]: 1, [c.id]: 1 })), tree).hit).toBe(true);
    expect(evalTree(ctx(makeResolve({ [a.id]: 1, [b.id]: 1, [c.id]: 0 })), tree).hit).toBe(false);
  });
});

describe("crossUp / crossDown 边沿", () => {
  it("crossUp：上轮低于、本轮达到才触发", () => {
    const l = leaf("price", "crossUp", 10);
    expect(evalLeaf(ctx(makeResolve({ [l.id]: 11 }, { [l.id]: 9 })), l)).not.toBeNull();
    // 已在上方不重复触发
    expect(evalLeaf(ctx(makeResolve({ [l.id]: 11 }, { [l.id]: 10.5 })), l)).toBeNull();
  });
  it("首轮（无 prev）不触发", () => {
    const l = leaf("price", "crossUp", 10);
    expect(evalLeaf(ctx(makeResolve({ [l.id]: 11 })), l)).toBeNull();
  });
  it("crossDown：上轮高于、本轮跌破", () => {
    const l = leaf("price", "crossDown", 10);
    expect(evalLeaf(ctx(makeResolve({ [l.id]: 9 }, { [l.id]: 11 })), l)).not.toBeNull();
    expect(evalLeaf(ctx(makeResolve({ [l.id]: 9 }, { [l.id]: 9.5 })), l)).toBeNull();
  });
});

describe("数据缺失", () => {
  it("叶子 cur 为 null 不命中，AND 整体不成立", () => {
    const a = leaf("pct", ">=", 5);
    const b = leaf("turnover", ">=", 5);
    const tree = node("AND", [a, b]);
    expect(evalTree(ctx(makeResolve({ [a.id]: 6 })), tree).hit).toBe(false);
  });
  it("空 AND 节点不命中", () => {
    expect(evalTree(ctx(makeResolve({})), node("AND", [])).hit).toBe(false);
  });
});
