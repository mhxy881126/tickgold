<script setup lang="ts">
import * as echarts from "echarts";
import { onBeforeUnmount, onMounted, ref, computed } from "vue";
import { listen } from "@tauri-apps/api/event";
import { startRadar, type RadarData } from "../api/market";

const lineRef = ref<HTMLElement | null>(null);
const barRef = ref<HTMLElement | null>(null);
let lineChart: echarts.ECharts | null = null;
let barChart: echarts.ECharts | null = null;

const data = ref<RadarData | null>(null);
const scanning = ref(false);
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

/* 读取当前主题 CSS 变量，让图表跟随外观 */
const cv = (n: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function ha(hex: string, a: number) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16),
    g = parseInt(h.slice(2, 4), 16),
    b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// 封板率 = 涨停 / (涨停 + 炸板)
const sealRate = computed(() => {
  const d = data.value;
  if (!d) return 0;
  const denom = d.limitUp + d.broken;
  return denom > 0 ? (d.limitUp / denom) * 100 : 0;
});
const ringStyle = computed(() => ({
  background: `conic-gradient(var(--accent) 0 ${sealRate.value}%, var(--bg-card2) ${sealRate.value}% 100%)`,
}));
interface Pt {
  t: string;
  up: number;
  down: number;
  lu: number;
  ld: number;
}
const points = ref<Pt[]>([]);

let unData: (() => void) | null = null;
let unStatus: (() => void) | null = null;

const LABELS = [
  "≥7%",
  "5~7%",
  "3~5%",
  "1~3%",
  "0~1%",
  "-1~0",
  "-3~-1",
  "-5~-3",
  "-7~-5",
  "≤-7",
];
const COLORS = [
  "#e0455a",
  "#e85a6d",
  "#ec7282",
  "#f08a98",
  "#f4a3ad",
  "#9fe0c4",
  "#6fd4aa",
  "#45c893",
  "#2bb87e",
  "#22b573",
];

function hm(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function tipStyle() {
  return {
    backgroundColor: cv("--bg-card"),
    borderColor: cv("--border-light"),
    textStyle: { color: cv("--text"), fontSize: 11 },
  };
}

function renderLine() {
  const p = points.value;
  const up = cv("--up"),
    dn = cv("--down"),
    dim = cv("--text-dim"),
    bd = cv("--border");
  lineChart?.setOption({
    title: {
      text: "涨跌家数分时",
      left: 6,
      top: 4,
      textStyle: { fontSize: 11, color: cv("--text") },
    },
    tooltip: { trigger: "axis", ...tipStyle() },
    legend: {
      data: ["上涨", "下跌"],
      top: 4,
      right: 8,
      itemWidth: 10,
      itemHeight: 8,
      textStyle: { fontSize: 10, color: dim },
    },
    grid: { left: 40, right: 12, top: 30, bottom: 20 },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: p.map((x) => x.t),
      axisLabel: { fontSize: 9, color: dim },
      axisLine: { lineStyle: { color: bd } },
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLabel: { fontSize: 9, color: dim },
      splitLine: { lineStyle: { color: bd } },
    },
    series: [
      {
        name: "上涨",
        type: "line",
        smooth: true,
        symbol: "none",
        data: p.map((x) => x.up),
        lineStyle: { color: up, width: 1.6 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(
            0,
            0,
            0,
            1,
            [
              { offset: 0, color: ha(up, 0.32) },
              { offset: 1, color: ha(up, 0.02) },
            ]
          ),
        },
      },
      {
        name: "下跌",
        type: "line",
        smooth: true,
        symbol: "none",
        data: p.map((x) => x.down),
        lineStyle: { color: dn, width: 1.6 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(
            0,
            0,
            0,
            1,
            [
              { offset: 0, color: ha(dn, 0.28) },
              { offset: 1, color: ha(dn, 0.02) },
            ]
          ),
        },
      },
    ],
  });
}

function renderBar() {
  const hist = data.value ? data.value.hist : [];
  const dim = cv("--text-dim"),
    bd = cv("--border");
  barChart?.setOption({
    title: {
      text: "涨跌分布",
      left: 6,
      top: 4,
      textStyle: { fontSize: 11, color: cv("--text") },
    },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, ...tipStyle() },
    grid: { left: 44, right: 32, top: 30, bottom: 20 },
    xAxis: {
      type: "value",
      axisLabel: { fontSize: 9, color: dim },
      splitLine: { lineStyle: { color: bd } },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: LABELS,
      axisLabel: { fontSize: 9, color: dim },
      axisLine: { lineStyle: { color: bd } },
    },
    series: [
      {
        type: "bar",
        barWidth: "64%",
        data: hist.map((v, i) => ({
          value: v,
          itemStyle: { color: COLORS[i], borderRadius: [0, 3, 3, 0] },
        })),
        label: { show: true, position: "right", fontSize: 9, color: dim },
      },
    ],
  });
}

function onData(d: RadarData) {
  data.value = d;
  const t = hm(d.updated);
  const last = points.value[points.value.length - 1];
  if (!last || last.t !== t) {
    points.value.push({
      t,
      up: d.upCount,
      down: d.downCount,
      lu: d.limitUp,
      ld: d.limitDown,
    });
    if (points.value.length > 260) points.value.shift();
  } else {
    last.up = d.upCount;
    last.down = d.downCount;
    last.lu = d.limitUp;
    last.ld = d.limitDown;
  }
  renderLine();
  renderBar();
}

function resize() {
  lineChart?.resize();
  barChart?.resize();
}

