<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { emit as tauriEmit } from "@tauri-apps/api/event";
import { aiTomorrowMainlineStream, type TomorrowMainline as Mainline, type StreamHandle } from "../../ai/commentary";
import { readAiCache, writeAiCache, formatCacheTime } from "../../utils/aiCache";
import { logger } from "../../utils/logger";

const CACHE_KEY = "tomorrow-mainline";

const loading = ref(false);
const refreshing = ref(false);
const error = ref("");
const data = ref<Mainline | null>(null);
const streamText = ref("");
const lastUpdate = ref("");
const fromCache = ref(false);
const slowLoading = ref(false);
let streamHandle: StreamHandle | null = null;
let slowTimer: ReturnType<typeof setTimeout> | null = null;

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

function strengthScore(s: string): string {
  switch (s) {
    case "strong": return "92";
    case "medium": return "72";
    case "weak": return "52";
    default: return "0";
  }
}

function strengthPercent(s: string): number {
  switch (s) {
    case "strong": return 92;
    case "medium": return 72;
    case "weak": return 52;
    default: return 0;
  }
}

function strengthDots(s: string): number {
  switch (s) {
    case "strong": return 3;
    case "medium": return 2;
    case "weak": return 1;
    default: return 0;
  }
}

const confidenceScore = computed(() => {
  if (!data.value) return 0;
  const themes = data.value.themes;
  if (!themes.length) return 0;
  const total = themes.reduce((sum, t) => sum + strengthPercent(t.strength), 0);
  return Math.round(total / themes.length);
});

function parseMainline(text: string): Mainline | null {
  try {
    const cleaned = text.trim().replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
    const v = JSON.parse(cleaned);
    const themes = Array.isArray(v.themes) ? v.themes.map((t: any) => ({
      theme: t.theme || "",
      logic: t.logic || "",
      leaders: Array.isArray(t.leaders) ? t.leaders : [],
      catalysts: Array.isArray(t.catalysts) ? t.catalysts : [],
      risk: t.risk || "",
      strength: t.strength || "medium",
    })) : [];
    return {
      generated_at: Date.now(),
      market_review: v.market_review || "",
      themes,
      overall_risk: v.overall_risk || "",
    };
  } catch { return null; }
}

// 初始化：先读缓存，再后台刷新
function init() {
  const cached = readAiCache<Mainline>(CACHE_KEY);
  if (cached) {
    data.value = cached.data;
    fromCache.value = true;
    lastUpdate.value = formatCacheTime(cached.timestamp);
    // 缓存超过 30 分钟则后台刷新（明日主线不需要太频繁）
    const stale = Date.now() - cached.timestamp > 30 * 60 * 1000;
    if (stale) void refresh(true);
  } else {
    void refresh(false);
  }
}

async function refresh(backgroundRefresh = false) {
  if (streamHandle) { streamHandle.unlisten(); streamHandle = null; }
  if (!backgroundRefresh) {
    loading.value = true;
    error.value = "";
  }
  refreshing.value = !backgroundRefresh;
  streamText.value = "";
  slowLoading.value = false;

  if (slowTimer) clearTimeout(slowTimer);
  slowTimer = setTimeout(() => {
    if (loading.value || refreshing.value) slowLoading.value = true;
  }, 10000); // 明日主线数据量大，给 10 秒再提示慢

  try {
    streamHandle = await aiTomorrowMainlineStream();
    streamHandle.onCached((full) => {
      const parsed = parseMainline(full);
      if (parsed) {
        data.value = parsed;
        loading.value = false;
        refreshing.value = true;
        fromCache.value = false;
      }
    });
    streamHandle.onDelta((t) => {
      streamText.value += t;
      if (refreshing.value && !loading.value) { loading.value = true; refreshing.value = false; }
    });
    streamHandle.onDone((full) => {
      if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
      slowLoading.value = false;
      const parsed = parseMainline(full);
      if (parsed) {
        data.value = parsed;
        fromCache.value = false;
        writeAiCache(CACHE_KEY, parsed); // 写入本地缓存
      } else if (!data.value) {
        error.value = "AI 返回数据解析失败";
      }
      loading.value = false;
      refreshing.value = false;
      lastUpdate.value = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    });
    streamHandle.onError((msg) => {
      if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
      slowLoading.value = false;
      if (data.value) {
        error.value = msg;
        logger.warn("明日主线刷新失败，继续展示缓存", msg);
      } else {
        error.value = msg;
        logger.error("明日主线失败", msg);
      }
      loading.value = false;
      refreshing.value = false;
    });
  } catch (e) {
    if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
    slowLoading.value = false;
    const msg = e instanceof Error ? e.message : String(e);
    if (data.value) {
      error.value = msg;
      logger.warn("明日主线刷新失败，继续展示缓存", msg);
    } else {
      error.value = msg;
    }
    loading.value = false;
    refreshing.value = false;
  }
}

