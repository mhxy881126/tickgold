import { describe, it, expect } from "vitest";
import { ref } from "vue";
import { packFree, rectsOverlap, settleFreeRects, type FreeRect } from "../../src/lib/layout";
import { useFreeLayout } from "../../src/composables/workbench/useFreeLayout";
import type { CardId } from "../../src/lib/cards";

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
    // radar w4 + news w4（默认尺寸）= 8 ≤ 12，同一行，行高 3
    const out = packFree(["radar", "news"]);
    expect(out.radar).toEqual(r(0, 0, 4, 3));
    expect(out.news).toEqual(r(4, 0, 4, 3));
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

// 方案 E · P0：freeResize —— 自由布局缩放手柄写回 freeRects，拖大后自动碰撞推开
describe("freeResize 自由布局缩放", () => {
  function make() {
    const openCards = ref<CardId[]>(["chart", "radar"]);
    const timeMode = ref<string | null>(null);
    const fl = useFreeLayout({ openCards, timeMode, pushUndo: () => {} });
    fl.enableFree();
    return { fl, openCards };
  }

  it("缩小不触发碰撞：chart 6×4 保留锚点，radar 不动", () => {
    const { fl } = make();
    fl.freeResize("chart", 6, 4);
    expect(fl.freeRects.value.chart).toEqual(r(0, 0, 6, 4));
    expect(fl.freeRects.value.radar).toEqual(r(8, 0, 4, 5));
  });

  it("拖大压到右侧卡：自动把雷达向下推，两两不重叠", () => {
    const { fl } = make();
    fl.freeResize("chart", 10, 4);
    expect(fl.freeRects.value.chart).toEqual(r(0, 0, 10, 4));
    expect(fl.freeRects.value.radar).toEqual(r(8, 4, 4, 5));
    expect(rectsOverlap(fl.freeRects.value.chart, fl.freeRects.value.radar)).toBe(false);
  });

  it("越界钳制：w/h 上限 12/30、下限 1/1", () => {
    const { fl } = make();
    fl.freeResize("chart", 99, 99);
    expect(fl.freeRects.value.chart).toEqual(r(0, 0, 12, 30));
    fl.freeResize("chart", 0, 0);
    expect(fl.freeRects.value.chart).toEqual(r(0, 0, 1, 1));
  });

  it("尺寸未变化 → 不写回（引用不变）", () => {
    const { fl } = make();
    const before = fl.freeRects.value.chart;
    fl.freeResize("chart", 8, 5);
    expect(fl.freeRects.value.chart).toBe(before);
  });

  it("未开启的卡 id → 无操作不报错", () => {
    const { fl } = make();
    expect(() => fl.freeResize("news", 6, 4)).not.toThrow();
  });

  it("NaN 尺寸（0 视口等边界）→ 拒绝写入，状态不变", () => {
    const { fl } = make();
    const before = JSON.parse(JSON.stringify(fl.freeRects.value));
    fl.freeResize("chart", Number.NaN, 4);
    fl.freeResize("chart", 6, Number.NaN);
    fl.freeResize("chart", Number.NaN, Number.NaN);
    expect(fl.freeRects.value).toEqual(before);
  });
});
