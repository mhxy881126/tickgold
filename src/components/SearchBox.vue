<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { searchStocks } from "../api/market";
import type { StockItem } from "../api/types";

const emit = defineEmits<{ select: [code: string, name: string] }>();

const kw = ref("");
const results = ref<StockItem[]>([]);
const showDrop = ref(false);
let timer: number | null = null;
let boxEl: HTMLElement | null = null;

function onInput() {
  if (timer) clearTimeout(timer);
  if (!kw.value.trim()) {
    results.value = [];
    showDrop.value = false;
    return;
  }
  timer = window.setTimeout(async () => {
    try {
      const r = await searchStocks(kw.value.trim());
      results.value = r.slice(0, 12);
      showDrop.value = results.value.length > 0;
    } catch {
      results.value = [];
      showDrop.value = false;
    }
  }, 250);
}

function pick(s: StockItem) {
  emit("select", s.code, s.name);
  kw.value = "";
  results.value = [];
  showDrop.value = false;
}

function onFocus() {
  if (results.value.length) showDrop.value = true;
}

function onDocClick(e: MouseEvent) {
  if (boxEl && !boxEl.contains(e.target as Node)) {
    showDrop.value = false;
  }
}

onMounted(() => document.addEventListener("click", onDocClick));
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div ref="boxEl" class="searchbox">
    <input
      v-model="kw"
      class="input"
      placeholder="搜索代码 / 名称 / 拼音"
      @input="onInput"
      @focus="onFocus"
    />
    <div v-if="showDrop && results.length" class="drop">
      <div
        v-for="s in results"
        :key="s.code"
        class="item"
        @mousedown.prevent="pick(s)"
      >
        <span class="nm">{{ s.name }}</span>
        <span class="cd">{{ s.code }}</span>
        <span class="mkt">{{ s.market }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.searchbox { position: relative; flex: 0 0 220px; }
.input {
  width: 100%; background: var(--bg); border: 1px solid var(--border);
  border-radius: 4px; color: var(--text); padding: 4px 10px; font-size: 12px;
  outline: none;
}
.input:focus { border-color: var(--accent); }
.drop {
  position: absolute; top: 100%; left: 0; right: 0; margin-top: 4px;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 6px;
  max-height: 360px; overflow-y: auto; z-index: 100; box-shadow: 0 8px 24px rgba(0,0,0,.4);
}
.item {
  display: flex; gap: 8px; padding: 7px 10px; cursor: pointer; align-items: center;
}
.item:hover { background: var(--bg-hover); }
.nm { font-weight: 600; flex: 1; }
.cd { color: var(--text-dim); font-size: 11px; }
.mkt { color: var(--text-dim); font-size: 10px; }
</style>
