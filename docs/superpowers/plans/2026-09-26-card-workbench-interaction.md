# 卡片工作台交互优化·鎏金专业版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改 Rust 的前提下，为 TickGold 卡片工作台增加可视化深度自定义、拖拽实时四向重排、自由模式辅助对齐、右键菜单、置顶/锁定/标签与撤销能力。

**Architecture:** 全部改动集中在前端三个点：扩展 `useWorkbench.ts` 的 `CardCustom` 与布局/状态逻辑；把单卡设置从 `CardShell.vue` 拆出为 `CardSettingsPopover.vue` 并新增 `CardContextMenu.vue`；在 `App.vue` 接线实时换位、ghost、右键菜单与撤销快捷键。纯 CSS 回弹动画，不引入任何新依赖。

**Tech Stack:** Vue 3.5 `<script setup lang="ts">`、Pinia（既有）、CSS Grid + TransitionGroup FLIP、SQLite 既有 `meta` 键持久化。

## Global Constraints

- 不新增任何 npm 依赖；不改 Rust（`src-tauri/**`）、不改数据库 schema、不改行情接口。
- 仅扩展 `CardCustom`（全部新字段可选）；旧布局 JSON 缺字段时按默认值渲染，不得报错。
- 强调色/渐变只作用于色条/边框/标题栏/选中态，**禁止改变内部图表涨跌红绿**。
- 数值写入前 clamp：`gradAngle 0..360`、`opacity 0.6..1`、`radius 6..18`、`borderWidth 0..2`、`tag` 截断 4 字。
- 所有动画限定 `transform/opacity`；必须含 `@media (prefers-reduced-motion: reduce)` 守卫。
- 提交约定：每个任务结束跑 `pnpm build`（含 `vue-tsc --noEmit`）通过后再提交；只提交本任务改动，不要卷入既有的 `src/App.vue`、`src/components/CardShell.vue` 未提交改动（第一个任务会先把这两处改动单独提交保存）。
- **验证方式说明**：本仓库未配置前端单测框架（`package.json` 无 vitest/jest，spec 也禁止新增依赖），故采用「`pnpm build` 类型检查 + dev 人工验证矩阵」作为每任务的测试周期；逻辑纯函数在任务 2/5 用一次性 Node 脚本断言验证（脚本用完即删，不入库）。

**参考文档：** 设计 spec：`docs/superpowers/specs/2026-09-26-card-workbench-interaction-design.md`

---

## Task 0: 保护既有未提交改动并建立工作基线

**目的：** 工作区已有用户对 `src/App.vue`（`.focus-rail` 毛玻璃）与 `src/components/CardShell.vue`（+2 行）的未提交改动。先确认其内容并单独提交，避免与后续大改动混杂；同时确认 dev/构建可用。

**Files:**
- Modify（仅提交既有改动）: `src/App.vue`, `src/components/CardShell.vue`

- [ ] **Step 1: 查看既有改动全文**

Run: `git -C "D:/Doubao-pek/股票盯盘系统·灵动岛版" diff`
Expected: 看到 App.vue 的 `.focus-rail` 毛玻璃样式（+7 行）与 CardShell.vue 的 2 行改动；确认无密钥/无关内容。

- [ ] **Step 2: 提交既有 UI 微调**

```bash
cd "D:/Doubao-pek/股票盯盘系统·灵动岛版"
git add src/App.vue src/components/CardShell.vue
git commit -m "style(workbench): 聚焦侧栏毛玻璃背景微调"
```

- [ ] **Step 3: 确认工作区干净且构建通过**

Run: `git status -s` → Expected: 无输出（干净）。
Run: `pnpm build` → Expected: `vue-tsc` 无错误、`vite build` 成功、生成 `dist/`。

---

## Task 1: CardCustom 扩展 + 默认外观解析 + CSS 变量注入

**Files:**
- Modify: `src/composables/useWorkbench.ts`（`CardCustom` 接口约 161 行；新增默认值解析；return 暴露）
- Modify: `src/components/CardShell.vue`（根元素注入 CSS 变量并应用到边框/圆角/背景/标题栏）
- Test: 一次性脚本 `D:/dsh/wb-t1-check.mjs`（用完即删）

**Interfaces:**
- Produces（后续任务依赖，命名必须一致）:
  - `CardCustom` 新增字段：`gradientTo?: string; gradAngle?: number; opacity?: number; radius?: number; borderWidth?: number; headStyle?: 1|2|3|4|5; pinned?: boolean; locked?: boolean; tag?: string;`
  - `cardLook(id: CardId): { color:string; gradientTo:string; gradAngle:number; opacity:number; radius:number; borderWidth:number; headStyle:number; pinned:boolean; locked:boolean; tag:string }`
  - `cardStyleVars(id: CardId): Record<string,string>` —— 返回注入根元素的 CSS 变量 map。
  - 常量 `HEAD_STYLES = 5`、`CARD_SWATCHES: string[]`（8 色）。

- [ ] **Step 1: 扩展接口与常量**

在 `src/composables/useWorkbench.ts`，把现有 `CardCustom`（约 161-167 行）整体替换为：

```ts
export interface CardCustom {
  span?: number;
  rspan?: number;
  collapsed?: boolean;
  color?: string;
  refresh?: number;
  // 外观
  gradientTo?: string;
  gradAngle?: number;
  opacity?: number;
  radius?: number;
  borderWidth?: number;
  headStyle?: 1 | 2 | 3 | 4 | 5;
  // 行为
  pinned?: boolean;
  locked?: boolean;
  tag?: string;
}
export const CARD_SWATCHES = [
  "#e8c878", "#ef5f6b", "#6aa6e8", "#2fbf95",
  "#b08ce8", "#ff9f43", "#2de1ff", "#d4af37",
];
```

- [ ] **Step 2: 新增 clamp 与 `cardLook` / `cardStyleVars`**

在 `useWorkbench()` 内部、`cardColorOf` 之前插入：

```ts
const clampN = (v: number | undefined, lo: number, hi: number, d: number) =>
  v === undefined || Number.isNaN(v) ? d : Math.max(lo, Math.min(hi, v));

function cardLook(id: CardId) {
  const cu = cardCustom.value[id] ?? {};
  const color = cu.color ?? CARD_META[id].accent;
  const gradAngle = clampN(cu.gradAngle, 0, 360, 135);
  return {
    color,
    gradientTo: cu.gradientTo ?? "",
    gradAngle,
    opacity: clampN(cu.opacity, 0.6, 1, 1),
    radius: clampN(cu.radius, 6, 18, 10),
    borderWidth: clampN(cu.borderWidth, 0, 2, 1),
    headStyle: clampN(cu.headStyle, 1, 5, 1) as 1 | 2 | 3 | 4 | 5,
    pinned: !!cu.pinned,
    locked: !!cu.locked,
    tag: (cu.tag ?? "").slice(0, 4),
  };
}
function cardStyleVars(id: CardId): Record<string, string> {
  const L = cardLook(id);
  const bg = L.gradientTo
    ? `linear-gradient(${L.gradAngle}deg, ${L.color} 0%, ${L.gradientTo} 100%)`
    : L.color;
  return {
    "--card-accent": L.color,
    "--card-accent2": L.gradientTo || L.color,
    "--card-grad": bg,
    "--card-opacity": String(L.opacity),
    "--card-radius": `${L.radius}px`,
    "--card-border": `${L.borderWidth}px`,
  };
}
```

