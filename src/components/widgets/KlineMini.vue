<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, toRef } from "vue";
import * as echarts from "echarts";
import { useWidgetData } from "../../composables/useMarketContext";

const props = defineProps<{ bind?: string | null }>();
const d = useWidgetData(toRef(props, "bind"));

const el = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;

function ma(n: number) {
  const data = d.kline.value;
  return data.map((_, i) =>
    i < n - 1
      ? null
      : +(data.slice(i - n + 1, i + 1).reduce((a, b) => a + b.close, 0) / n).toFixed(2)
  );
}
function option() {
  const data = d.kline.value;
  return {
    animation: false,
    legend: {
      data: ["MA5", "MA10", "MA20"], textStyle: { color: "#8a93a5", fontSize: 9 }, top: 2,
      itemWidth: 12, itemHeight: 7,
    },
    grid: [
      { left: 40, right: 10, top: 22, height: "60%" },
      { left: 40, right: 10, top: "80%", height: "15%" },
    ],
    tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
    xAxis: [
      { type: "category", data: data.map(() => ""), axisLabel: { show: false }, axisLine: { lineStyle: { color: "#2a3344" } } },
      { type: "category", gridIndex: 1, data: data.map(() => ""), axisLabel: { show: false } },
    ],
    yAxis: [
      { scale: true, axisLabel: { color: "#8a93a5", fontSize: 9 }, splitLine: { lineStyle: { color: "rgba(255,255,255,.05)" } } },
      { gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
    ],
    series: [
      {
        name: "K", type: "candlestick",
        data: data.map((b) => [b.open, b.close, b.low, b.high]),
        itemStyle: { color: "#f23645", color0: "#08db94", borderColor: "#f23645", borderColor0: "#08db94" },
      },
      { name: "MA5", type: "line", data: ma(5), showSymbol: false, lineStyle: { width: 1, color: "#ffd24d" } },
      { name: "MA10", type: "line", data: ma(10), showSymbol: false, lineStyle: { width: 1, color: "#b07dff" } },
      { name: "MA20", type: "line", data: ma(20), showSymbol: false, lineStyle: { width: 1, color: "#5db8ff" } },
      {
        name: "VOL", type: "bar", xAxisIndex: 1, yAxisIndex: 1,
        data: data.map((b) => b.volume),
        itemStyle: { color: (p: any) => (data[p.dataIndex].close >= data[p.dataIndex].open ? "#f23645" : "#08db94") },
      },
    ],
  };
}

async function render() {
  await d.ensure("kline");
  chart?.setOption(option(), true);
}

onMounted(async () => {
  await nextTick();
  if (el.value) chart = echarts.init(el.value);
  render();
});
watch(() => d.code.value, () => nextTick(render));
onBeforeUnmount(() => { chart?.dispose(); chart = null; });
</script>

<template>
  <div class="w-chart">
    <div ref="el" class="canvas"></div>
    <div v-if="!d.kline.value.length" class="hint">加载日K…</div>
  </div>
</template>

<style scoped>
.w-chart { position: absolute; inset: 0; min-height: 0; }
.canvas { position: absolute; inset: 0; }
.hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); font-size: 10px; pointer-events: none; }
</style>
