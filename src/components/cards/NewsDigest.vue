<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { aiNewsDigest, type NewsDigest as Digest, type NewsDigestItem } from "../../ai/commentary";
import { logger } from "../../utils/logger";

const loading = ref(false);
const error = ref("");
const data = ref<Digest | null>(null);
const activeTab = ref<"all" | "macro" | "industry" | "stock">("all");
const lastUpdate = ref("");

const tabs = [
  { key: "all", label: "全部" },
  { key: "macro", label: "宏观" },
  { key: "industry", label: "行业" },
  { key: "stock", label: "个股" },
] as const;

const filtered = computed<NewsDigestItem[]>(() => {
  if (!data.value) return [];
  if (activeTab.value === "all") return data.value.items;
  return data.value.items.filter((i) => i.category === activeTab.value);
});

function categoryColor(cat: string): string {
  switch (cat) {
    case "macro": return "#4ea1ff";
    case "industry": return "#35c4a8";
    case "stock": return "#e8c66a";
    default: return "#8a93a6";
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

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await aiNewsDigest();
    lastUpdate.value = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = msg;
    logger.error("资讯聚合失败", msg);
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <div class="news-digest-card">
    <div class="card-header">
      <span class="header-title">资讯聚合</span>
      <div class="header-actions">
        <span v-if="lastUpdate" class="update-time">{{ lastUpdate }}</span>
        <button class="refresh-btn" :disabled="loading" @click="refresh">
          {{ loading ? "聚合中…" : "刷新" }}
        </button>
      </div>
    </div>

    <div v-if="data" class="stats-bar">
      <span class="stat" :style="{ color: '#4ea1ff' }">宏观 {{ data.macro_count }}</span>
      <span class="stat" :style="{ color: '#35c4a8' }">行业 {{ data.industry_count }}</span>
      <span class="stat" :style="{ color: '#e8c66a' }">个股 {{ data.stock_count }}</span>
    </div>

    <div v-if="data" class="tabs">
      <button
        v-for="t in tabs" :key="t.key"
        class="tab" :class="{ active: activeTab === t.key }"
        @click="activeTab = t.key"
      >{{ t.label }}</button>
    </div>

    <div v-if="loading && !data" class="loading-state">
      <div class="spinner"></div>
      <span>AI 正在去重、分类、摘要快讯…</span>
    </div>

    <div v-else-if="error" class="error-state">
      <div class="error-icon">!</div>
      <div class="error-text">{{ error }}</div>
      <button class="retry-btn" @click="refresh">重试</button>
    </div>

    <div v-else class="news-list">
      <div v-for="(item, idx) in filtered" :key="idx" class="news-item">
        <div class="news-top">
          <span class="news-cat" :style="{ background: categoryColor(item.category) + '22', color: categoryColor(item.category) }">
            {{ categoryLabel(item.category) }}
          </span>
          <span class="news-title">{{ item.title }}</span>
        </div>
        <div class="news-summary">{{ item.summary }}</div>
        <div class="news-meta">
          <span v-if="item.time" class="news-time">{{ item.time }}</span>
          <span v-if="item.related_codes.length" class="related-codes">
            关联：{{ item.related_codes.join("、") }}
          </span>
          <a v-if="item.url" :href="item.url" target="_blank" class="news-link">原文</a>
        </div>
      </div>
      <div v-if="filtered.length === 0" class="empty-state">该分类暂无资讯</div>
    </div>

    <div class="disclaimer">AI 生成，仅供参考，不构成投资建议</div>
  </div>
</template>

<style scoped>
.news-digest-card {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  padding: 12px 14px; gap: 8px; overflow: hidden;
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

.stats-bar {
  display: flex; gap: 12px; flex-shrink: 0; padding: 4px 0;
  font-size: 11px; font-weight: 600;
}
.tabs { display: flex; gap: 4px; flex-shrink: 0; }
.tab {
  padding: 3px 10px; font-size: 11px; border-radius: 6px;
  border: 1px solid transparent; background: transparent;
  color: var(--text-dim, #8a93a6); cursor: pointer;
}
.tab.active {
  background: rgba(232, 198, 106, 0.12); color: var(--accent, #e8c66a);
  border-color: rgba(232, 198, 106, 0.3);
}
.tab:hover:not(.active) { color: var(--text, #e6ecf5); }

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

.news-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.news-item {
  padding: 8px 10px; border-radius: 8px;
  background: var(--bg-card, #15181f); border: 1px solid var(--border, #2a3344);
}
.news-top { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.news-cat {
  flex-shrink: 0; padding: 1px 6px; border-radius: 4px; font-size: 9px; font-weight: 700;
}
.news-title { font-size: 12px; font-weight: 700; color: var(--text, #e6ecf5); line-height: 1.4; }
.news-summary { font-size: 11.5px; color: var(--text-dim, #b0b8c8); line-height: 1.5; margin-bottom: 4px; }
.news-meta { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--text-dim, #8a93a6); }
.related-codes { color: var(--accent, #e8c66a); }
.news-link { color: #4ea1ff; text-decoration: none; }
.news-link:hover { text-decoration: underline; }
.empty-state {
  flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim, #8a93a6); font-size: 12px;
}
.disclaimer {
  flex-shrink: 0; font-size: 10px; color: var(--text-dim, #8a93a6);
  text-align: center; padding-top: 4px; border-top: 1px solid var(--border, #2a3344);
}
</style>
