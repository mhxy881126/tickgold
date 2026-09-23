<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  startRadar, stopRadar, startSpider, stopSpider,
  fetchSectors,
  type RadarData, type SpiderEvent,
} from "../api/market";
import type { Sector } from "../api/types";
import { useWatchlistStore } from "../stores/watchlist";
import RadarDisc from "./RadarDisc.vue";

const emit = defineEmits<{ select: [code: string] }>();
const wl = useWatchlistStore();

const radar = ref<RadarData | null>(null);
const events = ref<SpiderEvent[]>([]);
const sectors = ref<Sector[]>([]);
const mode = ref<"scan" | "review">("scan");

let un: UnlistenFn[] = [];
let timer = 0;

async function loadSectors() {
  try {
    const [ind, con] = await Promise.all([
      fetchSectors("industry"),
      fetchSectors("concept"),
    ]);
    const map = new Map<string, Sector>();
    [...ind, ...con].forEach((s) => {
      const ex = map.get(s.code);
      if (!ex || Math.abs(s.changePct) > Math.abs(ex.changePct)) map.set(s.code, s);
    });
    sectors.value = [...map.values()].sort(
      (a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)
    );
  } catch (e) {
    console.error("loadSectors", e);
  }
}

// 情绪仪表
const arcLen = Math.PI * 56;
const gaugeDash = computed(() => {
  const f = (radar.value?.sentiment ?? 0) / 100;
  return `${(arcLen * f).toFixed(1)} ${arcLen.toFixed(1)}`;
});
const gaugeColor = computed(() => {
  const s = radar.value?.sentiment ?? 50;
  if (s < 40) return "#3ba776";
  if (s < 60) return "#e3b341";
  return "#e0455a";
});

// 梯队（取前 6 个板级）
const ladder = computed(() => (radar.value?.ladder ?? []).slice(0, 6));

// 板块资金汇总（元 → 亿）
function yi(v: number) { return (v / 1e8).toFixed(1); }
const totalMain = computed(() =>
  sectors.value.reduce((a, s) => a + s.netAmount, 0)
);
const inflow3 = computed(() =>
  [...sectors.value].sort((a, b) => b.netAmount - a.netAmount).slice(0, 3)
);
const outflow3 = computed(() =>
  [...sectors.value].sort((a, b) => a.netAmount - b.netAmount).slice(0, 3)
);

function hhmm(t: number) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

onMounted(async () => {
  un.push(await listen<RadarData>("radar:data", (e) => { radar.value = e.payload; }));
  un.push(await listen<SpiderEvent[]>("spider:events", (e) => {
    if (e.payload?.length) events.value = e.payload.concat(events.value).slice(0, 120);
  }));
  try { await startRadar(); } catch (e) { console.error("startRadar", e); }
  try { await startSpider(wl.codes); } catch (e) { console.error("startSpider", e); }
  loadSectors();
  timer = window.setInterval(loadSectors, 15000);
});

onUnmounted(async () => {
  un.forEach((f) => f());
  if (timer) clearInterval(timer);
  try { await stopRadar(); } catch { /* ignore */ }
  try { await stopSpider(); } catch { /* ignore */ }
});
</script>

