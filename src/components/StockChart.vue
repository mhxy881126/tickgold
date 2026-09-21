<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
// @ts-ignore
import { Chart } from "hqchart/lib/main.js";

const props = defineProps<{ code: string }>();

const chartRef = ref<HTMLDivElement | null>(null);
let chart: any = null;
const period = ref<"minute" | "day" | "week" | "month">("day");

function getHQSymbol(code: string): string {
  if (code.startsWith("6") || code.startsWith("9")) return "sh" + code;
  return "sz" + code;
}

function load() {
  if (!chart) return;
  const sym = getHQSymbol(props.code);
  if (period.value === "minute") {
    chart.ChangePeriod("分时");
  } else if (period.value === "day") {
    chart.ChangePeriod("日线");
  } else if (period.value === "week") {
    chart.ChangePeriod("周线");
  } else {
    chart.ChangePeriod("月线");
  }
  chart.ChangeSymbol(sym);
}

function switchPeriod(p: "minute" | "day" | "week" | "month") {
  period.value = p;
  load();
}

onMounted(() => {
  if (!chartRef.value) return;
  chart = Chart.jsChartInit(chartRef.value, {
    type: "historykline",
    symbol: getHQSymbol(props.code),
    language: "cn",
    Windows: [
      { index: "MA" },
      { index: "VOL" },
      { index: "MACD" },
    ],
  });
});

onBeforeUnmount(() => {
  chart?.Destroy?.();
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
.chart { flex: 1; }
</style>