- [ ] **Step 3: 暴露新成员**

在 return 对象的 `cardColorOf,` 附近加入 `cardLook, cardStyleVars`（`CARD_SWATCHES` 是模块级 `export const`，其他组件直接 `import { CARD_SWATCHES } from "../composables/useWorkbench"`，**不要**放进 return）。

- [ ] **Step 4: CardShell 接收新 props 并应用变量**

在 `src/components/CardShell.vue` 的 `defineProps` 增加 `locked?: boolean` 与 `look?: Record<string, string>`，默认 `locked:false, look: () => ({})`；根元素 `:style` 改为合并：

```vue
:style="[ { '--accent-var': effectiveColor }, look ]"
:class="{ focused, dragging, 'free-drag': freeDrag, collapsed, resizing, locked }"
```

在 `.card-shell` 样式中把圆角/边框宽度/背景透明度改为变量驱动（替换现有 `border-radius:10px;` 与背景两行）：

```css
.card-shell {
  border-radius: var(--card-radius, 10px);
  border-width: var(--card-border, 1px);
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--bg-card) calc(var(--card-opacity,1) * 100%), transparent),
    color-mix(in srgb, var(--bg-card2) calc(var(--card-opacity,1) * 100%), transparent));
}
```

并让左色条用渐变（替换 `.card-bar { background: var(--accent-var); }` 一行为 `background: var(--card-grad, var(--accent-var));`）。

- [ ] **Step 5: 在 App.vue 两处 CardShell 传参**

网格 CardShell（约 850-869 行）与自由模式 CardShell（约 785 行起）都加：
`:look="bench.cardStyleVars(id)" :locked="bench.cardLook(id).locked"`

- [ ] **Step 6: 类型检查 + 视觉默认不变验证**

Run: `pnpm build` → Expected: 通过。
dev 下目视确认：未自定义卡片外观与改动前一致（圆角 10、不透明、纯金色色条）。

- [ ] **Step 7: 提交**

```bash
git add src/composables/useWorkbench.ts src/components/CardShell.vue src/App.vue
git commit -m "feat(workbench): CardCustom 外观字段扩展 + CSS 变量外观系统"
```

---

## Task 2: 设置弹层拆分（外观/行为两页签）+ 常驻弱化工具条 + 锁定/置顶/标签渲染

**Files:**
- Create: `src/components/CardSettingsPopover.vue`
- Modify: `src/components/CardShell.vue`（用新组件替换内联 `.card-cfg`；工具按钮常驻弱化；锁/钉/标签图标）
- Modify: `src/composables/useWorkbench.ts`（新增 setter：`setCardLook`、`resetCardLook`、`togglePin`、`toggleLock`、`setCardTag`）
- Test: `D:/dsh/wb-t2-check.mjs`（用完即删，验证 clamp 逻辑可内联到组件后用 build 覆盖）

**Interfaces:**
- Produces:
  - `setCardLook(id, patch: Partial<CardCustom>): void`（内部 clamp）
  - `resetCardLook(id): void`（仅清外观+行为覆盖，保留 span/rspan）
  - `togglePin(id): void`、`toggleLock(id): void`、`setCardTag(id, t: string): void`
  - 组件 `CardSettingsPopover` props: `{ open:boolean; look: ReturnType<useWorkbench cardLook 形态>; refresh:number }`，emits: `close`、`look(patch)`、`refresh(n)`、`pin`、`lock`、`tag(string)`、`reset`。

- [ ] **Step 1: 在 useWorkbench 增加 setter（放在 `setCardRefresh` 之后）**

```ts
function setCardLook(id: CardId, patch: Partial<CardCustom>) {
  const p: Partial<CardCustom> = { ...patch };
  if (p.gradAngle !== undefined) p.gradAngle = clampN(p.gradAngle, 0, 360, 135);
  if (p.opacity !== undefined) p.opacity = clampN(p.opacity, 0.6, 1, 1);
  if (p.radius !== undefined) p.radius = clampN(p.radius, 6, 18, 10);
  if (p.borderWidth !== undefined) p.borderWidth = clampN(p.borderWidth, 0, 2, 1);
  if (p.headStyle !== undefined) p.headStyle = clampN(p.headStyle, 1, 5, 1) as 1|2|3|4|5;
  if (p.tag !== undefined) p.tag = p.tag.slice(0, 4);
  patchCustom(id, p);
}
function setCardTag(id: CardId, t: string) { patchCustom(id, { tag: t.slice(0, 4) }); }
function togglePin(id: CardId) { patchCustom(id, { pinned: !cardCustom.value[id]?.pinned }); }
function toggleLock(id: CardId) { patchCustom(id, { locked: !cardCustom.value[id]?.locked }); }
function resetCardLook(id: CardId) {
  const cu = cardCustom.value[id];
  if (!cu) return;
  cardCustom.value = { ...cardCustom.value, [id]: {
    span: cu.span, rspan: cu.rspan, collapsed: cu.collapsed, refresh: cu.refresh } };
}
```
（`clampN` 定义在 Task 1 Step 2；确保其作用域可见——它是 useWorkbench 内函数。）
在 return 暴露这五个函数。

- [ ] **Step 2: 新建 `CardSettingsPopover.vue`**

完整新文件（两页签、8 色板+取色器、滑块、标题样式分段、行为页）：

