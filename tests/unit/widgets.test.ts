import { describe, expect, it } from "vitest";
import {
  WIDGET_COLS,
  WIDGET_MAX_ROWS,
  cellsOverlap,
  clampH,
  clampW,
  findFreeCell,
  insertWidget,
  noOverlap,
  occupancy,
  packWidgets,
  removeWidget,
  reorderWidgets,
  resizeWidget,
  type WidgetInstance,
} from "../../src/lib/widgets";

function inst(
  id: string,
  w: number,
  h: number,
  x = 0,
  y = 0
): WidgetInstance {
  return { id, def: id, w, h, x, y };
}

describe("cellsOverlap / noOverlap", () => {
  it("仅在两矩形真正相交时为 true", () => {
    expect(cellsOverlap({ x: 0, y: 0, w: 4, h: 3 }, { x: 4, y: 0, w: 4, h: 3 })).toBe(false);
    expect(cellsOverlap({ x: 0, y: 0, w: 4, h: 3 }, { x: 3, y: 2, w: 4, h: 3 })).toBe(true);
    expect(cellsOverlap({ x: 0, y: 0, w: 4, h: 3 }, { x: 0, y: 3, w: 4, h: 3 })).toBe(false);
  });

  it("装箱后任意集合均无重叠", () => {
    const items = [
      inst("a", 8, 5),
      inst("b", 8, 5),
      inst("c", 12, 4),
      inst("d", 6, 3),
    ];
    const packed = packWidgets(items);
    expect(noOverlap(packed)).toBe(true);
  });
});

describe("packWidgets first-fit", () => {
  it("首个 12 宽单元独占首行，后续另起行", () => {
    const packed = packWidgets([inst("a", 12, 4), inst("b", 6, 3)]);
    expect(packed[0]!).toMatchObject({ x: 0, y: 0 });
    expect(packed[1]!).toMatchObject({ x: 0, y: 4 });
  });

  it("同行并排放置，超出宽度换行", () => {
    const packed = packWidgets([inst("a", 5, 3), inst("b", 7, 3), inst("c", 5, 3)]);
    expect(packed[0]!).toMatchObject({ x: 0, y: 0 });
    expect(packed[1]!).toMatchObject({ x: 5, y: 0 });
    // 5+7=12 已占满 → 新行
    expect(packed[2]!).toMatchObject({ x: 0, y: 3 });
  });

  it("保留每实例 w/h，越界尺寸被 clamp", () => {
    const packed = packWidgets([inst("a", 20, -3), inst("b", 4, 2)]);
    expect(packed[0]!.w).toBe(WIDGET_COLS);
    expect(packed[0]!.h).toBe(1);
    expect(noOverlap(packed)).toBe(true);
  });
});

describe("reorderWidgets 跨行换位", () => {
  const packed = packWidgets([
    inst("a", 12, 4), // y=0 全宽
    inst("b", 6, 3),  // y=4, x=0
    inst("c", 6, 3),  // y=4, x=6
  ]);

  it("把末尾单元移到首位后重新装箱、无重叠", () => {
    const next = reorderWidgets(packed, "c", 0);
    expect(next.map((i) => i.id)).toEqual(["c", "a", "b"]);
    expect(noOverlap(next)).toBe(true);
  });

  it("索引越界被收敛；未知 id 原样返回", () => {
    const next = reorderWidgets(packed, "b", 99);
    expect(next.map((i) => i.id)).toEqual(["a", "c", "b"]);
    expect(noOverlap(next)).toBe(true);
    expect(reorderWidgets(packed, "zzz", 0)).toBe(packed);
  });
});

describe("resizeWidget clamp", () => {
  const def = { minW: 4, minH: 3 };

  it("下限不小于 def 最小跨度", () => {
    const r = resizeWidget(inst("a", 8, 5), def, 1, 1);
    expect(r.w).toBe(4);
    expect(r.h).toBe(3);
  });

  it("上限不超过网格（12 列 / 60 行）并四舍五入", () => {
    const r = resizeWidget(inst("a", 8, 5), def, 30.4, 99.6);
    expect(r.w).toBe(WIDGET_COLS);
    expect(r.h).toBe(WIDGET_MAX_ROWS);
  });

  it("clampW/clampH 独立校验", () => {
    expect(clampW(0)).toBe(1);
    expect(clampW(13)).toBe(12);
    expect(clampH(0)).toBe(1);
    expect(clampH(61)).toBe(60);
  });
});

describe("insertWidget / removeWidget", () => {
  it("插入到指定索引并重新装箱", () => {
    const base = packWidgets([inst("a", 12, 4), inst("b", 6, 3)]);
    const next = insertWidget(base, { id: "c", def: "c", w: 6, h: 3 }, 1);
    expect(next.map((i) => i.id)).toEqual(["a", "c", "b"]);
    expect(noOverlap(next)).toBe(true);
  });

  it("删除指定实例", () => {
    expect(removeWidget([inst("a", 1, 1), inst("b", 1, 1)], "a").map((i) => i.id)).toEqual(["b"]);
  });
});

describe("occupancy / findFreeCell", () => {
  it("占用矩阵与实例覆盖一致", () => {
    const occ = occupancy([{ x: 0, y: 0, w: 2, h: 2 }]);
    expect(occ[0]![0]).toBe(true);
    expect(occ[0]![2]).toBe(false);
    expect(occ[2]![0]).toBe(false);
  });

  it("网格填满时返回越界 y 哨兵", () => {
    const occ = occupancy([{ x: 0, y: 0, w: 12, h: 60 }]);
    expect(findFreeCell(occ, 1, 1)).toEqual({ x: 0, y: WIDGET_MAX_ROWS });
  });

  it("能在已有占用旁找到空位", () => {
    const occ = occupancy([{ x: 0, y: 0, w: 6, h: 3 }]);
    expect(findFreeCell(occ, 6, 3)).toEqual({ x: 6, y: 0 });
  });
});
