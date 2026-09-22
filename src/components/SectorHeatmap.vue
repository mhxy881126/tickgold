<script setup lang="ts">
import * as echarts from "echarts";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { fetchSectors } from "../api/market";
import type { Sector } from "../api/types";

const emit = defineEmits<{ select: [code: string] }>();

type Kind = "industry" | "concept";
type SizeBy = "turnover" | "net";
const kind = ref<Kind>("industry");
const sizeBy = ref<SizeBy>("turnover");
const updated = ref("");
const errMsg = ref("");

const elRef = ref<HTMLElement | null>(null);
let sectors: Sector[] = [];
let chart: echarts.ECharts | null = null;
let timer: number | null = null;

// 红涨绿跌，幅度决定深浅（4% 饱和）
function heatColor(pct: number): string {
  const a = Math.min(Math.abs(pct) / 4, 1);
  const alpha = (0.3 + a * 0.62).toFixed(2);
  return pct >= 0 ? `rgba(224,69,90,${alpha})` : `rgba(34,181,115,${alpha})`;
}

function hhmmss(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

interface Cell {
  name: string;
  value: number;
  itemStyle: { color: string };
  _lead: string;
  _leadName: string;
  _leadPct: number;
  _pct: number;
  _net: number;
  _in: number;
  _out: number;
  _big?: boolean;
}

function render() {
  if (!chart) return;
  const data: Cell[] = sectors.map((s) => ({
    name: s.name,
    value: sizeBy.value === "turnover" ? s.inAmount + s.outAmount : Math.abs(s.netAmount),
    itemStyle: { color: heatColor(s.changePct) },
    _lead: s.leadCode,
    _leadName: s.leadName,
    _leadPct: s.leadPct,
    _pct: s.changePct,
    _net: s.netAmount,
    _in: s.inAmount,
    _out: s.outAmount,
  }));

  // 成交规模 top 18% 标记为大方块，标签多显示一行净流入
  const bySize = [...data].sort((a, b) => b.value - a.value);
  const bigN = Math.max(6, Math.floor(bySize.length * 0.18));
  const bigSet = new Set(bySize.slice(0, bigN).map((d) => d.name));
  data.forEach((d) => {
    d._big = bigSet.has(d.name);
  });

  const yi = (n: number) => (n / 1e8).toFixed(2);

  chart.setOption(
    {
      tooltip: {
        backgroundColor: "#161b22",
        borderColor: "#2a313b",
        textStyle: { color: "#e6e9ee", fontSize: 11 },
        formatter: (p: any) => {
          const d = p.data as Cell;
          const net = d._net / 1e8;
          const turn = (d._in + d._out) / 1e8;
          const lead = d._lead.length >= 8 ? d._lead.slice(2) : "";
          const pc = d._pct >= 0 ? "#ff6a7d" : "#4fd6a8";
          return (
            `<b>${d.name}</b><br/>涨幅 <b style="color:${pc}">${d._pct >= 0 ? "+" : ""}${d._pct.toFixed(2)}%</b>` +
            `<br/>净流入 ${net >= 0 ? "+" : ""}${net.toFixed(2)} 亿` +
            `<br/>成交规模 ${turn.toFixed(1)} 亿` +
            `<br/>流入 ${yi(d._in)} 亿 / 流出 ${yi(d._out)} 亿` +
            (lead
              ? `<br/>领涨 ${d._leadName} <span style="color:${d._leadPct >= 0 ? "#ff6a7d" : "#4fd6a8"}">${
                  d._leadPct >= 0 ? "+" : ""
                }${d._leadPct.toFixed(2)}%</span>`
              : "")
          );
        },
      },
      series: [
        {
          type: "treemap",
          roam: true,
          nodeClick: false,
          breadcrumb: {
            show: true,
            bottom: 6,
            itemStyle: { color: "#222a35", borderColor: "#333c48", borderWidth: 1 },
            emphasisItemStyle: { color: "#3a4553" },
            textStyle: { color: "#c9d1d9", fontSize: 10 },
          },
          animationDuration: 400,
          squareRatio: 0.62,
          label: {
            show: true,
            visibleMin: 150,
            formatter: (p: any) => {
              const d = p.data as Cell;
              const cp = d._pct;
              const head = `{n|${d.name}}\n{v|${cp >= 0 ? "+" : ""}${cp.toFixed(2)}%}`;
              if (d._big) {
                const net = d._net / 1e8;
                return head + `\n{m|净${net >= 0 ? "+" : ""}${net.toFixed(1)}亿}`;
              }
              return head;
            },
            rich: {
              n: { color: "#fff", fontSize: 11, lineHeight: 15, fontWeight: "600" },
              v: { color: "rgba(255,255,255,.88)", fontSize: 10, lineHeight: 13 },
              m: { color: "rgba(255,255,255,.62)", fontSize: 9, lineHeight: 12 },
            },
          },
          itemStyle: { borderColor: "#0d1117", borderWidth: 2, gapWidth: 2 },
          upperLabel: { show: false },
          data,
        },
      ],
    },
    true
  );
}

async function load() {
  errMsg.value = "";
  try {
    sectors = await fetchSectors(kind.value);
    render();
    updated.value = hhmmss(new Date());
  } catch (e) {
    errMsg.value = "板块加载失败";
    console.error("sectorHeat", e);
  }
}

function switchKind(k: Kind) {
  if (kind.value !== k) {
    kind.value = k;
    load();
  }
}
function switchSize(s: SizeBy) {
  sizeBy.value = s;
  render();
}
function resize() {
  chart?.resize();
}

onMounted(() => {
  if (elRef.value) chart = echarts.init(elRef.value);
  chart?.on("click", (p: any) => {
    const lead = p.data?._lead;
    if (lead && lead.length >= 8) emit("select", lead.slice(2));
  });
  load();
  timer = window.setInterval(load, 15000);
  window.addEventListener("resize", resize);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  window.removeEventListener("resize", resize);
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div class="heat">
    <div class="bar">
      <div class="group">
        <button :class="{ on: kind === 'industry' }" @click="switchKind('industry')">行业</button>
        <button :class="{ on: kind === 'concept' }" @click="switchKind('concept')">概念</button>
      </div>
      <div class="group">
        <span class="gl">面积</span>
        <button :class="{ on: sizeBy === 'turnover' }" @click="switchSize('turnover')">成交规模</button>
        <button :class="{ on: sizeBy === 'net' }" @click="switchSize('net')">|净流入|</button>
      </div>
      <span class="upd">{{ updated }}</span>
    </div>
    <div class="canvas-wrap">
      <div ref="elRef" class="canvas"></div>
      <div class="hint">滚轮缩放 · 拖拽平移 · 点击板块查看领涨股</div>
      <div v-if="errMsg" class="err-mask">{{ errMsg }}</div>
    </div>
  </div>
</template>

<style scoped>
.heat { height: 100%; display: flex; flex-direction: column; padding: 8px 10px 10px; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.group { display: flex; gap: 4px; align-items: center; }
.gl { font-size: 10px; color: var(--text-dim); margin-right: 2px; }
.group button {
  background: transparent; border: 1px solid #2a323d; color: var(--text-dim);
  font-size: 10px; padding: 3px 9px; border-radius: 5px; cursor: pointer;
}
.group button.on { background: rgba(212,175,55,.16); border-color: #d4af37; color: #e8c66a; }
.upd { font-size: 10px; color: var(--text-dim); font-variant-numeric: tabular-nums; }

.canvas-wrap { flex: 1; position: relative; min-height: 0; }
.canvas { position: absolute; inset: 0; }
.hint {
  position: absolute; left: 8px; top: 6px; z-index: 5; pointer-events: none;
  font-size: 10px; color: rgba(255,255,255,.4);
  background: rgba(13,17,23,.45); border-radius: 4px; padding: 2px 7px;
}
.err-mask {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #e0556b; font-size: 12px;
}
</style>
