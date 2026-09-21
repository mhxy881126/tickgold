<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { init, type Chart } from "klinecharts";
import { fetchMinute, fetchKLine } from "../api/market";

const props = defineProps<{ code: string }>();

const chartRef = ref<HTMLDivElement | null>(null);
let chart: Chart | null = null;
const period = ref<"minute" | "day" | "week" | "month">("day");
const loading = ref(false);

async function load() {
  if (!chart) return;
  loading.value = true;
  try {
    chart.applyNewData([]);
    if (period.value === "minute") {
      const bars = await fetchMinute(props.code);
      const data = bars.map((b) => ({
        timestamp: b.timestamp, open: b.open, close: b.close,
        low: b.low, high: b.high, volume: b.volume,
      }));
      chart.applyNewData(data);
    } else {
      const periodNum = period.value === "day" ? 101 : period.value === "week" ? 102 : 103;
      const bars = await fetchKLine(props.code, periodNum, 300);
      const data = bars.map((b) => ({
        timestamp: b.timestamp, open: b.open, close: b.close,
        low: b.low, high: b.high, volume: b.volume,
      }));
      chart.applyNewData(data);
    }
  } catch (e) {
    console.error("chart load", e);
  } finally {
    loading.value = false;
  }
}

function switchPeriod(p: "minute" | "day" | "week" | "month") {
  period.value = p;
  load();
}

onMounted(() => {
  if (!chartRef.value) return;
  chart = init(chartRef.value, {
    styles: {
      grid: {
        horizontal: { color: "#1c2333", size: 0.5 },
        vertical: { color: "#1c2333", size: 0.5 },
      },
      candle: {
        tooltip: {
          text: { size: 11, color: "#ccc" },
        },
      },
    } as any,
  });
  const c: any = chart;
  c.createIndicator("MA", false, { id: "candle_pane" });
  c.createIndicator("VOL", false, { id: "pane_vol", height: 80 });
  c.createIndicator("MACD", false, { id: "pane_macd", height: 80 });
  load();
});

onBeforeUnmount(() => {
  (chart as any)?.close?.();
  chart = null;
});

watch(() => props.code, load);
</script>

<template>
  <div class="chart-panel">
    <div class="toolbar">
      <button :class="{ on: period === 'minute' }" @click="switchPeriod('minute')">分时</button>
      <button :class="{ on: period === 'day' }" @click="switchPeriod('day')">日K</button>
      <button :class="{ on: period === 'week' }" @click="switchPeriod('week')">周K</button>
      <button :class="{ on: period === 'month' }" @click="switchPeriod('month')">月K</button>
      <span v-if="loading" class="loading">加载中...</span>
    </div>
    <div ref="chartRef" class="chart"></div>
  </div>
</template>

<style scoped>
.chart-panel { display: flex; flex-direction: column; height: 100%; background: #0d1117; }
.toolbar { display: flex; gap: 4px; padding: 6px 10px; border-bottom: 1px solid #30363d; background: #161b22; }
.toolbar button {
  background: transparent; border: none; color: #8b949e; padding: 4px 10px;
  border-radius: 3px; cursor: pointer; font-size: 12px;
}
.toolbar button.on { background: #1f6feb; color: #fff; }
.toolbar button:hover { background: #21262d; color: #ccc; }
.loading { margin-left: auto; color: #8b949e; font-size: 11px; }
.chart { flex: 1; }
</style>
