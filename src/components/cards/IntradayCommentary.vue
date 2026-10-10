<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from "vue";
import { aiIntradayCommentaryStream, type IntradayCommentary as Commentary, type StreamHandle } from "../../ai/commentary";
import { readAiCache, writeAiCache, formatCacheTime } from "../../utils/aiCache";
import { logger } from "../../utils/logger";

const CACHE_KEY = "intraday-commentary";

const loading = ref(false);
const refreshing = ref(false);
const error = ref("");
const data = ref<Commentary | null>(null);
const streamText = ref("");
const lastUpdate = ref("");
const fromCache = ref(false);
const slowLoading = ref(false);
let streamHandle: StreamHandle | null = null;
let slowTimer: ReturnType<typeof setTimeout> | null = null;

// 初始化：先读缓存，再后台刷新
function init() {
  const cached = readAiCache<Commentary>(CACHE_KEY);
  if (cached) {
    data.value = cached.data;
    fromCache.value = true;
    lastUpdate.value = formatCacheTime(cached.timestamp);
    // 缓存超过 5 分钟则后台刷新
    const stale = Date.now() - cached.timestamp > 5 * 60 * 1000;
    if (stale) void refresh(true);
  } else {
    void refresh(false);
  }
}

// 智能分类：大盘/板块/个股
const categorizedDrivers = computed(() => {
  if (!data.value) return { market: [], sector: [], stock: [] };
  const items = data.value.key_drivers;
  const market: string[] = [];
  const sector: string[] = [];
  const stock: string[] = [];
  items.forEach((item) => {
    const t = item.toLowerCase();
    if (/大盘|沪指|上证|深成|创业板|指数|市场|北向|成交|量能/.test(t)) {
      market.push(item);
    } else if (/板块|行业|概念|赛道|题材/.test(t)) {
      sector.push(item);
    } else if (/涨停|个股|龙头|连板/.test(t)) {
      stock.push(item);
    } else {
      sector.push(item);
    }
  });
  if (market.length === 0 && items.length > 0) market.push(items[0]);
  if (sector.length === 0 && items.length > 1) sector.push(items[1]);
  if (stock.length === 0 && items.length > 2) stock.push(items[2]);
  return { market, sector, stock };
});

// 情绪色调
const sentimentColor = computed(() => {
  if (!data.value) return "var(--accent, #e8c66a)";
  const text = data.value.market_view + data.value.key_drivers.join("");
  const pos = (text.match(/上涨|涨|反弹|走强|利好|净流入|突破|回暖|强势|积极/g) || []).length;
  const neg = (text.match(/下跌|跌|回调|走弱|利空|净流出|跌破|降温|弱势|风险/g) || []).length;
  if (pos > neg + 2) return "#ef5350";
  if (neg > pos + 2) return "#26a69a";
  return "var(--accent, #e8c66a)";
});

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

