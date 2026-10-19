<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import PhaseTimeline from "./PhaseTimeline.vue";
import PhasePanel from "./PhasePanel.vue";
import InstructionList from "./InstructionList.vue";
import OrderDock from "./OrderDock.vue";
import { computePhase, type PhaseId } from "./useBattlePhase";
import type { AlertRule } from "./instructionModel";
import { formatHitRate } from "./hitRateModel";
import { useWorkflowStore, todayStr } from "../../stores/workflow";
import { useQuotesStore } from "../../stores/quotes";
import { toast } from "../../composables/useToast";
import { confirmDialog } from "../../composables/useDialog";
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
const listRef = ref<InstanceType<typeof InstructionList> | null>(null);
const instrMsg = ref("");
const instrTone = ref<"ok" | "bad">("ok");
let clock = 0;
let poll = 0;
let hitPoll = 0;
let disposed = false;

onMounted(async () => {
  // 缺省 scope 走后端早盘启发式：今日未确认 → 今日作战卡；否则下一交易日。
  // 战斗台既要展示今日计划，也要承担盘后「确认明日作战卡」入口，故不再固定 scope="today"。
  void wf.loadToday();
  // P1-c 命中率：挂载取一次，之后每 5 分钟刷新（不随 5s 指令轮询打行情接口）。
  void wf.loadHitRate();
  hitPoll = window.setInterval(() => { void wf.loadHitRate(); }, 5 * 60 * 1000);
  clock = window.setInterval(() => { now.value = new Date(); }, 1000);
  // 定时器先挂上再 await：否则首次请求期间组件被卸载会漏掉 poll 的清理。
  poll = window.setInterval(refresh, 5000);
  await refresh();
});
onBeforeUnmount(() => {
  disposed = true;
  window.clearInterval(clock);
  window.clearInterval(poll);
  window.clearInterval(hitPoll);
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
const hit = computed(() => formatHitRate(wf.hitRate));
const cash = computed(() => snap.value?.cash ?? 0);
const pct = computed(() => (snap.value?.positionPct ?? 0).toFixed(1));

// P1-c 计划确认入口：今日未确认作战卡（早盘提醒直达）或下一交易日 draft（盘后）。
const planIsToday = computed(() => wf.battlePlan?.planDate === todayStr());
const canConfirmPlan = computed(() => !!wf.battlePlan && !wf.planConfirmed);
const planConfirmLabel = computed(() =>
  planIsToday.value ? "确认今日作战卡" : "确认明日作战卡",
);

// 一次确认弹窗后调后端按计划日确认；失败把中文错误透出到 toast（不静默）。
async function onConfirmPlan() {
  const plan = wf.battlePlan;
  if (!plan || wf.planConfirmed) return;
  const label = plan.planDate === todayStr() ? "确认今日作战卡" : "确认明日作战卡";
  const ok = await confirmDialog({
    title: label,
    message:
      `确认后将把 ${plan.planDate} 作战卡的 ${plan.instructions?.length ?? 0} 条指令转为触发预警，` +
      "并进入盯盘流程。确认后不可在盘前撤回，可重新生成作战卡。",
    confirmText: "确认",
    cancelText: "取消",
  });
  if (!ok) return;
  await wf.planConfirm(plan.planDate);
  if (wf.error) {
    toast.error(wf.error);
    return;
  }
  toast.success("作战卡已确认，指令已转预警");
}

function pick(code: string) {
  dock.value?.setCode(code);
  preview.value = null;
}

// P1-b 行内编辑：store 保存成功后收起面板并提示「待触发」；失败把中文错误留在面板内。
async function onSaveTrigger(instrId: number, rule: AlertRule) {
  try {
    await wf.saveInstructionTrigger(instrId, rule);
    const row = wf.instructions.find((x) => x.id === instrId);
    listRef.value?.finishEdit(instrId);
    instrTone.value = "ok";
    instrMsg.value = `触发条件已保存${row ? `：${row.name || row.code}` : ""}`;
    toast.success("触发条件已保存");
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    listRef.value?.finishEdit(instrId, msg);
    instrTone.value = "bad";
    instrMsg.value = msg;
  }
}

// P1-b 触发后一键下单：确认时只提交已有信号票，成功后刷新列表并显示结果。
async function onSubmitTicket(ticketId: number) {
  try {
    const info = await wf.confirmSubmitInstruction(ticketId);
    await wf.refreshInstructions();
    instrTone.value = "ok";
    instrMsg.value = `已提交：${info.code} ${info.side === "SELL" ? "卖出" : "买入"} ${info.vol} 股（${info.sigId}）`;
    toast.success(`委托已提交：${info.code} ${info.side === "SELL" ? "卖出" : "买入"} ${info.vol} 股`);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    instrTone.value = "bad";
    instrMsg.value = `提交失败：${msg}`;
    toast.error(instrMsg.value);
  } finally {
    listRef.value?.finishSubmit(ticketId);
  }
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
      <span data-testid="hit-rate" class="bts-hit mono" :title="hit.title">{{ hit.text }}</span>
      <button
        v-if="canConfirmPlan"
        type="button"
        class="bts-plan-btn"
        data-testid="confirm-plan"
        :disabled="wf.busy"
        @click="onConfirmPlan"
      >
        {{ wf.busy ? "确认中…" : planConfirmLabel }}
      </button>
      <span
        v-else-if="wf.battlePlan && wf.planConfirmed"
        class="bts-plan-ok"
        data-testid="plan-confirmed"
        >已确认</span
      >
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
      <InstructionList
        ref="listRef"
        :rows="wf.instructions"
        :status="status"
        :message="instrMsg"
        :message-tone="instrTone"
        @pick="pick"
        @save-trigger="onSaveTrigger"
        @submit="onSubmitTicket"
      />
    </div>

    <OrderDock ref="dock" :status="status" :cash="cash" @ordered="refresh" />
  </div>
</template>

<style scoped>
.bts { display: flex; flex-direction: column; gap: 10px; height: 100%; padding: 10px 12px; overflow: auto; }
.bts-head { display: flex; align-items: baseline; gap: 10px; padding-right: 72px; }
.bts-logo { font-size: 13px; font-weight: 700; color: var(--accent); letter-spacing: 1px; }
.bts-sub { font-size: 11px; color: var(--text-dim); }
.bts-acc { margin-left: auto; font-size: 11px; color: var(--text-dim); }
.bts-hit {
  flex: none; font-size: 11px; color: var(--text-dim); white-space: nowrap; cursor: help;
  padding: 1px 7px; border: 1px solid var(--border); border-radius: 999px;
}
.bts-plan-btn {
  flex: none; font-size: 11.5px; font-weight: 700; color: #1a1408;
  background: var(--accent, #e8c878); border: 1px solid transparent;
  border-radius: 7px; padding: 3px 10px; cursor: pointer; white-space: nowrap;
}
.bts-plan-btn:hover { filter: brightness(1.08); }
.bts-plan-btn:disabled { opacity: .6; cursor: not-allowed; }
.bts-plan-ok {
  flex: none; font-size: 11px; font-weight: 700; color: var(--down, #2fbf95);
  border: 1px solid rgba(47, 191, 149, .5); border-radius: 999px; padding: 1px 8px;
  white-space: nowrap;
}
.bts-body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
.mono { font-variant-numeric: tabular-nums; }
</style>
