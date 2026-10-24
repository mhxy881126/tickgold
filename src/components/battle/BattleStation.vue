<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import PhaseTimeline from "./PhaseTimeline.vue";
import PhasePanel from "./PhasePanel.vue";
import InstructionList from "./InstructionList.vue";
import OrderDock from "./OrderDock.vue";
import CopilotBar from "./CopilotBar.vue";
import { computePhase, type PhaseId } from "./useBattlePhase";
import type { AlertRule } from "./instructionModel";
import { tagLabel } from "./instructionModel";
import { formatHitRate } from "./hitRateModel";
import { useWorkflowStore, todayStr } from "../../stores/workflow";
import { useQuotesStore } from "../../stores/quotes";
import { consumeOrderSide, pendingOrderSide, consumeOrderPrefill, pendingPrice } from "../../stores/quickAction";
import { toast } from "../../composables/useToast";
import { confirmDialog } from "../../composables/useDialog";
import { formatMs, orderTimingSummary, type OrderTimingSummary } from "../../broker/timing";
import {
  brokerGetStatus,
  brokerLiveUsage,
  riskSnapshot,
  type BrokerStatus,
  type LiveUsage,
  type RiskSnapshot,
} from "../../broker/api";

const wf = useWorkflowStore();
const quotes = useQuotesStore();
const now = ref(new Date());
const preview = ref<PhaseId | null>(null);
const status = ref<BrokerStatus | null>(null);
const snap = ref<RiskSnapshot | null>(null);
const timing = ref<OrderTimingSummary | null>(null);
const usage = ref<LiveUsage | null>(null);
const dock = ref<InstanceType<typeof OrderDock> | null>(null);
const listRef = ref<InstanceType<typeof InstructionList> | null>(null);
const instrMsg = ref("");
const instrTone = ref<"ok" | "bad">("ok");
let clock = 0;
let poll = 0;
let hitPoll = 0;
let disposed = false;

