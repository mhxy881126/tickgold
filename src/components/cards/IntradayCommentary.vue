<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { aiIntradayCommentaryStream, type IntradayCommentary as Commentary, type StreamHandle } from "../../ai/commentary";
import { logger } from "../../utils/logger";

const loading = ref(false);
const error = ref("");
const data = ref<Commentary | null>(null);
const streamText = ref("");
const lastUpdate = ref("");
let streamHandle: StreamHandle | null = null;

function parseJson(text: string): Commentary | null {
  try {
    const cleaned = text.trim().replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
    const v = JSON.parse(cleaned);
    return {
      timestamp: Date.now(),
      market_view: v.market_view || "",
      key_drivers: Array.isArray(v.key_drivers) ? v.key_drivers : [],
      risk_notes: Array.isArray(v.risk_notes) ? v.risk_notes : [],
      raw: cleaned,
    };
  } catch { return null; }
}

async function refresh() {
  if (streamHandle) { streamHandle.unlisten(); streamHandle = null; }
  loading.value = true;
  error.value = "";
  streamText.value = "";
  data.value = null;
  try {
    streamHandle = await aiIntradayCommentaryStream();
    streamHandle.onDelta((t) => { streamText.value += t; });
    streamHandle.onDone((full) => {
      const parsed = parseJson(full);
      if (parsed) data.value = parsed;
      else error.value = "AI 返回数据解析失败";
      loading.value = false;
      lastUpdate.value = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    });
    streamHandle.onError((msg) => {
      error.value = msg;
      loading.value = false;
      logger.error("盘中解读失败", msg);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = msg;
    loading.value = false;
  }
}

onMounted(refresh);
onBeforeUnmount(() => { if (streamHandle) streamHandle.unlisten(); });
</script>

<template>
  <div class="intraday-card">
    <div class="card-header">
      <span class="header-title">盘中解读</span>
      <div class="header-actions">
        <span v-if="lastUpdate" class="update-time">{{ lastUpdate }}</span>
        <button class="refresh-btn" :disabled="loading" @click="refresh">
          {{ loading ? "生成中…" : "刷新" }}
        </button>
      </div>
    </div>

    <div v-if="loading && !data" class="loading-state">
      <div class="spinner"></div>
      <span v-if="!streamText">AI 正在聚合大盘/板块/涨停池/快讯…</span>
      <div v-else class="stream-text">{{ streamText }}<span class="cursor">▊</span></div>
    </div>

    <div v-else-if="error" class="error-state">
      <div class="error-icon">!</div>
      <div class="error-text">{{ error }}</div>
      <button class="retry-btn" @click="refresh">重试</button>
    </div>

    <div v-else-if="data" class="content">
      <div class="market-view">
        <div class="section-label">市场总览</div>
        <div class="view-text">{{ data.market_view }}</div>
      </div>

      <div class="drivers">
        <div class="section-label">关键驱动</div>
        <div class="driver-list">
          <div v-for="(d, i) in data.key_drivers" :key="i" class="driver-item">
            <span class="driver-num">{{ i + 1 }}</span>
            <span class="driver-text">{{ d }}</span>
          </div>
        </div>
      </div>

      <div v-if="data.risk_notes.length" class="risks">
        <div class="section-label risk-label">风险提示</div>
        <div class="risk-list">
          <div v-for="(r, i) in data.risk_notes" :key="i" class="risk-item">⚠ {{ r }}</div>
        </div>
      </div>

      <div class="disclaimer">AI 生成，仅供参考，不构成投资建议</div>
    </div>
  </div>
</template>

<style scoped>
.intraday-card {
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

.stream-text { font-size: 11.5px; line-height: 1.6; color: var(--text, #e6ecf5); max-width: 100%; word-break: break-word; text-align: left; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
.cursor { animation: blink 1s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }
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

.content { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.section-label {
  font-size: 11px; font-weight: 700; color: var(--text-dim, #8a93a6);
  text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;
}
.risk-label { color: #ff8a8a; }
.market-view .view-text {
  font-size: 12.5px; line-height: 1.6; color: var(--text, #e6ecf5);
  background: rgba(232, 198, 106, 0.06); border-left: 2px solid var(--accent, #e8c66a);
  padding: 8px 10px; border-radius: 0 6px 6px 0;
}
.driver-list { display: flex; flex-direction: column; gap: 5px; }
.driver-item { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.5; }
.driver-num {
  flex-shrink: 0; width: 18px; height: 18px; border-radius: 50%;
  background: rgba(232, 198, 106, 0.15); color: var(--accent, #e8c66a);
  font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center;
}
.driver-text { color: var(--text, #e6ecf5); }
.risk-list { display: flex; flex-direction: column; gap: 4px; }
.risk-item { font-size: 11.5px; color: #ffb0b0; line-height: 1.5; }
.disclaimer {
  flex-shrink: 0; font-size: 10px; color: var(--text-dim, #8a93a6);
  text-align: center; padding-top: 4px; border-top: 1px solid var(--border, #2a3344);
}
</style>
