<script setup lang="ts">
import { ref, computed } from "vue";
import { fetchSectors } from "../api/market";
import type { Sector } from "../api/types";
import { useSmartPolling } from "../composables/useSmartPolling";

const emit = defineEmits<{ (e: "select", code: string): void }>();

type Kind = "industry" | "concept";
const kind = ref<Kind>("industry");
const loading = ref(true);
const error = ref("");
const cache = ref<Record<Kind, Sector[]>>({ industry: [], concept: [] });

// 排序
const sortKey = ref<"changePct" | "netAmount">("changePct");
const sortAsc = ref(false);

const list = computed<Sector[]>(() => {
  const arr = [...(cache.value[kind.value] || [])];
  arr.sort((a, b) => {
    const r = a[sortKey.value] - b[sortKey.value];
    return sortAsc.value ? r : -r;
  });
  return arr;
});

function setSort(k: "changePct" | "netAmount") {
  if (sortKey.value === k) sortAsc.value = !sortAsc.value;
  else {
    sortKey.value = k;
    sortAsc.value = false;
  }
}

async function load(showLoading = true) {
  if (showLoading) loading.value = true;
  error.value = "";
  try {
    cache.value[kind.value] = await fetchSectors(kind.value);
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

function switchKind(k: Kind) {
  kind.value = k;
  if (cache.value[k].length === 0) load();
}

function pickLead(s: Sector) {
  // leadCode 形如 sh603268 -> 603268
  if (s.leadCode.length >= 8) emit("select", s.leadCode.slice(2));
}

function yi(n: number): string {
  return (n / 1e8).toFixed(2);
}
function pctText(n: number): string {
  return (n > 0 ? "+" : "") + n.toFixed(2);
}
function arrow(k: "changePct" | "netAmount"): string {
  if (sortKey.value !== k) return "";
  return sortAsc.value ? "▲" : "▼";
}

// 智能轮询：仅在卡片可见 / 在线 / 非聚焦后台时静默刷新，断网、最小化自动暂停，恢复即刷新
useSmartPolling(() => load(false), { interval: 10000, cardId: "sector" });
</script>

<template>
  <div class="sector">
    <!-- Tab + 排序 -->
    <div class="toolbar">
      <div class="tabs">
        <button :class="{ on: kind === 'industry' }" @click="switchKind('industry')">行业板块</button>
        <button :class="{ on: kind === 'concept' }" @click="switchKind('concept')">概念板块</button>
      </div>
      <div class="sort">
        <button :class="{ on: sortKey === 'changePct' }" @click="setSort('changePct')">
          涨跌幅{{ arrow('changePct') }}
        </button>
        <button :class="{ on: sortKey === 'netAmount' }" @click="setSort('netAmount')">
          净流入{{ arrow('netAmount') }}
        </button>
      </div>
    </div>

    <!-- 表头 -->
    <div class="thead">
      <div class="c-name">板块</div>
      <div class="c-pct">涨跌幅</div>
      <div class="c-net">净流入(亿)</div>
      <div class="c-lead">领涨股</div>
    </div>

    <!-- 列表 -->
    <div class="tbody">
      <div v-if="loading" class="hint">加载中…</div>
      <div v-else-if="error" class="hint err">板块加载失败：{{ error }}</div>
      <div v-else-if="list.length === 0" class="hint">暂无数据</div>
      <div v-for="s in list" :key="s.code" class="trow">
        <div class="c-name">{{ s.name }}</div>
        <div class="c-pct" :class="s.changePct > 0 ? 'up' : s.changePct < 0 ? 'down' : ''">
          {{ pctText(s.changePct) }}%
        </div>
        <div class="c-net" :class="s.netAmount > 0 ? 'up' : s.netAmount < 0 ? 'down' : ''">
          {{ s.netAmount >= 0 ? '+' : '' }}{{ yi(s.netAmount) }}
        </div>
        <div class="c-lead" @click="pickLead(s)">
          <span class="lead-name">{{ s.leadName }}</span>
          <span class="lead-pct" :class="s.leadPct > 0 ? 'up' : 'down'">
            {{ pctText(s.leadPct) }}%
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sector {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 8px 10px 10px;
  overflow: hidden;
}

/* 工具栏 */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.tabs,
.sort {
  display: flex;
  gap: 4px;
}
.toolbar button {
  background: transparent;
  border: 1px solid #2a323d;
  color: var(--text-dim);
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 5px;
  cursor: pointer;
}
.toolbar button.on {
  background: rgba(53, 196, 168, 0.14);
  border-color: #35c4a8;
  color: #4fd6bb;
}

/* 表头 / 行 共用列 */
.thead,
.trow {
  display: grid;
  grid-template-columns: 24% 17% 21% 38%;
  align-items: center;
}
.thead {
  font-size: 10px;
  color: var(--text-dim);
  padding: 4px 6px;
  border-bottom: 1px solid #232b34;
}
.tbody {
  flex: 1;
  overflow-y: auto;
}
.trow {
  font-size: 11.5px;
  padding: 4px 6px;
  border-bottom: 1px solid #1b222a;
}
.trow:hover {
  background: rgba(255, 255, 255, 0.03);
}
.c-pct,
.c-net {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.c-lead {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.lead-name {
  font-size: 11px;
}
.lead-pct {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.c-lead:hover .lead-name {
  color: #4fd6bb;
}

.hint {
  padding: 30px 0;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
}
.hint.err {
  color: #e0556b;
}

.up {
  color: #ef5350;
}
.down {
  color: #26a69a;
}
</style>
