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

// 首板（1 板）数量多，默认只显示前 30
const firstBoardExpanded = ref(false);
const FIRST_SHOW = 30;
function shownItems(g: { boards: number; items: { code: string; name: string; price: number }[] }) {
  if (g.boards !== 1 || firstBoardExpanded.value) return g.items;
  return g.items.slice(0, FIRST_SHOW);
}
function boardClass(b: number) {
  if (b >= 5) return "lv5";
  if (b >= 3) return "lv3";
  if (b === 2) return "lv2";
  return "lv1";
}

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
      <!-- 连板梯队（含首板） -->
      <div v-if="tab === 'ladder'" class="ladder">
        <div v-if="!data" class="empty">正在全市场扫描…</div>
        <div v-else-if="data.ladder.length === 0" class="empty">当前无涨停股</div>
        <template v-else>
        <div
          v-for="g in data.ladder"
          :key="g.boards"
          class="lad-group"
          :class="[boardClass(g.boards), { top: g.boards === data.maxBoards }]"
        >
          <div class="lad-head">
            <div class="lad-badge">
              <span class="bn">{{ g.boards }}</span><span class="bt">板</span>
            </div>
            <div class="lad-meta">
              <span class="lc">{{ g.count }} 家</span>
              <span v-if="g.boards === data.maxBoards" class="crown">最高标</span>
              <span v-if="g.boards === 1" class="first-tag">首板</span>
            </div>
          </div>
          <div class="lad-items">
            <button
              v-for="s in shownItems(g)"
              :key="s.code"
              class="stock-chip"
              @click="emit('select', s.code)"
            >
              <span class="sn">{{ s.name }}</span>
              <span class="sp">{{ s.price.toFixed(2) }}</span>
            </button>
            <button
              v-if="g.boards === 1 && g.items.length > FIRST_SHOW"
              class="more-btn"
              @click="firstBoardExpanded = !firstBoardExpanded"
            >
              {{ firstBoardExpanded ? "收起" : `展开其余 ${g.items.length - FIRST_SHOW} 只` }}
            </button>
          </div>
        </div>
        </template>
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

/* 梯队（含首板） */
.ladder { display: flex; flex-direction: column; gap: 9px; padding-top: 4px; }
.lad-group { border: 1px solid #20262f; border-radius: 9px; padding: 9px 10px; background: #12161d; }
.lad-group.top {
  border-color: rgba(212,175,55,.55);
  box-shadow: 0 0 0 1px rgba(212,175,55,.2), 0 6px 20px rgba(212,175,55,.08);
}
.lad-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.lad-badge {
  width: 46px; height: 34px; border-radius: 8px; padding-top: 5px;
  display: flex; align-items: baseline; justify-content: center; gap: 2px; background: #1c2330;
}
.lad-group.lv5 .lad-badge { background: linear-gradient(160deg,#6b531c,#3d2e12); }
.lad-group.lv3 .lad-badge { background: linear-gradient(160deg,#5e2a2a,#381a1c); }
.lad-group.lv2 .lad-badge { background: #2a2418; }
.lad-group.lv1 .lad-badge { background: #1a212c; }
.bn { font-size: 19px; font-weight: 800; }
.bt { font-size: 10px; }
.lad-group.lv5 .bn, .lad-group.lv5 .bt { color: #ffd76a; }
.lad-group.lv3 .bn { color: #ff7a5c; }
.lad-group.lv3 .bt { color: #d96a52; }
.lad-group.lv2 .bn { color: #f0a23a; }
.lad-group.lv2 .bt { color: #c98a3a; }
.lad-group.lv1 .bn { color: #8b98a5; }
.lad-group.lv1 .bt { color: #6b7886; }
.lad-meta { display: flex; align-items: center; gap: 8px; }
.lc { font-size: 11px; color: var(--text-dim); }
.crown {
  font-size: 10px; font-weight: 700; color: #1a1a1a;
  background: linear-gradient(160deg,#ffd76a,#d4af37); border-radius: 4px; padding: 2px 7px;
}
.first-tag { font-size: 10px; color: #9fb4cc; background: rgba(78,161,255,.14); border-radius: 4px; padding: 2px 7px; }
.lad-items { display: flex; flex-wrap: wrap; gap: 6px; }
.stock-chip {
  display: inline-flex; align-items: baseline; gap: 5px; cursor: pointer;
  background: #161c25; border: 1px solid #242d38; color: #c9d1d9; font-size: 11px;
  padding: 4px 9px; border-radius: 7px;
}
.stock-chip:hover { border-color: #c03a4a; }
.stock-chip .sp { font-size: 10px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.more-btn {
  background: transparent; border: 1px dashed #333c48; color: var(--text-dim);
  font-size: 10px; padding: 4px 10px; border-radius: 7px; cursor: pointer;
}
.more-btn:hover { color: #e8c66a; border-color: #d4af37; }

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