onMounted(async () => {
  if (lineRef.value) lineChart = echarts.init(lineRef.value);
  if (barRef.value) barChart = echarts.init(barRef.value);
  unData = await listen<RadarData>("radar:data", (e) => onData(e.payload));
  unStatus = await listen("radar:status", (e: any) => {
    scanning.value = e.payload.scanning;
  });
  try {
    await startRadar();
  } catch (e) {
    console.error("startRadar", e);
  }
  window.addEventListener("resize", resize);
});

onBeforeUnmount(() => {
  unData?.();
  unStatus?.();
  window.removeEventListener("resize", resize);
  lineChart?.dispose();
  barChart?.dispose();
});
</script>

<template>
  <!-- 紧凑情绪卡（时段驾驶舱 Bento） -->
  <div v-if="compact" class="compact">
    <div class="c-ring" :style="ringStyle">
      <div class="c-inner">
        <b>{{ sealRate.toFixed(0) }}<i>%</i></b>
        <span>封板率</span>
      </div>
    </div>
    <div class="c-nums">
      <div class="cn up"><b>{{ data ? data.upCount : "--" }}</b><span>上涨</span></div>
      <div class="cn down"><b>{{ data ? data.downCount : "--" }}</b><span>下跌</span></div>
      <div class="cn up"><b>{{ data ? data.limitUp : "--" }}</b><span>涨停</span></div>
      <div class="cn down"><b>{{ data ? data.limitDown : "--" }}</b><span>跌停</span></div>
    </div>
    <div class="c-foot">
      <span>连板高度 <b class="gold">{{ data ? data.maxBoards + "板" : "--" }}</b></span>
      <span>炸板率 <b>{{ data ? data.brokenRate.toFixed(0) + "%" : "--" }}</b></span>
    </div>
  </div>

  <div v-else class="breadth">
    <!-- 顶部统计 -->
    <div class="stats">
      <div class="st up"><span class="lb">上涨</span><span class="vl">{{ data ? data.upCount : "--" }}</span></div>
      <div class="st down"><span class="lb">下跌</span><span class="vl">{{ data ? data.downCount : "--" }}</span></div>
      <div class="st flat"><span class="lb">平盘</span><span class="vl">{{ data ? data.flatCount : "--" }}</span></div>
      <div class="st up"><span class="lb">涨停</span><span class="vl">{{ data ? data.limitUp : "--" }}</span></div>
      <div class="st down"><span class="lb">跌停</span><span class="vl">{{ data ? data.limitDown : "--" }}</span></div>
      <div class="st warn"><span class="lb">炸板</span><span class="vl">{{ data ? data.broken : "--" }}</span></div>
      <div class="st warn"><span class="lb">炸板率</span><span class="vl">{{ data ? data.brokenRate.toFixed(0) + "%" : "--" }}</span></div>
      <span class="scan" :class="{ on: scanning }">{{ scanning ? "扫描中" : "已定格" }}</span>
    </div>

    <!-- 图表 -->
    <div class="charts">
      <div class="chart-box"><div ref="lineRef" class="c"></div></div>
      <div class="chart-box"><div ref="barRef" class="c"></div></div>
      <div v-if="!data" class="empty">正在统计全市场宽度…</div>
    </div>
  </div>
</template>

<style scoped>
.breadth { height: 100%; display: flex; flex-direction: column; padding: 8px 10px 10px; overflow: hidden; }

.stats { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.st {
  display: flex; flex-direction: column; align-items: center; min-width: 44px;
  background: var(--bg-card2); border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px;
}
.st .lb { font-size: 9px; color: var(--text-dim); }
.st .vl { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.25; }
.st.up .vl { color: var(--up); }
.st.down .vl { color: var(--down); }
.st.flat .vl { color: var(--text-dim); }
.st.warn .vl { color: var(--accent); }
.scan { margin-left: auto; font-size: 9px; color: var(--text-dim); }
.scan.on { color: var(--blue); }

.charts { flex: 1; display: grid; grid-template-columns: 1.25fr 1fr; gap: 8px; min-height: 0; position: relative; }
.chart-box { min-width: 0; min-height: 0; background: var(--bg-card2); border: 1px solid var(--border); border-radius: 8px; }
.c { width: 100%; height: 100%; }
.empty {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); font-size: 12px; pointer-events: none;
}

@media (max-width: 1100px) {
  .charts { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
}

/* 紧凑情绪卡 */
.compact { height: 100%; display: flex; flex-direction: column; gap: 8px; padding: 10px; overflow: hidden; }
.c-ring { width: 58px; height: 58px; border-radius: 50%; margin: 0 auto; display: grid; place-items: center; flex: none; }
.c-inner {
  width: 44px; height: 44px; border-radius: 50%; background: var(--bg-card2);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.c-inner b { font-size: 15px; font-weight: 800; color: var(--accent); line-height: 1; }
.c-inner b i { font-size: 9px; font-style: normal; }
.c-inner span { font-size: 8.5px; color: var(--text-dim); margin-top: 2px; }
.c-nums { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.cn {
  display: flex; align-items: center; justify-content: space-between;
  background: var(--bg-card2); border: 1px solid var(--border); border-radius: 6px; padding: 4px 9px;
}
.cn b { font-size: 15px; font-weight: 800; font-variant-numeric: tabular-nums; }
.cn span { font-size: 9.5px; color: var(--text-dim); }
.cn.up b { color: var(--up); }
.cn.down b { color: var(--down); }
.c-foot {
  display: flex; justify-content: space-between; font-size: 10px; color: var(--text-dim);
  margin-top: auto; padding-top: 2px;
}
.c-foot b { font-variant-numeric: tabular-nums; }
.c-foot b.gold { color: var(--accent); }
</style>
