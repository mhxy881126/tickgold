<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { usePaperStore } from "../stores/paper";
import { fetchQuotes } from "../api/market";
import type { Quote } from "../api/types";

const props = defineProps<{ code: string | null }>();
const paper = usePaperStore();

const tradeCode = ref<string | null>(props.code);
const orderQuote = ref<Quote | null>(null);
const side = ref<"buy" | "sell">("buy");
const vol = ref<number>(100);
const subTab = ref<"positions" | "orders">("positions");
const msg = ref("");
const busy = ref(false);
let qtimer: number | null = null;

watch(() => props.code, (c) => { if (c) tradeCode.value = c; });
watch(tradeCode, () => { loadOrderQuote(); });
watch(side, () => { vol.value = side.value === "buy" ? 100 : 0; });

async function loadOrderQuote() {
  if (!tradeCode.value) { orderQuote.value = null; return; }
  try {
    const qs = await fetchQuotes([tradeCode.value]);
    orderQuote.value = qs[0] ?? null;
  } catch { /* ignore */ }
}

const price = computed(() => orderQuote.value?.price ?? 0);
const curPosition = computed(() => paper.positions.find((p) => p.code === tradeCode.value));

// 仓位快捷
const maxBuy = computed(() => {
  if (!price.value) return 0;
  const est = paper.account.cash / (price.value * 1.0003);
  return Math.floor(est / 100) * 100;
});
function pickVol(ratio: number) {
  if (side.value === "buy") {
    vol.value = Math.floor((maxBuy.value * ratio) / 100 / 100) * 100;
  } else if (curPosition.value) {
    if (ratio >= 0.999) vol.value = curPosition.value.availVol;
    else vol.value = Math.floor((curPosition.value.availVol * ratio) / 100 / 100) * 100;
  }
}

const estAmount = computed(() => price.value * vol.value);
const estFee = computed(() => {
  if (!estAmount.value) return 0;
  const comm = Math.max(estAmount.value * 0.00025, 5);
  const stamp = side.value === "sell" ? estAmount.value * 0.0005 : 0;
  return comm + stamp + estAmount.value * 0.00001;
});

async function submit() {
  if (!tradeCode.value || !orderQuote.value) { msg.value = "请先选择股票"; return; }
  if (!vol.value || vol.value <= 0) { msg.value = "请输入有效数量"; return; }
  busy.value = true; msg.value = "";
  try {
    if (side.value === "buy") {
      await paper.buy(tradeCode.value, orderQuote.value.name, orderQuote.value.price, vol.value);
      msg.value = "买入成交";
    } else {
      await paper.sell(tradeCode.value, orderQuote.value.price, vol.value);
      msg.value = "卖出成交";
    }
    subTab.value = "positions";
    vol.value = side.value === "buy" ? 100 : 0;
    await loadOrderQuote();
  } catch (e) {
    msg.value = e instanceof Error ? e.message : "下单失败";
  }
  busy.value = false;
}

// 持仓表派生
interface PView {
  code: string; name: string; vol: number; avail: number; cost: number;
  now: number; mv: number; pnl: number; pnlPct: number;
}
const posView = computed<PView[]>(() =>
  paper.positions.map((p) => {
    const now = paper.priceMap[p.code]?.price ?? p.costAmount / p.vol;
    const mv = p.vol * now;
    const pnl = mv - p.costAmount;
    return {
      code: p.code, name: p.name, vol: p.vol, avail: p.availVol,
      cost: p.costAmount / p.vol, now, mv, pnl,
      pnlPct: p.costAmount ? (pnl / p.costAmount) * 100 : 0,
    };
  })
);

function pickPosition(code: string, s: "buy" | "sell") {
  tradeCode.value = code;
  side.value = s;
}

async function resetAccount() {
  if (window.confirm("确定重置模拟账户？将清空所有持仓与委托记录，资金恢复初始。")) {
    await paper.reset();
    msg.value = "账户已重置";
  }
}

