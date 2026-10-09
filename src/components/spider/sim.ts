// 蜘蛛仿真纯类：身体移动/转向、8 腿步态调度、扫描驻留。
// 无 DOM / canvas；渲染层只读 body / legsForRender / current / packets。
import {
  type Vec2, add, sub, scale, len, lerp, angleOf, rotate, clamp,
  twoBoneKnee, quad, buildHips, restTarget, LATERAL_BASE,
} from "./ik";
import type { Anchor } from "./anchors";

export type SignalKind = "BUY" | "SELL" | null;

export interface ScanPoint {
  x: number;
  y: number;
  anchor: Anchor;
  signal: SignalKind;
  /** 跨卡片中途点：经过不驻留、不发光束、不抽包 */
  via?: boolean;
}

export interface RenderLeg {
  hip: Vec2;
  knee: Vec2;
  foot: Vec2;
  lifting: boolean;
}

export interface SimOpts {
  speed: number;       // 身体移动 px/s
  arriveDist: number;  // 距目标多近算到达
  dwellMs: number;     // 到达后扫描驻留（滑行模式下为滑行扫描总时长）
  glideScan: boolean;  // 滑行扫描：经过目标时减速滑过，不停下
  reach: number;       // 落脚点相对髋的前移量
  stepMs: number;      // 单腿 swing 时长（抬脚弧）
  stridePeriod: number;// 步态周期 s
  liftHeight: number;  // 抬脚弧高
  maxTurnRate: number; // 最大转向角速度 rad/s
  trailMs: number;     // 数据包拖行时长
  flyMs: number;       // 数据包飞入信号桥时长
  reducedMotion?: boolean;
}

export interface SimEvents {
  arrived: ScanPoint | null;
  packetDone: string | null;
}

interface Leg {
  ox: number; oy: number; group: 0 | 1; side: 1 | -1;
  l1: number; l2: number;
  /** 该腿在步态周期中的固定相位 0..1 */
  phase: number;
  foot: Vec2;
  lifting: boolean;
  t: number;
  from: Vec2;
  to: Vec2;
}

export interface Packet {
  code: string;
  name: string;
  side: "BUY" | "SELL";
  price: number;
  pct: number;
  state: "extracting" | "trailing" | "flying" | "dissolving";
  pos: Vec2;
  age: number;
  t: number;
  from: Vec2;
  ctrl: Vec2;
  to: Vec2;
  /** 抽出动画起点（行位置） */
  extractFrom: Vec2;
  /** 抽出动画终点（蜘蛛身后拖行点） */
  extractTo: Vec2;
  /** 飞行拖尾点（最近 N 个位置） */
  trail: Vec2[];
  /** 消散粒子 */
  particles: { pos: Vec2; vel: Vec2; life: number; maxLife: number; size: number }[];
}

// 步态采用固定相位 trot
const DEFAULTS: SimOpts = {
  speed: 145, arriveDist: 14, dwellMs: 650, glideScan: true,
  reach: 30, stepMs: 110, stridePeriod: 0.45, liftHeight: 18,
  maxTurnRate: 0.8,
  trailMs: 900, flyMs: 600,
  reducedMotion: false,
};

/** 数据包出生/拖行点在身后的距离 */
const PACKET_BACK = 52;

export class SpiderSim {
  body: Vec2;
  angle = 0;
  readonly l1 = 24;
  readonly l2 = 28;
  packets: Packet[] = [];

  private opts: SimOpts;
  private path: ScanPoint[] = [];
  private idx = -1;
  private scanUntil = 0;
  private arrivedEmitted = false;
  private glideEntryDist = 0;
  private glideDir: Vec2 | null = null; // 滑行方向（到达时锁定）
  private legs: Leg[] = [];
  private gaitClock = 0; // 步态相位时钟（周期份额 0..1）
  private flyTarget: Vec2 | null = null;
  private _lastNow = 0;
  private _currentRowAnchor: Anchor | null = null;

  constructor(start: Vec2, opts: Partial<SimOpts> = {}) {
    this.body = { ...start };
    this.opts = { ...DEFAULTS, ...opts };
    this.relayoutFeet();
  }

