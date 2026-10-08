// 蜘蛛仿真纯类：身体移动/转向、8 腿步态调度、扫描驻留。
// 无 DOM / canvas；渲染层只读 body / legsForRender / current / packets。
import {
  type Vec2, add, sub, scale, len, lerp, angleOf, rotate, clamp,
  twoBoneKnee, quad, buildHips, restTarget,
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
  dwellMs: number;     // 到达后扫描驻留
  reach: number;       // 落脚点相对髋的前移量
  stepMs: number;      // 单腿 swing 时长（抬脚弧）
  stridePeriod: number;// 步态周期 s：同组 4 腿在一个周期内等相位错步
  liftHeight: number;  // 抬脚弧高
  maxTurnRate: number; // 最大转向角速度 rad/s（髋绕身体旋转，过快会把钉地的脚甩出骨长）
  trailMs: number;     // 数据包拖行时长
  flyMs: number;       // 数据包飞入信号桥时长
  reducedMotion?: boolean; // 减少动态：驻留不原地踏步，数据包走直线
}

export interface SimEvents {
  arrived: ScanPoint | null;
  packetDone: string | null;
}

interface Leg {
  ox: number; oy: number; group: 0 | 1; side: 1 | -1;
  l1: number; l2: number;
  /** 该腿在步态周期中的固定相位 0..1（trot：组内等间隔、两组错开半拍） */
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
  state: "trailing" | "flying";
  pos: Vec2;
  age: number;
  t: number;
  from: Vec2;
  ctrl: Vec2;
  to: Vec2;
}

