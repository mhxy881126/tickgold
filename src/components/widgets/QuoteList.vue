<script setup lang="ts">
import { computed } from "vue";
import { useQuotesStore } from "../../stores/quotes";
import { useMarketContext } from "../../composables/useMarketContext";
import AnimatedNumber from "../common/AnimatedNumber.vue";

// 行情列表：全部自选按涨跌幅排序，点击切换主标的
const quotes = useQuotesStore();
const ctx = useMarketContext();
const rows = computed(() => quotes.sortedByPct());
</script>

<template>
  <div class="w-list">
    <div class="head">
      <span class="nm">名称</span>
      <span class="pr">最新</span>
      <span class="pc">涨跌幅</span>
    </div>
    <div class="body">
      <div
        v-for="q in rows"
        :key="q.code"
        class="row"
        :class="{ on: ctx.primaryCode.value === q.code }"
        @click="ctx.select(q.code)"
      >
        <span class="nm"><b>{{ q.name }}</b><em>{{ q.code }}</em></span>
        <span class="pr"><AnimatedNumber :value="q.price" kind="price" :flash="false" /></span>
        <span class="pc" :class="q.pct >= 0 ? 'up' : 'down'">
          <AnimatedNumber :value="q.pct" kind="pct" />
        </span>
      </div>
      <div v-if="!rows.length" class="empty">暂无自选</div>
    </div>
  </div>
</template>

<style scoped>
.w-list { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; }
.head, .row { display: grid; grid-template-columns: 1fr 64px 64px; align-items: center;
  gap: 6px; padding: 0 10px; }
.head { height: 22px; flex-shrink: 0; font-size: 9.5px; color: var(--text-dim);
  border-bottom: 1px solid var(--border); }
.head .pr, .head .pc { text-align: right; }
.body { flex: 1; overflow-y: auto; min-height: 0; }
.row { height: 24px; font-size: 10.5px; cursor: pointer; }
.row:hover { background: rgba(255, 255, 255, .04); }
.row.on { background: rgba(232, 198, 106, .1); }
.nm { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.nm b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nm em { font-style: normal; font-size: 9px; color: var(--text-dim); flex-shrink: 0; }
.pr, .pc { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.empty { height: 100%; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); font-size: 10px; }
.up { color: #f23645; } .down { color: #08db94; }
</style>
