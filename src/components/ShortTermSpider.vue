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

type Scope = "all" | "watch" | "board" | "single";
const scope = ref<Scope>("all");
const scopes: { k: Scope; label: string }[] = [
  { k: "all", label: "全部A股" },
  { k: "watch", label: "自选股" },
  { k: "board", label: "板块" },
  { k: "single", label: "个股" },
];

const shown = computed(() => {
  let list = events.value;
  if (scope.value === "watch") list = list.filter((e) => wl.codes.includes(e.code));
  return list;
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
  try { await startSpider(wl.codes); } catch (e) { console.error("startSpider", e); }
});

onBeforeUnmount(async () => {
  if (unlistenE) unlistenE();
  if (unlistenS) unlistenS();
  try { await stopSpider(); } catch { /* ignore */ }
});

function togglePause() { paused.value = !paused.value; }
function clearAll() { events.value = []; }
function hhmmss(t: number) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
</script>

<template>
  <div class="spider">
    <!-- Tab切换 -->
    <div class="tabs">
      <button
        v-for="s in scopes" :key="s.k"
        class="tab" :class="{ on: scope === s.k }"
        @click="scope = s.k"
      >{{ s.label }}</button>
    </div>

    <!-- 表头 -->
    <div class="grid head">
      <span>时间</span>
      <span>股票名称</span>
      <span>异动信息</span>
      <span class="r">涨跌幅</span>
    </div>

    <!-- 事件流 -->
    <div class="stream">
      <TransitionGroup tag="div" name="ev" :css="true">
        <div
          v-for="e in shown" :key="e.time + e.code + e.kind"
          class="row"
          @click="emit('select', e.code)"
        >
          <span class="t">{{ hhmmss(e.time) }}</span>
          <span class="nm">{{ e.name }}</span>
          <span class="ds">{{ e.label }} · {{ e.desc }}</span>
          <span class="pct" :class="e.tone === 'up' ? 'up' : e.tone === 'down' ? 'down' : ''">
            {{ e.pct >= 0 ? '+' : '' }}{{ e.pct.toFixed(1) }}%
          </span>
        </div>
      </TransitionGroup>

      <div v-if="shown.length === 0" class="empty">
        <p>{{ status && !status.trading ? "非交易时段" : "暂无异动" }}</p>
      </div>
    </div>

    <!-- 底部按钮 -->
    <div class="foot">
      <button class="fbtn" @click="togglePause">{{ paused ? "继续" : "暂停" }}</button>
      <button class="fbtn" @click="clearAll">清空</button>
      <span class="cnt">{{ shown.length }}条</span>
    </div>
  </div>
</template>

<style scoped>
.spider { display: flex; flex-direction: column; height: 100%; font-size: 12px; }

.tabs { display: flex; align-items: center; gap: 2px; padding: 6px 8px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
.tab { background: transparent; border: none; color: var(--text-dim); font-size: 11px; cursor: pointer; padding: 4px 10px; border-radius: 6px; }
.tab.on { background: rgba(212,175,55,.15); color: var(--accent); font-weight: 600; }

.grid { display: grid; grid-template-columns: 60px 80px 1fr 70px; gap: 6px; align-items: center; }
.head { padding: 4px 8px; font-size: 10px; color: var(--text-dim); border-bottom: 1px solid var(--border); }
.head .r { text-align: right; }

.stream { flex: 1; overflow-y: auto; min-height: 0; }
.row {
  display: grid; grid-template-columns: 60px 80px 1fr 70px; gap: 6px;
  align-items: center; padding: 5px 8px; cursor: pointer;
  border-left: 2px solid transparent;
}
.row:hover { background: var(--bg-hover); }
.row:nth-child(odd) { background: rgba(255,255,255,.015); }
.row:nth-child(odd):hover { background: var(--bg-hover); }
.t { color: var(--text-dim); font-size: 10px; font-variant-numeric: tabular-nums; }
.nm { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ds { color: var(--text-dim); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pct { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.pct.up { color: var(--up); }
.pct.down { color: var(--down); }

.empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-dim); font-size: 11px; }

.foot { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-top: 1px solid var(--border); }
.fbtn { background: transparent; border: 1px solid var(--border); color: var(--text-dim); font-size: 10px; border-radius: 4px; padding: 2px 10px; cursor: pointer; }
.fbtn:hover { color: var(--text); border-color: var(--text-dim); }
.cnt { margin-left: auto; font-size: 10px; color: var(--text-dim); }

.ev-enter-active { transition: all .3s ease; }
.ev-enter-from { opacity: 0; transform: translateY(-8px); }
.ev-leave-active { transition: all .2s ease; }
.ev-leave-to { opacity: 0; }
.ev-move { transition: transform .3s ease; }
</style>
