<script setup lang="ts">
import { ref, watch } from "vue";
import { aiExplainSignal, type SignalAttribution as Attribution } from "../../ai/commentary";
import { logger } from "../../utils/logger";

const props = defineProps<{
  visible: boolean;
  code: string;
  name: string;
  kind: string;
}>();
const emit = defineEmits<{ close: [] }>();

const loading = ref(false);
const error = ref("");
const data = ref<Attribution | null>(null);

async function analyze() {
  if (!props.code) return;
  loading.value = true;
  error.value = "";
  data.value = null;
  try {
    data.value = await aiExplainSignal(props.code, props.name, props.kind);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = msg;
    logger.error("信号归因失败", msg);
  } finally {
    loading.value = false;
  }
}

watch(() => props.visible, (v) => {
  if (v && props.code) analyze();
});

function confidenceLabel(c: number): string {
  if (c >= 0.8) return "高";
  if (c >= 0.5) return "中";
  return "低";
}
function confidenceColor(c: number): string {
  if (c >= 0.8) return "#26d07c";
  if (c >= 0.5) return "#e8c66a";
  return "#ff8a8a";
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay" @click.self="emit('close')">
      <div class="modal-panel">
        <div class="modal-header">
          <div class="header-left">
            <span class="header-title">AI 信号归因</span>
            <span class="header-sub">{{ name }} ({{ code }}) · {{ kind }}</span>
          </div>
          <button class="close-btn" @click="emit('close')">✕</button>
        </div>

        <div class="modal-body">
          <div v-if="loading" class="loading-state">
            <div class="spinner"></div>
            <span>AI 正在从技术/资金/板块/消息四维度归因…</span>
          </div>

          <div v-else-if="error" class="error-state">
            <div class="error-icon">!</div>
            <div class="error-text">{{ error }}</div>
            <button class="retry-btn" @click="analyze">重试</button>
          </div>

          <div v-else-if="data" class="result">
            <div class="summary-box">
              <div class="summary-label">归因结论</div>
              <div class="summary-text">{{ data.summary }}</div>
              <div class="confidence" :style="{ color: confidenceColor(data.confidence) }">
                置信度 {{ confidenceLabel(data.confidence) }} ({{ Math.round(data.confidence * 100) }}%)
              </div>
            </div>

            <div class="dim-grid">
              <div class="dim-card">
                <div class="dim-icon">📊</div>
                <div class="dim-title">技术面</div>
                <div class="dim-text">{{ data.technical }}</div>
              </div>
              <div class="dim-card">
                <div class="dim-icon">💰</div>
                <div class="dim-title">资金面</div>
                <div class="dim-text">{{ data.fund_flow }}</div>
              </div>
              <div class="dim-card">
                <div class="dim-icon">🏭</div>
                <div class="dim-title">板块面</div>
                <div class="dim-text">{{ data.sector }}</div>
              </div>
              <div class="dim-card">
                <div class="dim-icon">📰</div>
                <div class="dim-title">消息面</div>
                <div class="dim-text">{{ data.news }}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <span class="disclaimer">AI 生成，仅供参考，不构成投资建议</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
}
.modal-panel {
  width: 640px; max-width: 92vw; max-height: 85vh;
  background: var(--bg, #0d1017); border: 1px solid var(--border, #2a3344);
  border-radius: 14px; display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--border, #2a3344);
  flex-shrink: 0;
}
.header-left { display: flex; flex-direction: column; gap: 2px; }
.header-title { font-size: 15px; font-weight: 700; color: var(--accent, #e8c66a); }
.header-sub { font-size: 11px; color: var(--text-dim, #8a93a6); }
.close-btn {
  width: 28px; height: 28px; border-radius: 6px; border: none;
  background: transparent; color: var(--text-dim, #8a93a6);
  font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.close-btn:hover { background: var(--bg-card, #15181f); color: var(--text, #e6ecf5); }

.modal-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 18px; }
.loading-state, .error-state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 40px 20px; color: var(--text-dim, #8a93a6); font-size: 13px;
}
.spinner {
  width: 32px; height: 32px; border: 3px solid var(--border, #2a3344);
  border-top-color: var(--accent, #e8c66a); border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.error-icon {
  width: 40px; height: 40px; border-radius: 50%; display: flex;
  align-items: center; justify-content: center; font-size: 22px; font-weight: 800;
  color: #ff6b78; background: rgba(255, 93, 107, 0.12);
  border: 1px solid rgba(255, 93, 107, 0.35);
}
.error-text { text-align: center; max-width: 80%; word-break: break-word; }
.retry-btn {
  padding: 6px 20px; font-size: 12px; border-radius: 6px;
  border: 1px solid var(--border, #2a3344); background: var(--bg-card, #15181f);
  color: var(--text, #e6ecf5); cursor: pointer;
}
.retry-btn:hover { border-color: var(--accent, #e8c66a); }

.summary-box {
  padding: 12px 14px; border-radius: 10px; margin-bottom: 14px;
  background: rgba(232, 198, 106, 0.06); border: 1px solid rgba(232, 198, 106, 0.2);
}
.summary-label { font-size: 11px; font-weight: 700; color: var(--accent, #e8c66a); margin-bottom: 4px; }
.summary-text { font-size: 13px; line-height: 1.6; color: var(--text, #e6ecf5); }
.confidence { font-size: 11px; font-weight: 600; margin-top: 6px; }

.dim-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.dim-card {
  padding: 12px; border-radius: 10px;
  background: var(--bg-card, #15181f); border: 1px solid var(--border, #2a3344);
}
.dim-icon { font-size: 18px; margin-bottom: 4px; }
.dim-title { font-size: 12px; font-weight: 700; color: var(--text, #e6ecf5); margin-bottom: 4px; }
.dim-text { font-size: 11.5px; line-height: 1.5; color: var(--text-dim, #b0b8c8); }

.modal-footer {
  padding: 10px 18px; border-top: 1px solid var(--border, #2a3344);
  text-align: center; flex-shrink: 0;
}
.disclaimer { font-size: 10px; color: var(--text-dim, #8a93a6); }
</style>
