<script setup lang="ts">
import { nextTick, onMounted, watch, toRef } from "vue";
import { useWidgetData } from "../../composables/useMarketContext";

// 五档盘口（singleton）
const props = defineProps<{ bind?: string | null }>();
const d = useWidgetData(toRef(props, "bind"));

async function refresh() {
  await d.ensure("ob");
}
onMounted(() => nextTick(refresh));
watch(() => d.code.value, () => nextTick(refresh));
</script>

<template>
  <div class="w-ob">
    <template v-if="d.ob.value">
      <div class="rows">
        <div
          v-for="(a, i) in d.ob.value.asks.slice(0, 5).reverse()"
          :key="'a' + i"
          class="row s"
        >
          <span class="lb">卖{{ d.ob.value.asks.slice(0, 5).length - i }}</span>
          <span class="pr">{{ a.price.toFixed(2) }}</span>
          <span class="vl">{{ a.vol }}</span>
        </div>
        <div class="mid">现价 {{ d.ob.value.price.toFixed(2) }}</div>
        <div
          v-for="(b, i) in d.ob.value.bids.slice(0, 5)"
          :key="'b' + i"
          class="row b"
        >
          <span class="lb">买{{ i + 1 }}</span>
          <span class="pr">{{ b.price.toFixed(2) }}</span>
          <span class="vl">{{ b.vol }}</span>
        </div>
      </div>
      <div class="info">
        开 {{ d.ob.value.open.toFixed(2) }} · 高 {{ d.ob.value.high.toFixed(2) }}
        · 低 {{ d.ob.value.low.toFixed(2) }} · 额 {{ (d.ob.value.amount / 1e8).toFixed(2) }}亿
      </div>
    </template>
    <div v-else class="loading">加载盘口…</div>
  </div>
</template>

<style scoped>
.w-ob { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 6px 9px;
  gap: 3px; min-height: 0; }
.rows { flex: 1; display: flex; flex-direction: column; justify-content: center; min-height: 0; }
.row { display: grid; grid-template-columns: 30px 1fr 56px; align-items: center; gap: 5px;
  height: 17px; font-size: 10px; }
.lb { color: var(--text-dim); font-size: 9px; }
.pr { font-variant-numeric: tabular-nums; font-weight: 600; }
.vl { text-align: right; font-variant-numeric: tabular-nums; font-size: 9px; color: var(--text-dim); }
.row.s .pr { color: #ff6b78; }
.row.b .pr { color: #2fe6ac; }
.mid { text-align: center; height: 20px; line-height: 20px; font-size: 10.5px; font-weight: 700;
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); margin: 2px 0; }
.info { font-size: 9px; color: var(--text-dim); text-align: center; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
.loading { flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); font-size: 10px; }
</style>
