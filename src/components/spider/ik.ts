// 程序化蜘蛛数学库：纯函数，无 DOM / canvas 依赖，可在 node 下单测。

/** 形态统一缩放系数（髋点/骨长/身体/reach 联动放大）。 */
export const SPIDER_SCALE = 2;
/** 落脚外侧基准（旧 14，随放大 ×2）。 */
export const LATERAL_BASE = 14 * SPIDER_SCALE;

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
  // 髋点随 SPIDER_SCALE ×2（前方为 -y）
  return [
    { ox: -14, oy: -20, group: 0, side: -1 },
    { ox: 14, oy: -20, group: 1, side: 1 },
    { ox: -22, oy: -6, group: 1, side: -1 },
    { ox: 22, oy: -6, group: 0, side: 1 },
    { ox: -22, oy: 6, group: 0, side: -1 },
    { ox: 22, oy: 6, group: 1, side: 1 },
    { ox: -14, oy: 20, group: 1, side: -1 },
    { ox: 14, oy: 20, group: 0, side: 1 },
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
  const lateral = rotate({ x: side * LATERAL_BASE, y: 0 }, bodyAngle);
  return add(add(hipWorld, scale(forward, reach)), scale(lateral, 0.4));
}

/**
 * 跨卡片长距离移动：在 from→to 间插入折线中途点（沿垂线左右摆动），
 * 模拟蜘蛛贴着面板边框爬行，避免空中直线飞行。
 * @deprecated 优先使用 naturalWaypoints（更自然的 S 形曲线）
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

/**
 * 自然曲线路径：在 from→to 之间生成平滑的 S 形/弧形中途点，
 * 模拟蜘蛛在屏幕中自然游走，而不是生硬地贴边或走直线。
 * - 短距离(<200px)：直线无中途点
 * - 中距离(200-500px)：1-2 个中途点，轻微弧度
 * - 长距离(>500px)：3-4 个中途点，明显的 S 形摆动
 * 随机化偏移幅度，每次路径都略有不同，更自然。
 */
export function naturalWaypoints(
  from: Vec2,
  to: Vec2,
  opts: { seed?: number; intensity?: number } = {},
): Vec2[] {
  const d = dist(from, to);
  if (d < 180) return []; // 短距离直接走

  const seed = opts.seed ?? Math.random() * 1000;
  const intensity = opts.intensity ?? 1.0;

  // 距离越远，中途点越多，摆动幅度越大
  const n = d < 350 ? 1 : d < 600 ? 2 : d < 900 ? 3 : 4;
  const maxSway = Math.min(180, d * 0.18) * intensity;

  const unit = scale(sub(to, from), 1 / d);
  const perp: Vec2 = { x: -unit.y, y: unit.x };

  // 伪随机：基于 seed + 位置的正弦函数，保证同 seed 下同结果
  const pseudoRand = (i: number) => Math.sin(seed * 0.1 + i * 2.37) * 0.5 + 0.5;

  const pts: Vec2[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    // S 形摆动：奇数点往一侧，偶数点往另一侧
    const direction = i % 2 === 1 ? 1 : -1;
    // 每个点的摆动幅度有随机变化（±30%）
    const swayAmount = maxSway * (0.7 + pseudoRand(i) * 0.6) * direction;
    // 中途点的纵向位置也略有偏移，避免均匀分布太机械
    const tJitter = t + (pseudoRand(i + 10) - 0.5) * 0.08;
    const clampedT = clamp(tJitter, 0.05, 0.95);
    pts.push(add(lerp(from, to, clampedT), scale(perp, swayAmount)));
  }
  return pts;
}

/**
 * 路径风格：自然曲线 / 贴边车道 / 直线
 * 蜘蛛会根据距离和随机性自动选择，避免单调。
 */
export type RouteStyle = "natural" | "edge" | "direct";

