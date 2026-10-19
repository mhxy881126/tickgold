<script setup lang="ts">
// P0-3 断连闭环 + 重连对账（全局常驻）：
// 断连时统计在途委托（非终态），顶部红色横幅提示并禁止推进（后端 submit 已拦 connected）；
// 重连后后端自动重拉资产/持仓/成交/挂单，前端延迟复核本地在途单状态，仍无终态的逐笔提示人工核对。
import { ref, onMounted, onBeforeUnmount } from "vue";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { brokerListOrders, type BrokerOrderInfo } from "../broker/api";

const OPEN = new Set(["submitting", "submitted", "part_filled"]);
const TERMINAL = new Set(["filled", "cancelled", "error", "rejected"]);
const STATUS_LABEL: Record<string, string> = {
  submitting: "提交中", submitted: "已报", part_filled: "部分成交",
  filled: "已成交", cancelled: "已撤单", error: "废单", rejected: "已拒单",
};

type Phase = "lost" | "reconciling" | "need-review" | "resolved";
const phase = ref<Phase | null>(null);
const openOrders = ref<BrokerOrderInfo[]>([]);
const reconcileTimer = ref<ReturnType<typeof setTimeout> | undefined>();

function sideLabel(side: string) {
  return side === "SELL" ? "卖出" : "买入";
}

function openBrokerConsole() {
  void emit("island:open-card", "brokerconsole");
}

async function reconcile() {
  phase.value = "reconciling";
  // 等后端重连后的全量重查（asset/position/trades/pending）落地。
  clearTimeout(reconcileTimer.value);
  reconcileTimer.value = setTimeout(async () => {
    try {
      const ids = new Set(openOrders.value.map((o) => o.sigId));
      const latest = await brokerListOrders(null);
      const stillOpen = latest.filter((o) => ids.has(o.sigId) && OPEN.has(o.status));
      const reached = latest.filter((o) => ids.has(o.sigId) && TERMINAL.has(o.status));
      if (stillOpen.length > 0) {
        openOrders.value = stillOpen;
        phase.value = "need-review";
      } else {
        openOrders.value = reached.length ? reached : openOrders.value;
        phase.value = "resolved";
      }
    } catch {
      phase.value = "need-review";
    }
  }, 4500);
}

// 人工确认：仅在能核对（重连后）时允许关闭。
function ack() {
  phase.value = null;
  openOrders.value = [];
}

let un: UnlistenFn[] = [];
onMounted(() => {
  listen<{ open_orders?: BrokerOrderInfo[] }>("broker:connection_lost", (ev) => {
    const list = ev.payload?.open_orders ?? [];
    // 只在有在途单时打断；无在途单的断连由控制台状态条提示即可。
    if (list.length > 0) {
      openOrders.value = list;
      phase.value = "lost";
    }
  }).then((u) => un.push(u));
  listen("broker:connection_restored", () => {
    if (phase.value === "lost" || openOrders.value.length > 0) {
      void reconcile();
    }
  }).then((u) => un.push(u));
});
onBeforeUnmount(() => {
  un.forEach((u) => u());
  clearTimeout(reconcileTimer.value);
});
</script>

