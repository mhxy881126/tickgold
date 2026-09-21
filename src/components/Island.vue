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
  await win.setSize(new LogicalSize(320, h));
}

function pick(q: Quote) {
  const i = quotes.value.findIndex((x) => x.code === q.code);
  if (i >= 0) idx.value = i;
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
    <!-- 折叠态：金色奢华 -->
    <div v-if="!expanded" class="bar" data-tauri-drag-region>
      <template v-if="current">
        <div class="icon" data-tauri-drag-region>⚡</div>
        <div class="nm" data-tauri-drag-region>{{ current.name }}</div>
        <div class="px" :class="cls(current.pct)" data-tauri-drag-region>{{ current.price.toFixed(2) }}</div>
        <div class="pct" :class="cls(current.pct)" data-tauri-drag-region>
          {{ current.pct > 0 ? "+" : "" }}{{ current.pct.toFixed(2) }}%
        </div>
        <button class="chev" title="展开" @click="toggleExpand">⌄</button>
      </template>
      <div v-else class="loading" data-tauri-drag-region>加载中…</div>
    </div>

    <!-- 展开态：金色通知列表 -->
    <div v-else class="open-wrap">
      <div class="open-head" data-tauri-drag-region>
        <span class="head-title">
          <span class="head-icon">⚡</span>
          智能异动提醒
        </span>
        <span class="head-count">{{ quotes.length }} 只</span>
      </div>
      <div class="open-list">
        <div
          v-for="q in quotes"
          :key="q.code"
          class="row"
          :class="{ active: current && q.code === current.code }"
          @click="pick(q)"
        >
          <span class="arrow" :class="cls(q.pct)">{{ q.pct > 0 ? "↑" : "↓" }}</span>
          <span class="rnm">{{ q.name }}</span>
          <span class="rpct" :class="cls(q.pct)">{{ q.pct > 0 ? "+" : "" }}{{ q.pct.toFixed(2) }}%</span>
        </div>
        <div v-if="quotes.length === 0" class="empty">主窗口添加自选股</div>
      </div>
    </div>
  </div>
</template>

<style>
html, body { background: transparent !important; }
</style>

<style scoped>
.island {
  height: 100%;
  font-size: 13px;
  color: #e6edf3;
  user-select: none;
}

/* 折叠态：金色奢华 + 脉冲动画 */
.bar {
  height: 52px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  background: linear-gradient(135deg, #1a1500 0%, #2a2000 100%);
  border: 1px solid #ffd700;
  border-radius: 999px;
  animation: pulse-gold 2s ease-in-out infinite;
}
@keyframes pulse-gold {
  0%, 100% { box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
  50% { box-shadow: 0 4px 30px rgba(255, 215, 0, 0.3); }
}

.icon {
  width: 22px;
  height: 22px;
  background: linear-gradient(135deg, #ffd700, #ffaa00);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #000;
  font-weight: 700;
}

.nm { font-weight: 600; max-width: 90px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: #ffd700; }
.px { font-variant-numeric: tabular-nums; font-weight: 600; }
.pct { font-variant-numeric: tabular-nums; margin-left: auto; font-weight: 600; }
.chev {
  background: transparent; border: none; color: #ffd700;
  font-size: 16px; cursor: pointer; padding: 2px 4px; line-height: 1;
}
.chev:hover { color: #ffaa00; }
.loading { color: #ffd700; width: 100%; text-align: center; }

/* 展开态：金色通知卡片 */
.open-wrap {
  height: 300px;
  display: flex; flex-direction: column;
  background: linear-gradient(135deg, #1a1500 0%, #2a2000 100%);
  border: 1px solid #ffd700;
  border-radius: 28px;
  overflow: hidden;
}
.open-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px;
}
.head-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #ffd700;
}
.head-icon {
  width: 20px;
  height: 20px;
  background: linear-gradient(135deg, #ffd700, #ffaa00);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: #000;
  font-weight: 700;
}
.head-count {
  background: linear-gradient(135deg, #ffd700, #ffaa00);
  color: #000;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
}
.open-list { flex: 1; overflow-y: auto; }
.row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 16px; cursor: pointer;
}
.row:hover { background: rgba(255, 215, 0, 0.08); }
.row.active { background: rgba(255, 215, 0, 0.15); }
.arrow { font-size: 12px; width: 16px; text-align: center; }
.rnm { max-width: 110px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rpct { font-variant-numeric: tabular-nums; margin-left: auto; width: 72px; text-align: right; }
.empty { text-align: center; color: #ffd700; padding: 30px 10px; font-size: 12px; }

.up { color: #ef5350; }
.down { color: #26a69a; }
.flat { color: #8b98a5; }
</style>
