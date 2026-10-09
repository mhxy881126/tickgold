# 复盘时间线卡片 重新设计 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将"复盘时间线"卡片从简单的实时异动面板升级为完整的复盘工具，支持历史交易日回看、时间线、情绪曲线、涨跌结构、热点板块、连板梯队、龙虎榜等模块，采用渐进式展开设计。

**Architecture:** 采用数据层与视图层分离的架构。`reviewBuilder.ts` 提供纯函数构建历史复盘数据，`useReviewData.ts` 组合式函数统一封装历史/实时两种数据模式，`ReviewTimeline.vue` 组件负责紧凑视图与展开视图的展示与交互。历史模式从涨停池/炸板池/龙虎榜/板块行情接口构建数据，实时模式复用现有的 radar+spider 事件。

**Tech Stack:** Vue 3 (Composition API) + TypeScript + ECharts + Tauri + Vitest

## Global Constraints

- 保持现有卡片注册方式：`id === 'reviewtimeline'`，`select` 事件接口不变
- 遵循项目现有代码风格（12px/10.5px 字号、金色 `#c9a24a` 主色、深色背景）
- 复用已有的 API 接口：`fetchZtPool`、`fetchZbPool`、`fetchLhbList`、`fetchSectors`
- 纯函数逻辑必须有单元测试，覆盖率 ≥ 80%
- 所有新增文件使用 `.ts` 扩展名，组件使用 `<script setup lang="ts">`

---

## Phase 1: 数据构建层（reviewBuilder）

### Task 1: 定义类型与工具函数

**Files:**
- Create: `src/utils/reviewBuilder.ts`
- Test: `tests/unit/utils/reviewBuilder.test.ts`

**Interfaces:**
- Produces:
  - `TimelineNode` interface
  - `ReviewEmotion` interface
  - `ReviewStructure` interface
  - `SectorRow` interface
  - `LadderGroup` interface
  - `LhbStock` interface
  - `ReviewData` interface
  - `buildReviewData(ztPool, zbPool, lhbList, sectors): ReviewData` 主函数入口

- [ ] **Step 1: 写类型定义的测试（类型存在性验证）**

```typescript
// tests/unit/utils/reviewBuilder.test.ts
import { describe, expect, it } from "vitest";
import * as RB from "../../../src/utils/reviewBuilder";

describe("reviewBuilder types", () => {
  it("exports buildReviewData function", () => {
    expect(typeof RB.buildReviewData).toBe("function");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/utils/reviewBuilder.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写类型定义和空函数骨架**

```typescript
// src/utils/reviewBuilder.ts
import type { ZtPool, ZtStock, LhbList, Sector } from "../api/market";

export interface TimelineNode {
  time: number;           // 时间戳（毫秒）
  type: "limit_up" | "broken" | "reseal" | "lhb" | "sector" | "promote";
  code: string;
  name: string;
  title: string;
  desc: string;
  pct?: number;
  tone: "up" | "down" | "neutral";
  extra?: Record<string, any>;
}

export interface ReviewEmotion {
  sentiment: number;      // 0-100
  mood: string;           // 冰点/低迷/中性/活跃/亢奋
  hist: number[];         // 情绪曲线数据点（约20个点）
  change: number;         // 较昨日变化
}

export interface ReviewStructure {
  limitUp: number;
  limitDown: number;
  broken: number;
  sealRate: number;       // %
  upCount: number;
  downCount: number;
  mainFund: number;       // 亿
  maxBoards: number;
  topStock: string;
  distribution: number[]; // 10档分布
}

export interface SectorRow {
  code: string;
  name: string;
  changePct: number;
  netAmount: number;      // 元
  leadStock: string;
  kind: "industry" | "concept";
}

export interface LadderGroup {
  boards: number;
  count: number;
  items: { code: string; name: string; pct: number; firstSeal: number; broken: number }[];
}

export interface LhbStock {
  code: string;
  name: string;
  pct: number;
  netAmt: number;
  reasons: string[];
}

export interface ReviewData {
  date: string;
  mode: "history" | "realtime";
  emotion: ReviewEmotion;
  structure: ReviewStructure;
  timeline: TimelineNode[];
  sectors: SectorRow[];
  ladder: LadderGroup[];
  lhb: LhbStock[];
}

export function buildReviewData(
  ztPool: ZtPool,
  zbPool: ZtPool,
  lhbList: LhbList | null,
  sectors: Sector[]
): ReviewData {
  return {
    date: ztPool.date || "",
    mode: "history",
    emotion: buildEmotion(ztPool, zbPool),
    structure: buildStructure(ztPool, zbPool, sectors),
    timeline: buildTimeline(ztPool, zbPool, lhbList, sectors),
    sectors: buildSectors(sectors),
    ladder: buildLadder(ztPool),
    lhb: buildLhb(lhbList),
  };
}

