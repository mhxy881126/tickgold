<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import PhaseTimeline from "./PhaseTimeline.vue";
import PhasePanel from "./PhasePanel.vue";
import InstructionList from "./InstructionList.vue";
import OrderDock from "./OrderDock.vue";
import { computePhase, type PhaseId } from "./useBattlePhase";
import { useWorkflowStore } from "../../stores/workflow";
import { useQuotesStore } from "../../stores/quotes";
import {
  brokerGetStatus,
  riskSnapshot,
  type BrokerStatus,
  type RiskSnapshot,
} from "../../broker/api";

const wf = useWorkflowStore();
const quotes = useQuotesStore();
const now = ref(new Date());
const preview = ref<PhaseId | null>(null);
const status = ref<BrokerStatus | null>(null);
const snap = ref<RiskSnapshot | null>(null);
const dock = ref<InstanceType<typeof OrderDock> | null>(null);
let clock = 0;
let poll = 0;
let disposed = false;

onMounted(async () => {
  void wf.loadToday();
  clock = window.setInterval(() => { now.value = new Date(); }, 1000);
  // 定时器先挂上再 await：否则首次请求期间组件被卸载会漏掉 poll 的清理。
  poll = window.setInterval(refresh, 5000);
  await refresh();
});
onBeforeUnmount(() => {
  disposed = true;
  window.clearInterval(clock);
  window.clearInterval(poll);
});

// 只轮询本地状态：同花顺通道的 broker_query_position 会激活交易窗口并抢焦点（同 BrokerConsole 不自动刷新），
// 持仓改由 OrderDock 在用户点卖出仓位档时按需拉取。
async function refresh() {
  try {
    const s = await brokerGetStatus();
    if (disposed) return;
    status.value = s;
  } catch { /* 未连接时保持上次状态 */ }
  try {
    const r = await riskSnapshot();
    if (disposed) return;
    snap.value = r;
  } catch { /* 模拟盘未初始化时忽略 */ }
  // 指令列表随同一轮轮询刷新（只查本地库，不驱动同花顺 GUI）。
  void wf.refreshInstructions();
}

const state = computed(() => computePhase(now.value));
const cash = computed(() => snap.value?.cash ?? 0);
const pct = computed(() => (snap.value?.positionPct ?? 0).toFixed(1));

function pick(code: string) {
  dock.value?.setCode(code);
  preview.value = null;
}
function money(n: number) {
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}
</script>

<template>
  <div class="bts" data-testid="battle-station">
    <header class="bts-head">
      <span class="bts-logo">作战台</span>
      <span class="bts-sub">现在该做什么，一屏看完</span>
      <span class="bts-acc mono">
        总资产 {{ money(snap?.equity ?? 0) }} · 现金 {{ money(cash) }} · 仓位 {{ pct }}%
      </span>
    </header>

    <PhaseTimeline :state="state" :preview="preview" @preview="preview = $event" />

    <div class="bts-body">
      <PhasePanel
        :state="state"
        :preview="preview"
        :quotes="quotes.map"
        @pick="pick"
        @preview="preview = $event"
      />
      <InstructionList :rows="wf.instructions" @pick="pick" />
    </div>

    <OrderDock ref="dock" :status="status" :cash="cash" @ordered="refresh" />
  </div>
</template>

<style scoped>
.bts { display: flex; flex-direction: column; gap: 10px; height: 100%; padding: 10px 12px; overflow: auto; }
.bts-head { display: flex; align-items: baseline; gap: 10px; }
.bts-logo { font-size: 13px; font-weight: 700; color: var(--accent); letter-spacing: 1px; }
.bts-sub { font-size: 11px; color: var(--text-dim); }
.bts-acc { margin-left: auto; font-size: 11px; color: var(--text-dim); }
.bts-body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
.mono { font-variant-numeric: tabular-nums; }
</style>
