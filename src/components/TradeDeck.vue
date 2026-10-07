<script setup lang="ts">
// 方案 D · 交易指挥舱（B 交易场景）：账户资金条 + 主区K线 + 信号确认桥 + 逐笔/模拟持仓/自选 + Kill Switch 同屏。
// 方案 E · P0：中区/底部 5 面板改走 12×6 网格 + CardShell，可拖右下角手柄自由缩放（1..12 格步进），
// 方案 F · P1：头部拖拽 = 磁贴编排（幽灵占位 + 磁吸辅助线 + 流体让位），布局随快照自动保存。
// 账户条 / Kill Switch / 合规提示条为 Deck 语义层，不参与缩放与编排。
// 模拟先行：委托全程走本地模拟账户，真实委托需用户在券商端完成并具备相应资质；
// 本场景行情 / 票据 / 资金均为运行态数据，不构成投资建议。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import CardContent from "./CardContent.vue";
import CardShell from "./CardShell.vue";
import { useWorkbench } from "../composables/useWorkbench";
import { CARD_META } from "../lib/cards";
import type { CardId } from "../lib/cards";
import { GAP } from "../lib/layout";
import type { NamedLayout } from "../lib/scenes";
import {
  brokerGetStatus,
  brokerKillSwitch,
  brokerQueryAsset,
  brokerReleaseKill,
  type BrokerAsset,
  type BrokerStatus,
} from "../broker/api";

const props = defineProps<{ selected: string | null }>();
const emit = defineEmits<{
  select: [code: string];
  sector: [name: string, kind: string];
  menu: [p: { id: CardId; x: number; y: number }];
}>();

// 方案 E · P0：Deck 面板 = 卡片体系一员，尺寸/布局全部走工作台网格
// 方案 G · P2：Deck 渲染放开 —— 当前场景全部 openCards 中有 CARD_META 的卡（含 Deck 专属卡 signalbridge）
const bench = useWorkbench();
const DECK_PANELS: CardId[] = ["chart", "signalbridge", "trades", "trade", "watch"];
const deckCards = computed(() =>
  bench.openCards.value.filter((id) => !!CARD_META[id])
);
const deckGridStyle = computed(() => {
  const gl = bench.gridLayout.value;
  return {
    gridTemplateRows: gl.scroll
      ? `repeat(${gl.rows}, 132px)`
      : `repeat(${Math.max(6, gl.rows)}, minmax(0, 1fr))`,
  };
});
// 顶层解包：模板内直接用 deckCells[id] 取该面板的网格线样式
const deckCells = computed(() => bench.layout.value);

