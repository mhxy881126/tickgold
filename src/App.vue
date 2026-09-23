<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, provide, watch } from "vue";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import CardShell from "./components/CardShell.vue";
import CardContent from "./components/CardContent.vue";
import UpdateDialog from "./components/UpdateDialog.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import LayoutMenu from "./components/LayoutMenu.vue";
import ShortTermSpider from "./components/ShortTermSpider.vue";
import LimitRadar from "./components/LimitRadar.vue";
import BreadthBoard from "./components/BreadthBoard.vue";
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
import ThemeRotation from "./components/ThemeRotation.vue";
import NewsFlash from "./components/NewsFlash.vue";
import WelcomeBoard from "./components/WelcomeBoard.vue";
import { useWatchlistStore } from "./stores/watchlist";
import { useQuotesStore } from "./stores/quotes";
import { useAlertStore } from "./stores/alert";
import { useWorkbench, CARD_META, MODES, currentTimeSlot, type CardId } from "./composables/useWorkbench";
import { useTheme } from "./composables/useTheme";
import type { AlertEvent } from "./api/market";
import { ensureDb } from "./db/database";

const wl = useWatchlistStore();
const quotes = useQuotesStore();
const alerts = useAlertStore();
const bench = useWorkbench();
const theme = useTheme();
provide("workbench", bench);

const selected = ref<string | null>(null);

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