<template>
  <div class="sweep">
    <!-- 左栏：情绪 + 梯队 -->
    <div class="sw-col left">
      <div class="sw-card">
        <div class="sw-h"><span class="bar"></span>市场情绪</div>
        <div class="sw-b gauge-b">
          <svg viewBox="0 0 140 84" width="100%" height="76">
            <path d="M14 78 A56 56 0 0 1 126 78" fill="none" stroke="#232a33" stroke-width="9" stroke-linecap="round" />
            <path d="M14 78 A56 56 0 0 1 126 78" fill="none" :stroke="gaugeColor" stroke-width="9"
                  stroke-linecap="round" :stroke-dasharray="gaugeDash" style="transition: stroke-dasharray .6s" />
            <text x="70" y="60" text-anchor="middle" class="g-num">{{ Math.round(radar?.sentiment ?? 0) }}</text>
            <text x="70" y="76" text-anchor="middle" class="g-mood">{{ radar?.mood || "—" }}</text>
          </svg>
          <div class="gauge-stats">
            <span><b class="up">{{ radar?.limitUp ?? 0 }}</b>涨停</span>
            <span><b class="down">{{ radar?.limitDown ?? 0 }}</b>跌停</span>
            <span><b class="warn">{{ radar?.broken ?? 0 }}</b>炸板</span>
          </div>
        </div>
      </div>

      <div class="sw-card" style="flex:1;min-height:0">
        <div class="sw-h"><span class="bar"></span>涨停梯队</div>
        <div class="sw-b scroll">
          <div v-if="!radar" class="empty">全市场扫描中…</div>
          <div v-for="g in ladder" :key="g.boards" class="ld" :class="{ top: g.boards === radar?.maxBoards }">
            <div class="ld-badge" :class="'lv' + Math.min(g.boards, 5)">{{ g.boards }}<i>板</i></div>
            <div class="ld-cnt">{{ g.count }}家</div>
            <div class="ld-stocks">
              <button v-for="s in g.items.slice(0, 4)" :key="s.code" @click="emit('select', s.code)">
                {{ s.name }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 中栏：雷达盘 -->
    <div class="sw-col center">
      <div class="sw-card radar-card">
        <div class="sw-h">
          <span class="bar"></span>市场雷达
          <div class="mode-switch">
            <button :class="{ on: mode === 'scan' }" @click="mode = 'scan'">扫盘</button>
            <button :class="{ on: mode === 'review' }" @click="mode = 'review'">复盘</button>
          </div>
        </div>
        <div class="sw-b radar-stage">
          <RadarDisc :sectors="sectors" :mode="mode" @select="(c) => c && emit('select', c)" />
        </div>
      </div>
    </div>

    <!-- 右栏：异动流 + 板块资金 -->
    <div class="sw-col right">
      <div class="sw-card" style="flex:1.1;min-height:0">
        <div class="sw-h"><span class="bar"></span>异动流</div>
        <div class="sw-b scroll">
          <div v-if="events.length === 0" class="empty">盘中异动实时推送…</div>
          <div v-for="e in events.slice(0, 50)" :key="e.time + e.code + e.kind"
               class="ev" :class="e.tone" @click="emit('select', e.code)">
            <span class="t">{{ hhmm(e.time) }}</span>
            <span class="tag">{{ e.label }}</span>
            <span class="nm">{{ e.name }}</span>
            <span class="pct">{{ (e.pct >= 0 ? '+' : '') + e.pct.toFixed(1) }}%</span>
          </div>
        </div>
      </div>

      <div class="sw-card">
        <div class="sw-h"><span class="bar"></span>板块资金</div>
        <div class="sw-b fund-b">
          <div class="fund-total" :class="totalMain >= 0 ? 'up' : 'down'">
            {{ yi(totalMain) }}<i>亿</i>
          </div>
          <div v-for="s in inflow3" :key="'in' + s.code" class="fund-row">
            <span>{{ s.name }}</span><b class="up">{{ yi(s.netAmount) }}</b>
          </div>
          <div class="fund-sep">净流出</div>
          <div v-for="s in outflow3" :key="'out' + s.code" class="fund-row">
            <span>{{ s.name }}</span><b class="down">{{ yi(s.netAmount) }}</b>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sweep {
  display: grid;
  grid-template-columns: 196px 1fr 248px;
  gap: 10px;
  height: 100%;
  min-height: 0;
}
.sw-col { display: flex; flex-direction: column; gap: 10px; min-height: 0; min-width: 0; }
.sw-card {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-card, #12101d);
  border: 1px solid var(--border, #241f36);
  border-radius: 11px;
  overflow: hidden;
}
.sw-h {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  flex-shrink: 0;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text, #e9e7f4);
  border-bottom: 1px solid var(--border, #1b1729);
}
.sw-h .bar { width: 3px; height: 12px; border-radius: 2px; background: #2de1ff; }
.sw-b { flex: 1; min-height: 0; padding: 9px; }
.scroll { overflow-y: auto; scrollbar-width: thin; }
.scroll::-webkit-scrollbar { width: 5px; }
.scroll::-webkit-scrollbar-thumb { background: #2a3344; border-radius: 3px; }
.empty { color: var(--text-dim, #8a84a4); font-size: 11px; text-align: center; padding: 24px 0; }

/* 情绪 */
.gauge-b { display: flex; flex-direction: column; }
.g-num { fill: #e8eaed; font-size: 24px; font-weight: 700; }
.g-mood { fill: #8b949e; font-size: 10px; }
.gauge-stats { display: flex; justify-content: space-around; margin-top: 2px; }
.gauge-stats span { font-size: 10px; color: var(--text-dim, #8a84a4); display: flex; flex-direction: column; align-items: center; }
.gauge-stats b { font-size: 14px; font-variant-numeric: tabular-nums; }
.gauge-stats b.up { color: #f25266; }
.gauge-stats b.down { color: #22b573; }
.gauge-stats b.warn { color: #f0a23a; }

/* 梯队 */
.ld { display: flex; align-items: center; gap: 7px; padding: 5px 4px; border-bottom: 1px solid rgba(255,255,255,.05); }
.ld.top .ld-badge { box-shadow: 0 0 0 1px rgba(212,175,55,.4); }
.ld-badge {
  flex-shrink: 0; width: 34px; height: 26px; border-radius: 7px;
  background: #1c2330; color: #8b98a5; font-size: 15px; font-weight: 800;
  display: flex; align-items: baseline; justify-content: center; gap: 1px;
}
.ld-badge i { font-size: 9px; font-style: normal; font-weight: 600; }
.ld-badge.lv5 { background: linear-gradient(160deg,#6b531c,#3d2e12); color: #ffd76a; }
.ld-badge.lv3 { background: linear-gradient(160deg,#5e2a2a,#381a1c); color: #ff7a5c; }
.ld-badge.lv2 { background: #2a2418; color: #f0a23a; }
.ld-cnt { flex-shrink: 0; font-size: 10px; color: var(--text-dim, #8a84a4); width: 30px; }
.ld-stocks { display: flex; flex-wrap: wrap; gap: 4px; }
.ld-stocks button {
  background: #161c25; border: 1px solid #242d38; color: #c9d1d9;
  font-size: 10px; padding: 2px 7px; border-radius: 6px; cursor: pointer;
}
.ld-stocks button:hover { border-color: #c03a4a; color: #fff; }

/* 雷达盘 */
.radar-card { flex: 1; }
.radar-stage { display: flex; align-items: center; justify-content: center; padding: 12px; }
.radar-stage > * { width: 100%; height: 100%; max-width: 100%; }
.mode-switch { margin-left: auto; display: flex; background: rgba(0,0,0,.3); border-radius: 7px; padding: 2px; gap: 2px; }
.mode-switch button {
  font-size: 10px; font-weight: 600; color: var(--text-dim, #8a84a4);
  background: none; border: none; padding: 3px 11px; border-radius: 5px; cursor: pointer;
}
.mode-switch button.on { color: #06202a; background: linear-gradient(180deg,#84ecff,#2de1ff); }

/* 异动流 */
.ev {
  display: grid;
  grid-template-columns: 50px 46px 1fr auto;
  align-items: center; gap: 6px; padding: 3px 4px; border-radius: 5px;
  cursor: pointer; border-left: 2px solid transparent;
}
.ev:hover { background: var(--bg-hover, rgba(255,255,255,.05)); }
.ev.up { border-left-color: #f23645; }
.ev.down { border-left-color: #08db98; }
.ev.neutral { border-left-color: #d4af37; }
.ev .t { color: var(--text-dim, #8a84a4); font-size: 9px; font-variant-numeric: tabular-nums; }
.ev .tag { font-size: 9px; padding: 0 4px; border-radius: 3px; text-align: center; }
.ev.up .tag { background: rgba(242,54,69,.15); color: #ff6b78; }
.ev.down .tag { background: rgba(8,219,152,.15); color: #2fe6b0; }
.ev.neutral .tag { background: rgba(212,175,55,.15); color: #e3c25f; }
.ev .nm { font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ev .pct { font-size: 10px; font-variant-numeric: tabular-nums; }
.ev.up .pct { color: #ff6b78; }
.ev.down .pct { color: #2fe6b0; }
.ev.neutral .pct { color: #e3c25f; }

/* 板块资金 */
.fund-b { display: flex; flex-direction: column; gap: 3px; }
.fund-total { font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; text-align: center; padding-bottom: 5px; }
.fund-total i { font-size: 10px; font-style: normal; margin-left: 2px; }
.fund-total.up { color: #f25266; } .fund-total.down { color: #22b573; }
.fund-row { display: flex; justify-content: space-between; font-size: 10.5px; }
.fund-row span { color: var(--text-dim, #8a84a4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fund-row b { font-variant-numeric: tabular-nums; }
.fund-row b.up { color: #f25266; } .fund-row b.down { color: #22b573; }
.fund-sep { font-size: 9px; color: var(--text-dim, #8a84a4); padding-top: 5px; margin-top: 2px; border-top: 1px solid rgba(255,255,255,.06); }
</style>