function money(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (abs >= 1e4) return (n / 1e4).toFixed(2) + "万";
  return n.toFixed(0);
}
function fmtTime(t: number): string {
  const d = new Date(t);
  return `${(d.getMonth() + 1)}/${d.getDate()} ${d.toLocaleTimeString([], { hour12: false })}`;
}
function cls(v: number): string { return v > 1e-6 ? "up" : v < -1e-6 ? "down" : ""; }

onMounted(async () => {
  await paper.load();
  await loadOrderQuote();
  qtimer = window.setInterval(loadOrderQuote, 3000);
});
onBeforeUnmount(() => {
  if (qtimer) clearInterval(qtimer);
  paper.stop();
});
</script>

<template>
  <div class="trade">
    <!-- 账户概览 -->
    <div class="acct">
      <div class="a"><div class="ak">总资产</div><div class="av">{{ money(paper.totalAssets) }}</div></div>
      <div class="a"><div class="ak">可用资金</div><div class="av">{{ money(paper.account.cash) }}</div></div>
      <div class="a"><div class="ak">持仓市值</div><div class="av">{{ money(paper.marketValue) }}</div></div>
      <div class="a"><div class="ak">浮动盈亏</div>
        <div class="av" :class="cls(paper.floatPnl)">{{ money(paper.floatPnl) }}</div></div>
      <div class="a"><div class="ak">累计盈亏</div>
        <div class="av" :class="cls(paper.totalPnl)">
          {{ money(paper.totalPnl) }} <span class="pct">{{ paper.pnlPct.toFixed(2) }}%</span>
        </div></div>
      <button class="reset" @click="resetAccount">重置</button>
    </div>

    <!-- 下单面板 -->
    <div class="order-box">
      <div class="stock-info">
        <template v-if="orderQuote">
          <div class="s-name">{{ orderQuote.name }} <span class="s-code">{{ orderQuote.code }}</span></div>
          <div class="s-price" :class="cls(orderQuote.pct)">{{ orderQuote.price.toFixed(2) }}</div>
          <div class="s-chg" :class="cls(orderQuote.pct)">
            {{ orderQuote.change >= 0 ? "+" : "" }}{{ orderQuote.change.toFixed(2) }}
            {{ orderQuote.pct >= 0 ? "+" : "" }}{{ orderQuote.pct.toFixed(2) }}%
          </div>
          <div v-if="curPosition" class="s-hold">
            持 {{ curPosition.vol }} / 可卖 {{ curPosition.availVol }}
          </div>
        </template>
        <div v-else class="s-empty">请从自选 / 榜单 / 持仓选择股票</div>
      </div>

      <div class="trade-form">
        <div class="seg">
          <button :class="{ on: side === 'buy' }" @click="side = 'buy'">买入</button>
          <button :class="{ on: side === 'sell' }" @click="side = 'sell'">卖出</button>
        </div>
        <div class="qty-row">
          <span class="qty-lb">数量</span>
          <input v-model.number="vol" type="number" min="0" step="100" class="qty-in" />
          <span class="qty-unit">股</span>
        </div>
        <div class="quick">
          <button @click="pickVol(0.25)">1/4</button>
          <button @click="pickVol(0.333)">1/3</button>
          <button @click="pickVol(0.5)">1/2</button>
          <button @click="pickVol(1)">全仓</button>
        </div>
        <div class="est">
          <div>价格 <b>{{ price ? price.toFixed(2) : "--" }}</b>（市价）</div>
          <div>预估金额 <b>{{ money(estAmount) }}</b></div>
          <div>预估费用 <b>{{ estFee.toFixed(2) }}</b></div>
        </div>
      </div>

      <div class="trade-action">
        <button class="go" :class="side" :disabled="busy" @click="submit">
          {{ busy ? "处理中" : side === "buy" ? "买入 B" : "卖出 S" }}
        </button>
        <div v-if="msg" class="msg" :class="{ ok: msg.includes('成交') || msg.includes('重置') }">{{ msg }}</div>
      </div>
    </div>

    <!-- 持仓 / 委托 -->
    <div class="lower">
      <div class="ltab">
        <button :class="{ on: subTab === 'positions' }" @click="subTab = 'positions'">
          持仓 <span class="badge">{{ paper.positions.length }}</span>
        </button>
        <button :class="{ on: subTab === 'orders' }" @click="subTab = 'orders'">委托 / 成交</button>
      </div>

      <div class="ltable-scroll">
        <table v-if="subTab === 'positions'" class="ltable">
          <thead>
            <tr>
              <th class="l-name">代码 / 名称</th><th>持仓</th><th>可卖</th>
              <th>成本</th><th>现价</th><th>市值</th><th>浮盈</th><th>盈亏%</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in posView" :key="p.code"
              :class="{ cur: p.code === tradeCode }">
              <td class="l-name">
                <span class="p-code">{{ p.code }}</span> {{ p.name }}
              </td>
              <td>{{ p.vol }}</td>
              <td>{{ p.avail }}</td>
              <td>{{ p.cost.toFixed(2) }}</td>
              <td>{{ p.now.toFixed(2) }}</td>
              <td>{{ money(p.mv) }}</td>
              <td :class="cls(p.pnl)">{{ money(p.pnl) }}</td>
              <td :class="cls(p.pnlPct)">{{ p.pnlPct.toFixed(2) }}%</td>
              <td class="ops">
                <button class="op buy" @click="pickPosition(p.code,'buy')">买</button>
                <button class="op sell" @click="pickPosition(p.code,'sell')">卖</button>
              </td>
            </tr>
            <tr v-if="!posView.length"><td colspan="9" class="no-data">暂无持仓，先买入股票</td></tr>
          </tbody>
        </table>

        <table v-else class="ltable">
          <thead>
            <tr><th>时间</th><th class="l-name">代码 / 名称</th><th>方向</th>
              <th>价格</th><th>数量</th><th>金额</th><th>费用</th></tr>
          </thead>
          <tbody>
            <tr v-for="o in paper.orders" :key="o.id">
              <td class="t">{{ fmtTime(o.createdAt) }}</td>
              <td class="l-name"><span class="p-code">{{ o.code }}</span> {{ o.name }}</td>
              <td :class="o.side === 'buy' ? 'up' : 'down'">{{ o.side === "buy" ? "买入" : "卖出" }}</td>
              <td>{{ o.price.toFixed(2) }}</td>
              <td>{{ o.vol }}</td>
              <td>{{ money(o.amount) }}</td>
              <td>{{ o.fee.toFixed(2) }}</td>
            </tr>
            <tr v-if="!paper.orders.length"><td colspan="7" class="no-data">暂无委托记录</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trade { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }

/* 账户条 */
.acct { display: flex; align-items: center; gap: 8px; background: var(--bg-panel);
  border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; flex-shrink: 0; }
.a { flex: 1; min-width: 0; }
.ak { font-size: 10px; color: var(--text-dim); }
.av { font-size: 15px; font-weight: 700; margin-top: 1px; font-variant-numeric: tabular-nums; }
.av .pct { font-size: 11px; font-weight: 500; }
.reset { padding: 3px 10px; font-size: 11px; background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 5px; cursor: pointer; flex-shrink: 0; }
.reset:hover { color: #f23645; border-color: #f23645; }

/* 下单面板 */
.order-box { display: grid; grid-template-columns: 1.1fr 1.4fr 0.9fr; gap: 10px;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px; flex-shrink: 0; }
.stock-info { border-right: 1px solid var(--border); padding-right: 10px; min-width: 0; }
.s-name { font-size: 13px; font-weight: 700; }
.s-code { font-size: 11px; color: var(--text-dim); margin-left: 5px; }
.s-price { font-size: 24px; font-weight: 700; line-height: 1.2; margin-top: 2px; }
.s-chg { font-size: 11.5px; }
.s-hold { font-size: 10.5px; color: var(--text-dim); margin-top: 3px; }
.s-empty { font-size: 11px; color: var(--text-dim); display: flex; align-items: center; height: 100%; }

.trade-form { display: flex; flex-direction: column; gap: 5px; border-right: 1px solid var(--border); padding-right: 10px; }
.seg { display: flex; gap: 4px; }
.seg button { flex: 1; padding: 4px 0; font-size: 12px; cursor: pointer; background: transparent;
  color: var(--text-dim); border: 1px solid var(--border); border-radius: 5px; }
.seg button.on.buy, .seg button:nth-child(1).on { color: #fff; background: #f23645; border-color: #f23645; }
.seg button.on:nth-child(2) { color: #fff; background: #0ecb81; border-color: #0ecb81; }
.qty-row { display: flex; align-items: center; gap: 6px; }
.qty-lb { font-size: 11px; color: var(--text-dim); }
.qty-in { flex: 1; width: 100%; background: #0d1219; border: 1px solid var(--border); border-radius: 5px;
  color: var(--text); font-size: 12px; padding: 4px 6px; }
.qty-unit { font-size: 11px; color: var(--text-dim); }
.quick { display: flex; gap: 4px; }
.quick button { flex: 1; font-size: 10.5px; padding: 3px 0; background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
.quick button:hover { color: var(--text); border-color: var(--text-dim); }
.est { font-size: 10.5px; color: var(--text-dim); display: flex; flex-direction: column; gap: 1px; margin-top: 1px; }
.est b { color: var(--text); font-weight: 600; }

.trade-action { display: flex; flex-direction: column; justify-content: center; gap: 6px; min-width: 0; }
.go { padding: 12px 0; font-size: 14px; font-weight: 700; border: none; border-radius: 7px; cursor: pointer; color: #fff; }
.go.buy { background: #f23645; } .go.sell { background: #0ecb81; }
.go:disabled { opacity: .6; cursor: default; }
.msg { font-size: 11px; color: #f23645; text-align: center; word-break: break-all; }
.msg.ok { color: #0ecb81; }

/* 下部 */
.lower { flex: 1; min-height: 0; display: flex; flex-direction: column;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.ltab { display: flex; gap: 4px; padding: 7px 8px 0; flex-shrink: 0; }
.ltab button { padding: 4px 12px; font-size: 11.5px; background: transparent; color: var(--text-dim);
  border: 1px solid transparent; border-radius: 5px; cursor: pointer; }
.ltab button.on { color: var(--accent); background: #1a2438; border-color: var(--border); }
.badge { display: inline-block; background: var(--border); border-radius: 8px; font-size: 10px;
  padding: 0 6px; margin-left: 3px; color: var(--text); }
.ltable-scroll { flex: 1; min-height: 0; overflow-y: auto; margin-top: 4px; }
.ltable { width: 100%; border-collapse: collapse; font-size: 11px; }
.ltable th { color: var(--text-dim); font-weight: 500; padding: 4px 6px; text-align: right;
  border-bottom: 1px solid var(--border); white-space: nowrap; position: sticky; top: 0; background: var(--bg-panel); }
.ltable th.l-name, .ltable td.l-name { text-align: left; }
.ltable td { padding: 3px 6px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.l-name .p-code { color: var(--text-dim); font-size: 10.5px; margin-right: 4px; }
tr.cur { background: #16233a; }
.ops { white-space: nowrap; }
.op { width: 26px; padding: 2px 0; font-size: 10.5px; border-radius: 4px; cursor: pointer;
  background: transparent; border: 1px solid var(--border); margin: 0 1px; }
.op.buy { color: #f23645; } .op.sell { color: #0ecb81; }
.op:hover { background: var(--bg-hover); }
.t { color: var(--text-dim); font-size: 10.5px; }
.no-data { text-align: center !important; color: var(--text-dim); padding: 22px 0; }

.up { color: #f23645; } .down { color: #0ecb81; }
</style>
