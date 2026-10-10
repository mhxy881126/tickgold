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
import ToastContainer from "./components/ToastContainer.vue";
import LayoutMenu from "./components/LayoutMenu.vue";
import SideDock from "./components/SideDock.vue";
import CardTabStrip from "./components/CardTabStrip.vue";
import AppDialog from "./components/AppDialog.vue";
import ShortTermSpider from "./components/ShortTermSpider.vue";
import LimitRadar from "./components/LimitRadar.vue";
import WatchList from "./components/WatchList.vue";
import Indices from "./components/Indices.vue";
import RankBoard from "./components/RankBoard.vue";
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
import TradeDeck from "./components/TradeDeck.vue";
import NewsFlash from "./components/NewsFlash.vue";
import WelcomeBoard from "./components/WelcomeBoard.vue";
import { useWatchlistStore } from "./stores/watchlist";
import { useQuotesStore } from "./stores/quotes";
import { useAlertStore } from "./stores/alert";
import { useWorkbench, CARD_META, SCENES, currentTimeSlot, type CardId, type Scene } from "./composables/useWorkbench";
import { useDockGroups } from "./composables/useDockGroups";
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
import SpiderOverlay from "./components/SpiderOverlay.vue";
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
import { initPluginSystem } from "./plugin/register";
import { promptDialog } from "./composables/useDialog";
import { toast } from "./composables/useToast";
import { useNovice } from "./composables/useNovice";

const wl = useWatchlistStore();
const quotes = useQuotesStore();
const alerts = useAlertStore();
const bench = useWorkbench();
const theme = useTheme();
const a11y = useAccessibility();
const motion = useMotion();
const skins = useSkins();
const novice = useNovice();
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
async function onCtxAction(a: string) {
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
    const t = await promptDialog({
      title: "卡片标签",
      defaultValue: bench.cardLook(id).tag,
      placeholder: "标签（最多4字）",
    });
    if (t !== null) bench.setCardTag(id, t);
  } else if (a === "close") bench.close(id);
  ctxMenu.value = null;
}

