<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { emit as tauriEmit } from "@tauri-apps/api/event";
import {
  aiNewsDigestStream,
  type NewsDigest as Digest,
  type NewsDigestItem,
  type Sentiment,
  type StreamHandle,
} from "../../ai/commentary";
import { fetchNewsFlash, fetchQuotes, type NewsItem } from "../../api/market";
import { openInAppBrowser } from "../../utils/openInApp";
import { readAiCache, writeAiCache, formatCacheTime } from "../../utils/aiCache";
import { useSmartPolling } from "../../composables/useSmartPolling";
import { logger } from "../../utils/logger";

const emit = defineEmits<{ select: [code: string] }>();

const CACHE_KEY = "news-digest";

// ====== 模式：ai 聚合模式｜direct 直接快讯模式（AI 不可用时自动降级） ======
const mode = ref<"ai" | "direct">("ai");
const aiFailed = ref(false);
const fromCache = ref(false);

// ====== AI 聚合模式数据 ======
const loading = ref(false);
const refreshing = ref(false);
const error = ref("");
const data = ref<Digest | null>(null);
const streamText = ref("");
const activeTab = ref<"all" | "macro" | "industry" | "stock">("all");
const lastUpdate = ref("");
const quoteMap = ref<Record<string, number>>({});
let streamHandle: StreamHandle | null = null;

// ====== 直接快讯模式数据（与盘中快讯一致的加载方式） ======
const flashItems = ref<NewsItem[]>([]);
const flashLoading = ref(false);
const flashPage = ref(1);
const flashSeen = new Set<number>();
const flashLive = ref(true);

const tabs = [
  { key: "all", label: "全部" },
  { key: "macro", label: "宏观" },
  { key: "industry", label: "行业" },
  { key: "stock", label: "个股" },
] as const;

function hm(t: string): string {
  return t.length >= 16 ? t.substring(11, 16) : t;
}

function categoryColor(cat: string): string {
  switch (cat) {
    case "macro": return "#4ea1ff";
    case "industry": return "#35c4a8";
    default: return "#e8c66a";
  }
}

function categoryLabel(cat: string): string {
  switch (cat) {
    case "macro": return "宏观";
    case "industry": return "行业";
    case "stock": return "个股";
    default: return cat;
  }
}

const sentimentMeta: Record<Sentiment, { label: string; cls: string }> = {
  bull: { label: "利好", cls: "bull" },
  bear: { label: "利空", cls: "bear" },
  neutral: { label: "中性", cls: "neutral" },
};

function sentimentOf(s: string): Sentiment {
  return s === "bull" || s === "bear" ? s : "neutral";
}

function scopeLabel(s: string): string {
  switch (s) {
    case "market": return "大盘";
    case "sector": return "板块";
    default: return "个股";
  }
}

function isStockCode(c: string): boolean {
  return /^\d{6}$/.test(c);
}

// ====== AI 模式：头条 & 时间线 ======
const hero = computed<NewsDigestItem | null>(() => {
  if (activeTab.value !== "all" || !data.value) return null;
  return data.value.items.find((i) => i.importance >= 3) ?? null;
});

const timeline = computed<NewsDigestItem[]>(() => {
  if (!data.value) return [];
  let list = activeTab.value === "all"
    ? data.value.items
    : data.value.items.filter((i) => i.category === activeTab.value);
  if (hero.value) list = list.filter((i) => i !== hero.value);
  return [...list].sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
});

// ====== AI 模式：加载关联个股行情 ======
async function loadQuotes(items: NewsDigestItem[]) {
  const codes = [...new Set(items.flatMap((i) => i.related_codes).filter(isStockCode))];
  if (codes.length === 0) { quoteMap.value = {}; return; }
  try {
    const quotes = await fetchQuotes(codes);
    const map: Record<string, number> = {};
    for (const q of quotes) map[q.code] = q.pct;
    quoteMap.value = map;
  } catch (e) {
    logger.warn("资讯关联行情获取失败", "NewsDigest", e);
  }
}

