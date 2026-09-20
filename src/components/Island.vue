<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { emit } from "@tauri-apps/api/event";
import { fetchQuotes } from "../api/market";
import { useWatchlistStore } from "../stores/watchlist";
import type { Quote } from "../api/types";

const wl = useWatchlistStore();
const win = getCurrentWindow();

const quotes = ref<Quote[]>([]);
const idx = ref(0);
const expanded = ref(false);
let pollTimer: number | null = null;
let rotateTimer: number | null = null;

const current = computed(() => quotes.value[idx.value] ?? null);

function cls(pct: number) {
  if (pct > 0) return "up";
  if (pct < 0) return "down";
  return "flat";
}

async function refresh() {
  const list = await fetchQuotes(wl.codes);
  quotes.value = list.sort((a, b) => b.pct - a.pct);
  if (idx.value >= quotes.value.length) idx.value = 0;
}

function rotate() {
  if (quotes.value.length > 1 && !expanded.value) {
    idx.value = (idx.value + 1) % quotes.value.length;
  }
}

async function toggleExpand() {
  expanded.value = !expanded.value;
  const h = expanded.value ? 300 : 52;
  await win.setSize(new LogicalSize(300, h));
}

function pick(q: Quote) {
  const i = quotes.value.findIndex((x) => x.code === q.code);
  if (i >= 0) idx.value = i;
  // 通知主窗口打开该股票
  emit("island:select", q.code);
  if (expanded.value) toggleExpand();
}

onMounted(async () => {
  await wl.load();
  refresh();
  pollTimer = window.setInterval(refresh, 3000);
  rotateTimer = window.setInterval(rotate, 3000);
});
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (rotateTimer) clearInterval(rotateTimer);
});
</script>

<template>
  <div class="island" :class="{ open: expanded }">
    <!-- 折叠态：单只轮播 -->
    <div v-if="!expanded" class="bar" data-tauri-drag-region>
      <template v-if="current">
        <div class="nm" data-tauri-drag-region>{{ current.name }}</div>
        <div class="px" :class="cls(current.pct)" data-tauri-drag-region>{{ current.price.toFixed(2) }}</div>
        <div class="pct" :class="cls(current.pct)" data-tauri-drag-region>
          {{ current.pct > 0 ? "+" : "" }}{{ current.pct.toFixed(2) }}%
        </div>
        <button class="chev" title="展开" @click="toggleExpand">⌄</button>
      </template>
      <div v-else class="loading" data-tauri-drag-region>加载中…</div>
    </div>

    <!-- 展开态：自选股列表 -->
    <div v-else class="open-wrap">
      <div class="open-head" data-tauri-drag-region>
        <span>自选 · {{ quotes.length }}</span>
        <button class="chev up" title="收起" @click="toggleExpand">⌃</button>
      </div>
      <div class="open-list">
        <div
          v-for="q in quotes"
          :key="q.code"
          class="row"
          :class="{ active: current && q.code === current.code }"
          @click="pick(q)"
        >
          <span class="rnm">{{ q.name }}</span>
          <span class="rpx" :class="cls(q.pct)">{{ q.price.toFixed(2) }}</span>
          <span class="rpct" :class="cls(q.pct)">{{ q.pct > 0 ? "+" : "" }}{{ q.pct.toFixed(2) }}%</span>
        </div>
        <div v-if="quotes.length === 0" class="empty">主窗口添加自选股</div>
      </div>
    </div>
  </div>
</template>

<style>
/* 透明窗口：island 挂载时覆盖 global.css 的深色 body */
html, body { background: transparent !important; }
</style>

<style scoped>
.island {
  height: 100%;
  font-size: 13px;
  color: #e6edf3;
  user-select: none;
}
/* 毛玻璃圆角条 */
.bar {
  height: 52px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  background: rgba(22, 27, 34, 0.82);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
}
.nm { font-weight: 600; max-width: 96px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.px { font-variant-numeric: tabular-nums; font-weight: 600; }
.pct { font-variant-numeric: tabular-nums; margin-left: auto; font-weight: 600; }
.chev {
  background: transparent; border: none; color: #8b98a5;
  font-size: 16px; cursor: pointer; padding: 2px 4px; line-height: 1;
}
.chev:hover { color: #e6edf3; }
.chev.up { font-size: 15px; }
.loading { color: #8b98a5; width: 100%; text-align: center; }

.open-wrap {
  height: 300px;
  display: flex; flex-direction: column;
  background: rgba(22, 27, 34, 0.92);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  overflow: hidden;
}
.open-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; color: #8b98a5; font-size: 12px;
}
.open-list { flex: 1; overflow-y: auto; }
.row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; cursor: pointer;
}
.row:hover { background: rgba(255, 255, 255, 0.05); }
.row.active { background: rgba(59, 130, 246, 0.15); }
.rnm { max-width: 110px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rpx { font-variant-numeric: tabular-nums; margin-left: auto; }
.rpct { font-variant-numeric: tabular-nums; width: 72px; text-align: right; }
.empty { text-align: center; color: #8b98a5; padding: 30px 10px; font-size: 12px; }

.up { color: #f23645; }
.down { color: #089981; }
.flat { color: #8b98a5; }
</style>
