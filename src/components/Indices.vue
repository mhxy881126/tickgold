<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { fetchIndexQuotes } from "../api/market";
import type { Quote } from "../api/types";

const list = ref<Quote[]>([]);
// 方案 A 紧凑行情条：仅展示最核心的 3 个指数（上证/深成/创业板）
const shown = computed(() => list.value.slice(0, 3));
let timer: number | null = null;

async function refresh() {
  const data = await fetchIndexQuotes();
  if (data.length) list.value = data;
}

function cls(pct: number) {
  return pct > 0.001 ? "up" : pct < -0.001 ? "down" : "flat";
}
function fmt(n: number) {
  return n.toFixed(2);
}

onMounted(() => {
  refresh();
  timer = window.setInterval(refresh, 3000);
});
onBeforeUnmount(() => {
  if (timer != null) clearInterval(timer);
});
</script>

<template>
  <div class="indices">
    <div v-for="q in shown" :key="q.code" class="idx" :class="cls(q.pct)">
      <span class="name">{{ q.name }}</span>
      <span class="price">{{ fmt(q.price) }}</span>
      <span class="pct">{{ q.pct > 0 ? "+" : "" }}{{ q.pct.toFixed(2) }}%</span>
    </div>
  </div>
</template>

<style scoped>
.indices {
  display: flex; align-items: center; gap: 18px;
  padding: 0 14px; flex: 1 1 auto; min-width: 0;
  font-size: 11px; overflow: hidden; white-space: nowrap;
}
.idx { display: flex; align-items: center; gap: 6px; }
.name { color: var(--text-dim); }
.price { font-weight: 600; font-variant-numeric: tabular-nums; }
.pct { font-variant-numeric: tabular-nums; font-size: 10px; opacity: 0.95; }
</style>
