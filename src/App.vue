<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, provide, watch, nextTick } from "vue";
import { listen } from "@tauri-apps/api/event";
import CardShell from "./components/CardShell.vue";
import CardContextMenu from "./components/CardContextMenu.vue";
import CardContent from "./components/CardContent.vue";
import UpdateDialog from "./components/UpdateDialog.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import ShortcutDialog from "./components/ShortcutDialog.vue";
import OnboardingDialog from "./components/OnboardingDialog.vue";
import LayoutMenu from "./components/LayoutMenu.vue";
import ShortTermSpider from "./components/ShortTermSpider.vue";
import LimitRadar from "./components/LimitRadar.vue";
import WatchList from "./components/WatchList.vue";
import Indices from "./components/Indices.vue";
import RankBoard from "./components/RankBoard.vue";
import RightPanel from "./components/RightPanel.vue";
import FundFlow from "./components/FundFlow.vue";
import AlertCenter from "./components/AlertCenter.vue";
import SectorBoard from "./components/SectorBoard.vue";
import SectorHeatmap from "./components/SectorHeatmap.vue";
import SectorEvents from "./components/SectorEvents.vue";
import Screener from "./components/Screener.vue";
import F10Card from "./components/F10Card.vue";
import PaperTrade from "./components/PaperTrade.vue";
import Journal from "./components/Journal.vue";
import EcoCalendar from "./components/EcoCalendar.vue";
import IpoCalendar from "./components/IpoCalendar.vue";
import SearchBox from "./components/SearchBox.vue";
import StockChart from "./components/StockChart.vue";
import TimeTabs from "./components/TimeTabs.vue";
import DistBoard from "./components/DistBoard.vue";
import NewsFlash from "./components/NewsFlash.vue";
import WelcomeBoard from "./components/WelcomeBoard.vue";
import { useWatchlistStore } from "./stores/watchlist";
import { useQuotesStore } from "./stores/quotes";
import { useAlertStore } from "./stores/alert";
import { useWorkbench, CARD_META, SCENES, currentTimeSlot, type CardId } from "./composables/useWorkbench";
import { useTheme } from "./composables/useTheme";
import { useAccessibility } from "./composables/useAccessibility";
import { useMotion } from "./composables/useMotion";
import { useSkins } from "./composables/useSkins";
import { useWindowControls } from "./composables/useWindowControls";
import { useCardFocus } from "./composables/useCardFocus";
import { useCardMount } from "./composables/useCardMount";
import { createRootMarketContext, provideMarketContext } from "./composables/useMarketContext";
import { usePip } from "./composables/usePip";
import WidgetCanvas from "./components/widgets/WidgetCanvas.vue";
import { useCommandPalette } from "./composables/useCommandPalette";
import { useActions } from "./composables/useActions";
import { useBuiltinActions } from "./composables/useBuiltinActions";
import type { AlertEvent } from "./api/market";
import { bootstrapAlerts } from "./composables/useAlertBootstrap";
import { ensureDb, db } from "./db/database";
import AlertToast from "./components/alert/AlertToast.vue";
import { startTimeSeries } from "./composables/useTimeSeries";
import { startCollector } from "./composables/useCollector";
import { playAlert } from "./utils/sound";
import { DOCK_GROUPS } from "./lib/dock";
import type { DockGroup, DockItem } from "./lib/dock";

const wl = useWatchlistStore();
const quotes = useQuotesStore();
const alerts = useAlertStore();
const bench = useWorkbench();
const theme = useTheme();
const a11y = useAccessibility();
const motion = useMotion();
const skins = useSkins();
// 卡片按需挂载：未进入可视区的卡片延迟初始化内部内容（图表/轮询）
const cardMount = useCardMount();
provide("workbench", bench);

// 画中岛：开窗状态管理 + 主窗微件变更实时同步到弹窗
const pip = usePip(bench, { onSelect: (code) => pickStock(code) });
watch(
  () => bench.cardWidgets,
  () => {
    Object.keys(bench.cardWidgets).forEach((cid) =>
      pip.syncCard(cid as CardId)
    );
  },
  { deep: true }
);

