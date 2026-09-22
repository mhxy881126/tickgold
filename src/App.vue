<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import CardShell from "./components/CardShell.vue";
import UpdateDialog from "./components/UpdateDialog.vue";
import ShortTermSpider from "./components/ShortTermSpider.vue";
import LimitRadar from "./components/LimitRadar.vue";
import WatchList from "./components/WatchList.vue";
import Indices from "./components/Indices.vue";
import RankBoard from "./components/RankBoard.vue";
import RightPanel from "./components/RightPanel.vue";
import FundFlow from "./components/FundFlow.vue";
import SectorBoard from "./components/SectorBoard.vue";
import SectorHeatmap from "./components/SectorHeatmap.vue";
import SectorEvents from "./components/SectorEvents.vue";
import Screener from "./components/Screener.vue";
import SearchBox from "./components/SearchBox.vue";
import StockChart from "./components/StockChart.vue";
import { useWatchlistStore } from "./stores/watchlist";
import { useQuotesStore } from "./stores/quotes";
import { useAlertStore } from "./stores/alert";
import { useWorkbench, CARD_META, MODES, type CardId } from "./composables/useWorkbench";

const wl = useWatchlistStore();
const quotes = useQuotesStore();
const alerts = useAlertStore();
const bench = useWorkbench();

const selected = ref<string | null>(null);

