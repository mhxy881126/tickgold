<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, toRef } from "vue";
import * as echarts from "echarts";
import { useWidgetData } from "../../composables/useMarketContext";

const props = defineProps<{ bind?: string | null }>();
const d = useWidgetData(toRef(props, "bind"));

const el = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;

function color() {
  const data = d.minute.value;
  if (data.length < 2) return "#f23645";
  return data[data.length - 1].close >= data[0].open ? "#f23645" : "#08db94";
}
function option() {
  const data = d.minute.value;
  const c = color();
  const base = d.ob.value?.prevClose ?? data[0]?.open;
  return {
    animation: false,
    grid: { left: 44, right: 12, top: 10, bottom: 22 },
    xAxis: {
      type: "category", boundaryGap: false, show: false,
      data: data.map((_, i) => i),
    },
    yAxis: { type: "value", scale: true, show: false },
    series: [{
      type: "line", data: data.map((b) => b.close), showSymbol: false,
      lineStyle: { width: 1.4, color: c },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: c + "44" }, { offset: 1, color: c + "00" },
        ]),
      },
      markLine: base
        ? {
            symbol: "none", silent: true,
            data: [{ yAxis: base }],
            lineStyle: { color: "#8a93a5", type: "dashed", width: 1 },
            label: { show: false },
          }
        : undefined,
    }],
  };
}

async function render() {
  await d.ensure("minute");
  await d.ensure("ob"); // 昨收基准线
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
    <div v-if="!d.minute.value.length" class="hint">加载分时…</div>
  </div>
</template>

<style scoped>
.w-chart { position: absolute; inset: 0; min-height: 0; }
.canvas { position: absolute; inset: 0; }
.hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); font-size: 10px; pointer-events: none; }
</style>