function openAiSettings() { tauriEmit("open-ai-settings"); }
function dismissError() { error.value = ""; }

onMounted(init);
onBeforeUnmount(() => {
  if (streamHandle) streamHandle.unlisten();
  if (slowTimer) clearTimeout(slowTimer);
});
</script>

<template>
  <div class="mainline-card">
    <div class="card-header">
      <div class="header-left">
        <span class="header-badge">AI</span>
        <span class="header-title">明日主线</span>
        <span class="header-sub">涨停梯队 · 板块 · 快讯</span>
        <span v-if="fromCache" class="cache-tag" title="当前为缓存数据">缓存</span>
      </div>
      <div class="header-actions">
        <span v-if="refreshing" class="refresh-badge">● 更新中</span>
        <span v-if="lastUpdate" class="update-time">{{ lastUpdate }}</span>
        <button class="refresh-btn" :disabled="loading && !fromCache" @click="refresh(false)">
          <svg v-if="!loading" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
          {{ loading ? "预测中…" : "刷新" }}
        </button>
      </div>
    </div>

    <!-- 错误提示条（有缓存时只显示顶部条） -->
    <div v-if="error && data" class="error-bar" @click="dismissError">
      <span class="err-ic">!</span>
      <span class="err-msg">刷新失败：{{ error }}</span>
      <span class="err-close">×</span>
    </div>

    <!-- 慢加载提示 -->
    <div v-if="slowLoading && !data" class="slow-hint">
      <span>AI 预测需要一点时间… 正在分析涨停梯队和板块轮动</span>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading && !data" class="loading-state">
      <div class="spinner-wrap">
        <div class="spinner"></div>
      </div>
      <div class="loading-title">AI 主线预测引擎运行中</div>
      <div class="loading-sub">正在分析涨停梯队 / 板块轮动 / 市场快讯…</div>
      <div v-if="streamText" class="stream-box">
        <div class="stream-text">{{ streamText }}<span class="cursor">▊</span></div>
      </div>
    </div>

    <!-- 错误状态 -->
    <div v-else-if="error" class="error-state">
      <div class="error-icon">!</div>
      <div class="error-title">预测失败</div>
      <div class="error-text">{{ error }}</div>
      <div class="error-actions">
        <button class="retry-btn" @click="refresh">重试</button>
        <button class="config-btn" @click="openAiSettings">配置 AI</button>
      </div>
      <div class="error-hint">AI 功能需配置大模型（本地 Ollama 或云端 API Key）</div>
    </div>

    <!-- Bento 内容区 -->
    <div v-else-if="data" class="bento-content">
      <!-- 今日复盘条 -->
      <div class="review-bar">
        <div class="rv-icon">📊</div>
        <div class="rv-text">{{ data.market_review }}</div>
      </div>

      <!-- 主 Bento 网格 -->
      <div class="bento-grid">
        <!-- TOP1 主线大图卡 -->
        <div v-if="data.themes[0]" class="bento-main bento-item">
          <div class="main-rank">#01</div>
          <div class="main-glow"></div>
          <div class="main-name">{{ data.themes[0].theme }}</div>
          <div class="main-logic">{{ data.themes[0].logic }}</div>
          
          <div class="main-strength">
            <div class="str-label">
              <span>主线强度</span>
              <span class="str-val">{{ strengthScore(data.themes[0].strength) }}</span>
            </div>
            <div class="str-bar">
              <div class="str-fill" :style="{ width: strengthPercent(data.themes[0].strength) + '%' }"></div>
            </div>
          </div>

          <div class="main-info">
            <div v-if="data.themes[0].leaders.length" class="info-block">
              <div class="info-label">龙头</div>
              <div class="info-leaders">
                <span v-for="(l, i) in data.themes[0].leaders.slice(0, 3)" :key="i" class="leader-chip">{{ l }}</span>
              </div>
            </div>
            <div v-if="data.themes[0].catalysts.length" class="info-block">
              <div class="info-label">催化</div>
              <div class="info-catalysts">{{ data.themes[0].catalysts.join(" · ") }}</div>
            </div>
          </div>
        </div>

        <!-- 次级主题卡片组 -->
        <div class="bento-sub-grid">
          <div v-for="(theme, idx) in data.themes.slice(1, 4)" :key="idx" 
               class="bento-sub bento-item" :class="'str-' + theme.strength">
            <div class="sub-header">
              <span class="sub-rank">#0{{ idx + 2 }}</span>
              <span class="sub-strength">
                <span v-for="n in 3" :key="n" class="dot" :class="{ active: n <= strengthDots(theme.strength) }"></span>
              </span>
            </div>
            <div class="sub-name">{{ theme.theme }}</div>
            <div class="sub-logic">{{ theme.logic }}</div>
            <div v-if="theme.leaders.length" class="sub-leaders">
              <span v-for="(l, i) in theme.leaders.slice(0, 2)" :key="i">{{ l }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 风险提示条 -->
      <div v-if="data.overall_risk" class="risk-bar">
        <div class="risk-icon">⚠</div>
        <div class="risk-text">{{ data.overall_risk }}</div>
      </div>

      <!-- 底部免责 -->
      <div class="disclaimer">
        <span class="disc-icon">ⓘ</span>
        AI 预测仅供参考，不构成投资建议 · 置信度 {{ confidenceScore }}%
      </div>
    </div>
  </div>
</template>

<style scoped>
.mainline-card {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  padding: 10px 12px; gap: 10px; overflow: hidden;
  background:
    radial-gradient(500px 280px at 10% 0%, rgba(232,184,96,.05), transparent 60%),
    var(--bg-card, #0f1218);
}

/* ===== 顶部标题栏 ===== */
.card-header {
  display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
}
.header-left { display: flex; align-items: center; gap: 8px; }
.header-badge {
  padding: 2px 8px; border-radius: 4px;
  background: linear-gradient(135deg, var(--accent, #e8b860), #b8923a);
  color: #000; font-size: 10px; font-weight: 800; letter-spacing: 1px;
}
.header-title { font-size: 13px; font-weight: 700; color: var(--text, #e6ecf5); }
.header-sub { font-size: 10px; color: var(--text-dim, #6b7280); margin-left: 2px; }
.header-actions { display: flex; align-items: center; gap: 8px; }
.update-time { font-size: 10px; color: var(--text-dim, #6b7280); font-family: "SF Mono", monospace; }
.refresh-badge { font-size: 10px; color: var(--accent, #e8b860); animation: pulse 1.5s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
.refresh-btn {
  padding: 3px 10px; font-size: 11px; border-radius: 6px;
  border: 1px solid var(--border, #2a3344); background: var(--bg-panel, #15181f);
  color: var(--text-dim, #8a93a6); cursor: pointer;
  display: flex; align-items: center; gap: 4px;
  transition: all .2s;
}
.refresh-btn svg { width: 12px; height: 12px; }
.refresh-btn:hover:not(:disabled) {
  border-color: var(--accent, #e8b860);
  color: var(--accent, #e8b860);
}
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* 缓存标签 */
.cache-tag {
  font-size: 9px; padding: 2px 6px;
  background: rgba(138, 147, 166, 0.15);
  color: var(--text-dim, #8a93a6);
  border-radius: 4px;
  border: 1px solid rgba(138, 147, 166, 0.2);
}

/* 错误提示条 */
.error-bar {
  display: flex; align-items: center; gap: 8px;
  margin: 0 12px 8px;
  padding: 6px 10px;
  background: rgba(255, 107, 120, 0.1);
  border: 1px solid rgba(255, 107, 120, 0.25);
  border-radius: 6px;
  font-size: 10.5px;
  color: #ff8a93;
  cursor: pointer;
  flex-shrink: 0;
}
.error-bar .err-ic {
  width: 16px; height: 16px; border-radius: 50%;
  background: rgba(255, 107, 120, 0.2);
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 800;
  flex-shrink: 0;
}
.error-bar .err-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.error-bar .err-close { font-size: 14px; opacity: 0.6; }

/* 慢加载提示 */
.slow-hint {
  margin: 0 12px 8px;
  padding: 6px 10px;
  background: rgba(232, 184, 96, 0.08);
  border: 1px solid rgba(232, 184, 96, 0.2);
  border-radius: 6px;
  font-size: 10.5px;
  color: var(--accent, #e8b860);
  text-align: center;
  flex-shrink: 0;
  animation: fadeIn 0.3s ease;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ===== 加载状态 ===== */
.loading-state {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--text-dim, #8a93a6);
}
.spinner-wrap {
  width: 44px; height: 44px; border-radius: 12px;
  background: rgba(232,184,96,.1);
  display: flex; align-items: center; justify-content: center;
}
.spinner {
  width: 24px; height: 24px; border: 2px solid var(--border, #2a3344);
  border-top-color: var(--accent, #e8b860); border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.loading-title { font-size: 13px; font-weight: 600; color: var(--text, #e6ecf5); }
.loading-sub { font-size: 11px; color: var(--text-dim, #8a93a6); }
.stream-box {
  width: 100%; max-height: 180px; overflow-y: auto;
  padding: 10px 12px; border-radius: 8px;
  background: rgba(232,184,96,.04);
  border: 1px solid rgba(232,184,96,.12);
}
.stream-text {
  font-size: 11.5px; line-height: 1.7; color: var(--text, #e6ecf5);
  text-align: left; white-space: pre-wrap; word-break: break-word;
}
.cursor { animation: blink 1s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }

/* ===== 错误状态 ===== */
.error-state {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--text-dim, #8a93a6); font-size: 12px;
}
.error-icon {
  width: 40px; height: 40px; border-radius: 12px; display: flex;
  align-items: center; justify-content: center; font-size: 20px; font-weight: 800;
  color: #ff6b78; background: rgba(255, 107, 120, 0.1);
  border: 1px solid rgba(255, 107, 120, 0.25);
}
.error-title { font-size: 13px; font-weight: 600; color: var(--text, #e6ecf5); }
.error-text { text-align: center; max-width: 80%; word-break: break-word; font-size: 11.5px; }
.error-actions { display: flex; gap: 8px; }
.retry-btn {
  padding: 5px 16px; font-size: 11px; border-radius: 6px;
  border: 1px solid var(--border, #2a3344); background: var(--bg-panel, #15181f);
  color: var(--text, #e6ecf5); cursor: pointer;
}
.retry-btn:hover { border-color: var(--accent, #e8b860); }
.config-btn {
  padding: 5px 16px; font-size: 11px; border-radius: 6px;
  border: 1px solid var(--accent, #e8b860); background: rgba(232, 184, 96, 0.1);
  color: var(--accent, #e8b860); cursor: pointer; font-weight: 600;
}
.config-btn:hover { background: rgba(232, 184, 96, 0.2); }
.error-hint { font-size: 10px; color: var(--text-dim, #8a93a6); margin-top: 4px; }

/* ===== Bento 内容区 ===== */
.bento-content {
  flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px;
  overflow-y: auto; overflow-x: hidden;
}
.bento-content::-webkit-scrollbar { width: 3px; }
.bento-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,.08); border-radius: 2px; }

/* 复盘条 */
.review-bar {
  flex-shrink: 0; display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 12px; border-radius: 8px;
  background: rgba(78, 161, 255, 0.06);
  border: 1px solid rgba(78, 161, 255, 0.15);
}
.rv-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }
.rv-text { font-size: 11.5px; color: var(--text, #e6ecf5); line-height: 1.65; }

/* Bento 主网格 */
.bento-grid {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 8px;
  flex: 1;
  min-height: 0;
}

.bento-item {
  border-radius: 8px;
  background: var(--bg-panel, #15181f);
  border: 1px solid var(--border, #2a3344);
  overflow: hidden;
  transition: all .2s;
}

/* ===== TOP1 主卡 ===== */
.bento-main {
  grid-row: span 2;
  padding: 14px;
  display: flex; flex-direction: column; gap: 10px;
  background: linear-gradient(160deg, rgba(232,184,96,.1), rgba(232,184,96,.02) 60%);
  border-color: rgba(232,184,96,.22);
  position: relative;
}
.main-glow {
  position: absolute; top: 0; right: 0; width: 100px; height: 100px;
  background: radial-gradient(circle at top right, rgba(232,184,96,.15), transparent 70%);
  pointer-events: none;
}
.main-rank {
  position: absolute; top: 8px; right: 12px;
  font-size: 40px; font-weight: 800; font-family: "SF Mono", monospace;
  color: var(--accent, #e8b860);
  opacity: 0.15; line-height: 1;
  pointer-events: none;
}
.main-name {
  font-size: 15px; font-weight: 700; color: var(--text, #e6ecf5);
  position: relative; z-index: 1;
}
.main-logic {
  font-size: 11.5px; color: var(--text-dim, #b0b8c8);
  line-height: 1.65;
  position: relative; z-index: 1;
}

.main-strength { position: relative; z-index: 1; }
.str-label {
  display: flex; justify-content: space-between;
  font-size: 10px; margin-bottom: 5px;
}
.str-label span:first-child { color: var(--text-dim, #6b7280); font-weight: 600; letter-spacing: 0.5px; }
.str-val {
  color: var(--accent, #e8b860); font-weight: 700;
  font-family: "SF Mono", monospace;
}
.str-bar {
  height: 5px; border-radius: 3px;
  background: rgba(255,255,255,.06);
  overflow: hidden;
}
.str-fill {
  height: 100%; border-radius: 3px;
  background: linear-gradient(90deg, var(--accent, #e8b860), #ffd88a);
  box-shadow: 0 0 8px rgba(232,184,96,.4);
}

.main-info {
  display: flex; flex-direction: column; gap: 8px;
  margin-top: auto;
  position: relative; z-index: 1;
}
.info-block { display: flex; flex-direction: column; gap: 4px; }
.info-label {
  font-size: 10px; color: var(--text-dim, #6b7280);
  font-weight: 600; letter-spacing: 0.5px;
}
.info-leaders { display: flex; gap: 5px; flex-wrap: wrap; }
.leader-chip {
  padding: 2px 8px; border-radius: 4px;
  background: rgba(255, 107, 120, 0.12);
  color: #ff8a9e; font-size: 10.5px; font-weight: 600;
}
.info-catalysts {
  font-size: 10.5px; color: var(--text, #e6ecf5);
  line-height: 1.6;
}

/* ===== 次级主题卡 ===== */
.bento-sub-grid {
  display: flex; flex-direction: column; gap: 8px;
  min-height: 0;
}
.bento-sub {
  padding: 10px 12px;
  display: flex; flex-direction: column; gap: 5px;
  cursor: pointer;
}
.bento-sub:hover {
  background: rgba(255,255,255,.04);
  border-color: var(--border, #3a4458);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0,0,0,.3);
}
.bento-sub.str-strong {
  border-color: rgba(232,184,96,.2);
  background: linear-gradient(160deg, rgba(232,184,96,.06), transparent 70%);
}
.bento-sub.str-medium {
  border-color: rgba(78,161,255,.15);
  background: linear-gradient(160deg, rgba(78,161,255,.04), transparent 70%);
}
.bento-sub.str-weak { opacity: 0.8; }

.sub-header { display: flex; align-items: center; justify-content: space-between; }
.sub-rank {
  font-size: 10px; font-weight: 800; color: var(--text-dim, #6b7280);
  font-family: "SF Mono", monospace;
}
.sub-strength { display: flex; gap: 3px; }
.sub-strength .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: rgba(255,255,255,.08);
}
.bento-sub.str-strong .sub-strength .dot.active {
  background: var(--accent, #e8b860);
  box-shadow: 0 0 4px var(--accent, #e8b860);
}
.bento-sub.str-medium .sub-strength .dot.active {
  background: #4ea1ff;
  box-shadow: 0 0 4px #4ea1ff;
}
.bento-sub.str-weak .sub-strength .dot.active {
  background: #6b7280;
}

.sub-name {
  font-size: 12.5px; font-weight: 700; color: var(--text, #e6ecf5);
}
.sub-logic {
  font-size: 10.5px; color: var(--text-dim, #8a93a6);
  line-height: 1.6;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.sub-leaders {
  display: flex; gap: 6px; flex-wrap: wrap;
  font-size: 10px; color: #ff8a9e; font-weight: 600;
  margin-top: 2px;
}

/* ===== 风险条 ===== */
.risk-bar {
  flex-shrink: 0; display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 12px; border-radius: 8px;
  background: rgba(255, 107, 120, 0.06);
  border: 1px solid rgba(255, 107, 120, 0.18);
}
.risk-icon { color: #ff6b78; font-size: 13px; flex-shrink: 0; margin-top: 1px; }
.risk-text { font-size: 11.5px; color: #ffb0bc; line-height: 1.65; }

/* ===== 底部免责 ===== */
.disclaimer {
  flex-shrink: 0;
  font-size: 10px; color: var(--text-dim, #6b7280);
  display: flex; align-items: center; justify-content: center; gap: 5px;
  padding-top: 4px;
  border-top: 1px solid var(--border, #232834);
}
.disc-icon { font-size: 11px; }

/* ===== 响应式：窄卡模式 ===== */
:deep(.card-narrow) .bento-grid {
  grid-template-columns: 1fr;
}
:deep(.card-narrow) .bento-main {
  grid-row: auto;
}
</style>
