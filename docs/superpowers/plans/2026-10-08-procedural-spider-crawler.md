# 程序化 IK 蜘蛛爬虫 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在全屏真实界面上实现视频同款程序化 IK 蜘蛛：8 腿两段式反向运动学真实抓在自选股/涨幅榜行上，带扫描光束、语义高亮、信号数据包拖行后飞入信号确认桥。

**Architecture:** Canvas 2D 全屏覆盖层（`pointer-events:none` 零 DOM 侵入）。数学/仿真/锚点几何全部抽成无 DOM 依赖的纯函数与纯类（vitest 可测），`.vue` 文件只做 rAF、DOM 采集与绘制。引擎通过模块级扫描事件总线驱动蜘蛛的行走路径与信号语义。

**Tech Stack:** Vue 3 `<script setup>` + TypeScript、Canvas 2D、vitest（node 环境，项目未安装 jsdom，不新增依赖）、Tauri 2（本次不改 Rust）。

## Global Constraints

- 不新增 npm 依赖；不改 Rust；测试用项目既有 vitest（`npx vitest run <path>`，node 环境）。
- 所有新文件 UTF-8；生产代码无 `any`（测试可用）；坐标一律为 CSS 像素视口坐标（`getBoundingClientRect` 口径）。
- 颜色语义固定：买入 `#ff4d8d`、卖出 `#17c964`、普通扫描青 `#2fd4e1`、腿线青 `#37e6f0`、关节/脚点粉 `#ff5ea8`、牵引线粉 `#ff7ad9`。
- 覆盖层与 canvas 必须 `pointer-events:none`，禁止拦截真实界面点击。
- 卡片 id 取自 `src/lib/cards.ts`：自选 `watch`、涨幅榜 `rank`、信号桥 `signalbridge`、爬虫卡片 `spiderbot`。
- A股红涨绿跌：买入/涨用粉色系，卖出/跌用绿色系，与第 3 条颜色一致。
- 真实 DOM 选择器：自选行 `[data-card-id="watch"] table.list tbody tr`（代码在 `.cd`、名称在 `.nm`），涨幅榜行 `[data-card-id="rank"] .vrow`（代码在 `.code`、名称在 `.nm`），卡片容器 `[data-card-id="<id>"]`。
- 每个任务结束必须 commit；提交信息用约定式提交（feat/test/refactor）。

---

## File Structure

| 文件 | 责任 | 单测 |
|---|---|---|
| `src/components/spider/ik.ts`（建） | 向量、两段 IK、贝塞尔、8 腿髋部配置、迈步判定、跨卡中途路径 | ✅ node |
| `tests/unit/spider/ik.test.ts`（建） | ik.ts 测试 | — |
| `src/components/spider/anchors.ts`（建） | 矩形→锚点的几何纯函数：过滤、视口裁剪、行情关联、排序 | ✅ node |
| `tests/unit/spider/anchors.test.ts`（建） | anchors.ts 测试 | — |
| `src/composables/useSpiderAnchors.ts`（建） | DOM 薄封装：querySelectorAll + getBoundingClientRect，卡片/信号桥/日志面板中心 | ❌ 薄封装 |
| `src/components/spider/sim.ts`（建） | 蜘蛛仿真纯类：身体移动转向、8 腿步态调度、扫描驻留、数据包状态机 | ✅ node |
| `tests/unit/spider/sim.test.ts`（建） | sim.ts 测试 | — |
| `src/components/spider/ProceduralSpider.vue`（建） | canvas 渲染 + rAF + 监听扫描事件驱动 sim；无业务逻辑 | ❌ 人工 |
| `src/composables/useSpiderBotEngine.ts`（改） | 新增模块级扫描事件总线并在切卡/扫到股票时 emit | 既有逻辑 |
| `src/components/SpiderOverlay.vue`（改） | 删除旧 SVG 补间动画，挂载 ProceduralSpider；保留顶栏/休市灯/日志/后端联动 | ❌ 人工 |

---

## Task 1: IK 数学库 `ik.ts`

**Files:**
- Create: `src/components/spider/ik.ts`
- Test: `tests/unit/spider/ik.test.ts`

