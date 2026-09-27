// 条件树评估纯函数：递归 AND/OR，支持标量运算与上穿/下破边沿
import type { Leaf, TreeNode, TreeItem } from "./types";
import { isNode } from "./types";

/** 叶子当前值 / 上一轮值（边沿判定用；null 表示数据缺失或首轮） */
export type Resolve = (leaf: Leaf) => { cur: number | null; prev: number | null };

export interface EvalCtx {
  now: number;
  code: string;
  resolve: Resolve;
}

export interface LeafHit {
  leaf: Leaf;
  actual: number;
}

export interface EvalResult {
  hit: boolean;
  matched: LeafHit[];
}

function compare(leaf: Leaf, cur: number): boolean {
  const v = leaf.value;
  switch (leaf.op) {
    case ">=":
      return cur >= v;
    case "<=":
      return cur <= v;
    case ">":
      return cur > v;
    case "<":
      return cur < v;
    case "==":
      return cur === v;
    default:
      return false;
  }
}

/** 评估单个叶子。crossUp/crossDown 需要上一轮值，首轮不触发。 */
export function evalLeaf(ctx: EvalCtx, leaf: Leaf): LeafHit | null {
  const { cur, prev } = ctx.resolve(leaf);
  if (cur == null) return null;

  if (leaf.op === "crossUp") {
    if (prev != null && prev < leaf.value && cur >= leaf.value) {
      return { leaf, actual: cur };
    }
    return null;
  }
  if (leaf.op === "crossDown") {
    if (prev != null && prev > leaf.value && cur <= leaf.value) {
      return { leaf, actual: cur };
    }
    return null;
  }
  return compare(leaf, cur) ? { leaf, actual: cur } : null;
}

export function evalTree(ctx: EvalCtx, node: TreeNode): EvalResult {
  const matched: LeafHit[] = [];
  let allHit = true;
  let anyHit = false;

  for (const item of node.children) {
    const r = evalItem(ctx, item);
    if (r.hit) anyHit = true;
    else allHit = false;
    if (r.matched.length > 0) matched.push(...r.matched);
  }

  // AND：所有子项命中；OR：任一子项命中。
  // 数据缺失的叶子不命中，因此 AND 下缺数据自然不成立。
  const hit = node.op === "AND" ? allHit && node.children.length > 0 : anyHit;
  return { hit, matched: dedupe(matched) };
}

function evalItem(ctx: EvalCtx, item: TreeItem): EvalResult {
  if (isNode(item)) return evalTree(ctx, item);
  const h = evalLeaf(ctx, item);
  return { hit: !!h, matched: h ? [h] : [] };
}

function dedupe(hits: LeafHit[]): LeafHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = h.leaf.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
