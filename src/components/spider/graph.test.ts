import { describe, it, expect } from "vitest";
import {
  buildFrameGraph,
  findPath,
  LANE_PENALTY,
  type CardRect,
  type GraphNode,
} from "./graph";

const VP = { w: 1200, h: 800 };

function card(cardId: string, x: number, y: number, width: number, height: number): CardRect {
  return { cardId, x, y, width, height, headHeight: 32 };
}

/** 节点是否落在卡片「内容区」（标题栏以下的内部；标题栏/边框不算） */
function inContent(p: GraphNode, c: CardRect): boolean {
  const hh = c.headHeight ?? 32;
  return p.x > c.x + 1 && p.x < c.x + c.width - 1
    && p.y > c.y + hh + 1 && p.y < c.y + c.height - 1;
}

function pathHitsContent(path: GraphNode[], cards: CardRect[]): boolean {
  return path.some((n) => cards.some((c) => inContent(n, c)));
}

describe("CardFrameGraph 构建", () => {
  it("每张卡生成 11 个结构节点（标题3 + 角4 + 边中点4）", () => {
    const g = buildFrameGraph([card("a", 100, 100, 300, 200)], VP);
    const ofCard = g.nodes.filter((n) => n.cardId === "a");
    expect(ofCard.length).toBe(11);
    expect(g.nodes.filter((n) => n.kind === "head").length).toBe(3);
    expect(g.nodes.filter((n) => n.kind === "corner").length).toBe(4);
    expect(g.nodes.filter((n) => n.kind === "edge-mid").length).toBe(4);
  });

  it("卡片周长与标题栏边为结构边", () => {
    const g = buildFrameGraph([card("a", 100, 100, 300, 200)], VP);
    // 结构边数量 > 0，且卡片相关边均 structural
    const cardEdges = g.edges.filter((e) => e.a.startsWith("a:") && e.b.startsWith("a:"));
    expect(cardEdges.length).toBeGreaterThan(0);
    expect(cardEdges.every((e) => e.structural)).toBe(true);
  });

  it("屏幕兜底车道为非结构边且权重大（含 LANE_PENALTY）", () => {
    const g = buildFrameGraph([card("a", 100, 100, 300, 200)], VP);
    const laneEdges = g.edges.filter((e) => e.a.startsWith("lane:") && e.b.startsWith("lane:"));
    expect(laneEdges.length).toBe(8);
    expect(laneEdges.every((e) => !e.structural)).toBe(true);
    expect(laneEdges.every((e) => e.w >= LANE_PENALTY)).toBe(true);
  });

  it("相邻卡片（间距 60）生成间隙走廊 gap 节点", () => {
    const cards = [card("a", 100, 100, 300, 200), card("b", 100, 360, 300, 200)];
    const g = buildFrameGraph(cards, VP);
    const gaps = g.nodes.filter((n) => n.kind === "gap");
    expect(gaps.length).toBeGreaterThan(0);
  });

  it("相距过远（间距 > GAP_MAX）不直连间隙", () => {
    const cards = [card("a", 100, 100, 300, 200), card("b", 100, 600, 300, 200)];
    const g = buildFrameGraph(cards, VP);
    // 两卡之间不应有直接连接 a/b 的 gap
    const abGap = g.nodes.filter((n) => n.kind === "gap" && n.id.includes("a:b"));
    expect(abGap.length).toBe(0);
  });
});

describe("A* 寻路", () => {
  it("相邻卡片：路径全部落在结构节点上，不进入任何卡片内容区", () => {
    const cards = [card("a", 100, 100, 300, 200), card("b", 100, 360, 300, 200)];
    const g = buildFrameGraph(cards, VP);
    const path = findPath(g, { x: 250, y: 220 }, { x: 250, y: 460 });
    expect(path.length).toBeGreaterThan(0);
    expect(pathHitsContent(path, cards)).toBe(false);
  });

  it("直连被第三张卡横挡时绕行，路径仍不穿越内容区", () => {
    const cards = [
      card("a", 60, 100, 260, 160),
      card("b", 60, 520, 260, 160),
      card("block", 20, 300, 900, 80), // 横亘挡住 a→b 的垂直走廊
    ];
    const g = buildFrameGraph(cards, VP);
    const path = findPath(g, { x: 190, y: 180 }, { x: 190, y: 600 });
    expect(path.length).toBeGreaterThan(0);
    expect(pathHitsContent(path, cards)).toBe(false);
    // 路径必须绕行：经过挡卡外围结构节点（角/边框）或屏幕车道，而不是穿过挡卡内容区
    expect(path.some((n) => n.kind === "lane"
      || (n.cardId === "block" && (n.kind === "corner" || n.kind === "edge-mid")))).toBe(true);
  });

  it("只有一张卡时仍可寻路（车道兜底保证连通）", () => {
    const cards = [card("a", 200, 200, 400, 300)];
    const g = buildFrameGraph(cards, VP);
    const path = findPath(g, { x: 240, y: 240 }, { x: 560, y: 460 });
    expect(path.length).toBeGreaterThan(0);
  });

  it("空图返回空数组", () => {
    const g = buildFrameGraph([], VP);
    expect(findPath(g, { x: 0, y: 0 }, { x: 100, y: 100 })).toEqual([]);
  });
});
