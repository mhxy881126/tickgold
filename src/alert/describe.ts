// 规则 / 条件树的人类可读描述（列表展示用）
import type { Scope, TreeNode, Leaf, TreeItem } from "./types";
import { isNode } from "./types";
import { fieldSpec } from "./fields";

const OP_TEXT: Record<Leaf["op"], string> = {
  ">=": "≥",
  "<=": "≤",
  ">": ">",
  "<": "<",
  "==": "=",
  crossUp: "上穿",
  crossDown: "下破",
};

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

function paramSuffix(leaf: Leaf): string {
  if (!leaf.params) return "";
  if (leaf.params.period != null) return `(${leaf.params.period})`;
  if (leaf.params.windowSec != null)
    return `/${Math.round(leaf.params.windowSec / 60)}分`;
  return "";
}

/** 单个叶子文字 */
export function leafText(leaf: Leaf): string {
  const s = fieldSpec(leaf.field);
  const name = s?.label ?? leaf.field;
  const isEvent = s?.category === "event";
  if (isEvent) return name;
  const unit = s?.unit ?? "";
  return `${name}${paramSuffix(leaf)} ${OP_TEXT[leaf.op]} ${fmtNum(leaf.value)}${unit}`;
}

/** 整棵树的摘要（扁平列出，标注 AND/OR） */
export function treeSummary(node: TreeNode, depth = 0): string {
  const parts: string[] = [];
  for (const child of node.children) {
    if (isNode(child)) parts.push(`(${treeSummary(child, depth + 1)})`);
    else parts.push(leafText(child));
  }
  const joiner = node.op === "AND" ? " 且 " : " 或 ";
  void depth;
  return parts.join(joiner) || "无条件";
}

/** 统计叶子数量 */
export function countLeaves(item: TreeItem): number {
  if (!isNode(item)) return 1;
  return item.children.reduce((n, c) => n + countLeaves(c), 0);
}

/** 作用域文字 */
export function scopeText(scope: Scope, groupName?: (id: number) => string): string {
  if (scope.kind === "code") return scope.code;
  if (scope.kind === "group")
    return groupName ? groupName(scope.groupId) : `分组#${scope.groupId}`;
  return "全部自选";
}
