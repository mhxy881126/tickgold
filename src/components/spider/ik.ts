// 程序化蜘蛛数学库：纯函数，无 DOM / canvas 依赖，可在 node 下单测。

export interface Vec2 {
  x: number;
  y: number;
}

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => len(sub(b, a));
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);
export const rotate = (a: Vec2, rad: number): Vec2 => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};
export const clamp = (x: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, x));

/**
 * 两段式反向运动学：已知髋 H、脚 F、两段骨长，返回膝关节位置。
 * bend=1/-1 决定腿弯向目标连线的哪一侧（左右腿相反）。
 * 距离异常时（重合/超长）钳制，保证返回有限值且两段闭合。
 */
export function twoBoneKnee(
  hip: Vec2,
  foot: Vec2,
  l1: number,
  l2: number,
  bend: 1 | -1,
): Vec2 {
  const d = clamp(dist(hip, foot), 0.0001, l1 + l2 - 0.001);
  const dir = scale(sub(foot, hip), 1 / d);
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const a = Math.acos(cosA);
  const kneeAngle = angleOf(dir) + bend * a;
  return add(hip, { x: Math.cos(kneeAngle) * l1, y: Math.sin(kneeAngle) * l1 });
}

/** 二次贝塞尔（抬脚弧线 / 数据包飞行）。 */
export function quad(a: Vec2, b: Vec2, c: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * b.x + t * t * c.x,
    y: u * u * a.y + 2 * u * t * b.y + t * t * c.y,
  };
}

/** 8 条腿的髋部锚点（相对身体中心，前方为 -y）。 */
export interface HipDef {
  ox: number; // 左右偏移
  oy: number; // 前后偏移（负=前）
  group: 0 | 1; // 对角步态分组
  side: 1 | -1; // 1 右 / -1 左
}

export function buildHips(): HipDef[] {
  return [
    { ox: -7, oy: -10, group: 0, side: -1 },
    { ox: 7, oy: -10, group: 1, side: 1 },
    { ox: -11, oy: -3, group: 1, side: -1 },
    { ox: 11, oy: -3, group: 0, side: 1 },
    { ox: -11, oy: 3, group: 0, side: -1 },
    { ox: 11, oy: 3, group: 1, side: 1 },
    { ox: -7, oy: 10, group: 1, side: -1 },
    { ox: 7, oy: 10, group: 0, side: 1 },
  ];
}

/** 脚相对身体超出舒适环带 [rMin, rMax] 时需要重新迈步。 */
export function shouldStep(
  footWorld: Vec2,
  body: Vec2,
  rMin: number,
  rMax: number,
): boolean {
  const d = dist(footWorld, body);
  return d > rMax || d < rMin;
}

/**
 * 计算某条腿新的期望落脚点：静止时落在髋部外侧；
 * 行进时沿移动方向前移 reach 像素。
 */
export function restTarget(
  hipWorld: Vec2,
  bodyAngle: number,
  moveDir: Vec2 | null,
  side: 1 | -1,
  reach: number,
): Vec2 {
  const forward =
    moveDir && len(moveDir) > 0.01
      ? moveDir
      : { x: Math.sin(bodyAngle), y: -Math.cos(bodyAngle) };
  const lateral = rotate({ x: side * 14, y: 0 }, bodyAngle);
  return add(add(hipWorld, scale(forward, reach)), scale(lateral, 0.4));
}

/**
 * 跨卡片长距离移动：在 from→to 间插入折线中途点（沿垂线左右摆动），
 * 模拟蜘蛛贴着面板边框爬行，避免空中直线飞行。
 */
export function buildWaypoints(
  from: Vec2,
  to: Vec2,
  opts: { maxSeg?: number; segLen?: number } = {},
): Vec2[] {
  const maxSeg = opts.maxSeg ?? 3;
  const segLen = opts.segLen ?? 260;
  const d = dist(from, to);
  if (d < 1) return [];
  const n = Math.min(maxSeg, Math.max(0, Math.ceil(d / segLen) - 1));
  const unit = scale(sub(to, from), 1 / d);
  const perp: Vec2 = { x: -unit.y, y: unit.x };
  const pts: Vec2[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const sway = (i % 2 ? 1 : -1) * 46;
    pts.push(add(lerp(from, to, t), scale(perp, sway)));
  }
  return pts;
}
