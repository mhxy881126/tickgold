<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { fetchSectors } from "../api/market";
import { useMarketFeeds } from "../composables/useMarketFeeds";
import type { Sector } from "../api/types";

const { radar } = useMarketFeeds({ spider: false, sectors: false });

const ind = ref<Sector[]>([]);
const con = ref<Sector[]>([]);
const all = computed(() => {
  const map = new Map<string, Sector>();
  [...ind.value, ...con.value].forEach((s) => {
    const ex = map.get(s.code);
    if (!ex || Math.abs(s.changePct) > Math.abs(ex.changePct)) map.set(s.code, s);
  });
  return [...map.values()];
});

const netYi = computed(() => (all.value.reduce((a, s) => a + s.netAmount, 0) / 1e8).toFixed(1));
const topIn = computed(() => [...all.value].sort((a, b) => b.netAmount - a.netAmount).slice(0, 5));
const topOut = computed(() => [...all.value].sort((a, b) => a.netAmount - b.netAmount).slice(0, 5));

function hc(v: number) {
  return v >= 5 ? "#f23645" : v >= 2 ? "#ff5d5e" : v >= 0.5 ? "#e8828c"
    : v >= -0.5 ? "#5a6478" : v >= -2 ? "#12a876" : "#08db94";
}
function group(gname: string, list: Sector[]) {
  const children = list.map((s) => {
    const v = Math.max(s.inAmount + s.outAmount, 1);
    return {
      name: s.name, value: v,
      label: { formatter: `${s.name} ${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(1)}%` },
      itemStyle: { color: hc(s.changePct) },
    };
  });
  return { name: gname, value: children.reduce((a, c) => a + (c.value as number), 0), children };
}

const treeEl = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;
function renderTree() {
  if (!chart) return;
  chart.setOption({
    tooltip: { show: false },
    series: [{
      type: "treemap", roam: false, nodeClick: false, breadcrumb: { show: false },
      levels: [
        { itemStyle: { borderWidth: 3, gapWidth: 3, borderColor: "#080a0e" },
          label: { show: true, position: "insideTopLeft", fontSize: 13, fontWeight: 800, color: "#fff", padding: [5, 0, 0, 6] } },
        { itemStyle: { borderWidth: 1, gapWidth: 1, borderColor: "#0d1016", borderRadius: 3 },
          label: { show: true, fontSize: 9.5, color: "#fff" } },
      ],
      data: [group("行业板块", ind.value), group("概念板块", con.value)],
    }],
  });
}

let timer = 0;
async function load() {
  try {
    const [a, b] = await Promise.all([fetchSectors("industry"), fetchSectors("concept")]);
    ind.value = a; con.value = b;
    await nextTick(); renderTree();
  } catch (e) { console.error(e); }
}
onMounted(async () => {
  await nextTick();
  if (treeEl.value) chart = echarts.init(treeEl.value);
  load();
  timer = window.setInterval(load, 15000);
});

