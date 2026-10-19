<script setup lang="ts">
// P1-b 行内编辑触发条件：6 个方向/过滤阈值 + 方向 + 数量 + 模拟盘自动执行开关。
// 面板只负责表单与本地校验，保存请求由父级走 store（失败再回填 error）。
import { computed, onMounted, reactive, ref } from "vue";
import {
  directionHint,
  formToRule,
  parseAlertRule,
  ruleToForm,
  triggerJsonToRule,
  validateForm,
  type AlertRule,
  type InstructionRow,
  type TriggerForm,
} from "./instructionModel";

const props = defineProps<{
  row: InstructionRow;
  /** 原始 alert_rule 文本（workflow 行不带该字段，由 store 从 plan.instructions 关联）。 */
  rule?: string;
  /** 物化叶子 JSON：没有 alert_rule 时的回填兜底。 */
  triggerJson?: string;
  /** 保存请求进行中（父级设置）。 */
  saving?: boolean;
  /** 后端/父级返回的中文错误（父级设置）。 */
  error?: string;
}>();

const emit = defineEmits<{
  (e: "save", rule: AlertRule): void;
  (e: "cancel"): void;
}>();

// 编辑前规则：alert_rule 优先，缺省用物化叶子反推（旧库 / fake 后端只有 triggerJson）。
const initialRule: AlertRule = (() => {
  const raw = (props.rule ?? "").trim();
  return raw ? parseAlertRule(raw) : triggerJsonToRule(props.triggerJson ?? "");
})();

const form = reactive<TriggerForm>(ruleToForm(initialRule));
// 行上的有效字段兜底：规则未显式给方向/数量/开关时（如仅从叶子回填），以列表行为准。
const ruleSide = initialRule.side;
const ruleVol = Number(initialRule.vol);
if (ruleSide !== "BUY" && ruleSide !== "SELL") {
  const side = String(props.row.side ?? "").toUpperCase();
  if (side === "BUY" || side === "SELL") form.side = side;
}
if (!(Number.isFinite(ruleVol) && ruleVol > 0) && props.row.vol > 0) {
  form.vol = String(props.row.vol);
}
if (typeof initialRule.autoConfirm !== "boolean") {
  form.autoConfirm = props.row.autoConfirm !== false;
}

const localError = ref("");
const shownError = computed(() => localError.value || props.error || "");
const hint = computed(() => directionHint(form));

// 面板不编辑、但会随规则原样回传的条件（回踩 / 封板 / 炸板 / 涨速窗口），提示避免误以为被清掉。
const carriedText = computed(() => {
  const parts: string[] = [];
  if ((Number(form.downPrice) || 0) > 0) parts.push(`价格≤${form.downPrice}`);
  if ((Number(form.downPct) || 0) < 0) parts.push(`跌幅≤${form.downPct}%`);
  if ((Number(form.downSpeed) || 0) > 0) parts.push(`跌速≥${form.downSpeed}`);
  if ((Number(form.sealLimitUp) || 0) > 0) parts.push("封涨停");
  if ((Number(form.sealLimitDown) || 0) > 0) parts.push("封跌停");
  if ((Number(form.brokenLimit) || 0) > 0) parts.push("炸板");
  const windowSec = String(form.speedWindowSec).trim();
  if (windowSec) parts.push(`涨速窗口${windowSec}s`);
  return parts.join(" · ");
});

const priceEl = ref<HTMLInputElement | null>(null);
onMounted(() => {
  priceEl.value?.focus();
});

function save() {
  if (props.saving) return;
  localError.value = "";
  const invalid = validateForm(form);
  if (invalid) {
    localError.value = invalid;
    return;
  }
  try {
    // 传 initialRule：面板里被清空的旧条件显式传 null（后端是合并语义）。
    emit("save", formToRule(form, initialRule));
  } catch (e) {
    localError.value = (e as Error)?.message ?? String(e);
  }
}

function cancel() {
  if (props.saving) return;
  localError.value = "";
  emit("cancel");
}
</script>

