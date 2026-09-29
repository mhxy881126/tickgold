<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { fetchRankBoard } from "../api/market";
import { useWatchlistStore } from "../stores/watchlist";
import { useVirtualList } from "../composables/useVirtualList";
import type { RankRow } from "../api/types";
import AnimatedNumber from "./common/AnimatedNumber.vue";

const emit = defineEmits<{ select: [code: string]; add: [code: string, name: string] }>();

// 指标列的取值与着色类型
type MetricKind = "amount" | "pct" | "money" | "ratio";
type TabKey =
  | "gainers" | "losers" | "amount" | "speed"
  | "big" | "vr" | "turnover" | "main";

interface TabDef {
  k: TabKey;
  label: string;
  metric: keyof RankRow;
  metricLabel: string;
  kind: MetricKind;
}

const tabs: TabDef[] = [
  { k: "gainers",  label: "涨幅",     metric: "amount",      metricLabel: "成交额",   kind: "amount" },
  { k: "losers",   label: "跌幅",     metric: "amount",      metricLabel: "成交额",   kind: "amount" },
  { k: "amount",   label: "成交额",   metric: "amount",      metricLabel: "成交额",   kind: "amount" },
  { k: "speed",    label: "快速涨幅", metric: "speed5",      metricLabel: "5分钟涨速", kind: "pct" },
  { k: "big",      label: "大单净量", metric: "bigNet",      metricLabel: "大单净量",  kind: "money" },
  { k: "vr",       label: "量比榜",   metric: "volumeRatio", metricLabel: "量比",     kind: "ratio" },
  { k: "turnover", label: "换手率",   metric: "turnover",    metricLabel: "换手率",   kind: "pct" },
  { k: "main",     label: "主力净流入", metric: "mainNet",    metricLabel: "主力净流入", kind: "money" },
];

const tab = ref<TabKey>("gainers");
const activeTab = computed(() => tabs.find((t) => t.k === tab.value) ?? tabs[0]);
const list = ref<RankRow[]>([]);
const page = ref(0);
const PAGE_SIZE = 50;
const loading = ref(false);
const hasMore = ref(true);
const errorMsg = ref("");
const wl = useWatchlistStore();

// ===== 虚拟滚动：专业终端密集行高 30px =====
const ROW_H = 30;
const {
  totalHeight: totalH, visibleItems: visibleRows, startOffset: offsetY,
  onScroll: onVirtualScroll, measure: measureScroll,
} = useVirtualList({ itemCount: computed(() => list.value.length), itemHeight: ROW_H, overscan: 10 });

