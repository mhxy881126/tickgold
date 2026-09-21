<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import * as echarts from "echarts";
import { fetchKLine, fetchMinute } from "../api/market";

const props = defineProps<{ code: string }>();

const chartRef = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;
let ro: ResizeObserver | null = null;
const period = ref<"minute" | "day" | "week" | "month">("day");
const loading = ref(false);

async function load() {
  if (!chart) return;
  loading.value = true;
  try {
    let dates: string[] = [];
    let ohlc: number[][] = [];
    let volumes: number[] = [];

    if (period.value === "minute") {
      const bars = await fetchMinute(props.code);
      dates = bars.map((b) => new Date(b.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
      ohlc = bars.map((b) => [b.open, b.close, b.low, b.high]);
      volumes = bars.map((b) => b.volume);
    } else {
      const periodNum = period.value === "day" ? 101 : period.value === "week" ? 102 : 103;
      const bars = await fetchKLine(props.code, periodNum, 300);
      dates = bars.map((b) => {
        const d = new Date(b.timestamp);
        return `${d.getMonth()+1}/${d.getDate()}`;
      });
      ohlc = bars.map((b) => [b.open, b.close, b.low, b.high]);
      volumes = bars.map((b) => b.volume);
    }

    // 计算 MA
    const calcMA = (data: number[], n: number) => {
      const result: (number | null)[] = [];
      for (let i = 0; i < data.length; i++) {
        if (i < n - 1) result.push(null);
        else {
          let sum = 0;
          for (let j = i - n + 1; j <= i; j++) sum += data[j];
          result.push(+(sum / n).toFixed(2));
        }
      }
      return result;
    };
    const closes = ohlc.map((b) => b[1]);
    const ma5 = calcMA(closes, 5);
    const ma10 = calcMA(closes, 10);
    const ma20 = calcMA(closes, 20);

    chart.setOption({
      backgroundColor: "transparent",
      animation: false,
      legend: {
        data: ["MA5", "MA10", "MA20"],
        top: 5,
        textStyle: { color: "#8b949e", fontSize: 11 },
      },
      grid: [
        { left: 50, right: 60, top: 30, height: "55%" },
        { left: 50, right: 60, top: "65%", height: "15%" },
        { left: 50, right: 60, top: "85%", height: "12%" },
      ],
      xAxis: [
        { type: "category", data: dates, gridIndex: 0, axisLine: { lineStyle: { color: "#30363d" } }, axisLabel: { color: "#8b949e", fontSize: 10 } },
        { type: "category", data: dates, gridIndex: 1, axisLine: { lineStyle: { color: "#30363d" } }, axisLabel: { show: false } },
        { type: "category", data: dates, gridIndex: 2, axisLine: { lineStyle: { color: "#30363d" } }, axisLabel: { color: "#8b949e", fontSize: 10 } },
      ],
      yAxis: [
        { scale: true, gridIndex: 0, axisLine: { lineStyle: { color: "#30363d" } }, splitLine: { lineStyle: { color: "#1c2333" } }, axisLabel: { color: "#8b949e", fontSize: 10 } },
        { scale: true, gridIndex: 1, axisLine: { lineStyle: { color: "#30363d" } }, splitLine: { show: false }, axisLabel: { color: "#8b949e", fontSize: 10 } },
        { scale: true, gridIndex: 2, axisLine: { lineStyle: { color: "#30363d" } }, splitLine: { show: false }, axisLabel: { color: "#8b949e", fontSize: 10 } },
      ],
      dataZoom: [
        { type: "inside", xAxisIndex: [0, 1, 2], start: 60, end: 100 },
      ],
      series: [
        {
          name: "K线",
          type: "candlestick",
          data: ohlc,
          itemStyle: {
            color: "#ef5350",
            color0: "#26a69a",
            borderColor: "#ef5350",
            borderColor0: "#26a69a",
          },
        },
        { name: "MA5", type: "line", data: ma5, xAxisIndex: 0, yAxisIndex: 0, smooth: true, showSymbol: false, lineStyle: { color: "#ffd740", width: 1 } },
        { name: "MA10", type: "line", data: ma10, xAxisIndex: 0, yAxisIndex: 0, smooth: true, showSymbol: false, lineStyle: { color: "#40c4ff", width: 1 } },
        { name: "MA20", type: "line", data: ma20, xAxisIndex: 0, yAxisIndex: 0, smooth: true, showSymbol: false, lineStyle: { color: "#e040fb", width: 1 } },
        {
          name: "成交量",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: volumes.map((v, i) => ({
            value: v,
            itemStyle: { color: ohlc[i][1] >= ohlc[i][0] ? "#ef5350" : "#26a69a" },
          })),
        },
      ],
    });
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
  chart = echarts.init(chartRef.value);
  load();
  ro = new ResizeObserver(() => chart?.resize());
  ro.observe(chartRef.value);
});

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  chart?.dispose();
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
.chart-panel { display: flex; flex-direction: column; height: 100%; }
.toolbar { display: flex; gap: 4px; padding: 6px 10px; border-bottom: 1px solid #20272f; }
.toolbar button {
  background: transparent; border: none; color: #8b949e; padding: 4px 10px;
  border-radius: 3px; cursor: pointer; font-size: 12px;
}
.toolbar button.on { background: #2f6fed; color: #fff; }
.loading { margin-left: auto; color: #8b949e; font-size: 11px; }
.chart { flex: 1; }
</style>