  private relayoutFeet(): void {
    const o = this.opts;
    const vP = o.speed * o.stridePeriod;
    const lateral = LATERAL_BASE * 0.4;
    const within = [0, 0];
    this.legs = buildHips().map((h) => {
      const k = within[h.group]++;
      const phase = h.group === 0 ? k * 0.25 : (k * 0.25 + 0.125) % 1;
      const fwd = vP * phase - o.reach;
      const local = { x: h.ox + h.side * lateral, y: h.oy - fwd };
      const foot = add(this.body, rotate(local, this.angle));
      return {
        ...h, phase, l1: this.l1, l2: this.l2,
        foot, lifting: false, t: 0, from: foot, to: foot,
      };
    });
    this.gaitClock = 0;
  }

  get active(): boolean {
    return this.idx >= 0 && this.idx < this.path.length;
  }

  get current(): ScanPoint | null {
    return this.active ? this.path[this.idx] : null;
  }

  /** 当前扫描点的驻留进度 0~1（0=刚到达，1=驻留结束）；非驻留状态返回 0 */
  get scanProgress(): number {
    if (!this.active || this.path[this.idx]?.via) return 0;
    if (this.scanUntil <= 0) return 0;
    const elapsed = this.opts.dwellMs - (this.scanUntil - this._lastNow);
    return Math.max(0, Math.min(1, elapsed / this.opts.dwellMs));
  }

  /** 是否处于扫描驻留状态（已到达非 via 点且尚未离开） */
  get isScanning(): boolean {
    return this.active && !this.path[this.idx]?.via && this.scanUntil > 0;
  }

  resetPath(points: ScanPoint[]): void {
    this.path = points;
    this.idx = points.length ? 0 : -1;
    this.scanUntil = 0;
    this.arrivedEmitted = false;
    this.glideDir = null;
    this._currentRowAnchor = null;
    this.glideEntryDist = this.opts.speed * 0.6;
    if (points.length) {
      const d = sub(points[0], this.body);
      if (len(d) > 1) this.angle = angleOf(d) + Math.PI / 2;
      this.relayoutFeet();
    }
  }

  setFlyTarget(p: Vec2): void {
    this.flyTarget = p;
  }

  spawnPacket(p: ScanPoint): void {
    if (!p.signal || !p.anchor.code) return;
    const back = rotate({ x: 0, y: PACKET_BACK }, this.angle);
    const trailPos = add(this.body, back);
    // 抽出起点：行中心位置（数据从行里"抽出来"）
    const extractFrom = {
      x: p.x + Math.min(p.anchor.width, 120),
      y: p.y,
    };
    this.packets.push({
      code: p.anchor.code,
      name: p.anchor.name ?? p.anchor.code,
      side: p.signal,
      price: p.anchor.price ?? 0,
      pct: p.anchor.pct ?? 0,
      state: "extracting",
      pos: { ...extractFrom },
      age: 0,
      t: 0,
      from: trailPos,
      ctrl: this.flyTarget
        ? { x: (trailPos.x + this.flyTarget.x) / 2, y: Math.min(trailPos.y, this.flyTarget.y) - 140 }
        : { x: trailPos.x, y: trailPos.y - 140 },
      to: this.flyTarget ? { ...this.flyTarget } : { ...trailPos },
      extractFrom,
      extractTo: trailPos,
      trail: [],
      particles: [],
    });
    const trailingOrExtracting = this.packets.filter((x) => x.state === "trailing" || x.state === "extracting");
    if (trailingOrExtracting.length > 8) this.packets.splice(this.packets.indexOf(trailingOrExtracting[0]), 1);
  }

  private hipWorld(h: { ox: number; oy: number }): Vec2 {
    return add(this.body, rotate({ x: h.ox, y: h.oy }, this.angle));
  }