<template>
  <!-- novalidate：number 输入的原生校验提示是英文气泡，这里统一用中文内联校验。 -->
  <form class="ie" data-testid="instr-edit-panel" novalidate @submit.prevent="save">
    <div class="ie-head">
      <span class="ie-title">编辑触发条件</span>
      <span class="ie-stock">{{ row.name || row.code }} <span class="mono">{{ row.code }}</span></span>
      <span class="ie-tip">保存后旧条件单作废并按新规则重建</span>
    </div>

    <div class="ie-grid">
      <label class="ie-field">价格≥
        <input
          ref="priceEl"
          v-model="form.upPrice"
          data-testid="instr-up-price"
          class="ie-inp mono"
          type="number"
          step="0.01"
          min="0"
          placeholder="未设置"
        />
      </label>
      <label class="ie-field">涨幅≥（%）
        <input
          v-model="form.upPct"
          data-testid="instr-up-pct"
          class="ie-inp mono"
          type="number"
          step="0.1"
          min="0"
          placeholder="未设置"
        />
      </label>
      <label class="ie-field">量比≥
        <input
          v-model="form.minVolumeRatio"
          data-testid="instr-vol-ratio"
          class="ie-inp mono"
          type="number"
          step="0.1"
          min="0"
          placeholder="未设置"
        />
      </label>
      <label class="ie-field">换手≥（%）
        <input
          v-model="form.minTurnover"
          data-testid="instr-turnover"
          class="ie-inp mono"
          type="number"
          step="0.1"
          min="0"
          placeholder="未设置"
        />
      </label>
      <label class="ie-field">成交额≥（亿）
        <input
          v-model="form.minAmount"
          data-testid="instr-amount"
          class="ie-inp mono"
          type="number"
          step="0.1"
          min="0"
          placeholder="未设置"
        />
      </label>
      <label class="ie-field">涨速≥
        <input
          v-model="form.riseSpeed"
          data-testid="instr-rise-speed"
          class="ie-inp mono"
          type="number"
          step="0.1"
          min="0"
          placeholder="未设置"
        />
      </label>
      <label class="ie-field">方向
        <select v-model="form.side" data-testid="instr-side" class="ie-inp">
          <option value="BUY">买入</option>
          <option value="SELL">卖出</option>
        </select>
      </label>
      <label class="ie-field">数量（股）
        <input
          v-model="form.vol"
          data-testid="instr-vol"
          class="ie-inp mono"
          type="number"
          step="100"
          min="100"
        />
      </label>
      <label class="ie-check" title="只影响模拟盘；实盘始终需要人工确认">
        <input v-model="form.autoConfirm" data-testid="instr-auto-confirm" type="checkbox" />
        模拟盘自动执行
      </label>
    </div>

    <p v-if="hint" class="ie-hint" data-testid="instr-direction-hint">{{ hint }}</p>
    <p v-if="carriedText" class="ie-carry">保留未在面板编辑的条件：{{ carriedText }}</p>
    <p v-if="shownError" class="ie-error" data-testid="instr-edit-error">{{ shownError }}</p>

    <div class="ie-actions">
      <button type="button" class="ie-btn ghost" data-testid="instr-cancel" :disabled="saving" @click="cancel">
        取消
      </button>
      <button type="submit" class="ie-btn primary" data-testid="instr-save" :disabled="saving">
        {{ saving ? "保存中…" : "保存" }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.ie { flex: none; width: 100%; box-sizing: border-box; margin: 1px 0 2px; padding: 6px 8px 7px; border: 1px solid var(--accent); border-radius: 8px; background: var(--bg-panel); }
.ie-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; }
.ie-title { font-size: 11.5px; font-weight: 700; color: var(--accent); }
.ie-stock { font-size: 11px; color: var(--text); }
.ie-tip { margin-left: auto; font-size: 10px; color: var(--text-dim); }
.ie-grid { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 5px 8px; }
.ie-field { display: flex; flex-direction: column; gap: 2px; font-size: 10px; color: var(--text-dim); }
.ie-inp { width: 84px; padding: 2px 5px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-input, transparent); color: var(--text); font-size: 11px; }
.ie-inp:focus { outline: none; border-color: var(--accent); }
.ie-check { display: flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--text-dim); cursor: pointer; padding-bottom: 3px; }
.ie-hint { margin: 5px 0 0; font-size: 10.5px; color: var(--accent); }
.ie-carry { margin: 4px 0 0; font-size: 10px; color: var(--text-dim); }
.ie-error { margin: 5px 0 0; font-size: 10.5px; color: #ff7a86; }
.ie-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
.ie-btn { padding: 2px 12px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text); font-size: 11.5px; cursor: pointer; }
.ie-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ie-btn.primary { background: var(--accent); border-color: var(--accent); color: #14110a; font-weight: 700; }
.ie-btn.ghost { color: var(--text-dim); }
.mono { font-variant-numeric: tabular-nums; }
</style>
