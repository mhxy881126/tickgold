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
import OrderConfirmBridge from "./components/OrderConfirmBridge.vue";
import ConnectionGuard from "./components/ConnectionGuard.vue";
import ReconciliationGuard from "./components/ReconciliationGuard.vue";
import ReminderBanner from "./components/ReminderBanner.vue";
import ToastContainer from "./components/ToastContainer.vue";
import LayoutMenu from "./components/LayoutMenu.vue";
import SceneSwitcher from "./components/SceneSwitcher.vue";
import SideDock from "./components/SideDock.vue";
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
import { useWorkbench, CARD_META, currentTimeSlot, type CardId, type Scene } from "./composables/useWorkbench";
import { NOVICE_CARDS } from "./lib/cards";
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
import { pushToast as pushAlertToast } from "./alert/bus";
import { startTimeSeries } from "./composables/useTimeSeries";
import { startCollector } from "./composables/useCollector";
import { playAlert } from "./utils/sound";
import { initPluginSystem } from "./plugin/register";
import { confirmDialog, promptDialog, useDialogState } from "./composables/useDialog";
import { toast } from "./composables/useToast";
import { useNovice } from "./composables/useNovice";
import { useLicenseStore } from "./stores/license";
import { coCancelAll } from "./broker/co";
import { requestOrder } from "./stores/quickAction";

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
const settingsInitialTab = ref<string | undefined>(undefined);
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

