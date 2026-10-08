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
    const sim = new SpiderSim({ x: 0, y: 0 }, { speed: 70, dwellMs: 200 });
    sim.resetPath([pt(50, 0), pt(100, 0)]);
    let ev = sim.update(60, 0); // 单步推进（产品速度域，避免大 dt 跨整个步态周期）
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
    const sim = new SpiderSim({ x: 0, y: 0 }, { speed: 70, dwellMs: 50 });
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
    const sim = new SpiderSim({ x: 0, y: 0 }, { speed: 70, dwellMs: 50 });
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
      // @ts-expect-error 读私有腿状态验证对角分组互斥
      const byGroup = [0, 0];
      // @ts-expect-error 同上
      for (const l of sim.legs) if (l.lifting) byGroup[l.group]++;
      expect(byGroup[0]).toBeLessThanOrEqual(1);
      expect(byGroup[1]).toBeLessThanOrEqual(1);
    }
  });

  it("默认参数下多方向长距离行走：逻辑脚始终在骨链可达域内（不超伸/不滑步）", () => {
    // 回归：固定相位 trot 的参数自洽契约。渲染投影只是兜底，逻辑脚本身不得超骨长。
    const dirs = [
      { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 },
      { x: 1, y: 1 }, { x: -1, y: 1 }, { x: 0.7, y: -0.7 },
    ];
    for (const dv of dirs) {
      const sim = new SpiderSim({ x: 0, y: 0 });
      const maxReach = sim.l1 + sim.l2;
      const points = Array.from({ length: 40 }, (_, i) => {
        const x = dv.x * (i + 1) * 50;
        const y = dv.y * (i + 1) * 50;
        return { x, y, anchor: anchor(x, y, `6000${i}${dv.x}${dv.y}`), signal: null };
      });
      sim.resetPath(points);
      let frames = 0;
      for (let f = 0; f < 8000 && sim.active; f++) {
        sim.update(16, f * 16);
        frames++;
        // @ts-expect-error 读取私有腿状态验证可达域
        for (const l of sim.legs) {
          // @ts-expect-error 同上
          const hip = sim.hipWorld(l);
          expect(Math.hypot(l.foot.x - hip.x, l.foot.y - hip.y)).toBeLessThanOrEqual(maxReach);
        }
      }
      // 路径必须在帧预算内走完，否则上面的覆盖是空转
      expect(sim.active).toBe(false);
      expect(frames).toBeGreaterThan(0);
      // 到站后任何一帧都不得有脚冻结在摆动弧上
      sim.update(16, 8000 * 16);
      // @ts-expect-error 读私有腿状态
      expect(sim.legs.every((l: { lifting: boolean }) => !l.lifting)).toBe(true);
    }
  });
});

describe("SpiderSim 数据包", () => {
  it("BUY/SELL 驻留点产生数据包，普通扫描不产生", () => {
    const sim = new SpiderSim({ x: 0, y: 0 }, { speed: 70, dwellMs: 100, trailMs: 100, flyMs: 200 });
    const buy = pt(30, 0, "BUY");
    (buy.anchor as Anchor).code = "600248";
    buy.anchor.name = "大金重工"; buy.anchor.price = 47.61; buy.anchor.pct = 2.9;
    sim.resetPath([buy, pt(60, 0, null)]);
    let spawned = false;
    for (let i = 0; i < 200; i++) {
      const ev = sim.update(40, i * 40);
      if (ev.arrived && ev.arrived.signal) sim.spawnPacket(ev.arrived);
      if (sim.packets.length) spawned = true;
    }
    expect(spawned).toBe(true);
    expect(sim.packets[0].side).toBe("BUY");
  });

  it("数据包先 trailing 后 flying 并最终移除，完成事件带 code", () => {
    const sim = new SpiderSim({ x: 0, y: 0 }, { speed: 70, dwellMs: 40, trailMs: 80, flyMs: 120 });
    sim.setFlyTarget({ x: 500, y: 0 });
    const buy = pt(20, 0, "SELL");
    buy.anchor.code = "600094"; buy.anchor.name = "大名城"; buy.anchor.price = 4.34; buy.anchor.pct = -1.2;
    sim.resetPath([buy]);
    let done: string | null = null;
    let sawTrailing = false;
    let sawFlying = false;
    for (let i = 0; i < 200; i++) {
      const ev = sim.update(40, i * 40);
      if (ev.arrived) sim.spawnPacket(ev.arrived);
      if (sim.packets.some((p) => p.state === "trailing")) sawTrailing = true;
      if (sim.packets.some((p) => p.state === "flying")) sawFlying = true;
      if (ev.packetDone) done = ev.packetDone;
    }
    expect(sawTrailing).toBe(true);
    expect(sawFlying).toBe(true);
    expect(done).toBe("600094");
    expect(sim.packets).toHaveLength(0);
  });

  it("无信号/无代码不产生数据包；无桥时拖行包封顶 8 个", () => {
    const sim = new SpiderSim({ x: 0, y: 0 });
    sim.spawnPacket(pt(10, 0, null));
    const noCode = pt(10, 0, "BUY");
    noCode.anchor.code = undefined;
    sim.spawnPacket(noCode);
    expect(sim.packets).toHaveLength(0);
    // 不设 flyTarget，连续塞 12 个买入包，trailing 封顶 8
    for (let i = 0; i < 12; i++) {
      const p = pt(10 + i, 0, "BUY");
      p.anchor.code = `6000${i}`;
      sim.spawnPacket(p);
    }
    expect(sim.packets).toHaveLength(8);
    expect(sim.packets.every((p) => p.state === "trailing")).toBe(true);
  });
});