```vue
<template>
  <div v-if="open" class="csp" @pointerdown.stop>
    <div class="csp-tabs">
      <button type="button" :class="{ on: tab === 'look' }" @click="tab = 'look'">外观</button>
      <button type="button" :class="{ on: tab === 'behave' }" @click="tab = 'behave'">行为</button>
    </div>

    <div v-show="tab === 'look'" class="csp-pane">
      <div class="row">
        <span class="k">主色</span>
        <span class="sws">
          <button v-for="c in swatches" :key="c" type="button" class="sw"
            :class="{ on: look.color === c }" :style="{ background: c }"
            @click="$emit('look', { color: c })"></button>
        </span>
        <input type="color" class="pick" :value="look.color"
          @input="$emit('look', { color: ($event.target as HTMLInputElement).value })" />
      </div>
      <div class="row">
        <span class="k">渐变</span>
        <input type="checkbox" :checked="!!look.gradientTo" @change="onGradToggle" />
        <input v-if="look.gradientTo" type="color" class="pick" :value="look.gradientTo"
          @input="$emit('look', { gradientTo: ($event.target as HTMLInputElement).value })" />
        <button v-if="look.gradientTo" type="button" class="mini" @click="$emit('look', { gradientTo: '' })">清除</button>
      </div>
      <div v-if="look.gradientTo" class="row">
        <span class="k">角度</span>
        <input type="range" min="0" max="360" :value="look.gradAngle" class="rng"
          @input="$emit('look', { gradAngle: Number(($event.target as HTMLInputElement).value) })" />
        <span class="val">{{ look.gradAngle }}°</span>
      </div>
      <div class="row">
        <span class="k">不透度</span>
        <input type="range" min="0.6" max="1" step="0.02" :value="look.opacity" class="rng"
          @input="$emit('look', { opacity: Number(($event.target as HTMLInputElement).value) })" />
      </div>
      <div class="row">
        <span class="k">圆角</span>
        <input type="range" min="6" max="18" step="1" :value="look.radius" class="rng"
          @input="$emit('look', { radius: Number(($event.target as HTMLInputElement).value) })" />
      </div>
      <div class="row">
        <span class="k">边框</span>
        <input type="range" min="0" max="2" step="1" :value="look.borderWidth" class="rng"
          @input="$emit('look', { borderWidth: Number(($event.target as HTMLInputElement).value) })" />
      </div>
      <div class="row">
        <span class="k">标题栏</span>
        <span class="seg">
          <button v-for="n in 5" :key="n" type="button" class="seg-btn"
            :class="{ on: look.headStyle === n }" @click="$emit('look', { headStyle: n })">{{ n }}</button>
        </span>
      </div>
    </div>

    <div v-show="tab === 'behave'" class="csp-pane">
      <div class="row">
        <span class="k">刷新</span>
        <select class="sel" :value="refresh" @change="$emit('refresh', Number(($event.target as HTMLSelectElement).value))">
          <option :value="0">跟随全局</option>
          <option :value="3">3 秒</option><option :value="5">5 秒</option>
          <option :value="10">10 秒</option><option :value="30">30 秒</option>
        </select>
      </div>
      <div class="row">
        <span class="k">标签</span>
        <input class="txt" maxlength="4" :value="look.tag" placeholder="最多4字"
          @input="$emit('tag', ($event.target as HTMLInputElement).value)" />
      </div>
      <div class="row">
        <button type="button" class="toggle" :class="{ on: look.pinned }" @click="$emit('pin')">置顶 {{ look.pinned ? '✓' : '' }}</button>
        <button type="button" class="toggle" :class="{ on: look.locked }" @click="$emit('lock')">锁定 {{ look.locked ? '✓' : '' }}</button>
      </div>
      <button type="button" class="reset" @click="$emit('reset')">恢复该卡片默认外观</button>
    </div>

    <button type="button" class="done" @click="$emit('close')">完成</button>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { CARD_SWATCHES } from "../composables/useWorkbench";
defineProps<{
  open: boolean;
  look: { color: string; gradientTo: string; gradAngle: number; opacity: number; radius: number;
          borderWidth: number; headStyle: number; pinned: boolean; locked: boolean; tag: string; };
  refresh: number;
}>();
const emit = defineEmits<{
  (e: "close"): void; (e: "look", p: Record<string, unknown>): void;
  (e: "refresh", n: number): void; (e: "pin"): void; (e: "lock"): void;
  (e: "tag", t: string): void; (e: "reset"): void;
}>();
const tab = ref<"look" | "behave">("look");
const swatches = CARD_SWATCHES;
function onGradToggle(ev: Event) {
  const on = (ev.target as HTMLInputElement).checked;
  emit("look", { gradientTo: on ? "#2f6fed" : "" });
}
</script>

<style scoped>
.csp { position: absolute; top: 34px; right: 8px; width: 248px; z-index: 60; padding: 10px;
  border: 1px solid var(--border); border-radius: 12px; background: var(--bg-panel);
  box-shadow: 0 18px 44px rgba(0,0,0,.6); }
.csp-tabs { display: flex; gap: 4px; margin-bottom: 8px; }
.csp-tabs button { flex: 1; height: 24px; border: 1px solid var(--border); background: transparent;
  color: var(--text-dim); border-radius: 6px; font-size: 11px; cursor: pointer; }
.csp-tabs button.on { color: var(--card-accent, var(--text)); border-color: var(--card-accent, var(--border)); }
.csp-pane { display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-dim); }
.k { width: 42px; flex: none; }
.sws { display: flex; flex-wrap: wrap; gap: 5px; flex: 1; }
.sw { width: 17px; height: 17px; border-radius: 5px; border: 1px solid rgba(255,255,255,.12); cursor: pointer; }
.sw.on { outline: 2px solid rgba(255,255,255,.6); outline-offset: 1px; }
.pick { width: 28px; height: 22px; padding: 0; border: 1px solid var(--border); background: transparent; border-radius: 5px; }
.rng { flex: 1; }
.val { width: 30px; text-align: right; }
.seg { display: flex; gap: 3px; }
.seg-btn { width: 24px; height: 22px; border: 1px solid var(--border); background: transparent; color: var(--text-dim);
  border-radius: 5px; font-size: 11px; cursor: pointer; }
.seg-btn.on { color: var(--card-accent, var(--text)); border-color: var(--card-accent, var(--border)); }
.sel, .txt { flex: 1; height: 24px; background: var(--bg-card); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; font-size: 11px; padding: 0 6px; }
.mini { border: 1px solid var(--border); background: transparent; color: var(--text-dim);
  border-radius: 5px; font-size: 10px; padding: 2px 6px; cursor: pointer; }
.toggle { flex: 1; height: 26px; border: 1px solid var(--border); background: transparent; color: var(--text-dim);
  border-radius: 6px; font-size: 11px; cursor: pointer; }
.toggle.on { color: var(--card-accent, var(--text)); border-color: var(--card-accent, var(--border)); }
.reset { width: 100%; height: 26px; border: 1px solid var(--border); background: transparent; color: var(--text-dim);
  border-radius: 6px; font-size: 11px; cursor: pointer; }
.done { width: 100%; height: 26px; margin-top: 8px; border: 1px solid var(--border); background: transparent;
  color: var(--text); border-radius: 6px; font-size: 11px; cursor: pointer; }
.done:hover { border-color: var(--card-accent, var(--border)); color: var(--card-accent, var(--text)); }
</style>
```

- [ ] **Step 3: CardShell 替换内联设置为新组件**

删除模板内现有 `<!-- 单卡设置弹层 -->` 整个 `<div class="card-cfg">…</div>`（现 41-67 行），替换为：