// ===== 方案 A：右栏只列"已开卡片"标签页（左 Dock 管"全部卡片"）=====
const dock = useDockGroups();
const addCardOpen = ref(false);
// 添加卡片菜单：按用户分组列出全部卡片（已开的置灰）
const addGroups = computed(() => dock.groups.value);
function toggleAddMenu() {
  addCardOpen.value = !addCardOpen.value;
}
// 已开卡片点击：切换主卡
function onTabPick(id: CardId) {
  if (bench.glassActive.value !== id) bench.setGlassActive(id);
}
// 添加菜单点击：打开并设为主卡
function openFromAddMenu(id: CardId) {
  if (bench.isOpen(id)) return;
  bench.open(id);
  bench.setGlassActive(id);
  addCardOpen.value = false;
}
// 点击面板外部关闭添加菜单
function onDocClickAdd(e: MouseEvent) {
  if (!addCardOpen.value) return;
  const t = e.target as HTMLElement;
  if (t.closest(".add-menu") || t.closest(".ot-add")) return;
  addCardOpen.value = false;
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

// ===== P2-b1 全局快捷键：B/S 下单方向 · C 撤销全部条件单 · W/D 直达卡片 =====
// editingSafe 缺省 false：焦点在输入框时 useActions 直接拦截，单字母键不会误伤打字。
function openCockpitFor(side: "BUY" | "SELL") {
  bench.open("cockpit");
  if (!bench.freeMode.value) bench.setGlassActive("cockpit");
  // 作战台可能尚未挂载（首次打开 / 切卡后重挂载）：方向先入队，由 BattleStation 挂载时消费。
  requestOrder(side);
}

async function cancelAllConditionalOrders() {
  // 已有弹窗（含本确认）时不叠加：confirmDialog 是单例状态，重复打开会丢前一个 Promise。
  if (useDialogState().open) return;
  const ok = await confirmDialog({
    title: "撤销全部活动条件单？",
    message:
      "将撤销所有未触发的条件单，已触发/已成交不受影响。此操作不可撤销；" +
      "关联计划指令也会被放弃。",
    confirmText: "全部撤销",
    danger: true,
  });
  if (!ok) return;
  try {
    const n = await coCancelAll();
    if (n > 0) toast.success(`已撤销 ${n} 张活动条件单`);
    else toast.info("当前没有生效中的条件单");
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    toast.error(`撤销条件单失败：${msg}`);
  }
}

registerAction({
  id: "trade.buy", title: "买入（作战台）", desc: "打开今日作战流，下单条切买入并聚焦代码框",
  category: "交易", keywords: "快捷键 B 买入 下单 作战台",
  icon: "M12 4l6 6h-4v10h-4V10H6z", defaultKeys: "B", editingSafe: false,
  run: () => openCockpitFor("BUY"),
});
registerAction({
  id: "trade.sell", title: "卖出（作战台）", desc: "打开今日作战流，下单条切卖出并聚焦代码框",
  category: "交易", keywords: "快捷键 S 卖出 下单 作战台",
  icon: "M12 20l-6-6h4V4h4v10h4z", defaultKeys: "S", editingSafe: false,
  run: () => openCockpitFor("SELL"),
});
registerAction({
  id: "trade.cancelAll", title: "撤销全部活动条件单", desc: "一次确认后撤销所有未触发的条件单",
  category: "交易", keywords: "快捷键 C 条件单 撤销 全部",
  icon: "M6 6l12 12M18 6L6 18", defaultKeys: "C", editingSafe: false,
  run: () => void cancelAllConditionalOrders(),
});
registerAction({
  id: "nav.watch", title: "自选股", desc: "打开自选股卡片",
  category: "导航", keywords: "快捷键 W 自选 卡片",
  icon: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  defaultKeys: "W", editingSafe: false,
  run: () => bench.open("watch"),
});
registerAction({
  id: "nav.chart", title: "K线图", desc: "打开 K 线图卡片",
  category: "导航", keywords: "快捷键 D K线 图表 卡片",
  icon: "M4 19h16v2H4zM6 16l4-5 3 3 4-6 3 3v3z",
  defaultKeys: "D", editingSafe: false,
  run: () => bench.open("chart"),
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

  // —— Pro 订阅授权状态（v3.0.2，启动即加载）——
  try {
    await useLicenseStore().load();
  } catch (e) {
    console.error("[app] license", e);
  }

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
      // P1-3 新手模式：首屏仅主线「今日作战流」+ 同花顺控制台；否则按时段进入默认布局。
      if (novice.novice.value) bench.setMode(NOVICE_CARDS);
      else bench.enterTimeMode(currentTimeSlot());
    }
  } catch (e) {
    console.error("[app] restore layout", e);
  }
  watch(novice.novice, (v) => {
    if (v) bench.setMode(NOVICE_CARDS);
  });
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
  // —— 右侧添加卡片菜单：点击外部关闭 ——
  document.addEventListener("click", onDocClickAdd);

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
    unlistenFns.push(await listen("open-settings", () => { settingsInitialTab.value = undefined; showSettings.value = true; }));
    unlistenFns.push(await listen("open-ai-settings", () => { settingsInitialTab.value = "ai"; showSettings.value = true; }));
    unlistenFns.push(await listen("open-pro-settings", () => { settingsInitialTab.value = "pro"; showSettings.value = true; }));
    unlistenFns.push(await listen("check-update", () => { showUpdate.value = true; }));
    unlistenFns.push(await listen("show-about", () => { showSettings.value = true; }));
    // 预警触发：写历史 + 应用内弹窗（自动消失）+ 声音 + 记录触发时间
    // 仅允许应用内提醒，不再发送任何电脑系统弹窗通知
    unlistenFns.push(
      await listen<AlertEvent>("alert:triggered", (e) => {
        const ev = e.payload;
        alerts.markFired(ev.id, ev.time);
        void alerts.addEvent(ev);
        try {
          pushAlertToast({
            key: `legacy_${ev.id}_${ev.time}`,
            title: `预警 · ${ev.label}`,
            body: ev.message,
            code: ev.code,
            tone: ev.tone,
            at: ev.time,
          });
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
    // v2.31 选股订阅：定时扫描完成，仅应用内 Toast（不发系统通知）
    unlistenFns.push(
      await listen<{ name: string; hitCount: number }>("screen-sub:run", (e) => {
        const p = e.payload;
        toast.info(`选股订阅「${p.name}」执行完成：命中 ${p.hitCount} 只`);
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
  document.removeEventListener("click", onDocClickAdd);
});
</script>

<template>
  <div class="app">
    <!-- 顶栏 -->
    <header class="topbar" :class="{ mac: isMac }" data-tauri-drag-region>
      <div class="brand" data-tauri-drag-region>TickGold</div>
      <SceneSwitcher :current-id="bench.sceneId.value" @select="applySceneGuarded" />
      <!-- 布局已统一为主卡+右导航 -->

      <SearchBox @select="onSearchSelect" />
      <div class="status">
        <span :class="quotes.polling ? 'dot on' : 'dot'"></span>
        {{ quotes.polling ? "实时" : "已暂停" }}
        <span class="sep">|</span>
        {{ Object.keys(quotes.map).length }} 只
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
    <SideDock @toggle="toggleCard" @palette="openPalette" @settings="showSettings = true" />

    <!-- 右侧主区：指数条 + 工作台 -->
    <div class="app-main">
    <!-- 行情条：指数 + 时段合并为一条紧凑行 -->
    <div class="quote-bar">
      <Indices class="idx-row" />
      <TimeTabs :active="bench.timeMode.value" @select="bench.enterTimeMode($event)" />
    </div>

    <!-- 工作台主区域 -->
    <main
      class="workspace"
      :class="{ dragging: bench.dragId.value !== null, bare: bench.openCards.value.length === 0 }"
    >
      <!-- 空台沉浸背景：铺满整个 workspace -->
      <Transition name="welcome">
        <WelcomeBoard v-if="bench.openCards.value.length === 0" />
      </Transition>

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
        <aside class="glass-edge open-tabs">
          <div class="ot-head">
            <span class="t">已开卡片</span>
            <span class="n">{{ bench.openCards.value.length }}</span>
          </div>
          <div class="ot-list">
            <div
              v-for="id in bench.openCards.value"
              :key="id"
              class="ot-item"
              :data-nav-id="id"
              :class="{ on: id === bench.glassActive.value }"
              @click="onTabPick(id)"
            >
              <span class="dt" :style="{ background: CARD_META[id]?.accent || '#8b97a8' }"></span>
              <span class="nm">{{ CARD_META[id]?.title || id }}</span>
              <span class="x" title="关闭" @click.stop="bench.close(id)">✕</span>
            </div>
            <div v-if="bench.openCards.value.length === 0" class="ot-empty">
              暂无已开卡片<br />从左侧 Dock 或下方「添加卡片」打开
            </div>
          </div>
          <div class="ot-add" @click="toggleAddMenu">＋ 添加卡片</div>

          <Teleport to="body">
          <Transition name="dpop">
            <div v-if="addCardOpen" class="add-menu" @click.stop>
              <div v-for="g in addGroups" :key="g.name" class="am-group">
                <div class="am-head"><span class="hg">{{ g.name }}</span><span class="hc">{{ g.items.length }}</span></div>
                <button
                  v-for="it in g.items"
                  :key="it.id"
                  type="button"
                  class="am-item"
                  :data-card-id="it.id"
                  :class="{ disabled: bench.isOpen(it.id) }"
                  @click="openFromAddMenu(it.id)"
                >
                  <span class="mi"><svg viewBox="0 0 24 24"><path fill="currentColor" :d="it.icon" /></svg></span>
                  <span class="nm">{{ CARD_META[it.id]?.title || it.label }}</span>
                  <span v-if="bench.isOpen(it.id)" class="gn">已开</span>
                </button>
              </div>
            </div>
          </Transition>
          </Teleport>
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
    <SettingsDialog v-model:open="showSettings" :initial-tab="settingsInitialTab as any" @replay-onboarding="showOnboarding = true" @check-update="showUpdate = true" />
    <ShortcutDialog v-model:open="showShortcuts" />
    <OnboardingDialog v-model:open="showOnboarding" />
    <!-- P0-5 全局下单确认桥：所有下单入口统一的金额醒目 + 硬校验核对 -->
    <OrderConfirmBridge />
    <!-- P0-3 断连闭环 + 重连对账横幅 -->
    <ConnectionGuard />
    <ReconciliationGuard />
    <!-- P1-c 8:45 盘前确认提醒（App 级横幅，点击直达作战流） -->
    <ReminderBanner />
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
