import { describe, it, expect } from "vitest";
import { packBento } from "../../src/lib/layout";

type Size = { w: number; h: number };
function sizer(map: Record<string, Size>) {
  return (id: string): Size => map[id] ?? { w: 3, h: 2 };
}

// 收集一次排布占用的所有网格单元，用于断言"无重叠"
function occupiedCells(cards: string[], pos: Record<string, { col: number; colEnd: number; row: number; rowEnd: number }>) {
  const cells = new Set<string>();
  for (const id of cards) {
    const p = pos[id];
    for (let y = p.row; y < p.rowEnd; y++)
      for (let x = p.col; x < p.colEnd; x++) {
        const key = `${x},${y}`;
        if (cells.has(key)) return key; // 返回首个冲突单元
        cells.add(key);
      }
  }
  return null;
}

describe("packBento 12 列 first-fit 装箱", () => {
  it("空卡片：rows=1、pos 为空", () => {
    const r = packBento([], sizer({}));
    expect(r.rows).toBe(1);
    expect(r.pos).toEqual({});
  });

  it("单卡从左上角 (col=1,row=1) 摆放", () => {
    const r = packBento(["chart"], sizer({ chart: { w: 6, h: 3 } }));
    expect(r.pos.chart).toEqual({ col: 1, colEnd: 7, row: 1, rowEnd: 4 });
    expect(r.rows).toBe(3);
  });

  it("两张半宽卡并排在第一行", () => {
    const r = packBento(["a", "b"], sizer({ a: { w: 6, h: 3 }, b: { w: 6, h: 3 } }));
    expect(r.pos.a).toEqual({ col: 1, colEnd: 7, row: 1, rowEnd: 4 });
    expect(r.pos.b).toEqual({ col: 7, colEnd: 13, row: 1, rowEnd: 4 });
    expect(r.rows).toBe(3);
  });

  it("当前行剩余宽度放不下时换行", () => {
    // a 宽 8（占列1–9），b 宽 8：第一行仅剩 3 列放不下，b 落到下一行
    const r = packBento(["a", "b"], sizer({ a: { w: 8, h: 2 }, b: { w: 8, h: 2 } }));
    expect(r.pos.a).toEqual({ col: 1, colEnd: 9, row: 1, rowEnd: 3 });
    expect(r.pos.b).toEqual({ col: 1, colEnd: 9, row: 3, rowEnd: 5 });
    expect(r.rows).toBe(4);
  });

  it("宽度越界被裁剪到 12，最小为 1", () => {
    const r = packBento(["big"], sizer({ big: { w: 99, h: 2 } }));
    expect(r.pos.big.col).toBe(1);
    expect(r.pos.big.colEnd).toBe(13);
  });

  it("多张不同尺寸卡排布后无任何网格单元重叠", () => {
    const cards = ["a", "b", "c", "d", "e"];
    const r = packBento(cards, sizer({
      a: { w: 4, h: 2 }, b: { w: 4, h: 2 }, c: { w: 4, h: 2 },
      d: { w: 8, h: 3 }, e: { w: 6, h: 2 },
    }));
    expect(occupiedCells(cards, r.pos)).toBeNull();
    // 每张卡都应被放置
    for (const id of cards) expect(r.pos[id]).toBeDefined();
  });
});
