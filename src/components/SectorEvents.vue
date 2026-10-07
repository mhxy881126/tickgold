<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { fetchSectors } from "../api/market";
import type { Sector } from "../api/types";
import { useSmartPolling } from "../composables/useSmartPolling";

const emit = defineEmits<{ select: [code: string] }>();

interface SEvent {
  time: number;
  kind: string;
  label: string;
  name: string;
  desc: string;
  pct: number;
  lead: string;
  leadName: string;
  tone: "up" | "down" | "neutral";
  init?: boolean;
  netAmount?: number;
}

type Filter = "all" | "surge" | "fund" | "plunge" | "lead";
const filter = ref<Filter>("all");
const events = ref<SEvent[]>([]);
const paused = ref(false);
const ready = ref(false);
const updated = ref("");
const nowTrading = ref(true);
const expanded = ref<Set<number>>(new Set());

let prev: Map<string, Sector> | null = null;

const DPCT = 0.3;
const DNET = 0.3 * 1e8;

function hhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function calcTrading() {
  const d = new Date();
  const day = d.getDay();
  const hm = d.getHours() * 60 + d.getMinutes();
  nowTrading.value = day >= 1 && day <= 5 && hm >= 9 * 60 + 25 && hm <= 15 * 60 + 5;
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

function buildBaseline(all: Sector[]): SEvent[] {
  const now = Date.now();
  const mk = (
    s: Sector,
    kind: string,
    label: string,
    tone: "up" | "down" | "neutral",
    desc: string
  ): SEvent => ({
    time: now, kind, label, tone, name: s.name, pct: s.changePct,
    lead: s.leadCode.length >= 8 ? s.leadCode.slice(2) : "",
    leadName: s.leadName,
    desc, init: true, netAmount: s.netAmount,
  });
  const valid = all.filter((s) => s.name);
  const byPct = [...valid].sort((a, b) => b.changePct - a.changePct);
  const byNet = [...valid].sort((a, b) => b.netAmount - a.netAmount);
  const out: SEvent[] = [];
  // 领涨板块 → surge(拉升) tab
  byPct.slice(0, 5).forEach((s) =>
    out.push(mk(s, "surge", "领涨板块", "up", `当前涨幅 ${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(2)}%`))
  );
  // 资金青睐 → fund(资金) tab
  byNet.slice(0, 5).forEach((s) => {
    const n = s.netAmount / 1e8;
    out.push(mk(s, "fund_in", "资金青睐", n >= 0 ? "up" : "down", `当前净流入 ${n >= 0 ? "+" : ""}${n.toFixed(2)} 亿`));
  });
  // 走弱板块 → plunge(跳水) tab
  byPct.slice(-3).forEach((s) =>
    out.push(mk(s, "plunge", "走弱板块", "down", `当前涨幅 ${s.changePct.toFixed(2)}%`))
  );
  return out;
}

function detect(p: Map<string, Sector>, c: Map<string, Sector>): SEvent[] {
  const now = Date.now();
  const out: SEvent[] = [];
  c.forEach((cur) => {
    const before = p.get(cur.code);
    if (!before) return;
    const dpct = cur.changePct - before.changePct;
    const dnet = cur.netAmount - before.netAmount;
    const lead = cur.leadCode.length >= 8 ? cur.leadCode.slice(2) : "";

    if (dpct >= DPCT) {
      out.push({
        time: now, kind: "surge", label: "板块拉升", tone: "up",
        name: cur.name, pct: cur.changePct, lead, leadName: cur.leadName, netAmount: cur.netAmount,
        desc: `拉升 +${dpct.toFixed(2)}% 至 ${cur.changePct.toFixed(2)}%`,
      });
    } else if (dpct <= -DPCT) {
      out.push({
        time: now, kind: "plunge", label: "板块跳水", tone: "down",
        name: cur.name, pct: cur.changePct, lead, leadName: cur.leadName, netAmount: cur.netAmount,
        desc: `跳水 ${dpct.toFixed(2)}% 至 ${cur.changePct.toFixed(2)}%`,
      });
    }
    if (dnet >= DNET) {
      out.push({
        time: now, kind: "fund_in", label: "资金抢筹", tone: "up",
        name: cur.name, pct: cur.changePct, lead, leadName: cur.leadName, netAmount: cur.netAmount,
        desc: `主力净流入 +${(dnet / 1e8).toFixed(2)} 亿`,
      });
    } else if (dnet <= -DNET) {
      out.push({
        time: now, kind: "fund_out", label: "资金出逃", tone: "down",
        name: cur.name, pct: cur.changePct, lead, leadName: cur.leadName, netAmount: cur.netAmount,
        desc: `主力净流出 ${(dnet / 1e8).toFixed(2)} 亿`,
      });
    }
  });
  return out;
}

async function tick() {
  try {
    const curr = await snapshot();
    if (!prev) {
      events.value = buildBaseline([...curr.values()]);
    } else {
      const evs = detect(prev, curr);
      if (evs.length) events.value.unshift(...evs);
      if (events.value.length > 200) events.value.length = 200;
    }
    prev = curr;
    updated.value = hhmmss(Date.now());
    ready.value = true;
  } catch (e) {
    console.error("sectorEvents tick", e);
  }
}

const shown = computed<SEvent[]>(() => {
  if (filter.value === "all") return events.value;
  if (filter.value === "surge") return events.value.filter((e) => e.kind === "surge");
  if (filter.value === "plunge") return events.value.filter((e) => e.kind === "plunge");
  if (filter.value === "lead") return events.value.filter((e) => e.init);
  return events.value.filter((e) => e.kind === "fund_in" || e.kind === "fund_out");
});

function togglePause() { paused.value = !paused.value; }
function clearAll() { events.value = events.value.filter((e) => e.init); }
function pick(e: SEvent) {
  if (e.lead) emit("select", e.lead);
}
function toggleExpand(i: number) {
  const s = new Set(expanded.value);
  if (s.has(i)) s.delete(i); else s.add(i);
  expanded.value = s;
}
function money(v?: number): string {
  if (!v) return "—";
  const n = v / 1e8;
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "亿";
}

onMounted(() => calcTrading());
useSmartPolling(tick, { interval: 15000, cardId: "sectorevents", paused });
</script>

<template>
  <div class="se">
    <!-- Tab切换 -->
    <div class="tabs">
      <button :class="{ on: filter === 'all' }" @click="filter = 'all'">全部</button>
      <button :class="{ on: filter === 'lead' }" @click="filter = 'lead'">领涨</button>
      <button :class="{ on: filter === 'surge' }" @click="filter = 'surge'">拉升</button>
      <button :class="{ on: filter === 'fund' }" @click="filter = 'fund'">资金</button>
      <button :class="{ on: filter === 'plunge' }" @click="filter = 'plunge'">跳水</button>
    </div>

    <!-- 表头 -->
    <div class="grid head">
      <span>时间</span>
      <span>板块名称</span>
      <span>异动信息</span>
      <span class="r">涨跌幅</span>
    </div>

    <div v-if="!nowTrading && ready" class="market-flag">非交易时段 · 板块数据定格</div>

    <div class="body">
      <div v-if="shown.length === 0" class="empty">
        <p>{{ !ready ? "正在加载…" : "暂无异动" }}</p>
      </div>
      <TransitionGroup name="ev" tag="div">
        <div
          v-for="(e, i) in shown"
          :key="(e.init ? 'b' : 'l') + e.time + '-' + e.kind + '-' + e.name + '-' + i"
        >
          <!-- 主行 -->
          <div
            class="row"
            :class="[e.tone, { snapshot: e.init }]"
            @click="toggleExpand(i)"
          >
            <span class="t">{{ e.init ? "快照" : hhmmss(e.time) }}</span>
            <span class="nm">{{ e.name }}</span>
            <span class="ds">{{ e.label }} · {{ e.desc }}</span>
            <span class="pct" :class="e.tone">{{ e.pct >= 0 ? "+" : "" }}{{ e.pct.toFixed(2) }}%</span>
          </div>
          <!-- 展开详情 -->
          <div v-if="expanded.has(i)" class="detail" @click.stop>
            <div class="d-row">
              <span class="d-label">领涨股</span>
              <span class="d-val up" v-if="e.lead" @click="pick(e)">{{ e.leadName || e.lead }} →</span>
              <span class="d-val" v-else>—</span>
            </div>
            <div class="d-row">
              <span class="d-label">主力净流入</span>
              <span class="d-val" :class="(e.netAmount ?? 0) >= 0 ? 'up' : 'down'">{{ money(e.netAmount) }}</span>
            </div>
            <div class="d-row">
              <span class="d-label">异动类型</span>
              <span class="d-val">{{ e.label }}</span>
            </div>
          </div>
        </div>
      </TransitionGroup>
    </div>

    <div class="foot">更新 {{ updated }}</div>
  </div>
</template>

<style scoped>
.se { height: 100%; display: flex; flex-direction: column; padding: 6px 8px; overflow: hidden; font-size: 13px; }

.tabs { display: flex; gap: 2px; margin-bottom: 6px; flex-shrink: 0; }
.tabs button {
  background: transparent; border: none; color: var(--text-dim);
  font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer;
}
.tabs button.on { background: rgba(212,175,55,.15); color: var(--accent); font-weight: 600; }

.grid { display: grid; grid-template-columns: 55px 100px 1fr 75px; gap: 6px; align-items: center; }
.head { padding: 4px 6px; font-size: 11px; color: var(--text-dim); border-bottom: 1px solid var(--border); }
.head .r { text-align: right; }

.market-flag {
  font-size: 11px; color: #e8c66a; background: rgba(212,175,55,.1);
  border: 1px solid rgba(212,175,55,.3); border-radius: 5px;
  padding: 5px 8px; margin-bottom: 6px;
}

.body { flex: 1; overflow-y: auto; min-height: 0; }
.empty { text-align: center; color: var(--text-dim); padding: 26px 10px; font-size: 12px; }

.row {
  display: grid; grid-template-columns: 55px 100px 1fr 75px; gap: 6px;
  align-items: center; padding: 7px 6px; cursor: pointer;
  border-left: 2px solid transparent;
}
.row:hover { background: var(--bg-hover); }
.row.up { border-left-color: var(--up); }
.row.down { border-left-color: var(--down); }
.row.neutral { border-left-color: var(--accent); }
.row.snapshot { background: rgba(212,175,55,.04); }
.row.snapshot:hover { background: var(--bg-hover); }
.t { font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.row.snapshot .t { color: var(--accent); }
.nm { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ds { font-size: 11px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pct { text-align: right; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.pct.up { color: var(--up); }
.pct.down { color: var(--down); }

.detail {
  background: var(--bg-card2); padding: 8px 12px 8px 60px;
  border-bottom: 1px solid var(--border); font-size: 12px;
}
.d-row { display: flex; justify-content: space-between; padding: 3px 0; }
.d-label { color: var(--text-dim); }
.d-val { font-variant-numeric: tabular-nums; cursor: pointer; }
.d-val.up { color: var(--up); }
.d-val.down { color: var(--down); }

.foot { font-size: 10px; color: var(--text-dim); padding-top: 4px; text-align: right; }

.ev-enter-active, .ev-leave-active { transition: all .3s ease; }
.ev-enter { opacity: 0; transform: translateX(14px); }
.ev-leave-to { opacity: 0; transform: translateX(-14px); }
</style>