// ===== 方案 F · P1：磁贴编排拖拽（幽灵占位 + 磁吸辅助线）=====
const gridEl = ref<HTMLElement | null>(null);
const deckDrag = ref<{ id: CardId; col: number; row: number } | null>(null);
const deckDragActive = ref(false);
// 磁吸辅助线（px，相对 .dk-grid 内容区）：目标格左边缘竖线 / 顶边缘横线
const deckGuides = ref<{ v: number[]; h: number[] }>({ v: [], h: [] });
function clampNum(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function onDeckDrag(id: CardId, e: PointerEvent) {
  if (e.button !== 0) return;
  const grid = gridEl.value;
  if (!grid) return;
  const base = bench.gridLayout.value.posMap[id];
  if (!base) return; // 布局未落位（如场景切换瞬间）不启拖
  const st = {
    sx: e.clientX, sy: e.clientY, lastX: e.clientX, lastY: e.clientY,
    active: false, esc: false, raf: 0,
  };
  const compute = () => {
    st.raf = 0;
    const g = gridEl.value;
    if (!g) return;
    const r = g.getBoundingClientRect();
    const gl = bench.gridLayout.value;
    const size = bench.cardSpanOf(id);
    // 与 cell() 同构的换算：12 列均分 + gap 补偿；行高非滚动均分 / 滚动 132px
    const cellW = (r.width + GAP) / 12;
    const rowHpx = gl.scroll ? 132 + GAP : (r.height + GAP) / Math.max(1, gl.rows);
    const cw = size.w * cellW - GAP;
    const ch = size.h * rowHpx - GAP;
    const mx = st.lastX - r.left;
    const my = st.lastY - r.top;
    const col = clampNum(Math.round((mx - cw / 2) / cellW) + 1, 1, 12);
    const row = clampNum(Math.round((my - ch / 2) / rowHpx) + 1, 1, 60);
    deckDrag.value = { id, col, row };
    deckGuides.value = { v: [(col - 1) * cellW], h: [(row - 1) * rowHpx] };
  };
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - st.sx;
    const dy = ev.clientY - st.sy;
    if (!st.active && Math.hypot(dx, dy) < 6) return;
    if (!st.active) {
      st.active = true;
      deckDragActive.value = true;
    }
    st.lastX = ev.clientX;
    st.lastY = ev.clientY;
    if (!st.raf) st.raf = requestAnimationFrame(compute);
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") st.esc = true;
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key);
    if (st.raf) cancelAnimationFrame(st.raf);
    if (st.active && deckDrag.value && !st.esc) {
      bench.deckMoveCard(id, deckDrag.value.col, deckDrag.value.row);
    }
    deckDrag.value = null;
    deckDragActive.value = false;
    deckGuides.value = { v: [], h: [] };
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key);
}
// 幽灵占位样式（与 cell() 同构的 calc，滚动/非滚动自适应）
const ghostStyle = computed(() => {
  const d = deckDrag.value;
  if (!d) return {};
  const gl = bench.gridLayout.value;
  const size = bench.cardSpanOf(d.id);
  const top = gl.scroll
    ? `${(d.row - 1) * (132 + GAP)}px`
    : `calc(${d.row - 1} * (100% + ${GAP}px) / ${Math.max(1, gl.rows)})`;
  const height = gl.scroll
    ? `${size.h * (132 + GAP) - GAP}px`
    : `calc(${size.h} * (100% + ${GAP}px) / ${Math.max(1, gl.rows)} - ${GAP}px)`;
  return {
    left: `calc(${d.col - 1} * (100% + ${GAP}px) / 12)`,
    top,
    width: `calc(${size.w} * (100% + ${GAP}px) / 12 - ${GAP}px)`,
    height,
  };
});
async function onSaveLayout() {
  openSaveDlg();
}
function onResetLayout() {
  bench.deckResetLayout(deckCards.value);
  flash("已恢复默认布局（尺寸自定义保留）");
}

// ===== 方案 G · P2：多套布局切换 + 自定义卡片增删 =====
const deckLayoutOpen = ref(false);
const deckAddOpen = ref(false);
const layouts = ref<NamedLayout[]>([]);
const layoutBusy = ref(false);
// 保存布局弹层：支持自定义命名
const saveDlg = ref(false);
const saveName = ref("");
function openSaveDlg() {
  saveName.value = "我的场景 " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
  saveDlg.value = true;
}
async function confirmSaveLayout() {
  const name = saveName.value.trim();
  if (!name) return;
  saveDlg.value = false;
  await bench.saveNamedLayout(name);
  void loadLayouts();
  flash("布局已保存：" + name);
}
// 列表项重命名
const renameOf = ref<number | null>(null);
const renameVal = ref("");
function startRename(l: NamedLayout) {
  renameOf.value = l.id;
  renameVal.value = l.name;
}
async function confirmRename() {
  const id = renameOf.value;
  const name = renameVal.value.trim();
  if (id === null) return;
  renameOf.value = null;
  if (!name) return;
  await bench.renameNamedLayout(id, name);
  void loadLayouts();
  flash("已重命名");
}
async function loadLayouts() {
  try {
    layouts.value = await bench.listNamedLayouts();
  } catch {
    layouts.value = [];
  }
}
function toggleLayouts() {
  deckLayoutOpen.value = !deckLayoutOpen.value;
  if (deckLayoutOpen.value) {
    deckAddOpen.value = false;
    void loadLayouts();
  }
}
function toggleAddCards() {
  deckAddOpen.value = !deckAddOpen.value;
  if (deckAddOpen.value) deckLayoutOpen.value = false;
}
async function onApplyLayout(id: number) {
  if (layoutBusy.value) return;
  layoutBusy.value = true;
  try {
    const ok = await bench.applyNamedLayout(id);
    deckLayoutOpen.value = false;
    flash(ok ? "已切换到该布局" : "布局不可用");
  } finally {
    layoutBusy.value = false;
  }
}
async function onDeleteLayout(id: number) {
  await bench.deleteNamedLayout(id);
  void loadLayouts();
  flash("已删除该布局");
}
function onAddCard(id: CardId) {
  bench.open(id);
  deckAddOpen.value = false;
  flash("已添加卡片，可拖拽编排位置");
}
// 候选卡：全量卡（CARD_META 全集，含 Deck 专属卡）中未打开的部分
const candidateCards = computed(() =>
  (Object.keys(CARD_META) as CardId[]).filter((id) => !bench.openCards.value.includes(id))
);
// 点击外部收起弹层
const deckPopWrap = ref<HTMLElement | null>(null);
function onDocPointer(e: PointerEvent) {
  const t = e.target as Node;
  if (deckPopWrap.value && !deckPopWrap.value.contains(t)) {
    deckLayoutOpen.value = false;
    deckAddOpen.value = false;
  }
}