// 自绘标题栏窗口控制
const {
  curVersion,
  isMac,
  isWin,
  isMax,
  initPlatform,
  winMinimize,
  winToggleMax,
  winClose,
} = useWindowControls();

// 卡片聚焦 / FLIP 共享元素
const {
  focusTargetEl,
  focusClosing,
  overlayShow,
  railCards,
  enterFocus,
  switchFocus,
  exitFocus,
  addAndFocus,
  refitFocus,
} = useCardFocus(bench);

const selected = ref<string | null>(null);

// 全局行情上下文层：微件总线的根层（卡级层在 WidgetCanvas 内覆盖）
const rootMarket = createRootMarketContext({
  primaryCode: selected,
  onSelect: (code) => pickStock(code),
});
provideMarketContext(rootMarket);

// 自由布局画布 DOM（同步给布局引擎，用于指针拖拽换算）
const freeCanvasEl = ref<HTMLElement | null>(null);
watch(freeCanvasEl, (el) => {
  // ref 绑在 TransitionGroup 上，拿到的是组件实例，需取其根 DOM($el)
  bench.freeCanvasRef.value = ((el as any)?.$el as HTMLElement) ?? (el as unknown as HTMLElement);
});

// ===== 分区列表（落点指示用）=====
const mainList = computed(() =>
  bench.openCards.value.filter((i) => bench.zoneOf(i) === "main")
);
const sideList = computed(() =>
  bench.openCards.value.filter((i) => bench.zoneOf(i) === "side")
);
// 某张卡片当前的落点位置：before / after（用于显示插入线）
function dropPos(id: CardId): "before" | "after" | null {
  const h = bench.dropHint.value;
  if (!h || bench.dragId.value === id) return null;
  const list = h.zone === "main" ? mainList.value : sideList.value;
  if (list[h.index] === id) return "before";
  if (h.index === list.length && list[list.length - 1] === id) return "after";
  return null;
}
// ===== 卡片右键菜单 =====
const ctxMenu = ref<{ id: CardId; x: number; y: number } | null>(null);
function onCardMenu(id: CardId, p: { x: number; y: number }) {
  const W = 170, H = 280;
  ctxMenu.value = {
    id,
    x: Math.min(p.x, window.innerWidth - W - 8),
    y: Math.min(p.y, window.innerHeight - H - 8),
  };
}
function onCtxAction(a: string) {
  const id = ctxMenu.value?.id;
  if (!id) return;
  if (a === "focus") { bench.focusId.value === id ? exitFocus() : enterFocus(id); }
  else if (a === "collapse") bench.toggleCollapse(id);
  else if (a === "pin") bench.togglePin(id);
  else if (a === "lock") bench.toggleLock(id);
  else if (a === "copy") bench.copyLook(id);
  else if (a === "paste") bench.pasteLook(id);
  else if (a === "color") bench.openCfgId.value = id;
  else if (a === "tag") {
    const t = prompt("标签（最多4字）", bench.cardLook(id).tag);
    if (t !== null) bench.setCardTag(id, t);
  } else if (a === "close") bench.close(id);
  ctxMenu.value = null;
}

// ===== 关闭卡片 toast（5s 自动消失）=====
const undoToast = ref(false);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => bench.lastClosed.value,
  (v) => {
    if (!v) return;
    undoToast.value = true;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      undoToast.value = false;
      bench.lastClosed.value = null;
    }, 5000);
  }
);

// 在网格空白区拖动：按列位置归到主干 / 侧栏分区末尾
function onGridDragOver(e: DragEvent) {
  e.preventDefault();
  const t = e.target as HTMLElement;
  if (typeof t.closest === "function") {
    // 悬停在卡片上时，卡片自身已给出精确落点，不要覆盖成"区末尾"
    if (t.closest(".card-shell")) return;
    if (t.closest(".card-head")) return;
  }
  const grid = e.currentTarget as HTMLElement;
  const r = grid.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  bench.hintZone(x < 7 / 12 ? "main" : "side");
}

