<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { invoke } from "@tauri-apps/api/core";

const props = defineProps<{ code: string | null }>();

interface OrderLevel { price: number; vol: number; }
interface OrderBook {
  name: string; code: string; price: number; prevClose: number;
  open: number; high: number; low: number; volume: number; amount: number;
  asks: OrderLevel[]; bids: OrderLevel[];
}

const ob = ref<OrderBook | null>(null);
let timer: number | null = null;

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
function chg(): number {
  if (!ob.value) return 0;
  return ob.value.price - ob.value.prevClose;
}
function pct(): number {
  if (!ob.value || ob.value.prevClose === 0) return 0;
  return (chg() / ob.value.prevClose) * 100;
}

async function load() {
  if (!props.code) { ob.value = null; return; }
  try {
    ob.value = await invoke<OrderBook>("get_orderbook", { code: props.code });
  } catch (e) {
    console.error("orderbook", e);
  }
}

watch(() => props.code, load);
onMounted(() => {
  load();
  timer = window.setInterval(load, 3000);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div class="right">
    <!-- 大价格 -->
    <div v-if="ob" class="rblock price-block">
      <div class="price-line">
        <span class="name">{{ ob.name }}</span>
        <span class="code">{{ ob.code }}</span>
      </div>
      <div class="bigprice" :class="cls(pct())">
        {{ fmt(ob.price) }}
        <span class="chg" :class="cls(pct())">
          {{ chg() >= 0 ? "+" : "" }}{{ fmt(chg()) }}
          {{ pct() >= 0 ? "+" : "" }}{{ fmt(pct()) }}%
        </span>
      </div>
    </div>
    <div v-else class="rblock"><div class="empty-tip">选择一只股票</div></div>

    <!-- 五档盘口 -->
    <div v-if="ob" class="rblock">
      <h4>五档盘口</h4>
      <table class="kv">
        <tr v-for="(a, i) in ob.asks.slice().reverse()" :key="'a'+i">
          <td class="l">卖{{ 5 - i }}</td>
          <td class="v up">{{ fmt(a.price) }}</td>
          <td class="w">{{ amt(a.vol * 100) }}</td>
        </tr>
        <tr class="mid"><td></td><td></td><td></td></tr>
        <tr v-for="(b, i) in ob.bids" :key="'b'+i">
          <td class="l buy">买{{ i + 1 }}</td>
          <td class="v down">{{ fmt(b.price) }}</td>
          <td class="w">{{ amt(b.vol * 100) }}</td>
        </tr>
      </table>
    </div>

    <!-- 今日概览 -->
    <div v-if="ob" class="rblock">
      <h4>今日概览</h4>
      <table class="kv">
        <tr><td class="l">今开</td><td class="v">{{ fmt(ob.open) }}</td></tr>
        <tr><td class="l">最高</td><td class="v up">{{ fmt(ob.high) }}</td></tr>
        <tr><td class="l">最低</td><td class="v down">{{ fmt(ob.low) }}</td></tr>
        <tr><td class="l">昨收</td><td class="v">{{ fmt(ob.prevClose) }}</td></tr>
        <tr><td class="l">成交量</td><td class="v">{{ amt(ob.volume * 100) }}</td></tr>
        <tr><td class="l">成交额</td><td class="v">{{ amt(ob.amount) }}</td></tr>
      </table>
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
.mid td { height: 4px; }
.up { color: var(--up); } .down { color: var(--down); }
</style>