onMounted(async () => {
  // B/S 快捷键：卡片挂载前方向已入队，这里消费一次并切方向 + 聚焦代码框。
  // 放在任何 await 之前，保证首帧就是目标方向（避免先 BUY 再跳 SELL 的闪烁）。
  const side = consumeOrderSide();
  if (side) dock.value?.focusSide(side);
  // P3-b 盘口/分时点击：挂载前到达的预填同样先消费，首帧即填好代码/方向/价格。
  // 放在 await 之前；预填自带方向时以后到的预填为准，未带方向则沿用上面的快捷键方向。
  const prefill = consumeOrderPrefill();
  if (prefill) dock.value?.applyPrefill(prefill);
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

// 作战台已挂载时（例如正看着作战台再按 S）也要消费待处理方向：
// 只在 mount 消费会留下一个「下次重挂载才生效」的陈旧方向，容易在无关场景误切方向。
watch(pendingOrderSide, (side) => {
  if (!side) return;
  const next = consumeOrderSide();
  if (next) dock.value?.focusSide(next);
});

// P3-b 盘口/分时点击：作战台已挂载时（自由布局里 K 线卡与作战台同屏）立即预填；
// 未挂载时 pendingPrice 保留，等下次挂载由 onMounted 消费（与 pendingOrderSide 同一套逻辑）。
watch(pendingPrice, (px) => {
  if (px == null) return;
  const prefill = consumeOrderPrefill();
  if (prefill) dock.value?.applyPrefill(prefill);
});

// 只轮询本地状态：同花顺通道的 broker_query_position 会激活交易窗口并抢焦点（同 BrokerConsole 不自动刷新），
// 持仓改由 OrderDock 在用户点卖出仓位档时按需拉取。
async function refresh() {
  try {
    const s = await brokerGetStatus();
    if (disposed) return;
    status.value = s;
    // 实盘通道且未武装时拉一次武装进度（本地查询，开销小；已武装则无需提示）。
    const liveChannel = s && s.kind === "client" && !s.clientSim && s.windowSim !== true;
    if (liveChannel && !s.liveEnabled) {
      try {
        usage.value = await brokerLiveUsage();
      } catch {
        usage.value = null;
      }
    } else if (liveChannel && s.liveEnabled) {
      usage.value = null;
    }
  } catch { /* 未连接时保持上次状态 */ }
  try {
    const r = await riskSnapshot();
    if (disposed) return;
    snap.value = r;
  } catch { /* 模拟盘未初始化时忽略 */ }
  // 指令列表随同一轮轮询刷新（只查本地库，不驱动同花顺 GUI）。
  void wf.refreshInstructions();
  // P2-a 下单耗时：放在 await 之后读取，确保本轮下单产生的记录已落盘；无记录时隐藏。
  timing.value = orderTimingSummary();
}

const state = computed(() => computePhase(now.value));
const hit = computed(() => formatHitRate(wf.hitRate));
// P2-a 下单耗时文案：`最近下单 1.2s · 2 击 · 中位 1.5s`，无样本时不渲染。
const timingText = computed(() => {
  const t = timing.value;
  if (!t) return "";
  return `最近下单 ${formatMs(t.lastMs)} · ${t.clicks} 击 · 中位 ${formatMs(t.medianMs)}`;
});
const cash = computed(() => snap.value?.cash ?? 0);
const pct = computed(() => (snap.value?.positionPct ?? 0).toFixed(1));

// ===== P4 实盘武装进度卡：实盘通道已选但未武装时，告诉用户还差哪几步、一键去设置 =====
// 通道语义与 OrderDock 一致：client 且非模拟窗口才算实盘通道。
const isLiveChannel = computed(() => {
  const s = status.value;
  return !!s && s.kind === "client" && !s.clientSim && s.windowSim !== true;
});
// 可自动检测的武装步骤（第 4 步「合规确认 + 输入风险确认」在设置页完成，不在此计分）。
const liveSteps = computed(() => {
  const u = usage.value;
  return [
    { label: "实盘限额", done: !!u && u.singleLimit > 0 && u.dailyLimit > 0 },
    { label: "标的白名单", done: !!u && u.whitelist.length > 0 },
    { label: "模拟演练", done: !!u && u.drillPassed },
  ];
});
const liveDoneCount = computed(() => liveSteps.value.filter((x) => x.done).length);
const liveArmed = computed(() => !!status.value && status.value.liveEnabled === true);
// 未连接 / 模拟通道 / 已武装时都不显示进度卡；仅实盘通道未武装时显示。
const showLiveArmCard = computed(() => isLiveChannel.value && !liveArmed.value);
function goArmSettings() {
  // 与 App.vue 的 open-ai-settings / open-pro-settings 同一模式：通知主窗口打开设置并定位券商页。
  window.dispatchEvent(new CustomEvent("open-broker-settings"));
}

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

// P1-c 确认后进入盯盘：计划已确认且尚未启动时给一键入口。
const canStartWatch = computed(() => wf.planConfirmed && !wf.watchStarted);

async function onWatchStart() {
  await wf.watchStart();
  if (wf.error) {
    toast.error(wf.error);
    return;
  }
  toast.success("盯盘已启动");
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

// P3-c 指令打标：store 用后端返回的最新列表覆盖，成功后提示标签，失败提示并把下拉复位。
async function onSetTag(instrId: number, tag: string) {
  try {
    await wf.setInstructionTag(instrId, tag);
    const row = wf.instructions.find((x) => x.id === instrId);
    instrTone.value = "ok";
    instrMsg.value = tag
      ? `标签已保存${row ? `：${row.name || row.code}` : ""} → ${tagLabel(tag)}`
      : `标签已清除${row ? `：${row.name || row.code}` : ""}`;
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    instrTone.value = "bad";
    instrMsg.value = msg;
    toast.error(msg);
    // 失败时用后端真值重刷，避免下拉停留在未落库的标签上。
    await wf.refreshInstructions();
  }
}

// P1-b 触发后一键下单：确认时只提交已有信号票，成功后刷新列表并显示结果。
async function onSubmitTicket(ticketId: number) {
  let ok = false;
  try {
    const info = await wf.confirmSubmitInstruction(ticketId);
    ok = true;
    // store 已 resolve：先结算耗时并刷新头部，不把随后的指令列表刷新算进下单耗时。
    listRef.value?.settleSubmit(ticketId, true);
    timing.value = orderTimingSummary();
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
    // 解除「提交中…」；失败路径兜底结算耗时，成功路径已在上面结算（幂等）。
    listRef.value?.finishSubmit(ticketId, ok);
    if (!ok) timing.value = orderTimingSummary();
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
      <span
        v-if="timing"
        data-testid="order-timing"
        class="bts-timing mono"
        title="最近 20 笔「确认下单 → broker 返回」耗时（本地记录，不参与风控）"
        >{{ timingText }}</span
      >
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
        v-if="wf.battlePlan && wf.planConfirmed"
        class="bts-plan-ok"
        data-testid="plan-confirmed"
        >已确认</span
      >
      <button
        v-if="canStartWatch"
        type="button"
        class="bts-plan-btn"
        data-testid="watch-start"
        :disabled="wf.busy"
        @click="onWatchStart"
      >
        {{ wf.busy ? "启动中…" : "开始盯盘" }}
      </button>
      <span
        v-if="wf.watchStarted"
        class="bts-plan-ok"
        data-testid="watch-started"
        >盯盘已启动</span
      >
    </header>

    <!-- P4 实盘武装进度卡：代替原来的「实盘未启用」红字，明确还差几步 + 一键去设置 -->
    <div v-if="showLiveArmCard" class="bts-arm" data-testid="live-arm-card">
      <div class="bts-arm-head">
        <span class="bts-arm-title">实盘通道已就绪 · 还差 {{ 3 - liveDoneCount }} 步武装</span>
        <button type="button" class="bts-arm-go" @click="goArmSettings">去设置武装实盘 →</button>
      </div>
      <div class="bts-arm-steps">
        <span
          v-for="(st, i) in liveSteps"
          :key="st.label"
          class="bts-arm-step"
          :class="{ done: st.done }"
        >
          {{ st.done ? "✓" : `${i + 1}` }} {{ st.label }}
        </span>
      </div>
      <div class="bts-arm-sub">第 4 步「合规确认 + 风险确认」在设置页完成；武装前不会提交任何真实委托。</div>
    </div>
    <div v-if="liveArmed" class="bts-arm-ok" data-testid="live-arm-ok">实盘已武装 · 每笔需人工确认</div>

    <!-- P3-a Copilot：独立第二行，避免挤压既有头部（资产 / 命中率 / 确认按钮）。 -->
    <CopilotBar />

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
        @set-tag="onSetTag"
        @submit="onSubmitTicket"
      />
    </div>

    <OrderDock ref="dock" :status="status" :cash="cash" @ordered="refresh" />
  </div>
</template>

<style scoped>
.bts { display: flex; flex-direction: column; gap: 10px; height: 100%; padding: 10px 12px; overflow: auto; }
.bts-head { display: flex; align-items: baseline; gap: 10px; row-gap: 4px; flex-wrap: wrap; padding-right: 72px; }
.bts-logo { font-size: 13px; font-weight: 700; color: var(--accent); letter-spacing: 1px; }
.bts-sub { font-size: 11px; color: var(--text-dim); }
.bts-acc { margin-left: auto; font-size: 11px; color: var(--text-dim); }
.bts-hit {
  flex: none; font-size: 11px; color: var(--text-dim); white-space: nowrap; cursor: help;
  padding: 1px 7px; border: 1px solid var(--border); border-radius: 999px;
}
.bts-timing {
  flex: none; font-size: 11px; color: var(--text-dim); white-space: nowrap;
  padding: 1px 7px; border: 1px solid var(--border); border-radius: 999px;
}
.bts-plan-btn {
  flex: none; font-size: 11.5px; font-weight: 700; color: var(--accent-contrast);
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
/* P4 实盘武装进度卡 */
.bts-arm {
  display: flex; flex-direction: column; gap: 5px;
  border: 1px solid rgba(232, 200, 120, .45);
  border-radius: 9px;
  background: linear-gradient(135deg, rgba(232, 200, 120, .10), rgba(232, 200, 120, .03));
  padding: 8px 12px;
}
.bts-arm-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.bts-arm-title { font-size: 12px; font-weight: 700; color: var(--accent); }
.bts-arm-go {
  flex: none; font-size: 11px; font-weight: 700; color: var(--accent-contrast);
  background: var(--accent, #e8c878); border: 1px solid transparent;
  border-radius: 6px; padding: 3px 10px; cursor: pointer; white-space: nowrap;
}
.bts-arm-go:hover { filter: brightness(1.08); }
.bts-arm-steps { display: flex; gap: 6px; flex-wrap: wrap; }
.bts-arm-step {
  font-size: 10.5px; padding: 1px 8px; border-radius: 999px;
  border: 1px solid var(--border); color: var(--text-dim);
}
.bts-arm-step.done { color: var(--down, #2fbf95); border-color: rgba(47, 191, 149, .5); }
.bts-arm-sub { font-size: 10.5px; color: var(--text-dim); }
.bts-arm-ok {
  flex: none; font-size: 11px; font-weight: 700; color: var(--down, #2fbf95);
  border: 1px solid rgba(47, 191, 149, .5); border-radius: 999px; padding: 1px 8px;
  align-self: flex-start; white-space: nowrap;
}
.bts-body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
.mono { font-variant-numeric: tabular-nums; }
</style>
