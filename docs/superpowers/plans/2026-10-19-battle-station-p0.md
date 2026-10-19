# 作战台 2.0 · P0（时间轴 + 下单条）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「今日作战流」从六步任务清单换成时段驱动的作战台：时间轴 + 阶段面板 + 常驻下单条，模拟/实盘双轨、实盘一次确认。

**Architecture:** 前端新增 `src/components/battle/`（纯函数时段模型 + 时间轴 + 阶段面板 + 下单条 + 壳组件），通过 `battle_station_v2` 开关在 `CardContent.vue` 里与旧 `Cockpit.vue` 二选一；后端新增 `broker_quick_order` 命令，复用 `bridge` 建票与 `submit_with_sig` 的既有九道闸门，不新增任何绕过风控的入口。

**Tech Stack:** Vue 3.5 + TypeScript 5.6 + Pinia + Vitest + Playwright + Tauri 2.12 + Rust 2021 + rusqlite。

## Global Constraints

- 所有时段判断按 `Asia/Shanghai`（UTC+8）计算，禁止依赖本机时区。
- 实盘默认关闭；下单条一次确认弹窗是唯一人工动作，不做二次输入/长按。
- 下单必须走 `submit_with_sig`（kill switch / 连接态 / 频率熔断 / 白名单 / 单笔上限 / 数据新鲜度 / 涨跌停 / T+1 / 仓位），禁止直接调 `broker_client_position_order`。
- 六步 `workflow` 引擎（`src-tauri/src/ai/workflow*.rs`）不改动，只在 UI 里隐藏。
- 新增 Tauri 命令必须注册到 `src-tauri/src/lib.rs` 的 `invoke_handler`。
- 前端一律 `pnpm`；提交信息使用 `feat(ui):` / `feat(broker):` / `chore:` 前缀。
- Vitest 只跑 **node 纯函数测试**（不引入 jsdom）；组件渲染与交互一律用 Playwright e2e 验证。
- 文件 UTF-8（无 BOM）；Vue 组件使用 `<script setup lang="ts">`。
- 任何失败必须给用户可读中文原因，禁止静默吞错。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/components/battle/useBattlePhase.ts`（新建） | 时段模型纯函数：`computePhase` / `beijingClock` / `PHASES` / `CLOSED_PHASE` |
| `src/components/battle/PhaseTimeline.vue`（新建） | 时间轴渲染、当前段高亮与进度、倒计时、点击预览 |
| `src/components/battle/PhasePanel.vue`（新建） | 阶段「现在该做」清单 + 计划股实时涨幅 + 盘后战果 |
| `src/components/battle/OrderDock.vue`（新建） | 下单条 + 一次确认弹窗 + 提交结果 |
| `src/components/battle/BattleStation.vue`（新建） | 卡片壳：时钟、账户条、时间轴、面板、下单条 |
| `src/components/battle/useBattleFlag.ts`（新建） | `battle_station_v2` 开关（localStorage） |
| `src/components/CardContent.vue`（修改） | `cockpit` 卡片在旧 `Cockpit` 与新 `BattleStation` 间切换 |
| `src/broker/api.ts`（修改） | 新增 `brokerQuickOrder(...)` |
| `src-tauri/src/ai/bridge.rs`（修改） | 新增 `create_confirmed_ticket` |
| `src-tauri/src/broker/mod.rs`（修改） | 新增 `broker_quick_order` 命令 + `validate_quick_order` + 单测 |
| `src-tauri/src/lib.rs`（修改） | 注册 `broker_quick_order` |
| `tests/unit/battle-phase.test.ts`（新建） | 时段边界单测 |
| `tests/unit/battle-timeline.test.ts`（新建） | 时间轴模型单测（node 纯函数） |
| `src/components/battle/orderModel.ts`（新建） | 涨跌停 / 仓位档手数 / 提交校验纯函数 |
| `tests/unit/order-model.test.ts`（新建） | 下单条纯逻辑单测 |
| `tests/e2e/support/backend.ts`（修改） | 假后端补 `broker_get_status` / `broker_quick_order` / `risk_snapshot` |
| `tests/e2e/battle-station.spec.ts`（新建） | 开盘时段、下单流程、熔断禁用 |

---

### Task 1: 时段模型（纯函数）

**Files:**
- Create: `src/components/battle/useBattlePhase.ts`
- Test: `tests/unit/battle-phase.test.ts`

**Interfaces:**
- Produces:
  - `type PhaseId = "premarket" | "auction" | "open" | "midday" | "close" | "post" | "closed"`
  - `interface PhaseDef { id: PhaseId; label: string; color: string; headline: string; checklist: string[] }`
  - `interface PhaseState { phase: PhaseDef; progress: number; nextLabel: string; nextInSec: number; subLabel: string | null; weekend: boolean; minutes: number }`
  - `computePhase(now: Date): PhaseState`
  - `beijingClock(d: Date): { weekday: number; minutes: number; seconds: number }`
  - `PHASES: PhaseDef[]`（6 段）、`CLOSED_PHASE: PhaseDef`
  - `TIMELINE_SEGMENTS: { id: PhaseId; label: string; grow: number; color: string }[]`（6 段，开盘 grow=31）
  - `mmss(sec: number): string`（倒计时格式化）

- [ ] **Step 1: Write the failing test**

`tests/unit/battle-phase.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computePhase, TIMELINE_SEGMENTS, mmss } from "../../src/components/battle/useBattlePhase";

const at = (iso: string) => computePhase(new Date(iso));

describe("timeline model", () => {
  it("六段、开盘占比 31、倒计时格式化", () => {
    expect(TIMELINE_SEGMENTS).toHaveLength(6);
    expect(TIMELINE_SEGMENTS.find((s) => s.id === "open")!.grow).toBe(31);
    expect(mmss(1740)).toBe("29:00");
    expect(mmss(59)).toBe("00:59");
    expect(mmss(0)).toBe("00:00");
  });
});

