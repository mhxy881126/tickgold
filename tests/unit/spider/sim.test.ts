import { describe, it, expect } from "vitest";
import { SpiderSim, type ScanPoint } from "../../../src/components/spider/sim";
import type { Anchor } from "../../../src/components/spider/anchors";

function anchor(x: number, y: number, code = "600248"): Anchor {
  return { id: `watch:${code}`, cardId: "watch", x, y, width: 200, height: 30, code };
}
function pt(x: number, y: number, signal: ScanPoint["signal"] = null): ScanPoint {
  return { x, y, anchor: anchor(x, y), signal };
}

describe("SpiderSim 身体移动", () => {
  it("无路径时静止", () => {
    const sim = new SpiderSim({ x: 100, y: 100 });
    const ev = sim.update(100, 0);
    expect(sim.body).toEqual({ x: 100, y: 100 });
    expect(ev.arrived).toBeNull();
    expect(sim.active).toBe(false);
  });

  it("沿路径移动并在终点驻留，到达时事件带当前点", () => {
    const sim = new SpiderSim({ x: 0, y: 0 }, { speed: 100, dwellMs: 200 });
    sim.resetPath([pt(50, 0), pt(100, 0)]);
    let ev = sim.update(500, 0); // 0.5s 走完 50px 以上
    expect(sim.active).toBe(true);
    // 推进到第一个点
    let guard = 0;
    while (!ev.arrived && guard++ < 50) ev = sim.update(60, guard * 60);
    expect(ev.arrived?.x).toBe(50);
    expect(sim.current?.x).toBe(50);
    // 驻留期间身体停在目标附近
    const before = { ...sim.body };
    sim.update(100, 1000);
    expect(Math.abs(sim.body.x - before.x)).toBeLessThan(2);
  });

  it("驻留结束后自动推进到下一点，全部走完 active=false", () => {
    const sim = new SpiderSim({ x: 0, y: 0 }, { speed: 200, dwellMs: 50 });
    sim.resetPath([pt(40, 0), pt(80, 0)]);
    let last: number | null = null;
    for (let i = 0; i < 200; i++) {
      const ev = sim.update(50, i * 50);
      if (ev.arrived) last = ev.arrived.x;
    }
    expect(last).toBe(80);
    expect(sim.active).toBe(false);
    expect(sim.current).toBeNull();
  });

  it("via 中途点不驻留，直接通过且不产生 arrived", () => {
    const sim = new SpiderSim({ x: 0, y: 0 }, { speed: 200, dwellMs: 50 });
    sim.resetPath([
      { x: 40, y: 0, anchor: anchor(40, 0, "via1"), signal: null, via: true },
      pt(80, 0),
    ]);
    const arrivedX: number[] = [];
    for (let i = 0; i < 200; i++) {
      const ev = sim.update(50, i * 50);
      if (ev.arrived) arrivedX.push(ev.arrived.x);
    }
    expect(arrivedX).toEqual([80]);
  });
});

describe("SpiderSim 步态", () => {
  it("渲染始终返回 8 条腿且两段长度守恒", () => {
    const sim = new SpiderSim({ x: 0, y: 0 });
    sim.resetPath([pt(200, 0)]);
    for (let i = 0; i < 10; i++) sim.update(50, i * 50);
    const legs = sim.legsForRender();
    expect(legs).toHaveLength(8);
    for (const l of legs) {
      const d1 = Math.hypot(l.knee.x - l.hip.x, l.knee.y - l.hip.y);
      const d2 = Math.hypot(l.foot.x - l.knee.x, l.foot.y - l.knee.y);
      expect(d1).toBeCloseTo(sim.l1, 5);
      expect(d2).toBeCloseTo(sim.l2, 5);
    }
  });

  it("同一时刻同一步态组至多 1 腿离地，全局至多 2 腿", () => {
    const sim = new SpiderSim({ x: 0, y: 0 });
    sim.resetPath([pt(400, 0)]);
    for (let i = 0; i < 120; i++) {
      sim.update(30, i * 30);
      const lifting = sim.legsForRender().filter((l) => l.lifting);
      expect(lifting.length).toBeLessThanOrEqual(2);
    }
  });
});