// backgroundRefresh: 后台刷新（有缓存时不显示全屏 loading）
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
  }, 8000);

  try {
    streamHandle = await aiIntradayCommentaryStream();
    streamHandle.onCached((full) => {
      const parsed = parseJson(full);
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
      const parsed = parseJson(full);
      if (parsed) {
        data.value = parsed;
        fromCache.value = false;
        writeAiCache(CACHE_KEY, parsed);
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
        logger.warn("盘中解读刷新失败，继续展示缓存", msg);
      } else {
        error.value = msg;
        logger.error("盘中解读失败", msg);
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
      logger.warn("盘中解读刷新失败，继续展示缓存", msg);
    } else {
      error.value = msg;
    }
    loading.value = false;
    refreshing.value = false;
  }
}

function dismissError() { error.value = ""; }

onMounted(init);
onBeforeUnmount(() => {
  if (streamHandle) streamHandle.unlisten();
  if (slowTimer) clearTimeout(slowTimer);
});
</script>

<template>
  <div class="intraday-brief">
    <div class="gold-bar"></div>

    <!-- 头部 -->
    <div class="brief-head">
      <div class="head-left">
        <div class="ai-badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/>
            <path d="M12 8v4l3 2"/>
          </svg>
          <span>AI 解读</span>
        </div>
        <h3 class="head-title">盘中解读</h3>
        <span v-if="fromCache" class="cache-tag" title="当前为缓存数据，后台正在刷新">缓存</span>
      </div>
      <div class="head-right">
        <span v-if="refreshing" class="refresh-pill">
          <span class="pulse-dot"></span>
          更新中
        </span>
        <span v-else-if="lastUpdate" class="update-time">{{ lastUpdate }}</span>
        <button class="refresh-btn" :disabled="loading && !fromCache" @click="refresh(false)" title="重新生成">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6"/>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
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
      <span>AI 生成需要一点时间… 越复杂的模型越慢</span>
    </div>

    <!-- 加载中（无缓存时显示全屏加载） -->
    <div v-if="loading && !data" class="loading-wrap">
      <div class="skeleton-summary">
        <div class="sk-line sk-line-1"></div>
        <div class="sk-line sk-line-2"></div>
        <div class="sk-line sk-line-3"></div>
      </div>
      <div class="skeleton-grid">
        <div class="sk-item" v-for="i in 4" :key="i">
          <div class="sk-val"></div>
          <div class="sk-label"></div>
        </div>
      </div>
      <div v-if="streamText" class="stream-preview">
        <div class="stream-label">
          <span class="live-dot"></span>
          AI 正在分析市场…
        </div>
        <div class="stream-text">{{ streamText }}<span class="cursor">▍</span></div>
      </div>
      <div v-else class="loading-hint">
        <svg class="spin-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
        <span>正在聚合大盘 / 板块 / 涨停池 / 快讯…</span>
      </div>
    </div>

    <!-- 错误态（无缓存时全屏显示） -->
    <div v-else-if="error && !data" class="error-wrap">
      <div class="error-icon">!</div>
      <div class="error-text">{{ error }}</div>
      <button class="retry-btn" @click="refresh(false)">重新生成</button>
    </div>

    <!-- 内容区 -->
    <div v-else-if="data" class="brief-body">
      <div class="summary-box" :style="{ borderColor: sentimentColor + '40', background: sentimentColor + '08' }">
        <div class="summary-label" :style="{ color: sentimentColor }">
          <span class="label-dot" :style="{ background: sentimentColor }"></span>
          核心观点
        </div>
        <p class="summary-text">{{ data.market_view }}</p>
      </div>

      <div class="driver-sections">
        <div v-if="categorizedDrivers.market.length" class="driver-section">
          <div class="section-tag tag-market">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 3v18h18"/>
              <path d="M7 14l4-4 4 4 5-5"/>
            </svg>
            大盘
          </div>
          <div class="section-content">
            <p v-for="(item, i) in categorizedDrivers.market.slice(0, 2)" :key="'m'+i">{{ item }}</p>
          </div>
        </div>
        <div v-if="categorizedDrivers.sector.length" class="driver-section">
          <div class="section-tag tag-sector">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="7" height="7"/>
              <rect x="14" y="3" width="7" height="7"/>
              <rect x="14" y="14" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/>
            </svg>
            板块
          </div>
          <div class="section-content">
            <p v-for="(item, i) in categorizedDrivers.sector.slice(0, 2)" :key="'s'+i">{{ item }}</p>
          </div>
        </div>
        <div v-if="categorizedDrivers.stock.length" class="driver-section">
          <div class="section-tag tag-stock">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            个股
          </div>
          <div class="section-content">
            <p v-for="(item, i) in categorizedDrivers.stock.slice(0, 2)" :key="'k'+i">{{ item }}</p>
          </div>
        </div>
      </div>

      <div v-if="data.risk_notes.length > 0" class="risk-box">
        <div class="risk-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          风险提示
        </div>
        <div class="risk-list">
          <div v-for="(r, i) in data.risk_notes.slice(0, 3)" :key="i" class="risk-item">
            <span class="risk-bullet">!</span>
            <span>{{ r }}</span>
          </div>
        </div>
      </div>

      <div class="brief-foot">
        <span class="foot-text">AI 生成内容仅供参考 · 不构成投资建议</span>
        <span class="foot-src">沪深交易所</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.intraday-brief {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  position: relative;
  background: linear-gradient(160deg, var(--bg-card, #17130b) 0%, var(--bg-card2, #120f08) 100%);
  overflow: hidden;
}

/* 顶部金色光条 */
.gold-bar {
  position: absolute; top: 0; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent 0%, var(--accent, #e8c66a) 50%, transparent 100%);
  opacity: 0.7;
}

/* 头部 */
.brief-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px 10px;
  flex-shrink: 0;
}
.head-left { display: flex; align-items: center; gap: 10px; }
.ai-badge {
  display: flex; align-items: center; gap: 5px;
  padding: 4px 10px; border-radius: 6px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent, #e8c66a) 20%, transparent), color-mix(in srgb, var(--accent, #e8c66a) 8%, transparent));
  border: 1px solid color-mix(in srgb, var(--accent, #e8c66a) 30%, transparent);
  color: var(--accent, #e8c66a);
  font-size: 11px; font-weight: 700;
}
.ai-badge svg { width: 13px; height: 13px; }
.head-title { font-size: 14px; font-weight: 700; color: var(--text, #e6ecf5); margin: 0; }
.cache-tag {
  font-size: 9px; padding: 2px 6px;
  background: rgba(138, 147, 166, 0.15);
  color: var(--text-dim, #8a93a6);
  border-radius: 4px;
  border: 1px solid rgba(138, 147, 166, 0.2);
}

.head-right { display: flex; align-items: center; gap: 8px; }
.refresh-pill {
  display: flex; align-items: center; gap: 5px;
  font-size: 10.5px; color: var(--accent, #e8c66a);
  padding: 3px 8px; border-radius: 10px;
  background: color-mix(in srgb, var(--accent, #e8c66a) 10%, transparent);
}
.pulse-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent, #e8c66a);
  animation: pulse 1.5s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.8); }
}
.update-time { font-size: 10.5px; color: var(--text-dim, #8a93a6); }
.refresh-btn {
  width: 26px; height: 26px; border-radius: 6px;
  border: 1px solid var(--border, #2a2418);
  background: var(--bg-card2, #120f08);
  color: var(--text-dim, #8a93a6);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.2s; flex-shrink: 0;
}
.refresh-btn svg { width: 13px; height: 13px; }
.refresh-btn:hover:not(:disabled) {
  border-color: var(--accent, #e8c66a);
  color: var(--accent, #e8c66a);
}
.refresh-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* 错误提示条 */
.error-bar {
  display: flex; align-items: center; gap: 8px;
  margin: 0 14px 8px;
  padding: 6px 10px;
  background: rgba(255, 107, 120, 0.1);
  border: 1px solid rgba(255, 107, 120, 0.25);
  border-radius: 6px;
  font-size: 10.5px;
  color: #ff8a93;
  cursor: pointer;
  flex-shrink: 0;
}
.err-ic {
  width: 16px; height: 16px; border-radius: 50%;
  background: rgba(255, 107, 120, 0.2);
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 800;
  flex-shrink: 0;
}
.err-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.err-close { font-size: 14px; opacity: 0.6; }

/* 慢加载提示 */
.slow-hint {
  margin: 0 14px 8px;
  padding: 6px 10px;
  background: rgba(232, 198, 106, 0.08);
  border: 1px solid rgba(232, 198, 106, 0.2);
  border-radius: 6px;
  font-size: 10.5px;
  color: var(--accent, #e8c66a);
  text-align: center;
  flex-shrink: 0;
  animation: fadeIn 0.3s ease;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ========== 加载态 ========== */
.loading-wrap {
  flex: 1; min-height: 0;
  padding: 0 14px 14px;
  display: flex; flex-direction: column;
  gap: 12px;
}
.skeleton-summary {
  padding: 12px; border-radius: 8px;
  background: color-mix(in srgb, var(--accent, #e8c66a) 5%, transparent);
  border: 1px dashed color-mix(in srgb, var(--accent, #e8c66a) 15%, transparent);
}
.sk-line {
  height: 10px; border-radius: 4px;
  background: linear-gradient(90deg, var(--bg-hover, #201b0e), var(--bg-card, #17130b), var(--bg-hover, #201b0e));
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
  margin-bottom: 8px;
}
.sk-line-1 { width: 60%; }
.sk-line-2 { width: 85%; }
.sk-line-3 { width: 70%; margin-bottom: 0; }
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.skeleton-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
}
.sk-item {
  background: var(--bg-card2, #120f08);
  border-radius: 6px;
  padding: 10px 6px;
  text-align: center;
}
.sk-val {
  width: 70%; height: 16px; margin: 0 auto 6px;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--bg-hover, #201b0e), var(--bg-card, #17130b), var(--bg-hover, #201b0e));
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}
.sk-label {
  width: 50%; height: 9px; margin: 0 auto;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--bg-hover, #201b0e), var(--bg-card, #17130b), var(--bg-hover, #201b0e));
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}
.stream-preview {
  flex: 1; min-height: 0;
  background: var(--bg-card2, #120f08);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex; flex-direction: column; gap: 8px;
  overflow: hidden;
}
.stream-label {
  display: flex; align-items: center; gap: 6px;
  font-size: 10.5px; color: var(--accent, #e8c66a);
  font-weight: 600; flex-shrink: 0;
}
.live-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #ef5350;
  animation: pulse 1.2s ease-in-out infinite;
}
.stream-text {
  flex: 1; min-height: 0; overflow-y: auto;
  font-size: 11.5px; line-height: 1.7;
  color: var(--text, #e6ecf5);
  white-space: pre-wrap; word-break: break-word;
}
.cursor { color: var(--accent, #e8c66a); animation: blink 1s step-end infinite; font-weight: 300; }
@keyframes blink { 50% { opacity: 0; } }

.loading-hint {
  flex: 1;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 12px;
  color: var(--text-dim, #8a93a6);
  font-size: 12px;
}
.spin-icon {
  width: 28px; height: 28px;
  color: var(--accent, #e8c66a);
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ========== 错误态 ========== */
.error-wrap {
  flex: 1;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 12px; padding: 20px;
}
.error-icon {
  width: 40px; height: 40px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 22px; font-weight: 800;
  color: #ff6b78;
  background: rgba(255, 93, 107, 0.12);
  border: 1px solid rgba(255, 93, 107, 0.35);
}
.error-text {
  text-align: center;
  color: var(--text-dim, #8a93a6);
  font-size: 12px;
  max-width: 80%; line-height: 1.5;
}
.retry-btn {
  padding: 6px 18px; font-size: 11.5px;
  border-radius: 6px;
  border: 1px solid var(--accent, #e8c66a);
  background: transparent;
  color: var(--accent, #e8c66a);
  cursor: pointer;
  transition: all 0.2s;
}
.retry-btn:hover { background: color-mix(in srgb, var(--accent, #e8c66a) 12%, transparent); }

/* ========== 内容区 ========== */
.brief-body {
  flex: 1; min-height: 0;
  padding: 0 14px 12px;
  display: flex; flex-direction: column; gap: 12px;
  overflow-y: auto;
}
.brief-body::-webkit-scrollbar { width: 4px; }
.brief-body::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--accent, #e8c66a) 25%, transparent);
  border-radius: 2px;
}

.summary-box {
  border: 1px solid;
  border-left-width: 3px;
  border-radius: 0 8px 8px 0;
  padding: 12px 14px;
  transition: all 0.3s;
}
.summary-label {
  display: flex; align-items: center; gap: 6px;
  font-size: 10.5px; font-weight: 700;
  letter-spacing: 1px; text-transform: uppercase;
  margin-bottom: 8px;
}
.label-dot {
  width: 6px; height: 6px; border-radius: 50%;
  box-shadow: 0 0 8px currentColor;
}
.summary-text {
  font-size: 12.5px; line-height: 1.7;
  color: var(--text, #e6ecf5);
  margin: 0;
}

.driver-sections { display: flex; flex-direction: column; gap: 8px; }
.driver-section {
  display: flex; gap: 10px;
  padding: 8px 0;
  border-top: 1px solid color-mix(in srgb, var(--text, #e6ecf5) 6%, transparent);
}
.section-tag {
  flex-shrink: 0;
  display: flex; align-items: center; gap: 4px;
  padding: 4px 9px; border-radius: 5px;
  font-size: 10.5px; font-weight: 700;
  height: fit-content;
}
.section-tag svg { width: 11px; height: 11px; }
.tag-market {
  background: rgba(239, 83, 80, 0.12);
  color: #ef5350;
  border: 1px solid rgba(239, 83, 80, 0.2);
}
.tag-sector {
  background: color-mix(in srgb, var(--accent, #e8c66a) 15%, transparent);
  color: var(--accent, #e8c66a);
  border: 1px solid color-mix(in srgb, var(--accent, #e8c66a) 25%, transparent);
}
.tag-stock {
  background: rgba(38, 166, 154, 0.12);
  color: #26a69a;
  border: 1px solid rgba(38, 166, 154, 0.2);
}
.section-content { flex: 1; min-width: 0; }
.section-content p {
  font-size: 12px; line-height: 1.6;
  color: color-mix(in srgb, var(--text, #e6ecf5) 85%, transparent);
  margin: 0 0 4px 0;
}
.section-content p:last-child { margin-bottom: 0; }

.risk-box {
  background: rgba(255, 107, 120, 0.06);
  border: 1px solid rgba(255, 107, 120, 0.15);
  border-radius: 8px;
  padding: 10px 12px;
}
.risk-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 700;
  color: #ff8a8a;
  margin-bottom: 8px;
}
.risk-title svg { width: 13px; height: 13px; }
.risk-list { display: flex; flex-direction: column; gap: 5px; }
.risk-item {
  display: flex; align-items: flex-start; gap: 6px;
  font-size: 11.5px;
  color: #ffb0b0; line-height: 1.5;
}
.risk-bullet {
  flex-shrink: 0;
  width: 14px; height: 14px; border-radius: 50%;
  background: rgba(255, 107, 120, 0.2);
  color: #ff8a8a;
  font-size: 10px; font-weight: 800;
  display: flex; align-items: center; justify-content: center;
  margin-top: 1px;
}

.brief-foot {
  display: flex; justify-content: space-between; align-items: center;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--text, #e6ecf5) 6%, transparent);
  flex-shrink: 0;
}
.foot-text { font-size: 10px; color: var(--text-dim, #8a93a6); }
.foot-src { font-size: 10px; color: color-mix(in srgb, var(--text-dim, #8a93a6) 70%, transparent); }
</style>
