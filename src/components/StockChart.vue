<template>
  <div class="sc-root">
    <!-- ===== 股票头 ===== -->
    <div class="sc-head">
      <div class="sc-id">
        <span class="sc-name">{{ headName }}</span>
        <span class="sc-code">{{ code }}</span>
      </div>
      <div class="sc-px" :class="pxTone">
        <span class="sc-price">{{ fmtPx(price) }}</span>
        <div class="sc-chg">
          <span>{{ change >= 0 ? "+" : "" }}{{ fmtPx(change) }}</span>
          <span>{{ pct >= 0 ? "+" : "" }}{{ pct.toFixed(2) }}%</span>
        </div>
      </div>
      <div class="sc-grid">
        <div class="gi"><label>今开</label><span :class="toneOf(open)">{{ fmtPx(open) }}</span></div>
        <div class="gi"><label>最高</label><span class="up">{{ fmtPx(high) }}</span></div>
        <div class="gi"><label>最低</label><span class="down">{{ fmtPx(low) }}</span></div>
        <div class="gi"><label>昨收</label><span>{{ fmtPx(prevClose) }}</span></div>
        <div class="gi"><label>成交量</label><span>{{ fmtVol(volume) }}</span></div>
        <div class="gi"><label>成交额</label><span>{{ fmtAmt(amount) }}</span></div>
        <div class="gi"><label>换手</label><span>{{ q ? q.turnover.toFixed(2) + "%" : "-" }}</span></div>
        <div class="gi"><label>振幅</label><span>{{ q ? q.amplitude.toFixed(2) + "%" : "-" }}</span></div>
        <div class="gi"><label>量比</label><span>{{ q ? q.volumeRatio.toFixed(2) : "-" }}</span></div>
        <div class="gi"><label>市盈(动)</label><span>{{ q && q.pe ? q.pe.toFixed(1) : "-" }}</span></div>
        <div class="gi"><label>流通市值</label><span>{{ q ? q.circMv.toFixed(1) + "亿" : "-" }}</span></div>
        <div class="gi"><label>总市值</label><span>{{ q ? q.totalMv.toFixed(1) + "亿" : "-" }}</span></div>
      </div>
    </div>

    <!-- ===== 周期条 ===== -->
    <div class="sc-tabs">
      <button
        v-for="(t, i) in tabs"
        :key="t.label"
        class="sc-tab"
        :class="{ active: i === active }"
        @click="switchTab(i)"
      >{{ t.label }}</button>
      <div class="sc-tabs-right">
        <button class="sc-tab ghost" title="画线工具（开发中）" @click="todo">画线</button>
      </div>
    </div>

    <!-- ===== 主体 ===== -->
    <div class="sc-body">
      <div class="sc-chart">
        <div ref="host" class="chart-host"></div>
        <div v-if="loading" class="sc-mask">加载中…</div>
        <div v-else-if="err" class="sc-mask err">{{ err }}</div>
      </div>

      <!-- 五档盘口 -->
      <div class="sc-book">
        <div class="ask">
          <div v-for="i in [4,3,2,1,0]" :key="'a'+i" class="lvl ask-lvl">
            <span class="lvl-tag">卖{{ i + 1 }}</span>
            <span class="lvl-px up">{{ fmtPx(asks[i]?.price) }}</span>
            <span class="lvl-vol">{{ fmtVol(asks[i]?.vol ?? 0) }}</span>
            <span class="lvl-bar" :style="{ width: barW(asks[i]?.vol ?? 0) + '%' }"></span>
          </div>
        </div>
        <div class="book-mid" :class="pxTone">
          <span class="bm-px">{{ fmtPx(price) }}</span>
          <span class="bm-chg">{{ pct >= 0 ? "+" : "" }}{{ pct.toFixed(2) }}%</span>
        </div>
        <div class="bid">
          <div v-for="i in [0,1,2,3,4]" :key="'b'+i" class="lvl bid-lvl">
            <span class="lvl-tag">买{{ i + 1 }}</span>
            <span class="lvl-px down">{{ fmtPx(ob?.bids[i]?.price) }}</span>
            <span class="lvl-vol">{{ fmtVol(ob?.bids[i]?.vol ?? 0) }}</span>
            <span class="lvl-bar" :style="{ width: barW(ob?.bids[i]?.vol ?? 0) + '%' }"></span>
          </div>
        </div>
        <div class="book-foot">
          <div><label>成交量</label><span>{{ fmtVol(volume) }}</span></div>
          <div><label>成交额</label><span>{{ fmtAmt(amount) }}</span></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { init, dispose, registerIndicator } from "klinecharts";