```vue
<CardSettingsPopover
  :open="cfgOpen"
  :look="look"
  :refresh="refresh"
  @close="cfgOpen = false"
  @look="(p) => $emit('look', p)"
  @refresh="(n) => $emit('refresh', n)"
  @pin="$emit('pin')"
  @lock="$emit('lock')"
  @tag="(t) => $emit('tag', t)"
  @reset="$emit('resetlook')"
/>
```

`defineEmits` 增加：`(e:"look", p: Record<string, unknown>):void; (e:"pin"):void; (e:"lock"):void; (e:"tag", t:string):void; (e:"resetlook"):void;`
props 增加 `look`（必填，结构同 popover 的 look 类型）。删除不再使用的 `COLORS` 常量与 `.card-cfg/.cfg-*` 样式。
`<script setup>` 顶部 `import CardSettingsPopover from "./CardSettingsPopover.vue";`

- [ ] **Step 4: 工具按钮常驻弱化 + 锁/钉/标签图标**

把 `.head-tools` 的 `opacity:0` 改为 `opacity:.45`（保留 hover/focused 时 opacity:1 的规则）；头部在标题后、spacer 前插入状态图标：

```vue
<span v-if="look.tag" class="card-tag">{{ look.tag }}</span>
<span v-if="look.pinned" class="hs-ic" title="已置顶">
  <svg viewBox="0 0 24 24"><path fill="currentColor" d="M16 9V4l1-1V2H7v1l1 1v5l-2 2v2h5v6l1 1 1-1v-6h5v-2l-2-2z"/></svg>
</span>
<span v-if="look.locked" class="hs-ic" title="已锁定">
  <svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 17a2 2 0 002-2 2 2 0 00-2-2 2 2 0 00-2 2 2 2 0 002 2zm6-9h-1V6a5 5 0 00-10 0v2H6a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1V9a1 1 0 00-1-1zM9 6a3 3 0 016 0v2H9V6z"/></svg>
</span>
```

锁定时禁止拖拽与 resize：`onHeadDown` 开头加 `if (props.locked) return;`；resize 手柄按钮加 `v-if="resizable && !locked"`。
新增样式：

```css
.card-tag { font-size: 10px; line-height: 1; padding: 2px 5px; border-radius: 6px;
  color: var(--card-accent, var(--text)); background: color-mix(in srgb, var(--card-accent, var(--accent-var)) 16%, transparent); flex: none; }
.hs-ic { width: 13px; height: 13px; color: var(--card-accent, var(--text-dim)); flex: none; display: inline-flex; }
.hs-ic svg { width: 13px; height: 13px; }
```

- [ ] **Step 5: App.vue 接线新事件（两处 CardShell）**

在网格/自由两处 CardShell 上补充：
```vue
:look="bench.cardLook(id)"
@look="(p) => bench.setCardLook(id, p)"
@pin="bench.togglePin(id)"
@lock="bench.toggleLock(id)"
@tag="(t) => bench.setCardTag(id, t)"
@resetlook="bench.resetCardLook(id)"
```
（`:color` 与 `@color` 保留兼容；`refresh` 已有。）

- [ ] **Step 6: 构建 + dev 人工验证**

Run: `pnpm build` → 通过。
dev：齿轮 → 外观页改色/渐变/角度/不透度/圆角/边框/标题样式实时生效；行为页标签/置顶/锁定可用；锁定后不能拖、resize 手柄消失。

- [ ] **Step 7: 提交**

```bash
git add src/components/CardSettingsPopover.vue src/components/CardShell.vue src/composables/useWorkbench.ts src/App.vue
git commit - "feat(workbench): 两页签卡片外观/行为设置 + 锁定置顶标签"
```
（修正：提交命令用 `git commit -m "..."`，消息同上。）

---

## Task 3: 网格拖拽实时四向重排 + ghost 插入指示 + Esc 取消

**Files:**
- Modify: `src/composables/useWorkbench.ts`（改 `pointerDragStart` 为实时换位；新增取消快照）
- Modify: `src/components/CardShell.vue`（拖拽中可选渲染 ghost 视觉，本任务在 App 层做 ghost）
- Modify: `src/App.vue`（拖拽中的 ghost 占位元素 + 被拖卡半透明 + Esc 监听）
- Test: `D:/dsh/wb-t3-check.mjs`（用完即删：对纯换位函数做断言）

**Interfaces:**
- Produces:
  - `reorderTo(src: CardId, zone: Zone, index: number): void` —— 不可变地把 src 移到目标分区指定下标（供实时换位与松手复用）。
  - `liveDragId: Ref<CardId|null>`（等同现有 dragId，拖拽中持续非空）
  - `cancelLiveDrag(): void` —— 恢复拖拽前 `{openCards, zoneOverride}` 快照。
- Consumes: 现有 `zoneOf / mainCards / sideCards / timeMode`。

- [ ] **Step 1: 新增 `reorderTo` 纯函数方法（放在 `applyDrop` 之前）**

```ts
function reorderTo(src: CardId, zone: Zone, index: number) {
  const rest = openCards.value.filter((c) => c !== src);
  const zoneIds = rest.filter((i) => zoneOf(i) === zone);
  const other = rest.filter((i) => zoneOf(i) !== zone);
  const at = Math.max(0, Math.min(index, zoneIds.length));
  const nz = [...zoneIds.slice(0, at), src, ...zoneIds.slice(at)];
  if (zoneOverride.value[src] !== undefined || defaultZone(src) !== zone) zoneOverride.value[src] = zone;
  openCards.value = zone === "main" ? [...nz, ...other] : [...other, ...nz];
  timeMode.value = null;
}
```

- [ ] **Step 2: 改造 `pointerDragStart` 为实时换位 + 快照取消**

在函数体的 `st` 对象中增加快照字段：`beforeOrder: [] as CardId[], beforeZone: {} as Partial<Record<CardId, Zone>>, esc: false`。
激活拖拽那一刻（`st.active = true; dragId.value = id;` 之后）记录：
```ts
st.beforeOrder = [...openCards.value];
st.beforeZone = { ...zoneOverride.value };
```
把 `compute()` 内原来的 `hintOver(...) / hintZone(...)` 调用替换为**实时换位**：计算出 `{zone,index}` 后立刻 `reorderTo(id, zone, index)`（仍保留 `dropHint.value = {zone,index}` 供 ghost 高亮）。
`onMove` 中新增 Esc 键处理改为在 window 注册 `keydown`（见 Step 3），本步先让 `onUp` 在正常松手时不再调用旧 `applyDrop`（换位已实时完成），仅 `dragEnd()`；若 `st.esc` 则先恢复快照。
`onUp` 改为：
```ts
const onUp = () => {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("keydown", onKey);
  if (raf) cancelAnimationFrame(raf);
  if (st.esc) {
    openCards.value = [...st.beforeOrder];
    zoneOverride.value = { ...st.beforeZone };
  }
  dragEnd();
};
const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") st.esc = true; };
window.addEventListener("keydown", onKey);
```
> 保留 `applyDrop/dragStart/hintOver/hintZone/clearHint` 暂不删除（HTML5 兜底事件 `@drop` 仍引用 `applyDrop`），但其内部改为调用 `reorderTo`：把 `applyDrop` 函数体替换为基于 `dragId/dropHint` 调 `reorderTo(src, hint.zone, clampedIndex)` 后 `dragEnd()`。