// ===== 槽位吸附：拖拽中实时算鼠标纵向偏置（top / bottom）=====
const dragYRatio = ref(0.5);
const dragYBias = computed<"top" | "bottom">(() =>
  dragYRatio.value < 0.5 ? "top" : "bottom"
);
function onDragMoveBias(e: PointerEvent) {
  if (!bench.dragId.value) return;
  const ws = document.querySelector(".ws-body");
  if (!ws) return;
  const r = ws.getBoundingClientRect();
  if (e.clientY < r.top || e.clientY > r.bottom) return;
  dragYRatio.value = (e.clientY - r.top) / r.height;
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

// ===== 对话框状态 =====
const showUpdate = ref(false);
const showSettings = ref(false);
const showShortcuts = ref(false);
const showOnboarding = ref(false);

// 统一卡片开关
function toggleCard(id: CardId) {
  if (bench.isOpen(id)) {
    // 已打开：如果不是当前主卡，就切为主卡；如果已经是主卡，就关闭
    if (!bench.freeMode.value && bench.glassActive.value === id) {
      bench.close(id);
    } else if (!bench.freeMode.value) {
      bench.setGlassActive(id);
    } else {
      bench.close(id);
    }
    return;
  }
  // 新打开：主卡+导航模式下自动设为主卡
  bench.open(id);
}

// ===== 方案 D · 交易指挥舱场景（B）=====
// 交易盯盘场景在非自由布局下以 TradeDeck 范式渲染（账户条 + 主图 + 信号桥 + 逐笔/模拟持仓/自选 + Kill Switch）
const deckMode = computed(() => !bench.freeMode.value && bench.sceneId.value === "trade");

// 编排与场景互斥守卫：自由布局（A 编排态）中禁止切换场景，先退出编排再切
const guardToast = ref(false);
let guardTimer: ReturnType<typeof setTimeout> | null = null;
function applySceneGuarded(sc: Scene) {
  if (bench.freeMode.value) {
    guardToast.value = true;
    if (guardTimer) clearTimeout(guardTimer);
    guardTimer = setTimeout(() => (guardToast.value = false), 2600);
    return;
  }
  bench.applyScene(sc);
}

// ===== 玻璃浮岛：按 Dock 分组聚合已开卡片 =====
// 用户可自定义左侧菜单分组（新增/重命名/删除/移动功能），此处共享同一份配置
const dock = useDockGroups();
const dockGroups = dock.groups;
const glassGroups = computed(() => {
  const open = bench.openCards.value;
  return dockGroups.value
    .map((g) => ({
      name: g.name,
      items: g.items.filter((it) => open.includes(it.id as CardId)),
    }))
    .filter((g) => g.items.length > 0);
});

// 玻璃浮岛右侧导航：所有分组都显示，可折叠
const allGlassGroups = dockGroups;
const openGroups = ref<Set<string>>(new Set(dockGroups.value.map(g => g.name)));
watch(dockGroups, (gs) => {
  openGroups.value = new Set([...openGroups.value, ...gs.map((g) => g.name)]);
});
function toggleGroup(name: string) {
  if (openGroups.value.has(name)) openGroups.value.delete(name);
  else openGroups.value.add(name);
  openGroups.value = new Set(openGroups.value);
}
// 右侧导航点击：已开则切换主卡，未开则打开并设为主卡
function onNavPick(id: CardId) {
  if (bench.openCards.value.includes(id)) {
    bench.setGlassActive(id);
  } else {
    bench.open(id);
    bench.setGlassActive(id);
  }
}

// 底部 Tab 流点击
function onTabActivate(id: CardId) {
  // 主卡+导航模式：直接切主卡
  if (!bench.freeMode.value) {
    bench.setGlassActive(id);
    return;
  }
  // 自由布局：聚焦逻辑
  if (bench.focusId.value === id) exitFocus();
  else if (bench.isFocused.value) switchFocus(id);
  else enterFocus(id);
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

// ===== 联动：选中股票 → K线进入主卡大区域 =====
function pickStock(code: string, name?: string) {
  selected.value = code;
  if (name && !wl.codes.includes(code)) {
    wl.add(code, name);
    toast.success(`已添加「${name}」到自选`);
  }
  // 主卡+导航模式：直接把主卡切到 K线图
  if (!bench.freeMode.value) {
    if (!bench.isOpen("chart")) bench.open("chart");
    bench.setGlassActive("chart");
    return;
  }
  // 自由布局：使用聚焦模式
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
function onSectorPick(name: string, kind: string) {
  // 主卡+导航模式：直接切主卡到板块行情
  if (!bench.freeMode.value) {
    if (!bench.isOpen("sector")) bench.open("sector");
    bench.setGlassActive("sector");
    return;
  }
  // 自由布局：打开板块行情卡片并聚焦
  if (bench.isOpen("sector")) {
    if (bench.isFocused.value) {
      if (bench.focusId.value !== "sector") switchFocus("sector");
    } else {
      enterFocus("sector");
    }
  } else {
    bench.open("sector");
    nextTick(() => enterFocus("sector"));
  }
}
function onSearchSelect(code: string, name: string) {
  pickStock(code, name);
}

const unlistenFns: (() => void)[] = [];

// AI 爬虫机器人
const spiderRef = ref<InstanceType<typeof SpiderOverlay> | null>(null);

onMounted(async () => {
  // 快捷键：Ctrl+Shift+S 启动/停止爬虫机器人
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "S") {
      e.preventDefault();
      if (spiderRef.value) {
        if (spiderRef.value.running) {
          spiderRef.value.stop();
        } else {
          spiderRef.value.start();
        }
      }
    }
  });
  // 板块热力图点击 → 打开板块行情卡片
  window.addEventListener("open-sector-card", () => {
    // 主卡+导航模式：直接切主卡
    if (!bench.freeMode.value) {
      if (!bench.isOpen("sector")) bench.open("sector");
      bench.setGlassActive("sector");
      return;
    }
    if (bench.isOpen("sector")) {
      bench.focusId.value = "sector";
    } else {
      bench.open("sector");
      nextTick(() => (bench.focusId.value = "sector"));
    }
  });

  // —— 平台、版本与窗口最大化状态 ——
  await initPlatform();

  // —— 基础数据（各自独立容错，互不影响）——
  try { await ensureDb(); } catch (e) { console.error("[app] db", e); }
  // —— 本地时序采集（情绪/指数/板块，盘中分时+收盘日级，常驻后台）——
  try { await startTimeSeries(); } catch (e) { console.error("[app] timeseries", e); }
  // —— 题材采集调度器（盘中 20 分钟催化增量 + 盘后归因；内部防重入/同日幂等）——
  try { startCollector(); } catch (e) { console.error("[app] collector", e); }
  try { await theme.load(); } catch (e) { console.error("[app] theme", e); }
  try { await novice.load(); } catch (e) { console.error("[app] novice", e); }
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

  // —— 插件生态：扫描内置/已装插件、动态注册微件、订阅启停事件 ——
  try { await initPluginSystem(); } catch (e) { console.error("[app] plugins", e); }

  // —— 预警引擎：停用旧 Rust 引擎，启动 v0.71 TypeScript 条件树引擎 ——
  await bootstrapAlerts({
    pickStock,
    openScreener: () => {
      if (!bench.isOpen("screener")) bench.open("screener");
    },
  });

  // —— 命令面板内部导航（全局快捷键由 useActions 派发）——
  window.addEventListener("keydown", onPaletteKey);
  // —— 槽位吸附：拖拽中实时算纵向偏置 ——
  window.addEventListener("pointermove", onDragMoveBias);

  // —— 事件监听 ——
  try {
    unlistenFns.push(
      await listen<string>("island:select", (e) => {
        const c = e.payload;
        if (!wl.codes.includes(c)) wl.add(c);
        pickStock(c);
      }),
      await listen<string>("island:open-card", (e) => {
        const cid = e.payload as CardId;
        bench.open(cid);
        // 主卡+导航模式：打开后直接设为主卡
        if (!bench.freeMode.value) {
          bench.setGlassActive(cid);
        } else {
          bench.focus(cid); // 自由布局：聚焦到主区
        }
      }),
      await listen("bridge:focus", () => {
        if (!bench.isOpen("signalbridge")) bench.open("signalbridge");
      })
    );
    // 托盘菜单事件
    unlistenFns.push(await listen("open-settings", () => { showSettings.value = true; }));
    unlistenFns.push(await listen("check-update", () => { showUpdate.value = true; }));
    unlistenFns.push(await listen("show-about", () => { showSettings.value = true; }));
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
  window.removeEventListener("pointermove", onDragMoveBias);
});
</script>

<template>
  <div class="app">
    <!-- 顶栏 -->
    <header class="topbar" :class="{ mac: isMac }" data-tauri-drag-region>
      <div class="brand" data-tauri-drag-region>TickGold</div>
      <div class="scene-pill-group-top">
        <button
          v-for="sc in SCENES"
          :key="sc.id"
          type="button"
          class="scene-pill"
          :class="{ on: bench.sceneId.value === sc.id }"
          @click="applySceneGuarded(sc)"
        >
          <svg viewBox="0 0 24 24"><path fill="currentColor" :d="sc.icon" /></svg>
          <span>{{ sc.label }}</span>
        </button>
      </div>
      <!-- 布局已统一为主卡+右导航 -->

      <SearchBox @select="onSearchSelect" />
      <div class="status">
        <span :class="quotes.polling ? 'dot on' : 'dot'"></span>
        {{ quotes.polling ? "实时" : "已暂停" }}
        <span class="sep">|</span>
        {{ Object.keys(quotes.map).length }} 只
        <span class="sep">|</span>
        <button class="icon-btn" title="设置" @click="showSettings = true">
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
        </button>
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

    <!-- 左侧 Dock：功能分类竖排导航（替代原顶部 Mega 横条） -->
    <SideDock @toggle="toggleCard" @palette="openPalette" />

    <!-- 右侧主区：指数条 + 工作台 -->
    <div class="app-main">
    <!-- 指数条 -->
    <Indices class="idx-row" />

    <!-- 工作台主区域 -->
    <main
      class="workspace"
      :class="{ dragging: bench.dragId.value !== null, bare: bench.openCards.value.length === 0 }"
    >
      <!-- 空台沉浸背景：铺满整个 workspace（含时段栏后方），与时段栏融为一体 -->
      <Transition name="welcome">
        <WelcomeBoard v-if="bench.openCards.value.length === 0" />
      </Transition>
      <!-- 时段 Tabs 一行 -->
      <div class="time-tabs-row">
        <TimeTabs :active="bench.timeMode.value" @select="bench.enterTimeMode($event)" />
      </div>

      <div class="ws-body" :class="{ free: bench.freeMode.value, glass: true }">

      <!-- ===== 方案 D · 交易指挥舱场景（交易盯盘） ===== -->
      <TradeDeck
        v-if="deckMode"
        :selected="selected"
        @select="onSelect"
        @sector="onSectorPick"
        @menu="(m) => onCardMenu(m.id, m)"
      />

      <!-- ===== 主卡+右导航布局（Bento / 玻璃浮岛通用） ===== -->
      <template v-else-if="!bench.freeMode.value">
        <div class="glass-layout">
        <div class="glass-master">
          <CardShell
            v-if="bench.glassActive.value"
            :card-id="bench.glassActive.value"
            :title="CARD_META[bench.glassActive.value].title"
            :accent="CARD_META[bench.glassActive.value].accent"
            :focused="false"
            :collapsed="false"
            :refresh="bench.cardRefreshOf(bench.glassActive.value)"
            :color="bench.cardCustom.value[bench.glassActive.value]?.color ?? ''"
            :look-vars="bench.cardStyleVars(bench.glassActive.value)"
            :look="bench.cardLook(bench.glassActive.value)"
            :locked="bench.cardLook(bench.glassActive.value).locked"
            :span="bench.cardSpanOf(bench.glassActive.value).w"
            :rspan="bench.cardSpanOf(bench.glassActive.value).h"
            :cfg-open-signal="bench.openCfgId.value === bench.glassActive.value"
            :popoutable="bench.isWidgetCard(bench.glassActive.value)"
            :popout-on="pip.isOpen({ kind: 'card', cardId: bench.glassActive.value })"
            hide-focus
            @close="bench.close(bench.glassActive.value!)"
            @focus="enterFocus(bench.glassActive.value!)"
            @restore="exitFocus"
            @menu="(p) => onCardMenu(bench.glassActive.value!, p)"
            @cfg-consumed="bench.openCfgId.value = null"
            @color="(c: string) => bench.setCardColor(bench.glassActive.value!, c)"
            @refresh="(n: number) => bench.setCardRefresh(bench.glassActive.value!, n)"
            @look="(p) => bench.setCardLook(bench.glassActive.value!, p)"
            @pin="bench.togglePin(bench.glassActive.value!)"
            @lock="bench.toggleLock(bench.glassActive.value!)"
            @tag="(t: string) => bench.setCardTag(bench.glassActive.value!, t)"
            @resetlook="bench.resetCardLook(bench.glassActive.value!)"
            @resetwidgets="bench.resetCardWidgets(bench.glassActive.value!)"
            @popout="pip.openPip({ kind: 'card', cardId: bench.glassActive.value! })"
          >
            <WidgetCanvas
              v-if="bench.isWidgetCard(bench.glassActive.value!)"
              :id="bench.glassActive.value!"
              :editing="false"
              @popout="(c: CardId, w: string) => pip.openPip({ kind: 'widget', cardId: c, widgetId: w })"
            />
            <CardContent
              v-else
              :id="bench.glassActive.value!"
              :selected="selected"
              @select="onSelect"
              @sector="onSectorPick"
            />
          </CardShell>
        </div>
        <aside class="glass-edge">
          <div class="ge-head">
            <div class="ge-title">卡片导航</div>
            <div class="ge-sub">{{ bench.openCards.value.length }} 张已开</div>
          </div>
          <div class="ge-groups">
            <div v-for="g in allGlassGroups" :key="g.name" class="ge-group" :class="{ open: openGroups.has(g.name) }">
              <div class="ge-group-head" @click="toggleGroup(g.name)">
                <span class="ge-group-icon">
                  <svg viewBox="0 0 24 24"><path fill="currentColor" :d="g.icon" /></svg>
                </span>
                <span class="ge-group-name">{{ g.name }}</span>
                <span class="ge-group-count">{{ g.items.filter(i => bench.openCards.value.includes(i.id)).length }}</span>
                <span class="ge-group-arrow">▶</span>
              </div>
              <div class="ge-group-items">
                <button
                  v-for="item in g.items"
                  :key="item.id"
                  type="button"
                  class="ge-item"
                  :data-nav-id="item.id"
                  :class="{ on: item.id === bench.glassActive.value, closed: !bench.openCards.value.includes(item.id) }"
                  @click="onNavPick(item.id)"
                >
                  <span class="ge-dot" :style="{ background: CARD_META[item.id]?.accent || '#8b97a8' }"></span>
                  {{ CARD_META[item.id]?.title || item.label }}
                </button>
              </div>
            </div>
          </div>
        </aside>
        </div>
      </template>

      <!-- ===== 自由布局：卡片绝对定位、可随意拖拽 ===== -->
      <template v-else-if="bench.freeMode.value">
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
              v-if="true"
              :card-id="id"
              :title="CARD_META[id].title"
              :accent="CARD_META[id].accent"
              free-drag
              resizable
              :focused="bench.focusId.value === id"
              :collapsed="bench.isCollapsed(id)"
              :refresh="bench.cardRefreshOf(id)"
              :color="bench.cardCustom.value[id]?.color ?? ''"
              :look-vars="bench.cardStyleVars(id)"
              :look="bench.cardLook(id)"
              :locked="bench.cardLook(id).locked"
              :span="bench.freeRects.value[id]?.w ?? bench.cardSpanOf(id).w"
              :rspan="bench.freeRects.value[id]?.h ?? bench.cardSpanOf(id).h"
              :cfg-open-signal="bench.openCfgId.value === id"
              :popoutable="bench.isWidgetCard(id)"
              :popout-on="pip.isOpen({ kind: 'card', cardId: id })"
              @close="bench.close(id)"
              @focus="enterFocus(id)"
              @restore="exitFocus"
              @grab="(e: PointerEvent) => bench.startFreeDrag(e, id)"
              @resize="(w: number, h: number) => bench.freeResize(id, w, h)"
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
                @sector="onSectorPick"
              />
            </CardShell>
          </div>
        </TransitionGroup>
      </template>

      <!-- 卡片聚焦 overlay：仅自由布局下使用 -->
      <template v-if="overlayShow && bench.freeMode.value">
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
    </div><!-- /.app-main -->

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

    <!-- 编排与场景互斥提示 toast -->
    <Transition name="toast">
      <div v-if="guardToast" class="undo-toast guard">编排中不可切换场景 · 请先恢复自动布局</div>
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
    <SettingsDialog v-model:open="showSettings" @replay-onboarding="showOnboarding = true" @check-update="showUpdate = true" />
    <ShortcutDialog v-model:open="showShortcuts" />
    <OnboardingDialog v-model:open="showOnboarding" />
    <ToastContainer />
    <AppDialog />

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

    <!-- AI 爬虫机器人全局覆盖层 -->
    <SpiderOverlay ref="spiderRef" />
  </div>
</template>

<style scoped src="./styles/app.css"></style>
