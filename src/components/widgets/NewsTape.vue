<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { fetchNewsFlash, type NewsItem } from "../../api/market";

// 盘中快讯（binding=none）：30s 轮询，倒序滚动
const items = ref<NewsItem[]>([]);
let timer: number | null = null;
let inflight = false;

function hm(t: string) {
  return t.length >= 16 ? t.substring(11, 16) : t;
}
async function load() {
  if (inflight || document.hidden) return;
  inflight = true;
  try {
    items.value = await fetchNewsFlash(1, 30);
  } catch {
    /* 保留旧数据 */
  } finally {
    inflight = false;
  }
}

onMounted(() => {
  void nextTick(load);
  timer = window.setInterval(load, 30000);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div class="w-news">
    <div class="body">
      <div v-for="n in items" :key="n.id" class="row">
        <span class="tm">{{ hm(n.time) }}</span>
        <span class="tx">{{ n.text }}</span>
      </div>
      <div v-if="!items.length" class="empty">加载快讯…</div>
    </div>
  </div>
</template>

<style scoped>
.w-news { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; }
.body { flex: 1; overflow-y: auto; min-height: 0; padding: 4px 0; }
.row { display: flex; gap: 7px; padding: 3px 10px; font-size: 10px; line-height: 1.45; }
.row:hover { background: rgba(255, 255, 255, .04); }
.tm { color: var(--text-dim); font-variant-numeric: tabular-nums; flex-shrink: 0;
  font-size: 9px; padding-top: 1px; }
.tx { min-width: 0; word-break: break-word; }
.empty { height: 100%; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); font-size: 10px; }
</style>
