// v0.71.0 可视化预警引擎：规则 / 条件树类型定义

/** 规则作用范围 */
export type Scope =
  | { kind: "code"; code: string }
  | { kind: "group"; groupId: number }
  | { kind: "all" };

/** 比较运算符 */
export type Op = ">=" | "<=" | ">" | "<" | "==" | "crossUp" | "crossDown";

/** 条件叶子（单个指标条件） */
export interface Leaf {
  id: string;
  field: string;
  op: Op;
  value: number;
  /** 指标周期 / 涨速窗口(秒) 等参数 */
  params?: Record<string, number>;
}

/** 条件树节点 */
export interface TreeNode {
  id: string;
  op: "AND" | "OR";
  children: (TreeNode | Leaf)[];
}

export type TreeItem = TreeNode | Leaf;

/** 触发动作 */
export interface AlertActions {
  notify: boolean; // 系统通知
  sound: boolean; // 声音
  popup: boolean; // 弹窗
  island: boolean; // 灵动岛联动
  openChart: boolean; // 自动打开 K线
  openBook: boolean; // 自动打开盘口
}

/** 静默时段（本地时间 "HH:MM"，可跨 0 点） */
export interface QuietRange {
  start: string;
  end: string;
}

/** v2 预警规则 */
export interface AlertRuleV2 {
  id: string;
  name: string;
  scope: Scope;
  tree: TreeNode;
  actions: AlertActions;
  tone: "auto" | "up" | "down";
  frequency: "once" | "daily" | "persistent";
  cooldownSec: number;
  quiet: QuietRange[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastFiredAt?: number;
}

export function isNode(item: TreeItem): item is TreeNode {
  return (item as TreeNode).children !== undefined;
}

export function isLeaf(item: TreeItem): item is Leaf {
  return (item as Leaf).field !== undefined;
}

export function newId(prefix = "t"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function newRuleId(): string {
  return `a_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 构造默认动作（默认系统通知 + 声音 + 灵动岛） */
export function defaultActions(): AlertActions {
  return {
    notify: true,
    sound: true,
    popup: false,
    island: true,
    openChart: false,
    openBook: false,
  };
}

/** 构造空 AND 根节点（含一个占位叶子） */
export function emptyTree(): TreeNode {
  return { id: newId("n"), op: "AND", children: [emptyLeaf("price", ">=")] };
}

export function emptyLeaf(field = "price", op: Op = ">="): Leaf {
  return { id: newId("l"), field, op, value: 0 };
}
