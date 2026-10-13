<template>
  <span class="qc" :class="{ dim: !q.sufficient }" :title="title">
    <i class="qc-dot" />
    同型命中率 <b>{{ Math.round(q.winRatePct) }}%</b>
    <em>n={{ q.samples }}</em>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { QualityViewInfo } from "../ai/api";

const props = defineProps<{ q: QualityViewInfo }>();

const title = computed(() =>
  props.q.sufficient
    ? `同型历史样本 ${props.q.samples} 个 · 胜率 ${props.q.winRatePct.toFixed(1)}% · 平均后续收益 ${props.q.avgRetPct.toFixed(2)}% · 置信 ${props.q.level}`
    : `样本不足（${props.q.samples} < 5），不作为决策依据`,
);
</script>

<style scoped>
.qc {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-style: normal;
  color: #1dbe7d;
  border: 1px solid #1dbe7d66;
  background: #1dbe7d14;
  border-radius: 6px;
  padding: 1px 7px;
  white-space: nowrap;
}
.qc b {
  font-weight: 700;
}
.qc em {
  color: #7e879b;
  font-style: normal;
}
.qc-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #1dbe7d;
}
.qc.dim {
  color: #8a93a6;
  border-color: #3a4356;
  background: rgba(255, 255, 255, 0.03);
}
.qc.dim .qc-dot {
  background: #8a93a6;
}
</style>