<template>
  <transition name="cg-fade">
    <div v-if="phase" class="cg-bar" :class="phase">
      <div class="cg-main">
        <div class="cg-title">
          <span class="cg-dot"></span>
          <template v-if="phase === 'lost'">券商通道已断开 · {{ openOrders.length }} 笔在途委托状态未确认，须重连后逐笔对账</template>
          <template v-else-if="phase === 'reconciling'">通道已重连 · 正在自动重拉成交 / 挂单并对账…</template>
          <template v-else-if="phase === 'need-review'">重连后仍有 {{ openOrders.length }} 笔未取得终态回报，请逐笔核对券商当日成交 / 挂单</template>
          <template v-else>对账完成：在途委托均已取得终态（成交 / 撤销）</template>
        </div>
        <div v-if="phase === 'lost'" class="cg-sub">断连期间系统已自动禁止一切新委托，避免在状态不明时继续下单。</div>
        <div v-if="openOrders.length" class="cg-list">
          <div v-for="o in openOrders" :key="o.sigId" class="cg-row">
            <span class="cg-side" :class="o.side === 'SELL' ? 'sell' : 'buy'">{{ sideLabel(o.side) }}</span>
            <span class="cg-code">{{ o.code }}</span>
            <span class="cg-fld">{{ o.price.toFixed(2) }} 元</span>
            <span class="cg-fld">{{ o.vol }} 股</span>
            <span v-if="o.filledVol > 0" class="cg-fld">已成交 {{ o.filledVol }}</span>
            <span class="cg-status" :class="{ open: OPEN.has(o.status) }">{{ STATUS_LABEL[o.status] || o.status }}</span>
          </div>
        </div>
      </div>
      <div class="cg-actions">
        <button type="button" class="cg-btn" @click="openBrokerConsole">打开同花顺控制台核对</button>
        <button
          v-if="phase === 'lost'"
          type="button"
          class="cg-btn"
          disabled
          title="重连并完成对账后才能确认"
        >等待重连…</button>
        <button
          v-else
          type="button"
          class="cg-btn"
          :class="{ primary: phase === 'need-review' || phase === 'resolved' }"
          @click="ack"
        >{{ phase === 'need-review' ? '我已逐笔核对无误' : '关闭' }}</button>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.cg-bar {
  position: fixed; top: 0; left: 0; right: 0; z-index: 1250;
  display: flex; align-items: flex-start; gap: 14px;
  padding: 10px 16px; font-size: 12px;
  background: linear-gradient(135deg, rgba(242,54,69,.18), rgba(242,54,69,.06));
  border-bottom: 1px solid rgba(242,54,69,.6);
  color: #ffd7db; box-shadow: 0 6px 24px rgba(0,0,0,.4);
}
.cg-bar.reconciling, .cg-bar.need-review {
  background: linear-gradient(135deg, rgba(255,177,61,.16), rgba(255,177,61,.05));
  border-bottom-color: rgba(255,177,61,.55); color: #ffe7bd;
}
.cg-bar.resolved {
  background: linear-gradient(135deg, rgba(31,191,117,.14), rgba(31,191,117,.05));
  border-bottom-color: rgba(31,191,117,.5); color: #c8f0d8;
}
.cg-main { flex: 1; min-width: 0; }
.cg-title { font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 8px; }
.cg-dot { width: 9px; height: 9px; border-radius: 50%; background: #ff5a6a; flex-shrink: 0; animation: cg-blink 1s infinite; }
.reconciling .cg-dot, .need-review .cg-dot { background: #ffb13d; }
.resolved .cg-dot { background: #3dd68a; animation: none; }
@keyframes cg-blink { 50% { opacity: .25; } }
.cg-sub { margin-top: 3px; opacity: .85; }
.cg-list { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.cg-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 8px; border-radius: 6px; background: rgba(0,0,0,.18); }
.cg-side { font-weight: 700; padding: 1px 7px; border-radius: 4px; }
.cg-side.buy { background: rgba(255,90,90,.2); color: #ff8a8a; }
.cg-side.sell { background: rgba(45,212,140,.2); color: #48d98c; }
.cg-code { font-weight: 700; font-variant-numeric: tabular-nums; }
.cg-fld { opacity: .85; font-variant-numeric: tabular-nums; }
.cg-status { margin-left: auto; font-weight: 700; }
.cg-status.open { color: #ffb13d; }
.cg-actions { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
.cg-btn {
  border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.06);
  color: inherit; font-size: 12px; font-weight: 600; border-radius: 7px;
  padding: 7px 12px; cursor: pointer; white-space: nowrap;
}
.cg-btn.primary { background: rgba(255,255,255,.16); border-color: rgba(255,255,255,.4); }
.cg-btn:disabled { opacity: .5; cursor: not-allowed; }
.cg-fade-enter-active, .cg-fade-leave-active { transition: opacity .2s; }
.cg-fade-enter-from, .cg-fade-leave-to { opacity: 0; }
</style>
