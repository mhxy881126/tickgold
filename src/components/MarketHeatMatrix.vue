<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import * as echarts from "echarts";
import { fetchSectors, fetchSectorStocks } from "../api/market";
import { useMarketFeeds } from "../composables/useMarketFeeds";
import type { Sector } from "../api/types";

const emit = defineEmits<{ (e: "select", code: string): void }>();

const { radar } = useMarketFeeds({ spider: false, sectors: false });

const ind = ref<Sector[]>([]);
const con = ref<Sector[]>([]);
const loading = ref(true);

// 选中板块及其成分股
const selectedSector = ref<Sector | null>(null);
const selectedKind = ref<"industry" | "concept">("concept");
const sectorStocks = ref<{ code: string; name: string; price: number; pct: number }[]>([]);
const stocksLoading = ref(false);

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

const hasRadar = computed(() => !!radar.value && radar.value.total > 0);
const sealRate = computed(() => {
  if (!radar.value || radar.value.limitUp === 0) return null;
  const lu = radar.value.limitUp;
  const br = radar.value.broken;
  if (lu + br === 0) return null;
  return Math.round((lu / (lu + br)) * 100);
});

function hc(v: number) {
  return v >= 5 ? "#f23645" : v >= 2 ? "#ff5d5e" : v >= 0.5 ? "#e8828c"
    : v >= -0.5 ? "#5a6478" : v >= -2 ? "#12a876" : "#08db94";
}

function group(gname: string, list: Sector[]) {
  const children = list.map((s) => {
    const v = Math.max(s.inAmount + s.outAmount, 1);
    return {
      name: s.name, value: v, sector: s,
      label: {
        formatter: `{n|${s.name}}\n{p|${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(1)}%}`,
        rich: {
          n: { fontSize: 11, fontWeight: 700, color: "#fff", lineHeight: 15 },
          p: { fontSize: 10, color: "#fff", opacity: 0.85, lineHeight: 13 },
        },
      },
      itemStyle: { color: hc(s.changePct) },
    };
  });
  return { name: gname, value: children.reduce((a, c) => a + (c.value as number), 0), children };
}

const treeEl = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;

function onChartClick(params: any) {
  const data = params.data;
  if (!data?.sector) return;
  const s: Sector = data.sector;
  const kind = ind.value.find((x) => x.code === s.code) ? "industry" : "concept";
  selectSector(s, kind);
}

async function selectSector(s: Sector, kind: "industry" | "concept") {
  selectedSector.value = s;
  selectedKind.value = kind;
  stocksLoading.value = true;
  sectorStocks.value = [];
  try {
    const arr = await fetchSectorStocks(s.code, kind);
    sectorStocks.value = (arr || []).slice(0, 50).map((x: any) => ({
      code: (x.symbol || x.code || "").replace(/^(sh|sz)/, ""),
      name: x.name || x.stockname || "",
      price: parseFloat(x.trade || x.price || 0),
      pct: parseFloat(x.changeratio || x.changepercent || 0),
    })).filter((s: any) => s.code);
  } catch {
    sectorStocks.value = [];
  } finally {
    stocksLoading.value = false;
  }
}

function closeSector() {
  selectedSector.value = null;
  sectorStocks.value = [];
}

function pickStock(code: string) {
  if (code) emit("select", code);
}

