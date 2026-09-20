<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { fetchRank } from "../api/market";
import { useWatchlistStore } from "../stores/watchlist";
import type { Quote } from "../api/types";

const emit = defineEmits<{ select: [code: string]; add: [code: string, name: string] }>();

type Tab = "gainers" | "losers" | "amount";
const tab = ref<Tab>("gainers");
const list = ref<Quote[]>([]);
const loading = ref(false);
const wl = useWatchlistStore();

const tabs: { k: Tab; label: string }[] = [
  { k: "gainers", label: "涨幅" },
  { k: "losers", label: "跌幅" },
  { k: "amount", label: "成交额" },
];

async function load() {
  loading.value = true;
  list.value = await fetchRank(tab.value, 40);
  loading.value = false;
}

watch(tab, load);
onMounted(load);

function isWatched(code: string) {
  return wl.codes.includes(code);
}
function cls(pct: number) {
  return pct > 0.001 ? "up" : pct < -0.001 ? "down" : "flat";
}
function fmt(n: number) {
  return n.toFixed(2);
}
function amt(n: number) {
  return (n / 1e8).toFixed(1) + "亿";
}
function addOne(q: Quote) {
  if (!isWatched(q.code)) wl.add(q.code, q.name);
}
</script>

<template>
  <div class="rank">
    <div class="tabs">
      <button
        v-for="t in tabs"
        :key="t.k"
        class="tab"
        :class="{ active: tab === t.k }"
        @click="tab = t.k"
      >
        {{ t.label }}
      </button>
    </div>
    <table>
      <thead>
        <tr><th>#</th><th>名称/代码</th><th class="r">最新</th><th class="r">涨跌幅</th><th class="r">成交额</th><th></th></tr>
      </thead>
      <tbody>
        <tr
          v-for="(q, i) in list"
          :key="q.code"
          @click="emit('select', q.code)"
        >
          <td class="idx">{{ i + 1 }}</td>
          <td>
            <div class="nm">{{ q.name }}</div>
            <div class="cd">{{ q.code }}</div>
          </td>
          <td class="r" :class="cls(q.pct)">{{ fmt(q.price) }}</td>
          <td class="r" :class="cls(q.pct)">{{ fmt(q.pct) }}%</td>
          <td class="r dim">{{ amt(q.amount) }}</td>
          <td class="ops">
            <button
              v-if="!isWatched(q.code)"
              class="add"
              title="加入自选"
              @click.stop="addOne(q)"
            >+</button>
            <span v-else class="inwl">已加</span>
          </td>
        </tr>
        <tr v-if="!loading && list.length === 0">
          <td colspan="6" class="empty">暂无数据</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.rank { display: flex; flex-direction: column; height: 100%; }
.tabs { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--border); }
.tab {
  flex: 1; padding: 4px 0; font-size: 12px; border-radius: 5px;
  background: transparent; border: 1px solid var(--border); color: var(--text-dim); cursor: pointer;
}
.tab.active { color: #e6edf3; border-color: #2f6fed; background: #16233a; }
table { width: 100%; border-collapse: collapse; }
thead th {
  text-align: left; color: var(--text-dim); font-weight: 500;
  padding: 6px 8px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg-panel);
}
th.r, td.r { text-align: right; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--bg-hover); }
td { padding: 6px 8px; border-bottom: 1px solid #1b2129; }
.idx { color: var(--text-dim); width: 22px; }
.nm { font-weight: 600; }
.cd { font-size: 11px; color: var(--text-dim); }
.dim { color: var(--text-dim); }
.ops { width: 44px; text-align: center; }
.add {
  background: transparent; border: 1px solid var(--border); color: var(--accent);
  border-radius: 4px; font-size: 12px; cursor: pointer; padding: 1px 8px;
}
.add:hover { background: var(--bg-hover); }
.inwl { font-size: 11px; color: var(--text-dim); }
.empty { text-align: center; color: var(--text-dim); padding: 30px; }
</style>
