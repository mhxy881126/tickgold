<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed } from "vue";
import { fetchFundFlow } from "../api/market";
import type { FundFlow } from "../api/types";

const props = defineProps<{ code: string | null }>();

const data = ref<FundFlow | null>(null);
let timer: number | null = null;

function money(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (a >= 1e4) return (n / 1e4).toFixed(0) + "万";
  return n.toFixed(0);
}
function cls(n: number): string {
  return n > 0 ? "up" : n < 0 ? "down" : "";
}
function sign(n: number): string {
  return n > 0 ? "+" : "";
}

// 四档条形宽度（以绝对值最大者为满，正负各占半区）
const maxAbs = computed(() => {
  if (!data.value) return 1;
  return Math.max(...data.value.levels.map((l) => Math.abs(l.net)), 1);
});
function negW(net: number): string {
  return net < 0 ? (Math.abs(net) / maxAbs.value * 100).toFixed(1) + "%" : "0%";
}
function posW(net: number): string {
  return net > 0 ? (net / maxAbs.value * 100).toFixed(1) + "%" : "0%";
}

async function load() {
  if (!props.code) {
    data.value = null;
    return;
  }
  try {
    data.value = await fetchFundFlow(props.code);
  } catch (e) {
    console.error("fundflow", e);
  }
}

watch(() => props.code, load);
onMounted(() => {
  load();
  timer = window.setInterval(load, 8000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="ff">
    <template v-if="data">
      <!-- 主力净流入 -->
      <div class="hero">
        <div class="hero-label">主力净流入</div>
        <div class="hero-val" :class="cls(data.mainNet)">
          {{ sign(data.mainNet) }}{{ money(data.mainNet) }}
        </div>
        <div class="hero-pct" :class="cls(data.mainNet)">
          净占比 {{ sign(data.mainNetPct) }}{{ data.mainNetPct.toFixed(1) }}%
        </div>
      </div>

      <!-- 四档分布 -->
      <div class="levels">
        <div v-for="lv in data.levels" :key="lv.name" class="lv">
          <div class="lv-name">{{ lv.name }}</div>
          <div class="bar-wrap">
            <div class="half">
              <div class="b neg" :style="{ width: negW(lv.net) }"></div>
            </div>
            <div class="axis"></div>
            <div class="half">
              <div class="b pos" :style="{ width: posW(lv.net) }"></div>
            </div>
          </div>
          <div class="lv-val" :class="cls(lv.net)">{{ money(lv.net) }}</div>
        </div>
      </div>

      <!-- 主力流入流出 -->
      <div class="grid2">
        <div class="cell">
          <div class="c-label up">主力流入</div>
          <div class="c-val">{{ money(data.mainIn) }}</div>
        </div>
        <div class="cell">
          <div class="c-label down">主力流出</div>
          <div class="c-val">{{ money(data.mainOut) }}</div>
        </div>
      </div>

      <!-- 散户 -->
      <div class="retail">
        <span class="r-label">散户净流入</span>
        <span class="r-val" :class="cls(data.retailNet)">
          {{ sign(data.retailNet) }}{{ money(data.retailNet) }}
          <em class="r-pct">({{ data.retailNetPct.toFixed(1) }}%)</em>
        </span>
      </div>
    </template>
    <div v-else class="empty">选择一只股票查看资金流向</div>
  </div>
</template>

<style scoped>
.ff {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  overflow: hidden;
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 12px;
}

/* 主力净流入 */
.hero {
  text-align: center;
  padding-bottom: 9px;
  border-bottom: 1px solid #20272f;
}
.hero-label {
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 3px;
}
.hero-val {
  font-size: 23px;
  font-weight: 700;
  line-height: 1.15;
}
.hero-pct {
  font-size: 11px;
  margin-top: 2px;
}

/* 四档分布 */
.levels {
  padding: 10px 0 6px;
  border-bottom: 1px solid #20272f;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.lv {
  display: grid;
  grid-template-columns: 38px 1fr 52px;
  align-items: center;
  gap: 6px;
}
.lv-name {
  font-size: 10px;
  color: var(--text-dim);
}
.bar-wrap {
  display: flex;
  height: 9px;
}
.half {
  flex: 1;
  display: flex;
}
.half:first-child {
  justify-content: flex-end;
}
.axis {
  width: 1px;
  background: #39424d;
}
.b {
  height: 100%;
  border-radius: 2px;
}
.b.neg {
  background: #26a69a;
}
.b.pos {
  background: #ef5350;
}
.lv-val {
  font-size: 10px;
  text-align: right;
  font-weight: 600;
}

/* 主力明细 */
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 9px 0;
  border-bottom: 1px solid #20272f;
}
.cell {
  text-align: center;
}
.c-label {
  font-size: 10px;
  margin-bottom: 2px;
}
.c-val {
  font-size: 13px;
  font-weight: 600;
}

/* 散户 */
.retail {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 9px;
  font-size: 12px;
}
.r-label {
  color: var(--text-dim);
}
.r-val {
  font-weight: 600;
}
.r-pct {
  font-style: normal;
  font-size: 10px;
  color: var(--text-dim);
  font-weight: 400;
}

.up {
  color: #ef5350;
}
.down {
  color: #26a69a;
}
</style>