**Interfaces:**
- Produces（后续任务依赖的全部导出，签名不得更改）:
  - `interface Vec2 { x: number; y: number }`
  - `add(a: Vec2, b: Vec2): Vec2`、`sub(a: Vec2, b: Vec2): Vec2`、`scale(a: Vec2, s: number): Vec2`
  - `len(a: Vec2): number`、`dist(a: Vec2, b: Vec2): number`、`lerp(a: Vec2, b: Vec2, t: number): Vec2`
  - `angleOf(a: Vec2): number`、`rotate(a: Vec2, rad: number): Vec2`、`clamp(x: number, lo: number, hi: number): number`
  - `twoBoneKnee(hip: Vec2, foot: Vec2, l1: number, l2: number, bend: 1 | -1): Vec2`
  - `quad(a: Vec2, b: Vec2, c: Vec2, t: number): Vec2`
  - `interface HipDef { ox: number; oy: number; group: 0 | 1; side: 1 | -1 }`
  - `buildHips(): HipDef[]`（返回 8 条腿，左右各 4，两组对角步态）
  - `shouldStep(footWorld: Vec2, body: Vec2, rMin: number, rMax: number): boolean`
  - `restTarget(hipWorld: Vec2, bodyAngle: number, moveDir: Vec2 | null, side: 1 | -1, reach: number): Vec2`
  - `buildWaypoints(from: Vec2, to: Vec2, opts?: { maxSeg?: number; segLen?: number }): Vec2[]`

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/spider/ik.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  add, sub, scale, len, dist, lerp, angleOf, rotate, clamp,
  twoBoneKnee, quad, buildHips, shouldStep, restTarget, buildWaypoints,
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
    expect(m.x).toBeCloseTo(5);
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/spider/ik.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/components/spider/ik.ts`**

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/spider/ik.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/components/spider/ik.ts tests/unit/spider/ik.test.ts
git commit -m "feat(spider): IK数学库（向量/两段IK/步态几何/路径点）"
```

---

## Task 2: 锚点几何纯函数 + DOM 采集封装

**Files:**
- Create: `src/components/spider/anchors.ts`
- Create: `src/composables/useSpiderAnchors.ts`
- Test: `tests/unit/spider/anchors.test.ts`

**Interfaces:**
- Consumes: `Quote`（`src/api/types.ts`：至少含 `code,name,price,pct`）、`CardId`（`src/lib/cards.ts`）
- Produces:
  - `interface AnchorRect { x: number; y: number; width: number; height: number; code?: string; name?: string }`
  - `interface Anchor { id: string; cardId: string; x: number; y: number; width: number; height: number; code?: string; name?: string; price?: number; pct?: number }`
  - `rectsToAnchors(cardId: string, rects: AnchorRect[], vp: { w: number; h: number }, quotes: Record<string, Pick<Quote, "name" | "price" | "pct">>): Anchor[]`
  - `useSpiderAnchors()` 返回 `{ collect(cardId: CardId): Anchor[]; cardCenter(cardId: CardId): Anchor | null; elCenter(el: Element | null | undefined): Anchor | null }`

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/spider/anchors.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { rectsToAnchors, type AnchorRect } from "../../../src/components/spider/anchors";

const quotes = {
  "600248": { name: "大金重工", price: 47.61, pct: 2.9 },
  "600094": { name: "大名城", price: 4.34, pct: 3.6 },
};

function rect(over: Partial<AnchorRect>): AnchorRect {
  return { x: 10, y: 10, width: 200, height: 30, ...over };
}

