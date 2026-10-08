// 蜘蛛仿真纯类：身体移动/转向、8 腿步态调度、扫描驻留。
// 无 DOM / canvas；渲染层只读 body / legsForRender / current / packets。
import {
  type Vec2, add, sub, scale, len, lerp, angleOf, rotate, clamp,
  twoBoneKnee, quad, buildHips, shouldStep, restTarget,
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
  speed: number;      // 身体移动 px/s
  arriveDist: number; // 距目标多近算到达
  dwellMs: number;    // 到达后扫描驻留
  rMin: number; rMax: number; // 脚舒适环带
  reach: number;      // 迈步前移量
  stepMs: number;     // 单腿抬起时长
  liftHeight: number; // 抬脚弧高
}

export interface SimEvents {
  arrived: ScanPoint | null;
  packetDone: string | null;
}

interface Leg {
  ox: number; oy: number; group: 0 | 1; side: 1 | -1;
  l1: number; l2: number;
  foot: Vec2;
  lifting: boolean;
  t: number;
  from: Vec2;
  to: Vec2;
}

// 数据包状态机在 Task 4 追加；此处先给类型与字段占位由 Task 4 完整实现。
export interface Packet {
  code: string;
  name: string;
  side: "BUY" | "SELL";
  price: number;
  pct: number;
  state: "trailing" | "flying";
  pos: Vec2;
  trail: Vec2[];
  age: number;
  t: number;
  from: Vec2;
  ctrl: Vec2;
  to: Vec2;
}

const DEFAULTS: SimOpts = {
  speed: 130, arriveDist: 10, dwellMs: 750,
  rMin: 14, rMax: 52, reach: 16, stepMs: 260, liftHeight: 12,
};

export class SpiderSim {
  body: Vec2;
  angle = 0;
  readonly l1 = 12;
  readonly l2 = 14;
  packets: Packet[] = [];

  private opts: SimOpts;
  private path: ScanPoint[] = [];
  private idx = -1;
  private scanUntil = 0;
  private legs: Leg[];
  private flyTarget: Vec2 = { x: 0, y: 0 };

  constructor(start: Vec2, opts: Partial<SimOpts> = {}) {
    this.body = { ...start };
    this.opts = { ...DEFAULTS, ...opts };
    // 初始 8 脚在身体周围环带内，避免首帧集体迈步
    this.legs = buildHips().map((h) => {
      const hip = this.hipWorld(h);
      const foot = add(hip, rotate({ x: h.side * 10, y: 4 }, this.angle));
      return { ...h, l1: this.l1, l2: this.l2, foot, lifting: false, t: 0, from: foot, to: foot };
    });
  }

  get active(): boolean {
    return this.idx >= 0 && this.idx < this.path.length;
  }

  get current(): ScanPoint | null {
    return this.active ? this.path[this.idx] : null;
  }

  resetPath(points: ScanPoint[]): void {
    this.path = points;
    this.idx = points.length ? 0 : -1;
    this.scanUntil = 0;
  }

  setFlyTarget(p: Vec2): void {
    this.flyTarget = p;
  }

  /** Task 4 实现完整状态机；此处先空实现让 Task 3 编译通过。 */
  spawnPacket(_p: ScanPoint): void {
    void _p;
  }

  private hipWorld(h: { ox: number; oy: number }): Vec2 {
    return add(this.body, rotate({ x: h.ox, y: h.oy }, this.angle));
  }

  private advanceLegs(dtMs: number, moveDir: Vec2 | null): void {
    const o = this.opts;
    const groupLifting = [false, false];
    let totalLifting = 0;
    for (const l of this.legs) {
      if (l.lifting) { groupLifting[l.group] = true; totalLifting++; }
    }

    for (const l of this.legs) {
      const hip = this.hipWorld(l);
      if (l.lifting) {
        l.t = clamp(l.t + dtMs / o.stepMs, 0, 1);
        const mid = add(lerp(l.from, l.to, 0.5), { x: 0, y: -o.liftHeight });
        l.foot = quad(l.from, mid, l.to, l.t);
        if (l.t >= 1) {
          l.lifting = false;
          l.foot = { ...l.to };
          groupLifting[l.group] = false;
          totalLifting--;
        }
      } else if (
        totalLifting < 2 &&
        !groupLifting[l.group] &&
        shouldStep(l.foot, this.body, o.rMin, o.rMax)
      ) {
        l.lifting = true;
        l.t = 0;
        l.from = { ...l.foot };
        l.to = restTarget(hip, this.angle, moveDir, l.side, o.reach);
        groupLifting[l.group] = true;
        totalLifting++;
      }
    }
  }

  update(dtMs: number, now: number): SimEvents {
    const ev: SimEvents = { arrived: null, packetDone: null };
    const o = this.opts;

    if (this.active) {
      const tgt = this.path[this.idx];
      const to = sub(tgt, this.body);
      const d = len(to);
      if (this.scanUntil > 0) {
        // 驻留扫描：身体静止
        if (now >= this.scanUntil) {
          this.scanUntil = 0;
          this.idx++;
        }
        this.advanceLegs(dtMs, null);
      } else if (d <= o.arriveDist) {
        this.body = { ...tgt };
        if (tgt.via) {
          // 跨卡片中途点：直接通过，不驻留/不发光束
          this.idx++;
          this.advanceLegs(dtMs, null);
        } else {
          this.scanUntil = now + o.dwellMs;
          ev.arrived = tgt;
          this.advanceLegs(dtMs, null);
        }
      } else {
        const step = Math.min(d, (o.speed * dtMs) / 1000);
        const dir = scale(to, 1 / d);
        this.body = add(this.body, scale(dir, step));
        // 身体朝向移动方向缓动（前方 -y，故取 dir 角度 + 90°）
        const want = angleOf(dir) + Math.PI / 2;
        let diff = want - this.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.angle += diff * Math.min(1, dtMs / 120);
        this.advanceLegs(dtMs, dir);
      }
    } else {
      // 空闲原地微动，腿不动
    }

    // Task 4 在此更新数据包
    return ev;
  }

  legsForRender(): RenderLeg[] {
    return this.legs.map((l) => {
      const hip = this.hipWorld(l);
      const bend: 1 | -1 = l.side === 1 ? 1 : -1;
      // 渲染契约：任意时刻骨架必须可达。高速移动时步态调度来不及轮换，
      // 逻辑脚可能被甩到两段骨长之和以外（IK 拉伸），此处把脚投影回
      // 可达环带 [|l1-l2|, l1+l2]，保证两段长度严格守恒。
      const off = sub(l.foot, hip);
      const d = len(off);
      const maxD = l.l1 + l.l2;
      const minD = Math.abs(l.l1 - l.l2);
      let foot = l.foot;
      let knee: Vec2;
      if (d > maxD) {
        // 超伸：骨架打直，脚收到骨长处
        const u = scale(off, 1 / d);
        foot = add(hip, scale(u, maxD));
        knee = add(hip, scale(u, l.l1));
      } else if (d < minD) {
        // 过近：反向打直，脚推到 |l1-l2| 处
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
