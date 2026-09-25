<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
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

// ===== 虚拟滚动（固定行高，仅渲染可视区 + 上下缓冲，5000+ 行也只挂约 30 个 DOM）=====
const ROW_H = 30;
const BUFFER = 8;
const scrollEl = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewH = ref(400);

const startIdx = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / ROW_H) - BUFFER)
);
const endIdx = computed(() =>
  Math.min(
    list.value.length,
    Math.ceil((scrollTop.value + viewH.value) / ROW_H) + BUFFER
  )
);
const visibleRows = computed(() =>
  list.value.slice(startIdx.value, endIdx.value).map((q, k) => ({
    q,
    i: startIdx.value + k,
  }))
);
const totalH = computed(() => list.value.length * ROW_H);
const offsetY = computed(() => startIdx.value * ROW_H);

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
  scrollTop.value = 0;
  if (scrollEl.value) scrollEl.value.scrollTop = 0;
  loadMore();
}
watch(tab, reset);
onMounted(() => {
  viewH.value = scrollEl.value?.clientHeight ?? 400;
  reset();
});

function onScroll(e: Event) {
  const el = e.target as HTMLElement;
  scrollTop.value = el.scrollTop;
  viewH.value = el.clientHeight;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) loadMore();
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

    <!-- 固定表头（不参与虚拟滚动） -->
    <div class="thead-bar">
      <table>
        <colgroup>
          <col style="width: 8%">
          <col style="width: 33%">
          <col style="width: 17%">
          <col style="width: 16%">
          <col style="width: 15%">
          <col style="width: 11%">
        </colgroup>
        <thead>
          <tr><th>#</th><th>名称</th><th class="r">最新</th><th class="r">涨跌幅</th><th class="r">成交额</th><th class="c">自选</th></tr>
        </thead>
      </table>
    </div>

    <div class="scroll" ref="scrollEl" @scroll="onScroll">
      <!-- 空 / 错误占位 -->
      <div v-if="list.length === 0 && (errorMsg || !loading)" class="empty-state">
        <span v-if="errorMsg" class="err">{{ errorMsg }}</span>
        <span v-else>暂无数据</span>
      </div>

      <!-- 虚拟滚动主体 -->
      <div class="vholder" :style="{ height: totalH + 'px' }">
        <div class="vwindow" :style="{ transform: `translateY(${offsetY}px)` }">
          <table>
            <colgroup>
              <col style="width: 8%">
              <col style="width: 33%">
              <col style="width: 17%">
              <col style="width: 16%">
              <col style="width: 15%">
              <col style="width: 11%">
            </colgroup>
            <tbody>
              <tr
                v-for="{ q, i } in visibleRows"
                :key="q.code"
                :style="{ height: ROW_H + 'px' }"
                @click="emit('select', q.code)"
              >
                <td class="idx">{{ i + 1 }}</td>
                <td class="stock-cell">
                  <span class="nm">{{ q.name }}</span>
                  <span class="cd">{{ q.code }}</span>
                </td>
                <td class="r" :class="cls(q.pct)">{{ fmt(q.price) }}</td>
                <td class="r" :class="cls(q.pct)">{{ q.pct > 0 ? "+" : "" }}{{ fmt(q.pct) }}%</td>
                <td class="r dim">{{ amtSmart(q.amount) }}</td>
                <td class="c act">
                  <button
                    v-if="!isWatched(q.code)"
                    class="add-btn"
                    title="加入自选"
                    @click.stop="addOne(q)"
                  >+</button>
                  <span v-else class="added" title="已在自选">✓</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 底部状态行 -->
      <div class="foot-row">
        <span v-if="loading"><span class="spin"></span>正在加载更多…</span>
        <span v-else-if="!hasMore && list.length > 0" class="dim">已加载全部 {{ list.length }} 只股票</span>
      </div>
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

.thead-bar { flex-shrink: 0; border-bottom: 1px solid var(--border); }
.thead-bar table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.thead-bar th {
  text-align: left; color: var(--text-dim); font-weight: 500;
  padding: 0 8px; height: 30px;
  font-size: 11px; background: var(--bg-panel);
}
.thead-bar th.r { text-align: right; }
.thead-bar th.c { text-align: center; }

.scroll { flex: 1; overflow-y: auto; min-height: 0; position: relative; }
.vholder { position: relative; width: 100%; }
.vwindow { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }
.vwindow table { width: 100%; border-collapse: collapse; table-layout: fixed; }

th.r, td.r { text-align: right; }
tbody tr { cursor: pointer; height: 30px; }
tbody tr:hover { background: var(--bg-hover); }
td {
  padding: 0 8px; height: 30px; border-bottom: 1px solid #1b2129;
  font-size: 12px; white-space: nowrap; overflow: hidden;
}
.idx { color: var(--text-dim); width: 22px; font-size: 11px; }
.stock-cell { display: flex; align-items: center; gap: 5px; overflow: hidden; }
.nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cd { font-size: 10px; color: var(--text-dim); flex-shrink: 0; }
.dim { color: var(--text-dim); }
th.c, td.c { text-align: center; }
.act { padding-left: 4px; padding-right: 4px; }
.add-btn {
  width: 20px; height: 20px; border-radius: 5px; cursor: pointer;
  border: 1px solid rgba(212,175,55,.55); background: rgba(212,175,55,.12);
  color: #e8c66a; font-size: 14px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
}
.add-btn:hover { background: #d4af37; border-color: #d4af37; color: #1a1a1a; }
.added { color: #3ba776; font-size: 12px; font-weight: 700; }

.empty-state {
  display: flex; align-items: center; justify-content: center;
  min-height: 160px; color: var(--text-dim); font-size: 12px; text-align: center; padding: 0 20px;
}
.empty-state .err { color: #f23645; font-size: 11px; }
.foot-row {
  display: flex; align-items: center; justify-content: center;
  min-height: 34px; font-size: 11px; color: var(--text-dim);
}
.foot-row .spin {
  display: inline-block; width: 11px; height: 11px; margin-right: 6px;
  border: 2px solid #333; border-top-color: #d4af37; border-radius: 50%;
  vertical-align: -1px; animation: r .8s linear infinite;
}
@keyframes r { to { transform: rotate(360deg); } }
</style>
