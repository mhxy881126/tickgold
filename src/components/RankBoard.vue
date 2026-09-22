<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { fetchRankPage } from "../api/market";
import { useWatchlistStore } from "../stores/watchlist";
import type { Quote } from "../api/types";

const emit = defineEmits<{ select: [code: string]; add: [code: string, name: string] }>();

type Tab = "gainers" | "losers" | "amount";
const tab = ref<Tab>("gainers");
const list = ref<Quote[]>([]);
const page = ref(0);
const PAGE_SIZE = 50;
const loading = ref(false);
const hasMore = ref(true);
const errorMsg = ref("");
const wl = useWatchlistStore();

const tabs: { k: Tab; label: string }[] = [
  { k: "gainers", label: "涨幅" },
  { k: "losers", label: "跌幅" },
  { k: "amount", label: "成交额" },
];

async function loadMore() {
  if (loading.value || !hasMore.value) return;
  loading.value = true;
  errorMsg.value = "";
  const next = page.value + 1;
  try {
    const rows = await fetchRankPage(tab.value, next, PAGE_SIZE);
    list.value = list.value.concat(rows);
    page.value = next;
    if (rows.length < PAGE_SIZE) hasMore.value = false;
  } catch (e: any) {
    if (list.value.length === 0) {
      errorMsg.value = String(e?.message || e || "加载失败");
    }
    // 已有数据时后续页失败：保留现状，用户可再次滚动重试
  } finally {
    loading.value = false;
  }
}

function reset() {
  list.value = [];
  page.value = 0;
  hasMore.value = true;
  errorMsg.value = "";
  loading.value = false;
  loadMore();
}
watch(tab, reset);
onMounted(reset);

function onScroll(e: Event) {
  const el = e.target as HTMLElement;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) loadMore();
}

function isWatched(code: string) {
  return wl.codes.includes(code);
}
function cls(pct: number) {
  return pct > 0.001 ? "up" : pct < -0.001 ? "down" : "flat";
}
function fmt(n: number) {
  return n.toFixed(2);
}
function amtSmart(n: number) {
  return n >= 1e8 ? (n / 1e8).toFixed(1) + "亿" : Math.round(n / 1e4) + "万";
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

    <div class="scroll" @scroll="onScroll">
      <table>
        <colgroup>
          <col style="width: 10%">
          <col style="width: 36%">
          <col style="width: 19%">
          <col style="width: 18%">
          <col style="width: 17%">
        </colgroup>
        <thead>
          <tr><th>#</th><th>名称</th><th class="r">最新</th><th class="r">涨跌幅</th><th class="r">成交额</th></tr>
        </thead>
        <tbody>
          <tr
            v-for="(q, i) in list"
            :key="q.code"
            @click="emit('select', q.code)"
          >
            <td class="idx">{{ i + 1 }}</td>
            <td class="stock-cell">
              <span class="nm">{{ q.name }}</span>
              <span class="cd">{{ q.code }}</span>
            </td>
            <td class="r" :class="cls(q.pct)">{{ fmt(q.price) }}</td>
            <td class="r" :class="cls(q.pct)">{{ q.pct > 0 ? "+" : "" }}{{ fmt(q.pct) }}%</td>
            <td class="r dim">
              {{ amtSmart(q.amount) }}
              <button
                v-if="!isWatched(q.code)"
                class="add"
                title="加入自选"
                @click.stop="addOne(q)"
              >+</button>
            </td>
          </tr>

          <tr v-if="loading">
            <td colspan="5" class="status"><span class="spin"></span>正在加载更多…</td>
          </tr>
          <tr v-else-if="!hasMore && list.length > 0">
            <td colspan="5" class="status dim">已加载全部 {{ list.length }} 只股票</td>
          </tr>
          <tr v-if="errorMsg && list.length === 0">
            <td colspan="5" class="empty err">{{ errorMsg }}</td>
          </tr>
          <tr v-if="!loading && list.length === 0 && !errorMsg">
            <td colspan="5" class="empty">暂无数据</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.rank { display: flex; flex-direction: column; height: 100%; }
.tabs { display: flex; gap: 6px; padding: 8px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
.tab {
  flex: 1; padding: 4px 0; font-size: 12px; border-radius: 5px;
  background: transparent; border: 1px solid var(--border); color: var(--text-dim); cursor: pointer;
}
.tab.active { color: #e6edf3; border-color: #2f6fed; background: #16233a; }

.scroll { flex: 1; overflow-y: auto; min-height: 0; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead th {
  text-align: left; color: var(--text-dim); font-weight: 500;
  padding: 5px 8px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg-panel); z-index: 1;
  font-size: 11px;
}
th.r, td.r { text-align: right; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--bg-hover); }
td { padding: 5px 8px; border-bottom: 1px solid #1b2129; font-size: 12px; white-space: nowrap; overflow: hidden; }
.idx { color: var(--text-dim); width: 22px; font-size: 11px; }
.stock-cell { display: flex; align-items: baseline; gap: 5px; overflow: hidden; }
.nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cd { font-size: 10px; color: var(--text-dim); flex-shrink: 0; }
.dim { color: var(--text-dim); position: relative; }
.add {
  background: transparent; border: none; color: var(--accent);
  font-size: 13px; cursor: pointer; padding: 0 0 0 4px;
  position: absolute; right: 2px; top: 50%; transform: translateY(-50%);
  opacity: 0;
}
tr:hover .add { opacity: 1; }
.add:hover { color: #fff; }

.status { text-align: center; color: var(--text-dim); padding: 12px; font-size: 11px; }
.status .spin {
  display: inline-block; width: 11px; height: 11px; margin-right: 6px;
  border: 2px solid #333; border-top-color: #d4af37; border-radius: 50%;
  vertical-align: -1px; animation: r .8s linear infinite;
}
@keyframes r { to { transform: rotate(360deg); } }
.empty { text-align: center; color: var(--text-dim); padding: 30px; font-size: 12px; }
.err { color: #f23645; font-size: 11px; padding: 0 16px; }
</style>