/**
 * 智能选路：根据距离、位置和随机性选择合适的路径风格。
 * - 短距离：直接走
 * - 中距离：优先自然曲线，偶尔贴边
 * - 长距离：自然曲线或贴边各有概率，避免总是一种风格
 */
export function smartRoute(
  from: Vec2,
  to: Vec2,
  size: ViewSize,
  opts: { pad?: number; seed?: number; preferEdge?: boolean } = {},
): { points: Vec2[]; style: RouteStyle } {
  const d = dist(from, to);
  const seed = opts.seed ?? Math.random() * 1000;

  if (d < 180) {
    return { points: [], style: "direct" };
  }

  // 距离越远，贴边概率越高（但不超过 45%）；默认自然曲线为主
  const edgeProb = Math.min(0.45, d / 2000);
  const roll = Math.sin(seed * 0.013) * 0.5 + 0.5; // 伪随机 0..1

  if (opts.preferEdge || roll < edgeProb) {
    // 贴边车道
    const pts = edgeRoute(from, to, size, { pad: opts.pad });
    return { points: pts, style: "edge" };
  } else {
    // 自然曲线
    const pts = naturalWaypoints(from, to, { seed });
    return { points: pts, style: "natural" };
  }
}

// ===== 全屏边缘「车道」漫游 =====
// 蜘蛛在距屏幕四边 pad 的内缩矩形周长上移动；pad > 蜘蛛半宽（含腿约 33）+余量。

export interface ViewSize {
  w: number;
  h: number;
}

export interface EdgeLane {
  pad: number;
  w: number; // 车道宽（右-左）
  h: number; // 车道高（下-上）
  per: number; // 周长
}

/** 距四边 pad 的内缩车道。 */
export function edgeLane(size: ViewSize, pad = 52): EdgeLane {
  const w = Math.max(1, size.w - pad * 2);
  const h = Math.max(1, size.h - pad * 2);
  return { pad, w, h, per: 2 * (w + h) };
}

/** 弧长 s（自车道左上角顺时针）→ 车道点。 */
function sToPoint(lane: EdgeLane, s: number): Vec2 {
  const { pad: p, w, h, per } = lane;
  let t = ((s % per) + per) % per;
  if (t <= w) return { x: p + t, y: p };
  t -= w;
  if (t <= h) return { x: p + w, y: p + t };
  t -= h;
  if (t <= w) return { x: p + w - t, y: p + h };
  t -= w;
  return { x: p, y: p + h - t };
}

/** 任意点 → 车道上最近点 + 其顺时针弧长。 */
function projectOnPerimeter(lane: EdgeLane, p: Vec2): { point: Vec2; s: number } {
  const { pad: q, w, h } = lane;
  // 四条边：弧长零点、固定坐标、沿边坐标的取值范围
  const edges: Array<{ s0: number; fixed: number; lo: number; hi: number; horizontal: boolean }> = [
    { s0: 0, fixed: q, lo: q, hi: q + w, horizontal: true },
    { s0: w, fixed: q + w, lo: q, hi: q + h, horizontal: false },
    { s0: w + h, fixed: q + h, lo: q, hi: q + w, horizontal: true },
    { s0: 2 * w + h, fixed: q, lo: q, hi: q + h, horizontal: false },
  ];
  let best: { point: Vec2; s: number; d: number } | null = null;
  for (const e of edges) {
    const along = clamp(e.horizontal ? p.x : p.y, e.lo, e.hi);
    const point: Vec2 = e.horizontal
      ? { x: along, y: e.fixed }
      : { x: e.fixed, y: along };
    const d = dist(p, point);
    if (!best || d < best.d) best = { point, s: e.s0 + (along - e.lo), d };
  }
  return { point: best!.point, s: best!.s };
}

