<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { exit } from "@tauri-apps/plugin-process";
import WatchList from "./components/WatchList.vue";
import Indices from "./components/Indices.vue";
import RankBoard from "./components/RankBoard.vue";
import RightPanel from "./components/RightPanel.vue";
import NewsBar from "./components/NewsBar.vue";
import SearchBox from "./components/SearchBox.vue";
import StockChart from "./components/StockChart.vue";
import { useWatchlistStore } from "./stores/watchlist";
import { useQuotesStore } from "./stores/quotes";
import { useAlertStore } from "./stores/alert";

const wl = useWatchlistStore();
const quotes = useQuotesStore();
const alerts = useAlertStore();

const selected = ref<string | null>(null);
// 左导航抽屉：null=收起，watch=自选，rank=榜单
const drawer = ref<"watch" | "rank" | null>("watch");

function nav(key: "watch" | "rank") {
  drawer.value = drawer.value === key ? null : key;
}

// ===== 自动更新 =====
const curVersion = ref("");
type UpdState =
  | "idle"
  | "checking"
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
    newVer.value = update.version;
    updState.value = "downloading";
    let got = 0;
    let total = 0;
    // 先下载，下载完后退出主程序，让安装器干净写入
    await update.download((e: any) => {
      switch (e.event) {
        case "Started": total = e.data.contentLength || 0; break;
        case "Progress": got += e.data.chunkLength; pct.value = total ? Math.round((got / total) * 100) : 0; break;
        case "Finished": pct.value = 100; break;
      }
    });
    updState.value = "installing";
    // 下载完成，手动运行安装器（显示图形化安装向导）
    await new Promise((r) => setTimeout(r, 500));
    // 用 shell 打开安装包，让用户手动安装
    const { Command } = await import("@tauri-apps/plugin-shell");
    const installerPath = await (update as any).installerPath?.();
    if (installerPath) {
      const cmd = Command.create(installerPath, []);
      await cmd.execute();
      await exit(0);
    } else {
      // fallback: 直接退出，让 updater 自动安装
      await exit(0);
    }
  } catch (err) {
    console.error("[updater]", err);
    updState.value = "error";
    setTimeout(resetUpd, 3000);
  }
}

function updLabel(): string {
  switch (updState.value) {
    case "checking": return "检查中…";
    case "installing": return "即将退出并安装…";
    case "uptodate": return "已是最新";
    case "error": return "更新失败";
    default: return "检查更新";
  }
}

function onSelect(code: string) { selected.value = code; }
function onSearchSelect(code: string, name: string) {
  selected.value = code;
  if (!wl.codes.includes(code)) wl.add(code, name);
  drawer.value = "watch";
}

let unlisten: (() => void) | null = null;