import type { Chart, KLineData } from "klinecharts";
import { fetchQuotes, fetchKLine, fetchMinute, fetchOrderBook } from "../api/market";
import type { Quote, OrderBook, KBar } from "../api/types";

const props = defineProps<{ code: string }>();

const UP = "#f23645";
const DOWN = "#08db94";
const FLAT = "#8b93a7";

const tabs = [
  { label: "分时", minute: true },
  { label: "1分", period: 1 },
  { label: "5分", period: 5 },
  { label: "15分", period: 15 },
  { label: "30分", period: 30 },
  { label: "60分", period: 60 },
  { label: "日K", period: 101 },
  { label: "周K", period: 102 },
  { label: "月K", period: 103 },
];
const active = ref(0);

const host = ref<HTMLElement | null>(null);
let chart: Chart | null = null;
let ro: ResizeObserver | null = null;
let headTimer = 0;
let chartTimer = 0;

const q = ref<Quote | null>(null);
const ob = ref<OrderBook | null>(null);
const loading = ref(true);
const err = ref("");

// ---- 头部合并字段（Quote 为主，OrderBook 兜底）----
const headName = computed(() => q.value?.name ?? ob.value?.name ?? "-");
const price = computed(() => q.value?.price ?? ob.value?.price ?? 0);
const prevClose = computed(() => q.value?.prevClose ?? ob.value?.prevClose ?? 0);
const open = computed(() => q.value?.open ?? ob.value?.open ?? 0);
const high = computed(() => q.value?.high ?? ob.value?.high ?? 0);
const low = computed(() => q.value?.low ?? ob.value?.low ?? 0);
const volume = computed(() => q.value?.volume ?? ob.value?.volume ?? 0);
const amount = computed(() => q.value?.amount ?? ob.value?.amount ?? 0);
const change = computed(() => q.value?.change ?? price.value - prevClose.value);
const pct = computed(() => q.value?.pct ?? (prevClose.value ? (change.value / prevClose.value) * 100 : 0));
const asks = computed(() => ob.value?.asks ?? []);

const pxTone = computed(() => (change.value > 0 ? "up" : change.value < 0 ? "down" : "flat"));
const toneOf = (v: number) => (v > prevClose.value ? "up" : v < prevClose.value ? "down" : "");

// ---- 格式化 ----
const fmtPx = (v?: number | null) => (v == null || isNaN(v) ? "--" : v.toFixed(2));
function fmtVol(v: number): string {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿手";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万手";
  return v.toFixed(0) + "手";
}
function fmtAmt(v: number): string {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万";
  return v.toFixed(0);
}
const maxVol = computed(() => {
  const lv = [...asks.value, ...(ob.value?.bids ?? [])].map((l) => l.vol);
  return Math.max(1, ...lv);
});
const barW = (v: number) => Math.round((v / maxVol.value) * 100);

// ===== 自定义分时均价指标（含昨收虚线）=====
registerIndicator({
  name: "AVG",
  shortName: "均价",
  series: "price" as any,
  precision: 2,
  figures: [{
    key: "avg",
    title: "均价",
    type: "line",
    styles: (() => ({ color: "#f5c542" })) as any,
  }],
  calc: (dataList: KLineData[]) => {
    let tv = 0, v = 0;
    return dataList.map((d) => {
      tv += (d.close || 0) * (d.volume || 0);
      v += d.volume || 0;
      return { avg: v > 0 ? tv / v : d.close };
    });
  },
});

// ---- KBar -> KLineData ----
function toKData(bars: KBar[]): KLineData[] {
  return bars.map((b) => ({
    timestamp: b.timestamp,
    open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
  }));
}

// ---- 分时均价映射（供 tooltip）----
function buildAvgMap(bars: KBar[]): Map<number, number> {
  const m = new Map<number, number>();
  let tv = 0, v = 0;
  for (const b of bars) {
    tv += b.close * b.volume; v += b.volume;
    m.set(b.timestamp, v > 0 ? tv / v : b.close);
  }
  return m;
}

const hhmmUTC = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