  /**
   * 推进步态：位移驱动模式（身体走了多远，步态就推进多少）。
   * - 步长 strideLen = speed * stridePeriod（一个完整周期前进的距离）
   * - 每帧推进的步态相位 = 本帧位移 / 步长
   * - 这样保证：走一步 = 前进一步长，无滑步
   */
  private advanceLegs(
    dtMs: number,
    moveDir: Vec2 | null,
    distance: number, // 本帧身体实际移动的距离（px）
    speedFactor = 1,
  ): void {
    const o = this.opts;
    // 步长：一个完整步态周期身体前进的距离
    const strideLen = o.speed * o.stridePeriod;

    if (distance > 0 && strideLen > 0) {
      // 位移驱动：推进步态相位
      this.gaitClock = (this.gaitClock + distance / strideLen) % 1;
    } else if (moveDir === null) {
      // 静止驻留：步态微小摆动（原地踏步感，但不前进）
      this.gaitClock = (this.gaitClock + (dtMs / 1000) * 0.15 * speedFactor) % 1;
    }
    // 注意：转向时（moveDir 有值但 distance≈0）不推进步态，只保持当前支撑相位

    const swingFrac = clamp((o.stepMs / 1000 / o.stridePeriod), 0.05, 0.32);
    const c = this.gaitClock;

    for (const l of this.legs) {
      const start = l.phase;
      const end = (l.phase + swingFrac) % 1;
      const inSwing = start < end
        ? c >= start && c < end
        : c >= start || c < end;
      const arc = (c - start + 1) % 1;
      const hip = this.hipWorld(l);
      if (inSwing) {
        if (!l.lifting) {
          l.lifting = true;
          l.from = { ...l.foot };
          let to = restTarget(hip, this.angle, moveDir, l.side, o.reach);

          // 锚定到行边缘：如果当前锚点有行高，脚只能落在行的上/下边缘
          const anchor = this._currentRowAnchor;
          if (anchor && anchor.height > 0 && moveDir) {
            to = this.snapFootToRowEdge(to, anchor, l.side);
          }

          const off = sub(to, hip);
          const dd = len(off);
          const reachable = l.l1 + l.l2 - 1.5;
          if (dd > reachable) to = add(hip, scale(off, reachable / dd));
          l.to = to;
        }
        l.t = clamp(arc / swingFrac, 0, 1);
        const mid = add(lerp(l.from, l.to, 0.5), { x: 0, y: -o.liftHeight });
        l.foot = quad(l.from, mid, l.to, l.t);
      } else if (l.lifting) {
        l.lifting = false;
        l.t = 1;
        l.foot = { ...l.to };
      }
    }
  }

  /** 将脚位置锚定到行的上/下边缘，避免脚穿进行内部 */
  private snapFootToRowEdge(foot: Vec2, anchor: Anchor, side: number): Vec2 {
    const topY = anchor.y - anchor.height / 2;
    const botY = anchor.y + anchor.height / 2;
    // 脚在行上方 → 落在上边缘；脚在行下方 → 落在下边缘
    const midY = anchor.y;
    const targetY = foot.y < midY ? topY : botY;
    // x 坐标夹在行的左右范围内（内侧留一点余量）
    const leftX = anchor.x + 4;
    const rightX = anchor.x + anchor.width - 4;
    const targetX = clamp(foot.x, leftX, rightX);
    return { x: targetX, y: targetY };
  }

