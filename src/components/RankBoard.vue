<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { fetchRankBoard, type RankScope } from "../api/market";
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

// 榜单仅保留沪深A股范围（北交所 / ETF基金 / 可转债已移除）
const scopes: { k: RankScope; label: string; note: string }[] = [
  { k: "a", label: "沪深 A", note: "" },
];

const tab = ref<TabKey>("gainers");
const scope = ref<RankScope>("a");
const activeScope = computed(() => scopes.find((s) => s.k === scope.value) ?? scopes[0]);
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
    const rows = await fetchRankBoard(tab.value, next, PAGE_SIZE, scope.value);
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
watch(scope, reset);

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
    <div v-if="scopes.length > 1" class="scopes">
      <button
        v-for="s in scopes"
        :key="s.k"
        type="button"
        class="scope"
        :class="{ active: scope === s.k }"
        @click="scope = s.k"
      >
        {{ s.label }}
      </button>
      <span v-if="activeScope.note" class="scope-note">{{ activeScope.note }}</span>
    </div>

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
            <span class="rk" :class="{'rk-gold': index===0, 'rk-silver': index===1, 'rk-bronze': index===2}">{{ index + 1 }}</span>
            <span class="name-cell">
              <span class="nm">{{ list[index]!.name }}</span>
              <span class="code">{{ list[index]!.code }}</span>
              <span
                v-if="scope === 'conv' && list[index]!.convertPremium != null"
                class="conv-tag"
                :class="list[index]!.convertPremium! >= 0 ? 'up' : 'down'"
              >溢{{ list[index]!.convertPremium!.toFixed(1) }}%</span>
            </span>
            <AnimatedNumber tag="span" class="price" :class="signCls(list[index]!.pct)" :value="list[index]!.price" kind="price" />
            <span class="pct-cell">
              <AnimatedNumber tag="span" class="pct" :class="signCls(list[index]!.pct)" :value="list[index]!.pct" kind="pct" />
              <div class="pct-bar" :class="signCls(list[index]!.pct)" :style="{width: Math.min(Math.abs(list[index]!.pct)*10, 100)+'%'}"></div>
            </span>
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
  background: var(--bg-input); border: 1px solid var(--border-ov); border-radius: 6px; overflow: hidden;
}

.scopes {
  flex-shrink: 0; display: flex; align-items: center; gap: 4px;
  padding: 6px 8px; background: var(--bg-input); border-bottom: 1px solid var(--border-ov);
}
.scope {
  padding: 3px 8px; border-radius: 4px; border: 1px solid var(--ov-08);
  background: var(--ov-04); color: #98a3b3; font-size: 11px; cursor: pointer;
}
.scope.active { color: #fff; border-color: var(--accent); background: rgba(212,175,55,.14); }
.scope-note { margin-left: auto; color: #66717f; font-size: 10px; }

/* 顶部密集 Tab：扁平分段式，8 项自动换行 */
.tabs {
  display: flex; flex-wrap: wrap; flex-shrink: 0;
  padding: 8px 8px 4px; gap: 4px;
  border-bottom: 1px solid var(--border-ov); 
  background: linear-gradient(180deg, var(--bg-card2) 0%, var(--bg-hover) 100%);
  min-height: 40px; /* 确保标签页有最小高度 */
}
.tab {
  background: var(--ov-05); 
  border: 1px solid var(--ov-10); 
  border-radius: 8px 8px 0 0; 
  padding: 6px 12px;
  font-size: 12px; color: #a0aab8; cursor: pointer; white-space: nowrap;
  transition: all 0.2s ease;
}
.tab:hover { 
  color: #fff; 
  background: var(--ov-10); 
  border-color: var(--ov-20);
}
.tab.active {
  color: #fff; 
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-color: transparent;
  box-shadow: 0 -2px 10px rgba(102, 126, 234, 0.3);
  font-weight: 600;
}

/* 固定表头 */
.thead-bar {
  flex-shrink: 0; display: flex; align-items: center; gap: 8px;
  padding: 0 10px; height: 28px;
  background: var(--bg-input); border-bottom: 1px solid var(--border-ov);
  color: #6b7686; font-size: 11px;
}

/* 列宽（与 .vrow 完全一致，保证对齐） */
.h-rk     { width: 34px; flex-shrink: 0; }
.h-name   { flex: 1; min-width: 0; }
.h-price  { width: 62px; flex-shrink: 0; text-align: right; }
.h-pct    { width: 90px; flex-shrink: 0; text-align: right; }
.h-metric { width: 78px; flex-shrink: 0; text-align: right; }
.h-watch  { width: 26px; flex-shrink: 0; text-align: center; }

.scroll { flex: 1; overflow-y: auto; min-height: 0; position: relative; }
.vholder { position: relative; width: 100%; }
.vwindow { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }

/* 30px 密集行：细横线分隔，hover 提亮，选中色靠交互 */
.vrow {
  display: flex; align-items: center; gap: 8px;
  height: 30px; padding: 0 10px; cursor: pointer;
  border-bottom: 1px solid var(--border-ov);
  font-variant-numeric: tabular-nums;
}
.vrow:hover { background: var(--ov-04); }

.rk {
  width: 34px; flex-shrink: 0; text-align: left;
  font-size: 11px; color: var(--text-dim); font-weight: 600;
}
.rk-gold   { color: #ffd700; }
.rk-silver { color: #c0c0c0; }
.rk-bronze { color: #cd7f32; }

/* 名称 + 代码（min-width:0 + ellipsis） */
.name-cell { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; }
.nm {
  font-size: 12px; color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.code { flex-shrink: 0; font-size: 10px; color: var(--text-dim); }
.conv-tag { flex-shrink: 0; font-size: 10px; font-weight: 600; padding: 0 4px; border-radius: 3px; background: var(--ov-05); }

.price { width: 62px; flex-shrink: 0; text-align: right; font-size: 12px; }
.pct-cell { width: 90px; flex-shrink: 0; text-align: right; position: relative; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.pct   { font-size: 12px; font-weight: 600; }
.pct-bar { position: absolute; left: 0; top: 50%; transform: translateY(-50%); height: 14px; border-radius: 2px; opacity: 0.25; z-index: 0; }
.pct-bar.up   { background: var(--up); }
.pct-bar.down { background: #08db98; }
.metric { width: 78px; flex-shrink: 0; text-align: right; font-size: 12px; }

/* 涨跌色：涨红 / 跌绿 / 平灰 */
.up      { color: var(--up); }
.down    { color: #08db98; }
.flat    { color: var(--text-dim); }
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
.watch-btn:hover { color: var(--text-dim); background: var(--ov-06); }
.watched { color: #3ba776; font-size: 11px; font-weight: 700; }

.empty-state {
  display: flex; align-items: center; justify-content: center;
  min-height: 160px; color: #6b7686; font-size: 12px; text-align: center; padding: 0 20px;
}
.empty-state .err { color: var(--up); font-size: 11px; }
.foot-row {
  display: flex; align-items: center; justify-content: center;
  min-height: 30px; font-size: 11px; color: #6b7686;
}
.foot-row .spin {
  display: inline-block; width: 11px; height: 11px; margin-right: 6px;
  border: 2px solid var(--border-ov); border-top-color: var(--accent); border-radius: 50%;
  vertical-align: -1px; animation: r .8s linear infinite;
}
@keyframes r { to { transform: rotate(360deg); } }
</style>
