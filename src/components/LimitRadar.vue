<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  startRadar, stopRadar,
  type RadarData, type RadarStatus,
} from "../api/market";

const emit = defineEmits<{ select: [code: string] }>();

const data = ref<RadarData | null>(null);
const scanning = ref(false);
const trading = ref(true);
const tab = ref<"ladder" | "up" | "broken" | "down">("ladder");
let un: UnlistenFn[] = [];

function hhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 仪表盘颜色（冷→热）
const gaugeColor = computed(() => {
  const s = data.value?.sentiment ?? 50;
  if (s < 40) return "#3ba776";
  if (s < 60) return "#e3b341";
  return "#e0455a";
});
const arcLen = Math.PI * 56;
const dash = computed(() => {
  const f = (data.value?.sentiment ?? 0) / 100;
  return `${(arcLen * f).toFixed(1)} ${arcLen.toFixed(1)}`;
});

onMounted(async () => {
  un.push(await listen<RadarData>("radar:data", (e) => { data.value = e.payload; }));
  un.push(await listen<RadarStatus>("radar:status", (e) => {
    scanning.value = e.payload.scanning;
    trading.value = e.payload.trading;
  }));
  try { await startRadar(); } catch (e) { console.error("startRadar", e); }
});

onUnmounted(async () => {
  un.forEach((f) => f());
  try { await stopRadar(); } catch { /* ignore */ }
});
</script>