const status = ref<BrokerStatus | null>(null);
const asset = ref<BrokerAsset | null>(null);
// Kill Switch 二次确认：首次点击进入 armed 态（4s 内再次点击才真正触发）
const armed = ref(false);
const busy = ref(false);
const barMsg = ref("");
let armTimer: ReturnType<typeof setTimeout> | undefined;
let tick: ReturnType<typeof setInterval> | undefined;

const positionPct = computed(() => {
  const a = asset.value;
  if (!a || !a.totalAsset || !a.marketValue) return null;
  return Math.min(100, Math.round((a.marketValue / a.totalAsset) * 100));
});

function fmtMoney(v: number | undefined): string {
  return v === undefined
    ? "--"
    : "¥" + v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

async function refresh() {
  try {
    status.value = await brokerGetStatus();
  } catch {
    status.value = null;
  }
  try {
    asset.value = await brokerQueryAsset();
  } catch {
    asset.value = null;
  }
}

function flash(m: string) {
  barMsg.value = m;
  setTimeout(() => (barMsg.value = ""), 2600);
}

async function triggerKill() {
  if (busy.value) return;
  if (!armed.value) {
    armed.value = true;
    armTimer = setTimeout(() => (armed.value = false), 4000);
    return;
  }
  clearTimeout(armTimer);
  armed.value = false;
  busy.value = true;
  try {
    flash(await brokerKillSwitch(true));
  } catch {
    flash("触发失败：券商通道不可用");
  }
  busy.value = false;
  await refresh();
}

async function releaseKill() {
  if (busy.value) return;
  busy.value = true;
  try {
    await brokerReleaseKill();
    flash("Kill Switch 已解除");
  } catch {
    flash("解除失败");
  }
  busy.value = false;
  await refresh();
}

onMounted(() => {
  refresh();
  // 轻量轮询账户 / 开关状态（Kill Switch 状态由券商侧事件驱动，轮询兜底）
  tick = setInterval(refresh, 8000);
  window.addEventListener("pointerdown", onDocPointer);
});
onBeforeUnmount(() => {
  if (tick) clearInterval(tick);
  if (armTimer) clearTimeout(armTimer);
  window.removeEventListener("pointerdown", onDocPointer);
});
</script>

<template>
  <div class="dk">
    <!-- 账户资金条 -->
    <div class="dk-acct">
      <div class="da-cell">
        <div class="da-k">总资产</div>
        <div class="da-v">{{ fmtMoney(asset?.totalAsset) }}</div>
      </div>
      <div class="da-cell">
        <div class="da-k">可用资金</div>
        <div class="da-v">{{ fmtMoney(asset?.cash) }}</div>
      </div>
      <div class="da-cell">
        <div class="da-k">持仓市值</div>
        <div class="da-v">{{ fmtMoney(asset?.marketValue) }}</div>
      </div>
      <div class="da-cell">
        <div class="da-k">仓位占比</div>
        <div class="da-v">{{ positionPct === null ? "--" : positionPct + "%" }}</div>
      </div>
      <div class="da-status">
        <span class="da-dot" :class="{ on: status?.connected }"></span>
        {{ status?.connected ? "QMT 已连接" : "未连接" }}
        <span class="da-acct">· {{ status?.accountId || "模拟账户" }}</span>
      </div>
      <div class="da-spacer"></div>
      <Transition name="fade">
        <div v-if="barMsg" class="da-msg">{{ barMsg }}</div>
      </Transition>
      <!-- 方案 G · P2：多套布局 + 自定义卡片增删 -->
      <div ref="deckPopWrap" class="dk-pop-wrap">
        <button class="dk-act" type="button" :class="{ on: deckLayoutOpen }" @click="toggleLayouts">
          布局 ▾
        </button>
        <button class="dk-act" type="button" :class="{ on: deckAddOpen }" @click="toggleAddCards">
          + 卡片
        </button>
        <!-- 布局抽屉：切换 / 管理命名布局 -->
        <div v-if="deckLayoutOpen" class="dk-pop">
          <div class="dk-pop-head">
            <span>命名布局</span>
            <button class="dk-pop-new" type="button" @click="onSaveLayout">保存新布局…</button>
          </div>
          <div v-if="!layouts.length" class="dk-pop-empty">暂无命名布局，点「保存布局」创建一套</div>
          <div v-for="l in layouts" :key="l.id" class="dk-pop-item">
            <template v-if="renameOf === l.id">
              <input
                v-model="renameVal"
                class="dk-pop-rename"
                type="text"
                :placeholder="l.name"
                @keydown.enter.prevent="confirmRename"
                @keydown.esc="renameOf = null"
              />
              <button class="dk-pop-del" type="button" title="确认重命名" @click="confirmRename">✓</button>
            </template>
            <template v-else>
              <button class="dk-pop-name" type="button" :disabled="layoutBusy" @click="onApplyLayout(l.id)">
                {{ l.name }}
              </button>
              <button class="dk-pop-del" type="button" title="重命名" @click="startRename(l)">✎</button>
              <button class="dk-pop-del" type="button" title="删除该布局" @click="onDeleteLayout(l.id)">×</button>
            </template>
          </div>
        </div>
        <!-- 保存布局弹层：自定义命名 -->
        <div v-if="saveDlg" class="dk-pop dk-pop-save">
          <div class="dk-pop-head"><span>保存为布局</span></div>
          <input
            v-model="saveName"
            class="dk-pop-rename"
            type="text"
            placeholder="布局名称"
            @keydown.enter.prevent="confirmSaveLayout"
            @keydown.esc="saveDlg = false"
          />
          <div class="dk-pop-save-actions">
            <button class="dk-act dk-pop-ok" type="button" :disabled="!saveName.trim()" @click="confirmSaveLayout">保存</button>
            <button class="dk-act" type="button" @click="saveDlg = false">取消</button>
          </div>
        </div>
        <!-- 添加卡抽屉：全量卡中未打开的部分 -->
        <div v-if="deckAddOpen" class="dk-pop">
          <div class="dk-pop-head"><span>添加卡片</span></div>
          <div v-if="!candidateCards.length" class="dk-pop-empty">所有卡片都已打开</div>
          <div v-for="id in candidateCards" :key="id" class="dk-pop-item">
            <button class="dk-pop-name" type="button" @click="onAddCard(id)">
              {{ CARD_META[id].title }}
            </button>
          </div>
        </div>
      </div>
      <button class="dk-act" type="button" title="把当前编排保存为命名布局" @click="onSaveLayout">
        保存布局
      </button>
      <button class="dk-act" type="button" title="清除全部面板位置，回到场景出厂（尺寸自定义保留）" @click="onResetLayout">
        恢复默认布局
      </button>
      <button
        v-if="status?.killSwitch"
        class="dk-release"
        type="button"
        :disabled="busy"
        @click="releaseKill"
      >
        解除 Kill Switch
      </button>
      <button
        class="dk-kill"
        :class="{ armed }"
        type="button"
        :disabled="busy"
        @click="triggerKill"
      >
        {{ armed ? "再次点击确认触发" : "KILL SWITCH · 紧急撤单" }}
      </button>
    </div>

    <!-- Kill Switch 已触发横幅 -->
    <Transition name="fade">
      <div v-if="status?.killSwitch" class="dk-kill-banner">
        ⚠ Kill Switch 已触发 —— 所有交易通道已断开，待人工确认后解除
      </div>
    </Transition>

    <!-- 合规提示条（Deck 语义层，不参与缩放） -->
    <div class="dk-hint-bar">信号 → 人工确认 → 指令 → 券商端执行 · 系统不自动成交 · 模拟先行</div>

    <!-- 可缩放面板网格（方案 E · P0 + 方案 F · P1）：5 面板走 CardShell，拖手柄调大小、拖头部磁贴编排 -->
    <div ref="gridEl" class="dk-grid" :style="deckGridStyle">
      <div
        v-for="id in deckCards"
        :key="id"
        class="dk-slot"
        :style="deckCells[id]"
      >
        <CardShell
          :card-id="id"
          :title="CARD_META[id].title"
          :accent="CARD_META[id].accent"
          resizable
          :dragging="deckDragActive && deckDrag?.id === id"
          :focused="false"
          :collapsed="bench.isCollapsed(id)"
          :refresh="bench.cardRefreshOf(id)"
          :color="bench.cardCustom.value[id]?.color ?? ''"
          :look-vars="bench.cardStyleVars(id)"
          :look="bench.cardLook(id)"
          :locked="bench.cardLook(id).locked"
          :span="bench.cardSpanOf(id).w"
          :rspan="bench.cardSpanOf(id).h"
          :cfg-open-signal="bench.openCfgId.value === id"
          hide-focus
          @pdrag="(e: PointerEvent) => onDeckDrag(id, e)"
          @close="bench.close(id)"
          @collapse="bench.toggleCollapse(id)"
          @resize="(w: number, h: number) => bench.resizeCard(id, w, h)"
          @menu="(p) => emit('menu', { id, x: p.x, y: p.y })"
          @cfg-consumed="bench.openCfgId.value = null"
          @look="(p) => bench.setCardLook(id, p)"
          @refresh="(n: number) => bench.setCardRefresh(id, n)"
          @pin="bench.togglePin(id)"
          @lock="bench.toggleLock(id)"
          @tag="(t: string) => bench.setCardTag(id, t)"
          @resetlook="bench.resetCardLook(id)"
          @resetwidgets="bench.resetCardWidgets(id)"
        >
          <CardContent
            :id="id"
            :selected="selected"
            @select="emit('select', $event)"
            @sector="(n: string, k: string) => emit('sector', n, k)"
          />
        </CardShell>
      </div>
      <!-- 磁贴拖拽层：幽灵占位 + 磁吸辅助线（方案 F · P1） -->
      <div v-if="deckDragActive && deckDrag" class="dk-drag-ghost" :style="ghostStyle"></div>
      <div v-if="deckGuides.v.length" class="dk-guide-v" :style="{ left: deckGuides.v[0] + 'px' }"></div>
      <div v-if="deckGuides.h.length" class="dk-guide-h" :style="{ top: deckGuides.h[0] + 'px' }"></div>
    </div>
  </div>
</template>

<style scoped>
.dk {
  height: 100%;
  min-height: 520px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* ===== 账户资金条 ===== */
.dk-acct {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 26px;
  padding: 10px 16px;
  border: 1px solid var(--border, #2a3344);
  border-radius: 10px;
  background: var(--bg-panel, #15181f);
  min-height: 58px;
}
.da-cell { min-width: 0; }
.da-k { font-size: 11px; color: var(--text-dim, #7c8798); }
.da-v {
  margin-top: 2px;
  font-size: 16px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text, #e6ecf5);
}
.da-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim, #7c8798);
  white-space: nowrap;
}
.da-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4a5565;
}
.da-dot.on { background: #26d07c; box-shadow: 0 0 6px rgba(38, 208, 124, 0.6); }
.da-acct { font-size: 11px; opacity: 0.75; }
.da-spacer { flex: 1; }
.da-msg {
  font-size: 12px;
  color: #e8c96a;
  max-width: 300px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dk-release {
  flex-shrink: 0;
  height: 32px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid #3a7d5a;
  background: rgba(38, 208, 124, 0.1);
  color: #26d07c;
  font-size: 12px;
  cursor: pointer;
}
.dk-release:hover { background: rgba(38, 208, 124, 0.18); }
.dk-kill {
  flex-shrink: 0;
  height: 32px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid rgba(242, 54, 69, 0.55);
  background: rgba(242, 54, 69, 0.12);
  color: #f26a75;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.2s, transform 0.1s;
}
.dk-kill:hover { background: rgba(242, 54, 69, 0.22); }
.dk-kill.armed {
  background: #f23645;
  border-color: #f23645;
  color: #fff;
  animation: kill-pulse 0.8s ease-in-out infinite alternate;
}
.dk-kill:disabled { opacity: 0.5; cursor: not-allowed; }
@keyframes kill-pulse {
  from { box-shadow: 0 0 0 rgba(242, 54, 69, 0.2); }
  to { box-shadow: 0 0 12px rgba(242, 54, 69, 0.75); }
}
.dk-kill-banner {
  flex-shrink: 0;
  padding: 7px 14px;
  border-radius: 8px;
  border: 1px solid rgba(242, 54, 69, 0.6);
  background: rgba(242, 54, 69, 0.16);
  color: #ff8a93;
  font-size: 12px;
  font-weight: 600;
}

/* ===== 合规提示条 + 可缩放面板网格（方案 E · P0 / 方案 F · P1） ===== */
.dk-hint-bar {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-dim, #7c8798);
  padding: 0 4px;
}
.dk-grid {
  position: relative; /* 拖拽幽灵/磁吸线的包含块 */
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 10px;
  overflow: auto;
}
.dk-slot {
  min-width: 0;
  min-height: 0;
  position: relative;
}
.dk-slot > :deep(.card-shell) {
  height: 100%;
}
.dk-act {
  flex-shrink: 0;
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--border, #2a3344);
  background: var(--bg-panel, #15181f);
  color: var(--text-dim, #7c8798);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.dk-act:hover,
.dk-act.on {
  color: var(--text, #e6ecf5);
  border-color: #e8c878;
}
/* 方案 G · P2：布局 / 添加卡抽屉 */
.dk-pop-wrap {
  position: relative;
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.dk-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 60;
  min-width: 260px;
  max-height: 300px;
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--border, #2a3344);
  border-radius: 10px;
  background: var(--bg-panel, #15181f);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.dk-pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px 8px;
  font-size: 12px;
  color: var(--text-dim, #7c8798);
  border-bottom: 1px solid var(--border, #222a38);
  margin-bottom: 4px;
}
.dk-pop-new {
  border: 0;
  background: none;
  color: #e8c878;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
}
.dk-pop-new:hover {
  text-decoration: underline;
}
.dk-pop-empty {
  padding: 14px 8px;
  font-size: 12px;
  color: var(--text-dim, #7c8798);
  text-align: center;
}
.dk-pop-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
.dk-pop-name {
  flex: 1;
  min-width: 0;
  text-align: left;
  border: 0;
  background: none;
  color: var(--text, #e6ecf5);
  font-size: 13px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dk-pop-name:hover {
  background: rgba(232, 200, 120, 0.12);
  color: #e8c878;
}
.dk-pop-del {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--text-dim, #7c8798);
  cursor: pointer;
  font-size: 14px;
}
.dk-pop-del:hover {
  color: #e8787c;
  background: rgba(232, 120, 124, 0.12);
}
/* 保存弹层 / 重命名输入 */
.dk-pop-rename {
  width: 100%;
  box-sizing: border-box;
  height: 30px;
  padding: 0 10px;
  margin: 2px 0;
  border-radius: 6px;
  border: 1px solid var(--border, #2a3344);
  background: var(--bg-deep, #0d1016);
  color: var(--text, #e6ecf5);
  font-size: 13px;
  outline: none;
}
.dk-pop-rename:focus {
  border-color: #e8c878;
}
.dk-pop-save {
  min-width: 240px;
}
.dk-pop-save-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 8px;
}
.dk-pop-ok {
  border-color: #e8c878;
  color: #e8c878;
}
/* 磁贴拖拽层：幽灵占位 + 磁吸辅助线 */
.dk-drag-ghost {
  position: absolute;
  z-index: 30;
  pointer-events: none;
  border: 1.5px dashed rgba(232, 200, 120, 0.85);
  border-radius: 10px;
  background: rgba(232, 200, 120, 0.1);
  box-shadow: 0 0 0 1px rgba(232, 200, 120, 0.25);
}
.dk-guide-v,
.dk-guide-h {
  position: absolute;
  z-index: 29;
  pointer-events: none;
  border: 0 dashed rgba(232, 200, 120, 0.65);
}
.dk-guide-v {
  top: 0;
  bottom: 0;
  border-left-width: 1px;
}
.dk-guide-h {
  left: 0;
  right: 0;
  border-top-width: 1px;
}

.fade-enter-active,
.fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from,
.fade-leave-to { opacity: 0; }
</style>
