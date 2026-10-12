<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from "vue";
import * as echarts from "echarts";
import {
  fetchF10Profile, fetchF10Finance, fetchF10Chips, fetchFundFlow,
  type CompanyProfile, type FinanceReport, type ChipDistribution,
} from "../api/market";
import type { StockFundFlow } from "../api/types";

const props = defineProps<{ code: string | null }>();

type Tab = "profile" | "finance" | "chips" | "fund";
const tab = ref<Tab>("profile");
const profile = ref<CompanyProfile | null>(null);
const finance = ref<FinanceReport | null>(null);
const chipsData = ref<ChipDistribution | null>(null);
const fundData = ref<StockFundFlow | null>(null);
const loading = ref(false);
const err = ref("");
const showAllFin = ref(false);
const chartEl = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;
let ro: ResizeObserver | null = null;

// 财务精选白名单（默认展示，信息密度最高的一组）
const FIN_PICK = new Set([
  "摊薄每股收益(元)", "每股净资产_调整前(元)", "每股经营性现金流(元)",
  "净资产收益率(%)", "加权净资产收益率(%)", "销售净利率(%)", "销售毛利率(%)",
  "主营业务收入增长率(%)", "净利润增长率(%)", "资产负债率(%)",
  "流动比率", "速动比率", "总资产(元)",
]);

const shortItems = computed(() => {
  const p = profile.value;
  if (!p) return [];
  const rows: [string, string][] = [
    ["公司名称", p.name], ["英文名称", p.enName],
    ["上市市场", p.market], ["上市日期", p.listDate],
    ["发行价格", p.issuePrice], ["成立日期", p.establishDate],
    ["注册资本", p.regCapital], ["机构类型", p.orgType],
    ["董事会秘书", p.secretary], ["公司电话", p.phone],
    ["公司传真", p.fax], ["电子邮箱", p.email],
    ["公司网址", p.website], ["邮政编码", p.postcode],
    ["注册地址", p.regAddress], ["办公地址", p.officeAddress],
  ];
  return rows.filter(([, v]) => v && v.trim() !== "");
});

// 财务表格：按 group 组织，默认仅精选
const finView = computed(() => {
  const f = finance.value;
  if (!f) return { periods: [] as string[], groups: [] as { name: string; rows: { name: string; values: (number | null)[] }[] }[] };
  const groups = f.groups
    .map((g) => ({
      name: g.name,
      rows: showAllFin.value ? g.rows : g.rows.filter((r) => FIN_PICK.has(r.name)),
    }))
    .filter((g) => g.rows.length > 0);
  return { periods: f.periods, groups };
});

function fmtFin(name: string, v: number | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "--";
  const abs = Math.abs(v);
  if (name.includes("(元)") || abs >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (abs >= 1e4) return (v / 1e4).toFixed(2) + "万";
  return v.toFixed(2);
}

function pctColor(v: number | null): string {
  if (v === null) return "var(--text-dim)";
  return v >= 0 ? "#f23645" : "#0ecb81";
}

function renderChip() {
  const d = chipsData.value;
  if (!d || !chartEl.value) return;
  if (!chart) chart = echarts.init(chartEl.value);
  const cat = d.prices.map((p) => p.toFixed(2));
  const nearestCat = (target: number) => {
    let bi = 0; let bd = Infinity;
    d.prices.forEach((p, i) => { const dd = Math.abs(p - target); if (dd < bd) { bd = dd; bi = i; } });
    return cat[bi];
  };
  const data = d.prices.map((p, i) => ({
    value: d.chips[i],
    itemStyle: { color: p <= d.currentPrice ? "#e2b440" : "#4a7bd0" },
  }));
  chart.setOption({
    animationDuration: 400,
    grid: { left: 8, right: 40, top: 10, bottom: 22, containLabel: true },
    xAxis: { type: "value", show: false },
    yAxis: {
      type: "category", data: cat, inverse: true,
      axisTick: { show: false }, axisLine: { show: false },
      axisLabel: {
        fontSize: 10, color: "#8a93a6",
        formatter: (v: string, i: number) => (i % 12 === 0 ? v : ""),
      },
    },
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" },
      backgroundColor: "#161c28", borderColor: "#2a3346", textStyle: { color: "#dfe5f0", fontSize: 11 },
      formatter: (ps: any) => {
        const i = ps[0].dataIndex;
        const tot = d.chips.reduce((a, b) => a + b, 0);
        const share = ((d.chips[i] / tot) * 100).toFixed(2);
        return `价格 ${cat[i]}<br/>筹码占比 ${share}%`;
      },
    },
    series: [{
      type: "bar", data, barCategoryGap: "0%",
      markLine: {
        symbol: "none", animation: false,
        label: { fontSize: 10, position: "end" },
        data: [
          { yAxis: nearestCat(d.currentPrice), lineStyle: { color: "#f23645", width: 1.5 }, label: { formatter: "现价", color: "#f23645" } },
          { yAxis: nearestCat(d.avgCost), lineStyle: { color: "#e8eaef", type: "dashed", width: 1.2 }, label: { formatter: "平均成本", color: "#c9d0dd" } },
        ],
      },
    }],
  });
  if (!ro) {
    ro = new ResizeObserver(() => chart?.resize());
    ro.observe(chartEl.value);
  }
}