// ===== 顶部 Dock：按功能域分组 =====
interface DockItem {
  id: CardId;
  label: string;
  icon: string;
}
interface DockGroup {
  name: string;
  items: DockItem[];
}
const DOCK_GROUPS: DockGroup[] = [
  {
    name: "总览",
    items: [
      { id: "watch", label: "自选", icon: "M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" },
      { id: "rank", label: "榜单", icon: "M3 5h18v2H3zm0 4h18v2H3zm0 4h12v2H3zm0 4h12v2H3z" },
      { id: "breadth", label: "宽度", icon: "M3 12h4l3-8 4 16 3-8h4" },
      { id: "dist", label: "涨跌分布", icon: "M3 21h2v-7H3zm4 0h2V9H7zm4 0h2V5h-2zm4 0h2v-9h-2zm4 0h2V11h-2z" },
    ],
  },
  {
    name: "盯盘",
    items: [
      { id: "radarsweep", label: "雷达扫盘", icon: "M12 2A10 10 0 1 0 22 12h-2A8 8 0 1 1 12 4zM12 6v6l5 2-1 1.7L11 13V6z" },
      { id: "radar", label: "雷达", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a6 6 0 100 12 6 6 0 000-12zm0 3a3 3 0 100 6 3 3 0 000-6z" },
      { id: "spider", label: "精灵", icon: "M13 2 3 14h7l-1 8 10-12h-7l1-8z" },
      { id: "alert", label: "预警", icon: "M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C8.63 5.36 7 7.92 7 11v5l-2 2v1h14v-1l-2-2z" },
    ],
  },
  {
    name: "模式",
    items: [
      { id: "radarsweep", label: "雷达扫盘", icon: "M12 2A10 10 0 1 0 22 12h-2A8 8 0 1 1 12 4zM12 6v6l5 2-1 1.7L11 13V6z" },
      { id: "reviewtimeline", label: "复盘时间线", icon: "M12 3a2 2 0 100 4 2 2 0 000-4zm0 7a2 2 0 100 4 2 2 0 000-4zm0 7a2 2 0 100 4 2 2 0 000-4z" },
      { id: "multigrid", label: "多股同列", icon: "M3 3h5v5H3zm6.5 0h5v5h-5zM16 3h5v5h-5zM3 9.5h5v5H3zm6.5 0h5v5h-5zM16 9.5h5v5h-5zM3 16h5v5H3zm6.5 0h5v5h-5zM16 16h5v5h-5z" },
      { id: "heatmatrix", label: "热力矩阵", icon: "M3 4h7v4H3zm9 0h9v4h-9zM3 10h9v4H3zm11 0h7v4h-7zM3 16h7v4H3zm9 0h9v4h-9z" },
      { id: "bentofocus", label: "Bento聚焦", icon: "M3 3h8v5H3zm9 0h9v9h-9zM3 9h5v12H3zm6 6h12v6H9z" },
      { id: "telegraph", label: "电报墙", icon: "M4 11a8 8 0 0116 0M7 11a5 5 0 0110 0M10 11a2 2 0 014 0M12 13v8" },
    ],
  },
  {
    name: "板块",
    items: [
      { id: "sector", label: "板块", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm-1 2.06V11H4.06A8 8 0 0111 4.06zM4 13h7v6.94A8 8 0 014 13zm9 6.94V13h6.94A8 8 0 0113 19.94zM19.94 11H13V4.06A8 8 0 0119.94 11z" },
      { id: "sectorheat", label: "热力图", icon: "M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z" },
      { id: "sectorevent", label: "板块异动", icon: "M3 12h4l3-8 4 16 3-8h4" },
      { id: "theme", label: "题材轮动", icon: "M12 5l7 3.5-7 3.5L5 8.5 12 5zM5 12l7 3.5L19 12M5 15.5l7 3.5 7-3.5" },
    ],
  },
  {
    name: "行情",
    items: [
      { id: "chart", label: "K线", icon: "M6 3h2v4H6zm0 14h2v4H6zM5 8h4v8H5zm11-9h2v3h-2zm0 12h2v5h-2zm-1-7h4v7h-4z" },
      { id: "order", label: "盘口", icon: "M5 3h14v18H5zm2 4h10v2H7zm0 4h10v2H7zm0 4h7v2H7z" },
      { id: "fundflow", label: "资金", icon: "M12 3c-4 0-7 1.3-7 3v12c0 1.7 3 3 7 3s7-1.3 7-3V6c0-1.7-3-3-7-3zm0 2c3.3 0 5 .9 5 1s-1.7 1-5 1-5-.9-5-1 1.7-1 5-1zm-5 4.5c1.2.8 3 1.3 5 1.3s3.8-.5 5-1.3V12c0 .1-1.7 1-5 1s-5-.9-5-1zm0 4c1.2.8 3 1.3 5 1.3s3.8-.5 5-1.3V16c0 .1-1.7 1-5 1s-5-.9-5-1z" },
      { id: "news", label: "快讯", icon: "M5 3h14a2 2 0 012 2v11a2 2 0 01-2 2H8l-4 3V5a2 2 0 011-2z" },
    ],
  },
  {
    name: "选股交易",
    items: [
      { id: "screener", label: "选股", icon: "M4 5h3v14H4zm6.5 5h3v9h-3zM17 9h3v10h-3z" },
      { id: "f10", label: "F10", icon: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm0 2l4 4h-4V4zM8 13h8v1.5H8zm0 4h8v1.5H8zm0-8h5v1.5H8z" },
      { id: "trade", label: "模拟交易", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm1 5v1.1c1.7.3 3 1.4 3 3.1 0 1.9-1.5 2.8-3.4 2.8-1.2 0-2.1-.4-2.6-1l1.2-1c.3.4.8.7 1.5.7.8 0 1.3-.3 1.3-.8s-.4-.8-1.5-1c-1.6-.4-3.2-1-3.2-2.9 0-1.6 1.3-2.7 3-3V5h2zm-1 11h2v2h-2z" },
    ],
  },
  {
    name: "工具",
    items: [
      { id: "journal", label: "日记", icon: "M5 3h14a1 1 0 011 1v16a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1zm3 5h8v1.5H8zm0 4h8v1.5H8zm0 4h5v1.5H8z" },
      { id: "calendar", label: "财经日历", icon: "M7 2v2H5a2 2 0 00-2 2v13a2 2 0 002 2h14a2 2 0 002-2V6a2 0 002-2 0 00-2-2h-2V2h-2v2H9V2H7zm-2 7h14v10H5V9zm2 2v3h3v-3H7zm5 0v3h3v-3z" },
      { id: "ipo", label: "新股解禁", icon: "M12 2l2.9 6.3 6.8.7-5 4.6 1.4 6.7L12 17l-6.1 3.3 1.4-6.7-5-4.6 6.8-.7z" },
    ],
  },
];

// ===== 模式预设 =====
const MODE_NAV: { cards: CardId[]; label: string; icon: string }[] = [
  { cards: MODES.pro, label: "专业", icon: "M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z" },
  { cards: MODES.sector, label: "板块", icon: "M3 12h4l3-8 4 16 3-8h4" },
  { cards: MODES.scanner, label: "选股", icon: "M3 4h18l-7 8v6l-4 2v-8z" },
  { cards: MODES.full, label: "全屏", icon: "M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z" },
];

function isMode(cards: CardId[]) {
  const a = [...bench.openCards.value].sort().join(",");
  const b = [...cards].sort().join(",");
  return a === b && a !== "";
}

// ===== Dock 联动放大（macOS Dock 感：鼠标越近、放大越多并上浮）=====
const dockRef = ref<HTMLElement | null>(null);
function onDockMove(e: MouseEvent) {
  const el = dockRef.value;
  if (!el) return;
  const items = el.querySelectorAll<HTMLElement>(".dock-item");
  items.forEach((it) => {
    const r = it.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const d = Math.abs(e.clientX - cx);
    const t = Math.max(0, 1 - d / 115);
    it.style.transform = `scale(${1 + t * 0.42}) translateY(${(-t * 6).toFixed(1)}px)`;
    it.style.zIndex = t > 0.05 ? "10" : "";
  });
}
function onDockLeave() {
  const el = dockRef.value;
  if (!el) return;
  el.querySelectorAll<HTMLElement>(".dock-item").forEach((it) => {
    it.style.transform = "";
    it.style.zIndex = "";
  });
}

// ===== Dock 超宽横向滚动（滚轮转换 + 左右箭头）=====
const dockCanL = ref(false);
const dockCanR = ref(false);
function updateDockArrows() {
  const el = dockRef.value;
  if (!el) return;
  dockCanL.value = el.scrollLeft > 4;
  dockCanR.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
}
function onDockWheel(e: WheelEvent) {
  const el = dockRef.value;
  if (!el || el.scrollWidth <= el.clientWidth) return;
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  }
}
function dockBy(dir: number) {
  const el = dockRef.value;
  if (!el) return;
  el.scrollBy({ left: dir * Math.round(el.clientWidth * 0.65), behavior: "smooth" });
}

// ===== 联动：选中股票 → 打开 K线卡片 =====
function onSelect(code: string) {
  selected.value = code;
  bench.open("chart");
}
function onSearchSelect(code: string, name: string) {
  selected.value = code;
  if (!wl.codes.includes(code)) wl.add(code, name);
  bench.open("chart");
}

// ===== 自动更新（功能在 UpdateDialog 对话框内）=====
const curVersion = ref("");
const showUpdate = ref(false);
const showSettings = ref(false);

// ===== 自绘标题栏窗口控制（Windows；macOS 用原生红绿灯）=====
const isMac = ref(false);
const isWin = ref(false);
const isMax = ref(false);
const inTauri = typeof window !== "undefined" && "__TAURI__" in window;
const appWin = inTauri ? getCurrentWindow() : null;

async function syncMax() {
  try {
    isMax.value = await invoke<boolean>("win_is_maximized");
    return;
  } catch {
    /* fall through to JS API */
  }
  if (!appWin) return;
  try {
    isMax.value = await appWin.isMaximized();
  } catch {
    /* ignore */
  }
}
async function winMinimize() {
  try {
    await invoke("win_minimize");
  } catch {
    appWin?.minimize().catch(() => {});
  }
}
async function winToggleMax() {
  try {
    isMax.value = await invoke<boolean>("win_toggle_maximize");
  } catch {
    appWin?.toggleMaximize().then(syncMax).catch(() => {});
  }
}
async function winClose() {
  try {
    await invoke("win_close");
  } catch {
    appWin?.close().catch(() => {});
  }
}
let unlistenResize: (() => void) | null = null;

const unlistenFns: (() => void)[] = [];

onMounted(async () => {
  // —— 平台与版本（独立容错）——
  try {
    const pf = (navigator.platform || navigator.userAgent || "").toLowerCase();
    isMac.value = pf.includes("mac");
    isWin.value = pf.includes("win");
    curVersion.value = await getVersion();
  } catch (e) {
    console.error("[app] platform/version", e);
  }
  // —— 窗口最大化状态同步 ——
  try {
    await syncMax();
    if (appWin) {
      unlistenResize = await appWin.onResized(() => {
        syncMax();
      });
    }
  } catch {
    /* ignore */
  }
  // —— 基础数据（各自独立容错，互不影响）——
  try { await ensureDb(); } catch (e) { console.error("[app] db", e); }
  try { await theme.load(); } catch (e) { console.error("[app] theme", e); }
  try { await wl.load(); } catch (e) { console.error("[app] watchlist", e); }
  try { await alerts.load(); } catch (e) { console.error("[app] alerts", e); }

  // —— 行情轮询：盯盘核心，自选加载后立即启动，不被后续任何步骤拖累 ——
  quotes.start(2000);

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

  // —— 预警引擎（容错，失败不影响行情）——
  try {
    await alerts.syncEngine();
  } catch (e) {
    console.error("[app] alert engine", e);
  }

  // —— Dock 交互 ——
  try {
    if (dockRef.value) {
      dockRef.value.addEventListener("wheel", onDockWheel, { passive: false });
      dockRef.value.addEventListener("scroll", updateDockArrows);
      window.addEventListener("resize", updateDockArrows);
      setTimeout(updateDockArrows, 400);
    }
  } catch (e) {
    console.error("[app] dock", e);
  }

  // —— 事件监听 ——
  try {
    unlistenFns.push(
      await listen<string>("island:select", (e) => {
        selected.value = e.payload;
        if (!wl.codes.includes(e.payload)) wl.add(e.payload);
        bench.open("chart");
      })
    );
    // 预警触发：系统通知 + 记录触发时间
    unlistenFns.push(
      await listen<AlertEvent>("alert:triggered", (e) => {
        const ev = e.payload;
        alerts.markFired(ev.id, ev.time);
        try {
          if ("Notification" in window && Notification.permission === "granted") {
            new Notification(`预警 · ${ev.label}`, { body: ev.message });
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
  unlistenResize?.();
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

    <!-- 顶部功能 Dock（按域分组，hover 联动放大；超宽可横向滚动） -->
    <div class="dock-wrap">
    <nav
      class="topdock"
      ref="dockRef"
      @mousemove="onDockMove"
      @mouseleave="onDockLeave"
    >
      <div v-for="g in DOCK_GROUPS" :key="g.name" class="dock-grp">
        <span class="grp-name">{{ g.name }}</span>
        <button
          v-for="it in g.items"
          :key="it.id"
          type="button"
          class="dock-item"
          :class="{ on: bench.isOpen(it.id) }"
          @click="bench.toggle(it.id)"
        >
          <svg viewBox="0 0 24 24" class="dock-ic"><path fill="currentColor" :d="it.icon" /></svg>
          <span class="dock-lb">{{ it.label }}</span>
        </button>
      </div>
      <div class="dock-grp mode-grp">
        <span class="grp-name">布局</span>
        <button
          v-for="(m, i) in MODE_NAV"
          :key="'m' + i"
          type="button"
          class="dock-item"
          :class="{ on: isMode(m.cards) }"
          @click="bench.setMode(m.cards)"
        >
          <svg viewBox="0 0 24 24" class="dock-ic"><path fill="currentColor" :d="m.icon" /></svg>
          <span class="dock-lb">{{ m.label }}</span>
        </button>
      </div>
    </nav>
    <button class="dock-arrow l" v-show="dockCanL" type="button" tabindex="-1" @click="dockBy(-1)">
      <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z" /></svg>
    </button>
    <button class="dock-arrow r" v-show="dockCanR" type="button" tabindex="-1" @click="dockBy(1)">
      <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4L13.2 12z" /></svg>
    </button>
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
      <!-- 时段切换栏（透明沉浸，无浮条边框） -->
      <TimeTabs :active="bench.timeMode.value" @select="bench.enterTimeMode($event)" />

      <div class="ws-body" :class="{ free: bench.freeMode.value }">

      <!-- ===== 自由布局：卡片绝对定位、可随意拖拽 ===== -->
      <template v-if="bench.freeMode.value">
        <div class="free-toolbar">
          <span class="ft-hint">自由布局：按住卡片标题栏拖动，自动避让不重叠；布局已自动保存</span>
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
            v-for="id in bench.openCards.value"
            :key="id"
            class="free-cell"
            :class="{ dragging: bench.freeDrag.value?.id === id }"
            :style="bench.freeCellStyle(id)"
          >
            <CardShell
              :title="CARD_META[id].title"
              :accent="CARD_META[id].accent"
              free-drag
              @close="bench.close(id)"
              @grab="(e: PointerEvent) => bench.startFreeDrag(e, id)"
            >
              <CardContent
                :id="id"
                :selected="selected"
                :compact="bench.timeMode.value !== null"
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
        :class="{ 'time-mode': bench.timeMode.value !== null }"
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
          :class="{
            'drop-before': dropPos(id) === 'before',
            'drop-after': dropPos(id) === 'after',
          }"
          :style="bench.layout.value[id]"
        >
          <CardShell
            :title="CARD_META[id].title"
            :accent="CARD_META[id].accent"
            :dragging="bench.dragId.value === id"
            @close="bench.close(id)"
            @pdrag="(e: PointerEvent) => bench.pointerDragStart(id, e)"
          >
            <CardContent
              :id="id"
              :selected="selected"
              :compact="bench.timeMode.value !== null"
              @select="onSelect"
            />
          </CardShell>
        </div>
      </TransitionGroup>
      </template>
      </div>
    </main>

    <!-- 软件更新对话框 -->
    <UpdateDialog v-model:open="showUpdate" />
    <!-- 设置对话框 -->
    <SettingsDialog v-model:open="showSettings" />
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-rows: 38px 32px 44px 1fr;
  grid-template-columns: 1fr;
  height: 100vh;
  background: var(--bg);
  color: var(--text);
}

/* 顶栏 */
.topbar {
  grid-column: 1;
  display: flex; align-items: center; gap: 14px;
  padding: 0 0 0 12px; background: var(--bg-panel); border-bottom: 1px solid var(--border);
}
.topbar.mac { padding-left: 72px; }
.brand { font-weight: 700; color: var(--accent); white-space: nowrap; }
.status { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-dim); margin-left: auto; padding-right: 6px; }
.sep { margin: 0 8px; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #555; margin-right: 5px; }
.dot.on { background: #26d07c; }
.ver { opacity: 0.8; }

/* Windows 自绘窗口控制 */
.win-ctl { display: flex; align-items: stretch; align-self: stretch; margin-left: 4px; }
.wc-btn {
  width: 46px; border: 0; background: transparent; color: var(--text-dim);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  transition: background 0.13s, color 0.13s;
}
.wc-btn svg { width: 12px; height: 12px; }
.wc-btn:hover { background: var(--bg-hover); color: var(--text); }
.wc-btn.close:hover { background: #e23b45; color: #fff; }

/* 指数条 */
.idx-row { grid-column: 1; }

/* 顶部功能 Dock */
.topdock {
  grid-column: 1;
  display: flex;
  align-items: stretch;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  padding: 0 6px;
  overflow-x: auto;
  scrollbar-width: none;
}
.topdock::-webkit-scrollbar { display: none; }

.dock-wrap { position: relative; grid-column: 1; display: flex; min-width: 0; }
.dock-wrap .topdock { flex: 1; min-width: 0; }
.dock-arrow {
  position: absolute; top: 50%; transform: translateY(-50%);
  width: 20px; height: 28px; border: 1px solid var(--border);
  border-radius: 7px; background: rgba(14, 20, 29, 0.92);
  color: var(--text); cursor: pointer; z-index: 12;
  display: flex; align-items: center; justify-content: center; padding: 0;
}
.dock-arrow:hover { background: #1c2735; border-color: #4ea1ff; color: #4ea1ff; }
.dock-arrow.l { left: 2px; }
.dock-arrow.r { right: 2px; }
.dock-grp {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 9px;
  border-right: 1px solid var(--border);
}
.dock-grp:last-child { border-right: 0; }
.mode-grp { margin-left: auto; border-right: 0; }
.grp-name {
  font-size: 10px;
  color: var(--text-dim);
  opacity: 0.65;
  margin-right: 5px;
  white-space: nowrap;
}
.dock-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transform-origin: bottom center;
  transition: transform 0.16s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.15s, color 0.15s;
}
.dock-ic { width: 15px; height: 15px; flex: none; }
.dock-item:hover { color: var(--text); background: var(--bg-hover); }
.dock-item:hover .dock-ic { color: #4ea1ff; }
.dock-item.on { color: var(--accent-2); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.dock-item.on .dock-ic { color: var(--accent-2); }

/* 工作台 */
.workspace {
  position: relative;
  min-width: 0;
  min-height: 0;
  padding: 10px 12px 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.ws-body {
  position: relative;
  flex: 1;
  min-height: 0;
  margin-top: 10px;
  z-index: 2;
}
/* 空台：去除留白，让沉浸背景铺满、时段栏与空台融为一体 */
.workspace.bare { padding: 0; }
.workspace.bare .ws-body { margin-top: 0; pointer-events: none; }
.workspace.bare .timetabs { padding-left: 16px; padding-right: 16px; }
.card-grid {
  position: relative;
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  grid-template-rows: repeat(6, 1fr);
  gap: 12px;
  height: 100%;
}
/* 时段驾驶舱：3 大行 Bento */
.card-grid.time-mode {
  grid-template-rows: repeat(3, 1fr);
}
.card-slot {
  position: relative;
  min-width: 0;
  min-height: 0;
}

/* ===== 自由布局 ===== */
.ws-body.free { overflow-y: auto; }
.free-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.ft-hint { font-size: 11px; color: var(--text-dim); }
.ft-btn {
  margin-left: auto; height: 24px; padding: 0 12px;
  border: 1px solid var(--border); border-radius: 6px;
  background: transparent; color: var(--text); font-size: 11px; cursor: pointer;
}
.ft-btn:hover { border-color: #d4af37; color: #e8c96a; }
.free-canvas { position: relative; width: 100%; }
.free-cell {
  transition: left 0.32s cubic-bezier(0.2, 0.8, 0.2, 1),
    top 0.32s cubic-bezier(0.2, 0.8, 0.2, 1), width 0.32s, height 0.32s;
}
.free-cell.dragging { transition: none; }
.free-cell.dragging .card-shell {
  border-color: #d4af37;
  box-shadow: 0 0 0 1px #d4af37, 0 16px 40px rgba(0, 0, 0, 0.5);
}
.free-leave { animation: cardOut 0.25s cubic-bezier(0.4, 0, 0.6, 1) both; z-index: 5; }

/* 分区落点高亮 */
.zone-hint {
  position: absolute;
  pointer-events: none;
  opacity: 0;
  border: 1px dashed #3a4657;
  border-radius: 10px;
  background: rgba(80, 110, 160, 0.04);
  transition: opacity 0.15s, background 0.15s, border-color 0.15s;
  z-index: 6;
}
.workspace.dragging .zone-hint {
  opacity: 1;
}
.zone-hint.active {
  border-color: #4ea1ff;
  border-style: solid;
  background: rgba(78, 161, 255, 0.1);
}
.zone-main {
  top: 0;
  bottom: 0;
  left: 0;
  width: calc(100% * 7 / 12 - 6px);
}
.zone-side {
  top: 0;
  bottom: 0;
  right: 0;
  width: calc(100% * 5 / 12 - 6px);
}

/* 卡片插入线（落在锚点卡片的顶/底缘，位于 gap 中） */
.card-slot.drop-before::before,
.card-slot.drop-after::after {
  content: "";
  position: absolute;
  left: 2px;
  right: 2px;
  height: 3px;
  background: #4ea1ff;
  border-radius: 2px;
  z-index: 15;
  box-shadow: 0 0 8px rgba(78, 161, 255, 0.8);
}
.card-slot.drop-before::before {
  top: -7px;
}
.card-slot.drop-after::after {
  bottom: -7px;
}

/* 卡片进出场 + FLIP */
.card-enter { animation: cardIn 0.38s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.card-leave {
  position: absolute;
  left: var(--x);
  top: var(--y);
  width: var(--w);
  height: var(--h);
  animation: cardOut 0.28s cubic-bezier(0.4, 0, 0.6, 1) both;
  z-index: 20;
}
.card-move { transition: transform 0.38s cubic-bezier(0.2, 0.8, 0.2, 1); }

@keyframes cardIn {
  from { opacity: 0; transform: scale(0.9); filter: blur(6px); }
  to { opacity: 1; transform: scale(1); filter: blur(0); }
}
@keyframes cardOut {
  from { opacity: 1; transform: scale(1); filter: blur(0); }
  to { opacity: 0; transform: scale(0.92); filter: blur(4px); }
}

/* 卡片内部 */
.chart-card { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.card-empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); font-size: 12px;
}

/* 欢迎页过渡（作用于 WelcomeBoard 根元素） */
.welcome-enter-active { transition: all 0.35s ease; }
.welcome-leave-active { transition: all 0.25s ease; }
.welcome-enter-from, .welcome-leave-to { opacity: 0; transform: scale(0.97); }

/* 更新 */
.upd {
  background: transparent; color: var(--text-dim); border: 1px solid var(--border);
  border-radius: 5px; padding: 2px 9px; font-size: 12px; cursor: pointer;
}
.upd:hover { color: var(--text); border-color: var(--text-dim); }
.upd.busy { color: #4ea1ff; border-color: #4ea1ff; cursor: default; }
.upd.bad { color: #f23645; border-color: #f23645; }
.upd-progress { display: flex; align-items: center; gap: 8px; }
.upd-text { font-size: 12px; color: #4ea1ff; white-space: nowrap; }
.bar { width: 120px; height: 5px; border-radius: 3px; background: var(--border); overflow: hidden; }
.fill { height: 100%; background: #4ea1ff; transition: width 0.2s; }
</style>
