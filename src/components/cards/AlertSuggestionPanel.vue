<script setup lang="ts">
import { ref } from "vue";
import { aiSuggestAlerts, type AlertSuggestion } from "../../ai/commentary";
import { logger } from "../../utils/logger";

const props = defineProps<{
  watchlist: string[];
}>();
const emit = defineEmits<{ close: []; apply: [rule: AlertSuggestion] }>();

const loading = ref(false);
const error = ref("");
const suggestions = ref<AlertSuggestion[]>([]);
const applied = ref<Set<string>>(new Set());

async function generate() {
  if (!props.watchlist.length) {
    error.value = "自选股列表为空";
    return;
  }
  loading.value = true;
  error.value = "";
  suggestions.value = [];
  try {
    suggestions.value = await aiSuggestAlerts(props.watchlist);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = msg;
    logger.error("预警推荐失败", msg);
  } finally {
    loading.value = false;
  }
}

function fieldLabel(f: string): string {
  const map: Record<string, string> = {
    price: "价格", pct: "涨跌幅", volume_ratio: "量比",
    turnover: "换手率", speed5m: "5分钟涨速", amount: "成交额",
  };
  return map[f] ?? f;
}

function opLabel(op: string): string {
  const map: Record<string, string> = {
    ">=": "≥", "<=": "≤", ">": ">", "<": "<",
    crossUp: "上穿", crossDown: "下穿",
  };
  return map[op] ?? op;
}

function priorityColor(p: string): string {
  switch (p) {
    case "high": return "#ff6b78";
    case "medium": return "#e8c66a";
    case "low": return "#8a93a6";
    default: return "#8a93a6";
  }
}

function priorityLabel(p: string): string {
  switch (p) {
    case "high": return "高";
    case "medium": return "中";
    case "low": return "低";
    default: return p;
  }
}

function ruleKey(s: AlertSuggestion): string {
  return `${s.code}-${s.field}-${s.op}-${s.value}`;
}

function applyRule(s: AlertSuggestion) {
  applied.value.add(ruleKey(s));
  emit("apply", s);
}
</script>

<template>
  <div class="alert-panel">
    <div class="panel-header">
      <span class="panel-title">AI 预警推荐</span>
      <button class="generate-btn" :disabled="loading" @click="generate">
        {{ loading ? "推荐中…" : suggestions.length ? "重新推荐" : "生成推荐" }}
      </button>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <span>AI 正在分析自选股行情，推荐预警规则…</span>
    </div>

    <div v-else-if="error" class="error-state">
      <div class="error-icon">!</div>
      <div class="error-text">{{ error }}</div>
      <button class="retry-btn" @click="generate">重试</button>
    </div>

    <div v-else-if="suggestions.length" class="suggestion-list">
      <div v-for="(s, idx) in suggestions" :key="idx" class="suggestion-card">
        <div class="sug-top">
          <span class="sug-stock">{{ s.name }} ({{ s.code }})</span>
          <span class="sug-priority" :style="{ color: priorityColor(s.priority), borderColor: priorityColor(s.priority) }">
            {{ priorityLabel(s.priority) }}
          </span>
        </div>
        <div class="sug-rule">
          <span class="rule-field">{{ fieldLabel(s.field) }}</span>
          <span class="rule-op">{{ opLabel(s.op) }}</span>
          <span class="rule-value">{{ s.value }}</span>
        </div>
        <div class="sug-reason">{{ s.reason }}</div>
        <button
          class="apply-btn"
          :class="{ applied: applied.has(ruleKey(s)) }"
          :disabled="applied.has(ruleKey(s))"
          @click="applyRule(s)"
        >
          {{ applied.has(ruleKey(s)) ? "已添加" : "一键添加" }}
        </button>
      </div>
    </div>

    <div v-else class="empty-state">
      <div class="empty-icon">🎯</div>
      <div class="empty-text">点击"生成推荐"，AI 将基于自选股行情推荐预警规则</div>
    </div>

    <div class="disclaimer">AI 推荐，仅供参考，不构成投资建议</div>
  </div>
</template>

<style scoped>
.alert-panel {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px; min-height: 300px;
}
.panel-header {
  display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
}
.panel-title { font-size: 13px; font-weight: 700; color: var(--accent, #e8c66a); }
.generate-btn {
  padding: 4px 12px; font-size: 11px; border-radius: 6px;
  border: 1px solid var(--accent, #e8c66a); background: rgba(232, 198, 106, 0.1);
  color: var(--accent, #e8c66a); cursor: pointer; font-weight: 600;
}
.generate-btn:hover:not(:disabled) { background: rgba(232, 198, 106, 0.2); }
.generate-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.loading-state, .error-state, .empty-state {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--text-dim, #8a93a6); font-size: 12px; text-align: center;
}
.spinner {
  width: 24px; height: 24px; border: 2px solid var(--border, #2a3344);
  border-top-color: var(--accent, #e8c66a); border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.error-icon {
  width: 32px; height: 32px; border-radius: 50%; display: flex;
  align-items: center; justify-content: center; font-size: 18px; font-weight: 800;
  color: #ff6b78; background: rgba(255, 93, 107, 0.12);
  border: 1px solid rgba(255, 93, 107, 0.35);
}
.error-text { max-width: 80%; word-break: break-word; }
.retry-btn {
  padding: 5px 16px; font-size: 11px; border-radius: 6px;
  border: 1px solid var(--border, #2a3344); background: var(--bg-card, #15181f);
  color: var(--text, #e6ecf5); cursor: pointer;
}
.retry-btn:hover { border-color: var(--accent, #e8c66a); }
.empty-icon { font-size: 32px; }
.empty-text { max-width: 80%; line-height: 1.5; }

.suggestion-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.suggestion-card {
  padding: 10px 12px; border-radius: 8px;
  background: var(--bg-card, #15181f); border: 1px solid var(--border, #2a3344);
}
.sug-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.sug-stock { font-size: 12px; font-weight: 700; color: var(--text, #e6ecf5); }
.sug-priority {
  font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px; border: 1px solid;
}
.sug-rule {
  display: flex; align-items: center; gap: 6px; margin-bottom: 6px;
  font-family: Consolas, monospace;
}
.rule-field {
  font-size: 11px; padding: 2px 8px; border-radius: 4px;
  background: rgba(78, 161, 255, 0.12); color: #4ea1ff; font-weight: 600;
}
.rule-op { font-size: 12px; color: var(--text-dim, #8a93a6); font-weight: 700; }
.rule-value { font-size: 13px; color: var(--accent, #e8c66a); font-weight: 700; }
.sug-reason { font-size: 11px; color: var(--text-dim, #b0b8c8); line-height: 1.5; margin-bottom: 8px; }
.apply-btn {
  width: 100%; padding: 5px; font-size: 11px; border-radius: 6px;
  border: 1px solid var(--accent, #e8c66a); background: rgba(232, 198, 106, 0.1);
  color: var(--accent, #e8c66a); cursor: pointer; font-weight: 600;
}
.apply-btn:hover:not(:disabled) { background: rgba(232, 198, 106, 0.2); }
.apply-btn.applied {
  border-color: #26d07c; background: rgba(38, 208, 124, 0.1);
  color: #26d07c; cursor: default;
}
.disclaimer {
  flex-shrink: 0; font-size: 10px; color: var(--text-dim, #8a93a6);
  text-align: center; padding-top: 4px; border-top: 1px solid var(--border, #2a3344);
}
</style>