// ---- 深色 + 红涨绿跌样式 ----
function buildStyles(minute: boolean, avgMap?: Map<number, number>) {
  const axisText = "#8b93a7";
  const gridLine = "rgba(255,255,255,.055)";
  const base: any = {
    grid: {
      show: true,
      horizontal: { show: true, color: gridLine },
      vertical: { show: true, color: gridLine },
    },
    candle: {
      type: minute ? "area" : "candle_solid",
      bar: {
        upColor: UP, downColor: DOWN, noChangeColor: FLAT,
        upBorderColor: UP, downBorderColor: DOWN, noChangeBorderColor: FLAT,
        upWickColor: UP, downWickColor: DOWN, noChangeWickColor: FLAT,
      },
      area: {
        lineSize: 1, lineColor: UP, value: "close", smooth: false,
        backgroundColor: [
          { offset: 0, color: "rgba(242,54,69,.22)" },
          { offset: 1, color: "rgba(242,54,69,.02)" },
        ],
        point: { show: false },
      },
      priceMark: {
        show: true,
        high: { show: true, color: axisText },
        low: { show: true, color: axisText },
        last: {
          show: true, upColor: UP, downColor: DOWN, noChangeColor: FLAT,
          line: { show: true, color: "rgba(255,255,255,.25)" },
        },
      },
    },
    indicator: { ohlc: { upColor: UP, downColor: DOWN, noChangeColor: FLAT } },
    xAxis: {
      axisLine: { show: true, color: gridLine },
      tickLine: { show: true, color: gridLine },
      tickText: { show: true, color: axisText },
    },
    yAxis: {
      axisLine: { show: true, color: gridLine },
      tickLine: { show: true, color: gridLine },
      tickText: { show: true, color: axisText },
    },
    crosshair: {
      show: true,
      horizontal: {
        show: true, line: { color: "rgba(220,225,240,.45)" },
        text: { backgroundColor: "#363c4e" },
      },
      vertical: {
        show: true, line: { color: "rgba(220,225,240,.45)" },
        text: { backgroundColor: "#363c4e" },
      },
    },
    separator: { color: gridLine },
  };
  if (minute && avgMap) {
    const pc = prevClose.value;
    base.candle.tooltip = {
      custom: ({ current }: any) => {
        const avg = avgMap.get(current.timestamp);
        const ch = current.close - pc;
        const pp = pc ? (ch / pc) * 100 : 0;
        const c = ch >= 0 ? UP : DOWN;
        return [
          { title: hhmmUTC(current.timestamp) },
          { title: "分时", color: c, text: current.close.toFixed(2) },
          { title: "均价", color: "#f5c542", text: avg != null ? avg.toFixed(2) : "--" },
          { title: "涨跌", color: c, text: `${ch >= 0 ? "+" : ""}${ch.toFixed(2)}  ${pp.toFixed(2)}%` },
          { title: "成交量", text: fmtVol(current.volume) },
        ];
      },
    };
  }
  return base;
}

// ---- 渲染图表（每次切换整体重建，避免指标残留）----
function renderChart(bars: KBar[], minute: boolean) {
  if (!host.value) return;
  if (chart) { dispose(chart); chart = null; }
  chart = init(host.value);
  if (!chart) return;
  chart.setTimezone("UTC");
  chart.setPriceVolumePrecision(2, 0);

  const avgMap = minute ? buildAvgMap(bars) : undefined;
  chart.setStyles(buildStyles(minute, avgMap));
  chart.applyNewData(toKData(bars));

  if (minute) {
    chart.createIndicator("AVG", false, { id: "candle_pane" });
    chart.createIndicator("VOL", false, { height: 88 });
  } else {
    chart.createIndicator("MA", false, { id: "candle_pane" });
    chart.createIndicator("VOL", false, { height: 78 });
    chart.createIndicator("MACD", false, { height: 88 });
  }
  chart.resize();
  if (minute) fitMinute();
}

// 分时：固定全天 240 分钟坐标，最新价右对齐，右侧留白等待收盘
function fitMinute() {
  if (!chart || !host.value) return;
  const w = host.value.clientWidth;
  chart.setBarSpace(Math.max(1.5, w / 242));
  chart.scrollToRealTime();
}

// ---- 加载当前 tab 数据 ----
async function load() {
  loading.value = true;
  err.value = "";
  const tab = tabs[active.value];
  try {
    let bars: KBar[];
    if (tab.minute) bars = await fetchMinute(props.code);
    else bars = await fetchKLine(props.code, tab.period!, tab.period! >= 100 ? 500 : 300);
    if (!bars || bars.length === 0) throw new Error("暂无数据");
    renderChart(bars, !!tab.minute);
  } catch (e: any) {
    err.value = "图表加载失败：" + (e?.message || e);
  } finally {
    loading.value = false;
  }
}

async function switchTab(i: number) {
  if (i === active.value) return;
  active.value = i;
  await load();
}

// ---- 头部 / 盘口 ----
async function loadHead() {
  const [qs, book] = await Promise.all([
    fetchQuotes([props.code]),
    fetchOrderBook(props.code).catch(() => null),
  ]);
  if (qs && qs.length) q.value = qs[0];
  if (book) ob.value = book;
}