// 步态采用「固定相位 trot」（非环带异步触发——后者会相位堆积导致超伸滑步）：
// 同组 4 腿在 stridePeriod 内按 0/¼/½/¾ 等相位错步，g1 相对 g0 错开 1/8；
// 每腿在自己的 swing 窗口（stepMs/period 占空）抬脚、落到髋前 reach 处，其余时间钉地。
// 自洽性（骨长 l1+l2=26，speed=70, period=0.4, swing=0.08）：
//   占空 0.2 < 组内相位间隔 0.25（同组至多 1 腿离地）；
//   每腿站立 0.32s 身体位移 22.4px，脚从髋前 14 流到髋后 8.4，
//   站立末脚距髋仅 ~10px，全周期恒在骨链内，不超伸、不滑步。
// 转向：起步即对准+脚重落位；驻留期以 maxTurnRate 预转下一点（身体静止，腿从容重踏）。
const DEFAULTS: SimOpts = {
  speed: 70, arriveDist: 10, dwellMs: 750,
  reach: 14, stepMs: 80, stridePeriod: 0.4, liftHeight: 9,
  maxTurnRate: 1.4,
  trailMs: 1000, flyMs: 650,
  reducedMotion: false,
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
  private legs: Leg[] = [];
  private gaitClock = 0; // 步态相位时钟（周期份额 0..1）
  private flyTarget: Vec2 | null = null;

  constructor(start: Vec2, opts: Partial<SimOpts> = {}) {
    this.body = { ...start };
    this.opts = { ...DEFAULTS, ...opts };
    this.relayoutFeet();
  }

  /**
   * 按稳态相位分布放 8 脚并分配 trot 相位（新一轮起步调用）：
   * c=0 时站立腿 phase=φ 的脚在身体纵轴 fwd=−14+28φ 处
   * （落地脚髋前 8.4 = 14−v×swing，再按 (0.8−φ) 周期后流），
   * 保证等待 swing 期间身体位移不把脚甩出骨链。
   */
  private relayoutFeet(): void {
    const within = [0, 0];
    this.legs = buildHips().map((h) => {
      const k = within[h.group]++;
      // g0: 0,.25,.5,.75；g1 错开半格 0.125 → 两组 swing 窗口尽量不重叠
      const phase = h.group === 0 ? k * 0.25 : (k * 0.25 + 0.125) % 1;
      // 稳态分布（v×P=28，sf=0.2）：开窗时定落点（髋前 14），swing 80ms 内身体
      // 已进 5.6，故落地即在髋前 8.4；c=0 时站立腿 φ 自落地过了 (0.8−φ) 周期：
      //   fwd = 8.4 − 28(0.8−φ) = −14+28φ
      // φ∈[.2,.8] 站立脚 fwd∈[−8.4, 8.4]，等待自身窗口期间最远流到髋后 ~14，全在骨链内。
      const fwd = -14 + 28 * phase;
      const local = { x: h.ox + h.side * 5.6, y: h.oy - fwd };
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

  resetPath(points: ScanPoint[]): void {
    this.path = points;
    this.idx = points.length ? 0 : -1;
    this.scanUntil = 0;
    // 起步即对准第一点，8 脚在新朝向下重新落位：避免 90° 起步转向把钉地的脚
    // 甩出骨链（新一轮爬行刚开始，脚无历史位置，直接落位无可视瞬移感）。
    if (points.length) {
      const d = sub(points[0], this.body);
      if (len(d) > 1) this.angle = angleOf(d) + Math.PI / 2;
      this.relayoutFeet();
    }
  }

  setFlyTarget(p: Vec2): void {
    this.flyTarget = p;
  }

  /** 驻留点产生数据包：无信号或缺 code 的点忽略。数据包先拖在身后，到点飞入信号桥。 */
  spawnPacket(p: ScanPoint): void {
    if (!p.signal || !p.anchor.code) return;
    const back = rotate({ x: 0, y: 26 }, this.angle);
    const from = add(this.body, back);
    this.packets.push({
      code: p.anchor.code,
      name: p.anchor.name ?? p.anchor.code,
      side: p.signal,
      price: p.anchor.price ?? 0,
      pct: p.anchor.pct ?? 0,
      state: "trailing",
      pos: from,
      age: 0,
      t: 0,
      from,
      // 初值在进入 flying 时会重算，此处给一个向上的弧形中点（未设信号桥时以原地占位）
      ctrl: this.flyTarget
        ? { x: (from.x + this.flyTarget.x) / 2, y: (from.y + this.flyTarget.y) / 2 - 140 }
        : { x: from.x, y: from.y - 140 },
      to: this.flyTarget ? { ...this.flyTarget } : { ...from },
    });
    // 无桥保护：拖行包上限 8，超出丢弃最老（正常产品路径 flyTarget 在组件挂载时即配置，
    // 此分支只防止无头/异常调用下数据包无限堆积）
    const trailing = this.packets.filter((x) => x.state === "trailing");
    if (trailing.length > 8) this.packets.splice(this.packets.indexOf(trailing[0]), 1);
  }

  private hipWorld(h: { ox: number; oy: number }): Vec2 {
    return add(this.body, rotate({ x: h.ox, y: h.oy }, this.angle));
  }

  /**
   * 固定相位 trot 步态：推进 gaitClock，每条腿仅在自己的 swing 相位窗口抬脚，
   * 沿二次贝塞尔弧线落到髋前 reach 处（可达域内），窗口外钉地不动。
   * clockSpeed：移动=1，驻留=慢拍小踏步，空闲=0。
   * 结构性保证：swing 占空 stepMs/period < 组内相位间隔 0.25，
   * 故同组至多 1 腿、全局至多 2 腿同时离地。
   */
  private advanceLegs(dtMs: number, moveDir: Vec2 | null, clockSpeed: number): void {
    const o = this.opts;
    const P = o.stridePeriod;
    const swingFrac = clamp((o.stepMs / 1000 / P), 0.05, 0.24);
    // gaitClock 用周期份额（0..1）：本帧推进 dt/周期 × 速度倍率
    this.gaitClock = (this.gaitClock + ((dtMs / 1000) * clockSpeed) / P) % 1;

    const c = this.gaitClock;
    for (const l of this.legs) {
      // swing 是周期上的圆弧 [phase, phase+swingFrac)，允许跨 0 环绕
      const start = l.phase;
      const end = (l.phase + swingFrac) % 1;
      const inSwing = start < end
        ? c >= start && c < end
        : c >= start || c < end;
      const arc = (c - start + 1) % 1; // 沿弧从窗口起点走过的份额（0..swingFrac）
      const hip = this.hipWorld(l);
      if (inSwing) {
        // 进入窗口瞬间定落点（站立脚钉到此刻为止）
        if (!l.lifting) {
          l.lifting = true;
          l.from = { ...l.foot };
          let to = restTarget(hip, this.angle, moveDir, l.side, o.reach);
          // 落脚点钳在骨链可达域内（留 1.5px 余量）
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
        // 离开窗口（含大 dt 跳变）：精确落位
        l.lifting = false;
        l.t = 1;
        l.foot = { ...l.to };
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
        // 驻留扫描：身体静止，但提前转向下一个路径点。
        // 静止旋转时髋切向线速度很低，脚能从容重踏，移动段就无需大角度急转。
        if (now >= this.scanUntil) {
          this.scanUntil = 0;
          this.idx++;
        } else if (this.idx + 1 < this.path.length) {
          const nxt = this.path[this.idx + 1];
          const want = angleOf(sub(nxt, this.body)) + Math.PI / 2;
          let diff = want - this.angle;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          const maxTurn = (o.maxTurnRate * dtMs) / 1000;
          this.angle += clamp(diff, -maxTurn, maxTurn);
        }
        // 驻留：身体静止，步态慢拍原地小踏步（脚落回休息位）；减少动态时不踏步
        this.advanceLegs(dtMs, null, o.reducedMotion ? 0 : 0.35);
      } else if (d <= o.arriveDist) {
        this.body = { ...tgt };
        if (tgt.via) {
          // 跨卡片中途点：直接通过，不驻留/不发光束；按当前朝向正常摆腿
          this.idx++;
          this.advanceLegs(dtMs, scale(to, 1 / Math.max(d, 0.001)), 1);
        } else {
          this.scanUntil = now + o.dwellMs;
          ev.arrived = tgt;
          this.advanceLegs(dtMs, null, o.reducedMotion ? 0 : 0.35);
        }
      } else {
        const dir = scale(to, 1 / d);
        // 身体朝向移动方向（起步与预转后通常已对齐）；残余折角限速跟随
        const want = angleOf(dir) + Math.PI / 2;
        let diff = want - this.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const maxTurn = (o.maxTurnRate * dtMs) / 1000;
        this.angle += clamp(diff, -maxTurn, maxTurn);
        // 残余大折角（via 折线）时减速，减少髋旋转对钉地脚的拉扯
        const turning = Math.abs(diff) > 0.25;
        const speedNow = turning ? o.speed * 0.5 : o.speed;
        const step = Math.min(d, (speedNow * dtMs) / 1000);
        this.body = add(this.body, scale(dir, step));
        this.advanceLegs(dtMs, dir, 1);
      }
    } else {
      // 路径走完：摆动中的腿立即收回到落点（到站收腿，避免脚永久冻结在弧顶）
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

  /**
   * 数据包状态机：
   * trailing —— 拖在身体后方（随时间左右轻摆），满 trailMs 进入 flying；
   * flying —— 沿二次贝塞尔弧线飞向信号桥，到点发 packetDone(code) 并移除。
   * 未设置信号桥（flyTarget=null）时数据包持续拖行，不会凭空飞走。
   */
  private updatePackets(dtMs: number, ev: SimEvents): void {
    const o = this.opts;
    const back = rotate({ x: 0, y: 26 }, this.angle);
    const anchorPos = add(this.body, back);
    const keep: Packet[] = [];
    for (const p of this.packets) {
      if (p.state === "trailing") {
        p.age += dtMs;
        // 拖在身体后方，随时间左右轻摆
        const sway = Math.sin(p.age / 130) * 6;
        const perp = rotate({ x: sway, y: 0 }, this.angle);
        p.pos = add(anchorPos, perp);
        if (p.age >= o.trailMs && this.flyTarget) {
          p.state = "flying";
          p.t = 0;
          p.from = { ...p.pos };
          p.to = { ...this.flyTarget };
          if (o.reducedMotion) {
            // 控制点取 from/to 精确中点：二次贝塞尔退化为直线
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
      } else {
        p.t = clamp(p.t + dtMs / o.flyMs, 0, 1);
        p.pos = quad(p.from, p.ctrl, p.to, p.t);
        if (p.t >= 1) {
          ev.packetDone = p.code; // 到达信号桥
        } else {
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