// ===== 资金四档 =====
const fundChartEl = ref<HTMLDivElement | null>(null);
let fundChart: echarts.ECharts | null = null;
let fundRo: ResizeObserver | null = null;

function renderFund() {
  const d = fundData.value;
  if (!d || !fundChartEl.value) return;
  if (!fundChart) fundChart = echarts.init(fundChartEl.value);
  // 图表取最近 15 日，转升序
  const recent = d.days.slice(0, 15).reverse();
  fundChart.setOption({
    animationDuration: 400,
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" },
      backgroundColor: "#161c28", borderColor: "#2a3346", textStyle: { color: "#dfe5f0", fontSize: 11 },
      valueFormatter: (v: any) => (Number(v) / 1e8).toFixed(2) + "亿",
    },
    legend: { data: ["超大单", "大单", "中单", "小单"], top: 2,
      textStyle: { color: "#8a93a6", fontSize: 10 } },
    grid: { left: 50, right: 16, top: 30, bottom: 22 },
    xAxis: { type: "category", data: recent.map((x) => x.date.slice(5)),
      axisLabel: { color: "#8a93a6", fontSize: 10 }, axisLine: { lineStyle: { color: "#2a3344" } } },
    yAxis: { type: "value", axisLabel: { color: "#8a93a6", fontSize: 10, formatter: (v: number) => (v / 1e8).toFixed(0) + "亿" },
      splitLine: { lineStyle: { color: "rgba(255,255,255,.05)" } } },
    series: [
      { name: "超大单", type: "bar", data: recent.map((x) => x.superNet),
        itemStyle: { color: "#f23645" } },
      { name: "大单", type: "bar", data: recent.map((x) => x.largeNet),
        itemStyle: { color: "#ff8a3d" } },
      { name: "中单", type: "bar", data: recent.map((x) => x.mediumNet),
        itemStyle: { color: "#b07cff" } },
      { name: "小单", type: "bar", data: recent.map((x) => x.smallNet),
        itemStyle: { color: "#0ecb81" } },
    ],
  });
  if (!fundRo) {
    fundRo = new ResizeObserver(() => fundChart?.resize());
    fundRo.observe(fundChartEl.value);
  }
}

function fmtFlow(v: number): string {
  const abs = Math.abs(v);
  const t = (v >= 0 ? "+" : "");
  if (abs >= 1e8) return t + (v / 1e8).toFixed(2) + "亿";
  if (abs >= 1e4) return t + (v / 1e4).toFixed(1) + "万";
  return t + v.toFixed(0);
}
const latestFund = computed(() => fundData.value?.days[0] ?? null);

async function load() {
  if (!props.code) return;
  loading.value = true; err.value = "";
  try {
    if (tab.value === "profile") profile.value = await fetchF10Profile(props.code);
    else if (tab.value === "finance") finance.value = await fetchF10Finance(props.code);
    else if (tab.value === "chips") {
      chipsData.value = await fetchF10Chips(props.code);
      await nextTick(); renderChip();
    } else {
      fundData.value = await fetchFundFlow(props.code, 60);
      await nextTick(); renderFund();
    }
  } catch (e) {
    err.value = typeof e === "string" ? e : "数据加载失败，请稍后重试";
  }
  loading.value = false;
}

watch(tab, () => {
  if (tab.value === "chips") { nextTick(renderChip); }
  if (tab.value === "fund") { nextTick(renderFund); }
  load();
});
watch(() => props.code, () => {
  profile.value = null; finance.value = null; chipsData.value = null; fundData.value = null;
  load();
}, { immediate: true });

