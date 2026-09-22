<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  startSpider, stopSpider, type SpiderEvent, type SpiderStatus,
} from "../api/market";
import { useWatchlistStore } from "../stores/watchlist";

const emit = defineEmits<{ select: [code: string] }>();

const wl = useWatchlistStore();
const events = ref<SpiderEvent[]>([]);
const status = ref<SpiderStatus | null>(null);
const paused = ref(false);
const MAX = 300;

type Filter = "all" | "surge" | "limit_up" | "big_buy" | "volume" | "plunge";
const filter = ref<Filter>("all");
const filters: { k: Filter; label: string }[] = [
  { k: "all", label: "全部" },
  { k: "surge", label: "拉升" },
  { k: "limit_up", label: "涨停" },
  { k: "big_buy", label: "大单" },
  { k: "volume", label: "放量" },
  { k: "plunge", label: "下跌" },
];

const shown = computed(() => {
  if (filter.value === "all") return events.value;
  if (filter.value === "surge") return events.value.filter((e) => e.kind === "surge");
  if (filter.value === "plunge")
    return events.value.filter((e) => e.kind === "plunge" || e.kind === "limit_down" || e.kind === "limit_up_open");
  if (filter.value === "limit_up")
    return events.value.filter((e) => e.kind === "limit_up" || e.kind === "limit_down_open");
  if (filter.value === "big_buy")
    return events.value.filter((e) => e.kind === "big_buy" || e.kind === "big_sell");
  return events.value.filter((e) => e.kind === "volume");
});

// 今日各类型计数
const counts = computed(() => {
  const c: Record<string, number> = {};
  for (const e of events.value) c[e.kind] = (c[e.kind] || 0) + 1;
  return c;
});

let unlistenE: UnlistenFn | null = null;
let unlistenS: UnlistenFn | null = null;

onMounted(async () => {
  unlistenE = await listen<SpiderEvent[]>("spider:events", (ev) => {
    if (paused.value || !ev.payload?.length) return;
    events.value = ev.payload.concat(events.value).slice(0, MAX);
  });
  unlistenS = await listen<SpiderStatus>("spider:status", (ev) => {
    status.value = ev.payload;
  });
  try {
    await startSpider(wl.codes);
  } catch (e) {
    console.error("startSpider failed", e);
  }
});

onBeforeUnmount(async () => {
  if (unlistenE) unlistenE();
  if (unlistenS) unlistenS();
  try { await stopSpider(); } catch { /* ignore */ }
});

function togglePause() { paused.value = !paused.value; }
function clearAll() { events.value = []; }
function hhmm(t: number) {
  const d = new Date(t);
  return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0") +
    ":" + d.getSeconds().toString().padStart(2, "0");
}
function toneCls(tone: string) {
  return tone === "up" ? "up" : tone === "down" ? "down" : "neutral";
}
</script>

<template>
  <div class="spider">
    <!-- 状态条 -->
    <div class="head">
      <span class="state" :class="{ off: status && !status.trading }">
        <span class="pulse"></span>
        {{ status && !status.trading ? "非交易时段" : "监控中" }}
        <em v-if="status">{{ status.poolSize }} 只</em>
      </span>
      <div class="head-btns">
        <button class="hbtn" @click="togglePause">{{ paused ? "继续" : "暂停" }}</button>
        <button class="hbtn" @click="clearAll">清空</button>
      </div>
    </div>

    <!-- 类型筛选 -->
    <div class="filters">
      <button
        v-for="f in filters" :key="f.k"
        class="fbtn" :class="{ on: filter === f.k }"
        @click="filter = f.k"
      >{{ f.label }}</button>
    </div>

    <!-- 事件流 -->
    <div class="stream">
      <TransitionGroup tag="div" name="ev" :css="true">
        <div
          v-for="e in shown" :key="e.time + e.code + e.kind"
          class="ev" :class="toneCls(e.tone)"
          @click="emit('select', e.code)"
        >
          <span class="t">{{ hhmm(e.time) }}</span>
          <span class="tag">{{ e.label }}</span>
          <span class="nm">{{ e.name }}</span>
          <span class="ds">{{ e.desc }}</span>
          <span class="px">{{ e.price.toFixed(2) }}</span>
        </div>
      </TransitionGroup>

      <div v-if="shown.length === 0" class="empty">
        <div class="radar"></div>
        <p>{{ status && !status.trading ? "当前为非交易时段，开盘后自动推送异动" : "正在扫描全市场异动…" }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.spider { display: flex; flex-direction: column; height: 100%; font-size: 12px; }

.head { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; flex-shrink: 0; }
.state { display: flex; align-items: center; gap: 6px; color: #26d07c; font-size: 11px; }
.state em { color: var(--text-dim); font-style: normal; }
.state.off { color: var(--text-dim); }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: #26d07c; box-shadow: 0 0 0 0 rgba(38,208,124,.6); animation: pulse 1.6s infinite; }
.state.off .pulse { background: #888; animation: none; }
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(38,208,124,.5); }
  70% { box-shadow: 0 0 0 7px rgba(38,208,124,0); }
  100% { box-shadow: 0 0 0 0 rgba(38,208,124,0); }
}
.head-btns { display: flex; gap: 4px; }
.hbtn { background: transparent; border: 1px solid var(--border); color: var(--text-dim); font-size: 10px; border-radius: 4px; padding: 1px 7px; cursor: pointer; }
.hbtn:hover { color: var(--text); border-color: var(--text-dim); }

.filters { display: flex; gap: 4px; padding: 0 8px 6px; flex-shrink: 0; }
.fbtn { flex: 1; background: transparent; border: 1px solid var(--border); color: var(--text-dim); font-size: 10px; border-radius: 4px; padding: 2px 0; cursor: pointer; }
.fbtn.on { color: #fff; background: #16233a; border-color: #2f6fed; }

.stream { flex: 1; overflow-y: auto; min-height: 0; padding: 0 6px; }
.ev {
  display: grid; grid-template-columns: 52px 58px 1fr auto auto;
  align-items: center; gap: 6px; padding: 4px 6px; border-radius: 5px; cursor: pointer;
  border-left: 2px solid transparent;
}
.ev:hover { background: var(--bg-hover); }
.ev.up { border-left-color: #f23645; }
.ev.down { border-left-color: #08db98; }
.ev.neutral { border-left-color: #d4af37; }
.t { color: var(--text-dim); font-size: 10px; font-variant-numeric: tabular-nums; }
.tag {
  font-size: 10px; padding: 0 4px; border-radius: 3px; text-align: center;
}
.ev.up .tag { background: rgba(242,54,69,.15); color: #ff6b78; }
.ev.down .tag { background: rgba(8,219,152,.15); color: #2fe6b0; }
.ev.neutral .tag { background: rgba(212,175,55,.15); color: #e3c25f; }
.nm { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ds { color: var(--text-dim); font-size: 10px; white-space: nowrap; }
.px { font-variant-numeric: tabular-nums; font-size: 11px; }
.ev.up .px { color: #ff6b78; }
.ev.down .px { color: #2fe6b0; }

.empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--text-dim); gap: 14px; }
.radar {
  width: 46px; height: 46px; border-radius: 50%;
  border: 2px solid #2a313b; border-top-color: #e0556b;
  animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* 新事件进入动画 */
.ev-enter-active { transition: all .3s ease; }
.ev-enter-from { opacity: 0; transform: translateY(-8px); }
.ev-leave-active { transition: all .2s ease; }
.ev-leave-to { opacity: 0; }
.ev-move { transition: transform .3s ease; }
</style>