function renderTree() {
  if (!chart) return;
  chart.setOption({
    tooltip: {
      show: true,
      formatter: (p: any) => {
        const s = p.data?.sector;
        if (!s) return p.name;
        return `<b>${s.name}</b><br/>涨跌幅: ${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(2)}%<br/>净流入: ${(s.netAmount / 1e8).toFixed(2)}亿<br/>领涨: ${s.leadName} ${s.leadPct >= 0 ? "+" : ""}${s.leadPct.toFixed(1)}%<br/><span style="color:#8ab4ff">点击查看成分股 →</span>`;
      },
      backgroundColor: "rgba(15,20,29,0.95)",
      borderColor: "#2a3344",
      textStyle: { color: "#d8dee9", fontSize: 11 },
    },
    series: [{
      type: "treemap", roam: true, nodeClick: false, breadcrumb: { show: false },
      leafDepth: 2,
      animationDuration: 300,
      levels: [
        { itemStyle: { borderWidth: 3, gapWidth: 3, borderColor: "#080a0e" },
          label: { show: true, position: "insideTopLeft", fontSize: 13, fontWeight: 800, color: "#fff", padding: [6, 0, 0, 8] } },
        { itemStyle: { borderWidth: 1, gapWidth: 1, borderColor: "#0d1016", borderRadius: 3 },
          label: { show: true, fontSize: 10, color: "#fff" } },
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
    loading.value = false;
    await nextTick(); renderTree();
  } catch (e) { console.error(e); loading.value = false; }
}

onMounted(async () => {
  await nextTick();
  if (treeEl.value) {
    chart = echarts.init(treeEl.value);
    chart.on("click", onChartClick);
  }
  load();
  timer = window.setInterval(load, 8000);
});

onBeforeUnmount(() => {
  window.clearInterval(timer);
  chart?.off("click", onChartClick);
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div class="mh">
    <!-- 顶部统计条 -->
    <div class="mh-stats">
      <div class="st" v-if="hasRadar"><b class="up">{{ radar?.upCount }}</b><span>上涨</span></div>
      <div class="st" v-if="hasRadar"><b class="down">{{ radar?.downCount }}</b><span>下跌</span></div>
      <div class="st" v-if="hasRadar"><b class="up">{{ radar?.limitUp }}</b><span>涨停</span></div>
      <div class="st" v-if="hasRadar"><b class="down">{{ radar?.limitDown }}</b><span>跌停</span></div>
      <div class="st" v-if="hasRadar"><b class="flat">{{ radar?.broken }}</b><span>炸板</span></div>
      <div class="st" v-if="sealRate !== null"><b class="up">{{ sealRate }}%</b><span>封板率</span></div>
      <div class="st"><b class="up">{{ netYi }}</b><span>主力净流入(亿)</span></div>
      <div class="st" v-if="hasRadar"><b class="flat">{{ Math.round(radar?.sentiment ?? 0) }}</b><span>情绪温度</span></div>
      <div class="st st-waiting" v-if="!hasRadar"><b class="flat">--</b><span>等待行情</span></div>
    </div>

    <div class="mh-body">
      <!-- 左侧：热力图 -->
      <div class="mh-tree">
        <div class="ch">板块热力矩阵<span>面积=资金活跃度 · 颜色=涨跌幅 · 点击板块查看成分股</span></div>
        <div ref="treeEl" class="tree"></div>
        <div v-if="loading" class="tree-loading">加载板块数据…</div>
      </div>

      <!-- 右侧面板 -->
      <div class="mh-side">
        <!-- 选中板块：成分股列表 -->
        <div v-if="selectedSector" class="side-card side-stocks">
          <div class="ch">
            <span class="sec-name">{{ selectedSector.name }}</span>
            <button class="back-btn" @click="closeSector">‹ 返回总览</button>
          </div>
          <div class="ch ch-sub">
            <span class="sec-pct" :class="selectedSector.changePct >= 0 ? 'up' : 'down'">
              {{ selectedSector.changePct >= 0 ? "+" : "" }}{{ selectedSector.changePct.toFixed(2) }}%
            </span>
            <span class="sec-kind">{{ selectedKind === "industry" ? "行业" : "概念" }}</span>
            <span class="sec-count" v-if="!stocksLoading">{{ sectorStocks.length }} 只成分股</span>
          </div>
          <div class="stock-list">
            <div v-if="stocksLoading" class="list-loading">加载成分股…</div>
            <template v-else>
              <div v-for="s in sectorStocks" :key="s.code" class="stock-row" @click="pickStock(s.code)" :title="`${s.name}（${s.code}）— 点击查看K线`">
                <span class="stock-name">{{ s.name }}</span>
                <span class="stock-code">{{ s.code }}</span>
                <span class="stock-pct" :class="s.pct >= 0 ? 'up' : 'down'">
                  {{ s.pct >= 0 ? "+" : "" }}{{ s.pct.toFixed(2) }}%
                </span>
              </div>
              <div v-if="sectorStocks.length === 0" class="list-empty">暂无成分股数据</div>
            </template>
          </div>
        </div>

        <!-- 未选中：主力资金TOP + 涨停统计 -->
        <template v-else>
          <div class="side-card" style="flex:1.3;min-height:0">
            <div class="ch">主力资金 TOP</div>
            <div class="scroll funds">
              <div v-for="s in topIn" :key="'i'+s.code" class="fr" @click="selectSector(s, ind.find(x=>x.code===s.code) ? 'industry' : 'concept')" :title="`点击查看 ${s.name} 成分股`">
                <span class="nm">{{ s.name }}</span><b class="up">{{ (s.netAmount/1e8).toFixed(2) }}亿</b>
                <em class="up">{{ s.changePct >= 0 ? '+' : '' }}{{ s.changePct.toFixed(1) }}%</em>
              </div>
              <div class="sep">流出</div>
              <div v-for="s in topOut" :key="'o'+s.code" class="fr" @click="selectSector(s, ind.find(x=>x.code===s.code) ? 'industry' : 'concept')" :title="`点击查看 ${s.name} 成分股`">
                <span class="nm">{{ s.name }}</span><b class="down">{{ (s.netAmount/1e8).toFixed(2) }}亿</b>
                <em class="down">{{ s.changePct >= 0 ? '+' : '' }}{{ s.changePct.toFixed(1) }}%</em>
              </div>
            </div>
          </div>
          <div class="side-card" style="flex:1;min-height:0">
            <div class="ch">涨停统计</div>
            <div class="lim" v-if="hasRadar">
              <div><b class="up">{{ radar?.maxBoards }}</b><span>最高连板</span></div>
              <div><b class="flat">{{ radar?.flatCount }}</b><span>平盘</span></div>
              <p class="mood">{{ radar?.mood }}</p>
            </div>
            <div class="lim lim-waiting" v-else>
              <div class="waiting-icon">⏳</div>
              <p>非交易时段<br/>等待盘中数据</p>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mh { display:flex;flex-direction:column;height:100%;min-height:0;gap:9px; }
.mh-stats { flex-shrink:0;display:grid;grid-template-columns:repeat(8,1fr);gap:8px; }
.st { display:flex;flex-direction:column;align-items:center;gap:1px;padding:7px 0;border-radius:10px;
  background:var(--bg-card,#0f141d);border:1px solid var(--border,#1e2738); }
.st b { font-size:16px;font-variant-numeric:tabular-nums; }
.st span { font-size:9.5px;color:var(--text-dim); }
.st-waiting b { color: var(--text-dim); }
.mh-body { flex:1;min-height:0;display:grid;grid-template-columns:1fr 280px;gap:9px; }
.mh-tree,.side-card { display:flex;flex-direction:column;min-height:0;position:relative;
  background:var(--bg-card,#0f141d);border:1px solid var(--border,#1e2738);border-radius:11px;overflow:hidden; }
.ch { height:32px;flex-shrink:0;display:flex;align-items:center;gap:8px;padding:0 11px;font-size:12px;font-weight:700;border-bottom:1px solid var(--border); }
.ch span { margin-left:auto;font-size:9.5px;font-weight:400;color:var(--text-dim); }
.tree { flex:1;min-height:0; }
.tree-loading { position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:12px;background:var(--bg-card,#0f141d); }
.mh-side { display:flex;flex-direction:column;gap:9px;min-height:0;min-width:0; }
.scroll { overflow-y:auto;scrollbar-width:thin; }
.scroll::-webkit-scrollbar{width:5px;} .scroll::-webkit-scrollbar-thumb{background:#2a3344;border-radius:3px;}
.funds { padding:5px 9px; }
.fr { display:grid;grid-template-columns:1fr 70px 52px;align-items:center;height:26px;font-size:10.5px;cursor:pointer;border-radius:4px;padding:0 4px; }
.fr:hover { background:rgba(212,175,55,.08); }
.fr .nm { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.fr b { font-variant-numeric:tabular-nums;font-size:10.5px; }
.fr em { font-style:normal;text-align:right;font-variant-numeric:tabular-nums;font-size:10px; }
.sep { font-size:9.5px;color:var(--text-dim);padding:5px 0 2px;border-top:1px solid var(--border);margin-top:4px; }
.lim { flex:1;display:grid;grid-template-columns:1fr 1fr;align-content:start;gap:8px;padding:10px; }
.lim div { display:flex;flex-direction:column;align-items:center;gap:1px; }
.lim b { font-size:18px; } .lim span { font-size:9.5px;color:var(--text-dim); }
.mood { grid-column:1/-1;text-align:center;font-size:11px;color:var(--text-dim);padding-top:8px;border-top:1px solid var(--border); }
.lim-waiting { display:flex;align-items:center;justify-content:center;text-align:center;color:var(--text-dim);font-size:11px;line-height:1.6; }
.waiting-icon { font-size:28px;margin-bottom:6px; }

/* 选中板块的成分股面板 */
.side-stocks { flex:1; }
.sec-name { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.back-btn { margin-left:auto;border:1px solid var(--border);background:transparent;color:var(--text-dim);
  border-radius:5px;padding:2px 10px;font-size:10.5px;cursor:pointer; }
.back-btn:hover { color:var(--accent);border-color:var(--accent); }
.ch-sub { height:28px;font-size:11px; }
.sec-pct { font-weight:700; }
.sec-kind { color:var(--text-dim); }
.sec-count { color:var(--text-dim); }
.stock-list { flex:1;overflow-y:auto;scrollbar-width:thin;padding:4px; }
.stock-list::-webkit-scrollbar{width:5px;} .stock-list::-webkit-scrollbar-thumb{background:#2a3344;border-radius:3px;}
.list-loading,.list-empty { padding:20px;text-align:center;color:var(--text-dim);font-size:11px; }
.stock-row {
  display:grid;grid-template-columns:1fr 60px 60px;align-items:center;
  padding:5px 8px;border-radius:6px;cursor:pointer;font-size:11px;
}
.stock-row:hover { background:rgba(212,175,55,.08); }
.stock-name { color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.stock-code { color:var(--text-dim);font-size:9.5px;text-align:center;font-variant-numeric:tabular-nums; }
.stock-pct { text-align:right;font-weight:600;font-variant-numeric:tabular-nums; }

.up { color:#f25266; } .down { color:#22b573; } .flat { color:#f0a23a; }
</style>