- [ ] **Step 3: App.vue ghost 占位 + 被拖卡透明**

在 `.card-grid` 内、`v-for` 的 slot 上给被拖卡对应 slot 加类 `live-src`（`:class` 增加 `'live-src': bench.dragId.value === id`）；并在该 slot 内部顶部放一个仅拖拽中显示的 ghost：
```vue
<div v-if="bench.dragId.value === id" class="drag-ghost"></div>
```
新增样式：
```css
.card-slot.live-src { opacity: .4; }
.drag-ghost { position: absolute; inset: 4px; border: 1.5px dashed var(--accent, #e8c878);
  border-radius: 10px; pointer-events: none; z-index: 1; }
```
（`.card-slot` 已 `position` 参与 grid；若其 position 非 relative/absolute，则给 `.card-slot` 补 `position:relative`。）

- [ ] **Step 4: 一次性脚本验证 reorder 纯逻辑**

新建 `D:/dsh/wb-t3-check.mjs`，把 `reorderTo` 的数组变换抽成纯函数 `reorder(open, src, zone, index, zoneOf)` 并断言三种情况：

```js
function reorder(open, src, zone, index, zoneOf) {
  const rest = open.filter((c) => c !== src);
  const zoneIds = rest.filter((i) => zoneOf(i) === zone);
  const other = rest.filter((i) => zoneOf(i) !== zone);
  const at = Math.max(0, Math.min(index, zoneIds.length));
  const nz = [...zoneIds.slice(0, at), src, ...zoneIds.slice(at)];
  return zone === "main" ? [...nz, ...other] : [...other, ...nz];
}
let pass = 0, fail = 0;
const eq = (a, b, name) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? (pass++, console.log("PASS", name)) : (fail++, console.log("FAIL", name, a, b));
};
// 卡片：a,b,c 默认 main；d 默认 side
const zoneOf = (x) => (x === "d" ? "side" : "main");
eq(reorder(["a", "b", "c", "d"], "c", "main", 0, zoneOf), ["c", "a", "b", "d"], "same-zone to front");
eq(reorder(["a", "b", "c", "d"], "a", "side", 1, zoneOf), ["b", "c", "d", "a"], "cross-zone move");
eq(reorder(["a", "b", "c", "d"], "a", "main", 99, zoneOf), ["b", "c", "a", "d"], "index clamp to end");
console.log(fail === 0 ? "ALL PASS" : `${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
```

Run: `node D:/dsh/wb-t3-check.mjs` → Expected: 3 行 PASS 后 `ALL PASS`，退出码 0。
随后删除：`Remove-Item D:/dsh/wb-t3-check.mjs`。

- [ ] **Step 5: 构建 + dev 验证矩阵项 1/2/3**

Run: `pnpm build` → 通过。
dev：①同区拖动其他卡四向流动、松手定型；②跨主干/侧栏移动正确；③拖拽中按 Esc 回到原顺序；④无空洞/不重叠。

- [ ] **Step 6: 提交**

```bash
git add src/composables/useWorkbench.ts src/App.vue src/components/CardShell.vue
git commit -m "feat(workbench): 网格拖拽实时四向重排 + ghost + Esc 取消"
```

---

## Task 4: 自由模式对齐辅助线 + 边缘磁吸 + 一键整理

**Files:**
- Modify: `src/composables/useWorkbench.ts`（`startFreeDrag` 加对齐/磁吸；新增 `tidyFree()`；新增 ref `alignGuides`）
- Modify: `src/App.vue`（渲染辅助线；自由工具条加「一键整理」按钮）

**Interfaces:**
- Produces:
  - `alignGuides: Ref<{ v: number[]; h: number[] }>`（画布坐标 px；空数组=不显示）。
  - `tidyFree(): void` —— 对 `freeRects` 重新 shelf 装箱并保留尺寸。

- [ ] **Step 1: 新增 alignGuides ref（放在 freeDrag 旁）**

```ts
const alignGuides = ref<{ v: number[]; h: number[] }>({ v: [], h: [] });
```

- [ ] **Step 2: startFreeDrag 的 compute() 增加对齐吸附（完整逻辑）**

在现有 compute() 算出 `nx, ny` 并 clamp 之后、`freeDrag.value = {...}` 赋值之前，插入下面完整代码。它在网格单位内寻找与其他卡边缘距离最小（≤ 容差）的边并吸附，同时输出像素坐标辅助线：

```ts
      // ===== 边缘对齐 + 磁吸（在 nx/ny clamp 之后）=====
      const SNAP_X = 0.12; // 列单位（约 10px）
      const SNAP_Y = 10 / (ROW_UNIT + GAP); // 行单位（约 10px）
      alignGuides.value = { v: [], h: [] };
      const otherRects = Object.entries(freeRects.value)
        .filter(([k]) => k !== id)
        .map(([, r]) => r) as FreeRect[];
      // 候选：被拖卡的左/右缘分别去贴其他卡的左/右缘，取全局最小距离
      let best: { d: number; axis: "x" | "y"; edge: number; move: number } | null = null;
      const consider = (d: number, axis: "x" | "y", edge: number, move: number) => {
        if (d <= (axis === "x" ? SNAP_X : SNAP_Y) && (!best || d < best.d)) best = { d, axis, edge, move };
      };
      for (const r of otherRects) {
        consider(Math.abs(nx - r.x), "x", r.x, r.x - nx);
        consider(Math.abs(nx - (r.x + r.w)), "x", r.x + r.w, (r.x + r.w) - nx);
        consider(Math.abs(nx + base.w - r.x), "x", r.x, r.x - (nx + base.w));
        consider(Math.abs(nx + base.w - (r.x + r.w)), "x", r.x + r.w, (r.x + r.w) - (nx + base.w));
        consider(Math.abs(ny - r.y), "y", r.y, r.y - ny);
        consider(Math.abs(ny - (r.y + r.h)), "y", r.y + r.h, (r.y + r.h) - ny);
        consider(Math.abs(ny + base.h - r.y), "y", r.y, r.y - (ny + base.h));
        consider(Math.abs(ny + base.h - (r.y + r.h)), "y", r.y + r.h, (r.y + r.h) - (ny + base.h));
      }
      if (best) {
        if (best.axis === "x") {
          nx = clampNum(nx + best.move, 0, COLS - base.w);
          // 与 freeCellStyle 同一换算：x 像素 = edge * (画布宽+GAP)/COLS
          alignGuides.value.v = [best.edge * ((cr.width + GAP) / COLS)];
        } else {
          ny = clampNum(ny + best.move, 0, 60);
          alignGuides.value.h = [GAP + best.edge * (ROW_UNIT + GAP)];
        }
      }
```

在拖拽结束的 `up()` 函数内（无论是否 esc）加入清空：`alignGuides.value = { v: [], h: [] };`。

- [ ] **Step 3: 新增 tidyFree()**

```ts
function tidyFree() {
  if (!freeMode.value) return;
  const ids = openCards.value;
  const packed = packFree(ids); // 以默认尺寸 shelf 装箱
  // 保留用户当前尺寸，仅采用 packed 的 x/y 序列：按 packed 行序写回坐标
  const cur = freeRects.value;
  const next: Record<string, FreeRect> = {};
  ids.forEach((id) => {
    const p = packed[id];
    const keep = cur[id] ?? freeSizeOf(id);
    next[id] = { x: p.x, y: p.y, w: keep.w, h: keep.h };
  });
  // 再做一次碰撞收敛，避免保留尺寸导致重叠
  settleFreeRects(next);
  freeRects.value = next;
}
```
在 return 暴露 `alignGuides, tidyFree`。

- [ ] **Step 4: App.vue 渲染辅助线 + 工具条按钮**

在 `.free-canvas` 内加两层（pointer-events:none）：
```vue
<div v-for="(x,i) in bench.alignGuides.value.v" :key="'v'+i" class="align-v"
  :style="{ left: x + 'px' }"></div>
<div v-for="(y,i) in bench.alignGuides.value.h" :key="'h'+i" class="align-h"
  :style="{ top: y + 'px' }"></div>
```
```css
.align-v, .align-h { position: absolute; background: #2de1ff; opacity: .8; z-index: 30; pointer-events: none; }
.align-v { width: 1px; top: 0; bottom: 0; }
.align-h { height: 1px; left: 0; right: 0; }
```
自由工具条 `.free-toolbar` 在「恢复自动布局」按钮前加：
`<button class="ft-btn" @click="bench.tidyFree()">一键整理</button>`

- [ ] **Step 5: 构建 + dev 验证矩阵项 4**

Run: `pnpm build` → 通过。
dev：自由模式拖卡靠近其他卡边缘出现青色辅助线并吸附；「一键整理」后卡片整齐且平滑归位、不重叠。

- [ ] **Step 6: 提交**

```bash
git commit -m "feat(workbench): 自由模式对齐辅助线/磁吸 + 一键整理"
```
（先 `git add src/composables/useWorkbench.ts src/App.vue`。）

---

## Task 5: 右键菜单 + 复制/粘贴样式 + 置顶/锁定联动

**Files:**
- Create: `src/components/CardContextMenu.vue`
- Modify: `src/composables/useWorkbench.ts`（新增样式剪贴板 `copiedLook`、`copyLook`、`pasteLook`）
- Modify: `src/components/CardShell.vue`（`@contextmenu` 发射）
- Modify: `src/App.vue`（挂载菜单、键盘导航、边缘翻转定位）

**Interfaces:**
- Produces:
  - `copiedLook: Ref<Partial<CardCustom> | null>`
  - `copyLook(id): void`、`pasteLook(id): void`
  - `CardContextMenu` props: `{ x:number; y:number; locked:boolean; pinned:boolean; collapsed:boolean; canPaste:boolean }`；emits `action(a:"focus"|"collapse"|"pin"|"lock"|"copy"|"paste"|"color"|"tag"|"close")`、`close`。

- [ ] **Step 1: useWorkbench 新增样式剪贴板（togglePin 附近）**

```ts
const LOOK_KEYS = ["color","gradientTo","gradAngle","opacity","radius","borderWidth","headStyle"] as const;
const copiedLook = ref<Partial<CardCustom> | null>(null);
function copyLook(id: CardId) {
  const cu = cardCustom.value[id] ?? {};
  const out: Partial<CardCustom> = {};
  LOOK_KEYS.forEach((k) => { if (cu[k] !== undefined) (out as Record<string, unknown>)[k] = cu[k]; });
  copiedLook.value = out;
}
function pasteLook(id: CardId) {
  if (copiedLook.value) setCardLook(id, copiedLook.value);
}
```
return 暴露 `copiedLook, copyLook, pasteLook`（`LOOK_KEYS` 模块内即可）。

- [ ] **Step 2: 新建 CardContextMenu.vue**

```vue
<template>
  <div class="ctx" :style="{ left: x + 'px', top: y + 'px' }" @pointerdown.stop @contextmenu.prevent>
    <button v-for="(it, i) in items" :key="it.act" type="button" class="ctx-item"
      :class="{ dis: it.dis, danger: it.act === 'close', sep: it.sep, focus: i === hi }"
      @click="choose(it)" @mouseenter="hi = i">{{ it.label }}</button>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
const props = defineProps<{ x:number; y:number; locked:boolean; pinned:boolean;
  collapsed:boolean; canPaste:boolean; }>();
const emit = defineEmits<{ (e:"action", a:string):void; (e:"close"):void; }>();
type Act = "focus"|"collapse"|"pin"|"lock"|"copy"|"paste"|"color"|"tag"|"close";
const items = computed(() => {
  const list: { act: Act; label:string; dis?:boolean; sep?:boolean }[] = [
    { act: "focus", label: "聚焦放大" },
    { act: "collapse", label: props.collapsed ? "展开" : "折叠" },
    { act: "pin", label: props.pinned ? "取消置顶" : "置顶" },
    { act: "lock", label: props.locked ? "解锁" : "锁定" },
    { act: "copy", label: "复制样式" },
    { act: "paste", label: "粘贴样式", dis: !props.canPaste },
    { act: "color", label: "改色", sep: true },
    { act: "tag", label: "加/改标签" },
    { act: "close", label: "关闭卡片", sep: true },
  ];
  return list;
});
const hi = ref(0);
function choose(it: { act: Act; dis?: boolean }) {
  if (it.dis) return;
  emit("action", it.act);
}
function onKey(e: KeyboardEvent) {
  const enabled = items.value.filter((i) => !i.dis);
  if (e.key === "ArrowDown") { hi.value = (hi.value + 1) % items.value.length; }
  else if (e.key === "ArrowUp") { hi.value = (hi.value - 1 + items.value.length) % items.value.length; }
  else if (e.key === "Enter") { const it = items.value[hi.value]; if (!it.dis) choose(it); }
  else if (e.key === "Escape") emit("close");
}
function onDocDown(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".ctx")) emit("close");
}
onMounted(() => { window.addEventListener("keydown", onKey, true); window.addEventListener("pointerdown", onDocDown, true); });
onBeforeUnmount(() => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("pointerdown", onDocDown, true); });
</script>
<style scoped>
.ctx { position: fixed; z-index: 200; min-width: 148px; padding: 4px; border: 1px solid var(--border);
  border-radius: 10px; background: var(--bg-panel); box-shadow: 0 18px 44px rgba(0,0,0,.65); }
