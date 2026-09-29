<script setup lang="ts">
// 画中岛弹窗根组件：无边框置顶小窗，只读展示。
// 自加载（ensureDb → wl.load → quotes 轮询，同 Island 范式）；
// widgets 来自 meta(workbench_current)，并由主窗 pip:sync 事件实时更新。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { ensureDb, db } from "../../db/database";
import { useQuotesStore } from "../../stores/quotes";
import { useWatchlistStore } from "../../stores/watchlist";
import {
  createRootMarketContext,
  provideMarketContext,
} from "../../composables/useMarketContext";
import { provideWidgetSource } from "../../composables/useWidgetSource";
import { migrateSnapshot } from "../../lib/widget-migrate";
import { CARD_META } from "../../lib/cards";
import {
  parsePipLabel,
  upsertGeometry,
  type PipGeometry,
} from "../../lib/pip";
import type { CardId } from "../../lib/cards";
import type { CardWidgets } from "../../lib/widgets";
import WidgetCanvas from "../widgets/WidgetCanvas.vue";
import WidgetShell from "../widgets/WidgetShell.vue";
import { widgetDefOf } from "../widgets/registry";

const win = getCurrentWindow();
const target = parsePipLabel(win.label);

const wl = useWatchlistStore();
const quotes = useQuotesStore();

// 本卡微件布局（弹窗内只读）
const widgetsRef = ref<CardWidgets | null>(null);
const ready = ref(false);

const cardId = computed<CardId | null>(() => target?.cardId ?? null);

// 单微件目标实例
const widgetInst = computed(() => {
  if (target?.kind !== "widget" || !widgetsRef.value) return null;
  return widgetsRef.value.items.find((i) => i.id === target.widgetId) ?? null;
});

// 主标的：整卡=卡主绑定；单微件=微件 bind ?? 卡主
const primaryCode = computed(() => {
  if (!widgetsRef.value) return null;
  if (target?.kind === "widget") {
    const inst = widgetsRef.value.items.find((i) => i.id === target.widgetId);
    return inst?.bind ?? widgetsRef.value.primary ?? null;
  }
  return widgetsRef.value.primary ?? null;
});

const titleText = computed(() => {
  if (!target) return "画中岛";
  const cardTitle = CARD_META[target.cardId]?.title ?? target.cardId;
  if (target.kind === "card") return cardTitle;
  const defTitle = widgetDefOf(widgetInst.value?.def ?? "")?.title ?? "微件";
  return `${cardTitle} · ${defTitle}`;
});

// 只读微件源：供卡内 WidgetCanvas inject
provideWidgetSource({
  widgetsOf(id) {
    return id === cardId.value ? widgetsRef.value ?? undefined : undefined;
  },
});

const rootMarket = createRootMarketContext({
  primaryCode,
  // 只读弹窗：行情列表点选只通知主窗，不在弹窗内切换
  onSelect: (code) => emit("pip:select", code),
});
provideMarketContext(rootMarket);

// ===== 单微件铺满窗口的 stride（w*stride-gap = 容器尺寸）=====
const wrapEl = ref<HTMLElement | null>(null);
const wrapW = ref(0);
const wrapH = ref(0);
let ro: ResizeObserver | null = null;
const GAP = 8;
const strideW = computed(() =>
  widgetInst.value ? (wrapW.value + GAP) / widgetInst.value.w : 0
);
const strideH = computed(() =>
  widgetInst.value ? (wrapH.value + GAP) / widgetInst.value.h : 0
);
// 单微件渲染实例：定位到 0,0
const displayInst = computed(() =>
  widgetInst.value ? { ...widgetInst.value, x: 0, y: 0 } : null
);

// ===== 几何持久化：move/resize 400ms 防抖写回 meta(pip_geometry) =====
let geoTimer: number | null = null;
let geoRaw: string | null = null;
async function saveGeometry() {
  const pos = await win.outerPosition();
  const size = await win.outerSize();
  const scale = await win.scaleFactor();
  const g: PipGeometry = {
    x: pos.x / scale,
    y: pos.y / scale,
    w: size.width / scale,
    h: size.height / scale,
  };
  geoRaw = upsertGeometry(geoRaw, win.label, g);
  await db().execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [
    "pip_geometry",
    geoRaw,
  ]);
}
function scheduleGeometry() {
  if (geoTimer) clearTimeout(geoTimer);
  geoTimer = window.setTimeout(saveGeometry, 400);
}

let unlistenMove: (() => void) | null = null;
let unlistenResize: (() => void) | null = null;
let unlistenSync: (() => void) | null = null;

// 置顶切换
const pinned = ref(true);
async function togglePin() {
  const next = !pinned.value;
  await invoke("pip_set_always_on_top", { label: win.label, on: next });
  pinned.value = next;
}

