<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, provide, watch, nextTick } from "vue";
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

// ===== 顶部功能导航：6 大功能域（Mega 菜单 + 命令面板共用）=====
interface DockItem {
  id: CardId;
  label: string;
  icon: string;
  desc: string;
  star?: boolean;
}
interface DockGroup {
  name: string;
  icon: string;
  items: DockItem[];
}
const DOCK_GROUPS: DockGroup[] = [
  {
    name: "大盘总览",
    icon: "M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z",
    items: [
      { id: "watch", label: "自选", icon: "M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z", desc: "我的股票分组实时行情", star: true },
      { id: "rank", label: "榜单", icon: "M3 5h18v2H3zm0 4h18v2H3zm0 4h12v2H3zm0 4h12v2H3z", desc: "全市场涨幅/跌幅/成交额排名", star: true },
      { id: "breadth", label: "市场宽度", icon: "M3 12h4l3-8 4 16 3-8h4", desc: "上涨/下跌家数分时曲线" },
      { id: "dist", label: "涨跌分布", icon: "M3 21h2v-7H3zm4 0h2V9H7zm4 0h2V5h-2zm4 0h2v-9h-2zm4 0h2V11h-2z", desc: "涨跌幅十档家数分布" },
    ],
  },
  {
    name: "盯盘模式",
    icon: "M12 2A10 10 0 1 0 22 12h-2A8 8 0 1 1 12 4zM12 6v6l5 2-1 1.7L11 13V6z",
    items: [
      { id: "radarsweep", label: "雷达扫盘", icon: "M12 2A10 10 0 1 0 22 12h-2A8 8 0 1 1 12 4zM12 6v6l5 2-1 1.7L11 13V6z", desc: "圆形雷达三栏全屏扫盘", star: true },
      { id: "reviewtimeline", label: "复盘时间线", icon: "M12 3a2 2 0 100 4 2 2 0 000-4zm0 7a2 2 0 100 4 2 2 0 000-4zm0 7a2 2 0 100 4 2 2 0 000-4z", desc: "全天异动时间线 + 当日总结" },
      { id: "multigrid", label: "多股同列", icon: "M3 3h5v5H3zm6.5 0h5v5h-5zM16 3h5v5h-5zM3 9.5h5v5H3zm6.5 0h5v5h-5zM16 9.5h5v5h-5zM3 16h5v5H3zm6.5 0h5v5h-5zM16 16h5v5h-5z", desc: "自选 9 只 分时/K线/盘口同屏" },
      { id: "heatmatrix", label: "热力矩阵", icon: "M3 4h7v4H3zm9 0h9v4h-9zM3 10h9v4H3zm11 0h7v4h-7zM3 16h7v4H3zm9 0h9v4h-9z", desc: "全市场板块热力矩阵" },
      { id: "bentofocus", label: "Bento聚焦", icon: "M3 3h8v5H3zm9 0h9v9h-9zM3 9h5v12H3zm6 6h12v6H9z", desc: "6 卡不规则总览，点按聚焦" },
      { id: "telegraph", label: "电报墙", icon: "M4 11a8 8 0 0116 0M7 11a5 5 0 0110 0M10 11a2 2 0 014 0M12 13v8", desc: "三列异动电报实时滚动" },
    ],
  },
  {
    name: "情绪异动",
    icon: "M13 2 3 14h7l-1 8 10-12h-7l1-8z",
    items: [
      { id: "radar", label: "涨停雷达", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a6 6 0 100 12 6 6 0 000-12zm0 3a3 3 0 100 6 3 3 0 000-6z", desc: "涨停/炸板/连板/情绪统计", star: true },
      { id: "spider", label: "短线精灵", icon: "M13 2 3 14h7l-1 8 10-12h-7l1-8z", desc: "活跃股盘中实时异动" },
      { id: "alert", label: "预警", icon: "M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C8.63 5.36 7 7.92 7 11v5l-2 2v1h14v-1l-2-2z", desc: "价格/涨跌幅触发推送" },
      { id: "news", label: "快讯", icon: "M5 3h14a2 2 0 012 2v11a2 2 0 01-2 2H8l-4 3V5a2 2 0 011-2z", desc: "7x24 全球财经直播" },
    ],
  },
  {
    name: "板块题材",
    icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm-1 2.06V11H4.06A8 8 0 0111 4.06zM4 13h7v6.94A8 8 0 014 13zm9 6.94V13h6.94A8 8 0 0113 19.94zM19.94 11H13V4.06A8 8 0 0119.94 11z",
    items: [
      { id: "sector", label: "板块行情", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm-1 2.06V11H4.06A8 8 0 0111 4.06zM4 13h7v6.94A8 8 0 014 13zm9 6.94V13h6.94A8 8 0 0113 19.94zM19.94 11H13V4.06A8 8 0 0119.94 11z", desc: "行业/概念板块排名" },
      { id: "sectorheat", label: "板块热力图", icon: "M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z", desc: "板块 treemap 缩放平移" },
      { id: "sectorevent", label: "板块异动", icon: "M3 12h4l3-8 4 16 3-8h4", desc: "板块拉升/跳水捕捉" },
      { id: "theme", label: "题材轮动", icon: "M12 5l7 3.5-7 3.5L5 8.5 12 5zM5 12l7 3.5L19 12M5 15.5l7 3.5 7-3.5", desc: "热门概念标签云" },
    ],
  },
  {
    name: "个股行情",
    icon: "M6 3h2v4H6zm0 14h2v4H6zM5 8h4v8H5zm11-9h2v3h-2zm0 12h2v5h-2zm-1-7h4v7h-4z",
    items: [
      { id: "chart", label: "K线/分时", icon: "M6 3h2v4H6zm0 14h2v4H6zM5 8h4v8H5zm11-9h2v3h-2zm0 12h2v5h-2zm-1-7h4v7h-4z", desc: "日周月 K + 当日分时", star: true },
      { id: "order", label: "五档盘口", icon: "M5 3h14v18H5zm2 4h10v2H7zm0 4h10v2H7zm0 4h7v2H7z", desc: "买卖五档 + 今日概览" },
      { id: "fundflow", label: "资金流向", icon: "M12 3c-4 0-7 1.3-7 3v12c0 1.7 3 3 7 3s7-1.3 7-3V6c0-1.7-3-3-7-3zm0 2c3.3 0 5 .9 5 1s-1.7 1-5 1-5-.9-5-1 1.7-1 5-1zm-5 4.5c1.2.8 3 1.3 5 1.3s3.8-.5 5-1.3V12c0 .1-1.7 1-5 1s-5-.9-5-1zm0 4c1.2.8 3 1.3 5 1.3s3.8-.5 5-1.3V16c0 .1-1.7 1-5 1s-5-.9-5-1z", desc: "主力/散户 四档资金" },
      { id: "f10", label: "F10资料", icon: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm0 2l4 4h-4V4zM8 13h8v1.5H8zm0 4h8v1.5H8zm0-8h5v1.5H8z", desc: "公司/财务/筹码分布" },
    ],
  },
  {
    name: "交易工具",
    icon: "M5 3h14a1 1 0 011 1v16a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1z",
    items: [
      { id: "screener", label: "条件选股", icon: "M4 5h3v14H4zm6.5 5h3v9h-3zM17 9h3v10h-3z", desc: "技术/基本面智能选股" },
      { id: "trade", label: "模拟交易", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm1 5v1.1c1.7.3 3 1.4 3 3.1 0 1.9-1.5 2.8-3.4 2.8-1.2 0-2.1-.4-2.6-1l1.2-1c.3.4.8.7 1.5.7.8 0 1.3-.3 1.3-.8s-.4-.8-1.5-1c-1.6-.4-3.2-1-3.2-2.9 0-1.6 1.3-2.7 3-3V5h2zm-1 11h2v2h-2z", desc: "虚拟资金 T+1 练盘" },
      { id: "journal", label: "盯盘日记", icon: "M5 3h14a1 1 0 011 1v16a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1zm3 5h8v1.5H8zm0 4h8v1.5H8zm0 4h5v1.5H8z", desc: "交易复盘记录" },
      { id: "calendar", label: "财经日历", icon: "M7 2v2H5a2 2 0 00-2 2v13a2 2 0 002 2h14a2 2 0 002-2V6a2 0 002-2 0 00-2-2h-2V2h-2v2H9V2H7zm-2 7h14v10H5V9zm2 2v3h3v-3H7zm5 0v3h3v-3z", desc: "休市安排/事件提醒" },
      { id: "ipo", label: "新股解禁", icon: "M12 2l2.9 6.3 6.8.7-5 4.6 1.4 6.7L12 17l-6.1 3.3 1.4-6.7-5-4.6 6.8-.7z", desc: "新股/解禁日历" },
      { id: "calc", label: "投资计算器", icon: "M7 2h10a2 2 0 012 2v16a2 2 0 01-2 2H7a2 2 0 01-2-2V4a2 2 0 012-2zm2 4h6v2H9V6zm0 4h2v2H9v-2zm4 0h2v2h-2v-2zm-4 4h2v2H9v-2zm4 0h2v2h-2v-2z", desc: "盈亏/仓位/风报比/黄金分割" },
      { id: "export", label: "数据导出", icon: "M12 3a1 1 0 011 1v8.6l3.3-3.3 1.4 1.4L12 17l-5.7-6.3 1.4-1.4L11 12.6V4a1 1 0 011-1zM5 19h14v2H5v-2z", desc: "CSV/JSON 导出自选/行情/交易" },
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

// ===== 命令面板（Ctrl / ⌘ + K）=====
const paletteOpen = ref(false);
const paletteQuery = ref("");
const pSel = ref(0);
const pInput = ref<HTMLInputElement | null>(null);
interface PaletteRow extends DockItem {
  cat: string;
}
const paletteAll: PaletteRow[] = DOCK_GROUPS.flatMap((g) =>
  g.items.map((it) => ({ ...it, cat: g.name }))
);
const pFiltered = computed<PaletteRow[]>(() => {
  const q = paletteQuery.value.trim().toLowerCase();
  if (!q)
    return paletteAll
      .filter((r) => r.star)
      .concat(paletteAll.filter((r) => !r.star));
  return paletteAll.filter((r) =>
    (r.label + r.desc + r.cat).toLowerCase().includes(q)
  );
});
watch(pFiltered, () => {
  pSel.value = 0;
});
function openPalette() {
  paletteOpen.value = true;
  paletteQuery.value = "";
  pSel.value = 0;
  nextTick(() => pInput.value?.focus());
}
function closePalette() {
  paletteOpen.value = false;
}
function runPalette(r?: PaletteRow) {
  const t = r ?? pFiltered.value[pSel.value];
  if (!t) return;
  toggleCard(t.id);
  closePalette();
}
function onGlobalKey(e: KeyboardEvent) {
  if (bench.isFocused.value && e.key === "Escape") {
    e.preventDefault();
    exitFocus();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    paletteOpen.value ? closePalette() : openPalette();
    return;
  }
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

// ===== 卡片聚焦：主从分屏 + FLIP 共享元素入场 =====
const focusTargetEl = ref<HTMLElement | null>(null);
const focusClosing = ref(false);
const overlayShow = computed(() => bench.isFocused.value || focusClosing.value);
const railCards = computed(() => bench.openCards.value);
let originRects: Record<string, DOMRect> = {};

function slotEls(): HTMLElement[] {
  const sel = bench.freeMode.value ? ".free-cell" : ".card-slot";
  return [...document.querySelectorAll(sel)] as HTMLElement[];
}
// 把所有卡片固定(fixed)在当前视觉位置，脱离网格、避免重排
function freezeSlots() {
  originRects = {};
  slotEls().forEach((el) => {
    const cid = el.getAttribute("data-card-id") as string;
    const r = el.getBoundingClientRect();
    originRects[cid] = r;
    el.style.transition = "none";
    el.style.position = "fixed";
    el.style.margin = "0";
    el.style.left = r.left + "px";
    el.style.top = r.top + "px";
    el.style.width = r.width + "px";
    el.style.height = r.height + "px";
    el.style.zIndex = "40";
  });
}
const FTRANS =
  "left .44s cubic-bezier(.32,.78,.3,1),top .44s cubic-bezier(.32,.78,.3,1),width .44s cubic-bezier(.32,.78,.3,1),height .44s cubic-bezier(.32,.78,.3,1)";
function placeAt(el: HTMLElement, r: { left: number; top: number; width: number; height: number }) {
  el.style.transition = FTRANS;
  el.style.left = r.left + "px";
  el.style.top = r.top + "px";
  el.style.width = r.width + "px";
  el.style.height = r.height + "px";
}
function enterFocus(id: CardId) {
  if (bench.isFocused.value) {
    switchFocus(id);
    return;
  }
  freezeSlots();
  focusClosing.value = false;
  bench.focus(id);
  nextTick(() => {
    const t = focusTargetEl.value!.getBoundingClientRect();
    void document.body.offsetWidth;
    slotEls().forEach((el) => {
      if (el.getAttribute("data-card-id") === id) {
        placeAt(el, t);
        el.style.zIndex = "70";
      }
    });
  });
}
function switchFocus(id: CardId) {
  if (id === bench.focusId.value) return;
  const t = focusTargetEl.value!.getBoundingClientRect();
  const old = bench.focusId.value;
  slotEls().forEach((el) => {
    const cid = el.getAttribute("data-card-id") as string;
    if (cid === id) {
      placeAt(el, t);
      el.style.zIndex = "70";
    } else if (cid === old) {
      placeAt(el, originRects[cid]);
      el.style.zIndex = "40";
    }
  });
  bench.focus(id);
}
function exitFocus() {
  if (!bench.isFocused.value) return;
  const fid = bench.focusId.value as CardId;
  focusClosing.value = true;
  slotEls().forEach((el) => {
    if (el.getAttribute("data-card-id") !== fid) return;
    if (originRects[fid]) placeAt(el, originRects[fid]);
    else {
      // 聚焦中新增、无原位记录的卡：淡出，避免 placeAt(undefined)
      el.style.transition = "opacity .3s ease";
      el.style.opacity = "0";
    }
  });
  setTimeout(() => {
    bench.clearSlotInline();
    bench.restoreFocus();
    focusClosing.value = false;
  }, 460);
}

// 统一卡片开关：聚焦态打开新卡 → 直接作为主卡（addAndFocus）
function toggleCard(id: CardId) {
  if (bench.isOpen(id)) {
    bench.close(id);
    return;
  }
  if (bench.isFocused.value) addAndFocus(id);
  else bench.open(id);
}
// 聚焦态新增卡片：新卡直接 fixed 到主区，旧主卡缩回原位
function addAndFocus(id: CardId) {
  const old = bench.focusId.value;
  bench.open(id);
  bench.focus(id);
  nextTick(() => {
    const t = focusTargetEl.value!.getBoundingClientRect();
    const ne = slotEls().find((e) => e.getAttribute("data-card-id") === id);
    if (ne) {
      ne.style.transition = FTRANS;
      ne.style.position = "fixed";
      ne.style.margin = "0";
      ne.style.left = t.left + "px";
      ne.style.top = t.top + "px";
      ne.style.width = t.width + "px";
      ne.style.height = t.height + "px";
      ne.style.zIndex = "70";
    }
    if (old) {
      const oe = slotEls().find((e) => e.getAttribute("data-card-id") === old);
      if (oe) {
        placeAt(oe, originRects[old]);
        oe.style.zIndex = "40";
      }
    }
  });
}
// 聚焦中窗口尺寸变化：主卡跟随新目标
function refitFocus() {
  if (!bench.isFocused.value || !focusTargetEl.value) return;
  const t = focusTargetEl.value.getBoundingClientRect();
  slotEls().forEach((el) => {
    if (el.getAttribute("data-card-id") === bench.focusId.value) {
      el.style.transition = "left .2s,top .2s,width .2s,height .2s";
      el.style.left = t.left + "px";
      el.style.top = t.top + "px";
      el.style.width = t.width + "px";
      el.style.height = t.height + "px";
    }
  });
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

  // —— 全局快捷键（命令面板 Ctrl/⌘ + K 等）——
  try {
    window.addEventListener("keydown", onGlobalKey);
    window.addEventListener("resize", refitFocus);
  } catch (e) {
    console.error("[app] hotkey", e);
  }

  // —— 事件监听 ——
  try {
    unlistenFns.push(
      await listen<string>("island:select", (e) => {
        const c = e.payload;
        if (!wl.codes.includes(c)) wl.add(c);
        pickStock(c);
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
  window.removeEventListener("keydown", onGlobalKey);
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
          <span class="mr-sep"></span>
          <button
            v-for="(m, i) in MODE_NAV"
            :key="'m' + i"
            type="button"
            class="layout-preset"
            :class="{ on: isMode(m.cards) }"
            :title="m.label + '布局'"
            @click="bench.setMode(m.cards)"
          >
            <svg viewBox="0 0 24 24"><path fill="currentColor" :d="m.icon" /></svg>
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
            :data-card-id="id"
            :class="{ dragging: bench.freeDrag.value?.id === id }"
            :style="bench.freeCellStyle(id)"
          >
            <CardShell
              :title="CARD_META[id].title"
              :accent="CARD_META[id].accent"
              free-drag
              :focused="bench.focusId.value === id"
              @close="bench.close(id)"
              @focus="enterFocus(id)"
              @restore="exitFocus"
              @grab="(e: PointerEvent) => bench.startFreeDrag(e, id)"
            >
              <CardContent
                :id="id"
                :selected="selected"
                :compact="bench.isFocused.value ? id !== bench.focusId.value && bench.timeMode.value !== null : bench.timeMode.value !== null"
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
            :focused="bench.focusId.value === id"
            @close="bench.close(id)"
            @focus="enterFocus(id)"
            @restore="exitFocus"
            @pdrag="(e: PointerEvent) => bench.pointerDragStart(id, e)"
          >
            <CardContent
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

    <!-- 软件更新对话框 -->
    <UpdateDialog v-model:open="showUpdate" />
    <!-- 设置对话框 -->
    <SettingsDialog v-model:open="showSettings" />

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

/* ===== Mega 功能导航 ===== */
.mega-nav {
  position: relative;
  grid-column: 1;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  z-index: 40;
}
.mega-tabs {
  display: flex;
  align-items: stretch;
  height: 44px;
  padding: 0 8px;
  gap: 2px;
}
.mega-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 13px;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  position: relative;
  transition: color 0.16s, background 0.16s;
}
.mt-ic { width: 15px; height: 15px; flex: none; opacity: 0.85; }
.mega-tab:hover { color: var(--text); background: var(--bg-hover); }
.mega-tab:hover .mt-ic { color: var(--accent-2); opacity: 1; }
.mega-tab.on { color: var(--accent-2); }
.mega-tab.on .mt-ic { color: var(--accent-2); opacity: 1; }
.mega-tab.on::after {
  content: "";
  position: absolute; left: 12px; right: 12px; bottom: 0;
  height: 2px; border-radius: 2px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
}

.mega-right { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.palette-btn {
  display: flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 8px 0 10px;
  border: 1px solid var(--border); border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text); font-size: 12px; cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.pb-ic { width: 14px; height: 14px; color: var(--accent-2); }
.pb-k {
  font-family: inherit; font-size: 10px; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px;
}
.palette-btn:hover { border-color: var(--accent); }
.mr-sep { width: 1px; height: 20px; background: var(--border); margin: 0 3px; }
.layout-preset {
  width: 30px; height: 28px; border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--text-dim); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.layout-preset svg { width: 15px; height: 15px; }
.layout-preset:hover { color: var(--text); background: var(--bg-hover); }
.layout-preset.on {
  color: var(--accent-2);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

/* Mega 下拉面板 */
.mega-panel {
  position: absolute;
  top: 100%; left: 0; right: 0;
  background: color-mix(in srgb, var(--bg-panel) 96%, transparent);
  backdrop-filter: blur(18px);
  border-bottom: 1px solid var(--border);
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.45);
  padding: 12px 16px 16px;
  z-index: 45;
}
.mp-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; }
.mp-head h3 { margin: 0; font-size: 14px; color: var(--accent-2); }
.mp-head span { font-size: 11px; color: var(--text-dim); }
.mp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 8px;
}
.mp-item {
  position: relative;
  display: grid;
  grid-template-columns: 32px 1fr;
  grid-template-rows: auto auto;
  align-items: center;
  column-gap: 10px;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 11px;
  background: var(--bg);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, transform 0.15s, background 0.15s;
}
.mpi-ic {
  grid-row: 1 / 3;
  width: 32px; height: 32px; border-radius: 9px;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--accent) 13%, transparent);
  color: var(--accent-2);
}
.mpi-ic svg { width: 17px; height: 17px; }
.mpi-t { font-size: 12.5px; font-weight: 700; line-height: 1.2; }
.mpi-d { font-size: 10.5px; color: var(--text-dim); line-height: 1.3; margin-top: 2px; }
.mpi-star { position: absolute; top: 7px; right: 8px; width: 11px; height: 11px; color: var(--accent); }
.mp-item:hover {
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  transform: translateY(-2px);
}
.mp-item.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--bg)); }
.mp-item.on .mpi-t::after { content: " · 已开"; color: var(--accent-2); font-weight: 500; font-size: 10px; }

/* Mega 面板过渡 */
.mpanel-enter-active { transition: opacity 0.2s ease, transform 0.2s ease; transform-origin: top center; }
.mpanel-leave-active { transition: opacity 0.14s ease, transform 0.14s ease; transform-origin: top center; }
.mpanel-enter-from, .mpanel-leave-to { opacity: 0; transform: translateY(-8px) scaleY(0.98); }

/* ===== 命令面板 ===== */
.palette-mask {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(5, 8, 12, 0.55);
  backdrop-filter: blur(3px);
  display: flex; justify-content: center; align-items: flex-start;
  padding-top: 13vh;
}
.palette {
  width: min(640px, 92vw);
  background: var(--bg-panel);
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: 16px;
  box-shadow: 0 32px 80px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}
.p-search { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.ps-ic { width: 18px; height: 18px; color: var(--accent-2); flex: none; }
.ps-input { flex: 1; border: 0; background: transparent; color: var(--text); font-size: 15px; outline: none; }
.ps-input::placeholder { color: var(--text-dim); }
.ps-esc {
  font-family: inherit; font-size: 10px; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px;
}
.p-list { max-height: 46vh; overflow-y: auto; padding: 8px; }
.p-opt {
  display: flex; align-items: center; gap: 11px; width: 100%;
  padding: 8px 10px; border: 0; border-radius: 10px;
  background: transparent; color: var(--text); text-align: left; cursor: pointer;
}
.po-ic {
  width: 30px; height: 30px; flex: none; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent-2);
}
.po-ic svg { width: 16px; height: 16px; }
.po-tx { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.po-tx b { font-size: 13px; font-weight: 700; }
.po-tx em {
  font-size: 11px; color: var(--text-dim); font-style: normal;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.po-cat {
  font-size: 10.5px; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 5px;
  padding: 2px 7px; white-space: nowrap;
}
.p-opt.sel { background: color-mix(in srgb, var(--accent) 15%, transparent); }
.p-opt.sel .po-cat { border-color: color-mix(in srgb, var(--accent) 45%, transparent); color: var(--accent-2); }
.p-empty { padding: 30px; text-align: center; color: var(--text-dim); font-size: 12.5px; }
.p-foot {
  display: flex; align-items: center; gap: 16px;
  padding: 9px 16px; border-top: 1px solid var(--border);
  font-size: 11px; color: var(--text-dim);
}
.p-foot kbd {
  font-family: inherit; font-size: 10px; color: var(--text);
  border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; margin-right: 3px;
}
.p-foot .cnt { margin-left: auto; }

/* 命令面板过渡 */
.palette-enter-active { transition: opacity 0.18s ease; }
.palette-enter-active .palette { animation: paletteIn 0.22s cubic-bezier(0.2, 0.8, 0.2, 1); }
.palette-leave-active { transition: opacity 0.13s ease; }
.palette-enter-from, .palette-leave-to { opacity: 0; }
@keyframes paletteIn {
  from { opacity: 0; transform: translateY(-10px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

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

/* ===== 卡片聚焦（主从分屏 + FLIP 共享元素入场）===== */
.focus-backdrop {
  position: fixed; inset: 0; z-index: 50;
  background: rgba(5, 7, 11, 0.62);
  animation: fIn 0.35s ease both;
}
.focus-backdrop.closing { animation: fOut 0.3s ease both; }
.focus-target {
  position: fixed; left: 12px; top: 124px; right: 306px; bottom: 12px;
  visibility: hidden; pointer-events: none;
}
.focus-rail {
  position: fixed; top: 124px; right: 12px; bottom: 12px; width: 282px; z-index: 80;
  display: flex; flex-direction: column; gap: 8px; overflow-y: auto; padding: 4px;
  pointer-events: none;
  animation: rIn 0.45s cubic-bezier(0.2, 0.8, 0.3, 1) both;
}
.focus-rail.closing { animation: rOut 0.28s ease both; }
.rail-item {
  display: flex; align-items: center; gap: 9px; flex: none;
  pointer-events: auto;
  padding: 10px 11px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-card); color: var(--text);
  cursor: pointer; text-align: left; transition: 0.16s;
}
.rail-item:hover { border-color: var(--border-light); transform: translateX(-2px); }
.rail-item.cur {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-card));
}
.ri-bar { width: 3px; height: 15px; border-radius: 2px; flex: none; }
.ri-title {
  flex: 1; font-size: 12px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ri-chev { width: 13px; height: 13px; color: var(--text-dim); flex: none; }
.rail-item.cur .ri-chev { color: var(--accent); }
@keyframes fIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes fOut { to { opacity: 0; } }
@keyframes rIn { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }
@keyframes rOut { to { opacity: 0; transform: translateX(20px); } }
</style>
