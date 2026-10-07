import { describe, it, expect } from "vitest";
import { packBento, packTiles } from "../../src/lib/layout";
import type { CardId } from "../../src/lib/cards";

// 方案 F · P1：packTiles 流体磁贴引擎
// 显式锚点固定落位、重叠向下让位；无锚点时 first-fit，与 packBento 输出一致。
function size(cw: number, ch: number) {
  return () => ({ w: cw, h: ch });
}
function none() {
  return undefined;
}

describe("packTiles 无显式锚点 → 与 packBento 一致", () => {
  it("chart 8×3 + radar 4×2 同行（与 packBento 输出相等）", () => {
    const cards: CardId[] = ["chart", "radar"];
    const a = packBento(cards, size(8, 3));
    const b = packTiles(cards, size(8, 3), none);
    expect(b.pos).toEqual(a.pos);
    expect(b.rows).toBe(a.rows);
  });

  it("三卡换行场景一致", () => {
    const cards: CardId[] = ["chart", "radar", "sector"];
    const a = packBento(cards, size(8, 3));
    const b = packTiles(cards, size(8, 3), none);
    expect(b.pos).toEqual(a.pos);
    expect(b.rows).toBe(a.rows);
  });
});

describe("packTiles 显式锚点落位", () => {
  it("chart 锚点 (5,1) → 从第 5 列起，右侧空 4 列", () => {
    const out = packTiles(["chart"], size(4, 2), () => ({ col: 5, row: 1 }));
    expect(out.pos.chart).toEqual({ col: 5, colEnd: 9, row: 1, rowEnd: 3 });
    expect(out.rows).toBe(2);
  });

  it("显式卡占位后，无锚点卡 first-fit 避开", () => {
    // chart 显式放 (7,1) 占 6 列；radar 4 列 first-fit → 从第 1 列起
    const out = packTiles(
      ["chart", "radar"],
      (id) => (id === "chart" ? { w: 6, h: 3 } : { w: 4, h: 2 }),
      (id) => (id === "chart" ? { col: 7, row: 1 } : undefined)
    );
    expect(out.pos.chart).toEqual({ col: 7, colEnd: 13, row: 1, rowEnd: 4 });
    expect(out.pos.radar.col).toBe(1);
    expect(out.pos.radar.row).toBe(1);
  });

  it("目标格被占 → 向下让位（流体），两两不重叠", () => {
    // a 显式 (1,1) 宽 8；b 也显式 (1,1) 宽 6 → b 下移到 a 底部
    const out = packTiles(
      ["a", "b"] as CardId[],
      (id) => (id === "a" ? { w: 8, h: 3 } : { w: 6, h: 2 }),
      (id) => ({ col: 1, row: 1 })
    );
    expect(out.pos.a).toEqual({ col: 1, colEnd: 9, row: 1, rowEnd: 4 });
    expect(out.pos.b.col).toBe(1);
    expect(out.pos.b.row).toBe(4);
    expect(out.pos.b.rowEnd).toBe(6);
  });

  it("列越界钳制：锚点 col=13 宽 4 → 落到第 9 列（12-4+1）", () => {
    const out = packTiles(["chart"], size(4, 2), () => ({ col: 13, row: 1 }));
    expect(out.pos.chart).toEqual({ col: 9, colEnd: 13, row: 1, rowEnd: 3 });
  });

  it("显式锚点空位被后续无锚点卡填充前，无重叠", () => {
    // chart 显式 (7,1) 6 列；radar 6 列 first-fit 在 (1,1)；两卡不重叠
    const out = packTiles(
      ["chart", "radar"],
      size(6, 3),
      (id) => (id === "chart" ? { col: 7, row: 1 } : undefined)
    );
    expect(out.pos.chart).toEqual({ col: 7, colEnd: 13, row: 1, rowEnd: 4 });
    expect(out.pos.radar).toEqual({ col: 1, colEnd: 7, row: 1, rowEnd: 4 });
  });
});