.ctx-item { display: block; width: 100%; text-align: left; height: 28px; padding: 0 10px; border: none;
  background: transparent; color: var(--text); font-size: 12px; border-radius: 6px; cursor: pointer; }
.ctx-item.focus, .ctx-item:hover:not(.dis) { background: var(--bg-hover); }
.ctx-item.dis { color: var(--text-dim); cursor: default; }
.ctx-item.danger { color: #ef5f6b; }
.ctx-item.sep { margin-top: 4px; }
.ctx-item.sep::before { content: ""; }
</style>
```

- [ ] **Step 3: CardShell 发 contextmenu 事件**

emits 增加 `(e:"menu", ev: { x:number; y:number }): void;`；根元素加 `@contextmenu.prevent="onCtx"`：
```ts
function onCtx(e: MouseEvent) { emit("menu", { x: e.clientX, y: e.clientY }); }
```

- [ ] **Step 4: App.vue 挂载菜单与动作分发**

`<script setup>` 增加：
```ts
const ctxMenu = ref<{ id: CardId; x: number; y: number } | null>(null);
function onCardMenu(id: CardId, p: { x: number; y: number }) {
  const W = 170, H = 280;
  ctxMenu.value = { id, x: Math.min(p.x, window.innerWidth - W - 8), y: Math.min(p.y, window.innerHeight - H - 8) };
}
function onCtxAction(a: string) {
  const id = ctxMenu.value?.id; if (!id) return;
  const b = bench;
  if (a === "focus") { if (b.focusId.value === id) b.restoreFocus(); else enterFocus(id); }
  else if (a === "collapse") b.toggleCollapse(id);
  else if (a === "pin") b.togglePin(id);
  else if (a === "lock") b.toggleLock(id);
  else if (a === "copy") b.copyLook(id);
  else if (a === "paste") b.pasteLook(id);
  else if (a === "tag") { b.setCardTag(id, prompt("标签（最多4字）", b.cardLook(id).tag) ?? b.cardLook(id).tag); }
  else if (a === "color") { b.openCfgId.value = id; }
  else if (a === "close") b.close(id);
  ctxMenu.value = null;
}
```
> 「改色」菜单项不做二级浮层（YAGNI），改为打开该卡设置弹层（默认外观页）。用一个瞬态信号完成，按下面 (a)(b)(c) 三处实现：

(a) `useWorkbench.ts`：在 `cardCustom` 声明附近新增并在 return 暴露
`const openCfgId = ref<CardId | null>(null);`

(b) `CardShell.vue`：props 增加 `cfgOpenSignal?: boolean`（默认 false），emits 增加 `(e:"cfg-consumed"):void`；`<script setup>` 顶部 `import { ref, computed, watch } from "vue";`，并加：
```ts
watch(() => props.cfgOpenSignal, (v) => { if (v) { cfgOpen.value = true; emit("cfg-consumed"); } });
```

(c) 两处 CardShell 接线：
```vue
:cfg-open-signal="bench.openCfgId.value === id"
@cfg-consumed="bench.openCfgId = null"
```

模板末尾（与命令面板同级）挂载：
```vue
<CardContextMenu v-if="ctxMenu" :x="ctxMenu.x" :y="ctxMenu.y"
  :locked="bench.cardLook(ctxMenu.id).locked" :pinned="bench.cardLook(ctxMenu.id).pinned"
  :collapsed="bench.isCollapsed(ctxMenu.id)" :can-paste="!!bench.copiedLook.value"
  @action="onCtxAction" @close="ctxMenu = null" />
```
两处 CardShell 加 `@menu="(p) => onCardMenu(id, p)"`。

- [ ] **Step 5: 构建 + dev 验证矩阵项 8**

Run: `pnpm build` → 通过。
dev：右键菜单各项生效；↑↓/Enter/Esc 与点击外部关闭可用；复制 A 样式 → 粘贴到 B 外观一致；菜单在右下角不溢出。

- [ ] **Step 6: 提交**

```bash
git add src/components/CardContextMenu.vue src/components/CardShell.vue src/composables/useWorkbench.ts src/App.vue
git commit -m "feat(workbench): 卡片右键菜单 + 复制/粘贴样式"
```

---

## Task 6: 撤销栈 + Ctrl/⌘+Z + 关闭 toast

**Files:**
- Modify: `src/composables/useWorkbench.ts`（撤销栈，包装结构操作）
- Modify: `src/App.vue`（全局快捷键、toast 渲染）

**Interfaces:**
- Produces:
  - `undo(): boolean`
  - `canUndo: Ref<boolean>`
  - `lastClosed: Ref<{ id: CardId } | null>`（供 toast 文案，toast 自动消失由 App 管）

- [ ] **Step 1: 增加撤销栈（useWorkbench 内，persistCurrent 之前）**

```ts
const undoStack: string[] = [];
const UNDO_MAX = 20;
const canUndo = ref(false);
const lastClosed = ref<{ id: CardId } | null>(null);
function pushUndo() {
  undoStack.push(serialize());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  canUndo.value = undoStack.length > 0;
}
function undo(): boolean {
  const snap = undoStack.pop();
  canUndo.value = undoStack.length > 0;
  if (!snap) return false;
  clearSlotInline();
  applySnapshot(snap);
  return true;
}
```
> 注意 `serialize/applySnapshot/clearSlotInline` 定义在后面（函数声明提升对 `function` 有效，const 箭头不行；这里它们都是 `function`，故可用）。确认 `canUndo` 初值 false。

- [ ] **Step 2: 在结构操作入口 push 快照**

在这些函数**改状态之前**调用 `pushUndo()`：`open`、`close`（同时 `lastClosed.value={id}`）、`applyDrop`/`reorderTo`（仅拖拽真正激活时 push 一次——在 pointerDragStart 激活时 push，而非每帧 reorderTo；因此 reorderTo 内**不**push，改在 `st.active=true` 分支 push）、`tidyFree`、`resetLayout`、`setMode`、`applyScene`、`enableFree`、`disableFree`、`enterTimeMode`。
外观 setter（`setCardLook/setCardColor/...`）不 push。
在 return 暴露 `undo, canUndo, lastClosed`。

> 实现细节：为避免实时拖拽每帧 push，push 点放在 `pointerDragStart` 激活分支（Task 3 的 `if (!st.active){ st.active=true; dragId.value=id; pushUndo(); ...}`）。取消（Esc）时把刚 push 的快照弹出（`undoStack.pop(); canUndo=...`），因为状态也回滚了。

- [ ] **Step 3: App.vue 全局 Ctrl/⌘+Z**

在 App.vue 的 onMounted 键盘处理中（若已有全局 keydown 则合并，否则新增）注册：
```ts
function onUndoKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) && !t.isContentEditable) {
    e.preventDefault();
    bench.undo();
    undoToast.value = false;
  }
}
window.addEventListener("keydown", onUndoKey);
onBeforeUnmount(() => window.removeEventListener("keydown", onUndoKey));
```
（确认顶部已 import `onMounted/onBeforeUnmount/ref`。）

- [ ] **Step 4: 关闭卡片 toast（watch lastClosed）**

```ts
const undoToast = ref(false);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
watch(() => bench.lastClosed.value, (v) => {
  if (!v) return;
  undoToast.value = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { undoToast.value = false; bench.lastClosed.value = null; }, 5000);
});
```
模板（根 div 内、顶部居中）：
```vue
<Transition name="toast">
  <button v-if="undoToast" type="button" class="undo-toast" @click="bench.undo(); undoToast=false">
    卡片已关闭 · 撤销
  </button>
