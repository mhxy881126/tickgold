<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { startRadar, type RadarData } from "../api/market";

const data = ref<RadarData | null>(null);
let un: (() => void) | null = null;

// 展示顺序（左→右）：跌极端→跌微 | 涨微→涨极端，共 10 档
const ORDER = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
const LABELS = ["≤-7", "-7~-5", "-5~-3", "-3~-1", "-1~0", "0~1", "1~3", "3~5", "5~7", "≥7"];
const IS_UP = [false, false, false, false, false, true, true, true, true, true];

const bars = computed(() => {
  const hist = data.value ? data.value.hist : [];
  const max = hist.length ? Math.max(...hist) : 1;
  return ORDER.map((idx, i) => {
    const v = hist[idx] ?? 0;
    return { v, h: v ? (v / max) * 100 : 0, lb: LABELS[i], up: IS_UP[i] };
  });
});
const totalUp = computed(() => (data.value ? data.value.upCount : 0));
const totalDown = computed(() => (data.value ? data.value.downCount : 0));
const totalFlat = computed(() => (data.value ? data.value.flatCount : 0));

onMounted(async () => {
  un = await listen<RadarData>("radar:data", (e) => (data.value = e.payload));
  try {
    await startRadar();
  } catch {
    /* 雷达可能已由其他卡片启动，忽略 */
  }
});
onBeforeUnmount(() => un?.());
</script>

<template>
  <div class="dist-board">
    <div class="d-chart">
      <div v-for="(b, i) in bars" :key="i" class="d-col">
        <span class="d-val">{{ b.v || "" }}</span>
        <div class="d-barwrap">
          <div class="d-bar" :class="{ up: b.up, down: !b.up }" :style="{ height: b.h + '%' }"></div>
        </div>
        <span class="d-lb">{{ b.lb }}</span>
      </div>
    </div>
    <div class="d-sum">
      <span class="down">跌 <b>{{ totalDown }}</b></span>
      <span class="flat">平 <b>{{ totalFlat }}</b></span>
      <span class="up">涨 <b>{{ totalUp }}</b></span>
    </div>
  </div>
</template>

<style scoped>
.dist-board {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 8px 10px 7px;
  overflow: hidden;
}
.d-chart {
  flex: 1;
  display: flex;
  align-items: stretch;
  gap: 2px;
  min-height: 0;
}
.d-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 0;
}
.d-val {
  font-size: 9px;
  height: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.d-barwrap {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  min-height: 0;
}
.d-bar {
  width: 72%;
  min-height: 1px;
  border-radius: 2px 2px 0 0;
}
.d-bar.up {
  background: var(--up);
}
.d-bar.down {
  background: var(--down);
}
.d-lb {
  font-size: 7.5px;
  height: 13px;
  color: var(--text-dim);
  white-space: nowrap;
  transform: scale(0.9);
}
.d-sum {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-dim);
  padding-top: 5px;
  border-top: 1px solid var(--border);
  margin-top: 4px;
}
.d-sum b {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}
.d-sum .up b {
  color: var(--up);
}
.d-sum .down b {
  color: var(--down);
}
.d-sum .flat b {
  color: var(--text-dim);
}
</style>