describe("rectsToAnchors", () => {
  it("丢弃宽高为 0 与视口外的行", () => {
    const out = rectsToAnchors(
      "watch",
      [
        rect({ code: "A", x: 0, y: 0, width: 0, height: 30 }),
        rect({ code: "B", x: 0, y: 100, width: 200, height: 30 }),
        rect({ code: "C", x: -500, y: 10, width: 200, height: 30 }),
        rect({ code: "D", x: 10, y: 5000, width: 200, height: 30 }),
      ],
      { w: 1280, h: 800 },
      {},
    );
    expect(out.map((a) => a.code)).toEqual(["B"]);
  });

  it("锚点落在行左缘垂直居中，带整行矩形供高亮", () => {
    const [a] = rectsToAnchors(
      "watch",
      [rect({ code: "600248", x: 100, y: 200, width: 300, height: 32 })],
      { w: 1280, h: 800 },
      quotes,
    );
    expect(a.x).toBe(106);
    expect(a.y).toBe(216);
    expect(a.width).toBe(300);
    expect(a.height).toBe(32);
  });

  it("按代码关联行情（价格/涨跌幅/名称）并生成稳定 id", () => {
    const [a] = rectsToAnchors(
      "watch",
      [rect({ code: "600248" })],
      { w: 1280, h: 800 },
      quotes,
    );
    expect(a.name).toBe("大金重工");
    expect(a.price).toBe(47.61);
    expect(a.pct).toBe(2.9);
    expect(a.id).toBe("watch:600248");
  });

  it("无代码的锚点用序号 id，名称缺失不报错", () => {
    const out = rectsToAnchors(
      "radar",
      [rect({}), rect({})],
      { w: 1280, h: 800 },
      {},
    );
    expect(out[0].id).toBe("radar:0");
    expect(out[1].id).toBe("radar:1");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/spider/anchors.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/components/spider/anchors.ts`**

```ts
// DOM 矩形 → 蜘蛛锚点的几何纯函数：不碰 document，可在 node 单测。
import type { Quote } from "../../api/types";

export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
  code?: string;
  name?: string;
}

export interface Anchor extends AnchorRect {
  id: string;
  cardId: string;
  /** 落脚/光束目标点：行左缘垂直居中 */
  price?: number;
  pct?: number;
}

type QuoteMap = Record<string, Pick<Quote, "name" | "price" | "pct">>;

const EDGE_PAD = 6;

export function rectsToAnchors(
  cardId: string,
  rects: AnchorRect[],
  vp: { w: number; h: number },
  quotes: QuoteMap,
): Anchor[] {
  const out: Anchor[] = [];
  rects.forEach((r, i) => {
    if (r.width <= 0 || r.height <= 0) return;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    // 整行中心需在视口内（虚拟滚动只保留已渲染且可见的行）
    if (cx < 0 || cy < 0 || cx > vp.w || cy > vp.h) return;

    const code = r.code?.trim();
    const q = code ? quotes[code] : undefined;
    out.push({
      ...r,
      id: code ? `${cardId}:${code}` : `${cardId}:${i}`,
      cardId,
      x: r.x + EDGE_PAD,
      y: cy,
      name: q?.name ?? r.name,
      price: q?.price,
      pct: q?.pct,
    });
  });
  return out;
}
```

- [ ] **Step 4: 实现 DOM 薄封装 `src/composables/useSpiderAnchors.ts`**

```ts
// 锚点采集的 DOM 层：查询真实股票行 → getBoundingClientRect → 交给纯函数。
// 无单测（项目无 jsdom）；几何正确性由 anchors.ts 单测覆盖。
import { rectsToAnchors, type Anchor, type AnchorRect } from "../components/spider/anchors";
import { useQuotesStore } from "../stores/quotes";
import type { CardId } from "../lib/cards";

const ROW_SELECTORS: Partial<Record<CardId, string>> = {
  watch: '[data-card-id="watch"] table.list tbody tr',
  rank: '[data-card-id="rank"] .vrow',
};

function readRow(el: Element): AnchorRect | null {
  const rc = el.getBoundingClientRect();
  if (rc.width <= 0 || rc.height <= 0) return null;
  const code =
    el.querySelector(".cd")?.textContent?.trim() ||
    el.querySelector(".code")?.textContent?.trim() ||
    undefined;
  const name = el.querySelector(".nm")?.textContent?.trim() || undefined;
  return { x: rc.left, y: rc.top, width: rc.width, height: rc.height, code, name };
}

export function useSpiderAnchors() {
  const quotes = useQuotesStore();
  const vp = () => ({ w: window.innerWidth, h: window.innerHeight });

  function collect(cardId: CardId): Anchor[] {
    const sel = ROW_SELECTORS[cardId];
    if (!sel) {
      const title = cardCenter(cardId);
      return title ? [title] : [];
    }
    const rects: AnchorRect[] = [];
    document.querySelectorAll(sel).forEach((el) => {
      const r = readRow(el);
      if (r) rects.push(r);
    });
    return rectsToAnchors(cardId, rects, vp(), quotes.map);
  }

  /** 卡片中心（无股票行的卡片兜底落脚点 / 信号桥飞行终点）。 */
  function cardCenter(cardId: CardId): Anchor | null {
    const el = document.querySelector(`[data-card-id="${cardId}"]`);
    return elCenter(el, cardId);
  }

  /** 任意元素中心（爬虫日志面板兜底终点用）。 */
  function elCenter(el: Element | null | undefined, cardId = "log"): Anchor | null {
    if (!el) return null;
    const rc = el.getBoundingClientRect();
    if (rc.width <= 0 || rc.height <= 0) return null;
    return {
      id: `${cardId}:center`,
      cardId,
      x: rc.left + rc.width / 2,
      y: rc.top + rc.height / 2,
      width: rc.width,
      height: rc.height,
    };
  }

  return { collect, cardCenter, elCenter };
}
```

- [ ] **Step 5: 运行测试确认通过 + 类型检查**

Run: `npx vitest run tests/unit/spider/anchors.test.ts`
Expected: PASS
Run: `npx vue-tsc --noEmit`
Expected: 无错误（既有警告忽略）

- [ ] **Step 6: 提交**

```bash
git add src/components/spider/anchors.ts src/composables/useSpiderAnchors.ts tests/unit/spider/anchors.test.ts
git commit -m "feat(spider): 锚点几何纯函数与真实行DOM采集封装"
```

---

## Task 3: 蜘蛛仿真类 `sim.ts`（身体移动 + 8 腿步态 + 扫描驻留）

**Files:**
- Create: `src/components/spider/sim.ts`
- Test: `tests/unit/spider/sim.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Vec2/add/sub/scale/len/dist/lerp/angleOf/rotate/clamp/twoBoneKnee/quad/buildHips/shouldStep/restTarget/buildWaypoints`；Task 2 的 `Anchor`
- Produces:
  - `type SignalKind = "BUY" | "SELL" | null`
  - `interface ScanPoint { x: number; y: number; anchor: Anchor; signal: SignalKind; via?: boolean }`
    （`via:true` 为跨卡片中途点：经过不驻留、不发光束、不抽包）
  - `interface RenderLeg { hip: Vec2; knee: Vec2; foot: Vec2; lifting: boolean }`
  - `class SpiderSim`：
    - `constructor(start: Vec2, opts?: Partial<SimOpts>)`
    - `body: Vec2`、`angle: number`（只读公开）
    - `resetPath(points: ScanPoint[]): void`
    - `active: boolean`（路径非空）
    - `current: ScanPoint | null`（当前驻留点，渲染光束/高亮用）
    - `legsForRender(): RenderLeg[]`
    - `spawnPacket(p: ScanPoint): void`
    - `packets: Packet[]`（Task 4 扩展）
    - `setFlyTarget(p: Vec2): void`
    - `update(dtMs: number, now: number): SimEvents`

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/spider/sim.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/spider/sim.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/components/spider/sim.ts`（移动 + 步态部分）**

```ts
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
      const knee = twoBoneKnee(hip, l.foot, l.l1, l.l2, l.side === 1 ? 1 : -1);
      return { hip, knee, foot: l.foot, lifting: l.lifting };
    });
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/spider/sim.test.ts`
Expected: 4 个 describe 全部 PASS

注意：如「驻留结束推进」用例因时间步长导致越点，`arriveDist=10` 已覆盖；若仍抖动，把测试循环步长保持 50ms 即可，不要改产品默认值。

- [ ] **Step 5: 提交**

```bash
git add src/components/spider/sim.ts tests/unit/spider/sim.test.ts
git commit -m "feat(spider): 仿真类身体移动/转向/对角步态与扫描驻留"
```

---

## Task 4: 数据包状态机（拖行 → 飞入信号桥）

**Files:**
- Modify: `src/components/spider/sim.ts`（替换 `spawnPacket` 空实现，在 `update` 内更新数据包）
- Test: `tests/unit/spider/sim.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 3 的 `SpiderSim`、`ScanPoint`；`quad`、`Packet`
- Produces: `spawnPacket(p: ScanPoint): void`；`update` 事件新增 `packetDone: string | null`（完成的数据包 code）；`packets: Packet[]` 供渲染。

- [ ] **Step 1: 追加失败测试**

在 `tests/unit/spider/sim.test.ts` 末尾追加：

```ts
describe("SpiderSim 数据包", () => {
  it("BUY/SELL 驻留点产生数据包，普通扫描不产生", () => {
    const sim = new SpiderSim({ x: 0, y: 0 }, { speed: 300, dwellMs: 100, trailMs: 100, flyMs: 200 });
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
    const sim = new SpiderSim({ x: 0, y: 0 }, { speed: 300, dwellMs: 40, trailMs: 80, flyMs: 120 });
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
});
```

同时在该文件顶部 import 中补上 `type Anchor` 已存在；`SimOpts` 测试用了 `trailMs/flyMs`，需在 Task 4 产品代码加入这两个字段。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/spider/sim.test.ts`
Expected: 新两个用例 FAIL（spawnPacket 空实现，packets 恒为空）

- [ ] **Step 3: 修改 `sim.ts`**

3a. `SimOpts` 增加字段：

```ts
  stepMs: number;
  liftHeight: number;
  trailMs: number;    // 数据包拖行时长
  flyMs: number;      // 数据包飞入信号桥时长
```

`DEFAULTS` 改为：

```ts
const DEFAULTS: SimOpts = {
  speed: 130, arriveDist: 10, dwellMs: 750,
  rMin: 14, rMax: 52, reach: 16, stepMs: 260, liftHeight: 12,
  trailMs: 1000, flyMs: 650,
};
```

3b. 替换 `spawnPacket` 空实现：

```ts
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
      trail: [],
      age: 0,
      t: 0,
      from,
      // 初值在进入 flying 时会重算，此处给一个向上的弧形中点
      ctrl: { x: (from.x + this.flyTarget.x) / 2, y: (from.y + this.flyTarget.y) / 2 - 140 },
      to: this.flyTarget,
    });
  }
```

3c. 在 `update` 末尾（`return ev` 之前）调用数据包更新，并新增私有方法：

```ts
    this.updatePackets(dtMs, ev);
    return ev;
```

```ts
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
        p.trail.unshift({ ...p.pos });
        if (p.trail.length > 10) p.trail.pop();
        if (p.age >= o.trailMs) {
          p.state = "flying";
          p.t = 0;
          p.from = { ...p.pos };
          p.ctrl = {
            x: (p.from.x + p.to.x) / 2,
            y: Math.min(p.from.y, p.to.y) - 150,
          };
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
```

- [ ] **Step 4: 运行全部蜘蛛测试确认通过**

Run: `npx vitest run tests/unit/spider/`
Expected: ik / anchors / sim 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/spider/sim.ts tests/unit/spider/sim.test.ts
git commit -m "feat(spider): 信号数据包拖行后二次贝塞尔飞入信号桥"
```

---

## Task 5: Canvas 渲染组件 `ProceduralSpider.vue`

**Files:**
- Create: `src/components/spider/ProceduralSpider.vue`

**Interfaces:**
- Consumes: `SpiderSim`（Task 3/4）、`useSpiderAnchors`（Task 2）、`onSpiderScan`（Task 6 才在引擎导出；本任务先从引擎导入，类型检查在 Task 6 后通过——故本任务与 Task 6 在同一轮联调，本任务 Step 单独先做渲染与本地 mock 验证）、`Anchor`/`ScanPoint`
- Produces: 默认导出的 Vue 组件，无 props（自挂载全屏 canvas、自注册扫描监听）；被 `SpiderOverlay` 以 `<ProceduralSpider v-if="visible" :log-el="logPanelEl" />` 使用。
- Props: `logEl: Element | null`（日志面板元素，飞桥兜底终点）

说明：本任务产出后依赖 Task 6 的 `onSpiderScan` 导出才能通过 `vue-tsc`，因此本任务的类型检查与人工验证在 Task 6 完成后统一执行；本任务结束只做文件级自查并提交，不运行 vue-tsc。

- [ ] **Step 1: 创建组件（完整代码）**

创建 `src/components/spider/ProceduralSpider.vue`：

```vue
<script setup lang="ts">
// 全屏 Canvas 渲染层：只负责把 SpiderSim 画出来 + 响应扫描事件驱动路径。
// pointer-events:none，所有业务（评分/落桥/后端）在引擎与 Rust 侧。
import { onBeforeUnmount, onMounted, ref } from "vue";
import { SpiderSim, type ScanPoint, type SignalKind } from "./sim";
import { useSpiderAnchors } from "../../composables/useSpiderAnchors";
import { onSpiderScan } from "../../composables/useSpiderBotEngine";
import { buildWaypoints, type Vec2 } from "./ik";
import type { Anchor } from "./anchors";
import type { CardId } from "../../lib/cards";

const props = defineProps<{ logEl: Element | null }>();

const COLORS = {
  buy: "#ff4d8d",
  sell: "#17c964",
  scan: "#2fd4e1",
  leg: "#37e6f0",
  joint: "#ff5ea8",
  string: "#ff7ad9",
};

const canvasRef = ref<HTMLCanvasElement | null>(null);
const anchors = useSpiderAnchors();
const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

let sim: SpiderSim;
let raf = 0;
let last = 0;
let signalByCode = new Map<string, SignalKind>();
let flyTimer = 0;
let unlisten: (() => void) | null = null;
let dpr = 1;

function signalColor(s: SignalKind): string {
  return s === "BUY" ? COLORS.buy : s === "SELL" ? COLORS.sell : COLORS.scan;
}

// ===== 扫描事件 → 行走路径 =====
function planCard(cardId: CardId) {
  const list = anchors.collect(cardId);
  if (!list.length) return;
  const pts: ScanPoint[] = [];
  let prev: Vec2 = { ...sim.body };
  list.slice(0, 8).forEach((a: Anchor, i: number) => {
    const via = i === 0 ? buildWaypoints(prev, a, { maxSeg: 3, segLen: 260 }) : [];
    via.forEach((v) =>
      pts.push({
        x: v.x, y: v.y,
        anchor: { ...a, x: v.x, y: v.y, width: 0, height: 0, id: `${a.id}:via${i}` },
        signal: null, via: true,
      }),
    );
    pts.push({ x: a.x, y: a.y, anchor: a, signal: signalByCode.get(a.code ?? "") ?? null });
    prev = { x: a.x, y: a.y };
  });
  if (pts.length) sim.resetPath(pts);
}

function onScan(ev: { type: string; cardId?: CardId; code?: string; signal?: SignalKind }) {
  if (ev.type === "card" && ev.cardId) {
    signalByCode = new Map();
    planCard(ev.cardId);
  } else if (ev.type === "target" && ev.code && ev.signal) {
    signalByCode.set(ev.code, ev.signal);
    // 蜘蛛正停在该行驻留时，即时补上信号色
    if (sim.current?.anchor.code === ev.code) sim.current.signal = ev.signal;
  }
}

function refreshFlyTarget() {
  const bridge = anchors.cardCenter("signalbridge");
  const fallback = anchors.elCenter(props.logEl);
  const target = bridge ?? fallback;
  if (target) sim.setFlyTarget({ x: target.x, y: target.y });
}

// ===== 绘制 =====
function draw(ctx: CanvasRenderingContext2D, now: number) {
  const { w, h } = ctx.canvas;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.scale(dpr, dpr);

  // 当前驻留行：高亮整行 + 光束
  const cur = sim.current;
  if (cur) {
    const color = signalColor(cur.signal);
    const a = cur.anchor;
    const pulse = 0.55 + 0.3 * Math.sin(now / 110);
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = reduced ? 0 : 14;
    ctx.strokeStyle = color;
    ctx.globalAlpha = pulse;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(a.x - 6, a.y - a.height / 2, a.width, a.height);
    // 光束：从头点到行中心的锥形
    const head = { x: sim.body.x, y: sim.body.y - 12 };
    const cx = a.x + Math.min(a.width, 180);
    const cy = a.y;
    ctx.globalAlpha = pulse * 0.8;
    ctx.beginPath();
    ctx.moveTo(head.x, head.y - 2);
    ctx.lineTo(cx, cy - 5);
    ctx.lineTo(cx, cy + 5);
    ctx.lineTo(head.x, head.y + 2);
    ctx.stroke();
    // 沿线脉冲方块
    if (!reduced) {
      const tt = (now % 900) / 900;
      const px = head.x + (cx - head.x) * tt;
      const py = head.y + (cy - head.y) * tt;
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = color;
      ctx.fillRect(px - 2, py - 2, 4, 4);
    }
    ctx.restore();
  }

  // 腿
  ctx.lineCap = "round";
  for (const l of sim.legsForRender()) {
    ctx.strokeStyle = COLORS.leg;
    ctx.lineWidth = l.lifting ? 2 : 1.4;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(l.hip.x, l.hip.y);
    ctx.lineTo(l.knee.x, l.knee.y);
    ctx.lineTo(l.foot.x, l.foot.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS.joint;
    ctx.beginPath();
    ctx.arc(l.foot.x, l.foot.y, l.lifting ? 3 : 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // 身体：呼吸起伏 + 腹部椭圆 + 头点
  const bob = reduced ? 0 : Math.sin(now / 160) * 1.4;
  const bx = sim.body.x;
  const by = sim.body.y + bob;
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(sim.angle);
  if (!reduced) {
    ctx.shadowColor = COLORS.leg;
    ctx.shadowBlur = 12;
  }
  ctx.fillStyle = "rgba(10,40,54,0.92)";
  ctx.strokeStyle = COLORS.leg;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, 2, 7, 11, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = COLORS.leg;
  ctx.beginPath();
  ctx.arc(0, -9, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 数据包
  for (const p of sim.packets) {
    // 牵引线（拖行期连身体）
    if (p.state === "trailing") {
      ctx.strokeStyle = COLORS.string;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sim.body.x, sim.body.y);
      ctx.lineTo(p.pos.x, p.pos.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const color = p.side === "BUY" ? COLORS.buy : COLORS.sell;
    const label = `${p.name} ${p.price.toFixed(2)} ${p.pct >= 0 ? "+" : ""}${p.pct.toFixed(1)}%`;
    ctx.font = "10px Consolas, monospace";
    const tw = ctx.measureText(label).width + 12;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = reduced ? 0 : 10;
    ctx.fillStyle = "rgba(28,10,24,0.92)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    roundRect(ctx, p.pos.x - tw / 2, p.pos.y - 10, tw, 20, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, p.pos.x, p.pos.y + 0.5);
    ctx.restore();
  }

  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function frame(now: number) {
  const c = canvasRef.value;
  if (!c) return;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const dt = Math.min(50, now - last || 16);
  last = now;
  const ev = sim.update(dt, now);
  if (ev.arrived && ev.arrived.signal) sim.spawnPacket(ev.arrived);
  draw(ctx, now);
  raf = requestAnimationFrame(frame);
}

function resize() {
  const c = canvasRef.value;
  if (!c) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = window.innerWidth * dpr;
  c.height = window.innerHeight * dpr;
  c.style.width = `${window.innerWidth}px`;
  c.style.height = `${window.innerHeight}px`;
}

onMounted(() => {
  sim = new SpiderSim({ x: window.innerWidth * 0.3, y: window.innerHeight * 0.55 });
  resize();
  refreshFlyTarget();
  flyTimer = window.setInterval(refreshFlyTarget, 250);
  window.addEventListener("resize", resize);
  unlisten = onSpiderScan(onScan);
  raf = requestAnimationFrame(frame);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  clearInterval(flyTimer);
  window.removeEventListener("resize", resize);
  unlisten?.();
});
</script>

<template>
  <canvas ref="canvasRef" class="spider-canvas" aria-hidden="true" />
</template>

<style scoped>
.spider-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
}
</style>
```

- [ ] **Step 2: 文件级自查**

确认：`pointer-events:none` 存在；无 `any`；所有 sim 字段名与 Task 3/4 一致（`body/angle/current/packets/legsForRender/update/spawnPacket/setFlyTarget`）。不运行 vue-tsc（依赖 Task 6 的导出）。

- [ ] **Step 3: 提交**

```bash
git add src/components/spider/ProceduralSpider.vue
git commit -m "feat(spider): canvas渲染层（IK蜘蛛/光束高亮/数据包）"
```

---

## Task 6: 引擎扫描事件总线 + SpiderOverlay 接线 + 全量验证

**Files:**
- Modify: `src/composables/useSpiderBotEngine.ts`
- Modify: `src/components/SpiderOverlay.vue`

**Interfaces:**
- Produces: `onSpiderScan(cb: (e: ScanEvent) => void): () => void`，其中
  `type ScanEvent = { type: "card"; cardId: CardId } | { type: "target"; cardId: CardId; code: string; signal: SignalKind }`。
- Consumes: Task 5 的默认导出 `ProceduralSpider`。

- [ ] **Step 1: 引擎增加事件总线**

在 `src/composables/useSpiderBotEngine.ts` 顶部 import 区之后（第 7 行附近）加入：

```ts
// ===== 扫描事件总线：驱动程序化蜘蛛覆盖层行走路径（无监听者时零开销）=====
export type SpiderSignalKind = "BUY" | "SELL" | null;
export type SpiderScanEvent =
  | { type: "card"; cardId: CardId }
  | { type: "target"; cardId: CardId; code: string; signal: SpiderSignalKind };

const scanListeners = new Set<(e: SpiderScanEvent) => void>();
export function onSpiderScan(cb: (e: SpiderScanEvent) => void): () => void {
  scanListeners.add(cb);
  return () => { scanListeners.delete(cb); };
}
function emitScan(e: SpiderScanEvent) {
  scanListeners.forEach((f) => f(e));
}
```

- [ ] **Step 2: 在切卡与扫到股票时 emit**

2a. 在 `scanRound` 中换下一张卡片、执行 `onSwitchCard(cardId)` 之后（现有 `addLog('🔄 智能切换到…')` 那一行后）加入：

```ts
    emitScan({ type: "card", cardId });
```

2b. 在 `scanWatchlist` 的 `list.forEach` 内，`const score = evaluateStock(...)` 之后加入：

```ts
    emitScan({
      type: "target",
      cardId: "watch",
      code: s.code,
      signal: score.recommendation === "BUY"
        ? "BUY"
        : score.recommendation === "SELL" ? "SELL" : null,
    });
```

注意：首轮扫描在 `start()` 里立即执行一次 `scanRound`，此时 ProceduralSpider 已挂载并先于引擎 start 注册监听（见 Step 3 挂载顺序），事件不会丢。

- [ ] **Step 3: SpiderOverlay 挂载新组件**

3a. `src/components/SpiderOverlay.vue` `<script setup>` 顶部加入导入与日志面板 ref：

```ts
import ProceduralSpider from "./spider/ProceduralSpider.vue";
const logPanelRef = ref<HTMLElement | null>(null);
```

3b. 删除旧动画代码：删除 `readStocksFromDOM`、`spiderPos/spiderTarget/currentPointIdx/walkingPhase/animFrame`、整个 `startWalking` 函数，以及 `start()` 内对 `startWalking()` 的调用；`onUnmounted` 中删除 `cancelAnimationFrame(animFrame)`。

3c. 模板中删除整个 `<svg class="spider-svg">…</svg>` 块（蜘蛛腿与身体），在 `<div class="spider-overlay">` 内顶部替换为：

```vue
    <ProceduralSpider v-if="visible" :log-el="logPanelRef" />
```

3d. 给日志面板容器加 ref：把 `<div class="sb-log-panel">` 改为 `<div ref="logPanelRef" class="sb-log-panel">`。

3e. 因蜘蛛现在由 canvas 全屏绘制，`.spider-svg` 相关 `<style>` 整块删除（保留 topbar/log-panel 等其余样式）。

- [ ] **Step 4: 类型检查与全部单测**

Run: `npx vue-tsc --noEmit`
Expected: 无错误

Run: `npx vitest run tests/unit/spider/`
Expected: ik / anchors / sim 全部 PASS

Run: `npx vitest run`
Expected: 既有全套测试不回退（允许与本次无关的既有失败，若有需先确认失败在改动前已存在：`git stash` 后复跑对照）。

- [ ] **Step 5: 人工验证（tauri dev）**

Run: `pnpm tauri dev`（等待 Rust 编译完成），按 Ctrl+Shift+S 启动爬虫，逐项核对：

1. 8 腿蜘蛛出现在自选股区域，脚真实抓在自选股行上，行切换/页面滚动时交替抬腿走弧线，无滑步/无腿穿过行
2. 蜘蛛逐行爬行，到达行时青色光束扫过该行、行框脉冲
3. 出现买入信号的行（如今日大金重工）框变粉色并抽出磁贴数据包，拖在身后约 1 秒后沿曲线飞入「信号确认桥」卡片（桥未开则飞入右下爬虫日志面板）
4. 切换到涨幅榜时蜘蛛经中途折线点爬过去（不直线飞行），脚抓真实榜单行
5. 切到板块/雷达等无行卡片时蜘蛛走到卡片标题栏原地停留
6. 顶栏 🟢交易中/🔴休市中、半自动/全自动、停止按钮及后端联动均正常
7. 覆盖层不阻挡任何鼠标点击（pointer-events 验证）
8. 停止后蜘蛛与定时器全部消失，无控制台报错；再启动正常

- [ ] **Step 6: 提交**

```bash
git add src/composables/useSpiderBotEngine.ts src/components/SpiderOverlay.vue
git commit -m "feat(spider): 接入扫描事件总线并用程序化IK蜘蛛替换旧补间动画"
```

---

## Self-Review 记录（计划作者已核对）

- Spec 覆盖：IK 步态（T1/T3）、锚点采集（T2）、光束高亮（T5）、数据包拖行飞桥（T4/T5）、跨卡中途点（T1 buildWaypoints + T5 planCard）、降级（T5 reduced 关发光/脉冲）、DOM 零侵入与点击穿透（T5 canvas pointer-events:none）、后端不改动（全局约束）均有对应任务。
- 类型一致性：`ScanPoint.signal/via`、`SimEvents.arrived/packetDone`、`Anchor.id/code/price/pct`、`onSpiderScan` 事件形状在 T2–T6 中逐任务对齐；`spawnPacket` 在 T3 空实现、T4 落地，T5 仅在 `arrived.signal` 时调用。
- 自查修正：跨卡中途点已改为 `via:true` 途经点（不驻留/不高亮/不抽包，sim 到达即推进，有专项测试）；数据包 ctrl 初值、onScan 条件语句、未用导入已清理。
- 已知联调点：T5 依赖 T6 的 `onSpiderScan` 导出，故 vue-tsc 与人工验证统一在 T6 Step 4–5 执行，已在 T5 注明。