// ===== 网格滚动模式：卡片超过 6 行时改用固定行高 =====
const cardGridStyle = computed<Record<string, string>>(() => {
  const gl = bench.gridLayout.value;
  return { gridTemplateRows: !gl.time && gl.scroll ? `repeat(${gl.rows}, 132px)` : "" };
});

// ===== Mega 菜单：悬停分类 → 展开多列面板 =====
const megaKey = ref<string | null>(null);
const megaGroup = computed<DockGroup | null>(
  () => DOCK_GROUPS.find((g) => g.name === megaKey.value) ?? null
);
function megaOpen(g: DockGroup) {
  megaKey.value = g.name;
}
function megaClose() {
  megaKey.value = null;
}
function pickMega(it: DockItem) {
  toggleCard(it.id);
  megaKey.value = null;
}

// ===== 对话框状态 =====
const showUpdate = ref(false);
const showSettings = ref(false);
const showShortcuts = ref(false);
const showOnboarding = ref(false);

// 统一卡片开关：聚焦态打开新卡 → 直接作为主卡（addAndFocus）
function toggleCard(id: CardId) {
  if (bench.isOpen(id)) {
    bench.close(id);
    return;
  }
  if (bench.isFocused.value) addAndFocus(id);
  else bench.open(id);
}

// ===== 命令面板（Ctrl / ⌘ + K）=====
const {
  paletteOpen,
  paletteQuery,
  pSel,
  pInput,
  pFiltered,
  openPalette,
  closePalette,
  runPalette,
} = useCommandPalette();

// 注册内置动作（开卡 / 场景 / 窗口），命令面板与快捷键共用
useBuiltinActions({
  toggleCard,
  applyScene: bench.applyScene,
  winMinimize,
  winToggleMax,
  winClose,
});

// 全局动作注册：快捷键派发由 useActions 统一处理（支持自定义绑定与编辑态过滤）
const { register: registerAction } = useActions();
registerAction({
  id: "app.palette", title: "命令面板", category: "应用", defaultKeys: "Ctrl+K", editingSafe: true,
  run: () => (paletteOpen.value ? closePalette() : openPalette()),
});
registerAction({
  id: "app.settings", title: "设置", category: "应用", defaultKeys: "Ctrl+,", editingSafe: true,
  run: () => (showSettings.value = true),
});
registerAction({
  id: "app.update", title: "检查更新", category: "应用", defaultKeys: "Ctrl+U", editingSafe: true,
  run: () => (showUpdate.value = true),
});
registerAction({
  id: "app.shortcuts", title: "快捷键速查", category: "应用", defaultKeys: "Ctrl+/", editingSafe: true,
  run: () => (showShortcuts.value = true),
});
registerAction({
  id: "app.shortcuts-qm", title: "快捷键速查", category: "应用", defaultKeys: "?", hidden: true,
  run: () => (showShortcuts.value = true),
});
registerAction({
  id: "bench.undo", title: "撤销结构操作", category: "工作台", defaultKeys: "Ctrl+Z",
  run: () => { bench.undo(); undoToast.value = false; },
});
registerAction({
  id: "focus.exit", title: "退出聚焦", category: "盯盘", defaultKeys: "Escape", editingSafe: true,
  hidden: true, when: () => bench.isFocused.value, run: exitFocus,
});

