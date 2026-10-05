<script setup lang="ts">
import * as echarts from "echarts";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { fetchSectors, fetchSectorStocks } from "../api/market";
import type { Sector } from "../api/types";
import { useWorkbench } from "../composables/useWorkbench";

const emit = defineEmits<{ select: [code: string]; sector: [name: string, kind: string] }>();
const bench = useWorkbench();
const selectedSector = ref<Sector | null>(null);
const stocks = ref<{ code: string; name: string; price: number; pct: number }[]>([]);
const loadingStocks = ref(false);

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
            itemStyle: { color: "rgba(20,25,35,.9)", borderColor: "#d4af37", borderWidth: 1 },
            emphasisItemStyle: { color: "rgba(40,50,65,.95)" },
            textStyle: { color: "#d4af37", fontSize: 11, fontWeight: "600" },
          },
          animationDuration: 600,
          squareRatio: 0.62,
          label: {
            show: true,
            visibleMin: 100,
            formatter: (p: any) => {
              const d = p.data as Cell;
              const cp = d._pct;
              const arrow = cp >= 0 ? "▲" : "▼";
              return `{n|${d.name}}\n{v|${arrow}${Math.abs(cp).toFixed(2)}%}`;
            },
            rich: {
              n: { color: "#fff", fontSize: 13, lineHeight: 18, fontWeight: "700", textShadowColor: "rgba(0,0,0,.6)", textShadowBlur: 4 },
              v: { color: "rgba(255,255,255,.95)", fontSize: 11, lineHeight: 15, fontWeight: "600" },
            },
          },
          itemStyle: {
            borderColor: "rgba(13,17,23,.8)",
            borderWidth: 3,
            gapWidth: 3,
            borderRadius: 8,
          },
          emphasis: {
            itemStyle: {
              borderColor: "#d4af37",
              borderWidth: 2,
              shadowBlur: 20,
              shadowColor: "rgba(212,175,55,.4)",
            },
          },
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
    // 数据加载后确保 resize 铺满容器
    requestAnimationFrame(() => chart?.resize());
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
    console.log("[sectorheat] click", p.name);
    if (p?.name) {
      const sec = sectors.find((s) => s.name === p.name);
      if (sec) {
        selectedSector.value = sec;
        loadingStocks.value = true;
        stocks.value = [];
        fetchSectorStocks(sec.code, kind.value).then((arr) => {
          stocks.value = (arr || []).slice(0, 30).map((x: any) => ({
            code: (x.symbol || x.code || "").replace(/^(sh|sz)/, ""),
            name: x.name || x.stockname || "",
            price: parseFloat(x.trade || x.price || 0),
            pct: parseFloat(x.changeratio || x.changepercent || 0),
          })).filter((s: any) => s.code);
        }).catch(() => {}).finally(() => (loadingStocks.value = false));
      }
    }
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
    <div class="main">
      <div class="canvas-wrap">
        <div ref="elRef" class="canvas"></div>
        <div class="hint">滚轮缩放 · 拖拽平移 · 点击板块查看成分股</div>
        <div v-if="errMsg" class="err-mask">{{ errMsg }}</div>
      </div>
      <div class="side">
        <template v-if="selectedSector">
          <div class="sec-head">
            <div class="sec-name">{{ selectedSector.name }}</div>
            <div class="sec-pct" :class="selectedSector.changePct >= 0 ? 'up' : 'down'">
              {{ selectedSector.changePct >= 0 ? '+' : '' }}{{ selectedSector.changePct.toFixed(2) }}%
            </div>
          </div>
          <div class="sec-info">
            <span>净流入 <b :class="selectedSector.netAmount >= 0 ? 'up' : 'down'">{{ (selectedSector.netAmount / 1e8).toFixed(1) }}亿</b></span>
            <span>领涨 <b>{{ selectedSector.leadName }}</b></span>
          </div>
          <div class="stocks">
            <div v-if="loadingStocks" class="empty">加载中...</div>
            <div v-else-if="stocks.length === 0" class="empty">暂无成分股数据</div>
            <div v-for="s in stocks" :key="s.code" class="stock-row" @click="emit('select', s.code)">
              <span class="s-name">{{ s.name }}</span>
              <span class="s-code">{{ s.code }}</span>
              <span class="s-pct" :class="s.pct >= 0 ? 'up' : 'down'">{{ s.pct >= 0 ? '+' : '' }}{{ s.pct.toFixed(2) }}%</span>
            </div>
          </div>
        </template>
        <div v-else class="side-empty">
          <div class="icon">◈</div>
          <div>点击左侧板块<br>查看成分股</div>
        </div>
      </div>
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

.main { flex: 1; display: flex; gap: 8px; min-height: 0; }
.canvas-wrap { flex: 1.5; position: relative; min-height: 0; min-width: 0; }
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

/* 右侧成分股面板 */
.side {
  flex: 1; min-width: 0; display: flex; flex-direction: column;
  background: rgba(14,18,27,.6); border: 1px solid #1b2230; border-radius: 8px;
  overflow: hidden;
}
.sec-head {
  padding: 10px 12px; border-bottom: 1px solid #1b2230;
  display: flex; align-items: center; justify-content: space-between;
}
.sec-name { font-size: 14px; font-weight: 700; color: #f0f4fa; }
.sec-pct { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.sec-pct.up { color: #f04a5a; }
.sec-pct.down { color: #26c281; }
.sec-info {
  padding: 8px 12px; display: flex; gap: 16px;
  font-size: 11px; color: var(--text-dim); border-bottom: 1px solid #1b2230;
}
.sec-info b { color: #e0e6ed; font-weight: 600; }
.up { color: #f04a5a; }
.down { color: #26c281; }
.stocks { flex: 1; overflow-y: auto; }
.stock-row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; cursor: pointer; border-bottom: 1px solid rgba(27,34,48,.5);
  font-size: 12px; transition: background .15s;
}
.stock-row:hover { background: rgba(255,255,255,.04); }
.s-name { flex: 1; color: #e0e6ed; }
.s-code { color: var(--text-dim); font-size: 10px; }
.s-pct { font-weight: 600; font-variant-numeric: tabular-nums; }
.side-empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; color: var(--text-dim); font-size: 12px; text-align: center;
}
.side-empty .icon { font-size: 28px; opacity: .3; }
</style>