/** 沿弧从 s1 走到 s2：纳入转角与 spacing 插值，返回有序车道点。dir=1 顺时针/-1 逆时针。 */
function walkArc(lane: EdgeLane, s1: number, s2: number, dir: 1 | -1, spacing: number): Vec2[] {
  const per = lane.per;
  let travel = dir === 1 ? (s2 - s1 + per) % per : (s1 - s2 + per) % per;
  if (travel < 1e-6) travel = per; // 同点：走一整圈
  // 收集从起点起的弧距集合：终点、4 个车道转角、spacing 刻度
  const cuts = new Set<number>([0, travel]);
  for (const c of [0, lane.w, lane.w + lane.h, 2 * lane.w + lane.h]) {
    const dArc = dir === 1 ? (c - s1 + per) % per : (s1 - c + per) % per;
    if (dArc > 0 && dArc < travel) cuts.add(dArc);
  }
  for (let d = spacing; d < travel; d += spacing) cuts.add(d);
  return [...cuts]
    .sort((a, b) => a - b)
    .map((d) => sToPoint(lane, s1 + dir * d));
}

/**
 * 远距接入路径：from/to 距离 ≥ minDirect 时，先上车道沿较短弧绕行再下车道；
 * 近距返回 []（同卡相邻行直接走）。返回点不含 from/to 本身，调用方标 via。
 */
export function edgeRoute(
  from: Vec2,
  to: Vec2,
  size: ViewSize,
  opts: { pad?: number; minDirect?: number; spacing?: number } = {},
): Vec2[] {
  const minDirect = opts.minDirect ?? 220;
  const spacing = opts.spacing ?? 240;
  if (dist(from, to) < minDirect) return [];
  const lane = edgeLane(size, opts.pad ?? 52);
  const a = projectOnPerimeter(lane, from);
  const b = projectOnPerimeter(lane, to);
  // 较短弧方向
  const cw = (b.s - a.s + lane.per) % lane.per;
  const dir: 1 | -1 = cw <= lane.per / 2 ? 1 : -1;
  // walkArc 已含起终点（a/b 车道投影），无需再包裹
  return walkArc(lane, a.s, b.s, dir, spacing);
}

/**
 * 自由漫游：从 from 投影上车道，沿 dir（默认顺时针）走 distance，按 spacing 采样。
 * 返回点全部由调用方标 via（不驻留/不发光束/不抽包）。
 */
export function roamPath(
  from: Vec2,
  size: ViewSize,
  opts: { pad?: number; distance?: number; dir?: 1 | -1; spacing?: number } = {},
): Vec2[] {
  const distance = opts.distance ?? 700;
  const spacing = opts.spacing ?? 200;
  const dir = opts.dir ?? 1;
  const lane = edgeLane(size, opts.pad ?? 52);
  const a = projectOnPerimeter(lane, from);
  return walkArc(lane, a.s, (a.s + dir * distance) % lane.per, dir, spacing);
}

/**
 * 局部游荡：在中心点附近做椭圆/8 字形小范围游荡。
 * 用于锚点采空时，蜘蛛在卡片附近徘徊等待，而不是跑到屏幕边缘去。
 * - 沿椭圆路径走 1.5 圈
 * - 从当前位置平滑接入
 */
export function localWanderPath(
  from: Vec2,
  center: Vec2,
  opts: { radiusX?: number; radiusY?: number; loops?: number; points?: number } = {},
): Vec2[] {
  const rx = opts.radiusX ?? 80;
  const ry = opts.radiusY ?? 50;
  const loops = opts.loops ?? 1.5;
  const pts = opts.points ?? 12;

  // 计算 from 相对于 center 的角度，从那里开始
  const startAngle = from.x !== center.x || from.y !== center.y
    ? Math.atan2(from.y - center.y, from.x - center.x)
    : 0;

  const result: Vec2[] = [];
  for (let i = 1; i <= pts; i++) {
    const t = i / pts;
    const angle = startAngle + t * Math.PI * 2 * loops;
    const x = center.x + Math.cos(angle) * rx;
    const y = center.y + Math.sin(angle) * ry;
    result.push({ x, y });
  }
  return result;
}