// ====== AI 模式：解析聚合结果 ======
function parseDigest(text: string): Digest | null {
  try {
    const cleaned = text.trim().replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
    const v = JSON.parse(cleaned);
    const rawItems: any[] = Array.isArray(v) ? v : (v.items || []);
    const items: NewsDigestItem[] = rawItems.map((item: any) => ({
      title: item.title || "",
      summary: item.summary || "",
      category: item.category === "industry" || item.category === "stock" ? item.category : "macro",
      related_codes: Array.isArray(item.related_codes) ? item.related_codes : [],
      time: item.time || "",
      url: item.url || "",
      sentiment: item.sentiment === "bull" || item.sentiment === "bear" ? item.sentiment : "neutral",
      importance: Math.min(3, Math.max(1, Number(item.importance) || 1)),
      impact_scope: item.impact_scope === "market" || item.impact_scope === "sector" ? item.impact_scope : "stock",
      source: item.source || "快讯",
    }));
    return {
      generated_at: Date.now(),
      ai_brief: typeof v.ai_brief === "string" ? v.ai_brief : "",
      macro_count: items.filter((i) => i.category === "macro").length,
      industry_count: items.filter((i) => i.category === "industry").length,
      stock_count: items.filter((i) => i.category === "stock").length,
      items,
    };
  } catch { return null; }
}

function applyDigest(parsed: Digest) {
  data.value = parsed;
  void loadQuotes(parsed.items);
}

// ====== AI 模式：初始化（先读缓存，再后台刷新） ======
function initAi() {
  const cached = readAiCache<Digest>(CACHE_KEY);
  if (cached) {
    applyDigest(cached.data);
    fromCache.value = true;
    loading.value = false;
    lastUpdate.value = formatCacheTime(cached.timestamp);
    // 缓存超过 10 分钟则后台刷新
    const stale = Date.now() - cached.timestamp > 10 * 60 * 1000;
    if (stale) void refreshAi(true);
  } else {
    void refreshAi(false);
  }
}