onBeforeUnmount(() => {
  window.clearInterval(timer);
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div class="mh">
    <!-- 顶部统计条 -->
    <div class="mh-stats">
      <div class="st"><b class="up">{{ radar?.upCount ?? 0 }}</b><span>上涨</span></div>
      <div class="st"><b class="down">{{ radar?.downCount ?? 0 }}</b><span>下跌</span></div>
      <div class="st"><b class="up">{{ radar?.limitUp ?? 0 }}</b><span>涨停</span></div>
      <div class="st"><b class="down">{{ radar?.limitDown ?? 0 }}</b><span>跌停</span></div>
      <div class="st"><b class="flat">{{ radar?.broken ?? 0 }}</b><span>炸板</span></div>
      <div class="st"><b class="up">{{ Math.round(100 - (radar?.brokenRate ?? 0)) }}%</b><span>封板率</span></div>
      <div class="st"><b class="up">{{ netYi }}</b><span>主力净流入(亿)</span></div>
      <div class="st"><b class="flat">{{ Math.round(radar?.sentiment ?? 0) }}</b><span>情绪温度</span></div>
    </div>

    <div class="mh-body">
      <div class="mh-tree">
        <div class="ch">板块热力矩阵<span>面积=资金活跃度 · 颜色=涨跌幅</span></div>
        <div ref="treeEl" class="tree"></div>
      </div>
      <div class="mh-side">
        <div class="side-card" style="flex:1.3;min-height:0">
          <div class="ch">主力资金 TOP</div>
          <div class="scroll funds">
            <div v-for="s in topIn" :key="'i'+s.code" class="fr">
              <span class="nm">{{ s.name }}</span><b class="up">{{ (s.netAmount/1e8).toFixed(2) }}亿</b>
              <em class="up">{{ s.changePct >= 0 ? '+' : '' }}{{ s.changePct.toFixed(1) }}%</em>
            </div>
            <div class="sep">流出</div>
            <div v-for="s in topOut" :key="'o'+s.code" class="fr">
              <span class="nm">{{ s.name }}</span><b class="down">{{ (s.netAmount/1e8).toFixed(2) }}亿</b>
              <em class="down">{{ s.changePct >= 0 ? '+' : '' }}{{ s.changePct.toFixed(1) }}%</em>
            </div>
          </div>
        </div>
        <div class="side-card" style="flex:1;min-height:0">
          <div class="ch">涨停统计</div>
          <div class="lim">
            <div><b class="up">{{ radar?.maxBoards ?? 0 }}</b><span>最高连板</span></div>
            <div><b class="flat">{{ radar?.flatCount ?? 0 }}</b><span>平盘</span></div>
            <p class="mood">{{ radar?.mood ?? "等待数据" }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mh { display:flex;flex-direction:column;height:100%;min-height:0;gap:9px; }
.mh-stats { flex-shrink:0;display:grid;grid-template-columns:repeat(8,1fr);gap:8px; }
.st { display:flex;flex-direction:column;align-items:center;gap:1px;padding:7px 0;border-radius:10px;
  background:var(--bg-card,#0f141d);border:1px solid var(--border,#1e2738); }
.st b { font-size:16px;font-variant-numeric:tabular-nums; } .st span { font-size:9.5px;color:var(--text-dim); }
.mh-body { flex:1;min-height:0;display:grid;grid-template-columns:1fr 280px;gap:9px; }
.mh-tree,.side-card { display:flex;flex-direction:column;min-height:0;
  background:var(--bg-card,#0f141d);border:1px solid var(--border,#1e2738);border-radius:11px;overflow:hidden; }
.ch { height:32px;flex-shrink:0;display:flex;align-items:center;gap:8px;padding:0 11px;font-size:12px;font-weight:700;border-bottom:1px solid var(--border); }
.ch span { margin-left:auto;font-size:9.5px;font-weight:400;color:var(--text-dim); }
.tree { flex:1;min-height:0; }
.mh-side { display:flex;flex-direction:column;gap:9px;min-height:0;min-width:0; }
.scroll { overflow-y:auto;scrollbar-width:thin; } .scroll::-webkit-scrollbar{width:5px;} .scroll::-webkit-scrollbar-thumb{background:#2a3344;border-radius:3px;}
.funds { padding:5px 9px; }
.fr { display:grid;grid-template-columns:1fr 70px 52px;align-items:center;height:24px;font-size:10.5px; }
.fr .nm { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.fr b { font-variant-numeric:tabular-nums;font-size:10.5px; } .fr em { font-style:normal;text-align:right;font-variant-numeric:tabular-nums;font-size:10px; }
.sep { font-size:9.5px;color:var(--text-dim);padding:5px 0 2px;border-top:1px solid var(--border);margin-top:4px; }
.lim { flex:1;display:grid;grid-template-columns:1fr 1fr;align-content:start;gap:8px;padding:10px; }
.lim div { display:flex;flex-direction:column;align-items:center;gap:1px; }
.lim b { font-size:18px; } .lim span { font-size:9.5px;color:var(--text-dim); }
.mood { grid-column:1/-1;text-align:center;font-size:11px;color:var(--text-dim);padding-top:8px;border-top:1px solid var(--border); }
.up { color:#f25266; } .down { color:#22b573; } .flat { color:#f0a23a; }
</style>
