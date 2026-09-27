import { describe, it, expect } from "vitest";
import { packFree, rectsOverlap, settleFreeRects, type FreeRect } from "../../src/lib/layout";

function r(x: number, y: number, w: number, h: number): FreeRect {
  return { x, y, w, h };
}

describe("packFree 自由布局初始装箱", () => {
  it("空卡片 → 空对象", () => {
    expect(packFree([])).toEqual({});
  });

  it("单卡 chart 从原点摆放（w8,h5）", () => {
    expect(packFree(["chart"])).toEqual({ chart: r(0, 0, 8, 5) });
  });

  it("两张窄卡同行并排，x 累加", () => {
    // radar w4 + breadth w4 = 8 ≤ 12，同一行，行高 3
    const out = packFree(["radar", "breadth"]);
    expect(out.radar).toEqual(r(0, 0, 4, 3));
    expect(out.breadth).toEqual(r(4, 0, 4, 3));
  });

  it("超出 12 列则换行，y 累加行高", () => {
    // chart w8 + sectorheat w8 = 16 > 12，第二张换行；行高均为 5
    const out = packFree(["chart", "sectorheat"]);
    expect(out.chart).toEqual(r(0, 0, 8, 5));
    expect(out.sectorheat).toEqual(r(0, 5, 8, 5));
  });

  it("同一行高度取该行最高卡（矮卡被拉伸）", () => {
    // radar h3 + sector h4 同行（4+6=10 ≤12），行高 4
    const out = packFree(["radar", "sector"]);
    expect(out.radar).toEqual(r(0, 0, 4, 4));
    expect(out.sector).toEqual(r(4, 0, 6, 4));
  });
});

describe("rectsOverlap 矩形相交判定", () => {
  it("边界相接（x 方向）不算重叠", () => {
    expect(rectsOverlap(r(0, 0, 4, 3), r(4, 0, 4, 3))).toBe(false);
  });
  it("边界相接（y 方向）不算重叠", () => {
    expect(rectsOverlap(r(0, 0, 4, 3), r(0, 3, 4, 3))).toBe(false);
  });
  it("x 方向有正重叠 → true", () => {
    expect(rectsOverlap(r(0, 0, 4, 3), r(3, 0, 4, 3))).toBe(true);
  });
  it("y 方向有正重叠 → true", () => {
    expect(rectsOverlap(r(0, 0, 4, 3), r(0, 2, 4, 3))).toBe(true);
  });
  it("完全分离 → false", () => {
    expect(rectsOverlap(r(0, 0, 4, 3), r(10, 10, 2, 2))).toBe(false);
  });
});

describe("settleFreeRects 碰撞推开", () => {
  it("两张完全重叠的卡，调用后上下排开、不再重叠", () => {
    const rects = { a: r(0, 0, 4, 3), b: r(0, 0, 4, 3) };
    settleFreeRects(rects);
    expect(rects.b.y).toBe(3);
    expect(rectsOverlap(rects.a, rects.b)).toBe(false);
  });

  it("多张重叠卡收敛后两两不重叠（只向下推）", () => {
    const rects = { a: r(0, 0, 4, 3), b: r(0, 0, 4, 3), c: r(0, 0, 4, 3) };
    settleFreeRects(rects);
    const ids = Object.keys(rects);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        expect(rectsOverlap(rects[ids[i]], rects[ids[j]])).toBe(false);
    // y 坐标单调向下
    expect(rects.a.y).toBe(0);
    expect(rects.b.y).toBe(3);
    expect(rects.c.y).toBe(6);
  });
});
