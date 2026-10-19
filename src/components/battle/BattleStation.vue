<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import PhaseTimeline from "./PhaseTimeline.vue";
import PhasePanel from "./PhasePanel.vue";
import OrderDock from "./OrderDock.vue";
import { computePhase, type PhaseId } from "./useBattlePhase";
import { useWorkflowStore } from "../../stores/workflow";
import { useQuotesStore } from "../../stores/quotes";
import {
  brokerGetStatus,
  brokerQueryPosition,
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
const positionList = ref<{ code: string; availVol: number }[]>([]);
const dock = ref<InstanceType<typeof OrderDock> | null>(null);
let clock = 0;
let poll = 0;

onMounted(async () => {
  void wf.loadToday();
  clock = window.setInterval(() => { now.value = new Date(); }, 1000);
  await refresh();
  poll = window.setInterval(refresh, 5000);
});
onBeforeUnmount(() => {
  window.clearInterval(clock);
  window.clearInterval(poll);
});

async function refresh() {
  try { status.value = await brokerGetStatus(); } catch { /* 未连接时保持上次状态 */ }
  try { snap.value = await riskSnapshot(); } catch { /* 模拟盘未初始化时忽略 */ }
  try {
    const r = await brokerQueryPosition();
    positionList.value = (r.positions ?? []).map((p) => ({ code: p.code, availVol: p.avail ?? 0 }));
  } catch { positionList.value = []; }
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
    </div>

    <OrderDock ref="dock" :status="status" :cash="cash" :positions="positionList" @ordered="refresh" />
  </div>
</template>

<style scoped>
.bts { display: flex; flex-direction: column; gap: 10px; height: 100%; padding: 10px 12px; overflow: auto; }
.bts-head { display: flex; align-items: baseline; gap: 10px; }
.bts-logo { font-size: 13px; font-weight: 700; color: var(--accent); letter-spacing: 1px; }
.bts-sub { font-size: 11px; color: var(--text-dim); }
.bts-acc { margin-left: auto; font-size: 11px; color: var(--text-dim); }
.bts-body { flex: 1; min-height: 0; }
.mono { font-variant-numeric: tabular-nums; }
</style>
