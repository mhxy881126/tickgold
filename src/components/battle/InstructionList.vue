<script setup lang="ts">
import { computed, ref } from "vue";
import { confirmDialog } from "../../composables/useDialog";
import { recordOrderTiming } from "../../broker/timing";
import InstructionEditor from "./InstructionEditor.vue";
import {
  canSubmitInstruction,
  instructionActions,
  instructionStatusMeta,
  submitBlockReason,
  tagLabel,
  INSTRUCTION_TAG_OPTIONS,
  triggerHint,
  type AlertRule,
  type BrokerGateStatus,
  type InstructionActions,
  type InstructionRow,
  type StateMeta,
} from "./instructionModel";

const props = defineProps<{
  rows: InstructionRow[];
  /** 券商状态：复用下单条口径决定「确认下单」是否可点；未传视为未知（不允许提交）。 */
  status?: BrokerGateStatus | null;
  /** 动作结果一行提示（保存 / 提交后由作战台写入）。 */
  message?: string;
  /** 提示色调：ok=成功（默认），bad=失败。 */
  messageTone?: "ok" | "bad";
}>();
const emit = defineEmits<{
  (e: "pick", code: string): void;
  (e: "save-trigger", instrId: number, rule: AlertRule): void;
  (e: "set-tag", instrId: number, tag: string): void;
  (e: "submit", ticketId: number): void;
}>();

const editingId = ref(0);
const saving = ref(false);
const editorError = ref("");
const submittingId = ref(0);
// P2-a 耗时埋点：确认点击 → 父级 store 返回（finishSubmit）为一次下单耗时。
let submitStartedAt = -1;
let submitTicketId = 0;
// 只展示前 5 条（与 P1-a 一致，保持作战台一屏紧凑）；表头计数仍是全量。
const visibleRows = computed(() => props.rows.slice(0, 5));

function tierLabel(tier: string): string {
  return tier === "candidate" ? "备选" : tier === "trigger" ? "触发" : "观察";
}

// 状态文案 / 编辑与提交门控 / 按钮文案 / 闸门原因全部来自 instructionModel 的纯函数，组件只调用。
function actionsOf(r: InstructionRow): InstructionActions {
  return instructionActions(r, props.status ?? null);
}
function statusOf(r: InstructionRow): StateMeta {
  return instructionStatusMeta(r);
}

const blockReason = computed(() => submitBlockReason(props.status ?? null));
const hasSubmittable = computed(() => visibleRows.value.some((r) => canSubmitInstruction(r)));

function openEdit(r: InstructionRow) {
  editingId.value = r.id;
  saving.value = false;
  editorError.value = "";
}

// P3-c：打标下拉。先把手选值回滚到行数据，成功后由 store 返回的新列表驱动；
// 失败时也保持原位（不把错误标签留在下拉框里）。
function onTag(r: InstructionRow, e: Event) {
  const el = e.target as HTMLSelectElement;
  const next = el.value;
  const current = r.tag ?? "";
  if (next === current) return;
  el.value = current;
  emit("set-tag", r.id, next);
}

function closeEdit() {
  editingId.value = 0;
  saving.value = false;
  editorError.value = "";
}
function save(r: InstructionRow, rule: AlertRule) {
  saving.value = true;
  editorError.value = "";
  emit("save-trigger", r.id, rule);
}

/** 触发后一键下单：只弹一次确认，确认后把已有的信号票交给 store（后端走 submit_with_sig）。 */
async function askSubmit(r: InstructionRow) {
  const action = actionsOf(r);
  if (!action.canSubmit || action.blockReason || submittingId.value) return;
  const sideText = r.side === "SELL" ? "卖出" : "买入";
  const priceText = r.price > 0 ? `限价 ${r.price.toFixed(2)}` : "按触发价";
  const ok = await confirmDialog({
    title: "确认下单",
    message:
      `确认提交 ${r.name || r.code}（${r.code}）${sideText} ${r.vol} 股？\n` +
      `${priceText}；提交时走全部风控闸门（熔断 / 连接 / 白名单 / 限价 / 新鲜度）。\n` +
      `沿用触发时生成的信号票，不会新建第二张票。`,
    confirmText: "确认提交",
  });
  if (!ok) return;
  submittingId.value = r.ticketId;
  submitStartedAt = performance.now();
  submitTicketId = r.ticketId;
  emit("submit", r.ticketId);
}

/** 父级保存完成回调：成功收起面板，失败把中文错误留在面板内。 */
function finishEdit(instrId: number, error = "") {
  if (editingId.value !== instrId) return;
  saving.value = false;
  if (error) {
    editorError.value = error;
    return;
  }
  closeEdit();
}
/** 父级在 store resolve 后立即调用：只结算耗时（成功/失败都记），不解除「提交中…」。 */
function settleSubmit(ticketId: number, ok: boolean) {
  if (submitStartedAt >= 0 && submitTicketId === ticketId) {
    recordOrderTiming({
      ms: performance.now() - submitStartedAt,
      clicks: 2,
      ok,
    });
    submitStartedAt = -1;
    submitTicketId = 0;
  }
}
/** 父级整体结束回调：解除「提交中…」并兜底结算耗时（成功路径已结算，幂等）。 */
function finishSubmit(ticketId: number, ok = true) {
  if (submittingId.value === ticketId) submittingId.value = 0;
  settleSubmit(ticketId, ok);
}
defineExpose({ finishEdit, finishSubmit, settleSubmit });
</script>