<template>
  <div class="radar">
    <!-- 顶部：情绪仪表 + 统计 -->
    <div class="top">
      <div class="gauge">
        <svg viewBox="0 0 140 86" width="132" height="80">
          <path d="M14 78 A56 56 0 0 1 126 78" fill="none" stroke="#232a33" stroke-width="9" stroke-linecap="round" />
          <path d="M14 78 A56 56 0 0 1 126 78" fill="none" :stroke="gaugeColor" stroke-width="9"
                stroke-linecap="round" :stroke-dasharray="dash" style="transition: stroke-dasharray .6s, stroke .4s" />
          <text x="70" y="62" text-anchor="middle" class="g-num">{{ Math.round(data?.sentiment ?? 0) }}</text>
          <text x="70" y="78" text-anchor="middle" class="g-mood">{{ data?.mood || "—" }}</text>
        </svg>
        <div class="g-label">市场情绪</div>
      </div>

      <div class="stats">
        <div class="stat up">
          <div class="sv">{{ data?.limitUp ?? 0 }}</div><div class="sl">涨停</div>
        </div>
        <div class="stat down">
          <div class="sv">{{ data?.limitDown ?? 0 }}</div><div class="sl">跌停</div>
        </div>
        <div class="stat warn">
          <div class="sv">{{ data?.broken ?? 0 }}</div><div class="sl">炸板</div>
        </div>
        <div class="stat">
          <div class="sv">{{ (data?.brokenRate ?? 0).toFixed(0) }}%</div><div class="sl">炸板率</div>
        </div>
        <div class="stat gold">
          <div class="sv">{{ data?.maxBoards ?? 0 }}</div><div class="sl">最高板</div>
        </div>
        <div class="stat up">
          <div class="sv">{{ data?.upCount ?? 0 }}</div><div class="sl">上涨</div>
        </div>
        <div class="stat down">
          <div class="sv">{{ data?.downCount ?? 0 }}</div><div class="sl">下跌</div>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button :class="{ on: tab === 'ladder' }" @click="tab = 'ladder'">连板梯队</button>
      <button :class="{ on: tab === 'up' }" @click="tab = 'up'">涨停 {{ data?.limitUp ?? 0 }}</button>
      <button :class="{ on: tab === 'broken' }" @click="tab = 'broken'">炸板 {{ data?.broken ?? 0 }}</button>
      <button :class="{ on: tab === 'down' }" @click="tab = 'down'">跌停 {{ data?.limitDown ?? 0 }}</button>
      <span class="scan-info">
        <span v-if="scanning" class="dot-pulse"></span>
        {{ data ? hhmmss(data.updated) : '' }}
      </span>
    </div>

    <div class="body">
      <!-- 连板梯队 -->
      <div v-if="tab === 'ladder'" class="ladder">
        <div v-if="!data || data.ladder.length === 0" class="empty">
          {{ data ? '当前无连板股（全部为首板或无涨停）' : '正在全市场扫描…' }}
        </div>
        <div v-for="g in data?.ladder ?? []" :key="g.boards" class="lad-row">
          <div class="lad-tag" :class="{ top: g.boards === data?.maxBoards }">
            <div class="lad-n">{{ g.boards }}</div><div class="lad-t">板</div>
          </div>
          <div class="lad-items">
            <button v-for="s in g.items" :key="s.code" class="chip" @click="emit('select', s.code)">
              {{ s.name }}
            </button>
          </div>
        </div>
      </div>

      <!-- 涨停列表 -->
      <div v-if="tab === 'up'" class="list">
        <div v-for="s in data?.limitUpList ?? []" :key="s.code" class="row" @click="emit('select', s.code)">
          <span class="nm">{{ s.name }}</span>
          <span class="bd" :class="{ hi: s.boards >= 3 }">{{ s.boards }}板</span>
          <span class="pr">{{ s.price.toFixed(2) }}</span>
          <span class="pct up">{{ s.pct.toFixed(2) }}%</span>
        </div>
      </div>

      <!-- 炸板列表 -->
      <div v-if="tab === 'broken'" class="list">
        <div v-for="s in data?.brokenList ?? []" :key="s.code" class="row" @click="emit('select', s.code)">
          <span class="nm">{{ s.name }}</span>
          <span class="bd brk">炸板</span>
          <span class="pr">{{ s.price.toFixed(2) }}</span>
          <span :class="s.pct >= 0 ? 'pct up' : 'pct down'">{{ s.pct.toFixed(2) }}%</span>
        </div>
      </div>

      <!-- 跌停列表 -->
      <div v-if="tab === 'down'" class="list">
        <div v-for="s in data?.limitDownList ?? []" :key="s.code" class="row" @click="emit('select', s.code)">
          <span class="nm">{{ s.name }}</span>
          <span class="bd dn">跌停</span>
          <span class="pr">{{ s.price.toFixed(2) }}</span>
          <span class="pct down">{{ s.pct.toFixed(2) }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.radar { display: flex; flex-direction: column; height: 100%; font-size: 12px; }

/* 顶部 */
.top { display: flex; gap: 14px; padding-bottom: 12px; border-bottom: 1px solid #20262f; }
.gauge { display: flex; flex-direction: column; align-items: center; flex: 0 0 128px; }
.g-num { fill: #e8eaed; font-size: 26px; font-weight: 700; }
.g-mood { fill: #8b949e; font-size: 11px; }
.g-label { color: #8b949e; font-size: 11px; margin-top: 2px; }

.stats { flex: 1; display: grid; grid-template-columns: repeat(4, 1fr); grid-auto-rows: minmax(40px, auto); gap: 6px; }
.stat {
  background: #141920; border-radius: 7px; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
}
.sv { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
.sl { font-size: 10px; color: #8b949e; margin-top: 1px; }
.stat.up .sv { color: #f25266; }
.stat.down .sv { color: #22b573; }
.stat.warn .sv { color: #f0a23a; }
.stat.gold .sv { color: #e8c66a; }

/* tabs */
.tabs { display: flex; align-items: center; gap: 4px; padding: 9px 0 8px; }
.tabs button {
  background: none; border: none; color: #8b949e; font-size: 11px; cursor: pointer;
  padding: 4px 9px; border-radius: 6px;
}
.tabs button:hover { color: #c9d1d9; }
.tabs button.on { background: #232c38; color: #e8eaed; font-weight: 600; }
.scan-info { margin-left: auto; display: flex; align-items: center; gap: 5px; color: #6b7280; font-size: 10px; font-variant-numeric: tabular-nums; }
.dot-pulse { width: 6px; height: 6px; border-radius: 50%; background: #4ea1ff; animation: pulse 1.2s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }

/* body */
.body { flex: 1; overflow-y: auto; }
.empty { color: #6b7280; font-size: 11px; text-align: center; padding: 30px 10px; }

/* 梯队 */
.ladder { display: flex; flex-direction: column; gap: 8px; padding-top: 4px; }
.lad-row { display: flex; gap: 10px; align-items: flex-start; }
.lad-tag {
  flex: 0 0 42px; height: 42px; border-radius: 8px; background: #1a212b;
  display: flex; align-items: baseline; justify-content: center; gap: 1px; padding-top: 7px;
}
.lad-tag.top { background: linear-gradient(160deg,#5a4620,#3a2f16); }
.lad-n { font-size: 19px; font-weight: 800; color: #e8c66a; }
.lad-t { font-size: 10px; color: #b89a4e; }
.lad-items { flex: 1; display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  background: #161c25; border: 1px solid #242d38; color: #c9d1d9; font-size: 11px;
  padding: 4px 9px; border-radius: 13px; cursor: pointer;
}
.chip:hover { border-color: #c03a4a; color: #ff8a98; }

/* 列表 */
.list { display: flex; flex-direction: column; }
.row {
  display: grid; grid-template-columns: 1fr 46px 64px 70px; align-items: center;
  padding: 6px 6px; border-radius: 6px; cursor: pointer; gap: 6px;
}
.row:hover { background: #171d26; }
.nm { color: #d6dae0; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd { font-size: 10px; text-align: center; border-radius: 4px; padding: 2px 0; color: #f25266; background: rgba(242,82,102,.12); }
.bd.hi { background: #c03a4a; color: #fff; font-weight: 700; }
.bd.brk { color: #f0a23a; background: rgba(240,162,58,.12); }
.bd.dn { color: #22b573; background: rgba(34,181,115,.12); }
.pr { text-align: right; color: #c9d1d9; font-size: 11px; font-variant-numeric: tabular-nums; }
.pct { text-align: right; font-size: 11px; font-variant-numeric: tabular-nums; }
.pct.up { color: #f25266; }
.pct.down { color: #22b573; }
</style>
