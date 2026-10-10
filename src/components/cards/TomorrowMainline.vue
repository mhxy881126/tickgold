<script setup lang="ts">
import { ref, onMounted } from "vue";
import { emit as tauriEmit } from "@tauri-apps/api/event";
import { aiTomorrowMainline, type TomorrowMainline as Mainline, type MainlineTheme } from "../../ai/commentary";
import { logger } from "../../utils/logger";

const loading = ref(false);
const error = ref("");
const data = ref<Mainline | null>(null);
const lastUpdate = ref("");

function strengthColor(s: string): string {
  switch (s) {
    case "strong": return "#ff6b78";
    case "medium": return "#e8c66a";
    case "weak": return "#8a93a6";
    default: return "#8a93a6";
  }
}

function strengthLabel(s: string): string {
  switch (s) {
    case "strong": return "强";
    case "medium": return "中";
    case "weak": return "弱";
    default: return s;
  }
}

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await aiTomorrowMainline();
    lastUpdate.value = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = msg;
    logger.error("明日主线失败", msg);
  } finally {
    loading.value = false;
  }
}

function openAiSettings() { tauriEmit("open-ai-settings"); }

onMounted(refresh);
</script>

<template>
  <div class="mainline-card">
    <div class="card-header">
      <span class="header-title">明日主线</span>
      <div class="header-actions">
        <span v-if="lastUpdate" class="update-time">{{ lastUpdate }}</span>
        <button class="refresh-btn" :disabled="loading" @click="refresh">
          {{ loading ? "预测中…" : "刷新" }}
        </button>
      </div>
    </div>

    <div v-if="loading && !data" class="loading-state">
      <div class="spinner"></div>
      <span>AI 正在分析涨停梯队/板块/快讯…</span>
    </div>

    <div v-else-if="error" class="error-state">
      <div class="error-icon">!</div>
      <div class="error-text">{{ error }}</div>
      <div class="error-actions">
        <button class="retry-btn" @click="refresh">重试</button>
        <button class="config-btn" @click="openAiSettings">配置 AI</button>
      </div>
      <div class="error-hint">AI 功能需配置大模型（本地 Ollama 或云端 API Key）</div>
    </div>

    <div v-else-if="data" class="content">
      <div class="market-review">
        <div class="section-label">今日复盘</div>
        <div class="review-text">{{ data.market_review }}</div>
      </div>

      <div class="themes">
        <div class="section-label">明日主线预测</div>
        <div class="theme-list">
          <div v-for="(theme, idx) in data.themes" :key="idx" class="theme-card">
            <div class="theme-header">
              <span class="theme-rank">#{{ idx + 1 }}</span>
              <span class="theme-name">{{ theme.theme }}</span>
              <span class="theme-strength" :style="{ color: strengthColor(theme.strength), borderColor: strengthColor(theme.strength) }">
                {{ strengthLabel(theme.strength) }}
              </span>
            </div>
            <div class="theme-logic">{{ theme.logic }}</div>

            <div v-if="theme.leaders.length" class="theme-row">
              <span class="row-label">龙头：</span>
              <span class="row-value leaders">{{ theme.leaders.join("、") }}</span>
            </div>
            <div v-if="theme.catalysts.length" class="theme-row">
              <span class="row-label">催化：</span>
              <span class="row-value">{{ theme.catalysts.join("；") }}</span>
            </div>
            <div v-if="theme.risk" class="theme-row risk-row">
              <span class="row-label">风险：</span>
              <span class="row-value">{{ theme.risk }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="data.overall_risk" class="overall-risk">
        <span class="risk-badge">整体风险</span>
        <span class="risk-text">{{ data.overall_risk }}</span>
      </div>

      <div class="disclaimer">AI 预测，仅供参考，不构成投资建议</div>
    </div>
  </div>
</template>

<style scoped>
.mainline-card {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  padding: 12px 14px; gap: 10px; overflow: hidden;
}
.card-header {
  display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
}
.header-title { font-size: 13px; font-weight: 700; color: var(--accent, #e8c66a); }
.header-actions { display: flex; align-items: center; gap: 8px; }
.update-time { font-size: 10px; color: var(--text-dim, #8a93a6); }
.refresh-btn {
  padding: 3px 10px; font-size: 11px; border-radius: 6px;
  border: 1px solid var(--border, #2a3344); background: var(--bg-card, #15181f);
  color: var(--text, #e6ecf5); cursor: pointer;
}
.refresh-btn:hover:not(:disabled) { border-color: var(--accent, #e8c66a); }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.loading-state, .error-state {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--text-dim, #8a93a6); font-size: 12px;
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
.error-text { text-align: center; max-width: 80%; word-break: break-word; }
.retry-btn {
  padding: 5px 16px; font-size: 11px; border-radius: 6px;
  border: 1px solid var(--border, #2a3344); background: var(--bg-card, #15181f);
  color: var(--text, #e6ecf5); cursor: pointer;
}
.retry-btn:hover { border-color: var(--accent, #e8c66a); }
.error-actions { display: flex; gap: 8px; }
.config-btn {
  padding: 5px 16px; font-size: 11px; border-radius: 6px;
  border: 1px solid var(--accent, #e8c66a); background: rgba(232, 198, 106, 0.12);
  color: var(--accent, #e8c66a); cursor: pointer; font-weight: 600;
}
.config-btn:hover { background: rgba(232, 198, 106, 0.22); }
.error-hint { font-size: 10px; color: var(--text-dim, #8a93a6); margin-top: 4px; }

.content { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.section-label {
  font-size: 11px; font-weight: 700; color: var(--text-dim, #8a93a6);
  text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;
}
.market-review .review-text {
  font-size: 12px; line-height: 1.6; color: var(--text, #e6ecf5);
  background: rgba(78, 161, 255, 0.06); border-left: 2px solid #4ea1ff;
  padding: 8px 10px; border-radius: 0 6px 6px 0;
}
.theme-list { display: flex; flex-direction: column; gap: 8px; }
.theme-card {
  padding: 10px 12px; border-radius: 8px;
  background: var(--bg-card, #15181f); border: 1px solid var(--border, #2a3344);
}
.theme-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.theme-rank {
  font-size: 11px; font-weight: 800; color: var(--accent, #e8c66a);
  background: rgba(232, 198, 106, 0.12); padding: 1px 6px; border-radius: 4px;
}
.theme-name { font-size: 12.5px; font-weight: 700; color: var(--text, #e6ecf5); flex: 1; }
.theme-strength {
  font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px;
  border: 1px solid;
}
.theme-logic { font-size: 11.5px; color: var(--text-dim, #b0b8c8); line-height: 1.5; margin-bottom: 6px; }
.theme-row { display: flex; align-items: flex-start; gap: 4px; font-size: 11px; line-height: 1.5; margin-top: 3px; }
.row-label { flex-shrink: 0; color: var(--text-dim, #8a93a6); font-weight: 600; }
.row-value { color: var(--text, #e6ecf5); }
.row-value.leaders { color: #ff8a8a; font-weight: 600; }
.risk-row .row-value { color: #ffb0b0; }
.overall-risk {
  display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px;
  background: rgba(255, 107, 120, 0.06); border: 1px solid rgba(255, 107, 120, 0.2);
  border-radius: 8px;
}
.risk-badge {
  flex-shrink: 0; font-size: 10px; font-weight: 700; color: #ff6b78;
  background: rgba(255, 107, 120, 0.15); padding: 2px 8px; border-radius: 4px;
}
.risk-text { font-size: 11.5px; color: #ffb0b0; line-height: 1.5; }
.disclaimer {
  flex-shrink: 0; font-size: 10px; color: var(--text-dim, #8a93a6);
  text-align: center; padding-top: 4px; border-top: 1px solid var(--border, #2a3344);
}
</style>
