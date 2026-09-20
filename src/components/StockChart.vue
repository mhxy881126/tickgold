<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick, reactive } from "vue";
import { init, dispose, type Chart } from "klinecharts";
import { fetchKLine } from "../api/market";
import type { KBar } from "../api/types";

const props = defineProps<{ code: string | null }>();

const box = ref<HTMLDivElement | null>(null);
const loading = ref(false);
// period: 0=分时 1/5/15/30/60 分钟 101 日 102 周 103 月
const period = ref(101);
const periods = [
  { label: "分时", value: 0 },
  { label: "1分", value: 1 },
  { label: "5分", value: 5 },
  { label: "15分", value: 15 },
  { label: "30分", value: 30 },
  { label: "60分", value: 60 },
  { label: "日K", value: 101 },
  { label: "周K", value: 102 },
  { label: "月K", value: 103 },
];

type MainInd = "MA" | "BOLL";
type SubInd = "VOL" | "MACD" | "KDJ" | "RSI";
const mainInd = ref<MainInd>("MA");
const subInd = ref<SubInd>("VOL");
const mainInds: MainInd[] = ["MA", "BOLL"];
const subInds: SubInd[] = ["VOL", "MACD", "KDJ", "RSI"];

// 均线参数
const maParams = reactive([5, 10, 20, 30, 60]);
const showMaSettings = ref(false);
const maInput = ref("5,10,20,30,60");

// 悬停盘口浮层
const hover = reactive({
  time: "", open: 0, high: 0, low: 0, close: 0,
  volume: 0, change: 0, pct: 0, show: false,
});

let chart: Chart | null = null;

async function load() {
  if (!props.code || !chart) return;
  loading.value = true;
  // 分时：拉 1 分钟数据
  const loadPeriod = period.value === 0 ? 1 : period.value;
  const bars: KBar[] = await fetchKLine(props.code, loadPeriod, 800);
  chart.applyNewData(
    bars.map((b) => ({
      timestamp: b.timestamp,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }))
  );
  loading.value = false;
}