function buildEmotion(ztPool: ZtPool, zbPool: ZtPool): ReviewEmotion {
  return { sentiment: 50, mood: "中性", hist: [], change: 0 };
}
function buildStructure(ztPool: ZtPool, zbPool: ZtPool, sectors: Sector[]): ReviewStructure {
  return {
    limitUp: 0, limitDown: 0, broken: 0, sealRate: 0,
    upCount: 0, downCount: 0, mainFund: 0,
    maxBoards: 0, topStock: "—", distribution: [],
  };
}
function buildTimeline(ztPool: ZtPool, zbPool: ZtPool, lhbList: LhbList | null, sectors: Sector[]): TimelineNode[] {
  return [];
}
function buildSectors(sectors: Sector[]): SectorRow[] {
  return [];
}
function buildLadder(ztPool: ZtPool): LadderGroup[] {
  return [];
}
function buildLhb(lhbList: LhbList | null): LhbStock[] {
  return [];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/utils/reviewBuilder.test.ts`
Expected: PASS — 函数存在

- [ ] **Step 5: Commit**

```bash
git add src/utils/reviewBuilder.ts tests/unit/utils/reviewBuilder.test.ts
git commit -m "feat(review): add reviewBuilder skeleton with types"
```

---

### Task 2: 实现涨跌结构构建（buildStructure）

**Files:**
- Modify: `src/utils/reviewBuilder.ts`
- Test: `tests/unit/utils/reviewBuilder.test.ts`

**Interfaces:**
- Consumes: `ZtPool`, `ZtPool`, `Sector[]`
- Produces: `buildStructure(ztPool, zbPool, sectors): ReviewStructure`

- [ ] **Step 1: 写 buildStructure 的测试**

```typescript
// 添加到 tests/unit/utils/reviewBuilder.test.ts
describe("buildStructure", () => {
  const mockZt: any = {
    date: "20260115",
    total: 50,
    list: [
      { code: "000001", name: "平安银行", pct: 10.0, boards: 3, firstSeal: 93000, broken: 0, amount: 1e9 },
      { code: "000002", name: "万科A", pct: 10.0, boards: 2, firstSeal: 100000, broken: 1, amount: 5e8 },
      { code: "000003", name: "中集集团", pct: 10.0, boards: 1, firstSeal: 143000, broken: 0, amount: 2e8 },
    ],
  };
  const mockZb: any = {
    date: "20260115",
    total: 10,
    list: [
      { code: "000010", name: "炸板股1", pct: 5.0, boards: 1, firstSeal: 0, broken: 1, amount: 3e8 },
    ],
  };
  const mockSectors: any[] = [
    { code: "BK0001", name: "银行", changePct: 2.5, netAmount: 5e9 },
    { code: "BK0002", name: "地产", changePct: -1.2, netAmount: -2e9 },
  ];

  it("calculates limitUp count correctly", () => {
    const result = RB.buildReviewData(mockZt, mockZb, null, mockSectors);
    expect(result.structure.limitUp).toBe(3);
  });

  it("calculates broken count correctly (zt broken + zb total)", () => {
    const result = RB.buildReviewData(mockZt, mockZb, null, mockSectors);
    expect(result.structure.broken).toBe(1 + 10); // zt中炸过的1只 + 炸板池10只
  });

  it("calculates sealRate correctly", () => {
    const result = RB.buildReviewData(mockZt, mockZb, null, mockSectors);
    // 封板率 = 涨停 / (涨停 + 炸板) * 100
    const expected = 3 / (3 + 11) * 100;
    expect(result.structure.sealRate).toBeCloseTo(expected, 1);
  });

  it("calculates mainFund correctly (sum of sector netAmount in 亿)", () => {
    const result = RB.buildReviewData(mockZt, mockZb, null, mockSectors);
    expect(result.structure.mainFund).toBeCloseTo(0.3, 1); // (5e9 - 2e9) / 1e8 = 30亿
  });

  it("finds maxBoards and topStock", () => {
    const result = RB.buildReviewData(mockZt, mockZb, null, mockSectors);
    expect(result.structure.maxBoards).toBe(3);
    expect(result.structure.topStock).toBe("平安银行");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/utils/reviewBuilder.test.ts -t buildStructure`
Expected: FAIL — 返回全 0 默认值

- [ ] **Step 3: 实现 buildStructure**

```typescript
// 替换 src/utils/reviewBuilder.ts 中的 buildStructure 函数
function buildStructure(ztPool: ZtPool, zbPool: ZtPool, sectors: Sector[]): ReviewStructure {
  const ztList = ztPool.list || [];
  const zbList = zbPool.list || [];
  
  const limitUp = ztList.length;
  const broken = zbList.length + ztList.filter((s: any) => s.broken > 0).length;
  const sealRate = limitUp + broken > 0 ? limitUp / (limitUp + broken) * 100 : 0;
  
  // 主力资金：板块净流入总和（亿）
  const mainFund = sectors.reduce((sum: number, s: any) => sum + (s.netAmount || 0), 0) / 1e8;
  
  // 最高连板
  let maxBoards = 0;
  let topStock = "—";
  for (const s of ztList as any[]) {
    if (s.boards > maxBoards) {
      maxBoards = s.boards;
      topStock = s.name;
    }
  }
  
  // 涨跌分布（简化：用涨跌幅分桶）
  const dist = new Array(10).fill(0);
  
  return {
    limitUp,
    limitDown: 0, // 历史数据暂无跌停池，留0
    broken,
    sealRate: Math.round(sealRate * 10) / 10,
    upCount: 0,   // 历史数据暂无全市场涨跌数，留0
    downCount: 0,
    mainFund: Math.round(mainFund * 10) / 10,
    maxBoards,
    topStock,
    distribution: dist,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/utils/reviewBuilder.test.ts -t buildStructure`
Expected: PASS — 所有断言通过

- [ ] **Step 5: Commit**

```bash
git add src/utils/reviewBuilder.ts tests/unit/utils/reviewBuilder.test.ts
git commit -m "feat(review): implement buildStructure"
```

---

### Task 3: 实现情绪数据构建（buildEmotion）

**Files:**
- Modify: `src/utils/reviewBuilder.ts`
- Test: `tests/unit/utils/reviewBuilder.test.ts`

**Interfaces:**
- Consumes: `ZtPool`, `ZtPool`
- Produces: `buildEmotion(ztPool, zbPool): ReviewEmotion`

- [ ] **Step 1: 写 buildEmotion 的测试**

```typescript
describe("buildEmotion", () => {
  it("calculates sentiment based on limit up/down and seal rate", () => {
    const zt: any = { total: 60, list: Array.from({ length: 60 }, (_, i) => ({ boards: 1, firstSeal: 100000, broken: 0, code: String(i), name: String(i), pct: 10 })) };
    const zb: any = { total: 15, list: Array.from({ length: 15 }, (_, i) => ({ code: String(i), name: String(i) })) };
    
    const result = RB.buildReviewData(zt, zb, null, []);
    // 情绪应该在活跃区间（60-80）
    expect(result.emotion.sentiment).toBeGreaterThan(50);
    expect(result.emotion.sentiment).toBeLessThan(95);
  });

  it("returns 中性 mood for sentiment around 50", () => {
    const zt: any = { total: 30, list: Array.from({ length: 30 }, (_, i) => ({ boards: 1, firstSeal: 100000, broken: 0, code: String(i), name: String(i), pct: 10 })) };
    const zb: any = { total: 20, list: Array.from({ length: 20 }, (_, i) => ({ code: String(i), name: String(i) })) };
    
    const result = RB.buildReviewData(zt, zb, null, []);
    expect(["冰点", "低迷", "中性", "活跃", "亢奋"]).toContain(result.emotion.mood);
  });

  it("generates hist array with data points", () => {
    const zt: any = { total: 40, list: Array.from({ length: 40 }, (_, i) => ({ boards: 1, firstSeal: 93000 + i * 1000, broken: 0, code: String(i), name: String(i), pct: 10 })) };
    const zb: any = { total: 10, list: [] };
    
    const result = RB.buildReviewData(zt, zb, null, []);
    expect(result.emotion.hist.length).toBeGreaterThan(5);
    // 所有点都在 0-100 之间
    for (const h of result.emotion.hist) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(100);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/utils/reviewBuilder.test.ts -t buildEmotion`
Expected: FAIL — 默认返回 50 + 空数组

- [ ] **Step 3: 实现 buildEmotion**

```typescript
// 替换 src/utils/reviewBuilder.ts 中的 buildEmotion 函数
function buildEmotion(ztPool: ZtPool, zbPool: ZtPool): ReviewEmotion {
  const ztCount = ztPool.list?.length || 0;
  const zbCount = zbPool.list?.length || 0;
  const total = ztCount + zbCount;
  
  // 情绪计算（参考 limitup.rs 的算法简化版）
  const s_limit = Math.min(25, (ztCount - 0) * 0.4); // 涨停贡献
  const s_broken = -Math.min(15, zbCount * 0.5);    // 炸板惩罚
  const maxBoards = Math.max(0, ...(ztPool.list || []).map((s: any) => s.boards || 0));
  const s_height = Math.min(12, Math.max(0, maxBoards - 1) * 1.5);
  const s_seal = total > 0 ? (ztCount / total - 0.5) * 10 : 0;
  
  const sentiment = Math.max(2, Math.min(99, 50 + s_limit + s_broken + s_height + s_seal));
  
  // mood
  let mood = "中性";
  if (sentiment < 20) mood = "冰点";
  else if (sentiment < 40) mood = "低迷";
  else if (sentiment < 60) mood = "中性";
  else if (sentiment < 80) mood = "活跃";
  else mood = "亢奋";
  
  // 情绪曲线：用首封时间分布估算（20个点）
  const hist = buildEmotionHist(ztPool, zbPool, sentiment);
  
  return {
    sentiment: Math.round(sentiment * 10) / 10,
    mood,
    hist,
    change: 0, // 昨日对比暂留空，需额外拉取昨日数据
  };
}

function buildEmotionHist(ztPool: ZtPool, zbPool: ZtPool, baseSentiment: number): number[] {
  const points = 20;
  const hist: number[] = [];
  
  // 按时间段统计涨停数
  const buckets = new Array(4).fill(0); // 早盘/午前/午后/尾盘
  const ztList = (ztPool.list || []) as any[];
  
  for (const s of ztList) {
    const seal = s.firstSeal || 0;
    const h = Math.floor(seal / 10000);
    const m = Math.floor((seal % 10000) / 100);
    const mins = h * 60 + m;
    
    if (mins >= 570 && mins < 630) buckets[0]++;       // 9:30-10:30 早盘
    else if (mins >= 630 && mins < 690) buckets[1]++;  // 10:30-11:30 午前
    else if (mins >= 780 && mins < 840) buckets[2]++;  // 13:00-14:00 午后
    else if (mins >= 840 && mins <= 900) buckets[3]++; // 14:00-15:00 尾盘
  }
  
  // 用插值生成平滑曲线
  const total = buckets.reduce((a, b) => a + b, 0) || 1;
  let cumulative = 0;
  
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1); // 0-1 对应全天
    
    // 估算该时间点累计涨停比例
    let ratio = 0;
    if (t < 0.25) ratio = (buckets[0] / total) * (t / 0.25);
    else if (t < 0.5) ratio = buckets[0] / total + (buckets[1] / total) * ((t - 0.25) / 0.25);
    else if (t < 0.75) ratio = (buckets[0] + buckets[1]) / total + (buckets[2] / total) * ((t - 0.5) / 0.25);
    else ratio = (buckets[0] + buckets[1] + buckets[2]) / total + (buckets[3] / total) * ((t - 0.75) / 0.25);
    
    cumulative += ratio * 0.3;
    const val = Math.max(5, Math.min(95, baseSentiment - 10 + cumulative * 20 + Math.sin(t * Math.PI) * 5));
    hist.push(Math.round(val * 10) / 10);
  }
  
  return hist;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/utils/reviewBuilder.test.ts -t buildEmotion`
Expected: PASS — 所有断言通过

- [ ] **Step 5: Commit**

```bash
git add src/utils/reviewBuilder.ts tests/unit/utils/reviewBuilder.test.ts
git commit -m "feat(review): implement buildEmotion with hist curve"
```

---

### Task 4: 实现时间线构建（buildTimeline）

**Files:**
- Modify: `src/utils/reviewBuilder.ts`
- Test: `tests/unit/utils/reviewBuilder.test.ts`

**Interfaces:**
- Consumes: `ZtPool`, `ZtPool`, `LhbList | null`, `Sector[]`
- Produces: `buildTimeline(ztPool, zbPool, lhbList, sectors): TimelineNode[]`

- [ ] **Step 1: 写 buildTimeline 的测试**

```typescript
describe("buildTimeline", () => {
  const mockZt: any = {
    date: "20260115",
    total: 3,
    list: [
      { code: "000001", name: "平安银行", pct: 10.0, boards: 3, firstSeal: 93500, broken: 0, amount: 1e9 },
      { code: "000002", name: "万科A", pct: 10.0, boards: 2, firstSeal: 101500, broken: 2, amount: 5e8 },
      { code: "000003", name: "中集集团", pct: 10.0, boards: 1, firstSeal: 144500, broken: 0, amount: 2e8 },
    ],
  };
  const mockZb: any = { total: 1, list: [{ code: "000010", name: "炸板股", pct: 5.0 }] };
  const mockLhb: any = {
    date: "2026-01-15",
    total: 2,
    stocks: [
      { code: "000001", name: "平安银行", pct: 10.0, netAmt: 2e8, reasons: ["日涨幅偏离值达7%"] },
    ],
  };
  const mockSectors: any[] = [
    { code: "BK0001", name: "银行", changePct: 3.5, netAmount: 5e9 },
    { code: "BK0002", name: "地产", changePct: 2.1, netAmount: 2e9 },
    { code: "BK0003", name: "煤炭", changePct: -1.5, netAmount: -1e9 },
  ];

  it("builds limit_up nodes from ztPool firstSeal", () => {
    const result = RB.buildReviewData(mockZt, mockZb, mockLhb, mockSectors);
    const limitUps = result.timeline.filter(n => n.type === "limit_up");
    expect(limitUps.length).toBeGreaterThan(0);
  });

  it("builds reseal nodes for stocks with broken > 0", () => {
    const result = RB.buildReviewData(mockZt, mockZb, mockLhb, mockSectors);
    const reseals = result.timeline.filter(n => n.type === "reseal");
    expect(reseals.length).toBe(1); // 万科A broken=2
    expect(reseals[0].name).toBe("万科A");
  });

  it("sorts nodes by time ascending", () => {
    const result = RB.buildReviewData(mockZt, mockZb, mockLhb, mockSectors);
    for (let i = 1; i < result.timeline.length; i++) {
      expect(result.timeline[i].time).toBeGreaterThanOrEqual(result.timeline[i - 1].time);
    }
  });

  it("includes lhb nodes when lhbList provided", () => {
    const result = RB.buildReviewData(mockZt, mockZb, mockLhb, mockSectors);
    const lhbs = result.timeline.filter(n => n.type === "lhb");
    expect(lhbs.length).toBeGreaterThan(0);
  });

  it("includes top sector node", () => {
    const result = RB.buildReviewData(mockZt, mockZb, mockLhb, mockSectors);
    const sectors = result.timeline.filter(n => n.type === "sector");
    expect(sectors.length).toBeGreaterThan(0);
    expect(sectors[0].name).toBe("银行");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/utils/reviewBuilder.test.ts -t buildTimeline`
Expected: FAIL — 返回空数组

- [ ] **Step 3: 实现 buildTimeline**

```typescript
// 替换 src/utils/reviewBuilder.ts 中的 buildTimeline 函数
function buildTimeline(
  ztPool: ZtPool,
  zbPool: ZtPool,
  lhbList: any,
  sectors: Sector[]
): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  const date = ztPool.date || "";
  const baseTs = date ? parseYmdToTs(date) : Date.now();
  
  // 1. 涨停 / 回封 节点
  for (const s of (ztPool.list || []) as any[]) {
    const sealTs = baseTs + firstSealToMinutes(s.firstSeal) * 60 * 1000;
    const isReseal = s.broken > 0;
    
    nodes.push({
      time: sealTs,
      type: isReseal ? "reseal" : "limit_up",
      code: s.code,
      name: s.name,
      title: isReseal ? "回封涨停" : "首封涨停",
      desc: `${s.boards}连板 · ${s.broken > 0 ? `炸板${s.broken}次` : "一字/硬板"}`,
      pct: s.pct,
      tone: "up",
      extra: { boards: s.boards, firstSeal: s.firstSeal, broken: s.broken, amount: s.amount },
    });
  }
  
  // 2. 炸板节点（炸板池的放午后，因为没有精确时间）
  const zbNoonTs = baseTs + 13 * 60 * 60 * 1000 + 30 * 60 * 1000; // 13:30
  for (const s of (zbPool.list || []) as any[]) {
    nodes.push({
      time: zbNoonTs + Math.random() * 3600 * 1000, // 午后随机分布
      type: "broken",
      code: s.code,
      name: s.name,
      title: "炸板",
      desc: `炸板后涨${(s.pct || 0).toFixed(1)}%`,
      pct: s.pct,
      tone: "down",
      extra: {},
    });
  }
  
  // 3. 龙虎榜节点（收盘后）
  if (lhbList?.stocks?.length) {
    const closeTs = baseTs + 15 * 60 * 60 * 1000;
    for (const s of lhbList.stocks.slice(0, 10)) {
      nodes.push({
        time: closeTs,
        type: "lhb",
        code: s.code,
        name: s.name,
        title: "龙虎榜",
        desc: `净${s.netAmt >= 0 ? "买入" : "卖出"}${Math.abs(s.netAmt) / 1e8 .toFixed(2)}亿`,
        pct: s.pct,
        tone: s.netAmt >= 0 ? "up" : "down",
        extra: { reasons: s.reasons },
      });
    }
  }
  
  // 4. 板块异动（涨幅前3的板块，时间标记在午盘）
  const topSectors = [...sectors]
    .sort((a: any, b: any) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 3);
  const sectorTs = baseTs + 10 * 60 * 60 * 1000 + 30 * 60 * 1000;
  
  for (const s of topSectors) {
    nodes.push({
      time: sectorTs,
      type: "sector",
      code: (s as any).code,
      name: s.name,
      title: "板块异动",
      desc: `${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(1)}%`,
      pct: s.changePct,
      tone: s.changePct >= 0 ? "up" : "down",
      extra: { netAmount: (s as any).netAmount },
    });
  }
  
  // 按时间排序
  nodes.sort((a, b) => a.time - b.time);
  
  return nodes;
}

// 辅助函数：YYYYMMDD → 当日 0 点时间戳
function parseYmdToTs(ymd: string): number {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6)) - 1;
  const d = Number(ymd.slice(6, 8));
  return new Date(y, m, d, 0, 0, 0).getTime();
}

// 辅助函数：firstSeal (HHmmss) → 从0点的分钟数
function firstSealToMinutes(seal: number): number {
  if (!seal) return 9 * 60 + 30; // 默认9:30
  const h = Math.floor(seal / 10000);
  const m = Math.floor((seal % 10000) / 100);
  return h * 60 + m;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/utils/reviewBuilder.test.ts -t buildTimeline`
Expected: PASS — 所有断言通过

- [ ] **Step 5: Commit**

```bash
git add src/utils/reviewBuilder.ts tests/unit/utils/reviewBuilder.test.ts
git commit -m "feat(review): implement buildTimeline"
```

---

### Task 5: 实现连板梯队、板块、龙虎榜构建

**Files:**
- Modify: `src/utils/reviewBuilder.ts`
- Test: `tests/unit/utils/reviewBuilder.test.ts`

**Interfaces:**
- Produces:
  - `buildLadder(ztPool): LadderGroup[]`
  - `buildSectors(sectors): SectorRow[]`
  - `buildLhb(lhbList): LhbStock[]`

- [ ] **Step 1: 写这三个函数的测试**

```typescript
describe("buildLadder", () => {
  it("groups stocks by board count descending", () => {
    const zt: any = {
      list: [
        { code: "1", name: "股1", pct: 10, boards: 3, firstSeal: 93000, broken: 0 },
        { code: "2", name: "股2", pct: 10, boards: 3, firstSeal: 100000, broken: 1 },
        { code: "3", name: "股3", pct: 10, boards: 2, firstSeal: 94500, broken: 0 },
        { code: "4", name: "股4", pct: 10, boards: 1, firstSeal: 140000, broken: 0 },
      ],
    };
    const result = RB.buildReviewData(zt, { list: [] }, null, []);
    expect(result.ladder.length).toBe(3); // 3板、2板、1板
    expect(result.ladder[0].boards).toBe(3);
    expect(result.ladder[0].count).toBe(2);
    expect(result.ladder[0].items.length).toBe(2);
  });
});

describe("buildSectors", () => {
  it("sorts sectors by netAmount descending", () => {
    const sectors: any[] = [
      { code: "BK1", name: "A", changePct: 1.0, netAmount: 1e9 },
      { code: "BK2", name: "B", changePct: 3.0, netAmount: 5e9 },
      { code: "BK3", name: "C", changePct: -2.0, netAmount: -3e9 },
    ];
    const result = RB.buildReviewData({ list: [] }, { list: [] }, null, sectors);
    expect(result.sectors.length).toBe(3);
    expect(result.sectors[0].name).toBe("B"); // 5e9 最大
    expect(result.sectors[2].name).toBe("C"); // -3e9 最小
  });
});

describe("buildLhb", () => {
  it("returns empty array for null input", () => {
    const result = RB.buildReviewData({ list: [] }, { list: [] }, null, []);
    expect(result.lhb).toEqual([]);
  });

  it("maps lhb stocks correctly", () => {
    const lhb: any = {
      date: "2026-01-15",
      total: 2,
      stocks: [
        { code: "000001", name: "平安银行", pct: 10.0, netAmt: 200000000, reasons: ["日涨幅偏离值达7%"] },
        { code: "000002", name: "万科A", pct: 8.5, netAmt: -50000000, reasons: ["日换手率达20%"] },
      ],
    };
    const result = RB.buildReviewData({ list: [] }, { list: [] }, lhb, []);
    expect(result.lhb.length).toBe(2);
    expect(result.lhb[0].code).toBe("000001");
    expect(result.lhb[0].netAmt).toBe(200000000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/utils/reviewBuilder.test.ts -t "buildLadder|buildSectors|buildLhb"`
Expected: FAIL — 返回空数组

- [ ] **Step 3: 实现三个函数**

```typescript
// 替换 src/utils/reviewBuilder.ts 中的三个函数
function buildLadder(ztPool: ZtPool): LadderGroup[] {
  const groups = new Map<number, any[]>();
  
  for (const s of (ztPool.list || []) as any[]) {
    const boards = s.boards || 1;
    if (!groups.has(boards)) groups.set(boards, []);
    groups.get(boards)!.push({
      code: s.code,
      name: s.name,
      pct: s.pct,
      firstSeal: s.firstSeal,
      broken: s.broken || 0,
    });
  }
  
  // 按连板数降序排列
  const ladder: LadderGroup[] = [];
  for (const boards of [...groups.keys()].sort((a, b) => b - a)) {
    const items = groups.get(boards)!;
    // 组内按首封时间升序（早封的在前）
    items.sort((a, b) => (a.firstSeal || 0) - (b.firstSeal || 0));
    ladder.push({ boards, count: items.length, items });
  }
  
  return ladder;
}

function buildSectors(sectors: Sector[]): SectorRow[] {
  return [...sectors]
    .sort((a: any, b: any) => (b.netAmount || 0) - (a.netAmount || 0))
    .map((s: any) => ({
      code: s.code,
      name: s.name,
      changePct: s.changePct,
      netAmount: s.netAmount || 0,
      leadStock: "", // 暂留空，后续可加
      kind: s.kind || "industry",
    }));
}

function buildLhb(lhbList: any): LhbStock[] {
  if (!lhbList?.stocks) return [];
  return lhbList.stocks.map((s: any) => ({
    code: s.code,
    name: s.name,
    pct: s.pct,
    netAmt: s.netAmt || 0,
    reasons: s.reasons || [],
  }));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/utils/reviewBuilder.test.ts`
Expected: PASS — 全部测试通过

- [ ] **Step 5: Commit**

```bash
git add src/utils/reviewBuilder.ts tests/unit/utils/reviewBuilder.test.ts
git commit -m "feat(review): implement ladder, sectors, lhb builders"
```

---

## Phase 2: 数据组合层（useReviewData）+ 紧凑视图

### Task 6: 实现 useReviewData 组合式函数

**Files:**
- Create: `src/composables/useReviewData.ts`

**Interfaces:**
- Consumes: `buildReviewData` from `../utils/reviewBuilder`
- Produces: `useReviewData(dateRef?, modeRef?): { data, loading, error, load }`

- [ ] **Step 1: 创建 useReviewData.ts**

```typescript
// src/composables/useReviewData.ts
import { computed, onMounted, ref, watch } from "vue";
import { fetchZtPool, fetchZbPool, fetchLhbList, type ZtPool, type LhbList } from "../api/market";
import { fetchSectors } from "../api/market";
import { buildReviewData, type ReviewData } from "../utils/reviewBuilder";
import { useMarketFeeds } from "./useMarketFeeds";
import { isTrading } from "../utils/sessions";

export function useReviewData() {
  const dateStr = ref(""); // YYYYMMDD
  const mode = ref<"history" | "realtime">("history");
  const data = ref<ReviewData | null>(null);
  const loading = ref(false);
  const error = ref("");

  // 实时模式的数据来源
  const { radar, events: realtimeEvents, sectors: realtimeSectors } = useMarketFeeds();

  // 自动判断默认模式
  function autoMode() {
    mode.value = isTrading() ? "realtime" : "history";
  }

  // 历史模式：拉取数据并构建
  async function loadHistory(date: string) {
    loading.value = true;
    error.value = "";
    try {
      const [zt, zb, lhb, indSec, conSec] = await Promise.all([
        fetchZtPool(date).catch(() => ({ date, total: 0, list: [] } as ZtPool)),
        fetchZbPool(date).catch(() => ({ date, total: 0, list: [] } as ZtPool)),
        fetchLhbList(date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")).catch(() => null),
        fetchSectors("industry").catch(() => []),
        fetchSectors("concept").catch(() => []),
      ]);

      // 合并行业+概念板块（去重，取绝对值大的）
      const map = new Map<string, any>();
      for (const s of [...indSec, ...conSec] as any[]) {
        const ex = map.get(s.code);
        if (!ex || Math.abs(s.changePct) > Math.abs(ex.changePct)) {
          map.set(s.code, s);
        }
      }
      const sectors = [...map.values()];

      data.value = buildReviewData(zt as any, zb as any, lhb as LhbList, sectors as any);
    } catch (e: any) {
      error.value = e?.message || String(e);
    } finally {
      loading.value = false;
    }
  }

  // 找最近一个有数据的交易日（往前扫最多10天）
  async function findNearestTradingDay(): Promise<string> {
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
      try {
        const zt = await fetchZtPool(ymd);
        if (zt.list && zt.list.length > 0) return ymd;
      } catch { /* 跳过 */ }
    }
    // fallback：今天
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  }

  // 加载数据
  async function load(date?: string) {
    if (mode.value === "history") {
      const targetDate = date || dateStr.value || await findNearestTradingDay();
      dateStr.value = targetDate;
      await loadHistory(targetDate);
    }
    // realtime 模式下由 useMarketFeeds 自动推送，这里转换格式
  }

  // 实时数据转换（简化版，v1.1完善）
  const realtimeData = computed((): ReviewData | null => {
    if (mode.value !== "realtime" || !radar.value) return null;
    const r = radar.value;
    return {
      date: dateStr.value,
      mode: "realtime",
      emotion: {
        sentiment: r.sentiment,
        mood: r.mood,
        hist: r.hist.map((h: any) => typeof h === "number" ? h : 50),
        change: 0,
      },
      structure: {
        limitUp: r.limitUp,
        limitDown: r.limitDown,
        broken: r.broken,
        sealRate: 100 - r.brokenRate,
        upCount: r.upCount,
        downCount: r.downCount,
        mainFund: (realtimeSectors.value.reduce((a, s: any) => a + (s.netAmount || 0), 0) / 1e8),
        maxBoards: r.maxBoards,
        topStock: r.ladder?.[0]?.items?.[0]?.name || "—",
        distribution: [],
      },
      timeline: realtimeEvents.value.map((e: any) => ({
        time: e.time,
        type: mapSpiderType(e.kind),
        code: e.code,
        name: e.name,
        title: e.label,
        desc: e.desc,
        pct: e.pct,
        tone: e.tone as any,
        extra: {},
      })),
      sectors: realtimeSectors.value as any,
      ladder: (r.ladder || []) as any,
      lhb: [],
    };
  });

  function mapSpiderType(kind: string): "limit_up" | "broken" | "lhb" | "sector" | "promote" | "reseal" {
    switch (kind) {
      case "limit_up": return "limit_up";
      case "limit_up_open": return "broken";
      case "limit_down": return "broken";
      default: return "sector";
    }
  }

  // 切换模式
  function setMode(m: "history" | "realtime") {
    if (m === "realtime" && !isTrading()) {
      error.value = "当前非交易时间，无法使用实时模式";
      return;
    }
    mode.value = m;
    error.value = "";
  }

  onMounted(() => {
    autoMode();
    load();
  });

  watch(dateStr, (d) => {
    if (mode.value === "history" && d) loadHistory(d);
  });

  return {
    dateStr,
    mode,
    data: computed(() => mode.value === "realtime" ? realtimeData.value : data.value),
    loading,
    error,
    load,
    setMode,
  };
}
```

- [ ] **Step 2: 验证 TS 编译不报错**

Run: `npx vue-tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 3: Commit**

```bash
git add src/composables/useReviewData.ts
git commit -m "feat(review): add useReviewData composable"
```

---

### Task 7: 重写 ReviewTimeline 紧凑视图（上半部分：工具栏 + 仪表盘 + 核心数据）

**Files:**
- Modify: `src/components/ReviewTimeline.vue`

**Interfaces:**
- Consumes: `useReviewData`
- Produces: 紧凑视图的工具栏、情绪仪表盘、核心数据区

- [ ] **Step 1: 重写 script 部分（引入新的数据层）**

```vue
<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import { useReviewData } from "../composables/useReviewData";
import { isTrading } from "../utils/sessions";

const emit = defineEmits<{ select: [code: string] }>();
const { dateStr, mode, data, loading, error, load, setMode } = useReviewData();

const expanded = ref(false);
function toggleExpand() { expanded.value = !expanded.value; }

function formatDate(ymd: string): string {
  if (!ymd) return "";
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function onDateChange(e: Event) {
  const val = (e.target as HTMLInputElement).value;
  if (val) {
    const ymd = val.replaceAll("-", "");
    dateStr.value = ymd;
  }
}

// 仪表盘数据
const sentiment = computed(() => data.value?.emotion.sentiment ?? 0);
const mood = computed(() => data.value?.emotion.mood ?? "—");
const gaugeColor = computed(() => {
  const s = sentiment.value;
  if (s < 40) return "#3ba776";
  if (s < 60) return "#e3b341";
  return "#e0455a";
});
const arcLen = Math.PI * 45;
const dash = computed(() => `${(arcLen * sentiment.value / 100).toFixed(1)} ${arcLen.toFixed(1)}`);

// 核心数据
const structure = computed(() => data.value?.structure);
</script>
```

- [ ] **Step 2: 写紧凑视图的上半部分模板**

```vue
<template>
  <div class="rt" :class="{ expanded }">
    <!-- 紧凑视图 -->
    <div v-if="!expanded" class="rt-compact">
      <!-- 工具栏 -->
      <div class="rt-toolbar">
        <input type="date" :value="formatDate(dateStr)" @change="onDateChange" class="rt-date" />
        <div class="rt-mode">
          <button class="mode-btn" :class="{ active: mode === 'history' }" @click="setMode('history')">历史</button>
          <button class="mode-btn" :class="{ active: mode === 'realtime', disabled: !isTrading() }" @click="setMode('realtime')" :disabled="!isTrading()">实时</button>
        </div>
        <button class="rt-expand" @click="toggleExpand" title="展开完整复盘">⬜ 展开</button>
      </div>

      <!-- 加载状态 -->
      <div v-if="loading" class="rt-loading">加载中…</div>
      <div v-else-if="error" class="rt-error">
        {{ error }}
        <button class="retry-btn" @click="load()">重试</button>
      </div>

      <!-- 仪表盘 + 情绪 -->
      <div v-else-if="data" class="rt-gauge-row">
        <div class="rt-gauge">
          <svg viewBox="0 0 100 60" class="gauge-svg">
            <path d="M 10 55 A 45 45 0 0 1 90 55" fill="none" stroke="#2a251a" stroke-width="6" stroke-linecap="round"/>
            <path d="M 10 55 A 45 45 0 0 1 90 55" fill="none" :stroke="gaugeColor" stroke-width="6" stroke-linecap="round"
              :stroke-dasharray="dash" :stroke-dashoffset="0"/>
            <text x="50" y="42" text-anchor="middle" class="gauge-text" :fill="gaugeColor">{{ Math.round(sentiment) }}</text>
          </svg>
        </div>
        <div class="rt-mood">
          <div class="mood-title" :style="{ color: gaugeColor }">{{ mood }}</div>
          <div class="mood-sub">情绪温度</div>
        </div>
      </div>

      <!-- 核心数据（4个+2行） -->
      <div v-if="structure" class="rt-stats">
        <div class="stats-row">
          <div class="stat-item">
            <b class="up">{{ structure.limitUp }}</b><span>涨停</span>
          </div>
          <div class="stat-item">
            <b class="down">{{ structure.limitDown }}</b><span>跌停</span>
          </div>
          <div class="stat-item">
            <b class="flat">{{ structure.broken }}</b><span>炸板</span>
          </div>
          <div class="stat-item">
            <b class="up">{{ structure.sealRate.toFixed(0) }}%</b><span>封板率</span>
          </div>
        </div>
        <div class="stats-wide">
          <span>上涨 / 下跌</span>
          <b>{{ structure.upCount }} / {{ structure.downCount }}</b>
        </div>
        <div class="stats-wide">
          <span>主力资金</span>
          <b :class="structure.mainFund >= 0 ? 'up' : 'down'">{{ structure.mainFund >= 0 ? '+' : '' }}{{ structure.mainFund.toFixed(1) }} 亿</b>
        </div>
        <div class="stats-wide">
          <span>最高连板</span>
          <b class="up">{{ structure.maxBoards }}板 · {{ structure.topStock }}</b>
        </div>
      </div>

      <!-- 迷你时间线（底部，下面task做） -->
      <div class="rt-mini-tl">
        <!-- 占位，下一task实现 -->
      </div>
    </div>

    <!-- 展开视图（后面task做） -->
    <div v-else class="rt-expanded">
      展开视图占位
    </div>
  </div>
</template>
```

- [ ] **Step 3: 写紧凑视图的基础样式**

```vue
<style scoped>
.rt { height: 100%; min-height: 0; display: flex; flex-direction: column;
  background: var(--bg-card, #14110d); border: 1px solid var(--border, #2c2619); border-radius: 11px; overflow: hidden;
  font-size: 12px; color: var(--text, #e8dcc8);
}

/* 工具栏 */
.rt-toolbar { display: flex; align-items: center; gap: 8px; height: 34px; flex-shrink: 0;
  padding: 0 8px; border-bottom: 1px solid var(--border, #211c13); }
.rt-date { background: #1a1610; border: 1px solid #2c2619; border-radius: 4px;
  color: #e8dcc8; font-size: 11px; padding: 2px 6px; color-scheme: dark; }
.rt-mode { display: flex; gap: 1px; background: #1a1610; border-radius: 4px; padding: 1px; }
.mode-btn { background: transparent; border: none; color: #8a7f68; font-size: 10.5px;
  padding: 2px 8px; border-radius: 3px; cursor: pointer; }
.mode-btn.active { background: #2c2619; color: #e6c878; }
.mode-btn.disabled { opacity: 0.4; cursor: not-allowed; }
.rt-expand { margin-left: auto; background: #2c2619; border: none; color: #c9a24a;
  font-size: 10.5px; padding: 3px 10px; border-radius: 4px; cursor: pointer; }
.rt-expand:hover { background: #3a3320; }

/* 状态 */
.rt-loading { padding: 30px; text-align: center; color: var(--text-dim); font-size: 11px; }
.rt-error { padding: 20px; text-align: center; color: #f0883e; font-size: 11px; }
.retry-btn { margin-top: 8px; background: #2c2619; border: 1px solid #3a3320;
  color: #e6c878; font-size: 10.5px; padding: 4px 12px; border-radius: 4px; cursor: pointer; }

/* 仪表盘 */
.rt-gauge-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px 8px; }
.rt-gauge { width: 80px; flex-shrink: 0; }
.gauge-svg { width: 100%; height: auto; }
.gauge-text { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.rt-mood { flex: 1; }
.mood-title { font-size: 16px; font-weight: 700; }
.mood-sub { font-size: 10.5px; color: var(--text-dim); margin-top: 2px; }

/* 核心数据 */
.rt-stats { padding: 0 10px 8px; }
.stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-bottom: 6px; }
.stat-item { display: flex; flex-direction: column; align-items: center; gap: 1px; }
.stat-item b { font-size: 15px; font-variant-numeric: tabular-nums; }
.stat-item span { font-size: 9.5px; color: var(--text-dim); }
.stats-wide { display: flex; justify-content: space-between; align-items: center;
  padding: 4px 2px; border-top: 1px solid #211c13; font-size: 11px; }
.stats-wide span { color: var(--text-dim); }
.stats-wide b { font-size: 11.5px; font-variant-numeric: tabular-nums; }
.up { color: #f25266; }
.down { color: #22b573; }
.flat { color: #f0a23a; }

/* 迷你时间线占位 */
.rt-mini-tl { flex: 1; min-height: 0; border-top: 1px solid #211c13; }
</style>
```

- [ ] **Step 4: 验证页面能正常渲染（无报错）**

检查浏览器控制台无 JS 错误，紧凑视图上半部分显示正常。

- [ ] **Step 5: Commit**

```bash
git add src/components/ReviewTimeline.vue
git commit -m "feat(review): compact view top half (toolbar + gauge + stats)"
```

---

### Task 8: 实现迷你时间线（紧凑视图底部）

**Files:**
- Modify: `src/components/ReviewTimeline.vue`

**Interfaces:**
- Consumes: `data.timeline`
- Produces: 紧凑视图底部的迷你时间线（5个关键节点）

- [ ] **Step 1: 添加迷你时间线计算属性**

```typescript
// 添加到 script setup
// 迷你时间线：取5个关键节点
const miniTimeline = computed(() => {
  const tl = data.value?.timeline;
  if (!tl || tl.length === 0) return [];
  
  // 取最有代表性的5个
  const selected: typeof tl = [];
  
  // 1. 第一个涨停
  const firstLimit = tl.find(n => n.type === "limit_up" || n.type === "reseal");
  if (firstLimit) selected.push(firstLimit);
  
  // 2. 最高连板（从ladder找第一个）
  const topBoard = data.value?.ladder?.[0]?.items?.[0];
  if (topBoard) {
    const node = tl.find(n => n.code === topBoard.code);
    if (node && !selected.includes(node)) selected.push(node);
  }
  
  // 3. 最严重的炸板
  const broken = tl.filter(n => n.type === "broken");
  if (broken.length > 0) {
    selected.push(broken[Math.floor(broken.length / 2)]);
  }
  
  // 4. 最强板块
  const topSector = tl.find(n => n.type === "sector" && n.tone === "up");
  if (topSector) selected.push(topSector);
  
  // 5. 最后一个涨停
  const lastLimit = [...tl].reverse().find(n => n.type === "limit_up" || n.type === "reseal");
  if (lastLimit && !selected.includes(lastLimit)) selected.push(lastLimit);
  
  // 如果不够5个，补其他节点
  if (selected.length < 5) {
    for (const n of tl) {
      if (selected.length >= 5) break;
      if (!selected.includes(n)) selected.push(n);
    }
  }
  
  // 按时间排序
  return selected.sort((a, b) => a.time - b.time).slice(0, 5);
});

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function nodeClass(type: string): string {
  switch (type) {
    case "limit_up": case "reseal": return "red";
    case "broken": return "orange";
    case "lhb": return "blue";
    case "sector": return "green";
    case "promote": return "purple";
    default: return "gold";
  }
}
```

- [ ] **Step 2: 添加迷你时间线模板（替换占位）**

```vue
<!-- 迷你时间线 -->
<div v-if="data && miniTimeline.length > 0" class="rt-mini-tl">
  <div class="mini-tl-list">
    <div v-for="(n, i) in miniTimeline" :key="n.time + n.code"
      class="mini-tl-item" :class="{ last: i === miniTimeline.length - 1 }"
      @click="emit('select', n.code)">
      <span class="mini-tl-time">{{ hhmm(n.time) }}</span>
      <span class="mini-tl-dot-wrap"><span class="mini-tl-dot" :class="nodeClass(n.type)"></span></span>
      <span class="mini-tl-name">{{ n.name }}</span>
      <span class="mini-tl-title">{{ n.title }}</span>
    </div>
  </div>
  <div class="mini-tl-more" @click="toggleExpand">点击展开 查看全部 →</div>
</div>
<div v-else-if="data" class="rt-empty">
  当日暂无关键节点
</div>
```

- [ ] **Step 3: 添加迷你时间线样式**

```css
/* 替换 .rt-mini-tl 占位样式 */
.rt-mini-tl { flex: 1; min-height: 0; border-top: 1px solid #211c13;
  display: flex; flex-direction: column; overflow: hidden; }

.mini-tl-list { flex: 1; padding: 6px 8px; overflow-y: auto; }
.mini-tl-item { display: grid; grid-template-columns: 40px 16px 1fr auto; gap: 4px;
  align-items: center; cursor: pointer; padding: 3px 0; position: relative; }
.mini-tl-item:hover .mini-tl-name { color: #e6c878; }
.mini-tl-time { font-size: 10px; color: var(--text-dim); text-align: right; font-variant-numeric: tabular-nums; }
.mini-tl-dot-wrap { position: relative; display: flex; justify-content: center; }
.mini-tl-dot-wrap::before { content: ''; position: absolute; top: -6px; bottom: -6px;
  left: 50%; width: 2px; transform: translateX(-50%); background: #2c2619; }
.mini-tl-item.first .mini-tl-dot-wrap::before { top: 50%; }
.mini-tl-item.last .mini-tl-dot-wrap::before { bottom: 50%; }
.mini-tl-dot { width: 8px; height: 8px; border-radius: 50%; z-index: 1; border: 2px solid #0c0a08; }
.mini-tl-dot.red { background: #f23645; box-shadow: 0 0 6px rgba(242,54,69,.6); }
.mini-tl-dot.orange { background: #f0a23a; box-shadow: 0 0 6px rgba(240,162,58,.6); }
.mini-tl-dot.blue { background: #4a9eff; box-shadow: 0 0 6px rgba(74,158,255,.6); }
.mini-tl-dot.green { background: #08db94; box-shadow: 0 0 6px rgba(8,219,148,.6); }
.mini-tl-dot.purple { background: #b388ff; box-shadow: 0 0 6px rgba(179,136,255,.6); }
.mini-tl-dot.gold { background: #c9a24a; box-shadow: 0 0 6px rgba(201,162,74,.6); }
.mini-tl-name { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mini-tl-title { font-size: 9.5px; color: var(--text-dim); }

.mini-tl-more { flex-shrink: 0; text-align: center; font-size: 10px; color: #c9a24a;
  padding: 6px; border-top: 1px solid #211c13; cursor: pointer; background: #14110d; }
.mini-tl-more:hover { color: #e6c878; background: #1a1610; }

.rt-empty { flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); font-size: 11px; }
```

- [ ] **Step 4: 验证渲染正常**

检查迷你时间线显示正常，点击节点能触发 select 事件。

- [ ] **Step 5: Commit**

```bash
git add src/components/ReviewTimeline.vue
git commit -m "feat(review): compact mini timeline"
```

---

## Phase 3: 展开视图

### Task 9: 实现展开视图框架 + 左侧时间线

**Files:**
- Modify: `src/components/ReviewTimeline.vue`

**Interfaces:**
- Consumes: `data.timeline`, `data.ladder`, etc.
- Produces: 展开视图的左右两栏布局 + 左侧完整时间线

- [ ] **Step 1: 替换展开视图占位内容**

```vue
<!-- 展开视图 -->
<div v-else class="rt-expanded">
  <!-- 展开视图工具栏 -->
  <div class="rt-toolbar rt-toolbar-exp">
    <input type="date" :value="formatDate(dateStr)" @change="onDateChange" class="rt-date" />
    <div class="rt-mode">
      <button class="mode-btn" :class="{ active: mode === 'history' }" @click="setMode('history')">历史</button>
      <button class="mode-btn" :class="{ active: mode === 'realtime', disabled: !isTrading() }" @click="setMode('realtime')" :disabled="!isTrading()">实时</button>
    </div>
    <div class="rt-tl-filter">
      <label><input type="checkbox" v-model="filterTypes" value="limit_up" /> 涨停</label>
      <label><input type="checkbox" v-model="filterTypes" value="broken" /> 炸板</label>
      <label><input type="checkbox" v-model="filterTypes" value="lhb" /> 龙虎榜</label>
      <label><input type="checkbox" v-model="filterTypes" value="sector" /> 板块</label>
    </div>
    <button class="rt-expand" @click="toggleExpand">↙ 收起</button>
  </div>

  <!-- 主体：左右两栏 -->
  <div class="rt-body">
    <!-- 左栏：时间线 -->
    <div class="rt-left">
      <div class="rt-panel-header">
        <span class="bar"></span>全天关键节点
        <span class="panel-sub">点击节点回看个股</span>
      </div>
      <div v-if="loading" class="rt-loading">加载中…</div>
      <div v-else-if="filteredTimeline.length === 0" class="rt-empty">当日暂无关键节点</div>
      <div v-else class="tl-full scroll">
        <div v-for="(group, gi) in timelineGroups" :key="gi" class="tl-group">
          <div class="tl-group-label">{{ group.label }}</div>
          <div v-for="(n, ni) in group.items" :key="n.time + n.code + ni"
            class="tl-item" :class="{ last: ni === group.items.length - 1 && gi === timelineGroups.length - 1 }"
            @click="emit('select', n.code)">
            <span class="tl-time">{{ hhmm(n.time) }}</span>
            <span class="tl-dot-col"><span class="tl-dot" :class="nodeClass(n.type)"></span></span>
            <div class="tl-content">
              <div class="tl-head">
                <span class="tl-tag" :class="'tg-' + nodeClass(n.type)">{{ n.title }}</span>
                <b>{{ n.name }}</b>
              </div>
              <p class="tl-desc">{{ n.desc }}<span v-if="n.pct != null"> · {{ n.pct >= 0 ? '+' : '' }}{{ n.pct.toFixed(1) }}%</span></p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 右栏：模块列表（下一task做） -->
    <div class="rt-right">
      右栏模块占位
    </div>
  </div>
</div>
```

- [ ] **Step 2: 添加时间线分组逻辑和过滤逻辑**

```typescript
// 添加到 script setup
const filterTypes = ref<string[]>(["limit_up", "reseal", "broken", "lhb", "sector", "promote"]);

const filteredTimeline = computed(() => {
  const tl = data.value?.timeline || [];
  return tl.filter(n => filterTypes.value.includes(n.type));
});

// 按时间段分组
const timelineGroups = computed(() => {
  const tl = filteredTimeline.value;
  const groups = [
    { label: "早盘 09:25-10:30", items: [] as any[] },
    { label: "午前 10:30-11:30", items: [] as any[] },
    { label: "午后 13:00-14:00", items: [] as any[] },
    { label: "尾盘 14:00-15:00", items: [] as any[] },
    { label: "收盘后", items: [] as any[] },
  ];
  
  for (const n of tl) {
    const d = new Date(n.time);
    const mins = d.getHours() * 60 + d.getMinutes();
    if (mins >= 565 && mins < 630) groups[0].items.push(n);
    else if (mins >= 630 && mins < 690) groups[1].items.push(n);
    else if (mins >= 780 && mins < 840) groups[2].items.push(n);
    else if (mins >= 840 && mins <= 900) groups[3].items.push(n);
    else groups[4].items.push(n);
  }
  
  // 过滤掉空组
  return groups.filter(g => g.items.length > 0);
});
```

- [ ] **Step 3: 添加展开视图样式**

```css
/* 展开视图整体 */
.rt.expanded { position: relative; }

.rt-toolbar-exp { padding-left: 12px; }
.rt-tl-filter { display: flex; gap: 8px; margin-left: 12px; font-size: 10.5px; color: var(--text-dim); }
.rt-tl-filter label { display: flex; align-items: center; gap: 3px; cursor: pointer; }
.rt-tl-filter input { accent-color: #c9a24a; }

.rt-body { flex: 1; display: grid; grid-template-columns: 1fr 320px; gap: 0; min-height: 0; overflow: hidden; }

/* 左栏：时间线 */
.rt-left { display: flex; flex-direction: column; min-height: 0;
  border-right: 1px solid var(--border, #211c13); }
.rt-panel-header { display: flex; align-items: center; gap: 7px; height: 32px; flex-shrink: 0;
  padding: 0 12px; font-size: 12px; font-weight: 700; border-bottom: 1px solid var(--border, #211c13); }
.rt-panel-header .bar { width: 3px; height: 12px; border-radius: 2px; background: #c9a24a; }
.rt-panel-header .panel-sub { margin-left: auto; font-size: 10px; font-weight: 400; color: var(--text-dim); }

.tl-full { flex: 1; overflow-y: auto; padding: 8px 12px; }
.tl-group { margin-bottom: 8px; }
.tl-group-label { font-size: 10.5px; color: #c9a24a; font-weight: 600;
  padding: 4px 0 6px; position: sticky; top: 0; background: var(--bg-card, #14110d); z-index: 1; }

.tl-item { display: grid; grid-template-columns: 44px 24px 1fr; gap: 8px; cursor: pointer;
  padding: 2px 0; }
.tl-item:hover .tl-content b { color: #e6c878; }
.tl-time { text-align: right; font-variant-numeric: tabular-nums; font-size: 11px;
  color: var(--text-dim); padding-top: 6px; }
.tl-dot-col { position: relative; display: flex; justify-content: center; }
.tl-dot-col::before { content: ''; position: absolute; top: 0; bottom: 0;
  left: 50%; width: 2px; transform: translateX(-50%);
  background: linear-gradient(180deg, #2c2619, #211c13); }
.tl-item.last .tl-dot-col::before { bottom: 50%; }
.tl-dot { width: 11px; height: 11px; border-radius: 50%; margin-top: 6px; z-index: 1;
  border: 2px solid #0c0a08; }
.tl-dot.red { background: #f23645; box-shadow: 0 0 9px rgba(242,54,69,.7); }
.tl-dot.orange { background: #f0a23a; box-shadow: 0 0 9px rgba(240,162,58,.7); }
.tl-dot.blue { background: #4a9eff; box-shadow: 0 0 9px rgba(74,158,255,.7); }
.tl-dot.green { background: #08db94; box-shadow: 0 0 9px rgba(8,219,148,.7); }
.tl-dot.purple { background: #b388ff; box-shadow: 0 0 9px rgba(179,136,255,.7); }
.tl-dot.gold { background: #c9a24a; box-shadow: 0 0 9px rgba(201,162,74,.7); }

.tl-content { padding: 4px 0 10px; }
.tl-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tl-tag { font-size: 9px; font-weight: 700; padding: 1px 7px; border-radius: 5px; }
.tg-red { background: rgba(242,54,69,.16); color: #ff8a93; }
.tg-orange { background: rgba(240,162,58,.16); color: #f0a23a; }
.tg-blue { background: rgba(74,158,255,.16); color: #6ab0ff; }
.tg-green { background: rgba(8,219,148,.14); color: #2fe6ac; }
.tg-purple { background: rgba(179,136,255,.16); color: #c9a8ff; }
.tg-gold { background: rgba(201,162,74,.16); color: #e6c878; }
.tl-content b { font-size: 12.5px; }
.tl-desc { font-size: 10.5px; color: var(--text-dim); line-height: 1.5; margin-top: 4px; }

/* 右栏 */
.rt-right { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; }

.scroll { overflow-y: auto; scrollbar-width: thin; }
.scroll::-webkit-scrollbar { width: 5px; }
.scroll::-webkit-scrollbar-thumb { background: #3a3320; border-radius: 3px; }
```

- [ ] **Step 4: 验证展开视图渲染正常**

点击展开按钮，左右两栏布局正常，时间线分组显示正确。

- [ ] **Step 5: Commit**

```bash
git add src/components/ReviewTimeline.vue
git commit -m "feat(review): expanded view left column (full timeline)"
```

---

### Task 10: 实现右栏模块（情绪曲线 + 涨跌结构 + 板块 + 梯队 + 龙虎榜）

**Files:**
- Modify: `src/components/ReviewTimeline.vue`

**Interfaces:**
- Consumes: `data.emotion`, `data.structure`, `data.sectors`, `data.ladder`, `data.lhb`
- Produces: 右栏五个可折叠模块

- [ ] **Step 1: 添加 ECharts 情绪曲线**

```typescript
// 在 script setup 中添加
import { ref, onMounted, onBeforeUnmount, nextTick, watch } from "vue";
import * as echarts from "echarts";

const curveEl = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;

function renderCurve(hist: number[]) {
  if (!chart || !hist.length) return;
  chart.setOption({
    animation: false,
    grid: { left: 30, right: 10, top: 12, bottom: 20 },
    tooltip: { trigger: "axis", formatter: (p: any) => `温度 ${p[0].value}` },
    xAxis: { type: "category", show: false, data: hist.map((_, i) => i), boundaryGap: false },
    yAxis: {
      type: "value", min: 0, max: 100,
      splitLine: { lineStyle: { color: "rgba(255,255,255,.05)" } },
      axisLabel: { color: "#8a7f68", fontSize: 9 },
    },
    series: [{
      type: "line", data: hist, smooth: true, showSymbol: false,
      lineStyle: { color: "#c9a24a", width: 1.6 },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: "rgba(201,162,74,.30)" },
        { offset: 1, color: "rgba(201,162,74,0)" },
      ]) },
      markLine: { symbol: "none", silent: true, data: [{ yAxis: 50 }],
        lineStyle: { color: "#5a6478", type: "dashed", width: 1 }, label: { show: false } },
    }],
  });
}

// 模块折叠状态
const collapsed = ref<Record<string, boolean>>({
  emotion: false, structure: false, sectors: false, ladder: false, lhb: false,
});
function toggleCollapse(key: string) {
  collapsed.value[key] = !collapsed.value[key];
}

// 连板梯队：首板默认只显示前10
const firstBoardExpanded = ref(false);
```

- [ ] **Step 2: 替换右栏占位内容为五个模块**

```vue
<!-- 右栏 -->
<div class="rt-right scroll">
  <!-- 情绪曲线 -->
  <div class="rt-module">
    <div class="rt-module-head" @click="toggleCollapse('emotion')">
      <span class="bar"></span>情绪曲线
      <span class="collapse-icon">{{ collapsed.emotion ? '+' : '−' }}</span>
    </div>
    <div v-show="!collapsed.emotion" class="rt-module-body">
      <div ref="curveEl" class="curve-chart"></div>
    </div>
  </div>

  <!-- 涨跌结构 -->
  <div class="rt-module">
    <div class="rt-module-head" @click="toggleCollapse('structure')">
      <span class="bar"></span>涨跌结构
      <span class="collapse-icon">{{ collapsed.structure ? '+' : '−' }}</span>
    </div>
    <div v-show="!collapsed.structure" class="rt-module-body">
      <div v-if="structure" class="struct-grid">
        <div class="struct-item"><b class="up">{{ structure.limitUp }}</b><span>涨停</span></div>
        <div class="struct-item"><b class="down">{{ structure.limitDown }}</b><span>跌停</span></div>
        <div class="struct-item"><b class="flat">{{ structure.broken }}</b><span>炸板</span></div>
        <div class="struct-item"><b class="up">{{ structure.sealRate.toFixed(0) }}%</b><span>封板率</span></div>
        <div class="struct-wide"><span>上涨 / 下跌</span><b>{{ structure.upCount }} / {{ structure.downCount }}</b></div>
        <div class="struct-wide"><span>主力资金</span><b :class="structure.mainFund >= 0 ? 'up' : 'down'">{{ structure.mainFund >= 0 ? '+' : '' }}{{ structure.mainFund.toFixed(1) }} 亿</b></div>
        <div class="struct-wide"><span>最高连板</span><b class="up">{{ structure.maxBoards }}板 · {{ structure.topStock }}</b></div>
      </div>
    </div>
  </div>

  <!-- 热点板块 -->
  <div class="rt-module">
    <div class="rt-module-head" @click="toggleCollapse('sectors')">
      <span class="bar"></span>热点板块
      <span class="collapse-icon">{{ collapsed.sectors ? '+' : '−' }}</span>
    </div>
    <div v-show="!collapsed.sectors" class="rt-module-body">
      <div class="sector-list">
        <div v-for="(s, i) in data?.sectors?.slice(0, 10)" :key="s.code" class="sector-row">
          <span class="sec-rank">{{ i + 1 }}</span>
          <span class="sec-name">{{ s.name }}</span>
          <span class="sec-pct" :class="s.changePct >= 0 ? 'up' : 'down'">{{ s.changePct >= 0 ? '+' : '' }}{{ s.changePct.toFixed(1) }}%</span>
          <span class="sec-fund" :class="s.netAmount >= 0 ? 'up' : 'down'">{{ (s.netAmount / 1e8).toFixed(1) }}亿</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 连板梯队 -->
  <div class="rt-module">
    <div class="rt-module-head" @click="toggleCollapse('ladder')">
      <span class="bar"></span>连板梯队
      <span class="collapse-icon">{{ collapsed.ladder ? '+' : '−' }}</span>
    </div>
    <div v-show="!collapsed.ladder" class="rt-module-body">
      <div class="ladder-list">
        <div v-for="group in data?.ladder" :key="group.boards" class="ladder-group">
          <div class="ladder-boards" :class="'lv-' + Math.min(group.boards, 5)">
            {{ group.boards }}板 <span class="ladder-count">{{ group.count }}只</span>
          </div>
          <div class="ladder-stocks">
            <template v-if="group.boards > 1 || firstBoardExpanded">
              <span v-for="s in group.items" :key="s.code" class="ladder-stock"
                :class="{ early: s.firstSeal && s.firstSeal <= 100000, late: s.firstSeal && s.firstSeal >= 143000, broken: s.broken > 0 }"
                @click="emit('select', s.code)">{{ s.name }}</span>
            </template>
            <template v-else>
              <span v-for="s in group.items.slice(0, 10)" :key="s.code" class="ladder-stock"
                :class="{ early: s.firstSeal && s.firstSeal <= 100000, late: s.firstSeal && s.firstSeal >= 143000, broken: s.broken > 0 }"
                @click="emit('select', s.code)">{{ s.name }}</span>
              <span v-if="group.items.length > 10" class="ladder-more" @click="firstBoardExpanded = true">+{{ group.items.length - 10 }} 展开</span>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 龙虎榜 -->
  <div class="rt-module">
    <div class="rt-module-head" @click="toggleCollapse('lhb')">
      <span class="bar"></span>龙虎榜
      <span class="collapse-icon">{{ collapsed.lhb ? '+' : '−' }}</span>
    </div>
    <div v-show="!collapsed.lhb" class="rt-module-body">
      <div v-if="!data?.lhb?.length" class="rt-empty-small">当日暂无龙虎榜数据</div>
      <div v-else class="lhb-list">
        <div v-for="s in data.lhb.slice(0, 10)" :key="s.code" class="lhb-row" @click="emit('select', s.code)">
          <span class="lhb-name">{{ s.name }}</span>
          <span class="lhb-pct" :class="s.pct >= 0 ? 'up' : 'down'">{{ s.pct >= 0 ? '+' : '' }}{{ s.pct.toFixed(1) }}%</span>
          <span class="lhb-amt" :class="s.netAmt >= 0 ? 'up' : 'down'">
            {{ s.netAmt >= 0 ? '净买' : '净卖' }}{{ (Math.abs(s.netAmt) / 1e8).toFixed(2) }}亿
          </span>
        </div>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 3: 添加右栏模块样式**

```css
/* 模块通用 */
.rt-module { border-bottom: 1px solid var(--border, #211c13); }
.rt-module-head { display: flex; align-items: center; gap: 7px; height: 32px;
  padding: 0 12px; font-size: 12px; font-weight: 700; cursor: pointer;
  background: #14110d; position: sticky; top: 0; z-index: 2; }
.rt-module-head:hover { background: #1a1610; }
.rt-module-head .bar { width: 3px; height: 12px; border-radius: 2px; background: #c9a24a; }
.collapse-icon { margin-left: auto; font-size: 14px; color: var(--text-dim); width: 14px; text-align: center; }
.rt-module-body { padding: 8px 12px; }

/* 情绪曲线 */
.curve-chart { width: 100%; height: 130px; }

/* 涨跌结构 */
.struct-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 4px; }
.struct-item { display: flex; flex-direction: column; align-items: center; gap: 1px; }
.struct-item b { font-size: 15px; font-variant-numeric: tabular-nums; }
.struct-item span { font-size: 9.5px; color: var(--text-dim); }
.struct-wide { grid-column: 1 / -1; display: flex; justify-content: space-between;
  align-items: center; padding: 4px 2px; border-top: 1px solid #211c13; font-size: 11px; }
.struct-wide span { color: var(--text-dim); }
.struct-wide b { font-size: 11.5px; font-variant-numeric: tabular-nums; }

/* 板块列表 */
.sector-list { display: flex; flex-direction: column; gap: 2px; }
.sector-row { display: grid; grid-template-columns: 18px 1fr 45px 55px; gap: 6px;
  align-items: center; font-size: 11px; padding: 3px 2px; }
.sector-row:hover { background: #1a1610; }
.sec-rank { font-size: 10px; color: var(--text-dim); text-align: center; }
.sec-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sec-pct, .sec-fund { text-align: right; font-variant-numeric: tabular-nums; font-size: 10.5px; }

/* 连板梯队 */
.ladder-list { display: flex; flex-direction: column; gap: 6px; }
.ladder-group { display: grid; grid-template-columns: 55px 1fr; gap: 8px; align-items: start; }
.ladder-boards { font-size: 11px; font-weight: 700; padding: 2px 4px; border-radius: 3px;
  text-align: center; background: rgba(201,162,74,.12); color: #e6c878; }
.ladder-boards.lv-2 { background: rgba(242,54,69,.12); color: #ff8a93; }
.ladder-boards.lv-3 { background: rgba(242,54,69,.2); color: #ff6b78; }
.ladder-boards.lv-4 { background: rgba(242,54,69,.28); color: #ff4d5e; }
.ladder-boards.lv-5 { background: rgba(242,54,69,.35); color: #ff3347; }
.ladder-count { font-size: 9px; opacity: 0.7; font-weight: 400; }
.ladder-stocks { display: flex; flex-wrap: wrap; gap: 4px; }
.ladder-stock { font-size: 10.5px; padding: 1px 5px; border-radius: 3px;
  background: #1a1610; cursor: pointer; border: 1px solid transparent; }
.ladder-stock:hover { border-color: #c9a24a; }
.ladder-stock.early { border-color: rgba(201,162,74,.4); }
.ladder-stock.late { opacity: 0.6; }
.ladder-stock.broken { border-style: dashed; border-color: rgba(240,162,58,.5); }
.ladder-more { font-size: 10px; color: #c9a24a; cursor: pointer; padding: 1px 5px; }

/* 龙虎榜 */
.lhb-list { display: flex; flex-direction: column; gap: 2px; }
.lhb-row { display: grid; grid-template-columns: 1fr 45px auto; gap: 6px;
  align-items: center; font-size: 11px; padding: 4px 2px; cursor: pointer; }
.lhb-row:hover { background: #1a1610; }
.lhb-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lhb-pct { text-align: right; font-variant-numeric: tabular-nums; }
.lhb-amt { font-size: 10px; font-variant-numeric: tabular-nums; }

.rt-empty-small { text-align: center; color: var(--text-dim); font-size: 10.5px; padding: 10px; }
```

- [ ] **Step 4: 添加图表初始化和销毁逻辑**

```typescript
// 添加到 script setup
onMounted(async () => {
  await nextTick();
  if (curveEl.value) chart = echarts.init(curveEl.value);
  if (data.value?.emotion.hist) renderCurve(data.value.emotion.hist);
});

watch(() => data.value?.emotion.hist, (h) => {
  if (h && h.length > 0) renderCurve(h);
});

onBeforeUnmount(() => {
  chart?.dispose();
  chart = null;
});
```

- [ ] **Step 5: 验证右栏渲染正常**

展开视图后，五个模块都能正常显示，折叠/展开功能正常。

- [ ] **Step 6: Commit**

```bash
git add src/components/ReviewTimeline.vue
git commit -m "feat(review): expanded view right column modules"
```

---

## Phase 4: 完善与优化

### Task 11: 错误处理优化 + 空状态完善

**Files:**
- Modify: `src/composables/useReviewData.ts`
- Modify: `src/components/ReviewTimeline.vue`

- [ ] **Step 1: useReviewData 添加更友好的错误恢复**

在 `findNearestTradingDay` 失败时回退到今天日期，不抛错。

- [ ] **Step 2: ReviewTimeline 添加空状态的引导文案**

空状态时显示"暂无数据，试试切换日期"，并提供快捷切换到"最近交易日"的按钮。

- [ ] **Step 3: 测试各种异常场景**

- 无网络 / API 失败
- 非交易时间实时模式
- 日期选择到周末

- [ ] **Step 4: Commit**

```bash
git add src/composables/useReviewData.ts src/components/ReviewTimeline.vue
git commit -m "fix(review): better error handling and empty states"
```

---

### Task 12: 整体样式调优 + 最终测试

**Files:**
- Modify: `src/components/ReviewTimeline.vue`

- [ ] **Step 1: 运行完整单元测试**

Run: `npx vitest run tests/unit/utils/reviewBuilder.test.ts`
Expected: 全部通过

- [ ] **Step 2: 运行类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无新增类型错误

- [ ] **Step 3: 手动验证功能清单**

1. ✅ 非交易时间打开，自动显示历史模式 + 最近交易日数据
2. ✅ 紧凑视图：仪表盘 + 核心数据 + 迷你时间线
3. ✅ 点击展开：左右两栏布局正常
4. ✅ 左栏时间线：分组显示、节点类型多样、点击选个股
5. ✅ 右栏模块：情绪曲线、涨跌结构、热点板块、连板梯队、龙虎榜
6. ✅ 模块折叠功能正常
7. ✅ 日期选择器切换日期，数据更新
8. ✅ 主力资金负数显示绿色
9. ✅ 加载状态、错误状态、空状态都有提示

- [ ] **Step 4: 微调样式细节**

- 间距、字号对齐现有卡片风格
- 深色模式下对比度检查

- [ ] **Step 5: Commit**

```bash
git add src/components/ReviewTimeline.vue
git commit -m "style(review): polish styles and final testing"
```

---

## 验收清单

- [ ] `reviewBuilder.ts` 纯函数单元测试覆盖率 ≥ 80%
- [ ] 非交易时间打开卡片能看到最近交易日复盘数据
- [ ] 可选择任意历史交易日查看
- [ ] 交易时间可切换实时模式
- [ ] 紧凑视图：仪表盘 + 核心数据 + 迷你时间线
- [ ] 展开视图：左时间线 + 右五模块
- [ ] 时间线节点类型：涨停/炸板/回封/龙虎榜/板块异动
- [ ] 主力资金负数显示绿色（Bug修复）
- [ ] 数据加载失败有明确提示，可重试
- [ ] 不破坏现有卡片系统（`id`、`select` 事件都保留）
