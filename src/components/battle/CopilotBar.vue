<script setup lang="ts">
// P3-a Copilot：一句话 → 条件单草稿 → 用户确认后创建。
// 只创建本地条件单（co_create），不产生委托；名称从行情缓存补全，补不到显示代码。
import { computed, ref } from "vue";
import { coCreate } from "../../broker/co";
import { toast } from "../../composables/useToast";
import { useQuotesStore } from "../../stores/quotes";
import { useWorkflowStore } from "../../stores/workflow";
import { parseCommand, type CopilotDraft } from "../../copilot/parseCommand";

const quotes = useQuotesStore();
const wf = useWorkflowStore();

const text = ref("");
const draft = ref<CopilotDraft | null>(null);
const error = ref("");
const busy = ref(false);

const previewText = computed(() => {
  const d = draft.value;
  if (!d) return "";
  return d.name && d.name !== d.code ? `${d.name} ${d.summary}` : d.summary;
});

function onInput() {
  // 句子改了就丢弃旧草稿：避免「改了文字却确认了上一版价格」。
  draft.value = null;
  error.value = "";
}

function onParse() {
  if (busy.value) return;
  const r = parseCommand(text.value);
  if (!r.ok) {
    draft.value = null;
    error.value = r.error;
    return;
  }
  error.value = "";
  const name = quotes.map[r.draft.code]?.name?.trim() || r.draft.code;
  draft.value = { ...r.draft, name };
}

function onCancel() {
  draft.value = null;
  error.value = "";
}

async function onConfirm() {
  const d = draft.value;
  if (!d || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await coCreate({
      code: d.code,
      name: d.name || d.code,
      side: d.side,
      trigger: d.trigger,
      vol: d.vol,
      priceMode: "trigger",
      ttl: "day",
      autoConfirm: true,
      note: "copilot",
    });
    const label = d.name && d.name !== d.code ? `${d.name} ${d.code}` : d.code;
    const sideText = d.side === "SELL" ? "卖出" : "买入";
    toast.success(`条件单已创建：${label} ${sideText} ${d.vol} 股`);
    text.value = "";
    draft.value = null;
    // 条件单与指令列表同源：刷新后作战台立即可见。
    await wf.refreshInstructions();
  } catch (e) {
    // Tauri 的 Err(String) 原样 reject；后端错误已是中文，空错误用兜底文案。
    const raw = typeof e === "string" ? e : (e as { message?: unknown })?.message;
    const msg = typeof raw === "string" ? raw.trim() : "";
    error.value = msg ? `创建失败：${msg}` : "创建条件单失败，请稍后重试";
    toast.error(error.value);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="cp" data-testid="copilot-bar">
    <span class="cp-tag">Copilot</span>
    <input
      v-model="text"
      class="cp-input"
      data-testid="copilot-input"
      type="text"
      spellcheck="false"
      autocomplete="off"
      placeholder="一句话建条件单：600519 跌破1680 买入100股"
      aria-label="Copilot 条件单指令"
      @input="onInput"
      @keyup.enter="onParse"
    />
    <button
      type="button"
      class="cp-btn"
      data-testid="copilot-parse"
      :disabled="busy"
      @click="onParse"
    >解析</button>
    <span v-if="error" class="cp-err" data-testid="copilot-error" role="alert">{{ error }}</span>
    <div v-else-if="draft" class="cp-preview" data-testid="copilot-preview">
      <span class="cp-summary" :title="previewText">{{ previewText }}</span>
      <button
        type="button"
        class="cp-btn primary"
        data-testid="copilot-confirm"
        :disabled="busy"
        @click="onConfirm"
      >{{ busy ? "创建中…" : "创建条件单" }}</button>
      <button
        type="button"
        class="cp-btn"
        data-testid="copilot-cancel"
        :disabled="busy"
        @click="onCancel"
      >取消</button>
    </div>
  </section>
</template>

<style scoped>
.cp {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 3px 6px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-card);
}
.cp-tag {
  flex: none; padding: 1px 5px; border: 1px solid var(--accent); border-radius: 4px;
  font-size: 10px; font-weight: 700; letter-spacing: .4px; color: var(--accent);
}
.cp-input {
  flex: 1 1 220px; min-width: 160px; padding: 2px 6px;
  border: 1px solid transparent; border-radius: 5px;
  background: transparent; color: var(--text); font-size: 11.5px; outline: none;
}
.cp-input:focus { border-color: var(--accent); }
.cp-input::placeholder { color: var(--text-dim); }
.cp-preview { display: flex; align-items: center; gap: 6px; flex: 1 1 260px; min-width: 0; flex-wrap: wrap; }
.cp-summary {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; color: var(--text);
}
.cp-btn {
  flex: none; padding: 1px 8px; border: 1px solid var(--border); border-radius: 5px;
  background: transparent; color: var(--text-dim); font-size: 10.5px; cursor: pointer;
  white-space: nowrap;
}
.cp-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.cp-btn:disabled { opacity: .5; cursor: not-allowed; }
.cp-btn.primary { color: var(--accent); border-color: var(--accent); font-weight: 700; }
.cp-err { flex: 1 1 auto; font-size: 10.5px; color: #ff7a86; }
</style>