  update(dtMs: number, now: number): SimEvents {
    this._lastNow = now;
    const ev: SimEvents = { arrived: null, packetDone: null };
    const o = this.opts;

    if (this.active) {
      const tgt = this.path[this.idx];
      const to = sub(tgt, this.body);
      const d = len(to);

      if (tgt.via) {
        // 中途点：全速通过
        if (d <= o.arriveDist) {
          this.body = { ...tgt };
          this.idx++;
          this.advanceLegs(dtMs, scale(to, 1 / Math.max(d, 0.001)), d);
        } else {
          const dir = scale(to, 1 / d);
          const want = angleOf(dir) + Math.PI / 2;
          let diff = want - this.angle;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          const maxTurn = (o.maxTurnRate * dtMs) / 1000;
          this.angle += clamp(diff, -maxTurn, maxTurn);
          const turning = Math.abs(diff) > 0.25;
          const speedNow = turning ? o.speed * 0.5 : o.speed;
          const step = Math.min(d, (speedNow * dtMs) / 1000);
          this.body = add(this.body, scale(dir, step));
          // 位移驱动步态：本帧走了 step 距离
          this.advanceLegs(dtMs, dir, step);
        }
      } else if (o.glideScan) {
        // ═══ 滑行扫描模式：接近减速 → 到达发信号 → 沿进入方向滑出 → 推进 ═══
        // 速度曲线采用 ease-in-out S 型，更自然
        if (!this.arrivedEmitted) {
          // 接近阶段
          const dir = scale(to, 1 / Math.max(d, 0.001));
          const want = angleOf(dir) + Math.PI / 2;
          let diff = want - this.angle;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;

          // 转向平滑：大角度时先转到位再走，小角度边走边转（更自然）
          const maxTurn = (o.maxTurnRate * dtMs) / 1000;
          const turnProgress = 1 - clamp(Math.abs(diff) / Math.PI * 0.7, 0, 1);
          this.angle += clamp(diff, -maxTurn, maxTurn);
          const turning = Math.abs(diff) > 0.2;

          // S 型减速曲线：ease-in-out cubic
          let speedFactor = 1.0;
          if (d < this.glideEntryDist) {
            const t = clamp(d / this.glideEntryDist, 0, 1);
            // ease-in-out: t < 0.5 ? 4t³ : 1 - (-2t+2)³ / 2
            const ease = t < 0.5
              ? 4 * t * t * t
              : 1 - Math.pow(-2 * t + 2, 3) / 2;
            speedFactor = 0.22 + 0.78 * ease;
          }
          const turnPenalty = turning ? 0.55 + 0.45 * turnProgress : 1;
          const baseSpeed = o.speed * turnPenalty;
          const speedNow = baseSpeed * speedFactor;
          const step = Math.min(d, (speedNow * dtMs) / 1000);
          this.body = add(this.body, scale(dir, step));
          // 设置当前行锚点（用于脚锚定行边缘）
          this._currentRowAnchor = tgt.anchor.height > 0 ? tgt.anchor : null;
          // 位移驱动步态
          this.advanceLegs(dtMs, dir, step);

          if (d <= o.arriveDist) {
            ev.arrived = tgt;
            this.arrivedEmitted = true;
            this.scanUntil = now + o.dwellMs;
            this.glideDir = { ...dir };
          }
        } else if (now < this.scanUntil) {
          // 滑行扫描中：先慢后快的滑出（bell curve）
          const elapsed = o.dwellMs - (this.scanUntil - now);
          const progress = clamp(elapsed / o.dwellMs, 0, 1);
          // 前 30% 慢速驻留扫描，后 70% 逐渐加速离开
          const glidePhase = progress < 0.3
            ? 0.15  // 最慢：超慢
            : 0.15 + 0.65 * Math.pow((progress - 0.3) / 0.7, 2);
          const dir = this.glideDir ?? scale(to, 1 / Math.max(d, 0.001));
          const speedNow = o.speed * glidePhase;
          const step = (speedNow * dtMs) / 1000;
          this.body = add(this.body, scale(dir, step));
          // 驻留时用空 moveDir 触发原地小步摆动
          this.advanceLegs(dtMs, progress < 0.5 ? null : dir, step);
        } else {
          // 滑行扫描结束，推进到下一点
          this.idx++;
          this.arrivedEmitted = false;
          this.scanUntil = 0;
          this.glideDir = null;
        }
      } else {
        // ═══ 传统驻留模式 ═══
        if (this.scanUntil > 0) {
          if (now >= this.scanUntil) {
            this.scanUntil = 0;
            this.idx++;
            this._currentRowAnchor = null;
          } else if (this.idx + 1 < this.path.length) {
            const nxt = this.path[this.idx + 1];
            const want = angleOf(sub(nxt, this.body)) + Math.PI / 2;
            let diff = want - this.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            const maxTurn = (o.maxTurnRate * dtMs) / 1000;
            this.angle += clamp(diff, -maxTurn, maxTurn);
          }
          // 驻留：原地小步摆动
          this.advanceLegs(dtMs, null, 0);
        } else if (d <= o.arriveDist) {
          this.body = { ...tgt };
          this.scanUntil = now + o.dwellMs;
          this._currentRowAnchor = tgt.anchor.height > 0 ? tgt.anchor : null;
          ev.arrived = tgt;
          this.advanceLegs(dtMs, null, 0);
        } else {
          const dir = scale(to, 1 / d);
          const want = angleOf(dir) + Math.PI / 2;
          let diff = want - this.angle;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          const maxTurn = (o.maxTurnRate * dtMs) / 1000;
          this.angle += clamp(diff, -maxTurn, maxTurn);
          const turning = Math.abs(diff) > 0.25;
          const speedNow = turning ? o.speed * 0.5 : o.speed;
          const step = Math.min(d, (speedNow * dtMs) / 1000);
          this.body = add(this.body, scale(dir, step));
          this._currentRowAnchor = tgt.anchor.height > 0 ? tgt.anchor : null;
          // 位移驱动步态
          this.advanceLegs(dtMs, dir, step);
        }
      }
    } else {
      // 路径走完：收腿
      for (const l of this.legs) {
        if (l.lifting) {
          l.lifting = false;
          l.t = 1;
          l.foot = { ...l.to };
        }
      }
    }

    this.updatePackets(dtMs, ev);
    return ev;
  }