</Transition>
```
```css
.undo-toast { position: fixed; top: 124px; left: 50%; transform: translateX(-50%); z-index: 300;
  padding: 8px 16px; border: 1px solid var(--border); border-radius: 20px; background: var(--bg-panel);
  color: var(--text); font-size: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.5); cursor: pointer; }
.toast-enter-active, .toast-leave-active { transition: opacity .2s, transform .2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(-6px); }
```

- [ ] **Step 5: 构建 + dev 验证矩阵项 10/11**

Run: `pnpm build` → 通过。
dev：关卡片出 toast，点撤销/Ctrl+Z 恢复；拖动后 Ctrl+Z 回退；连续 21 次结构操作后最旧记录被丢弃且不报错；输入框内 Ctrl+Z 不触发撤销。

- [ ] **Step 6: 提交**

```bash
git add src/composables/useWorkbench.ts src/App.vue
git commit -m "feat(workbench): 结构操作撤销栈 + Ctrl/Z 恢复 + 关闭撤销 toast"
```

---

## Task 7: 回弹动效 + 错峰 FLIP + reduced-motion + 全量验收

**Files:**
- Modify: `src/App.vue`（卡片错峰 delay、回弹曲线、reduced-motion）
- Modify: `src/components/CardShell.vue`（resize/聚焦回弹、错峰变量）

- [ ] **Step 1: 关键曲线替换为轻回弹**

在 App.vue 把 `.card-move` 的 `transition: transform .38s cubic-bezier(.2,.8,.2,1)` 改为
`transition: transform .42s cubic-bezier(.34,1.25,.5,1);`
聚焦相关内联 FTRANS（搜 `FTRANS` 常量，约 App.vue 顶部）若为旧曲线，改为同一回弹曲线。

- [ ] **Step 2: 批量开卡错峰**

给入场卡片设置 `--i` 变量（slot 上 `:style="[ bench.layout.value[id], { '--i': String(Math.min(openIndex,6)) } ]"`，其中 `openIndex` 用 `bench.openCards.value.indexOf(id)`）。
把 `.card-enter` 的 `animation: cardIn .38s ...` 增加 `animation-delay: calc(var(--i,0) * 60ms);`。

- [ ] **Step 3: 全局 reduced-motion 守卫**

在 `src/styles/global.css` 末尾追加：
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .001ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 4: 锁定卡不参与拖动光标**

确认 Task 2 的锁定已拦截头部拖拽与手柄；补充 `.card-shell.locked .card-head { cursor: default; }`。

- [ ] **Step 5: 全量构建与人工矩阵（spec 第十节 1–16 项）**

Run: `pnpm build` → 通过，无新增 TS/构建告警（既有 `<tr>` Vue 告警可接受，属历史问题）。
逐项执行 spec 第 10.2 节验证矩阵 #1–#16，记录结果；任何失败回到对应任务修复后重测。

- [ ] **Step 6: 更新 README 特性描述（精简一条）**

在 `README.md`「卡片化动画工作台」特性列表末尾追加一行：
`- **卡片深度自定义与实时重排（v0.68.0）**：拖拽实时四向流动重排（Esc 取消）/自由摆放辅助磁吸双模式；每卡可调主色/渐变/透明度/圆角/边框/标题栏样式，支持置顶·锁定·标签、右键菜单、复制粘贴样式与 Ctrl/Z 撤销误关。`
同时把 `package.json` 与 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的版本号由 `0.67.0` 改为 `0.68.0`（三处保持一致）。

- [ ] **Step 7: 最终提交**

```bash
git add src/App.vue src/components/CardShell.vue src/styles/global.css README.md package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "feat(workbench): v0.68.0 卡片实时重排/深度自定义/撤销 全量验收"
```

---

## Self-Review（计划对照 spec）

- 数据模型新字段（spec 三）：Task 1 ✅；setter/clamp Task 2 ✅。
- 实时重排+ghost+Esc（spec 4.1）：Task 3 ✅；自由模式辅助线/磁吸/一键整理（4.2）：Task 4 ✅；模式切换沿用既有 enable/disableFree（撤销 Task 6 覆盖）✅。
- 动画（spec 五）：Task 7（回弹/错峰/reduced-motion）✅。
- 标题栏常驻/锁钉标签（6.1）：Task 2 ✅；右键菜单+复制粘贴样式（6.2）：Task 5 ✅；两页签设置（6.3）：Task 2 ✅。
- 撤销栈（spec 七）：Task 6 ✅。
- 持久化兼容/不加 migration（spec 八）：所有新字段走现有 serialize，无新增表 ✅。
- 非目标（spec 九）：计划未引入多实例/CSS 编辑/Rust 改动/新依赖 ✅。
- 验证矩阵 1–16（spec 十）：构建每任务覆盖；矩阵项分散在 Task 2/3/4/5/6/7，Task 7 做全量回归 ✅。
- 类型/命名一致性：`cardLook/cardStyleVars/setCardLook/resetCardLook/togglePin/toggleLock/setCardTag/reorderTo/tidyFree/copyLook/pasteLook/undo/canUndo/lastClosed/alignGuides/openCfgId` 在各任务间命名一致；Task 5 的「改色」信号采用 `cfg-open-signal` props 方案（已在该任务内说明 CardShell watch 与 consumed 事件，执行者须在 Task 2 的 CardShell 基础上补充，避免跨任务悬空）。