// ---- 盘中轮询：5s 头/盘口，10s 图表末根 ----
async function refreshHead() {
  try { await loadHead(); } catch { /* ignore */ }
}
async function refreshChart() {
  if (!chart) return;
  const tab = tabs[active.value];
  try {
    let bars: KBar[];
    if (tab.minute) bars = await fetchMinute(props.code);
    else bars = await fetchKLine(props.code, tab.period!, tab.period! >= 100 ? 500 : 300);
    if (bars && bars.length) chart.updateData(toKData([bars[bars.length - 1]])[0]);
  } catch { /* ignore */ }
}

const todo = () => {};

onMounted(async () => {
  await loadHead();
  await load();
  ro = new ResizeObserver(() => {
    chart?.resize();
    if (tabs[active.value].minute) fitMinute();
  });
  if (host.value) ro.observe(host.value);
  headTimer = window.setInterval(refreshHead, 5000);
  chartTimer = window.setInterval(refreshChart, 10000);
});

onUnmounted(() => {
  window.clearInterval(headTimer);
  window.clearInterval(chartTimer);
  ro?.disconnect();
  if (chart) dispose(chart);
});
</script>

<style scoped>
.sc-root {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  background: #0c0f14; color: #d6dae3; font-size: 12px;
}

/* 股票头 */
.sc-head {
  display: flex; align-items: center; gap: 16px;
  padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,.06); flex-wrap: wrap;
}
.sc-id { display: flex; flex-direction: column; gap: 2px; min-width: 92px; }
.sc-name { font-size: 16px; font-weight: 700; color: #eef1f6; }
.sc-code { font-size: 11px; color: #8b93a7; }
.sc-px { display: flex; align-items: baseline; gap: 10px; min-width: 150px; }
.sc-price { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
.sc-chg { display: flex; flex-direction: column; font-size: 11px; font-variant-numeric: tabular-nums; }
.sc-grid {
  display: grid; grid-template-columns: repeat(6, auto); gap: 4px 18px;
  margin-left: auto;
}
.gi { display: flex; gap: 6px; white-space: nowrap; }
.gi label { color: #7b8294; }
.gi span { color: #c7ccd8; font-variant-numeric: tabular-nums; }

/* 周期条 */
.sc-tabs {
  display: flex; align-items: center; gap: 2px;
  padding: 4px 10px; border-bottom: 1px solid rgba(255,255,255,.06);
}
.sc-tab {
  border: none; background: transparent; color: #9aa1b1;
  padding: 4px 10px; font-size: 12px; border-radius: 5px; cursor: pointer;
}
.sc-tab:hover { background: rgba(255,255,255,.06); color: #e6e9f0; }
.sc-tab.active { background: rgba(242,54,69,.16); color: #ff6b76; }
.sc-tab.ghost { color: #7b8294; }
.sc-tabs-right { margin-left: auto; }

/* 主体 */
.sc-body { flex: 1; min-height: 0; display: flex; }
.sc-chart { flex: 1; min-width: 0; position: relative; }
.chart-host { position: absolute; inset: 0; }
.sc-mask {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #8b93a7; background: #0c0f14;
}
.sc-mask.err { color: #ff6b76; padding: 0 24px; text-align: center; }

/* 五档盘口 */
.sc-book {
  width: 178px; flex-shrink: 0; border-left: 1px solid rgba(255,255,255,.06);
  display: flex; flex-direction: column; font-size: 11px;
}
.ask, .bid { display: flex; flex-direction: column; }
.lvl {
  position: relative; display: grid; grid-template-columns: 30px 1fr auto;
  gap: 4px; padding: 2.5px 8px; align-items: center; overflow: hidden;
}
.lvl-tag { color: #7b8294; z-index: 1; }
.lvl-px { z-index: 1; font-variant-numeric: tabular-nums; text-align: right; }
.lvl-vol { color: #9aa1b1; z-index: 1; font-variant-numeric: tabular-nums; }
.lvl-bar {
  position: absolute; right: 0; top: 2px; bottom: 2px; height: auto;
  opacity: .14; z-index: 0; border-radius: 3px 0 0 3px;
}
.ask-lvl .lvl-bar { background: UP; }
.bid-lvl .lvl-bar { background: DOWN; }
.book-mid {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: 6px 10px; border-top: 1px solid rgba(255,255,255,.06);
  border-bottom: 1px solid rgba(255,255,255,.06);
}
.bm-px { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
.bm-chg { font-size: 11px; font-variant-numeric: tabular-nums; }
.book-foot { margin-top: auto; padding: 8px 10px; border-top: 1px solid rgba(255,255,255,.06); }
.book-foot div { display: flex; justify-content: space-between; padding: 2px 0; }
.book-foot label { color: #7b8294; }
.book-foot span { color: #c7ccd8; }

.up { color: #ff5b68 !important; }
.down { color: #16c98d !important; }
</style>