// ===== 左导航：卡片开关 =====
const CARD_NAV: { id: CardId; label: string; icon: string }[] = [
  { id: "watch", label: "自选", icon: "M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" },
  { id: "rank", label: "榜单", icon: "M3 5h18v2H3zm0 4h18v2H3zm0 4h12v2H3zm0 4h12v2H3z" },
  { id: "radar", label: "雷达", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a6 6 0 100 12 6 6 0 000-12zm0 3a3 3 0 100 6 3 3 0 000-6z" },
  { id: "chart", label: "K线", icon: "M6 3h2v4H6zm0 14h2v4H6zM5 8h4v8H5zm11-9h2v3h-2zm0 12h2v5h-2zm-1-7h4v7h-4z" },
  { id: "spider", label: "精灵", icon: "M13 2 3 14h7l-1 8 10-12h-7l1-8z" },
  { id: "sector", label: "板块", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm-1 2.06V11H4.06A8 8 0 0111 4.06zM4 13h7v6.94A8 8 0 014 13zm9 6.94V13h6.94A8 8 0 0113 19.94zM19.94 11H13V4.06A8 8 0 0119.94 11z" },
  { id: "sectorheat", label: "热力", icon: "M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z" },
  { id: "sectorevent", label: "板动", icon: "M3 12h4l3-8 4 16 3-8h4" },
  { id: "screener", label: "选股", icon: "M4 5h3v14H4zm6.5 5h3v9h-3zM17 9h3v10h-3z" },
  { id: "order", label: "盘口", icon: "M5 3h14v18H5zm2 4h10v2H7zm0 4h10v2H7zm0 4h7v2H7z" },
  { id: "fundflow", label: "资金", icon: "M12 3c-4 0-7 1.3-7 3v12c0 1.7 3 3 7 3s7-1.3 7-3V6c0-1.7-3-3-7-3zm0 2c3.3 0 5 .9 5 1s-1.7 1-5 1-5-.9-5-1 1.7-1 5-1zm-5 4.5c1.2.8 3 1.3 5 1.3s3.8-.5 5-1.3V12c0 .1-1.7 1-5 1s-5-.9-5-1zm0 4c1.2.8 3 1.3 5 1.3s3.8-.5 5-1.3V16c0 .1-1.7 1-5 1s-5-.9-5-1z" },
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

let unlisten: (() => void) | null = null;
watch(() => quotes.map, (m) => alerts.evaluate(m), { deep: true });

onMounted(async () => {
  try {
    curVersion.value = await getVersion();
    await wl.load();
    await alerts.load();
    if (wl.codes.length) {
      selected.value = wl.codes[0];
      bench.setMode(MODES.pro);
    }
    quotes.start(2000);
    unlisten = await listen<string>("island:select", (e) => {
      selected.value = e.payload;
      if (!wl.codes.includes(e.payload)) wl.add(e.payload);
      bench.open("chart");
    });
  } catch (e) {
    console.error("[app] init failed", e);
  }
});
onBeforeUnmount(() => { if (unlisten) unlisten(); });
</script>

<template>
  <div class="app">
    <!-- 顶栏 -->
    <header class="topbar">
      <div class="brand">TickGold</div>
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
        <button class="upd" @click="showUpdate = true">检查更新</button>
      </div>
    </header>

    <!-- 指数条 -->
    <Indices class="idx-row" />

    <!-- 左窄导航 -->
    <nav class="leftnav">
      <div
        v-for="item in CARD_NAV"
        :key="item.id"
        class="nav-item"
        :class="{ on: bench.isOpen(item.id) }"
        :title="item.label"
        @click="bench.toggle(item.id)"
      >
        <svg viewBox="0 0 24 24" class="nav-ic"><path fill="currentColor" :d="item.icon" /></svg>
        <span class="nav-lb">{{ item.label }}</span>
      </div>

      <div class="nav-sep"></div>

      <div
        v-for="(m, i) in MODE_NAV"
        :key="'m' + i"
        class="nav-item"
        :class="{ on: isMode(m.cards) }"
        :title="m.label + '布局'"
        @click="bench.setMode(m.cards)"
      >
        <svg viewBox="0 0 24 24" class="nav-ic"><path fill="currentColor" :d="m.icon" /></svg>
        <span class="nav-lb">{{ m.label }}</span>
      </div>
    </nav>

    <!-- 工作台主区域 -->
    <main class="workspace">
      <!-- 默认欢迎页（无卡片时） -->
      <Transition name="welcome">
        <div v-if="bench.openCards.value.length === 0" class="welcome">
          <div class="w-logo">TG</div>
          <h1 class="w-title">TickGold 盯盘工作台</h1>
          <p class="w-sub">从左侧打开功能卡片，或选择一个布局模式快速开始</p>
          <div class="w-btns">
            <button class="w-btn primary" @click="bench.setMode(MODES.pro)">专业盯盘</button>
            <button class="w-btn" @click="bench.setMode(MODES.sector)">板块模式</button>
            <button class="w-btn" @click="bench.setMode(MODES.scanner)">选股模式</button>
            <button class="w-btn" @click="bench.setMode(MODES.full)">全屏布局</button>
          </div>
        </div>
      </Transition>

      <!-- 卡片网格 -->
      <TransitionGroup
        tag="div"
        class="card-grid"
        enter-active-class="card-enter"
        leave-active-class="card-leave"
        move-class="card-move"
      >
        <div
          v-for="id in bench.openCards.value"
          :key="id"
          class="card-slot"
          :style="bench.layout.value[id]"
        >
          <CardShell
            :title="CARD_META[id].title"
            :accent="CARD_META[id].accent"
            @close="bench.close(id)"
          >
            <WatchList
              v-if="id === 'watch'"
              :selected="selected"
              @select="onSelect"
            />
            <RankBoard
              v-else-if="id === 'rank'"
              @select="onSelect"
            />
            <div v-else-if="id === 'chart'" class="chart-card">
              <StockChart v-if="selected" :key="selected" :code="selected" />
              <div v-else class="card-empty">从自选或榜单选择一只股票</div>
            </div>
            <LimitRadar v-else-if="id === 'radar'" @select="onSelect" />
            <ShortTermSpider v-else-if="id === 'spider'" @select="onSelect" />
            <SectorBoard v-else-if="id === 'sector'" @select="onSelect" />
            <SectorHeatmap v-else-if="id === 'sectorheat'" @select="onSelect" />
            <SectorEvents v-else-if="id === 'sectorevent'" @select="onSelect" />
            <Screener v-else-if="id === 'screener'" @select="onSelect" />
            <FundFlow v-else-if="id === 'fundflow'" :code="selected" />
            <RightPanel v-else :code="selected" />
          </CardShell>
        </div>
      </TransitionGroup>
    </main>

    <!-- 软件更新对话框 -->
    <UpdateDialog v-model:open="showUpdate" />
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-rows: 38px 32px 1fr;
  grid-template-columns: 46px 1fr;
  height: 100vh;
}

/* 顶栏 */
.topbar {
  grid-column: 1 / 3;
  display: flex; align-items: center; gap: 14px;
  padding: 0 12px; background: var(--bg-panel); border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}
.brand { font-weight: 700; color: var(--accent); white-space: nowrap; }
.status { flex: 1; display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-dim); justify-content: flex-end; -webkit-app-region: no-drag; }
.sep { margin: 0 8px; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #555; margin-right: 5px; }
.dot.on { background: #26d07c; }
.ver { opacity: 0.8; }

/* 指数条 */
.idx-row { grid-column: 1 / 3; }

/* 左导航 */
.leftnav {
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column; align-items: center;
  padding: 8px 0; gap: 3px;
  overflow-y: auto;
}
.nav-item {
  width: 40px; padding: 6px 0; border-radius: 7px; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; color: var(--text-dim);
  transition: all 0.15s;
}
.nav-ic { width: 17px; height: 17px; }
.nav-lb { font-size: 10px; margin-top: 3px; }
.nav-item:hover { color: var(--text); background: var(--bg-hover); }
.nav-item.on { color: var(--accent); background: #16233a; }
.nav-sep { width: 24px; height: 1px; background: var(--border); margin: 5px 0; }

/* 工作台 */
.workspace {
  position: relative;
  min-width: 0;
  min-height: 0;
  padding: 12px;
  overflow: hidden;
}
.card-grid {
  position: relative;
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  grid-template-rows: repeat(6, 1fr);
  gap: 12px;
  height: 100%;
}
.card-slot { min-width: 0; min-height: 0; }

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

/* 默认欢迎页 */
.welcome {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  z-index: 5;
}
.welcome-enter-active { transition: all 0.35s ease; }
.welcome-leave-active { transition: all 0.25s ease; }
.welcome-enter-from, .welcome-leave-to { opacity: 0; transform: scale(0.96); }

.w-logo {
  width: 64px; height: 64px; border-radius: 18px;
  display: flex; align-items: center; justify-content: center;
  font-size: 24px; font-weight: 700; color: #1a1a1a;
  background: linear-gradient(135deg, #e8c66a, #c8992e);
  box-shadow: 0 8px 28px rgba(212, 175, 55, 0.4);
  margin-bottom: 20px;
}
.w-title { font-size: 22px; font-weight: 700; margin: 0 0 8px; }
.w-sub { font-size: 13px; color: var(--text-dim); margin: 0 0 28px; }
.w-btns { display: flex; gap: 12px; }
.w-btn {
  padding: 9px 22px; border-radius: 8px; font-size: 13px; cursor: pointer;
  background: var(--bg-panel); border: 1px solid var(--border); color: var(--text);
  transition: all 0.15s;
}
.w-btn:hover { border-color: var(--text-dim); }
.w-btn.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
.w-btn.primary:hover { background: #3d7bf5; }

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