describe("computePhase", () => {
  it("盘前：08:59", () => {
    const s = at("2026-10-19T08:59:00+08:00");
    expect(s.phase.id).toBe("premarket");
    expect(s.nextLabel).toBe("集合竞价");
    expect(s.nextInSec).toBe(16 * 60);
  });

  it("竞价：09:15 可撤单，09:20 起不可撤单", () => {
    expect(at("2026-10-19T09:15:00+08:00").phase.id).toBe("auction");
    expect(at("2026-10-19T09:19:59+08:00").subLabel).toBe("可撤单");
    expect(at("2026-10-19T09:20:00+08:00").subLabel).toBe("不可撤单");
    expect(at("2026-10-19T09:29:59+08:00").phase.id).toBe("auction");
  });

  it("开盘：三子段与进度", () => {
    expect(at("2026-10-19T09:30:00+08:00").phase.id).toBe("open");
    expect(at("2026-10-19T09:34:59+08:00").subLabel).toBe("首波");
    expect(at("2026-10-19T09:35:00+08:00").subLabel).toBe("承接");
    expect(at("2026-10-19T09:45:00+08:00").subLabel).toBe("分歧");
    const half = at("2026-10-19T09:45:00+08:00");
    expect(half.progress).toBeCloseTo(0.5, 5);
    expect(half.nextInSec).toBe(15 * 60);
  });

  it("盘中 / 尾盘 / 盘后 / 跨日", () => {
    expect(at("2026-10-19T10:00:00+08:00").phase.id).toBe("midday");
    expect(at("2026-10-19T14:30:00+08:00").phase.id).toBe("close");
    expect(at("2026-10-19T15:00:00+08:00").phase.id).toBe("post");
    expect(at("2026-10-20T00:30:00+08:00").phase.id).toBe("post");
    expect(at("2026-10-20T00:30:00+08:00").nextLabel).toBe("盘前");
  });

  it("周末休市", () => {
    const s = at("2026-10-24T10:00:00+08:00"); // 周六
    expect(s.phase.id).toBe("closed");
    expect(s.weekend).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/battle-phase.test.ts`
Expected: FAIL（`Failed to resolve import ".../useBattlePhase"`）

- [ ] **Step 3: Write minimal implementation**

`src/components/battle/useBattlePhase.ts`:

```ts
// 作战台时段模型：纯函数、按 Asia/Shanghai 计算，便于单测与回放。
export type PhaseId = "premarket" | "auction" | "open" | "midday" | "close" | "post" | "closed";

export interface PhaseDef {
  id: PhaseId;
  label: string;
  color: string;
  headline: string;
  checklist: string[];
}

export const CLOSED_PHASE: PhaseDef = {
  id: "closed",
  label: "休市",
  color: "#5d6670",
  headline: "非交易日，下一交易日再战",
  checklist: ["复盘上一交易日", "维护自选与题材", "检查明日作战卡"],
};

export const PHASES: PhaseDef[] = [
  {
    id: "premarket", label: "盘前", color: "#6aa6e8", headline: "确认今日作战卡",
    checklist: ["看昨日复盘结论", "核对作战卡前 3 条", "确认仓位与风控档位"],
  },
  {
    id: "auction", label: "集合竞价", color: "#e8c878", headline: "盯竞价，定开盘动作",
    checklist: ["09:20 后不可撤单", "计划股竞价强弱", "低开破位则放弃"],
  },
  {
    id: "open", label: "开盘", color: "#ff6b78", headline: "主战场：只打计划内的票",
    checklist: ["首波 5 分钟看承接", "触发计划再出手", "亏损单不加仓"],
  },
  {
    id: "midday", label: "盘中", color: "#2fbf95", headline: "管持仓，等新机会",
    checklist: ["持仓止损优先", "新开仓只做计划内", "午后缩量不追高"],
  },
  {
    id: "close", label: "尾盘", color: "#e89c3d", headline: "去弱留强，决定过夜",
    checklist: ["尾盘强度排序", "弱票减仓", "确定明日持仓"],
  },
  {
    id: "post", label: "盘后", color: "#8b97a8", headline: "复盘 + 生成明日作战卡",
    checklist: ["跑盘后流水线", "核对今日成交", "确认明日计划"],
  },
];

export interface PhaseState {
  phase: PhaseDef;
  progress: number;
  nextLabel: string;
  nextInSec: number;
  subLabel: string | null;
  weekend: boolean;
  minutes: number;
}

const B = {
  pre: 8 * 60 + 30,
  auction: 9 * 60 + 15,
  open: 9 * 60 + 30,
  midday: 10 * 60,
  close: 14 * 60 + 30,
  post: 15 * 60,
};

export function beijingClock(d: Date): { weekday: number; minutes: number; seconds: number } {
  const bj = new Date(d.getTime() + 8 * 3600_000);
  return {
    weekday: bj.getUTCDay(),
    minutes: bj.getUTCHours() * 60 + bj.getUTCMinutes(),
    seconds: bj.getUTCSeconds(),
  };
}

function phaseAt(m: number): PhaseDef {
  if (m >= B.pre && m < B.auction) return PHASES[0]!;
  if (m >= B.auction && m < B.open) return PHASES[1]!;
  if (m >= B.open && m < B.midday) return PHASES[2]!;
  if (m >= B.midday && m < B.close) return PHASES[3]!;
  if (m >= B.close && m < B.post) return PHASES[4]!;
  return PHASES[5]!;
}

function phaseRange(id: PhaseId): [number, number] {
  switch (id) {
    case "premarket": return [B.pre, B.auction];
    case "auction": return [B.auction, B.open];
    case "open": return [B.open, B.midday];
    case "midday": return [B.midday, B.close];
    case "close": return [B.close, B.post];
    default: return [B.post, B.post];
  }
}

function nextBoundary(m: number): { label: string; target: number; plusDay: boolean } {
  if (m < B.pre) return { label: "盘前", target: B.pre, plusDay: false };
  if (m < B.auction) return { label: "集合竞价", target: B.auction, plusDay: false };
  if (m < B.open) return { label: "开盘", target: B.open, plusDay: false };
  if (m < B.midday) return { label: "盘中", target: B.midday, plusDay: false };
  if (m < B.close) return { label: "尾盘", target: B.close, plusDay: false };
  if (m < B.post) return { label: "盘后", target: B.post, plusDay: false };
  return { label: "盘前", target: B.pre, plusDay: true };
}

function subLabelAt(id: PhaseId, m: number): string | null {
  if (id === "auction") return m < 9 * 60 + 20 ? "可撤单" : "不可撤单";
  if (id === "open") {
    if (m < 9 * 60 + 35) return "首波";
    if (m < 9 * 60 + 45) return "承接";
    return "分歧";
  }
  return null;
}

export const TIMELINE_SEGMENTS: { id: PhaseId; label: string; grow: number; color: string }[] = [
  { id: "premarket", label: "盘前", grow: 14, color: "#6aa6e8" },
  { id: "auction", label: "竞价", grow: 15, color: "#e8c878" },
  { id: "open", label: "开盘", grow: 31, color: "#ff6b78" },
  { id: "midday", label: "盘中", grow: 20, color: "#2fbf95" },
  { id: "close", label: "尾盘", grow: 10, color: "#e89c3d" },
  { id: "post", label: "盘后", grow: 10, color: "#8b97a8" },
];

export function mmss(sec: number): string {
  const m = Math.floor(Math.max(0, sec) / 60);
  const s = Math.max(0, sec) % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function computePhase(now: Date): PhaseState {
  const { weekday, minutes, seconds } = beijingClock(now);
  const weekend = weekday === 0 || weekday === 6;
  if (weekend) {
    return { phase: CLOSED_PHASE, progress: 0, nextLabel: "下一交易日", nextInSec: 0, subLabel: null, weekend, minutes };
  }
  const phase = phaseAt(minutes);
  const nb = nextBoundary(minutes);
  const diffMin = nb.plusDay ? 24 * 60 - minutes + nb.target : nb.target - minutes;
  const nextInSec = Math.max(0, diffMin * 60 - seconds);
  let progress = 0;
  if (phase.id !== "post") {
    const [start, end] = phaseRange(phase.id);
    progress = Math.min(1, Math.max(0, (minutes - start) / Math.max(1, end - start)));
  }
  return { phase, progress, nextLabel: nb.label, nextInSec, subLabel: subLabelAt(phase.id, minutes), weekend, minutes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/battle-phase.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add src/components/battle/useBattlePhase.ts tests/unit/battle-phase.test.ts
git commit -m "feat(ui): 作战台时段模型（Asia/Shanghai 纯函数 + 单测）"
```

---

### Task 2: 时间轴与阶段面板

**Files:**
- Create: `src/components/battle/PhaseTimeline.vue`
- Create: `src/components/battle/PhasePanel.vue`
- Test: `tests/unit/battle-timeline.test.ts`

**Interfaces:**
- Consumes: `computePhase` / `PhaseState` / `PhaseId`（Task 1）；`useWorkflowStore`；`Quote`（`src/api/types`）。
- Produces:
  - `PhaseTimeline` props `{ state: PhaseState; preview: PhaseId | null }`，emits `preview(id: PhaseId | null)`
  - `PhasePanel` props `{ state: PhaseState; preview: PhaseId | null; quotes: Record<string, Quote> }`，emits `pick(code: string)` / `preview(id: PhaseId | null)`

- [ ] **Step 1: Write the failing test**

`tests/unit/battle-timeline.test.ts`（node 纯函数，渲染由 Task 6 的 e2e 覆盖）：

```ts
import { describe, expect, it } from "vitest";
import { computePhase, TIMELINE_SEGMENTS, mmss } from "../../src/components/battle/useBattlePhase";

describe("battle timeline model", () => {
  it("开盘时段：六段、开盘占比 31、进度 1/30、倒计时 29:00", () => {
    const s = computePhase(new Date("2026-10-19T09:31:00+08:00"));
    expect(TIMELINE_SEGMENTS).toHaveLength(6);
    expect(TIMELINE_SEGMENTS.find((x) => x.id === "open")!.grow).toBe(31);
    expect(s.phase.id).toBe("open");
    expect(s.progress).toBeCloseTo(1 / 30, 5);
    expect(mmss(s.nextInSec)).toBe("29:00");
  });

  it("周末无当前段", () => {
    const s = computePhase(new Date("2026-10-24T10:00:00+08:00"));
    expect(s.weekend).toBe(true);
    expect(s.phase.id).toBe("closed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/battle-timeline.test.ts`
Expected: FAIL（`TIMELINE_SEGMENTS` / `mmss` 未导出）

- [ ] **Step 3: Write minimal implementation**

`src/components/battle/PhaseTimeline.vue`:

```vue
<script setup lang="ts">
import { computed } from "vue";
import { mmss, TIMELINE_SEGMENTS as SEGMENTS, type PhaseId, type PhaseState } from "./useBattlePhase";

const props = defineProps<{ state: PhaseState; preview: PhaseId | null }>();
const emit = defineEmits<{ (e: "preview", id: PhaseId | null): void }>();

const currentId = computed<PhaseId | null>(() => (props.state.weekend ? null : props.state.phase.id));
const isOn = (id: PhaseId) => currentId.value === id;

function click(id: PhaseId) {
  emit("preview", props.preview === id ? null : id);
}
</script>

<template>
  <div class="btl" data-testid="battle-phase">
    <div v-if="state.weekend" class="btl-closed">休市 · 下一交易日再战</div>
    <div v-else class="btl-bar">
      <button
        v-for="seg in SEGMENTS"
        :key="seg.id"
        type="button"
        class="btl-seg"
        :class="{ on: isOn(seg.id), preview: preview === seg.id }"
        :style="{ flexGrow: seg.grow, '--c': seg.color }"
        :title="seg.label"
        @click="click(seg.id)"
      >
        <span class="btl-label">{{ seg.label }}</span>
        <span v-if="isOn(seg.id)" class="btl-fill" :style="{ width: state.progress * 100 + '%' }" />
      </button>
    </div>
    <div class="btl-meta">
      <span class="btl-cur" :style="{ color: state.phase.color }">
        {{ state.phase.label }} · {{ state.phase.headline }}
      </span>
      <span v-if="!state.weekend" class="btl-next mono" data-testid="battle-countdown">
        距{{ state.nextLabel }} {{ mmss(state.nextInSec) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.btl { display: flex; flex-direction: column; gap: 6px; }
.btl-bar { display: flex; height: 30px; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
.btl-seg {
  position: relative; border: 0; border-right: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-card) 92%, transparent);
  color: var(--text-dim); font-size: 11px; cursor: pointer; padding: 0; overflow: hidden;
}
.btl-seg:last-child { border-right: 0; }
.btl-seg.on { background: color-mix(in srgb, var(--c) 22%, var(--bg-card)); color: var(--text); }
.btl-seg.preview { outline: 1px solid var(--c); outline-offset: -1px; }
.btl-fill { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--c); }
.btl-label { position: relative; z-index: 1; }
.btl-meta { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; }
.btl-closed { padding: 8px; text-align: center; color: var(--text-dim); border: 1px dashed var(--border); border-radius: 8px; }
.btl-cur { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-variant-numeric: tabular-nums; color: var(--text-dim); flex: none; }
</style>
```

`src/components/battle/PhasePanel.vue`:

```vue
<script setup lang="ts">
import { computed } from "vue";
import type { Quote } from "../../api/types";
import { useWorkflowStore } from "../../stores/workflow";
import { CLOSED_PHASE, PHASES, type PhaseId, type PhaseState } from "./useBattlePhase";

const props = defineProps<{
  state: PhaseState;
  preview: PhaseId | null;
  quotes: Record<string, Quote>;
}>();
const emit = defineEmits<{ (e: "pick", code: string): void; (e: "preview", id: PhaseId | null): void }>();

const wf = useWorkflowStore();
const shown = computed(() => {
  if (props.preview) return PHASES.find((p) => p.id === props.preview) ?? props.state.phase;
  return props.state.phase;
});
const isPreview = computed(() => !!props.preview && props.preview !== props.state.phase.id);
const plan = computed(() => (wf.battlePlan?.instructions ?? []).slice(0, 5));
const feedback = computed(() => wf.feedback);
</script>

<template>
  <section class="bpp" data-testid="battle-panel">
    <header class="bpp-head">
      <span class="bpp-title" :style="{ color: shown.color }">{{ shown.label }}</span>
      <span class="bpp-headline">{{ shown.headline }}</span>
      <button v-if="isPreview" type="button" class="bpp-back" @click="emit('preview', null)">回到当前</button>
    </header>

    <ul class="bpp-list">
      <li v-for="item in shown.checklist" :key="item">{{ item }}</li>
    </ul>

    <div v-if="!state.weekend && plan.length" class="bpp-plan">
      <button
        v-for="p in plan"
        :key="p.code"
        type="button"
        class="bpp-stock"
        @click="emit('pick', p.code)"
      >
        <span class="bpp-code mono">{{ p.code }}</span>
        <span class="bpp-name">{{ p.name }}</span>
        <span
          class="bpp-pct mono"
          :class="{ up: (quotes[p.code]?.pct ?? 0) >= 0, down: (quotes[p.code]?.pct ?? 0) < 0 }"
        >
          {{ (quotes[p.code]?.pct ?? 0).toFixed(2) }}%
        </span>
      </button>
    </div>

    <p v-if="state.weekend" class="bpp-dim">{{ CLOSED_PHASE.headline }}</p>
    <p v-else-if="feedback && state.phase.id === 'post'" class="bpp-dim">
      今日 {{ feedback.fills.total }} 笔成交 · 已实现 {{ feedback.realizedPnl }} 元 · 胜率 {{ feedback.winRate }}%
    </p>
  </section>
</template>

<style scoped>
.bpp { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; background: var(--bg-card); }
.bpp-head { display: flex; align-items: baseline; gap: 8px; }
.bpp-title { font-size: 12px; font-weight: 700; }
.bpp-headline { font-size: 12px; color: var(--text); }
.bpp-back { margin-left: auto; background: transparent; border: 0; color: var(--accent); font-size: 11px; cursor: pointer; }
.bpp-list { margin: 0; padding-left: 16px; color: var(--text-dim); font-size: 11.5px; line-height: 1.6; }
.bpp-plan { display: flex; flex-wrap: wrap; gap: 4px; }
.bpp-stock { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text); font-size: 11.5px; cursor: pointer; }
.bpp-stock:hover { background: var(--bg-hover); }
.bpp-pct.up { color: var(--up); }
.bpp-pct.down { color: var(--down); }
.bpp-dim { margin: 0; color: var(--text-dim); font-size: 11.5px; }
.mono { font-variant-numeric: tabular-nums; }
</style>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/unit/battle-timeline.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: Commit**

```bash
git add src/components/battle/PhaseTimeline.vue src/components/battle/PhasePanel.vue tests/unit/battle-timeline.test.ts
git commit -m "feat(ui): 作战台时间轴与阶段面板"
```

---

### Task 3: 下单条（一次确认）

**Files:**
- Create: `src/components/battle/orderModel.ts`
- Create: `src/components/battle/OrderDock.vue`
- Test: `tests/unit/order-model.test.ts`

**Interfaces:**
- Consumes: `brokerGetStatus` / `brokerQuickOrder` / `BrokerStatus`（`src/broker/api`）；`fetchOrderBook`；`useQuotesStore`；`toast`。
- Produces:
  - `orderModel.ts`：`type PositionPct = 2 | 3 | 4`、`boardRatio(code): number`、`limitPrices(code, prevClose): { up: number; down: number }`、`positionVolume(cash, position, price): number`、`canSubmitQuickOrder({ code, price, vol, blocked }): boolean`
  - `OrderDock` props `{ status: BrokerStatus | null; cash: number }`，emits `ordered`，expose `setCode(code: string)`。
- 数据属性：`data-testid` 为 `order-code` / `order-buy` / `order-sell` / `order-confirm` / `order-confirm-ok` / `order-confirm-cancel` / `order-msg` / `order-mode`。

- [ ] **Step 1: Write the failing test**

`tests/unit/order-model.test.ts`（node 纯函数；弹窗与提交由 Task 6 的 e2e 覆盖）：

```ts
import { describe, expect, it } from "vitest";
import {
  boardRatio,
  canSubmitQuickOrder,
  limitPrices,
  positionVolume,
} from "../../src/components/battle/orderModel";

describe("orderModel", () => {
  it("涨跌停按板块：主板 10%，创业板/科创板 20%", () => {
    expect(boardRatio("600519")).toBe(1.1);
    expect(boardRatio("300750")).toBe(1.2);
    expect(boardRatio("688981")).toBe(1.2);
    expect(limitPrices("600519", 100)).toEqual({ up: 110, down: 90 });
    expect(limitPrices("300750", 100)).toEqual({ up: 120, down: 80 });
    expect(limitPrices("600519", 0)).toEqual({ up: 0, down: 0 });
  });

  it("仓位档换算手数（向下取整到 100 股）", () => {
    expect(positionVolume(1_000_000, 2, 10)).toBe(50_000);
    expect(positionVolume(100_000, 4, 10)).toBe(2_500);
    expect(positionVolume(100, 2, 10)).toBe(0);
    expect(positionVolume(1_000_000, 3, 33)).toBe(10_100);
  });

  it("提交校验：代码 / 价格 / 数量 / 熔断", () => {
    expect(canSubmitQuickOrder({ code: "600519", price: 10, vol: 100, blocked: false })).toBe(true);
    expect(canSubmitQuickOrder({ code: "60051", price: 10, vol: 100, blocked: false })).toBe(false);
    expect(canSubmitQuickOrder({ code: "600519", price: 0, vol: 100, blocked: false })).toBe(false);
    expect(canSubmitQuickOrder({ code: "600519", price: 10, vol: 0, blocked: false })).toBe(false);
    expect(canSubmitQuickOrder({ code: "600519", price: 10, vol: 100, blocked: true })).toBe(false);
  });
});
```

> 校验 `positionVolume(1_000_000, 3, 33)`：`floor(333333.33 / 33 / 100) * 100 = floor(101.01) * 100 = 10_100`。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/order-model.test.ts`
Expected: FAIL（`orderModel.ts` 不存在）

- [ ] **Step 3: Write minimal implementation**

`src/components/battle/orderModel.ts`:

```ts
// 下单条的纯计算：涨跌停、仓位档手数、提交校验（node 可测，不依赖 DOM）。
export type PositionPct = 2 | 3 | 4;

export function boardRatio(code: string): number {
  return /^(30|68)/.test(code) ? 1.2 : 1.1;
}

export function limitPrices(code: string, prevClose: number): { up: number; down: number } {
  if (!prevClose) return { up: 0, down: 0 };
  const r = boardRatio(code);
  return { up: +(prevClose * r).toFixed(2), down: +(prevClose * (2 - r)).toFixed(2) };
}

export function positionVolume(cash: number, position: PositionPct, price: number): number {
  if (price <= 0 || cash <= 0) return 0;
  const ratio = position === 2 ? 0.5 : position === 3 ? 1 / 3 : 0.25;
  return Math.floor((cash * ratio) / price / 100) * 100;
}

export function canSubmitQuickOrder(a: {
  code: string;
  price: number;
  vol: number;
  blocked: boolean;
}): boolean {
  return !a.blocked && /^\d{6}$/.test(a.code) && a.price > 0 && a.vol > 0;
}
```

`src/components/battle/OrderDock.vue`:

```vue
<script setup lang="ts">
import { computed, ref } from "vue";
import { brokerQuickOrder, type BrokerStatus } from "../../broker/api";
import { fetchOrderBook } from "../../api/market";
import { useQuotesStore } from "../../stores/quotes";
import { toast } from "../../composables/useToast";
import { canSubmitQuickOrder, limitPrices, positionVolume, type PositionPct } from "./orderModel";
import type { OrderBook } from "../../api/types";

const props = defineProps<{ status: BrokerStatus | null; cash: number }>();
const emit = defineEmits<{ (e: "ordered"): void }>();

const quotes = useQuotesStore();
const code = ref("");
const price = ref(0);
const vol = ref(100);
const position = ref<PositionPct>(2);
const side = ref<"BUY" | "SELL">("BUY");
const book = ref<OrderBook | null>(null);
const confirmOpen = ref(false);
const busy = ref(false);
const lastMsg = ref("");

const q = computed(() => quotes.map[code.value]);
const name = computed(() => q.value?.name ?? book.value?.name ?? "");
const prevClose = computed(() => book.value?.prevClose ?? q.value?.prevClose ?? 0);
const limit = computed(() => limitPrices(code.value, prevClose.value));

const chips = computed(() => [
  { label: "最新", value: q.value?.price ?? 0 },
  { label: "买一", value: book.value?.bids?.[0]?.price ?? 0 },
  { label: "卖一", value: book.value?.asks?.[0]?.price ?? 0 },
  { label: "涨停", value: limit.value.up },
  { label: "跌停", value: limit.value.down },
]);

const live = computed(() => !!props.status && props.status.kind !== "mock");
const blocked = computed(() => !props.status || props.status.killSwitch || !props.status.connected);
const canSubmit = computed(() =>
  canSubmitQuickOrder({ code: code.value, price: price.value, vol: vol.value, blocked: blocked.value }),
);
const modeText = computed(() => {
  if (!props.status) return "未连接";
  if (props.status.killSwitch) return "已熔断";
  if (!props.status.connected) return "未连接";
  return live.value ? (props.status.liveEnabled ? "实盘" : "实盘未启用") : "模拟";
});
const amount = computed(() => price.value * vol.value);

async function loadBook(c: string) {
  if (!/^\d{6}$/.test(c)) return;
  try {
    book.value = await fetchOrderBook(c);
    if (!price.value) price.value = book.value.price || 0;
  } catch {
    book.value = null;
  }
}

function applyPosition(p: PositionPct) {
  position.value = p;
  const v = positionVolume(props.cash, p, price.value);
  if (v > 0) vol.value = v;
}

function openConfirm(s: "BUY" | "SELL") {
  if (blocked.value) return;
  side.value = s;
  if (!price.value) price.value = q.value?.price ?? book.value?.price ?? 0;
  confirmOpen.value = true;
}

async function submit() {
  if (!canSubmit.value || busy.value) return;
  busy.value = true;
  lastMsg.value = "";
  try {
    const info = await brokerQuickOrder(code.value, side.value, price.value, vol.value, position.value);
    lastMsg.value = `已提交 ${info.sigId}`;
    toast.success(`${side.value === "BUY" ? "买入" : "卖出"}委托已提交：${code.value} ${vol.value} 股`);
    confirmOpen.value = false;
    emit("ordered");
  } catch (e) {
    lastMsg.value = String((e as Error)?.message ?? e);
    toast.error(lastMsg.value);
  } finally {
    busy.value = false;
  }
}

function setCode(c: string) {
  code.value = c;
  price.value = quotes.map[c]?.price ?? 0;
  void loadBook(c);
}
defineExpose({ setCode });
</script>

<template>
  <div class="od" data-testid="order-dock">
    <div class="od-row">
      <input
        v-model.trim="code"
        class="od-code mono"
        data-testid="order-code"
        placeholder="代码"
        maxlength="6"
        inputmode="numeric"
        @blur="loadBook(code)"
      />
      <span class="od-name">{{ name || "—" }}</span>

      <input v-model.number="price" class="od-num mono" type="number" step="0.01" min="0" placeholder="价格" />
      <input v-model.number="vol" class="od-num mono" type="number" step="100" min="0" placeholder="数量" />

      <div class="od-chips">
        <button
          v-for="c in chips"
          :key="c.label"
          type="button"
          class="od-chip"
          :disabled="!c.value"
          @click="price = c.value"
        >{{ c.label }}</button>
      </div>

      <div class="od-pos">
        <button type="button" class="od-chip" :class="{ on: position === 2 }" @click="applyPosition(2)">1/2</button>
        <button type="button" class="od-chip" :class="{ on: position === 3 }" @click="applyPosition(3)">1/3</button>
        <button type="button" class="od-chip" :class="{ on: position === 4 }" @click="applyPosition(4)">1/4</button>
      </div>

      <button type="button" class="od-btn buy" data-testid="order-buy" :disabled="blocked" @click="openConfirm('BUY')">买入</button>
      <button type="button" class="od-btn sell" data-testid="order-sell" :disabled="blocked" @click="openConfirm('SELL')">卖出</button>

      <span class="od-mode" :class="{ live, dead: blocked }" data-testid="order-mode">{{ modeText }}</span>
      <span v-if="lastMsg" class="od-msg" data-testid="order-msg">{{ lastMsg }}</span>
    </div>

    <div v-if="confirmOpen" class="od-mask" @click.self="confirmOpen = false">
      <div class="od-confirm" data-testid="order-confirm">
        <h4>{{ side === "BUY" ? "买入" : "卖出" }}确认</h4>
        <dl>
          <dt>标的</dt><dd>{{ name || "—" }} <span class="mono">{{ code }}</span></dd>
          <dt>价格</dt><dd class="mono">{{ price.toFixed(2) }}</dd>
          <dt>数量</dt><dd class="mono">{{ vol }} 股（{{ position === 2 ? "1/2" : position === 3 ? "1/3" : "1/4" }} 仓）</dd>
          <dt>金额</dt><dd class="mono">{{ amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) }} 元</dd>
          <dt>账户</dt><dd>{{ modeText }}</dd>
          <dt>风控</dt><dd>提交时校验（熔断 / 白名单 / 单笔上限 / 新鲜度）</dd>
        </dl>
        <div class="od-actions">
          <button type="button" class="od-btn ghost" data-testid="order-confirm-cancel" @click="confirmOpen = false">取消</button>
          <button type="button" class="od-btn primary" data-testid="order-confirm-ok" :disabled="busy || !canSubmit" @click="submit">
            {{ busy ? "提交中…" : "确认下单" }}
          </button>
        </div>
        <p v-if="lastMsg" class="od-err">{{ lastMsg }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.od { border-top: 1px solid var(--border); padding-top: 8px; }
.od-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.od-code { width: 72px; }
.od-name { font-size: 11.5px; color: var(--text-dim); min-width: 48px; }
.od-num { width: 78px; }
.od-chip { padding: 2px 6px; font-size: 10.5px; border: 1px solid var(--border); border-radius: 5px; background: transparent; color: var(--text-dim); cursor: pointer; }
.od-chip:disabled { opacity: .45; cursor: default; }
.od-chip.on { color: var(--accent); border-color: var(--accent); }
.od-chips, .od-pos { display: flex; gap: 3px; }
.od-btn { padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text); font-size: 12px; cursor: pointer; }
.od-btn:disabled { opacity: .45; cursor: not-allowed; }
.od-btn.buy { color: var(--up); border-color: var(--up); }
.od-btn.sell { color: var(--down); border-color: var(--down); }
.od-btn.primary { background: var(--accent); color: #111; border-color: var(--accent); }
.od-btn.ghost { background: transparent; }
.od-mode { margin-left: auto; font-size: 10.5px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border); color: var(--text-dim); }
.od-mode.live { color: var(--up); border-color: var(--up); }
.od-mode.dead { color: var(--text-dim); opacity: .8; }
.od-msg { font-size: 11px; color: var(--text-dim); }
.od-mask { position: fixed; inset: 0; background: rgba(5,7,11,.55); display: flex; align-items: center; justify-content: center; z-index: 400; }
.od-confirm { width: 340px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.od-confirm h4 { margin: 0 0 10px; font-size: 13px; }
.od-confirm dl { display: grid; grid-template-columns: 56px 1fr; gap: 4px 8px; margin: 0; font-size: 12px; }
.od-confirm dt { color: var(--text-dim); }
.od-confirm dd { margin: 0; }
.od-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.od-err { margin: 8px 0 0; color: var(--up); font-size: 11.5px; }
.mono { font-variant-numeric: tabular-nums; }
</style>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/order-model.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add src/components/battle/orderModel.ts src/components/battle/OrderDock.vue tests/unit/order-model.test.ts
git commit -m "feat(ui): 下单条（一次确认 + 模拟/实盘徽标）"
```

---

### Task 4: 作战台壳与卡片接入

**Files:**
- Create: `src/components/battle/useBattleFlag.ts`
- Create: `src/components/battle/BattleStation.vue`
- Modify: `src/components/CardContent.vue`（替换 `cockpit` 分支）

**Interfaces:**
- Consumes: `computePhase`；`PhaseTimeline` / `PhasePanel` / `OrderDock`；`useWorkflowStore`；`brokerGetStatus` / `riskSnapshot`。
- Produces: `BattleStation`（无 props）；`useBattleFlag(storage?: FlagStorage)` 返回 `{ enabled, set }`，`FlagStorage` 为 `{ getItem, setItem }`。

- [ ] **Step 1: Write the failing test（开关默认值）**

`tests/unit/battle-flag.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { useBattleFlag, type FlagStorage } from "../../src/components/battle/useBattleFlag";

function memStorage(init: Record<string, string> = {}): FlagStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
}

describe("useBattleFlag", () => {
  it("默认开启，关闭后写入存储", () => {
    const s = memStorage();
    const f = useBattleFlag(s);
    expect(f.enabled.value).toBe(true);
    f.set(false);
    expect(s.map.get("battle_station_v2")).toBe("off");
    expect(f.enabled.value).toBe(false);
  });

  it("存储为 off 时默认关闭", () => {
    const f = useBattleFlag(memStorage({ battle_station_v2: "off" }));
    expect(f.enabled.value).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/battle-flag.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write minimal implementation**

`src/components/battle/useBattleFlag.ts`:

```ts
import { ref } from "vue";

const KEY = "battle_station_v2";

export interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function useBattleFlag(storage: FlagStorage = localStorage) {
  const enabled = ref(storage.getItem(KEY) !== "off");
  function set(v: boolean) {
    enabled.value = v;
    storage.setItem(KEY, v ? "on" : "off");
  }
  return { enabled, set };
}
```

`src/components/battle/BattleStation.vue`:

```vue
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import PhaseTimeline from "./PhaseTimeline.vue";
import PhasePanel from "./PhasePanel.vue";
import OrderDock from "./OrderDock.vue";
import { computePhase, type PhaseId } from "./useBattlePhase";
import { useWorkflowStore } from "../../stores/workflow";
import { useQuotesStore } from "../../stores/quotes";
import { brokerGetStatus, riskSnapshot, type BrokerStatus, type RiskSnapshot } from "../../broker/api";

const wf = useWorkflowStore();
const quotes = useQuotesStore();
const now = ref(new Date());
const preview = ref<PhaseId | null>(null);
const status = ref<BrokerStatus | null>(null);
const snap = ref<RiskSnapshot | null>(null);
const dock = ref<InstanceType<typeof OrderDock> | null>(null);
let clock = 0;
let poll = 0;

onMounted(async () => {
  void wf.loadToday();
  clock = window.setInterval(() => { now.value = new Date(); }, 1000);
  await refresh();
  poll = window.setInterval(refresh, 5000);
});
onBeforeUnmount(() => {
  window.clearInterval(clock);
  window.clearInterval(poll);
});

async function refresh() {
  try { status.value = await brokerGetStatus(); } catch { /* 未连接时保持上次状态 */ }
  try { snap.value = await riskSnapshot(); } catch { /* 模拟盘未初始化时忽略 */ }
}

const state = computed(() => computePhase(now.value));
const cash = computed(() => snap.value?.cash ?? 0);
const pct = computed(() => (snap.value?.positionPct ?? 0).toFixed(1));

function pick(code: string) {
  dock.value?.setCode(code);
  preview.value = null;
}
function money(n: number) {
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}
</script>

<template>
  <div class="bts" data-testid="battle-station">
    <header class="bts-head">
      <span class="bts-logo">作战台</span>
      <span class="bts-sub">现在该做什么，一屏看完</span>
      <span class="bts-acc mono">
        总资产 {{ money(snap?.equity ?? 0) }} · 现金 {{ money(cash) }} · 仓位 {{ pct }}%
      </span>
    </header>

    <PhaseTimeline :state="state" :preview="preview" @preview="preview = $event" />

    <div class="bts-body">
      <PhasePanel
        :state="state"
        :preview="preview"
        :quotes="quotes.map"
        @pick="pick"
        @preview="preview = $event"
      />
    </div>

    <OrderDock ref="dock" :status="status" :cash="cash" @ordered="refresh" />
  </div>
</template>

<style scoped>
.bts { display: flex; flex-direction: column; gap: 10px; height: 100%; padding: 10px 12px; overflow: auto; }
.bts-head { display: flex; align-items: baseline; gap: 10px; }
.bts-logo { font-size: 13px; font-weight: 700; color: var(--accent); letter-spacing: 1px; }
.bts-sub { font-size: 11px; color: var(--text-dim); }
.bts-acc { margin-left: auto; font-size: 11px; color: var(--text-dim); }
.bts-body { flex: 1; min-height: 0; }
.mono { font-variant-numeric: tabular-nums; }
</style>
```

- [ ] **Step 4: Wire into `CardContent.vue`**

在 `src/components/CardContent.vue` 的 `<script setup>` 中加入：

```ts
import BattleStation from "./battle/BattleStation.vue";
import { useBattleFlag } from "./battle/useBattleFlag";

const battle = useBattleFlag();
```

把原来的：

```vue
<Cockpit v-else-if="id === 'cockpit'" />
```

替换为：

```vue
<div v-else-if="id === 'cockpit'" class="cockpit-wrap">
  <button type="button" class="battle-switch" @click="battle.set(!battle.enabled.value)">
    {{ battle.enabled.value ? "旧版六步" : "新版作战台" }}
  </button>
  <BattleStation v-if="battle.enabled.value" />
  <Cockpit v-else />
</div>
```

在文件末尾追加（若无 `<style>` 则新建 `<style scoped>`）：

```vue
<style scoped>
.cockpit-wrap { position: relative; height: 100%; }
.battle-switch {
  position: absolute; top: 4px; right: 8px; z-index: 6;
  padding: 1px 8px; font-size: 10.5px; border-radius: 5px;
  border: 1px solid var(--border); background: color-mix(in srgb, var(--bg-card) 88%, transparent);
  color: var(--text-dim); cursor: pointer;
}
.battle-switch:hover { color: var(--text); border-color: var(--border-light); }
</style>
```

- [ ] **Step 5: Run tests & build**

Run: `pnpm test tests/unit/battle-flag.test.ts && pnpm build`
Expected: 测试 PASS，`vue-tsc` 无类型错误，构建成功。

- [ ] **Step 6: Commit**

```bash
git add src/components/battle/useBattleFlag.ts src/components/battle/BattleStation.vue src/components/CardContent.vue tests/unit/battle-flag.test.ts
git commit -m "feat(ui): 作战台卡片壳接入，旧六步流程可一键回退"
```

---

### Task 5: 后端 `broker_quick_order`

**Files:**
- Modify: `src-tauri/src/ai/bridge.rs`（新增 `create_confirmed_ticket` + 单测）
- Modify: `src-tauri/src/broker/mod.rs`（新增命令 + 校验函数 + 单测）
- Modify: `src-tauri/src/lib.rs`（`invoke_handler` 注册）
- Modify: `src/broker/api.ts`（新增 `brokerQuickOrder`）

**Interfaces:**
- Produces:
  - Rust: `pub fn create_confirmed_ticket(conn: &Connection, input: SignalInput) -> Option<String>`
  - Rust: `#[tauri::command] pub async fn broker_quick_order(app: AppHandle, code: String, side: String, price: f64, vol: i64, position: Option<i64>) -> Result<protocol::BrokerOrderInfo, String>`
  - Rust: `pub(crate) fn validate_quick_order(code: &str, side: &str, price: f64, vol: i64) -> Result<(), String>`
  - TS: `brokerQuickOrder(code: string, side: "BUY" | "SELL", price: number, vol: number, position?: number): Promise<BrokerOrderInfo>`

- [ ] **Step 1: Write the failing Rust test**

在 `src-tauri/src/broker/mod.rs` 的 `mod tests` 内追加：

```rust
    #[test]
    fn quick_order_validation() {
        assert!(validate_quick_order("600519", "BUY", 10.0, 100).is_ok());
        assert!(validate_quick_order("600519", "SELL", 10.0, 150).is_ok());
        assert!(validate_quick_order("60051", "BUY", 10.0, 100).is_err());
        assert!(validate_quick_order("600519", "HOLD", 10.0, 100).is_err());
        assert!(validate_quick_order("600519", "BUY", 0.0, 100).is_err());
        assert!(validate_quick_order("600519", "BUY", 10.0, 150).is_err());
        assert!(validate_quick_order("600519", "BUY", 10.0, 0).is_err());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run（需 MSVC 环境）：

```powershell
cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" >nul 2>&1 && cd /d `"D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri`" && cargo test quick_order_validation 2>&1"
```

Expected: FAIL（`validate_quick_order` 未定义）

- [ ] **Step 3: Implement bridge helper**

在 `src-tauri/src/ai/bridge.rs` 的 `create_ticket` 之后追加：

```rust
/// 下单条专用：创建并立即确认的信号票（复用 create_ticket 的字段与同日同向去重）。
pub fn create_confirmed_ticket(conn: &Connection, input: SignalInput) -> Option<String> {
    let price = input.ref_price;
    let vol = input.vol;
    let sig_id = create_ticket(conn, input)?;
    let now = now_millis();
    let amount = price * vol as f64;
    let updated = conn
        .execute(
            "UPDATE signal_ticket SET status='confirmed', price=?1, vol=?2, amount=?3, updated_at=?4 \
             WHERE sig_id=?5",
            rusqlite::params![price, vol, amount, now, sig_id],
        )
        .unwrap_or(0);
    if updated == 0 {
        return None;
    }
    audit(conn, &sig_id, "confirmed", "下单条手动确认（一次确认）", "dock");
    Some(sig_id)
}
```

- [ ] **Step 4: Implement command + registration**

在 `src-tauri/src/broker/mod.rs` 的 `broker_submit` 之后追加：

```rust
/// 下单条直下：一次确认后走与信号桥完全相同的风控 / 写单 / 成交推进链路。
#[tauri::command]
pub async fn broker_quick_order(
    app: AppHandle,
    code: String,
    side: String,
    price: f64,
    vol: i64,
    position: Option<i64>,
) -> Result<protocol::BrokerOrderInfo, String> {
    validate_quick_order(&code, &side, price, vol)?;
    let code = code.trim().to_string();
    let side = side.trim().to_ascii_uppercase();
    let name = market::get_quotes(vec![code.clone()])
        .await
        .ok()
        .and_then(|qs| qs.into_iter().find(|q| q.code == code).map(|q| q.name))
        .unwrap_or_else(|| code.clone());
    let dir = app.state::<crate::ai::AiState>().dir();
    let input = crate::ai::bridge::SignalInput {
        code: code.clone(),
        name,
        side: side.clone(),
        source: "dock".to_string(),
        model_version: "manual".to_string(),
        strategy: "manual".to_string(),
        confidence: 1.0,
        ref_price: price,
        vol,
        reason: format!("下单条手动下单（仓位档 {:?}）", position),
        trade_date: conditional::today_dashed(),
    };
    let sig_id = {
        let conn = maindb::open_readwrite(&dir)?;
        crate::ai::bridge::create_confirmed_ticket(&conn, input)
            .ok_or_else(|| "创建委托单失败：同方向已有待确认单据或参数非法".to_string())?
    };
    match submit_with_sig(&app, &sig_id).await {
        Ok(info) => Ok(info),
        Err(e) => {
            if let Ok(conn) = maindb::open_readwrite(&dir) {
                let _ = conn.execute(
                    "UPDATE signal_ticket SET status='rejected', updated_at=?1 \
                     WHERE sig_id=?2 AND status='confirmed'",
                    rusqlite::params![now_millis(), sig_id],
                );
            }
            Err(e)
        }
    }
}

pub(crate) fn validate_quick_order(code: &str, side: &str, price: f64, vol: i64) -> Result<(), String> {
    let c = code.trim();
    if c.len() != 6 || !c.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("证券代码需为 6 位数字".to_string());
    }
    let s = side.trim().to_ascii_uppercase();
    if s != "BUY" && s != "SELL" {
        return Err("方向只能是 BUY 或 SELL".to_string());
    }
    if !price.is_finite() || price <= 0.0 {
        return Err("委托价格无效".to_string());
    }
    if vol <= 0 {
        return Err("委托数量无效".to_string());
    }
    if s == "BUY" && vol % 100 != 0 {
        return Err("买入数量需为 100 股的整数倍".to_string());
    }
    Ok(())
}
```

在 `src-tauri/src/lib.rs` 的 `invoke_handler` 列表中 `broker::broker_submit,` 下一行加入：

```rust
            broker::broker_quick_order,
```

- [ ] **Step 5: Add bridge unit test**

在 `src-tauri/src/ai/bridge.rs` 的 `mod tests` 内追加：

```rust
    #[test]
    fn create_confirmed_ticket_marks_confirmed() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE signal_ticket(
                id INTEGER PRIMARY KEY AUTOINCREMENT, sig_id TEXT UNIQUE, trade_date TEXT,
                created_at INTEGER, code TEXT, name TEXT, side TEXT, source TEXT,
                model_version TEXT, strategy TEXT, confidence REAL, ref_price REAL,
                price REAL, vol INTEGER, amount REAL, reason TEXT, status TEXT, updated_at INTEGER);
             CREATE TABLE signal_audit(
                id INTEGER PRIMARY KEY AUTOINCREMENT, sig_id TEXT, action TEXT,
                detail TEXT, actor TEXT, created_at INTEGER);",
        )
        .unwrap();
        let input = SignalInput {
            code: "600519".into(),
            name: "贵州茅台".into(),
            side: "BUY".into(),
            source: "dock".into(),
            model_version: "manual".into(),
            strategy: "manual".into(),
            confidence: 1.0,
            ref_price: 1680.0,
            vol: 100,
            reason: "test".into(),
            trade_date: "2026-10-19".into(),
        };
        let sig_id = create_confirmed_ticket(&conn, input).expect("ticket");
        let (status, price, vol): (String, f64, i64) = conn
            .query_row(
                "SELECT status, price, vol FROM signal_ticket WHERE sig_id=?1",
                [&sig_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "confirmed");
        assert_eq!(price, 1680.0);
        assert_eq!(vol, 100);
    }
```

- [ ] **Step 6: Add frontend API + run all tests**

`src/broker/api.ts` 在 `brokerSubmit` 之后追加：

```ts
export function brokerQuickOrder(
  code: string,
  side: "BUY" | "SELL",
  price: number,
  vol: number,
  position?: number,
) {
  return invoke<BrokerOrderInfo>("broker_quick_order", { code, side, price, vol, position: position ?? null });
}
```

Run:

```powershell
cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" >nul 2>&1 && cd /d `"D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri`" && cargo test quick_order 2>&1"
pnpm test tests/unit/order-model.test.ts
```

Expected: Rust 测试 PASS（`quick_order_validation`、`create_confirmed_ticket_marks_confirmed`），前端测试 PASS。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/ai/bridge.rs src-tauri/src/broker/mod.rs src-tauri/src/lib.rs src/broker/api.ts
git commit -m "feat(broker): 下单条直下命令 broker_quick_order（复用九道闸门）"
```

---

### Task 6: 假后端补齐 + 端到端验收

**Files:**
- Modify: `tests/e2e/support/backend.ts`
- Create: `tests/e2e/battle-station.spec.ts`

**Interfaces:**
- Consumes: `broker_get_status` / `broker_quick_order` / `risk_snapshot` 假实现；`data-testid` 从 Task 2/3/4。
- Produces: `setFakeBrokerStatus(patch)`（测试内切换熔断/连接态）。

- [ ] **Step 1: Add fake handlers**

`tests/e2e/support/backend.ts` 顶部（`type Row` 之后）追加：

```ts
let fakeBrokerStatus: Record<string, unknown> = {
  kind: "mock",
  liveEnabled: false,
  connected: true,
  killSwitch: false,
  accountId: "SIM",
  clientSim: true,
  windowSim: true,
};

export function setFakeBrokerStatus(patch: Record<string, unknown>) {
  fakeBrokerStatus = { ...fakeBrokerStatus, ...patch };
}
```

在 `handlers` 对象内追加（放在 `check_latest` 之前）：

```ts
  broker_get_status: () => fakeBrokerStatus,
  broker_quick_order: (a) => ({
    id: 1, sigId: "QK1", brokerKind: "mock", brokerAccount: "SIM", brokerOrderId: "QK1",
    code: String(a?.code ?? ""), side: String(a?.side ?? "BUY"),
    price: Number(a?.price ?? 0), vol: Number(a?.vol ?? 0),
    status: "submitted", filledVol: 0, filledAvgPrice: 0, errorMsg: "",
    createdAt: Date.now(), updatedAt: Date.now(),
  }),
  risk_snapshot: () => ({
    equity: 1_000_000, cash: 1_000_000, marketValue: 0, positionPct: 0,
    dayPnl: 0, dayPnlPct: 0, drawdownPct: 0, stopTriggerCount: 0,
    consecutiveLosses: 0, killSwitch: false, warnings: [], positions: [],
  }),
  workflow_get_today: () => null,
  workflow_p1_products: () => ({ briefing: null, candidates: [], plan: null, planConfirmed: false }),
  workflow_p2_products: () => ({ feedback: null, running: false, killSwitch: false }),
```

- [ ] **Step 2: Write the e2e test**

`tests/e2e/battle-station.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { setFakeBrokerStatus } from "./support/backend";

async function openCockpit(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".dock-btn").first()).toBeVisible();
  await page.locator(".dock-btn").nth(5).click();
  await page.locator(".dp-item").filter({ hasText: "今日作战流" }).click();
  await expect(page.getByTestId("battle-station")).toBeVisible();
  await expect(page.getByTestId("order-mode")).not.toHaveText("未连接");
}

test("开盘时段高亮 + 倒计时", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-19T09:31:00+08:00") });
  await openCockpit(page);
  await expect(page.locator(".btl-seg.on")).toContainText("开盘");
  await expect(page.getByTestId("battle-countdown")).toContainText("距盘中");
  await expect(page.getByTestId("battle-countdown")).toContainText("29:00");
});

test("模拟盘下单：3 次点击 + 一次确认", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-19T09:31:00+08:00") });
  await openCockpit(page);

  await page.getByTestId("order-code").fill("600519");
  await page.getByTestId("order-code").blur();
  await page.getByTestId("order-buy").click();
  await expect(page.getByTestId("order-confirm")).toBeVisible();
  await expect(page.getByTestId("order-confirm")).toContainText("贵州茅台");
  await page.getByTestId("order-confirm-ok").click();
  await expect(page.getByTestId("order-msg")).toContainText("QK1");
});

test("熔断时下单条置灰", async ({ page }) => {
  setFakeBrokerStatus({ killSwitch: true });
  await page.clock.install({ time: new Date("2026-10-19T09:31:00+08:00") });
  await openCockpit(page);
  await expect(page.getByTestId("order-buy")).toBeDisabled();
  await expect(page.getByTestId("order-mode")).toContainText("已熔断");
});

test("默认模拟徽标 + 未启用实盘提示", async ({ page }) => {
  setFakeBrokerStatus({ killSwitch: false });
  await page.clock.install({ time: new Date("2026-10-19T09:31:00+08:00") });
  await openCockpit(page);
  await expect(page.getByTestId("order-mode")).toContainText("模拟");
});

test("旧版六步 / 新版作战台可切换", async ({ page }) => {
  setFakeBrokerStatus({ killSwitch: false });
  await page.clock.install({ time: new Date("2026-10-19T09:31:00+08:00") });
  await openCockpit(page);
  await page.locator(".battle-switch").click();
  await expect(page.getByTestId("battle-station")).toHaveCount(0);
  await expect(page.locator(".battle-switch")).toHaveText("新版作战台");
  await page.locator(".battle-switch").click();
  await expect(page.getByTestId("battle-station")).toBeVisible();
});
```

- [ ] **Step 3: Run e2e**

Run: `pnpm exec playwright test tests/e2e/battle-station.spec.ts --reporter=line`
Expected: 5 passed。若 `.dock-btn` 顺序变化导致找不到菜单，改为 `page.locator(".dock-btn").filter({ hasText: "交易" }).click()`。

- [ ] **Step 4: Full verification**

```powershell
pnpm test
pnpm build
cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" >nul 2>&1 && cd /d `"D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri`" && cargo clippy --all-targets -- -D warnings 2>&1"
```

Expected: 前端单测全绿、构建成功、clippy 零告警。

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/support/backend.ts tests/e2e/battle-station.spec.ts
git commit -m "test(e2e): 作战台开盘时段、下单确认与熔断验收"
```

---

## Self-Review

**1. Spec coverage**

| Spec 要求 | 对应任务 |
|---|---|
| 时段模型 + 开盘子段 | Task 1 |
| 非线性时间轴（开盘 31%）+ 倒计时 + 点击预览 | Task 2 |
| 阶段面板「现在该做」+ 计划股实时涨幅 | Task 2 |
| 下单条：价格 chips / 仓位档 / 买卖 / 模式徽标 | Task 3 |
| 一次确认弹窗（标的/价格/数量/金额/账户/风控说明） | Task 3 |
| 双轨路径共用 `submit_with_sig` | Task 5 |
| 旧六步可回退 | Task 4 |
| 熔断置灰、实盘未启用提示 | Task 3 + Task 6 |
| 验收 8 条中的 1/2/5/6/7 | Task 6（其余由单测覆盖） |

**2. Placeholder scan**：无 TBD/TODO；所有步骤含可执行代码或命令。

**3. Type consistency**：`PhaseState` / `PhaseId` 在 Task 1 定义，Task 2/4 引用；`brokerQuickOrder` 签名与 Rust 命令参数一致（code/side/price/vol/position）；`setFakeBrokerStatus` 在 Task 6 定义并在测试中导入。

**已知取舍**：P0 不接 `broker_chase_validate` 预检，确认弹窗明确写「提交时校验」，失败原因由 `submit_with_sig` 原文回显；节假日按周末近似，后续 P1 接入交易日历。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-19-battle-station-p0.md`.

Two execution options:

1. **Subagent-Driven（推荐）** — 每个 Task 派一个新 subagent，任务间双阶段 review，迭代快。
2. **Inline Execution** — 在当前会话按 executing-plans 分批执行，每批设检查点。

选哪种？
