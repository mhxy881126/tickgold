<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  startSpider, stopSpider,
  getSpiderThresholds, setSpiderThresholds,
  type SpiderEvent, type SpiderStatus, type SpiderThresholds,
} from "../api/market";
import { useWatchlistStore } from "../stores/watchlist";

const emit = defineEmits<{ select: [code: string] }>();

const wl = useWatchlistStore();
const events = ref<SpiderEvent[]>([]);
const status = ref<SpiderStatus | null>(null);
const paused = ref(false);
const MAX = 300;

// 阈值设置
const showCfg = ref(false);
const thForm = ref<SpiderThresholds | null>(null);
const thSaving = ref(false);

async function openCfg() {
  try {
    thForm.value = await getSpiderThresholds();
    showCfg.value = true;
  } catch (e) {
    console.error("getSpiderThresholds", e);
  }
}
async function saveCfg() {
  if (!thForm.value) return;
  thSaving.value = true;
  try {
    thForm.value = await setSpiderThresholds(thForm.value);
    showCfg.value = false;
  } catch (e) {
    console.error("setSpiderThresholds", e);
  } finally {
    thSaving.value = false;
  }
}

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
      <button class="fbtn gear" title="异动阈值设置" @click="openCfg">阈值</button>
      <span class="cnt">{{ shown.length }}条</span>
    </div>

    <!-- 阈值设置浮层 -->
    <div v-if="showCfg && thForm" class="cfg-mask" @click.self="showCfg = false">
      <div class="cfg-panel">
        <div class="cfg-title">异动监控阈值</div>
        <label class="cfg-row">
          <span class="cfg-k">急涨 / 急跌</span>
          <input v-model.number="thForm.surgePct" type="number" step="0.05" min="0.05" class="cfg-inp" />
          <span class="cfg-u">%</span>
        </label>
        <label class="cfg-row">
          <span class="cfg-k">大单成交额</span>
          <input v-model.number="thForm.bigAmountWan" type="number" step="50" min="50" class="cfg-inp" />
          <span class="cfg-u">万元</span>
        </label>
        <label class="cfg-row">
          <span class="cfg-k">放量量比</span>
          <input v-model.number="thForm.volumeRatio" type="number" step="0.1" min="0.5" class="cfg-inp" />
          <span class="cfg-u">倍</span>
        </label>
        <div class="cfg-tip">相邻 5 秒快照比较；保存后下一快照生效</div>
        <div class="cfg-btns">
          <button class="fbtn" @click="showCfg = false">取消</button>
          <button class="fbtn ok" :disabled="thSaving" @click="saveCfg">{{ thSaving ? "保存中" : "保存" }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.spider { display: flex; flex-direction: column; height: 100%; font-size: 12px; position: relative; }

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
.row:nth-child(odd) { background: var(--ov-01); }
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

/* 阈值浮层 */
.cfg-mask {
  position: absolute; inset: 0; z-index: 30;
  background: rgba(0,0,0,.5); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
}
.cfg-panel {
  width: min(280px, 88%); background: var(--bg-card);
  border: 1px solid var(--border); border-radius: 10px;
  padding: 14px 14px 12px; box-shadow: 0 12px 40px rgba(0,0,0,.5);
}
.cfg-title { font-size: 13px; font-weight: 700; margin-bottom: 10px; }
.cfg-row { display: grid; grid-template-columns: 80px 1fr 30px; gap: 8px; align-items: center; margin-bottom: 9px; }
.cfg-k { font-size: 11px; color: var(--text-dim); }
.cfg-inp {
  width: 100%; background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 6px; padding: 5px 8px; color: var(--text); font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.cfg-inp:focus { outline: none; border-color: var(--accent); }
.cfg-u { font-size: 10px; color: var(--text-dim); }
.cfg-tip { font-size: 10px; color: var(--text-dim); margin: 2px 0 10px; }
.cfg-btns { display: flex; justify-content: flex-end; gap: 8px; }
.fbtn.ok { color: var(--accent); border-color: var(--accent); }
.fbtn.ok:disabled { opacity: .5; cursor: default; }
</style>
