import { describe, it, expect } from "vitest";
import { planCut, QUICK_GLIDE_MS, OVERVIEW_GLIDE_MS } from "./director";
import { buildFrameGraph, type CardRect } from "./graph";

const VP = { w: 900, h: 720 };

function card(cardId: string, x: number, y: number, width: number, height: number): CardRect {
  return { cardId, x, y, width, height, headHeight: 32 };
}

describe("CutDirector 三幕切卡", () => {
  it("上下三卡：ACT1 离场全 via、ACT2 路过中间卡标题快速一瞟、ACT3 标题总览", () => {
    const cards = [
      card("a", 40, 200, 200, 300),
      card("c", 300, 200, 200, 300),
      card("b", 560, 200, 200, 300),
    ];
    const g = buildFrameGraph(cards, VP);
    const plan = planCut({
      graph: g,
      from: { x: 140, y: 216 }, // 旧卡标题中点
      targetCardId: "b" as never,
      entry: { x: 660, y: 216 }, // 新卡标题中点
      currentCardId: "a",
    });

    expect(plan.acts.length).toBe(3);
    const [act1, act2, act3] = plan.acts;

    // ACT1：沿旧卡边框离场，非空且全部 via
    expect(act1.points.length).toBeGreaterThan(0);
    expect(act1.points.every((p) => p.via)).toBe(true);

    // ACT2：经过中间卡 c 的标题中点 → 非 via、快速 glide，并登记 glideAt
    expect(plan.glideAt.has("c:hm")).toBe(true);
    const glidePt = act2.points.find((p) => p.anchor.id === "c:hm");
    expect(glidePt).toBeDefined();
    expect(glidePt!.via).toBeFalsy();
    expect(glidePt!.glideMs).toBe(QUICK_GLIDE_MS);

    // ACT3：末尾目标卡标题中点 b:hm 非 via、总览时长
    const last = act3.points[act3.points.length - 1];
    expect(last.anchor.id).toBe("b:hm");
    expect(last.via).toBeFalsy();
    expect(last.glideMs).toBe(OVERVIEW_GLIDE_MS);
  });

  it("首次切卡（无当前卡）：ACT1 为空，直接进入穿行/入场", () => {
    const cards = [card("b", 200, 200, 300, 200)];
    const g = buildFrameGraph(cards, VP);
    const plan = planCut({
      graph: g,
      from: { x: 100, y: 100 },
      targetCardId: "b" as never,
      entry: { x: 350, y: 216 },
      currentCardId: null,
    });
    expect(plan.acts[0].name).toBe("act1");
    expect(plan.acts[0].points.length).toBe(0);
  });

  it("三幕路径的非 via 点只出现在标题（中途快扫 / 目标总览），无数据区落脚点", () => {
    const cards = [
      card("a", 200, 40, 300, 150),
      card("c", 200, 250, 300, 150),
      card("b", 200, 460, 300, 150),
    ];
    const g = buildFrameGraph(cards, VP);
    const plan = planCut({
      graph: g,
      from: { x: 350, y: 120 },
      targetCardId: "b" as never,
      entry: { x: 350, y: 476 },
      currentCardId: "a",
    });
    const real = plan.acts.flatMap((a) => a.points).filter((p) => !p.via);
    expect(real.length).toBeGreaterThan(0);
    expect(real.every((p) => p.anchor.kind === "header")).toBe(true);
  });
});
