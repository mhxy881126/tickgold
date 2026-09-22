<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { fetchSectors } from "../api/market";
import type { Sector } from "../api/types";

const emit = defineEmits<{ select: [code: string] }>();

interface SEvent {
  time: number;
  kind: string;
  label: string;
  name: string;
  desc: string;
  pct: number;
  lead: string;
  tone: "up" | "down" | "neutral";
}

type Filter = "all" | "surge" | "fund" | "plunge";
const filter = ref<Filter>("all");
const events = ref<SEvent[]>([]);
const paused = ref(false);
const updated = ref("");

let prev: Map<string, Sector> | null = null;
let timer: number | null = null;

const DPCT = 0.5; // 板块涨跌幅变化阈值（个百分点）
const DNET = 0.5 * 1e8; // 板块净流入变化阈值（元，0.5 亿）

function hhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function snapshot(): Promise<Map<string, Sector>> {
  const [ind, con] = await Promise.all([
    fetchSectors("industry").catch(() => [] as Sector[]),
    fetchSectors("concept").catch(() => [] as Sector[]),
  ]);
  const m = new Map<string, Sector>();
  [...ind, ...con].forEach((s) => m.set(s.code, s));
  return m;
}

function detect(p: Map<string, Sector>, c: Map<string, Sector>): SEvent[] {
  const now = Date.now();
  const out: SEvent[] = [];
  c.forEach((cur, code) => {
    const before = p.get(code);
    if (!before) return; // 首轮基线
    const dpct = cur.changePct - before.changePct;
    const dnet = cur.netAmount - before.netAmount;
    const lead = cur.leadCode.length >= 8 ? cur.leadCode.slice(2) : "";

    if (dpct >= DPCT) {
      out.push({
        time: now, kind: "surge", label: "板块拉升", tone: "up",
        name: cur.name, pct: cur.changePct, lead,
        desc: `拉升 +${dpct.toFixed(2)}% 至 ${cur.changePct.toFixed(2)}%`,
      });
    } else if (dpct <= -DPCT) {
      out.push({
        time: now, kind: "plunge", label: "板块跳水", tone: "down",
        name: cur.name, pct: cur.changePct, lead,
        desc: `跳水 ${dpct.toFixed(2)}% 至 ${cur.changePct.toFixed(2)}%`,
      });
    }
    if (dnet >= DNET) {
      out.push({
        time: now, kind: "fund_in", label: "资金抢筹", tone: "up",
        name: cur.name, pct: cur.changePct, lead,
        desc: `主力净流入 +${(dnet / 1e8).toFixed(2)} 亿`,
      });
    } else if (dnet <= -DNET) {
      out.push({
        time: now, kind: "fund_out", label: "资金出逃", tone: "down",
        name: cur.name, pct: cur.changePct, lead,
        desc: `主力净流出 ${(dnet / 1e8).toFixed(2)} 亿`,
      });
    }
  });
  return out;
}

async function tick() {
  try {
    const curr = await snapshot();
    if (prev) {
      const evs = detect(prev, curr);
      if (evs.length) events.value.unshift(...evs);
      if (events.value.length > 200) events.value.length = 200;
    }
    prev = curr;
    updated.value = hhmmss(Date.now());
  } catch (e) {
    console.error("sectorEvents tick", e);
  }
}

const shown = computed<SEvent[]>(() => {
  if (filter.value === "all") return events.value;
  if (filter.value === "surge") return events.value.filter((e) => e.kind === "surge");
  if (filter.value === "plunge") return events.value.filter((e) => e.kind === "plunge");
  return events.value.filter((e) => e.kind === "fund_in" || e.kind === "fund_out");
});

function togglePause() {
  paused.value = !paused.value;
  if (paused.value) {
    if (timer) clearInterval(timer);
    timer = null;
  } else {
    timer = window.setInterval(tick, 15000);
  }
}
function clearAll() {
  events.value = [];
}
function pick(e: SEvent) {
  if (e.lead) emit("select", e.lead);
}

