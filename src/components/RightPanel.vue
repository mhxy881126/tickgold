<script setup lang="ts">
import { computed } from "vue";
import { useQuotesStore } from "../stores/quotes";

const props = defineProps<{ code: string | null }>();
const quotes = useQuotesStore();

const q = computed(() => (props.code ? quotes.map[props.code] : null));

function fmt(n: number | undefined, d = 2) {
  return n == null ? "--" : n.toFixed(d);
}
function amt(n: number | undefined) {
  if (n == null) return "--";
  if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(2) + "万";
  return n.toFixed(0);
}
function cls(p: number | undefined) {
  if (p == null) return "";
  return p > 0.001 ? "up" : p < -0.001 ? "down" : "";
}
</script>

<template>
  <div class="right">
    <!-- 大价格 -->
    <div class="rblock price-block">
      <div v-if="q" class="price-line">
        <span class="name">{{ q.name }}</span>
        <span class="code">{{ q.code }}</span>
      </div>
      <div v-if="q" class="bigprice" :class="cls(q.pct)">
        {{ fmt(q.price) }}
        <span class="chg" :class="cls(q.pct)">
          {{ q.change >= 0 ? "+" : "" }}{{ fmt(q.change) }}
          {{ q.pct >= 0 ? "+" : "" }}{{ fmt(q.pct) }}%
        </span>
      </div>
      <div v-else class="empty-tip">选择一只股票</div>
    </div>

    <!-- 今日概览 -->
    <div v-if="q" class="rblock">
      <h4>今日概览</h4>
      <table class="kv">
        <tr><td class="l">今开</td><td class="v" :class="cls(q.open - q.prevClose)">{{ fmt(q.open) }}</td></tr>
        <tr><td class="l">最高</td><td class="v up">{{ fmt(q.high) }}</td></tr>
        <tr><td class="l">最低</td><td class="v down">{{ fmt(q.low) }}</td></tr>
        <tr><td class="l">昨收</td><td class="v">{{ fmt(q.prevClose) }}</td></tr>
        <tr><td class="l">成交量</td><td class="v">{{ amt(q.volume * 100) }}</td></tr>
        <tr><td class="l">成交额</td><td class="v">{{ amt(q.amount) }}</td></tr>
      </table>
    </div>

    <!-- 五档盘口（P2 接真实接口） -->
    <div class="rblock">
      <h4>五档盘口</h4>
      <table class="kv">
        <tr><td class="l">卖5</td><td class="v dim">--</td><td class="w dim">--</td></tr>
        <tr><td class="l">卖4</td><td class="v dim">--</td><td class="w dim">--</td></tr>
        <tr><td class="l">卖3</td><td class="v dim">--</td><td class="w dim">--</td></tr>
        <tr><td class="l">卖2</td><td class="v dim">--</td><td class="w dim">--</td></tr>
        <tr><td class="l">卖1</td><td class="v dim">--</td><td class="w dim">--</td></tr>
        <tr><td class="l buy">买1</td><td class="v dim">--</td><td class="w dim">--</td></tr>
        <tr><td class="l buy">买2</td><td class="v dim">--</td><td class="w dim">--</td></tr>
        <tr><td class="l buy">买3</td><td class="v dim">--</td><td class="w dim">--</td></tr>
        <tr><td class="l buy">买4</td><td class="v dim">--</td><td class="w dim">--</td></tr>
        <tr><td class="l buy">买5</td><td class="v dim">--</td><td class="w dim">--</td></tr>
      </table>
      <div class="todo">五档接口 P2 接入</div>
    </div>

    <!-- 资金流向（P3） -->
    <div class="rblock">
      <h4>资金流向</h4>
      <div class="todo">资金流向接口 P3 接入</div>
    </div>
  </div>
</template>

<style scoped>
.right { background: var(--bg-panel); border-left: 1px solid var(--border); overflow-y: auto; height: 100%; }
.rblock { padding: 10px 12px; border-bottom: 1px solid var(--border); }
h4 { font-size: 11px; color: var(--text-dim); font-weight: 500; margin-bottom: 6px; }
.price-block { padding: 12px; }
.price-line { display: flex; gap: 8px; align-items: baseline; margin-bottom: 4px; }
.name { font-weight: 700; font-size: 15px; }
.code { color: var(--text-dim); font-size: 12px; }
.bigprice { font-size: 26px; font-weight: 700; display: flex; align-items: baseline; gap: 10px; }
.chg { font-size: 13px; font-weight: 500; }
.empty-tip { color: var(--text-dim); padding: 20px 0; text-align: center; }
.kv { width: 100%; font-variant-numeric: tabular-nums; }
.kv td { padding: 2px 0; }
.l { color: var(--text-dim); } .l.buy { color: var(--down); }
.v { text-align: right; } .w { text-align: right; color: var(--text-dim); }
.dim { color: var(--text-dim); }
.up { color: var(--up); } .down { color: var(--down); }
.todo { font-size: 11px; color: var(--text-dim); opacity: 0.6; padding-top: 4px; }
</style>
