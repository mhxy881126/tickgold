<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { fetchIndexQuotes } from "../api/market";
import type { Quote } from "../api/types";

const list = ref<Quote[]>([]);
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
    <div v-for="q in list" :key="q.code" class="idx" :class="cls(q.pct)">
      <span class="name">{{ q.name }}</span>
      <span class="price">{{ fmt(q.price) }}</span>
      <span class="chg">{{ q.change > 0 ? "+" : "" }}{{ fmt(q.change) }}</span>
      <span class="pct">{{ q.pct > 0 ? "+" : "" }}{{ q.pct.toFixed(2) }}%</span>
    </div>
  </div>
</template>

<style scoped>
.indices {
  display: flex; align-items: center; gap: 22px;
  padding: 4px 12px; height: 28px;
  background: var(--bg-panel); border-bottom: 1px solid var(--border);
  font-size: 12px; overflow: hidden; white-space: nowrap;
}
.idx { display: flex; align-items: baseline; gap: 6px; }
.name { color: var(--text-dim); }
.price { font-weight: 600; font-variant-numeric: tabular-nums; }
.chg, .pct { font-variant-numeric: tabular-nums; opacity: 0.9; }
</style>
