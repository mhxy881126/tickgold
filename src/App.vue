<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { listen } from "@tauri-apps/api/event";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import WatchList from "./components/WatchList.vue";
import StockChart from "./components/StockChart.vue";
import { useWatchlistStore } from "./stores/watchlist";
import { useQuotesStore } from "./stores/quotes";
import { useAlertStore } from "./stores/alert";

const wl = useWatchlistStore();
const quotes = useQuotesStore();
const alerts = useAlertStore();

const selected = ref<string | null>(null);
const updateState = ref<"idle" | "checking" | "available" | "uptodate" | "error">("idle");

async function checkUpdate() {
  updateState.value = "checking";
  try {
    const update = await checkForUpdate();
    if (update) {
      updateState.value = "available";
      await update.downloadAndInstall();
      await relaunch();
    } else {
      updateState.value = "uptodate";
    }
  } catch (e) {
    console.error("[updater]", e);
    updateState.value = "error";
  }
}

function onSelect(code: string) { selected.value = code; }

let unlisten: (() => void) | null = null;

// 行情更新后跑预警
watch(
  () => quotes.map,
  (m) => alerts.evaluate(m),
  { deep: true }
);

onMounted(async () => {
  try {
    // 先加载 SQLite：分组/自选/预警
    await wl.load();
    await alerts.load();
    if (wl.codes.length) selected.value = wl.codes[0];
    quotes.start(2000);
    // 灵动岛点击股票 -> 主窗口切换
    unlisten = await listen<string>("island:select", (e) => {
      selected.value = e.payload;
      if (!wl.codes.includes(e.payload)) wl.add(e.payload);
    });
  } catch (e) {
    console.error("[app] init failed", e);
  }
});
onBeforeUnmount(() => { if (unlisten) unlisten(); });
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">灵动盯盘</div>
      <div class="status">
        <span :class="quotes.polling ? 'dot on' : 'dot'"></span>
        {{ quotes.polling ? "实时" : "已暂停" }}
        <span class="sep">|</span>
        {{ Object.keys(quotes.map).length }} 只
        <span class="sep">|</span>
        {{ quotes.lastUpdate ? new Date(quotes.lastUpdate).toLocaleTimeString() : "--:--:--" }}
        <span class="sep">|</span>
        <button class="upd" @click="checkUpdate">
          {{ updateState === "checking" ? "检查中…"
            : updateState === "available" ? "更新中…"
            : updateState === "uptodate" ? "已是最新"
            : updateState === "error" ? "检查失败"
            : "检查更新" }}
        </button>
      </div>
    </header>

    <div class="body">
      <aside class="left">
        <WatchList :selected="selected" @select="onSelect" />
      </aside>
      <section class="right">
        <StockChart v-if="selected" :key="selected" :code="selected" />
        <div v-else class="placeholder">从左侧选择一只股票开始看盘</div>
      </section>
    </div>

    <footer v-if="alerts.firedLog.length" class="alertbar">
      <div class="alabel">预警</div>
      <div class="alog">
        <span v-for="(l, i) in alerts.firedLog.slice(0, 3)" :key="i" class="item">{{ l }}</span>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100%; }
.topbar {
  height: 38px; display: flex; align-items: center; justify-content: space-between;
  padding: 0 12px; background: var(--bg-panel); border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}
.brand { font-weight: 700; letter-spacing: 1px; }
.status { font-size: 12px; color: var(--text-dim); -webkit-app-region: no-drag; }
.sep { margin: 0 8px; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #555; margin-right: 5px; }
.dot.on { background: #26d07c; }
.body { flex: 1; display: flex; min-height: 0; }
.left { width: 320px; border-right: 1px solid var(--border); overflow: hidden; }
.right { flex: 1; min-width: 0; }
.placeholder { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-dim); }
.alertbar {
  display: flex; gap: 10px; padding: 6px 12px; font-size: 12px;
  background: #2a1a1a; border-top: 1px solid #4a2a2a;
}
.alabel { color: #f23645; font-weight: 600; }
.alog { display: flex; flex-direction: column; }
.item { color: #ffb3b8; }
.upd {
  background: transparent; color: var(--text-dim); border: 1px solid var(--border);
  border-radius: 5px; padding: 2px 9px; font-size: 12px; cursor: pointer;
}
.upd:hover { color: var(--text); border-color: var(--text-dim); }
</style>
