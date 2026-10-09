import { describe, it, expect } from "vitest";
import {
  add, sub, scale, len, dist, lerp, angleOf, rotate, clamp,
  twoBoneKnee, quad, buildHips, shouldStep, restTarget, buildWaypoints,
  edgeLane, edgeRoute, roamPath,
  type Vec2,
} from "../../../src/components/spider/ik";

describe("ik 向量", () => {
  it("加减乘长度", () => {
    expect(add({ x: 1, y: 2 }, { x: 3, y: -2 })).toEqual({ x: 4, y: 0 });
    expect(sub({ x: 4, y: 0 }, { x: 1, y: 2 })).toEqual({ x: 3, y: -2 });
    expect(scale({ x: 2, y: -4 }, 0.5)).toEqual({ x: 1, y: -2 });
    expect(len({ x: 3, y: 4 })).toBe(5);
    expect(dist({ x: 0, y: 0 }, { x: 0, y: -3 })).toBe(3);
  });

  it("lerp 端点与中点", () => {
    expect(lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0)).toEqual({ x: 0, y: 0 });
    expect(lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({ x: 5, y: 10 });
    expect(lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 1)).toEqual({ x: 10, y: 20 });
  });

  it("rotate 90 度与保长", () => {
    expect(angleOf({ x: 0, y: -1 })).toBeCloseTo(-Math.PI / 2);
    const r = rotate({ x: 1, y: 0 }, Math.PI / 2);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(1);
    expect(len(r)).toBeCloseTo(1);
  });

  it("clamp 边界", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});

describe("twoBoneKnee 两段 IK", () => {
  const hip: Vec2 = { x: 0, y: 0 };
  const l1 = 10, l2 = 10;

  it("膝到髋、膝到脚两段长度守恒", () => {
    const foot: Vec2 = { x: 16, y: 0 };
    for (const bend of [1, -1] as const) {
      const k = twoBoneKnee(hip, foot, l1, l2, bend);
      expect(dist(hip, k)).toBeCloseTo(10, 6);
      expect(dist(k, foot)).toBeCloseTo(10, 6);
    }
  });

  it("左右 bend 膝关节分居目标连线两侧", () => {
    const foot: Vec2 = { x: 12, y: 4 };
    const k1 = twoBoneKnee(hip, foot, l1, l2, 1);
    const k2 = twoBoneKnee(hip, foot, l1, l2, -1);
    // 叉积符号相反
    const cross = (k: Vec2) => foot.x * k.y - foot.y * k.x;
    expect(Math.sign(cross(k1))).toBe(-Math.sign(cross(k2)));
    expect(cross(k1)).not.toBe(0);
  });

  it("脚与髋重合（距离 0）不返回 NaN", () => {
    const k = twoBoneKnee(hip, hip, l1, l2, 1);
    expect(Number.isFinite(k.x)).toBe(true);
    expect(Number.isFinite(k.y)).toBe(true);
    expect(dist(hip, k)).toBeCloseTo(10, 6);
  });

  it("脚超过骨长总和时被钳制，仍闭合", () => {
    const foot: Vec2 = { x: 100, y: 0 };
    const k = twoBoneKnee(hip, foot, l1, l2, 1);
    expect(dist(hip, k)).toBeCloseTo(10, 6);
    expect(dist(k, foot)).toBeGreaterThan(19.9); // 已钳到接近伸直
  });
});

describe("quad 二次贝塞尔", () => {
  it("端点正确且中点被控制点拉偏", () => {
    const a: Vec2 = { x: 0, y: 0 }, b: Vec2 = { x: 0, y: -10 }, c: Vec2 = { x: 10, y: 0 };
    expect(quad(a, b, c, 0)).toEqual(a);
    expect(quad(a, b, c, 1)).toEqual(c);
    const m = quad(a, b, c, 0.5);
    expect(m.x).toBeCloseTo(2.5); // 0.25*10
    expect(m.y).toBeCloseTo(-5);
  });
});

