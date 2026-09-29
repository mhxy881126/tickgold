<script setup lang="ts">
import { computed, nextTick, onMounted, watch, toRef } from "vue";
import { useWidgetData } from "../../composables/useMarketContext";
import AnimatedNumber from "../common/AnimatedNumber.vue";

// 资金流向条（紧凑）：主力净流入 + 四档分布
const props = defineProps<{ bind?: string | null }>();
const d = useWidgetData(toRef(props, "bind"));

const maxAbs = computed(() => {
  const f = d.fund.value;
  if (!f) return 1;
  return Math.max(...f.levels.map((l) => Math.abs(l.net)), 1);
});
function negW(net: number) {
  return net < 0 ? (Math.abs(net) / maxAbs.value * 100).toFixed(1) + "%" : "0%";
}
function posW(net: number) {
  return net > 0 ? (net / maxAbs.value * 100).toFixed(1) + "%" : "0%";
}
function money(n: number) {
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (a >= 1e4) return (n / 1e4).toFixed(0) + "万";
  return n.toFixed(0);
}
async function refresh() { await d.ensure("fund"); }
onMounted(() => nextTick(refresh));
watch(() => d.code.value, () => nextTick(refresh));
</script>

<template>
  <div class="w-fund">
    <template v-if="d.fund.value">
      <div class="hero">
        <span class="lbl">主力净流入</span>
        <AnimatedNumber
          tag="b"
          :class="d.fund.value.mainNet > 0 ? 'up' : d.fund.value.mainNet < 0 ? 'down' : ''"
          :value="d.fund.value.mainNet"
          kind="money"
        />
        <span class="pct" :class="d.fund.value.mainNet > 0 ? 'up' : d.fund.value.mainNet < 0 ? 'down' : ''">
          {{ d.fund.value.mainNetPct.toFixed(1) }}%
        </span>
      </div>
      <div class="levels">
        <div v-for="lv in d.fund.value.levels" :key="lv.name" class="lv">
          <span class="nm">{{ lv.name }}</span>
          <div class="bar">
            <div class="half"><div class="b neg" :style="{ width: negW(lv.net) }"></div></div>
            <div class="axis"></div>
            <div class="half"><div class="b pos" :style="{ width: posW(lv.net) }"></div></div>
          </div>
          <span class="val" :class="lv.net > 0 ? 'up' : lv.net < 0 ? 'down' : ''">{{ money(lv.net) }}</span>
        </div>
      </div>
    </template>
    <div v-else class="loading">加载资金流向…</div>
  </div>
</template>

<style scoped>
.w-fund { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 8px 10px;
  gap: 7px; min-height: 0; }
.hero { display: flex; align-items: baseline; gap: 8px; }
.hero .lbl { font-size: 10px; color: var(--text-dim); }
.hero b { font-size: 16px; font-variant-numeric: tabular-nums; }
.hero .pct { font-size: 10px; font-variant-numeric: tabular-nums; }
.levels { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 6px; min-height: 0; }
.lv { display: grid; grid-template-columns: 34px 1fr 48px; align-items: center; gap: 6px; }
.nm { font-size: 9.5px; color: var(--text-dim); }
.bar { display: flex; height: 8px; }
.half { flex: 1; display: flex; }
.half:first-child { justify-content: flex-end; }
.axis { width: 1px; background: #39424d; }
.b { height: 100%; border-radius: 2px; }
.b.neg { background: #26a69a; } .b.pos { background: #ef5350; }
.val { font-size: 9.5px; text-align: right; font-variant-numeric: tabular-nums; }
.loading { flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); font-size: 10px; }
.up { color: #ef5350; } .down { color: #26a69a; }
</style>
