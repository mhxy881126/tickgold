// 微件协议与卡内布局纯函数。
// 微件 = 卡内 12 列网格中的一个单元；只接收 { bind? }，数据来自注入的行情上下文。
// 本文件不依赖 Vue（除类型），便于单测。
import type { Component } from "vue";

export const WIDGET_COLS = 12;
export const WIDGET_MAX_ROWS = 60;

export type WidgetBinding = "stock" | "none" | "optional-stock";

export interface WidgetDef {
  id: string;
  title: string;
  component: Component;
  minW: number;
  minH: number;
  defaultW: number;
  defaultH: number;
  binding: WidgetBinding;
  singleton?: boolean;
}

// 运行时实例（序列化为卡片快照的一部分）
export interface WidgetInstance {
  id: string; // 实例唯一 id（同卡）
  def: string; // WidgetDef.id
  w: number;
  h: number;
  x: number;
  y: number;
  bind?: string | null; // 绑定股票代码（覆盖卡级绑定）
  text?: string | null; // text-note 文字内容（其余微件忽略）
}

export interface CardWidgets {
  primary?: string | null; // 卡主标的（覆盖全局 selected）
  items: WidgetInstance[];
}

// ===== 几何工具 =====
export interface Cell { x: number; y: number; w: number; h: number }

export function cellsOverlap(a: Cell, b: Cell): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

// 占用矩阵：根据实例集合生成（用于碰撞检测/无重叠校验）
export function occupancy(
  items: Pick<WidgetInstance, "x" | "y" | "w" | "h">[],
  rows: number = WIDGET_MAX_ROWS
): boolean[][] {
  const occ: boolean[][] = Array.from({ length: rows }, () =>
    Array(WIDGET_COLS).fill(false)
  );
  for (const it of items) {
    for (let y = it.y; y < it.y + it.h; y++)
      for (let x = it.x; x < it.x + it.w; x++)
        if (y >= 0 && y < rows && x >= 0 && x < WIDGET_COLS) occ[y]![x] = true;
  }
  return occ;
}

export function noOverlap(items: Cell[]): boolean {
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (cellsOverlap(items[i]!, items[j]!)) return false;
  return true;
}

// 在占用矩阵中为 w×h 寻找首个空位（first-fit，动态行）
export function findFreeCell(
  occ: boolean[][],
  w: number,
  h: number
): { x: number; y: number } {
  for (let y = 0; y <= occ.length - h; y++) {
    for (let x = 0; x + w <= WIDGET_COLS; x++) {
      let ok = true;
      for (let dy = 0; dy < h && ok; dy++)
        for (let dx = 0; dx < w; dx++) if (occ[y + dy]![x + dx]) { ok = false; break; }
      if (ok) return { x, y };
    }
  }
  return { x: 0, y: WIDGET_MAX_ROWS };
}

function mark(occ: boolean[][], c: Cell) {
  for (let y = c.y; y < c.y + c.h; y++)
    for (let x = c.x; x < c.x + c.w; x++)
      if (occ[y] && occ[y]![x] !== undefined) occ[y]![x] = true;
}

// 按给定顺序重排：保留每实例 w/h，重新 first-fit 装箱（无重叠、整数网格线）
export function packWidgets(items: WidgetInstance[]): WidgetInstance[] {
  const occ = occupancy([]);
  return items.map((it) => {
    const w = clampW(it.w);
    const h = clampH(it.h);
    const pos = findFreeCell(occ, w, h);
    mark(occ, { ...pos, w, h });
    return { ...it, x: pos.x, y: pos.y, w, h };
  });
}

export function clampW(w: number): number {
  return Math.max(1, Math.min(WIDGET_COLS, Math.round(w)));
}
export function clampH(h: number): number {
  return Math.max(1, Math.min(WIDGET_MAX_ROWS, Math.round(h)));
}

// resize：clamp 到该 def 的 minW/minH 与网格边界；不改 x/y（调用方负责碰撞）
export function resizeWidget(
  inst: WidgetInstance,
  def: Pick<WidgetDef, "minW" | "minH">,
  w: number,
  h: number
): WidgetInstance {
  return {
    ...inst,
    w: Math.max(def.minW, Math.min(WIDGET_COLS, Math.round(w))),
    h: Math.max(def.minH, Math.min(WIDGET_MAX_ROWS, Math.round(h))),
  };
}

// 移动实例并 clamp 到网格内（不改尺寸）
export function moveWidget(inst: WidgetInstance, x: number, y: number): WidgetInstance {
  return {
    ...inst,
    x: Math.max(0, Math.min(WIDGET_COLS - inst.w, Math.round(x))),
    y: Math.max(0, Math.min(WIDGET_MAX_ROWS - inst.h, Math.round(y))),
  };
}

// 重排：把 srcId 移动到目标索引，再按顺序装箱（保留尺寸）
export function reorderWidgets(
  items: WidgetInstance[],
  srcId: string,
  index: number
): WidgetInstance[] {
  const src = items.find((i) => i.id === srcId);
  if (!src) return items;
  const rest = items.filter((i) => i.id !== srcId);
  const at = Math.max(0, Math.min(rest.length, index));
  const next = [...rest.slice(0, at), src, ...rest.slice(at)];
  return packWidgets(next);
}

// 删除实例（保留其余实例位置；空集合交由调用方决定是否移除整个 widgets）
export function removeWidget(items: WidgetInstance[], id: string): WidgetInstance[] {
  return items.filter((i) => i.id !== id);
}

// 新增实例：放到指定索引（缺省末尾），自动找空位
export function insertWidget(
  items: WidgetInstance[],
  inst: Omit<WidgetInstance, "x" | "y">,
  index?: number
): WidgetInstance[] {
  const made: WidgetInstance = { ...inst, x: 0, y: 0 };
  const at = index === undefined ? items.length : Math.max(0, Math.min(items.length, index));
  const next = [...items.slice(0, at), made, ...items.slice(at)];
  return packWidgets(next);
}

let seq = 0;
export function makeWidgetId(defId: string): string {
  seq += 1;
  return `w_${defId}_${Date.now().toString(36)}_${seq}`;
}