  private updatePackets(dtMs: number, ev: SimEvents): void {
    const o = this.opts;
    const back = rotate({ x: 0, y: PACKET_BACK }, this.angle);
    const anchorPos = add(this.body, back);
    const keep: Packet[] = [];
    const EXTRACT_MS = 350; // 抽出动画时长
    for (const p of this.packets) {
      if (p.state === "extracting") {
        p.age += dtMs;
        const t = clamp(p.age / EXTRACT_MS, 0, 1);
        // 弹性缓出：先快后慢，带一点回弹
        const ease = t < 0.5
          ? 4 * t * t * t
          : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const elastic = ease + Math.sin(t * Math.PI * 2) * 0.05 * (1 - t);
        const clampedT = clamp(elastic, 0, 1);
        p.pos = lerp(p.extractFrom, p.extractTo, clampedT);
        p.t = t;
        // 拖尾
        p.trail.unshift({ ...p.pos });
        if (p.trail.length > 6) p.trail.pop();
        if (p.age >= EXTRACT_MS) {
          p.state = "trailing";
          p.age = 0;
          p.pos = { ...anchorPos };
        }
        keep.push(p);
      } else if (p.state === "trailing") {
        p.age += dtMs;
        const sway = Math.sin(p.age / 130) * 6;
        const perp = rotate({ x: sway, y: 0 }, this.angle);
        p.pos = add(anchorPos, perp);
        // 拖尾点
        p.trail.unshift({ ...p.pos });
        if (p.trail.length > 8) p.trail.pop();
        if (p.age >= o.trailMs && this.flyTarget) {
          p.state = "flying";
          p.t = 0;
          p.from = { ...p.pos };
          p.to = { ...this.flyTarget };
          if (o.reducedMotion) {
            p.ctrl = {
              x: (p.from.x + p.to.x) / 2,
              y: (p.from.y + p.to.y) / 2,
            };
          } else {
            p.ctrl = {
              x: (p.from.x + p.to.x) / 2,
              y: Math.min(p.from.y, p.to.y) - 150,
            };
          }
        }
        keep.push(p);
      } else if (p.state === "flying") {
        p.t = clamp(p.t + dtMs / o.flyMs, 0, 1);
        p.pos = quad(p.from, p.ctrl, p.to, p.t);
        // 飞行拖尾点
        p.trail.unshift({ ...p.pos });
        if (p.trail.length > 12) p.trail.pop();
        if (p.t >= 1) {
          // 进入消散阶段
          p.state = "dissolving";
          p.t = 0;
          // 生成消散粒子（6~10 个）
          const particleCount = 6 + Math.floor(Math.random() * 5);
          for (let i = 0; i < particleCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 20 + Math.random() * 50;
            p.particles.push({
              pos: { ...p.pos },
              vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
              life: 0,
              maxLife: 250 + Math.random() * 350,
              size: 1.5 + Math.random() * 2.5,
            });
          }
          ev.packetDone = p.code;
        }
        keep.push(p);
      } else if (p.state === "dissolving") {
        // 消散阶段：粒子飞散
        p.t += dtMs;
        let hasAlive = false;
        for (const pt of p.particles) {
          pt.life += dtMs;
          if (pt.life < pt.maxLife) {
            hasAlive = true;
            pt.pos.x += pt.vel.x * (dtMs / 1000);
            pt.pos.y += pt.vel.y * (dtMs / 1000);
            pt.vel.x *= 0.96;
            pt.vel.y *= 0.96;
            pt.vel.y += 30 * (dtMs / 1000); // 轻微重力
          }
        }
        if (hasAlive || p.t < 600) {
          keep.push(p);
        }
      }
    }
    this.packets = keep;
  }

  legsForRender(): RenderLeg[] {
    return this.legs.map((l) => {
      const hip = this.hipWorld(l);
      const bend: 1 | -1 = l.side === 1 ? 1 : -1;
      const off = sub(l.foot, hip);
      const d = len(off);
      const maxD = l.l1 + l.l2;
      const minD = Math.abs(l.l1 - l.l2);
      let foot = l.foot;
      let knee: Vec2;
      if (d > maxD) {
        const u = scale(off, 1 / d);
        foot = add(hip, scale(u, maxD));
        knee = add(hip, scale(u, l.l1));
      } else if (d < minD) {
        const u =
          d > 1e-6
            ? scale(off, 1 / d)
            : rotate({ x: l.side, y: 0 }, this.angle);
        foot = add(hip, scale(u, minD));
        knee = twoBoneKnee(hip, foot, l.l1, l.l2, bend);
      } else {
        knee = twoBoneKnee(hip, foot, l.l1, l.l2, bend);
      }
      return { hip, knee, foot, lifting: l.lifting };
    });
  }
}
