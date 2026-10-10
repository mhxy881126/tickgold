<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { fetchIndexQuotes } from "../../api/market";
import type { Quote } from "../../api/types";

const list = ref<Quote[]>([]);
const loading = ref(true);
const error = ref("");
let timer: number | null = null;

async function refresh() {
  try {
    const data = await fetchIndexQuotes();
    if (data.length) {
      list.value = data;
      error.value = "";
    }
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

function cls(pct: number) {
  return pct > 0.001 ? "up" : pct < -0.001 ? "down" : "flat";
}

onMounted(() => {
  refresh();
  timer = window.setInterval(refresh, 5000);
});
onBeforeUnmount(() => {
  if (timer != null) clearInterval(timer);
});
</script>

<template>
  <div class="market-card">
    <div v-if="loading" class="loading">加载中…</div>
    <div v-else-if="error" class="error">{{ error }}</div>
    <div v-else class="index-list">
      <div v-for="q in list" :key="q.code" class="index-row" :class="cls(q.pct)">
        <div class="idx-header">
          <span class="idx-name">{{ q.name }}</span>
          <span class="idx-code">{{ q.code }}</span>
        </div>
        <div class="idx-price">{{ q.price.toFixed(2) }}</div>
        <div class="idx-chg">
          <span>{{ q.change > 0 ? "+" : "" }}{{ q.change.toFixed(2) }}</span>
          <span>{{ q.pct > 0 ? "+" : "" }}{{ q.pct.toFixed(2) }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.market-card {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  padding: 12px; gap: 8px; overflow: hidden;
}
.loading, .error {
  flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim, #8a93a6); font-size: 12px;
}
.error { color: #ff8a8a; }
.index-list {
  flex: 1; min-height: 0; overflow-y: auto;
  display: flex; flex-direction: column; gap: 8px;
}
.index-row {
  padding: 10px 12px; border-radius: 8px;
  background: var(--bg-card, #15181f); border: 1px solid var(--border, #2a3344);
  border-left: 3px solid var(--border, #2a3344);
}
.index-row.up { border-left-color: #ff4d4f; }
.index-row.down { border-left-color: #26d07c; }
.index-row.flat { border-left-color: #8a93a6; }
.idx-header {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-bottom: 4px;
}
.idx-name { font-size: 13px; font-weight: 700; color: var(--text, #e6ecf5); }
.idx-code { font-size: 10px; color: var(--text-dim, #8a93a6); }
.idx-price {
  font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums;
  color: var(--text, #e6ecf5); margin-bottom: 2px;
}
.idx-chg {
  display: flex; gap: 12px; font-size: 12px; font-variant-numeric: tabular-nums;
}
.index-row.up .idx-chg { color: #ff4d4f; }
.index-row.down .idx-chg { color: #26d07c; }
.index-row.flat .idx-chg { color: var(--text-dim, #8a93a6); }
</style>