<template>
  <section class="il" data-testid="instruction-list">
    <header class="il-head">
      <span class="il-title">今日指令</span>
      <span class="il-count">{{ rows.length }}</span>
      <span
        v-if="message"
        class="il-msg"
        :class="{ bad: messageTone === 'bad' }"
        data-testid="instr-action-msg"
      >{{ message }}</span>
    </header>
    <p v-if="blockReason && hasSubmittable" class="il-warn" data-testid="instr-submit-hint">
      {{ blockReason }}
    </p>
    <p v-if="!rows.length" class="il-empty">今日无计划指令，确认作战卡后自动生成</p>
    <div v-else class="il-rows">
      <template v-for="r in visibleRows" :key="r.id">
        <InstructionEditor
          v-if="editingId === r.id"
          :row="r"
          :rule="r.alertRule"
          :trigger-json="r.triggerJson"
          :saving="saving"
          :error="editorError"
          @save="save(r, $event)"
          @cancel="closeEdit"
        />
        <div v-else class="il-row">
          <button type="button" class="il-main" @click="emit('pick', r.code)">
            <span class="il-tier" :class="`tier-${r.tier}`">{{ tierLabel(r.tier) }}</span>
            <span class="il-code mono">{{ r.code }}</span>
            <span class="il-name">{{ r.name }}</span>
            <span class="il-hint">{{ triggerHint(r.triggerJson) }}</span>
          </button>
          <!-- P3-c 指令打标：chip 回显 + 小下拉（清除/逻辑/情绪/跟风），标签用于次日代码权重。 -->
          <span v-if="tagLabel(r.tag)" class="il-tag-chip">{{ tagLabel(r.tag) }}</span>
          <select
            class="il-tag"
            data-testid="instr-tag"
            :value="r.tag ?? ''"
            title="指令标签（逻辑 / 情绪 / 跟风），用于次日代码权重"
            @change="onTag(r, $event)"
          >
            <option v-for="o in INSTRUCTION_TAG_OPTIONS" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
          <!-- 状态徽标：已有委托按委托状态，否则由票面状态覆盖执行状态（confirmed→待提交、rejected→已拒绝）。 -->
          <span
            class="il-state"
            :class="`tone-${statusOf(r).tone}`"
            :data-state="r.state"
            :data-ticket="r.ticketStatus"
            :data-order="r.orderStatus"
            :data-testid="r.hasOrder ? 'instr-order-state' : 'instr-state'"
          >{{ statusOf(r).label }}</span>
          <template v-if="!r.hasOrder">
            <button
              v-if="actionsOf(r).canSubmit"
              type="button"
              class="il-act primary"
              data-testid="instr-submit"
              :disabled="!!actionsOf(r).blockReason || submittingId === r.ticketId"
              :title="actionsOf(r).blockReason || '一次确认后提交已有信号票'"
              @click="askSubmit(r)"
            >{{ submittingId === r.ticketId ? "提交中…" : actionsOf(r).submitLabel }}</button>
            <button
              v-if="actionsOf(r).canEdit"
              type="button"
              class="il-act"
              data-testid="instr-edit"
              title="修改触发条件（保存后重建条件单）"
              @click="openEdit(r)"
            >编辑</button>
          </template>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.il { border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; background: var(--bg-card); }
.il-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.il-title { font-size: 12px; font-weight: 700; }
.il-count { font-size: 11px; color: var(--text-dim); }
.il-msg { margin-left: auto; font-size: 10.5px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.il-msg.bad { color: var(--up); }
.il-warn { margin: 0 0 5px; font-size: 10.5px; color: var(--up); }
.il-empty { margin: 0; font-size: 11.5px; color: var(--text-dim); }
.il-rows { display: flex; flex-direction: column; gap: 3px; }
.il-row { display: flex; align-items: center; gap: 6px; padding: 2px 4px; border: 1px solid transparent; border-radius: 6px; }
.il-row:hover { background: var(--bg-hover); }
.il-main { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; padding: 1px 2px; border: none; background: transparent; color: var(--text); font-size: 11.5px; cursor: pointer; text-align: left; }
.il-tier { flex: none; padding: 0 5px; border-radius: 4px; font-size: 10px; border: 1px solid var(--border); color: var(--text-dim); }
.il-tier.tier-candidate { color: var(--accent); border-color: var(--accent); }
.il-code { flex: none; }
.il-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.il-hint { flex: none; color: var(--text-dim); font-size: 10.5px; }
.il-tag-chip { flex: none; padding: 0 5px; border-radius: 4px; font-size: 10px; color: var(--accent); border: 1px solid var(--accent); }
.il-tag { flex: none; max-width: 58px; padding: 0 2px; border: 1px solid var(--border); border-radius: 4px; background: transparent; color: var(--text-dim); font-size: 10.5px; cursor: pointer; }
.il-tag:hover, .il-tag:focus { color: var(--accent); border-color: var(--accent); outline: none; }
.il-state { flex: none; padding: 0 6px; border-radius: 4px; font-size: 10.5px; border: 1px solid var(--border); }
.il-state.tone-info { color: var(--blue); border-color: var(--blue); }
.il-state.tone-gold { color: var(--accent); border-color: var(--accent); }
.il-state.tone-up { color: var(--up); border-color: var(--up); }
.il-state.tone-muted { color: var(--text-dim); }
.il-act { flex: none; padding: 1px 7px; border-radius: 5px; border: 1px solid var(--border); background: transparent; color: var(--text-dim); font-size: 10.5px; cursor: pointer; }
.il-act:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.il-act:disabled { opacity: 0.45; cursor: not-allowed; }
.il-act.primary { color: var(--accent); border-color: var(--accent); }
.il-act.primary:disabled { color: var(--text-dim); border-color: var(--border); }
.mono { font-variant-numeric: tabular-nums; }
</style>