watch(() => quotes.map, (m) => alerts.evaluate(m), { deep: true });

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
    <!-- 顶栏 -->
    <header class="topbar">
      <div class="brand">金睛盯盘</div>
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
        <div v-if="updState === 'downloading'" class="upd-progress">
          <span class="upd-text">下载 v{{ newVer }} {{ pct }}%</span>
          <div class="bar"><div class="fill" :style="{ width: pct + '%' }"></div></div>
        </div>
        <button v-else class="upd" :class="{ busy: updState !== 'idle', bad: updState === 'error' }" @click="checkUpdate">
          {{ updLabel() }}
        </button>
      </div>
    </header>

    <!-- 指数条 -->
    <Indices class="idx-row" />

    <!-- 左窄导航 -->
    <nav class="leftnav">
      <div class="item" :class="{ on: drawer === 'watch' }" @click="nav('watch')" title="自选股">
        <span class="ic">★</span><span class="lb">自选</span>
      </div>
      <div class="item" :class="{ on: drawer === 'rank' }" @click="nav('rank')" title="榜单">
        <span class="ic">≡</span><span class="lb">榜单</span>
      </div>
      <div class="item" title="板块"><span class="ic">▣</span><span class="lb">板块</span></div>
      <div class="item" title="资讯"><span class="ic">◔</span><span class="lb">资讯</span></div>
      <div class="item" title="设置"><span class="ic">⚙</span><span class="lb">设置</span></div>
    </nav>

    <!-- 中间抽屉（自选/榜单） -->
    <aside v-if="drawer" class="drawer">
      <WatchList v-if="drawer === 'watch'" :selected="selected" @select="onSelect" />
      <RankBoard v-else @select="onSelect" />
    </aside>

    <!-- 中间主干：K线图 -->
    <section class="center">
      <StockChart v-if="selected" :key="selected" :code="selected" />
      <div v-else class="placeholder">从左侧自选或榜单选择一只股票</div>
    </section>

    <!-- 右栏盘口 -->
    <aside class="rightpanel">
      <RightPanel :code="selected" />
    </aside>

    <!-- 底部新闻 -->
    <footer class="newsbar">
      <NewsBar :code="selected" />
    </footer>

    <!-- 预警条 -->
    <footer v-if="alerts.firedLog.length" class="alertbar">
      <div class="alabel">预警</div>
      <div class="alog">
        <span v-for="(l, i) in alerts.firedLog.slice(0, 3)" :key="i" class="item">{{ l }}</span>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-rows: 38px 32px 1fr 90px;
  grid-template-columns: 46px auto 1fr 300px;
  height: 100vh;
}

/* 顶栏 */
.topbar {
  grid-column: 1 / 5;
  display: flex; align-items: center; gap: 14px;
  padding: 0 12px; background: var(--bg-panel); border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}
.brand { font-weight: 700; color: var(--accent); white-space: nowrap; }
.search {
  flex: 0 0 220px; background: var(--bg); border: 1px solid var(--border);
  border-radius: 4px; color: var(--text-dim); padding: 4px 10px; font-size: 12px;
}
.status { flex: 1; display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-dim); justify-content: flex-end; -webkit-app-region: no-drag; }
.sep { margin: 0 8px; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #555; margin-right: 5px; }
.dot.on { background: #26d07c; }
.ver { opacity: 0.8; }

/* 指数条 */
.idx-row { grid-column: 1 / 5; }

/* 左导航 */
.leftnav {
  background: var(--bg-panel); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; align-items: center; padding-top: 8px; gap: 2px;
}
.item {
  width: 40px; padding: 6px 0; border-radius: 6px; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; color: var(--text-dim);
}
.item .ic { font-size: 15px; line-height: 1.2; }
.item .lb { font-size: 10px; margin-top: 2px; }
.item:hover { color: var(--text); }
.item.on { background: var(--bg-hover); color: var(--accent); }

/* 抽屉 */
.drawer {
  width: 260px; border-right: 1px solid var(--border); overflow: hidden;
  display: flex; flex-direction: column; background: var(--bg-panel);
}

/* 中间 */
.center { min-width: 0; min-height: 0; }
.placeholder { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-dim); }

/* 右栏 */
.rightpanel { min-height: 0; overflow: hidden; }

/* 底部新闻 */
.newsbar { grid-column: 2 / 5; border-top: 1px solid var(--border); min-height: 0; }

/* 预警条 */
.alertbar {
  grid-column: 1 / 5; display: flex; gap: 10px; padding: 6px 12px; font-size: 12px;
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
.bar { width: 120px; height: 5px; border-radius: 3px; background: var(--border); overflow: hidden; }
.fill { height: 100%; background: #4ea1ff; transition: width 0.2s; }
.chart-wrap { display: flex; flex-direction: column; height: 100%; }
.chart-head { display: flex; align-items: center; gap: 12px; padding: 6px 12px; border-bottom: 1px solid var(--border); }
.chart-head .back { background: transparent; border: 1px solid var(--border); color: var(--text-dim); padding: 3px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; }
.chart-head .back:hover { background: var(--bg-hover); color: var(--text); }
.chart-head .cur { color: var(--text-dim); font-size: 12px; }
</style>
