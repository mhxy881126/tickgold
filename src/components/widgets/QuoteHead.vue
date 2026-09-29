<script setup lang="ts">
import { toRef } from "vue";
import { useWidgetData } from "../../composables/useMarketContext";
import AnimatedNumber from "../common/AnimatedNumber.vue";

// 报价头：名称/代码 + 大价格/涨跌幅 + 开高低等量价字段
const props = defineProps<{ bind?: string | null }>();
const d = useWidgetData(toRef(props, "bind"));
</script>

<template>
  <div class="w-quote">
    <div class="top">
      <div class="nm">
        <span class="name">{{ d.name.value }}</span>
        <span class="code">{{ d.code.value }}</span>
      </div>
      <div class="vals">
        <AnimatedNumber
          tag="span"
          class="price"
          :class="(d.quote.value?.pct ?? 0) >= 0 ? 'up' : 'down'"
          :value="d.quote.value?.price"
          kind="price"
        />
        <AnimatedNumber
          tag="span"
          class="pct"
          :class="(d.quote.value?.pct ?? 0) >= 0 ? 'up' : 'down'"
          :value="d.quote.value?.pct"
          kind="pct"
        />
      </div>
    </div>
    <div class="grid">
      <div class="cell"><label>今开</label><b>{{ d.quote.value?.open?.toFixed(2) ?? '--' }}</b></div>
      <div class="cell"><label>最高</label><b>{{ d.quote.value?.high?.toFixed(2) ?? '--' }}</b></div>
      <div class="cell"><label>最低</label><b>{{ d.quote.value?.low?.toFixed(2) ?? '--' }}</b></div>
      <div class="cell"><label>昨收</label><b>{{ d.quote.value?.prevClose?.toFixed(2) ?? '--' }}</b></div>
      <div class="cell"><label>成交量</label><b>{{ d.quote.value ? (d.quote.value.volume / 1e4).toFixed(1) + '万手' : '--' }}</b></div>
      <div class="cell"><label>成交额</label><b>{{ d.quote.value ? (d.quote.value.amount / 1e8).toFixed(2) + '亿' : '--' }}</b></div>
      <div class="cell"><label>换手率</label><b>{{ d.quote.value ? d.quote.value.turnover.toFixed(2) + '%' : '--' }}</b></div>
      <div class="cell"><label>量比</label><b>{{ d.quote.value?.volumeRatio?.toFixed(2) ?? '--' }}</b></div>
    </div>
  </div>
</template>

<style scoped>
.w-quote { height: 100%; display: flex; flex-direction: column; padding: 9px 11px; gap: 8px; min-height: 0; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.nm { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.name { font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.code { font-size: 10px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.vals { display: flex; align-items: baseline; gap: 9px; flex-shrink: 0; }
.price { font-size: 21px; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1; }
.pct { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
.grid { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(4, 1fr);
  grid-auto-rows: min-content; gap: 5px 10px; align-content: center; }
.cell { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.cell label { font-size: 10px; color: var(--text-dim); flex-shrink: 0; }
.cell b { font-size: 10.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.up { color: #f23645; } .down { color: #08db94; }
</style>