describe("buildHips 8 腿配置", () => {
  it("8 腿、左右各 4、每组 4 腿对角分布", () => {
    const hips = buildHips();
    expect(hips).toHaveLength(8);
    expect(hips.filter((h) => h.side === -1)).toHaveLength(4);
    expect(hips.filter((h) => h.side === 1)).toHaveLength(4);
    expect(hips.filter((h) => h.group === 0)).toHaveLength(4);
    expect(hips.filter((h) => h.group === 1)).toHaveLength(4);
  });

  it("髋点为放大后坐标（最宽 ±22、最前/最后 ±20）", () => {
    const hips = buildHips();
    expect(Math.max(...hips.map((h) => Math.abs(h.ox)))).toBe(22);
    expect(Math.max(...hips.map((h) => Math.abs(h.oy)))).toBe(20);
  });
});

describe("边缘车道漫游", () => {
  const size = { w: 1000, h: 600 };
  const onLane = (p: Vec2, pad = 52) =>
    p.x === pad || p.x === 1000 - pad || p.y === pad || p.y === 600 - pad;

  it("edgeLane 内缩矩形周长正确", () => {
    const lane = edgeLane(size, 52);
    expect(lane.w).toBe(1000 - 104);
    expect(lane.h).toBe(600 - 104);
    expect(lane.per).toBe(2 * (lane.w + lane.h));
  });

  it("edgeRoute 近距返回空、远距路径点全在车道上", () => {
    expect(edgeRoute({ x: 100, y: 300 }, { x: 200, y: 300 }, size)).toHaveLength(0);
    const route = edgeRoute({ x: 100, y: 100 }, { x: 900, y: 500 }, size);
    expect(route.length).toBeGreaterThan(1);
    // 除端点投影外都在车道上；首点为 from 的车道投影
    expect(route.every((p) => onLane(p))).toBe(true);
    // 路径不穿过屏幕中央
    expect(route.some((p) => Math.abs(p.x - 500) < 60 && Math.abs(p.y - 300) < 60)).toBe(false);
  });

  it("roamPath 有界、采样点落在车道且至少含若干点", () => {
    const roam = roamPath({ x: 500, y: 300 }, size, { distance: 700, spacing: 200 });
    expect(roam.length).toBeGreaterThanOrEqual(3);
    expect(roam.every((p) => onLane(p))).toBe(true);
  });
});

describe("步态几何", () => {
  it("shouldStep 按脚相对身体距离判定", () => {
    expect(shouldStep({ x: 100, y: 0 }, { x: 100, y: 0 }, 18, 46)).toBe(true); // 太近
    expect(shouldStep({ x: 100, y: 60 }, { x: 100, y: 0 }, 18, 46)).toBe(true); // 太远
    expect(shouldStep({ x: 100, y: 30 }, { x: 100, y: 0 }, 18, 46)).toBe(false);
  });

  it("restTarget 静止时落在髋部外侧，行进时向前偏移", () => {
    const hip = { x: 0, y: 0 };
    const idle = restTarget(hip, 0, null, 1, 20);
    expect(idle.x).toBeGreaterThan(0); // 右侧腿在右边
    const move = restTarget(hip, 0, { x: 0, y: -1 }, -1, 20);
    expect(move.y).toBeLessThan(0); // 向左腿也朝前方(-y)偏移
  });

  it("buildWaypoints 近距离不插点、远距离插入折线点且不超 maxSeg", () => {
    expect(buildWaypoints({ x: 0, y: 0 }, { x: 100, y: 0 }, { segLen: 260 })).toHaveLength(0);
    const far = buildWaypoints({ x: 0, y: 0 }, { x: 900, y: 0 }, { segLen: 260, maxSeg: 3 });
    expect(far.length).toBeGreaterThan(0);
    expect(far.length).toBeLessThanOrEqual(3);
    // 折线点偏离直连线
    expect(far.some((p) => Math.abs(p.y) > 1)).toBe(true);
  });
});
