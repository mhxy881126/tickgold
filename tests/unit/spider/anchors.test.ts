import { describe, it, expect } from "vitest";
import { rectsToAnchors, type AnchorRect } from "../../../src/components/spider/anchors";

const quotes = {
  "600248": { name: "大金重工", price: 47.61, pct: 2.9 },
  "600094": { name: "大名城", price: 4.34, pct: 3.6 },
};

function rect(over: Partial<AnchorRect>): AnchorRect {
  return { x: 10, y: 10, width: 200, height: 30, ...over };
}

describe("rectsToAnchors", () => {
  it("丢弃宽高为 0 与视口外的行", () => {
    const out = rectsToAnchors(
      "watch",
      [
        rect({ code: "A", x: 0, y: 0, width: 0, height: 30 }),
        rect({ code: "B", x: 0, y: 100, width: 200, height: 30 }),
        rect({ code: "C", x: -500, y: 10, width: 200, height: 30 }),
        rect({ code: "D", x: 10, y: 5000, width: 200, height: 30 }),
      ],
      { w: 1280, h: 800 },
      {},
    );
    expect(out.map((a) => a.code)).toEqual(["B"]);
  });

  it("锚点落在行左缘垂直居中，带整行矩形供高亮", () => {
    const [a] = rectsToAnchors(
      "watch",
      [rect({ code: "600248", x: 100, y: 200, width: 300, height: 32 })],
      { w: 1280, h: 800 },
      quotes,
    );
    expect(a.x).toBe(108); // 100 + EDGE_PAD(8)
    expect(a.y).toBe(216);
    expect(a.width).toBe(300);
    expect(a.height).toBe(32);
  });

  it("按代码关联行情（价格/涨跌幅/名称）并生成稳定 id", () => {
    const [a] = rectsToAnchors(
      "watch",
      [rect({ code: "600248" })],
      { w: 1280, h: 800 },
      quotes,
    );
    expect(a.name).toBe("大金重工");
    expect(a.price).toBe(47.61);
    expect(a.pct).toBe(2.9);
    expect(a.id).toBe("watch:600248");
  });

  it("无代码的锚点用序号 id，名称缺失不报错", () => {
    const out = rectsToAnchors(
      "radar",
      [rect({}), rect({})],
      { w: 1280, h: 800 },
      {},
    );
    expect(out[0].id).toBe("radar:0");
    expect(out[1].id).toBe("radar:1");
  });
});