// ====== AI 模式：刷新 ======
async function refreshAi(backgroundRefresh = false) {
  if (streamHandle) { streamHandle.unlisten(); streamHandle = null; }
  if (!backgroundRefresh) {
    loading.value = true;
    error.value = "";
  }
  refreshing.value = !backgroundRefresh;
  streamText.value = "";
  fromCache.value = false;
  try {
    streamHandle = await aiNewsDigestStream();
    streamHandle.onCached((full) => {
      const parsed = parseDigest(full);
      if (parsed) {
        applyDigest(parsed);
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
      const parsed = parseDigest(full);
      if (parsed) {
        applyDigest(parsed);
        aiFailed.value = false;
        fromCache.value = false;
        writeAiCache(CACHE_KEY, parsed); // 写入缓存
      } else if (!data.value) {
        // 解析失败且没缓存 → 降级
        aiFailed.value = true;
        mode.value = "direct";
        void loadFlash(1);
      }
      loading.value = false;
      refreshing.value = false;
      lastUpdate.value = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    });
    streamHandle.onError((msg) => {
      if (data.value) {
        // 有缓存 → 只显示错误条，不降级
        error.value = msg;
        logger.warn("资讯聚合刷新失败，继续展示缓存", msg);
      } else {
        // 没缓存 → 降级到直接模式
        error.value = msg;
        aiFailed.value = true;
        mode.value = "direct";
        logger.warn("资讯聚合 AI 失败，降级为直接快讯模式", msg);
        void loadFlash(1);
      }
      loading.value = false;
      refreshing.value = false;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (data.value) {
      error.value = msg;
      logger.warn("资讯聚合刷新失败，继续展示缓存", msg);
    } else {
      error.value = msg;
      aiFailed.value = true;
      mode.value = "direct";
      void loadFlash(1);
    }
    loading.value = false;
    refreshing.value = false;
  }
}

// ====== 直接快讯模式：加载 ======
async function loadFlash(p: number) {
  if (flashLoading.value) return;
  flashLoading.value = true;
  try {
    const list = await fetchNewsFlash(p, 30);
    if (p === 1) {
      const fresh = list.filter((x) => !flashSeen.has(x.id));
      flashItems.value = [...fresh, ...flashItems.value];
    } else {
      const more = list.filter((x) => !flashSeen.has(x.id));
      flashItems.value = [...flashItems.value, ...more];
    }
    list.forEach((x) => flashSeen.add(x.id));
    lastUpdate.value = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (e) {
    logger.error("资讯加载失败", "NewsDigest", e);
  }
  flashLoading.value = false;
}

function onFlashScroll(e: Event) {
  if (mode.value !== "direct") return;
  const el = e.target as HTMLElement;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
    flashPage.value += 1;
    void loadFlash(flashPage.value);
  }
}

// ====== 打开原文（与盘中快讯完全一致的方式） ======
function openUrl(item: { url?: string; title?: string; text?: string }) {
  if (!item.url) return;
  const title = (item.title || item.text || "资讯原文").replace(/\s+/g, " ").slice(0, 26);
  void openInAppBrowser(item.url, title);
}

function openAiSettings() { tauriEmit("open-ai-settings"); }

// ====== 统一刷新入口 ======
function refresh() {
  if (mode.value === "ai") {
    void refreshAi(false);
  } else {
    flashPage.value = 1;
    flashItems.value = [];
    flashSeen.clear();
    void loadFlash(1);
  }
}

// 切换模式
function switchMode(m: "ai" | "direct") {
  mode.value = m;
  if (m === "ai" && !data.value && !loading.value) {
    void refreshAi();
  } else if (m === "direct" && flashItems.value.length === 0) {
    void loadFlash(1);
  }
}

// ====== 初始化：先读缓存，再后台刷新 AI ======
onMounted(() => {
  initAi();
});

onBeforeUnmount(() => {
  if (streamHandle) streamHandle.unlisten();
});

// 直接模式下启用智能轮询（与盘中快讯一致）
useSmartPolling(() => {
  if (mode.value === "direct" && flashLive.value) {
    flashPage.value = 1;
    void loadFlash(1);
  }
}, { interval: 45000, cardId: "newsdigest" });
</script>

<template>
  <div class="news-digest-card">
    <!-- 头部 -->
    <div class="card-header">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="header-title">资讯聚合</span>
        <span v-if="mode === 'ai' && fromCache" class="cache-tag" title="当前为缓存数据">缓存</span>
      </div>
      <div class="header-actions">
        <!-- 模式切换 -->
        <div class="mode-switch">
          <button
            class="mode-btn" :class="{ active: mode === 'ai' }"
            @click="switchMode('ai')" title="AI 智能聚合"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/>
              <path d="M12 8v4l3 2"/>
            </svg>
            AI
          </button>
          <button
            class="mode-btn" :class="{ active: mode === 'direct' }"
            @click="switchMode('direct')" title="实时快讯流"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>
            </svg>
            快讯
          </button>
        </div>
        <span v-if="mode === 'direct'" class="live">
          <span class="dot" :class="{ on: flashLive }"></span>
          直播中
        </span>
        <span v-else-if="refreshing" class="live">
          <span class="dot on"></span>
          更新中…
        </span>
        <span v-if="lastUpdate" class="update-time">{{ lastUpdate }}</span>
        <button class="refresh-btn" :disabled="loading || flashLoading" @click="refresh">
          {{ loading || flashLoading ? "刷新中…" : "刷新" }}
        </button>
      </div>
    </div>

    <!-- ========== AI 聚合模式 ========== -->
    <template v-if="mode === 'ai'">
      <!-- 错误提示条（有缓存时） -->
      <div v-if="error && data" class="error-bar" @click="error = ''">
        <span class="err-ic">!</span>
        <span class="err-msg">刷新失败：{{ error }}</span>
        <span class="err-close">×</span>
      </div>

      <!-- AI 盘面一句话综述 -->
      <div v-if="data && data.ai_brief" class="ai-brief">
        <span class="ai-tag">AI 综述</span>
        {{ data.ai_brief }}
      </div>

      <div v-if="data" class="tabs">
        <button
          v-for="t in tabs" :key="t.key"
          class="tab" :class="{ active: activeTab === t.key }"
          @click="activeTab = t.key"
        >
          {{ t.label }}
          <i>{{ t.key === "all" ? data.items.length : t.key === "macro" ? data.macro_count : t.key === "industry" ? data.industry_count : data.stock_count }}</i>
        </button>
      </div>

      <!-- 加载中 -->
      <div v-if="loading && !data" class="loading-state">
        <div class="spinner"></div>
        <span v-if="!streamText">AI 正在去重、分类、研判多空…</span>
        <div v-else class="stream-text">{{ streamText }}<span class="cursor">▊</span></div>
        <button class="fallback-btn" @click="switchMode('direct')">
          等不及？切换到实时快讯
        </button>
      </div>

      <!-- 错误态 -->
      <div v-else-if="error && !data" class="error-state">
        <div class="error-icon">!</div>
        <div class="error-text">AI 聚合暂不可用</div>
        <div class="error-actions">
          <button class="retry-btn" @click="refreshAi()">重试 AI</button>
          <button class="config-btn" @click="openAiSettings">配置 AI</button>
        </div>
        <button class="fallback-btn primary" @click="switchMode('direct')">
          查看实时快讯
        </button>
        <div class="error-hint">AI 功能需配置大模型（本地 Ollama 或云端 API Key）</div>
      </div>

      <!-- 内容 -->
      <div v-else class="news-body">
        <!-- 头条大卡 -->
        <div v-if="hero" class="hero" @click="openUrl(hero)">
          <span class="hero-flame">🔥 头条 · ★★★</span>
          <div class="hero-title">{{ hero.title }}</div>
          <div v-if="hero.summary" class="hero-summary">{{ hero.summary }}</div>
          <div class="chips">
            <span class="chip" :class="sentimentMeta[sentimentOf(hero.sentiment)].cls">
              {{ sentimentMeta[sentimentOf(hero.sentiment)].label }}
            </span>
            <span class="chip cat" :style="{ background: categoryColor(hero.category) + '22', color: categoryColor(hero.category) }">
              {{ categoryLabel(hero.category) }}
            </span>
            <span class="chip scope">影响 · {{ scopeLabel(hero.impact_scope) }}</span>
            <template v-for="c in hero.related_codes.filter(isStockCode)" :key="c">
              <span class="chip stock" @click.stop="emit('select', c)">{{ c }}</span>
              <span v-if="quoteMap[c] !== undefined" class="chip" :class="quoteMap[c] >= 0 ? 'up' : 'down'">
                {{ (quoteMap[c] >= 0 ? "+" : "") + quoteMap[c].toFixed(1) + "%" }}
              </span>
            </template>
            <span class="hero-meta">{{ hm(hero.time) }} · {{ hero.source }} ›</span>
          </div>
        </div>

        <!-- 时间线 -->
        <div class="timeline">
          <div
            v-for="(item, idx) in timeline" :key="idx" class="t-item"
            @click="openUrl(item)"
          >
            <span class="t-time">{{ hm(item.time) }}</span>
            <div class="t-line">
              <div class="t-title">
                <span v-if="item.importance >= 3" class="stars">★</span>
                {{ item.title }}
              </div>
              <div v-if="item.summary" class="t-summary">{{ item.summary }}</div>
              <div class="chips">
                <span class="chip sm" :class="sentimentMeta[sentimentOf(item.sentiment)].cls">
                  {{ sentimentMeta[sentimentOf(item.sentiment)].label }}
                </span>
                <span class="chip sm cat" :style="{ background: categoryColor(item.category) + '22', color: categoryColor(item.category) }">
                  {{ categoryLabel(item.category) }}
                </span>
                <template v-for="c in item.related_codes.filter(isStockCode)" :key="c">
                  <span class="chip sm stock" @click.stop="emit('select', c)">{{ c }}</span>
                  <span v-if="quoteMap[c] !== undefined" class="chip sm" :class="quoteMap[c] >= 0 ? 'up' : 'down'">
                    {{ (quoteMap[c] >= 0 ? "+" : "") + quoteMap[c].toFixed(1) + "%" }}
                  </span>
                </template>
                <span class="t-src">{{ item.source }}</span>
              </div>
            </div>
          </div>
          <div v-if="timeline.length === 0" class="empty-state">该分类暂无资讯</div>
        </div>
      </div>
    </template>

    <!-- ========== 直接快讯模式（与盘中快讯一致） ========== -->
    <template v-else>
      <div v-if="aiFailed" class="mode-hint">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>
        </svg>
        <span>实时快讯流 · AI 不可用时自动降级到此模式</span>
        <button class="hint-close" @click="switchMode('ai')" title="切回 AI 模式">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/>
            <path d="M12 8v4l3 2"/>
          </svg>
          启用 AI
        </button>
      </div>

      <div class="flash-list" @scroll="onFlashScroll">
        <div
          v-for="n in flashItems" :key="n.id" class="flash-item"
          @click="openUrl(n)"
        >
          <span class="f-time">{{ hm(n.time) }}</span>
          <span v-for="(t, i) in n.tags" :key="i" class="f-tag">{{ t }}</span>
          <span class="f-text">{{ n.text }}</span>
        </div>
        <div v-if="flashLoading && flashItems.length > 0" class="f-load">加载中…</div>
        <div v-if="flashItems.length === 0 && !flashLoading" class="empty-state">暂无快讯</div>
      </div>
    </template>

    <div class="disclaimer">
      <template v-if="mode === 'ai'">AI 生成，仅供参考，不构成投资建议</template>
      <template v-else>资讯来源：新浪财经 7×24</template>
    </div>
  </div>
</template>

<style scoped>
.news-digest-card {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  padding: 10px 12px;
  gap: 8px;
  overflow: hidden;
}

/* ===== 头部 ===== */
.card-header {
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
}
.header-title {
  font-size: 13px; font-weight: 700;
  color: var(--accent, #e8c66a);
}
.header-actions {
  display: flex; align-items: center; gap: 6px;
}

/* 模式切换 */
.mode-switch {
  display: flex;
  background: var(--bg-card2, #0d1015);
  border: 1px solid var(--border, #2a3344);
  border-radius: 6px;
  padding: 2px;
}
.mode-btn {
  display: flex; align-items: center; gap: 3px;
  padding: 2px 7px;
  font-size: 10px;
  border: none;
  background: transparent;
  color: var(--text-dim, #8a93a6);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
}
.mode-btn svg { width: 11px; height: 11px; }
.mode-btn.active {
  background: rgba(176, 124, 255, 0.2);
  color: #b07cff;
}
.mode-btn:hover:not(.active) { color: var(--text, #e6ecf5); }

.live {
  font-size: 9.5px;
  color: var(--text-dim, #8a93a6);
  display: flex; align-items: center; gap: 4px;
}
.dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #5d6878;
}
.dot.on {
  background: #08c98a;
  box-shadow: 0 0 6px rgba(8, 201, 138, 0.8);
  animation: pulse 1.6s infinite;
}
@keyframes pulse { 50% { opacity: 0.4; } }

.update-time {
  font-size: 10px;
  color: var(--text-dim, #8a93a6);
  font-variant-numeric: tabular-nums;
}
.refresh-btn {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 6px;
  border: 1px solid var(--border, #2a3344);
  background: var(--bg-card, #15181f);
  color: var(--text, #e6ecf5);
  cursor: pointer;
  flex-shrink: 0;
}
.refresh-btn:hover:not(:disabled) { border-color: var(--accent, #e8c66a); }
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
  margin: 0 2px 6px;
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

/* ===== AI 综述 ===== */
.ai-brief {
  position: relative;
  flex-shrink: 0;
  background: linear-gradient(135deg, rgba(176, 124, 255, 0.12), rgba(78, 161, 255, 0.06));
  border: 1px solid rgba(176, 124, 255, 0.28);
  border-radius: 9px;
  padding: 9px 10px 8px;
  font-size: 11px;
  line-height: 1.6;
  color: #d8cff0;
}
.ai-tag {
  display: inline-block;
  font-size: 8.5px;
  font-weight: 700;
  color: #fff;
  background: #b07cff;
  border-radius: 4px;
  padding: 0 5px;
  margin-right: 5px;
  vertical-align: 1px;
}

/* ===== Tabs ===== */
.tabs { display: flex; gap: 4px; flex-shrink: 0; }
.tab {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-dim, #8a93a6);
  cursor: pointer;
}
.tab i {
  font-style: normal;
  font-size: 9px;
  opacity: 0.7;
  margin-left: 2px;
}
.tab.active {
  background: rgba(232, 198, 106, 0.12);
  color: var(--accent, #e8c66a);
  border-color: rgba(232, 198, 106, 0.3);
}
.tab:hover:not(.active) { color: var(--text, #e6ecf5); }

/* ===== 加载 / 错误 ===== */
.loading-state, .error-state {
  flex: 1;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 10px;
  color: var(--text-dim, #8a93a6);
  font-size: 12px;
}
.spinner {
  width: 24px; height: 24px;
  border: 2px solid var(--border, #2a3344);
  border-top-color: var(--accent, #e8c66a);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.stream-text {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text, #e6ecf5);
  max-width: 100%;
  word-break: break-word;
  text-align: left;
  white-space: pre-wrap;
  max-height: 160px;
  overflow-y: auto;
}
.cursor { animation: blink 1s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }

.fallback-btn {
  margin-top: 4px;
  padding: 5px 14px;
  font-size: 11px;
  border-radius: 6px;
  border: 1px solid var(--border, #2a3344);
  background: var(--bg-card, #15181f);
  color: var(--text-dim, #8a93a6);
  cursor: pointer;
  transition: all 0.15s;
}
.fallback-btn:hover {
  border-color: #b07cff;
  color: #b07cff;
}
.fallback-btn.primary {
  border-color: #b07cff;
  background: rgba(176, 124, 255, 0.15);
  color: #b07cff;
  font-weight: 600;
}

.error-icon {
  width: 32px; height: 32px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; font-weight: 800;
  color: #ff6b78;
  background: rgba(255, 93, 107, 0.12);
  border: 1px solid rgba(255, 93, 107, 0.35);
}
.error-text { text-align: center; }
.retry-btn, .config-btn {
  padding: 5px 16px;
  font-size: 11px;
  border-radius: 6px;
  border: 1px solid var(--border, #2a3344);
  background: var(--bg-card, #15181f);
  color: var(--text, #e6ecf5);
  cursor: pointer;
}
.retry-btn:hover { border-color: var(--accent, #e8c66a); }
.config-btn {
  border-color: var(--accent, #e8c66a);
  background: rgba(232, 198, 106, 0.12);
  color: var(--accent, #e8c66a);
  font-weight: 600;
}
.config-btn:hover { background: rgba(232, 198, 106, 0.22); }
.error-actions { display: flex; gap: 8px; }
.error-hint {
  font-size: 10px;
  color: var(--text-dim, #8a93a6);
  margin-top: 4px;
}

/* ===== 内容区 ===== */
.news-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 头条 */
.hero {
  flex-shrink: 0;
  position: relative;
  cursor: pointer;
  border: 1px solid rgba(255, 93, 107, 0.35);
  background: linear-gradient(135deg, rgba(255, 93, 107, 0.1), rgba(255, 93, 107, 0.02));
  border-radius: 10px;
  padding: 10px 12px;
}
.hero:hover { border-color: rgba(255, 93, 107, 0.6); }
.hero-flame { font-size: 9px; color: #ff7080; font-weight: 700; }
.hero-title {
  font-size: 13px;
  font-weight: 700;
  line-height: 1.45;
  margin: 4px 0;
}
.hero-summary {
  font-size: 11px;
  color: var(--text-dim, #b0b8c8);
  line-height: 1.55;
  margin-bottom: 7px;
}
.hero-meta {
  margin-left: auto;
  font-size: 9px;
  color: var(--text-dim, #8a93a6);
  white-space: nowrap;
}

/* 时间线 */
.timeline { display: flex; flex-direction: column; }
.t-item {
  display: flex;
  gap: 10px;
  padding: 8px 2px;
  border-bottom: 1px solid rgba(42, 51, 68, 0.5);
  cursor: pointer;
}
.t-item:last-child { border-bottom: none; }
.t-item:hover .t-title { color: #fff; }
.t-time {
  font-size: 9.5px;
  color: #5d6878;
  font-variant-numeric: tabular-nums;
  padding-top: 2px;
  flex: none;
  width: 34px;
}
.t-line { flex: 1; min-width: 0; }
.t-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text, #e6ecf5);
  line-height: 1.45;
  transition: color 0.15s;
}
.stars { color: var(--accent, #e8c66a); margin-right: 2px; }
.t-summary {
  font-size: 10.5px;
  color: var(--text-dim, #8a93a6);
  line-height: 1.5;
  margin-top: 2px;
}
.t-src {
  margin-left: auto;
  font-size: 9px;
  color: #5d6878;
  white-space: nowrap;
}

/* chips */
.chips {
  display: flex;
  gap: 4px;
  margin-top: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.chip {
  flex: none;
  font-size: 9px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
}
.chip.sm { font-size: 8.5px; padding: 0 5px; }
.chip.bull { background: rgba(255, 93, 107, 0.14); color: #ff8a93; }
.chip.bear { background: rgba(8, 201, 138, 0.14); color: #3ddcaa; }
.chip.neutral { background: rgba(138, 147, 166, 0.14); color: var(--text-dim, #8a93a6); }
.chip.up { background: rgba(255, 93, 107, 0.14); color: #ff8a93; font-family: Consolas, monospace; }
.chip.down { background: rgba(8, 201, 138, 0.14); color: #3ddcaa; font-family: Consolas, monospace; }
.chip.scope { background: rgba(138, 147, 166, 0.1); color: var(--text-dim, #8a93a6); }
.chip.stock {
  background: rgba(232, 198, 106, 0.12);
  color: var(--accent, #e8c66a);
  font-family: Consolas, monospace;
  cursor: pointer;
}
.chip.stock:hover { background: rgba(232, 198, 106, 0.25); }

.empty-state {
  flex: 1;
  display: flex; align-items: center; justify-content: center;
  color: var(--text-dim, #8a93a6);
  font-size: 12px;
  padding: 24px 0;
}

.disclaimer {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-dim, #8a93a6);
  text-align: center;
  padding-top: 4px;
  border-top: 1px solid var(--border, #2a3344);
}

/* ===== 直接快讯模式 ===== */
.mode-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(8, 201, 138, 0.08);
  border: 1px solid rgba(8, 201, 138, 0.2);
  border-radius: 6px;
  font-size: 10.5px;
  color: #3ddcaa;
  flex-shrink: 0;
}
.mode-hint svg { width: 12px; height: 12px; flex-shrink: 0; }
.mode-hint span { flex: 1; }
.hint-close {
  display: flex; align-items: center; gap: 3px;
  padding: 2px 8px;
  font-size: 9.5px;
  background: transparent;
  border: 1px solid rgba(176, 124, 255, 0.3);
  color: #b07cff;
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}
.hint-close svg { width: 10px; height: 10px; }
.hint-close:hover { background: rgba(176, 124, 255, 0.15); }

.flash-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.flash-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 2px;
  border-bottom: 1px solid rgba(32, 39, 47, 0.6);
  cursor: pointer;
}
.flash-item:hover .f-text { color: #e9eef6; }
.f-time {
  font-size: 9.5px;
  color: #7d8792;
  font-variant-numeric: tabular-nums;
  flex: none;
}
.f-tag {
  font-size: 8.5px;
  color: #b07cff;
  background: rgba(176, 124, 255, 0.12);
  border-radius: 3px;
  padding: 0 4px;
  flex: none;
  white-space: nowrap;
}
.f-text {
  font-size: 11px;
  color: #b8c2cf;
  line-height: 1.45;
  flex: 1;
  transition: color 0.15s;
}
.f-load {
  text-align: center;
  font-size: 10px;
  color: #5d6878;
  padding: 8px 0;
}
</style>