async function loadMore() {
  if (loading.value || !hasMore.value) return;
  loading.value = true;
  errorMsg.value = "";
  const next = page.value + 1;
  try {
    const rows = await fetchRankBoard(tab.value, next, PAGE_SIZE);
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

const scrollEl = ref<HTMLElement | null>(null);

function reset() {
  list.value = [];
  page.value = 0;
  hasMore.value = true;
  errorMsg.value = "";
  loading.value = false;
  if (scrollEl.value) scrollEl.value.scrollTop = 0;
  loadMore();
}
watch(tab, reset);
onMounted(() => {
  measureScroll(scrollEl.value);
  reset();
});

function onScroll(e: Event) {
  const el = e.target as HTMLElement;
  onVirtualScroll.call(el);
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) loadMore();
}

function isWatched(code: string) {
  return wl.codes.includes(code);
}
function addOne(q: RankRow) {
  if (!isWatched(q.code)) wl.add(q.code, q.name);
}

// 涨跌色：>0 红、<0 绿、=0 灰
function signCls(n: number) {
  return n > 0.001 ? "up" : n < -0.001 ? "down" : "flat";
}
// 动态指标列对应的数字动画类型
const metricAnimKind = computed<"pct" | "money" | "amount" | "raw">(() => {
  const k = activeTab.value.kind;
  return k === "pct" ? "pct" : k === "money" ? "money" : k === "ratio" ? "raw" : "amount";
});
// 动态指标列着色：带符号的（涨速/大单/主力）随正负着色，成交额/量比/换手为中性
function metricCls(q: RankRow) {
  const v = q[activeTab.value.metric] as number;
  return activeTab.value.kind === "amount" || activeTab.value.kind === "ratio"
    ? "neutral"
    : signCls(v);
}
</script>

<template>
  <div class="rank">
    <!-- 顶部密集 Tab（8 项，自动换行） -->
    <div class="tabs">
      <button
        v-for="t in tabs"
        :key="t.k"
        type="button"
        class="tab"
        :class="{ active: tab === t.k }"
        @click="tab = t.k"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- 固定表头：列与行严格对齐 -->
    <div class="thead-bar">
      <span class="h-rk">#</span>
      <span class="h-name">名称</span>
      <span class="h-price">最新</span>
      <span class="h-pct">涨跌幅</span>
      <span class="h-metric">{{ activeTab.metricLabel }}</span>
      <span class="h-watch" title="自选">自选</span>
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
          <div
            v-for="{ index } in visibleRows"
            :key="list[index]?.code"
            class="vrow"
            :style="{ height: ROW_H + 'px' }"
            @click="emit('select', list[index]!.code)"
          >
            <span class="rk">{{ index + 1 }}</span>
            <span class="name-cell">
              <span class="nm">{{ list[index]!.name }}</span>
              <span class="code">{{ list[index]!.code }}</span>
            </span>
            <AnimatedNumber tag="span" class="price" :class="signCls(list[index]!.pct)" :value="list[index]!.price" kind="price" />
            <AnimatedNumber tag="span" class="pct" :class="signCls(list[index]!.pct)" :value="list[index]!.pct" kind="pct" />
            <AnimatedNumber
              tag="span"
              class="metric"
              :class="metricCls(list[index]!)"
              :value="(list[index]![activeTab.metric] as number)"
              :kind="metricAnimKind"
              :decimals="activeTab.kind === 'pct' ? 2 : activeTab.kind === 'ratio' ? 2 : 2"
              :flash="activeTab.kind === 'pct' || activeTab.kind === 'money'"
            />
            <span class="watch">
              <button
                v-if="!isWatched(list[index]!.code)"
                type="button"
                class="watch-btn"
                title="加入自选"
                @click.stop="addOne(list[index]!)"
              >+</button>
              <span v-else class="watched" title="已在自选">✓</span>
            </span>
          </div>
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
/* ===== 主题①：专业深色终端 · 密集表格 ===== */
.rank {
  display: flex; flex-direction: column; height: 100%;
  background: #0b0e14; border: 1px solid #1b2230; border-radius: 6px; overflow: hidden;
}

/* 顶部密集 Tab：扁平分段式，8 项自动换行 */
.tabs {
  display: flex; flex-wrap: wrap; flex-shrink: 0;
  padding: 4px 6px 0; gap: 2px;
  border-bottom: 1px solid #1b2230; background: #0e121b;
}
.tab {
  background: transparent; border: 1px solid transparent; border-bottom: none;
  border-radius: 4px 4px 0 0; padding: 5px 10px;
  font-size: 12px; color: #7d8896; cursor: pointer; white-space: nowrap;
}
.tab:hover { color: #c7d0dc; background: rgba(255, 255, 255, .03); }
.tab.active {
  color: #f0f4fa; background: #0b0e14;
  border-color: #1b2230; box-shadow: inset 0 2px 0 #d4af37;
}

/* 固定表头 */
.thead-bar {
  flex-shrink: 0; display: flex; align-items: center; gap: 8px;
  padding: 0 10px; height: 28px;
  background: #0e121b; border-bottom: 1px solid #1b2230;
  color: #6b7686; font-size: 11px;
}

/* 列宽（与 .vrow 完全一致，保证对齐） */
.h-rk     { width: 34px; flex-shrink: 0; }
.h-name   { flex: 1; min-width: 0; }
.h-price  { width: 62px; flex-shrink: 0; text-align: right; }
.h-pct    { width: 66px; flex-shrink: 0; text-align: right; }
.h-metric { width: 78px; flex-shrink: 0; text-align: right; }
.h-watch  { width: 26px; flex-shrink: 0; text-align: center; }

.scroll { flex: 1; overflow-y: auto; min-height: 0; position: relative; }
.vholder { position: relative; width: 100%; }
.vwindow { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }

/* 30px 密集行：细横线分隔，hover 提亮，选中色靠交互 */
.vrow {
  display: flex; align-items: center; gap: 8px;
  height: 30px; padding: 0 10px; cursor: pointer;
  border-bottom: 1px solid #141a25;
  font-variant-numeric: tabular-nums;
}
.vrow:hover { background: rgba(255, 255, 255, .035); }

.rk {
  width: 34px; flex-shrink: 0; text-align: left;
  font-size: 11px; color: #5d6878;
}

/* 名称 + 代码（min-width:0 + ellipsis） */
.name-cell { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; }
.nm {
  font-size: 12px; color: #d7dee8;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.code { flex-shrink: 0; font-size: 10px; color: #5d6878; }

.price { width: 62px; flex-shrink: 0; text-align: right; font-size: 12px; }
.pct   { width: 66px; flex-shrink: 0; text-align: right; font-size: 12px; font-weight: 600; }
.metric { width: 78px; flex-shrink: 0; text-align: right; font-size: 12px; }

/* 涨跌色：涨红 / 跌绿 / 平灰 */
.up      { color: #f23645; }
.down    { color: #08db98; }
.flat    { color: #8b97a8; }
.neutral { color: #c3ccd8; }

/* 弱化的加自选 */
.watch {
  width: 26px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
}
.watch-btn {
  width: 20px; height: 20px; border-radius: 4px;
  background: transparent; border: 1px solid transparent;
  color: #6b7686; font-size: 14px; line-height: 1; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
}
.watch-btn:hover { color: #e6edf3; background: rgba(255, 255, 255, .06); }
.watched { color: #3ba776; font-size: 11px; font-weight: 700; }

.empty-state {
  display: flex; align-items: center; justify-content: center;
  min-height: 160px; color: #6b7686; font-size: 12px; text-align: center; padding: 0 20px;
}
.empty-state .err { color: #f23645; font-size: 11px; }
.foot-row {
  display: flex; align-items: center; justify-content: center;
  min-height: 30px; font-size: 11px; color: #6b7686;
}
.foot-row .spin {
  display: inline-block; width: 11px; height: 11px; margin-right: 6px;
  border: 2px solid #2a313d; border-top-color: #d4af37; border-radius: 50%;
  vertical-align: -1px; animation: r .8s linear infinite;
}
@keyframes r { to { transform: rotate(360deg); } }
</style>