onBeforeUnmount(() => {
  ro?.disconnect();
  fundRo?.disconnect();
  chart?.dispose();
  fundChart?.dispose();
  chart = null;
  fundChart = null;
});
</script>

<template>
  <div class="f10">
    <!-- Tab 栏 -->
    <div class="tabs">
      <button v-for="t in (['profile','finance','chips','fund'] as Tab[])" :key="t"
        class="tab" :class="{ on: tab === t }" @click="tab = t">
        {{ t === 'profile' ? '公司概况' : t === 'finance' ? '财务分析' : t === 'chips' ? '筹码分布' : '资金流向' }}
      </button>
    </div>

    <div class="body">
      <div v-if="!code" class="hint">请先从自选或榜单选择一只股票</div>
      <div v-else-if="loading" class="hint">加载中…</div>
      <div v-else-if="err" class="hint err-hint">{{ err }}</div>

      <!-- 公司概况 -->
      <template v-else-if="tab === 'profile' && profile">
        <div class="grid">
          <div v-for="[k, v] in shortItems" :key="k" class="cell">
            <span class="k">{{ k }}</span><span class="v">{{ v }}</span>
          </div>
        </div>
        <div v-if="profile.mainBusiness" class="para">
          <div class="para-t">主营业务</div><p>{{ profile.mainBusiness }}</p>
        </div>
        <div v-if="profile.intro" class="para">
          <div class="para-t">公司简介</div><p>{{ profile.intro }}</p>
        </div>
      </template>

      <!-- 财务分析 -->
      <template v-else-if="tab === 'finance' && finance">
        <div class="fin-scroll">
          <table class="fin-table">
            <thead>
              <tr>
                <th class="fin-name">指标</th>
                <th v-for="p in finView.periods" :key="p">{{ p.slice(5) || p }}</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="g in finView.groups" :key="g.name">
                <tr><td class="grp" :colspan="finView.periods.length + 1">{{ g.name }}</td></tr>
                <tr v-for="r in g.rows" :key="r.name">
                  <td class="fin-name">{{ r.name }}</td>
                  <td v-for="(v, i) in r.values" :key="i"
                    class="fin-val" :style="{ color: pctColor(v) }">{{ fmtFin(r.name, v) }}</td>
                </tr>
              </template>
            </tbody>
          </table>
          <button class="more" @click="showAllFin = !showAllFin">
            {{ showAllFin ? "收起（仅核心指标）" : "显示全部指标" }}
          </button>
        </div>
      </template>

      <!-- 筹码分布 -->
      <template v-else-if="tab === 'chips' && chipsData">
        <div class="chip-stats">
          <div class="stat">
            <div class="stat-k">获利比例</div>
            <div class="stat-v" :class="chipsData.profitRatio >= 50 ? 'up' : 'down'">
              {{ chipsData.profitRatio.toFixed(1) }}%
            </div>
          </div>
          <div class="stat">
            <div class="stat-k">平均成本</div>
            <div class="stat-v">{{ chipsData.avgCost.toFixed(2) }}</div>
          </div>
          <div class="stat">
            <div class="stat-k">90%集中度</div>
            <div class="stat-v">{{ chipsData.concentration90.toFixed(1) }}%</div>
          </div>
          <div class="stat wide">
            <div class="stat-k">90%成本区间</div>
            <div class="stat-v sm">{{ chipsData.low90.toFixed(2) }} ~ {{ chipsData.high90.toFixed(2) }}</div>
          </div>
        </div>
        <div ref="chartEl" class="chip-chart"></div>
        <div class="legend">
          <span class="lg"><i class="dot gold"></i>获利盘</span>
          <span class="lg"><i class="dot blue"></i>套牢盘</span>
        </div>
      </template>

      <!-- 资金流向 -->
      <template v-else-if="tab === 'fund' && fundData">
        <div class="fund-today" v-if="latestFund">
          <div class="ft-cell">
            <div class="ft-k">主力净流入（{{ latestFund.date }}）</div>
            <div class="ft-v" :class="latestFund.mainNet >= 0 ? 'up' : 'down'">{{ fmtFlow(latestFund.mainNet) }}</div>
          </div>
          <div class="ft-cell">
            <div class="ft-k">超大单</div>
            <div class="ft-v" :class="latestFund.superNet >= 0 ? 'up' : 'down'">{{ fmtFlow(latestFund.superNet) }}</div>
          </div>
          <div class="ft-cell">
            <div class="ft-k">大单</div>
            <div class="ft-v" :class="latestFund.largeNet >= 0 ? 'up' : 'down'">{{ fmtFlow(latestFund.largeNet) }}</div>
          </div>
          <div class="ft-cell">
            <div class="ft-k">中单</div>
            <div class="ft-v" :class="latestFund.mediumNet >= 0 ? 'up' : 'down'">{{ fmtFlow(latestFund.mediumNet) }}</div>
          </div>
          <div class="ft-cell">
            <div class="ft-k">小单</div>
            <div class="ft-v" :class="latestFund.smallNet >= 0 ? 'up' : 'down'">{{ fmtFlow(latestFund.smallNet) }}</div>
          </div>
        </div>
        <div ref="fundChartEl" class="fund-chart-box"></div>
        <div class="fund-note">口径：东方财富资金流，主力=超大单+大单；免费数据，非 Level-2</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.f10 { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.tabs { display: flex; gap: 4px; padding: 0 2px 8px; border-bottom: 1px solid var(--border); }
.tab {
  flex: 1; padding: 5px 0; font-size: 12px; cursor: pointer;
  background: transparent; color: var(--text-dim); border: 1px solid transparent; border-radius: 6px;
  transition: all .15s;
}
.tab:hover { color: var(--text); }
.tab.on { color: var(--accent); background: #1a2438; border-color: var(--border); }
.body { flex: 1; min-height: 0; overflow: hidden; padding-top: 8px; display: flex; flex-direction: column; }
.hint { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-dim); font-size: 12px; }
.err-hint { color: #f23645; }

/* 概况 */
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 14px; overflow-y: auto; }
.cell { display: flex; gap: 8px; font-size: 11.5px; line-height: 1.5; min-width: 0; }
.k { color: var(--text-dim); white-space: nowrap; flex-shrink: 0; }
.v { color: var(--text); word-break: break-all; }
.para { margin-top: 10px; flex-shrink: 0; }
.para-t { font-size: 11.5px; color: var(--accent); margin-bottom: 4px; font-weight: 600; }
.para p { margin: 0; font-size: 11.5px; line-height: 1.7; color: var(--text); white-space: pre-wrap; }

/* 财务 */
.fin-scroll { flex: 1; min-height: 0; overflow-y: auto; }
.fin-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.fin-table th { color: var(--text-dim); font-weight: 500; padding: 4px 6px; text-align: right; border-bottom: 1px solid var(--border); white-space: nowrap; }
.fin-table th.fin-name { text-align: left; }
.fin-name { text-align: left; color: var(--text); padding: 3px 6px; white-space: nowrap; }
.fin-val { text-align: right; padding: 3px 6px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.grp { color: var(--accent); font-weight: 600; padding: 7px 6px 3px; font-size: 11px; }
.more { margin: 8px 0; padding: 4px 12px; font-size: 11px; cursor: pointer; background: transparent; color: var(--text-dim); border: 1px solid var(--border); border-radius: 5px; }
.more:hover { color: var(--text); }

/* 筹码 */
.chip-stats { display: flex; flex-wrap: wrap; gap: 6px; flex-shrink: 0; }
.stat { flex: 1 1 30%; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 7px; padding: 6px 8px; min-width: 0; }
.stat.wide { flex: 1 1 100%; }
.stat-k { font-size: 10px; color: var(--text-dim); }
.stat-v { font-size: 15px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }
.stat-v.sm { font-size: 13px; font-weight: 600; }
.stat-v.up { color: #f23645; }
.stat-v.down { color: #0ecb81; }
.chip-chart { flex: 1; min-height: 120px; margin-top: 6px; }
.legend { display: flex; gap: 16px; justify-content: center; padding-top: 4px; flex-shrink: 0; }
.lg { font-size: 10.5px; color: var(--text-dim); display: flex; align-items: center; gap: 5px; }
.dot { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.dot.gold { background: #e2b440; }
.dot.blue { background: #4a7bd0; }

/* 资金流向 */
.fund-today { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; flex-shrink: 0; }
.ft-cell { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 7px; padding: 6px 8px; min-width: 0; }
.ft-k { font-size: 10px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ft-v { font-size: 13px; font-weight: 700; margin-top: 3px; font-variant-numeric: tabular-nums; }
.ft-v.up { color: #f23645; }
.ft-v.down { color: #0ecb81; }
.fund-chart-box { flex: 1; min-height: 180px; margin-top: 8px; }
.fund-note { flex-shrink: 0; text-align: center; font-size: 10px; color: var(--text-dim); padding-top: 6px; }
</style>
