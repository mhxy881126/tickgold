<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import WatchList from "./components/WatchList.vue";
import StockChart from "./components/StockChart.vue";
import Indices from "./components/Indices.vue";
import RankBoard from "./components/RankBoard.vue";
import { useWatchlistStore } from "./stores/watchlist";
import { useQuotesStore } from "./stores/quotes";
import { useAlertStore } from "./stores/alert";

const wl = useWatchlistStore();
const quotes = useQuotesStore();
const alerts = useAlertStore();

const selected = ref<string | null>(null);
const sideTab = ref<"watch" | "rank">("watch");

// ===== 自动更新 =====
const curVersion = ref("");
type UpdState =
  | "idle"
  | "checking"
  | "newfound"
  | "downloading"
  | "installing"
  | "uptodate"
  | "error";
const updState = ref<UpdState>("idle");
const newVer = ref("");
const pct = ref(0);

function resetUpd() {
  updState.value = "idle";
  newVer.value = "";
  pct.value = 0;
}

async function checkUpdate() {
  if (updState.value === "checking" || updState.value === "downloading") return;
  updState.value = "checking";
  try {
    const update = await checkForUpdate();
    if (!update) {
      updState.value = "uptodate";
      setTimeout(resetUpd, 2500);
      return;
    }
    // 有新版本，开始下载
    newVer.value = update.version;
    updState.value = "downloading";
    let got = 0;
    let total = 0;
    await update.downloadAndInstall((e) => {
      switch (e.event) {
        case "Started":
          total = e.data.contentLength || 0;
          break;
        case "Progress":
          got += e.data.chunkLength;
          pct.value = total ? Math.round((got / total) * 100) : 0;
          break;
        case "Finished":
          pct.value = 100;
          break;
      }
    });
    updState.value = "installing";
    await relaunch();
  } catch (err) {
    console.error("[updater]", err);
    updState.value = "error";
    setTimeout(resetUpd, 3000);
  }
}

function updLabel(): string {
  switch (updState.value) {
    case "checking": return "检查中…";
    case "newfound": return `新版本 v${newVer.value}`;
    case "installing": return "安装中，即将重启…";
    case "uptodate": return "已是最新";
    case "error": return "更新失败";
    default: return "检查更新";
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
    curVersion.value = await getVersion();
    await wl.load();
    await alerts.load();
    if (wl.codes.length) selected.value = wl.codes[0];
    quotes.start(2000);
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
        <span class="ver" :title="`当前版本 v${curVersion}`">v{{ curVersion }}</span>

        <!-- 更新区域 -->
        <span class="sep">|</span>
        <div v-if="updState === 'downloading'" class="upd-progress">
          <span class="upd-text">下载 v{{ newVer }} {{ pct }}%</span>
          <div class="bar"><div class="fill" :style="{ width: pct + '%' }"></div></div>
        </div>
        <button
          v-else
          class="upd"
          :class="{ busy: updState !== 'idle', bad: updState === 'error' }"
          @click="checkUpdate"
        >
          {{ updLabel() }}
        </button>
      </div>
    </header>

    <Indices />

    <div class="body">
      <aside class="left">
        <div class="side-tabs">
          <button :class="{ active: sideTab === 'watch' }" @click="sideTab = 'watch'">自选</button>
          <button :class="{ active: sideTab === 'rank' }" @click="sideTab = 'rank'">榜单</button>
        </div>
        <WatchList v-if="sideTab === 'watch'" :selected="selected" @select="onSelect" />
        <RankBoard v-else @select="onSelect" />
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
.status { font-size: 12px; color: var(--text-dim); -webkit-app-region: no-drag; display: flex; align-items: center; }
.sep { margin: 0 8px; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #555; margin-right: 5px; }
.dot.on { background: #26d07c; }
.ver { color: var(--text-dim); opacity: 0.8; }
.body { flex: 1; display: flex; min-height: 0; }
.left { width: 320px; border-right: 1px solid var(--border); overflow: hidden; display: flex; flex-direction: column; }
.side-tabs { display: flex; gap: 6px; padding: 8px 8px 0; }
.side-tabs button {
  flex: 1; padding: 4px 0; font-size: 12px; border-radius: 6px 6px 0 0;
  background: transparent; border: 1px solid var(--border); border-bottom: none;
  color: var(--text-dim); cursor: pointer;
}
.side-tabs button.active { color: var(--text); background: var(--bg-hover); }
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
.upd.busy { color: #4ea1ff; border-color: #4ea1ff; cursor: default; }
.upd.bad { color: #f23645; border-color: #f23645; }

.upd-progress { display: flex; align-items: center; gap: 8px; }
.upd-text { font-size: 12px; color: #4ea1ff; white-space: nowrap; }
.bar {
  width: 120px; height: 5px; border-radius: 3px;
  background: var(--border); overflow: hidden;
}
.fill { height: 100%; background: #4ea1ff; transition: width 0.2s; }
</style>
