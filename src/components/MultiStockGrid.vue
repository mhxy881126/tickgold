<script setup lang="ts">
import { computed, ref } from "vue";
import MultiCell from "./MultiCell.vue";
import { useWatchlistStore } from "../stores/watchlist";

const emit = defineEmits<{ select: [code: string] }>();
const wl = useWatchlistStore();
const codes = computed(() => wl.codes.slice(0, 9));
const view = ref<"m" | "k" | "o">("m");
</script>

<template>
  <div class="mg">
    <div class="mg-bar">
      <span class="ttl">多股同列</span>
      <div class="tabs">
        <button :class="{ on: view === 'm' }" @click="view = 'm'">分时</button>
        <button :class="{ on: view === 'k' }" @click="view = 'k'">日K</button>
        <button :class="{ on: view === 'o' }" @click="view = 'o'">五档</button>
      </div>
      <span class="hint">点击格子放大 · 点击名称联动个股</span>
    </div>
    <div class="mg-grid">
      <MultiCell
        v-for="c in codes" :key="c" :code="c" :view="view"
        @select="(v) => emit('select', v)"
      />
    </div>
    <div v-if="codes.length === 0" class="empty">自选股为空，请先在榜单 / 搜索中添加股票</div>
  </div>
</template>

<style scoped>
.mg { display:flex;flex-direction:column;height:100%;min-height:0;gap:9px; }
.mg-bar { display:flex;align-items:center;gap:10px;flex-shrink:0; }
.ttl { font-size:13px;font-weight:800; }
.tabs { display:flex;padding:3px;border-radius:10px;background:rgba(0,0,0,.25);border:1px solid var(--border); }
.tabs button { font-size:11px;font-weight:600;color:var(--text-dim);padding:5px 14px;border-radius:8px;border:0;background:transparent;cursor:pointer;transition:.16s; }
.tabs button:hover { color:var(--text); }
.tabs button.on { color:#fff;background:linear-gradient(180deg,#36b8e8,#1d8fc0); }
.hint { margin-left:auto;font-size:10px;color:var(--text-dim); }
.mg-grid { flex:1;min-height:0;display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:1fr;gap:9px; }
.empty { flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:12px; }
</style>
