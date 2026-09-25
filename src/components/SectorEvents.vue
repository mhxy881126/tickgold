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
  tone: "up" | "down" | "neutral";
  init?: boolean;
}

type Filter = "all" | "surge" | "fund" | "plunge" | "lead";
const filter = ref<Filter>("all");
const events = ref<SEvent[]>([]);
const paused = ref(false);
const ready = ref(false);
const updated = ref("");
const nowTrading = ref(true);

let prev: Map<string, Sector> | null = null;

const DPCT = 0.3; // 板块涨跌幅变化阈值（个百分点）
const DNET = 0.3 * 1e8; // 板块净流入变化阈值（元，0.3 亿）

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

/// 首次基线：把当前真实的领涨 / 资金青睐 / 走弱板块作为快照事件，保证卡片非空
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
    desc, init: true,
  });
  const valid = all.filter((s) => s.name);
  const byPct = [...valid].sort((a, b) => b.changePct - a.changePct);
  const byNet = [...valid].sort((a, b) => b.netAmount - a.netAmount);
  const out: SEvent[] = [];
  byPct.slice(0, 5).forEach((s) =>
    out.push(mk(s, "lead_up", "领涨板块", "up", `当前涨幅 ${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(2)}%`))
  );
  byNet.slice(0, 5).forEach((s) => {
    const n = s.netAmount / 1e8;
    out.push(mk(s, "lead_fund", "资金青睐", n >= 0 ? "up" : "down", `当前净流入 ${n >= 0 ? "+" : ""}${n.toFixed(2)} 亿`));
  });
  byPct.slice(-3).forEach((s) =>
    out.push(mk(s, "lead_down", "走弱板块", "down", `当前涨幅 ${s.changePct.toFixed(2)}%`))
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

function togglePause() {
  // 仅切换手动暂停信号，启停交给智能轮询（同时保留可见 / 在线 / 聚焦感知）
  paused.value = !paused.value;
}
function clearAll() {
  // 清空实时异动，保留基线快照
  events.value = events.value.filter((e) => e.init);
}
function pick(e: SEvent) {
  if (e.lead) emit("select", e.lead);
}

onMounted(() => calcTrading());
// 智能轮询：可见 / 在线 / 非聚焦后台时每 15s 检测板块异动；手动暂停、断网、最小化自动停，恢复即刷新
useSmartPolling(tick, { interval: 15000, cardId: "sectorevents", paused });
</script>

<template>
  <div class="se">
    <div class="tabs">
      <button :class="{ on: filter === 'all' }" @click="filter = 'all'">全部</button>
      <button :class="{ on: filter === 'lead' }" @click="filter = 'lead'">当前强势</button>
      <button :class="{ on: filter === 'surge' }" @click="filter = 'surge'">拉升</button>
      <button :class="{ on: filter === 'fund' }" @click="filter = 'fund'">资金</button>
      <button :class="{ on: filter === 'plunge' }" @click="filter = 'plunge'">跳水</button>
      <span class="tools">
        <button class="tool" @click="togglePause">{{ paused ? '继续' : '暂停' }}</button>
        <button class="tool" @click="clearAll">清空</button>
      </span>
    </div>
    <div v-if="!nowTrading && ready" class="market-flag">非交易时段 · 板块数据定格，下方为最近快照</div>

    <div class="body">
      <div v-if="shown.length === 0" class="empty">
        <div class="radar-ico"></div>
        <p v-if="!ready">正在加载板块快照…</p>
        <p v-else>{{ events.length === 0 ? '正在监控板块异动…' : '该类型暂无事件' }}</p>
      </div>
      <TransitionGroup name="ev" tag="div">
        <div
          v-for="(e, i) in shown"
          :key="(e.init ? 'b' : 'l') + e.time + '-' + e.kind + '-' + e.name + '-' + i"
          class="ev-row"
          :class="[e.tone, { snapshot: e.init }]"
          @click="pick(e)"
        >
          <span class="t">{{ e.init ? '快照' : hhmmss(e.time) }}</span>
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

.market-flag {
  font-size: 10px; color: #e8c66a; background: rgba(212,175,55,.1);
  border: 1px solid rgba(212,175,55,.3); border-radius: 5px;
  padding: 4px 8px; margin-bottom: 7px;
}

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
/* 基线快照：金色区分，弱化"实时异动"感 */
.ev-row.snapshot { background: #171821; border-left-color: #b89a4e; }
.ev-row.snapshot .t { color: #b89a4e; font-size: 9px; }
.ev-row:hover { background: #181f29; }
.t { font-size: 10px; color: var(--text-dim); font-variant-numeric: tabular-nums; align-self: center; }
.tag {
  font-size: 10px; text-align: center; border-radius: 4px; padding: 2px 0; align-self: center;
}
.ev-row.up .tag { color: #ff8a98; background: rgba(224,85,107,.14); }
.ev-row.down .tag { color: #4fd6a8; background: rgba(34,181,115,.14); }
.ev-row.snapshot .tag { color: #e8c66a; background: rgba(212,175,55,.14); }
.nm { font-size: 11px; font-weight: 600; color: #d6dae0; }
.desc { grid-column: 2 / 4; font-size: 10px; color: var(--text-dim); font-variant-numeric: tabular-nums; }

.foot { font-size: 9px; color: #5b6470; padding-top: 5px; text-align: right; font-variant-numeric: tabular-nums; }

.ev-enter-active, .ev-leave-active { transition: all .35s ease; }
.ev-enter { opacity: 0; transform: translateX(14px); }
.ev-leave-to { opacity: 0; transform: translateX(-14px); }
</style>
