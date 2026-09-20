<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { init, dispose, type Chart } from "klinecharts";
import { fetchKLine } from "../api/market";
import type { KBar } from "../api/types";

const props = defineProps<{ code: string | null }>();

const box = ref<HTMLDivElement | null>(null);
const loading = ref(false);
const period = ref(101);
const periods = [
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

let chart: Chart | null = null;

async function load() {
  if (!props.code) return;
  loading.value = true;
  const bars: KBar[] = await fetchKLine(props.code, period.value, 800);
  if (chart) {
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
  }
  loading.value = false;
}

function setupChart() {
  if (!box.value) return;
  const c = init(box.value, {
    styles: {
      grid: { horizontal: { color: "#1b2129" }, vertical: { color: "#1b2129" } },
      candle: {
        priceMark: { high: { color: "#f23645" }, low: { color: "#089981" } },
      },
    },
  });
  if (!c) return;
  chart = c;
  applyIndicators();
}

/** 应用主图 + 副图指标 */
function applyIndicators() {
  if (!chart) return;
  // 主图：替换 candle_pane 指标
  chart.createIndicator(mainInd.value, false, { id: "candle_pane" });
  // 副图：先清空 pane_sub 旧指标，再创建新的
  const existing = chart.getIndicatorByPaneId("pane_sub") || {};
  for (const name of Object.keys(existing)) {
    chart.removeIndicator(name);
  }
  chart.createIndicator(subInd.value, false, { id: "pane_sub" });
}

function setMainInd(m: MainInd) {
  mainInd.value = m;
  if (chart) chart.createIndicator(m, false, { id: "candle_pane" });
}
function setSubInd(s: SubInd) {
  subInd.value = s;
  applyIndicators();
}

watch(() => [props.code, period.value], load);

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
      <span class="sep">|</span>
      <button
        v-for="s in subInds"
        :key="s"
        :class="{ on: subInd === s }"
        @click="setSubInd(s)"
      >{{ s }}</button>
      <span v-if="loading" class="ld">加载中…</span>
    </div>
    <div ref="box" class="chart"></div>
  </div>
</template>

<style scoped>
.chart-wrap { display: flex; flex-direction: column; height: 100%; }
.toolbar { display: flex; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--border); }
.toolbar button {
  background: transparent; color: var(--text-dim); border: 1px solid transparent;
  border-radius: 5px; padding: 3px 9px; cursor: pointer; font-size: 12px;
}
.toolbar button.on { color: var(--text); background: var(--bg-hover); border-color: var(--border); }
.toolbar button:hover { color: var(--text); }
.toolbar .sep { color: var(--border); margin: 0 4px; }
.ld { margin-left: auto; color: var(--text-dim); align-self: center; }
.chart { flex: 1; min-height: 0; }
</style>