// 命令面板内部导航（仅面板打开时生效）
function onPaletteKey(e: KeyboardEvent) {
  if (!paletteOpen.value) return;
  const n = pFiltered.value.length;
  if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    pSel.value = Math.min(pSel.value + 1, n - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    pSel.value = Math.max(pSel.value - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    runPalette();
  }
}

// ===== 联动：选中股票 → K线进入主干聚焦大区域（非弹窗） =====
function pickStock(code: string, name?: string) {
  selected.value = code;
  if (name && !wl.codes.includes(code)) wl.add(code, name);
  if (bench.isOpen("chart")) {
    if (bench.isFocused.value) {
      if (bench.focusId.value !== "chart") switchFocus("chart");
    } else {
      enterFocus("chart");
    }
  } else {
    bench.open("chart");
    nextTick(() => enterFocus("chart"));
  }
}
function onSelect(code: string) {
  pickStock(code);
}
function onSearchSelect(code: string, name: string) {
  pickStock(code, name);
}

const unlistenFns: (() => void)[] = [];

onMounted(async () => {
  // —— 平台、版本与窗口最大化状态 ——
  await initPlatform();

  // —— 基础数据（各自独立容错，互不影响）——
  try { await ensureDb(); } catch (e) { console.error("[app] db", e); }
  // —— 本地时序采集（情绪/指数/板块，盘中分时+收盘日级，常驻后台）——
  try { await startTimeSeries(); } catch (e) { console.error("[app] timeseries", e); }
  // —— 题材采集调度器（盘中 20 分钟催化增量 + 盘后归因；内部防重入/同日幂等）——
  try { startCollector(); } catch (e) { console.error("[app] collector", e); }
  try { await theme.load(); } catch (e) { console.error("[app] theme", e); }
  try { await a11y.load(); } catch (e) { console.error("[app] a11y", e); }
  try { await motion.load(); } catch (e) { console.error("[app] motion", e); }
  try {
    const obRows = await db().select<{ value: string }[]>("SELECT value FROM meta WHERE key=?", ["onboarding_done"]);
    if (obRows[0]?.value !== "1") showOnboarding.value = true;
  } catch (e) { console.error("[app] onboarding", e); }
  try { await wl.load(); } catch (e) { console.error("[app] watchlist", e); }
  try { await alerts.load(); } catch (e) { console.error("[app] alerts", e); }

  // —— 行情轮询：盯盘核心，自选加载后立即启动，不被后续任何步骤拖累 ——
  quotes.start(2000);

  // —— 卡片皮肤（内置 seed / 恢复 app_skin），需在布局恢复前 ——
  try { await skins.load(); } catch (e) { console.error("[app] skins", e); }

  // —— 布局恢复（容错）——
  try {
    const restored = await bench.restoreCurrent();
    if (!restored) {
      bench.enterTimeMode(currentTimeSlot());
    }
  } catch (e) {
    console.error("[app] restore layout", e);
  }
  if (wl.codes.length) {
    selected.value = wl.codes[0];
  }

  // —— 预警引擎：停用旧 Rust 引擎，启动 v0.71 TypeScript 条件树引擎 ——
  await bootstrapAlerts({
    pickStock,
    openScreener: () => {
      if (!bench.isOpen("screener")) bench.open("screener");
    },
  });

  // —— 命令面板内部导航（全局快捷键由 useActions 派发）——
  window.addEventListener("keydown", onPaletteKey);

  // —— 事件监听 ——
  try {
    unlistenFns.push(
      await listen<string>("island:select", (e) => {
        const c = e.payload;
        if (!wl.codes.includes(c)) wl.add(c);
        pickStock(c);
      })
    );
    // 预警触发：写历史 + 系统通知 + 声音 + 记录触发时间
    unlistenFns.push(
      await listen<AlertEvent>("alert:triggered", (e) => {
        const ev = e.payload;
        alerts.markFired(ev.id, ev.time);
        void alerts.addEvent(ev);
        try {
          if ("Notification" in window && Notification.permission === "granted") {
            new Notification(`预警 · ${ev.label}`, { body: ev.message });
          }
        } catch {
          /* ignore */
        }
        try {
          if (localStorage.getItem("tickgold_alert_sound") !== "0") {
            playAlert(ev.tone);
          }
        } catch {
          /* ignore */
        }
      })
    );
  } catch (e) {
    console.error("[app] listeners", e);
  }
});
onBeforeUnmount(() => {
  unlistenFns.forEach((f) => f());
  window.removeEventListener("keydown", onPaletteKey);
});
</script>

<template>
  <div class="app">
    <!-- 顶栏 -->
    <header class="topbar" :class="{ mac: isMac }" data-tauri-drag-region>
      <div class="brand" data-tauri-drag-region>TickGold</div>
      <SearchBox @select="onSearchSelect" />
      <div class="status">
        <span :class="quotes.polling ? 'dot on' : 'dot'"></span>
        {{ quotes.polling ? "实时" : "已暂停" }}
        <span class="sep">|</span>
        {{ Object.keys(quotes.map).length }} 只
        <span class="sep">|</span>
        {{ quotes.lastUpdate ? new Date(quotes.lastUpdate).toLocaleTimeString() : "--:--:--" }}
        <span class="sep">|</span>
        <span class="ver">v{{ curVersion }}</span>
        <span class="sep">|</span>
        <LayoutMenu />
        <span class="sep">|</span>
        <button class="upd" @click="showSettings = true">设置</button>
        <span class="sep">|</span>
        <button class="upd" @click="showUpdate = true">检查更新</button>
      </div>
      <!-- Windows 自绘窗口控制（macOS 使用原生红绿灯） -->
      <div v-if="isWin" class="win-ctl" data-tauri-drag-region="false">
        <button
          class="wc-btn"
          type="button"
          data-tauri-drag-region="false"
          title="最小化"
          @mousedown.stop
          @click="winMinimize"
        >
          <svg viewBox="0 0 12 12"><path d="M2 6h8" stroke="currentColor" stroke-width="1" /></svg>
        </button>
        <button
          class="wc-btn"
          type="button"
          data-tauri-drag-region="false"
          :title="isMax ? '向下还原' : '最大化'"
          @mousedown.stop
          @click="winToggleMax"
        >
          <svg v-if="!isMax" viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1" /></svg>
          <svg v-else viewBox="0 0 12 12"><rect x="3.4" y="4.4" width="5.2" height="5" fill="none" stroke="currentColor" stroke-width="1" /><path d="M4.4 4.4V3h4.6v4.6H7.6" fill="none" stroke="currentColor" stroke-width="1" /></svg>
        </button>
        <button
          class="wc-btn close"
          type="button"
          data-tauri-drag-region="false"
          title="关闭"
          @mousedown.stop
          @click="winClose"
        >
          <svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1" /></svg>
        </button>
      </div>
    </header>

    <!-- 指数条 -->
    <Indices class="idx-row" />

    <!-- Mega 功能导航：分类标签 + 悬停展开面板 -->
    <div class="mega-nav" @mouseleave="megaClose()">
      <div class="mega-tabs">
        <button
          v-for="g in DOCK_GROUPS"
          :key="g.name"
          type="button"
          class="mega-tab"
          :class="{ on: megaKey === g.name }"
          @mouseenter="megaOpen(g)"
          @focus="megaOpen(g)"
        >
          <svg viewBox="0 0 24 24" class="mt-ic"><path fill="currentColor" :d="g.icon" /></svg>
          <span>{{ g.name }}</span>
        </button>

        <div class="mega-right">
          <button class="palette-btn" type="button" @click="openPalette">
            <svg viewBox="0 0 24 24" class="pb-ic"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 10-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1114 9.5 4.5 4.5 0 019.5 14z" /></svg>
            <span class="pb-tx">命令</span>
            <kbd class="pb-k">Ctrl K</kbd>
          </button>
        </div>
      </div>

      <Transition name="mpanel">
        <div v-if="megaGroup" class="mega-panel" :key="megaGroup.name">
          <div class="mp-head">
            <h3>{{ megaGroup.name }}</h3>
            <span>{{ megaGroup.items.length }} 个功能 · 点击打开卡片</span>
          </div>
          <div class="mp-grid">
            <button
              v-for="it in megaGroup.items"
              :key="it.id"
              type="button"
              class="mp-item"
              :class="{ on: bench.isOpen(it.id) }"
              @click="pickMega(it)"
            >
              <span class="mpi-ic">
                <svg viewBox="0 0 24 24"><path fill="currentColor" :d="it.icon" /></svg>
              </span>
              <span class="mpi-t">{{ it.label }}</span>
              <span class="mpi-d">{{ it.desc }}</span>
              <svg v-if="it.star" class="mpi-star" viewBox="0 0 24 24"><path fill="currentColor" d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>
            </button>
          </div>
        </div>
      </Transition>
    </div>

    <!-- 工作台主区域 -->
    <main
      class="workspace"
      :class="{ dragging: bench.dragId.value !== null, bare: bench.openCards.value.length === 0 }"
    >
      <!-- 空台沉浸背景：铺满整个 workspace（含时段栏后方），与时段栏融为一体 -->
      <Transition name="welcome">
        <WelcomeBoard v-if="bench.openCards.value.length === 0" />
      </Transition>
      <!-- 场景模板栏：一键切换盯盘布局（V3 亮点） -->
      <div class="scene-bar">
        <span class="scene-label">场景模板</span>
        <button
          v-for="sc in SCENES"
          :key="sc.id"
          type="button"
          class="scene-chip"
          :class="{ on: bench.sceneId.value === sc.id }"
          @click="bench.applyScene(sc)"
        >
          <svg viewBox="0 0 24 24"><path fill="currentColor" :d="sc.icon" /></svg>
          <span>{{ sc.label }}</span>
        </button>
      </div>
      <!-- 时段切换栏（透明沉浸，无浮条边框） -->
      <TimeTabs :active="bench.timeMode.value" @select="bench.enterTimeMode($event)" />

      <div class="ws-body" :class="{ free: bench.freeMode.value }">

      <!-- ===== 自由布局：卡片绝对定位、可随意拖拽 ===== -->
      <template v-if="bench.freeMode.value">
        <div class="free-toolbar">
          <span class="ft-hint">自由布局：按住卡片标题栏拖动，靠近其它卡边缘自动磁吸对齐；布局已自动保存</span>
          <button class="ft-btn" @click="bench.tidyFree()">一键整理</button>
          <button class="ft-btn" @click="bench.disableFree()">恢复自动布局</button>
        </div>
        <TransitionGroup
          tag="div"
          class="free-canvas"
          ref="freeCanvasEl"
          enter-active-class="card-enter"
          leave-active-class="free-leave"
          :style="{ height: bench.freeHeight.value + 'px' }"
        >
          <div
            v-for="(x, i) in bench.alignGuides.value.v"
            :key="'av' + i"
            class="align-v"
            :style="{ left: x + 'px' }"
          ></div>
          <div
            v-for="(y, i) in bench.alignGuides.value.h"
            :key="'ah' + i"
            class="align-h"
            :style="{ top: y + 'px' }"
          ></div>
          <div
            v-for="id in bench.openCards.value"
            :key="id"
            class="free-cell"
            :data-card-id="id"
            :ref="(el: any) => cardMount.observeSlot(el, id)"
            :class="{ dragging: bench.freeDrag.value?.id === id, 'snap-spring': bench.snapPulse.value === id }"
            :style="bench.freeCellStyle(id)"
          >
            <CardShell
              v-if="cardMount.isMounted(id)"
              :card-id="id"
              :title="CARD_META[id].title"
              :accent="CARD_META[id].accent"
              free-drag
              :focused="bench.focusId.value === id"
              :collapsed="bench.isCollapsed(id)"
              :refresh="bench.cardRefreshOf(id)"
              :color="bench.cardCustom.value[id]?.color ?? ''"
              :look-vars="bench.cardStyleVars(id)"
              :look="bench.cardLook(id)"
              :cfg-open-signal="bench.openCfgId.value === id"
              :popoutable="bench.isWidgetCard(id)"
              :popout-on="pip.isOpen({ kind: 'card', cardId: id })"
              @close="bench.close(id)"
              @focus="enterFocus(id)"
              @restore="exitFocus"
              @grab="(e: PointerEvent) => bench.startFreeDrag(e, id)"
              @menu="(p) => onCardMenu(id, p)"
              @cfg-consumed="bench.openCfgId.value = null"
              @collapse="bench.toggleCollapse(id)"
              @color="(c: string) => bench.setCardColor(id, c)"
              @refresh="(n: number) => bench.setCardRefresh(id, n)"
              @look="(p) => bench.setCardLook(id, p)"
              @pin="bench.togglePin(id)"
              @lock="bench.toggleLock(id)"
              @tag="(t: string) => bench.setCardTag(id, t)"
              @resetlook="bench.resetCardLook(id)"
              @resetwidgets="bench.resetCardWidgets(id)"
              @popout="pip.openPip({ kind: 'card', cardId: id })"
            >
              <WidgetCanvas
                v-if="bench.isWidgetCard(id)"
                :id="id"
                :editing="false"
                @popout="(c: CardId, w: string) => pip.openPip({ kind: 'widget', cardId: c, widgetId: w })"
              />
              <CardContent
                v-else
                :id="id"
                :selected="selected"
                @select="onSelect"
              />
            </CardShell>
          </div>
        </TransitionGroup>
      </template>

      <!-- ===== 自动布局：分区 + 装箱网格（默认） ===== -->
      <template v-else>
      <!-- 分区落点高亮（拖拽时显示，不参与卡片动画） -->
      <div
        class="zone-hint zone-main"
        :class="{ active: bench.dropHint.value?.zone === 'main' }"
      ></div>
      <div
        class="zone-hint zone-side"
        :class="{ active: bench.dropHint.value?.zone === 'side' }"
      ></div>

      <!-- 卡片网格 -->
      <TransitionGroup
        tag="div"
        class="card-grid"
        :class="{
          'time-mode': bench.timeMode.value !== null,
          scroll: bench.gridLayout.value.scroll,
        }"
        :style="cardGridStyle"
        enter-active-class="card-enter"
        leave-active-class="card-leave"
        move-class="card-move"
        @dragover="onGridDragOver"
        @drop="bench.applyDrop()"
      >
        <div
          v-for="id in bench.openCards.value"
          :key="id"
          class="card-slot"
          :data-card-id="id"
          :ref="(el: any) => cardMount.observeSlot(el, id)"
          :class="{
            'drop-before': dropPos(id) === 'before',
            'drop-after': dropPos(id) === 'after',
            'live-src': bench.dragId.value === id,
          }"
          :style="[ bench.layout.value[id], { '--i': String(Math.min(bench.openCards.value.indexOf(id), 6)) } ]"
        >
          <div v-if="bench.dragId.value === id" class="drag-ghost"></div>
          <CardShell
            v-if="cardMount.isMounted(id)"
            :card-id="id"
            :title="CARD_META[id].title"
            :accent="CARD_META[id].accent"
            :dragging="bench.dragId.value === id"
            :focused="bench.focusId.value === id"
            :collapsed="bench.isCollapsed(id)"
            :resizable="bench.focusId.value === null && !bench.isCollapsed(id)"
            :span="bench.cardSpanOf(id).w"
            :rspan="bench.cardSpanOf(id).h"
            :refresh="bench.cardRefreshOf(id)"
            :color="bench.cardCustom.value[id]?.color ?? ''"
            :look-vars="bench.cardStyleVars(id)"
            :look="bench.cardLook(id)"
            :cfg-open-signal="bench.openCfgId.value === id"
            :popoutable="bench.isWidgetCard(id)"
            :popout-on="pip.isOpen({ kind: 'card', cardId: id })"
            @close="bench.close(id)"
            @focus="enterFocus(id)"
            @restore="exitFocus"
            @pdrag="(e: PointerEvent) => bench.pointerDragStart(id, e)"
            @menu="(p) => onCardMenu(id, p)"
            @cfg-consumed="bench.openCfgId.value = null"
            @collapse="bench.toggleCollapse(id)"
            @color="(c: string) => bench.setCardColor(id, c)"
            @refresh="(n: number) => bench.setCardRefresh(id, n)"
            @resize="(w: number, h: number) => bench.resizeCard(id, w, h)"
            @look="(p) => bench.setCardLook(id, p)"
            @pin="bench.togglePin(id)"
            @lock="bench.toggleLock(id)"
            @tag="(t: string) => bench.setCardTag(id, t)"
            @resetlook="bench.resetCardLook(id)"
            @resetwidgets="bench.resetCardWidgets(id)"
            @popout="pip.openPip({ kind: 'card', cardId: id })"
          >
            <WidgetCanvas
              v-if="bench.isWidgetCard(id)"
              :id="id"
              :editing="false"
              @popout="(c: CardId, w: string) => pip.openPip({ kind: 'widget', cardId: c, widgetId: w })"
            />
            <CardContent
              v-else
              :id="id"
              :selected="selected"
              :compact="bench.isFocused.value ? id !== bench.focusId.value && bench.timeMode.value !== null : bench.timeMode.value !== null"
              @select="onSelect"
            />
          </CardShell>
        </div>
      </TransitionGroup>
      </template>

      <!-- 卡片聚焦 overlay：遮罩 + 主区目标 + 右侧快速切换栏（与卡片同处 ws-body 层叠上下文）-->
      <template v-if="overlayShow">
        <div class="focus-backdrop" :class="{ closing: focusClosing }" @click="exitFocus"></div>
        <div class="focus-target" ref="focusTargetEl"></div>
        <div class="focus-rail" :class="{ closing: focusClosing }">
          <button
            v-for="id in railCards"
            :key="id"
            type="button"
            class="rail-item"
            :class="{ cur: id === bench.focusId.value }"
            @click="switchFocus(id)"
          >
            <span class="ri-bar" :style="{ background: CARD_META[id].accent }"></span>
            <span class="ri-title">{{ CARD_META[id].title }}</span>
            <svg class="ri-chev" viewBox="0 0 24 24"><path fill="currentColor" d="M9 6l6 6-6 6z" /></svg>
          </button>
        </div>
      </template>
      </div>
    </main>

    <!-- 关闭卡片撤销 toast -->
    <Transition name="toast">
      <button
        v-if="undoToast"
        type="button"
        class="undo-toast"
        @click="bench.undo(); undoToast = false"
      >
        卡片已关闭 · 撤销
      </button>
    </Transition>

    <!-- 卡片右键菜单 -->
    <CardContextMenu
      v-if="ctxMenu"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :locked="bench.cardLook(ctxMenu.id).locked"
      :pinned="bench.cardLook(ctxMenu.id).pinned"
      :collapsed="bench.isCollapsed(ctxMenu.id)"
      :can-paste="!!bench.copiedLook.value"
      @action="onCtxAction"
      @close="ctxMenu = null"
    />

    <!-- 软件更新对话框 -->
    <UpdateDialog v-model:open="showUpdate" />
    <!-- 设置对话框 -->
    <AlertToast />
    <SettingsDialog v-model:open="showSettings" @replay-onboarding="showOnboarding = true" />
    <ShortcutDialog v-model:open="showShortcuts" />
    <OnboardingDialog v-model:open="showOnboarding" />

    <!-- 命令面板（Ctrl / ⌘ + K） -->
    <Transition name="palette">
      <div v-if="paletteOpen" class="palette-mask" @click="closePalette">
        <div class="palette" @click.stop>
          <div class="p-search">
            <svg viewBox="0 0 24 24" class="ps-ic"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 10-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1114 9.5 4.5 4.5 0 019.5 14z" /></svg>
            <input
              ref="pInput"
              v-model="paletteQuery"
              type="text"
              class="ps-input"
              placeholder="搜索功能、卡片、指标…"
              spellcheck="false"
            />
            <kbd class="ps-esc">ESC</kbd>
          </div>
          <div class="p-list">
            <button
              v-for="(r, i) in pFiltered.slice(0, 60)"
              :key="r.cat + r.label"
              type="button"
              class="p-opt"
              :class="{ sel: i === pSel }"
              @mouseenter="pSel = i"
              @click="runPalette(r)"
            >
              <span class="po-ic">
                <svg viewBox="0 0 24 24"><path fill="currentColor" :d="r.icon" /></svg>
              </span>
              <span class="po-tx">
                <b>{{ r.label }}</b>
                <em>{{ r.desc }}</em>
              </span>
              <span class="po-cat">{{ r.cat }}</span>
            </button>
            <div v-if="!pFiltered.length" class="p-empty">没有匹配的功能，换个关键词试试</div>
          </div>
          <div class="p-foot">
            <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
            <span><kbd>↵</kbd> 打开</span>
            <span class="esc"><kbd>esc</kbd> 关闭</span>
            <span class="cnt">{{ pFiltered.length }} 个功能</span>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped src="./styles/app.css"></style>