function setupChart() {
  if (!box.value || chart) return;
  const isTS = period.value === 0;
  const c = init(box.value, {
    styles: {
      grid: { horizontal: { color: "#1b2129" }, vertical: { color: "#1b2129" } },
      candle: {
        type: (isTS ? "time_sharing" : "candle_solid") as any,
        priceMark: { high: { color: "#f23645" }, low: { color: "#089981" } },
      },
    },
  });
  if (!c) return;
  chart = c;
  applyIndicators();
  c.subscribeAction("onCrosshairChange" as any, (data: any) => {
    const d = data?.kLineData;
    if (!d) { hover.show = false; return; }
    hover.show = true;
    hover.close = d.close ?? 0;
    hover.open = d.open ?? 0;
    hover.high = d.high ?? 0;
    hover.low = d.low ?? 0;
    hover.volume = d.volume ?? 0;
    hover.change = hover.close - hover.open;
    hover.pct = hover.open ? (hover.change / hover.open) * 100 : 0;
    const dt = new Date(d.timestamp);
    hover.time = `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
  });
}

/** 应用主图 + 副图指标 */
function applyIndicators() {
  if (!chart) return;
  const isTS = period.value === 0;
  if (isTS) {
    try { chart.removeIndicator("MA"); } catch {}
    try { chart.removeIndicator("BOLL"); } catch {}
  } else {
    chart.createIndicator(mainInd.value, false, { id: "candle_pane" });
    if (mainInd.value === "MA") {
      chart.overrideIndicator({ id: "candle_pane", name: "MA", calcParams: [...maParams] } as any);
    }
  }
  const existing = chart.getIndicatorByPaneId("pane_sub") || {};
  for (const name of Object.keys(existing)) {
    try { chart.removeIndicator(name); } catch {}
  }
  chart.createIndicator(subInd.value, false, { id: "pane_sub" });
}

function setMainInd(m: MainInd) {
  mainInd.value = m;
  applyIndicators();
}
function setSubInd(s: SubInd) {
  subInd.value = s;
  applyIndicators();
}

function openMaSettings() {
  maInput.value = maParams.join(",");
  showMaSettings.value = true;
}
function applyMaParams() {
  const nums = maInput.value.split(/[,，\s]+/).map((s) => parseInt(s, 10)).filter((n) => n > 0 && n < 500).slice(0, 5);
  if (nums.length) {
    maParams.splice(0, maParams.length, ...nums);
    applyIndicators();
  }
  showMaSettings.value = false;
}

function fmt(n: number) {
  return n.toFixed(2);
}
function vol(v: number) {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万";
  return v.toFixed(0);
}
function cls(p: number) {
  return p > 0.001 ? "up" : p < -0.001 ? "down" : "flat";
}

// 切周期：只切 candle 样式 + 重新拉数据，不重建实例
watch(period, async () => {
  if (!chart) return;
  const isTS = period.value === 0;
  chart.setStyles({ candle: { type: (isTS ? "time_sharing" : "candle_solid") as any } });
  applyIndicators();
  await load();
});
watch(() => props.code, load);

onMounted(async () => {
  await nextTick();
  setupChart();
  load();
});
onBeforeUnmount(() => {
  if (box.value) dispose(box.value);
  chart = null;
});
</script>

<template>
  <div class="chart-wrap">
    <div class="toolbar">
      <button
        v-for="p in periods"
        :key="p.value"
        :class="{ on: period === p.value }"
        @click="period = p.value"
      >{{ p.label }}</button>
      <span class="sep">|</span>
      <button
        v-for="m in mainInds"
        :key="m"
        :class="{ on: mainInd === m }"
        @click="setMainInd(m)"
      >{{ m }}</button>
      <button class="gear" title="均线参数" @click="openMaSettings">⚙</button>
      <span class="sep">|</span>
      <button
        v-for="s in subInds"
        :key="s"
        :class="{ on: subInd === s }"
        @click="setSubInd(s)"
      >{{ s }}</button>
      <span v-if="loading" class="ld">加载中…</span>
    </div>
    <div v-if="hover.show" class="hover-bar" :class="cls(hover.pct)">
      <span>{{ hover.time }}</span>
      <span>开 {{ fmt(hover.open) }}</span>
      <span>高 {{ fmt(hover.high) }}</span>
      <span>低 {{ fmt(hover.low) }}</span>
      <span>收 {{ fmt(hover.close) }}</span>
      <span>量 {{ vol(hover.volume) }}</span>
      <span :class="cls(hover.pct)">{{ hover.pct >= 0 ? "+" : "" }}{{ fmt(hover.pct) }}%</span>
    </div>
    <div ref="box" class="chart"></div>

    <div v-if="showMaSettings" class="modal-mask" @click.self="showMaSettings = false">
      <div class="modal">
        <h3>均线参数</h3>
        <p class="hint">逗号分隔，1~5 个正整数</p>
        <input v-model="maInput" class="ma-inp" />
        <div class="modal-btns">
          <button @click="showMaSettings = false">取消</button>
          <button class="ok" @click="applyMaParams">应用</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chart-wrap { display: flex; flex-direction: column; height: 100%; position: relative; }
.toolbar { display: flex; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--border); align-items: center; }
.toolbar button {
  background: transparent; color: var(--text-dim); border: 1px solid transparent;
  border-radius: 5px; padding: 3px 9px; cursor: pointer; font-size: 12px;
}
.toolbar button.on { color: var(--text); background: var(--bg-hover); border-color: var(--border); }
.toolbar button:hover { color: var(--text); }
.toolbar .sep { color: var(--border); margin: 0 4px; }
.toolbar .gear { color: var(--text-dim); }
.ld { margin-left: auto; color: var(--text-dim); align-self: center; }
.chart { flex: 1; min-height: 0; }
.hover-bar {
  display: flex; gap: 14px; padding: 4px 10px; font-size: 12px;
  border-bottom: 1px solid var(--border); color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.hover-bar.up { color: #f23645; }
.hover-bar.down { color: #089981; }
.modal-mask {
  position: absolute; inset: 0; background: rgba(0,0,0,.5);
  display: flex; align-items: center; justify-content: center; z-index: 10;
}
.modal {
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px;
  padding: 16px; width: 260px;
}
.modal h3 { margin: 0 0 6px; font-size: 14px; }
.hint { margin: 0 0 8px; font-size: 12px; color: var(--text-dim); }
.ma-inp {
  width: 100%; box-sizing: border-box; background: var(--bg-input);
  border: 1px solid var(--border); color: var(--text); padding: 6px 8px;
  border-radius: 4px; font-size: 13px;
}
.modal-btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.modal-btns button {
  background: transparent; border: 1px solid var(--border); color: var(--text-dim);
  padding: 4px 12px; border-radius: 4px; cursor: pointer;
}
.modal-btns button.ok { background: var(--accent); border-color: var(--accent); color: #fff; }
</style>