async function closeWindow() {
  emit("pip:closed", { label: win.label });
  await win.close();
}

function measure() {
  const el = wrapEl.value;
  if (!el) return;
  wrapW.value = el.clientWidth;
  wrapH.value = el.clientHeight;
}

onMounted(async () => {
  if (!target || !cardId.value) return;
  await ensureDb();

  // 取已存几何 raw（供后续 upsert 合并）
  const geoRows = await db().select<{ value: string }[]>(
    "SELECT value FROM meta WHERE key='pip_geometry'"
  );
  geoRaw = geoRows[0]?.value ?? null;

  // 从主窗快照取本卡 widgets
  await wl.load();
  const rows = await db().select<{ value: string }[]>(
    "SELECT value FROM meta WHERE key='workbench_current'"
  );
  try {
    const rawCards = JSON.parse(rows[0]?.value ?? "[]");
    const { cards } = migrateSnapshot(rawCards);
    widgetsRef.value =
      cards.find((c) => c.id === cardId.value)?.widgets ?? null;
  } catch {
    widgetsRef.value = null;
  }

  quotes.start(2000);
  ready.value = true;

  // 主窗编排/绑定变更：实时覆盖本卡只读布局
  unlistenSync = await listen<{ cardId: CardId; widgets: CardWidgets }>(
    "pip:sync",
    (ev) => {
      if (ev.payload.cardId === cardId.value) widgetsRef.value = ev.payload.widgets;
    }
  );

  // 单微件容器测量
  if (target.kind === "widget") {
    measure();
    if (wrapEl.value) {
      ro = new ResizeObserver(measure);
      ro.observe(wrapEl.value);
    }
  }

  unlistenMove = await listen("tauri://move", scheduleGeometry);
  unlistenResize = await listen("tauri://resize", scheduleGeometry);
});

onBeforeUnmount(() => {
  if (geoTimer) clearTimeout(geoTimer);
  unlistenMove?.();
  unlistenResize?.();
  unlistenSync?.();
  ro?.disconnect();
});

</script>

<template>
  <div v-if="target" class="pip-root">
    <div class="pip-bar" data-tauri-drag-region>
      <span class="pip-dot"></span>
      <span class="pip-title" data-tauri-drag-region>{{ titleText }}</span>
      <span class="pip-spacer"></span>
      <button
        type="button"
        class="pip-btn"
        :class="{ on: pinned }"
        :title="pinned ? '取消置顶' : '置顶'"
        @click.stop="togglePin"
      >📌</button>
      <button type="button" class="pip-btn x" title="关闭画中岛" @click.stop="closeWindow">×</button>
    </div>

    <div ref="wrapEl" class="pip-body">
      <template v-if="ready">
        <!-- 整卡：复用卡内画布（只读源已注入） -->
        <WidgetCanvas
          v-if="target.kind === 'card'"
          :id="target.cardId"
          :editing="false"
        />
        <!-- 单微件：外壳铺满窗口 -->
        <WidgetShell
          v-else-if="displayInst"
          :inst="displayInst"
          :editing="false"
          :stride-w="strideW"
          :stride-h="strideH"
          :gap="GAP"
        />
        <div v-else class="pip-empty">微件不存在（可能已被移除）</div>
      </template>
      <div v-else class="pip-empty">加载中…</div>
    </div>
  </div>
</template>

<style>
html,
body,
#app {
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
}
</style>

<style scoped>
.pip-root {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel, #14161c);
  border: 1px solid var(--border, #2a2f3a);
  border-radius: 10px;
  overflow: hidden;
}
.pip-bar {
  height: 30px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 8px;
  background: var(--bg-elevated, #1a1d24);
  border-bottom: 1px solid var(--border, #2a2f3a);
  user-select: none;
}
.pip-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent, #e8c878); flex-shrink: 0;
}
.pip-title { font-size: 11px; font-weight: 600; color: var(--text, #e6edf3);
  max-width: 60%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pip-spacer { flex: 1; }
.pip-btn { width: 22px; height: 22px; border: 0; background: transparent;
  color: var(--text-dim, #8b98a5); font-size: 11px; border-radius: 5px;
  cursor: pointer; line-height: 1; padding: 0; }
.pip-btn:hover { background: var(--bg-hover, rgba(255,255,255,.07)); color: var(--text, #e6edf3); }
.pip-btn.on { color: var(--accent, #e8c878); }
.pip-btn.x { font-size: 15px; }
.pip-btn.x:hover { color: #ff6b78; }
.pip-body { flex: 1; position: relative; min-height: 0; }
.pip-empty { position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; color: var(--text-dim, #8b98a5); font-size: 11px; }
</style>