onMounted(async () => {
  await tick(); // 首次建基线
  timer = window.setInterval(tick, 15000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="se">
    <div class="tabs">
      <button :class="{ on: filter === 'all' }" @click="filter = 'all'">全部</button>
      <button :class="{ on: filter === 'surge' }" @click="filter = 'surge'">拉升</button>
      <button :class="{ on: filter === 'fund' }" @click="filter = 'fund'">资金</button>
      <button :class="{ on: filter === 'plunge' }" @click="filter = 'plunge'">跳水</button>
      <span class="tools">
        <button class="tool" @click="togglePause">{{ paused ? '继续' : '暂停' }}</button>
        <button class="tool" @click="clearAll">清空</button>
      </span>
    </div>

    <div class="body">
      <div v-if="shown.length === 0" class="empty">
        <div class="radar-ico"></div>
        <p>{{ events.length === 0 ? '正在监控板块异动…' : '该类型暂无事件' }}</p>
      </div>
      <TransitionGroup name="ev" tag="div">
        <div v-for="(e, i) in shown" :key="e.time + '-' + e.name + '-' + i"
             class="ev-row" :class="e.tone" @click="pick(e)">
          <span class="t">{{ hhmmss(e.time) }}</span>
          <span class="tag">{{ e.label }}</span>
          <span class="nm">{{ e.name }}</span>
          <span class="desc">{{ e.desc }}</span>
        </div>
      </TransitionGroup>
    </div>
    <div class="foot">更新 {{ updated }}</div>
  </div>
</template>

<style scoped>
.se { height: 100%; display: flex; flex-direction: column; padding: 8px 10px 6px; overflow: hidden; }

.tabs { display: flex; align-items: center; gap: 4px; margin-bottom: 7px; flex-wrap: wrap; }
.tabs button {
  background: transparent; border: 1px solid #2a323d; color: var(--text-dim);
  font-size: 10px; padding: 3px 8px; border-radius: 5px; cursor: pointer;
}
.tabs button.on { background: rgba(224,85,107,.16); border-color: #e0556b; color: #ff8a98; }
.tools { margin-left: auto; display: flex; gap: 4px; }
.tool { font-size: 10px; }

.body { flex: 1; overflow-y: auto; min-height: 0; }
.empty { text-align: center; color: var(--text-dim); padding: 26px 10px; font-size: 11px; }
.radar-ico {
  width: 34px; height: 34px; margin: 0 auto 10px; border-radius: 50%;
  border: 2px solid #2a323d; border-top-color: #e0556b; animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.ev-row {
  display: grid; grid-template-columns: 44px 48px 1fr; gap: 4px 6px;
  padding: 6px 6px; border-radius: 6px; cursor: pointer; margin-bottom: 4px;
  background: #141920; border-left: 3px solid #444;
}
.ev-row.up { border-left-color: #e0556b; }
.ev-row.down { border-left-color: #22b573; }
.ev-row.neutral { border-left-color: #e3b341; }
.ev-row:hover { background: #181f29; }
.t { font-size: 10px; color: var(--text-dim); font-variant-numeric: tabular-nums; align-self:center; }
.tag {
  font-size: 10px; text-align: center; border-radius: 4px; padding: 2px 0; align-self:center;
}
.ev-row.up .tag { color: #ff8a98; background: rgba(224,85,107,.14); }
.ev-row.down .tag { color: #4fd6a8; background: rgba(34,181,115,.14); }
.nm { font-size: 11px; font-weight: 600; color: #d6dae0; }
.desc { grid-column: 2 / 4; font-size: 10px; color: var(--text-dim); font-variant-numeric: tabular-nums; }

.foot { font-size: 9px; color: #5b6470; padding-top: 5px; text-align: right; font-variant-numeric: tabular-nums; }

.ev-enter-active, .ev-leave-active { transition: all .35s ease; }
.ev-enter { opacity: 0; transform: translateX(14px); }
.ev-leave-to { opacity: 0; transform: translateX(-14px); }
</style>
