<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { db } from "../db/database";
import { renderMarkdown } from "../ai/markdown";
import {
  getReview,
  listReviews,
  runReview,
  type ReviewDetailInfo,
  type ReviewSummaryInfo,
} from "../ai/api";

interface FactRefInfo {
  kind: string;
  card?: string;
  code?: string;
  date?: string;
  url?: string;
  title?: string;
}

const dates = ref<string[]>([]);
const date = ref<string>("");
const list = ref<ReviewSummaryInfo[]>([]);
const selectedId = ref<number | null>(null);
const detail = ref<ReviewDetailInfo | null>(null);
const activeScope = ref<"all" | "market" | "theme" | "stock">("all");
const running = ref(false);
const errMsg = ref("");

const scopeMeta: Record<string, { label: string; color: string }> = {
  market: { label: "市场", color: "#d4af37" },
  theme: { label: "题材", color: "#5aa0ff" },
  stock: { label: "个股", color: "#ff5a6a" },
  trade: { label: "交易", color: "#00ffd5" },
};

const filtered = computed(() =>
  activeScope.value === "all"
    ? list.value
    : list.value.filter((r) => r.scope === activeScope.value)
);

const refs = computed<FactRefInfo[]>(() => {
  if (!detail.value) return [];
  try {
    return JSON.parse(detail.value.evidence) as FactRefInfo[];
  } catch {
    return [];
  }
});

const rendered = computed(() =>
  detail.value ? renderMarkdown(detail.value.content) : ""
);

function refText(r: FactRefInfo) {
  if (r.kind === "url") return r.title || r.url || "链接";
  let t = r.card || "数据";
  if (r.code) t += ` · ${r.code}`;
  if (r.date) t += ` · ${r.date}`;
  return t;
}

async function loadDates() {
  const rows = await db().select<{ trade_date: string }[]>(
    "SELECT DISTINCT trade_date FROM ai_review ORDER BY trade_date DESC"
  );
  dates.value = rows.map((r) => r.trade_date);
  if (!date.value && dates.value[0]) date.value = dates.value[0];
}

async function loadList() {
  if (!date.value) {
    list.value = [];
    return;
  }
  list.value = await listReviews(date.value);
  const keep = list.value.find((r) => r.id === selectedId.value);
  if (!keep) {
    selectedId.value = list.value[0]?.id ?? null;
  }
  await loadDetail();
}

async function loadDetail() {
  if (selectedId.value == null) {
    detail.value = null;
    return;
  }
  detail.value = await getReview(selectedId.value);
}

async function selectRow(id: number) {
  selectedId.value = id;
  await loadDetail();
}

async function rerun(force: boolean) {
  running.value = true;
  errMsg.value = "";
  try {
    await runReview(date.value || null, force);
    await loadDates();
    if (date.value === "" && dates.value[0]) date.value = dates.value[0];
    await loadList();
  } catch (e) {
    errMsg.value = String(e);
  } finally {
    running.value = false;
  }
}

onMounted(() => {
  void (async () => {
    await loadDates();
    await loadList();
  })().catch(() => {});
});
</script>

<template>
  <div class="rv">
    <div class="rv-head">
      <div class="rv-title">AI 复盘</div>
      <div class="rv-controls">
        <select v-model="date" class="rv-select" @change="loadList">
          <option v-for="d in dates" :key="d" :value="d">{{ d }}</option>
        </select>
        <button class="rv-btn" :disabled="running" @click="rerun(true)">
          {{ running ? "生成中…" : "重跑当日" }}
        </button>
      </div>
    </div>

    <div class="rv-tabs">
      <button
        class="rv-tab"
        :class="{ on: activeScope === 'all' }"
        @click="activeScope = 'all'"
      >
        全部
      </button>
      <button
        v-for="(m, k) in scopeMeta"
        :key="k"
        class="rv-tab"
        :class="{ on: activeScope === k }"
        @click="activeScope = k as 'market' | 'theme' | 'stock'"
      >
        {{ m.label }}
      </button>
    </div>

    <div class="rv-body" v-if="dates.length > 0">
      <div class="rv-list">
        <div
          v-for="r in filtered"
          :key="r.id"
          class="rv-row"
          :class="{ on: r.id === selectedId }"
          @click="selectRow(r.id)"
        >
          <span class="rv-dot" :style="{ color: scopeMeta[r.scope]?.color }">●</span>
          <span class="rv-r-title">{{ r.title || r.summary || "未命名复盘" }}</span>
          <span
            class="rv-r-scope"
            :style="{ color: scopeMeta[r.scope]?.color }"
          >
            {{ scopeMeta[r.scope]?.label }}
          </span>
        </div>
        <div v-if="filtered.length === 0" class="rv-empty">该分层暂无复盘</div>
      </div>

      <div class="rv-detail" v-if="detail">
        <div class="rv-d-title">{{ detail.title || "复盘" }}</div>
        <div class="rv-d-meta">
          {{ detail.tradeDate }} · {{ scopeMeta[detail.scope]?.label }}
          <template v-if="detail.subject"> · {{ detail.subject }}</template>
          · {{ detail.model }}
        </div>
        <div v-if="detail.summary" class="rv-summary">{{ detail.summary }}</div>
        <div class="rv-md" v-html="rendered"></div>
        <div v-if="refs.length > 0" class="rv-refs">
          <div class="rv-refs-title">本地证据</div>
          <a
            v-for="(r, i) in refs"
            :key="i"
            class="rv-chip"
            :href="r.kind === 'url' ? r.url : undefined"
            :title="refText(r)"
          >
            {{ refText(r) }}
          </a>
        </div>
      </div>
    </div>

    <div v-else class="rv-no-date">
      <div class="rv-empty">尚无复盘。收盘归因完成后会自动生成；也可立即手动生成。</div>
      <button class="rv-btn rv-primary" :disabled="running" @click="rerun(false)">
        {{ running ? "生成中…（约 1-3 分钟）" : "生成最近交易日复盘" }}
      </button>
    </div>

    <div v-if="errMsg" class="rv-err">{{ errMsg }}</div>
    <div class="rv-foot">AI 生成内容仅供参考，不构成投资建议</div>
  </div>
</template>

<style scoped>
.rv { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.rv-head { display: flex; align-items: center; justify-content: space-between; }
.rv-title { font-weight: 700; color: var(--text, #e6ecf5); }
.rv-controls { display: flex; gap: 6px; }
.rv-select {
  padding: 3px 6px; font-size: 11px; border-radius: 7px;
  border: 1px solid var(--border, #2a3344); background: var(--bg-card, #15181f);
  color: var(--text, #dfe5f0);
}
.rv-btn {
  padding: 3px 12px; border: 1px solid var(--border, #2a3344); border-radius: 7px;
  background: var(--bg-card, #15181f); color: var(--accent, #d4af37);
  font-size: 11px; cursor: pointer;
}
.rv-btn:disabled { opacity: .6; cursor: default; }
.rv-primary { color: var(--accent, #d4af37); border-color: var(--accent, #d4af37); }
.rv-tabs { display: flex; gap: 4px; }
.rv-tab {
  padding: 2px 12px; font-size: 10px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--border, #2a3344); background: transparent;
  color: var(--text-dim, #939cb0);
}
.rv-tab.on { background: var(--bg-hover, rgba(255, 255, 255, 0.06)); color: var(--text, #e6ecf5); }
.rv-body { flex: 1; min-height: 0; display: flex; gap: 8px; }
.rv-list { width: 40%; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.rv-row {
  display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  border: 1px solid transparent; border-radius: 8px; cursor: pointer;
}
.rv-row:hover { background: var(--bg-hover, rgba(255, 255, 255, 0.04)); }
.rv-row.on { background: var(--bg-hover, rgba(255, 255, 255, 0.06)); border-color: var(--border, #2a3344); }
.rv-dot { font-size: 8px; }
.rv-r-title { flex: 1; color: var(--text, #dfe5f0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rv-r-scope { font-size: 10px; }
.rv-detail { flex: 1; min-width: 0; overflow-y: auto; }
.rv-d-title { font-size: 14px; font-weight: 700; color: var(--text, #e6ecf5); }
.rv-d-meta { color: var(--text-dim, #8a93a6); font-size: 10px; margin: 3px 0 6px; }
.rv-summary {
  padding: 6px 10px; border-left: 2px solid var(--accent, #d4af37);
  background: rgba(212, 175, 55, 0.08); border-radius: 0 8px 8px 0;
  color: var(--text, #e6ecf5); margin-bottom: 8px; line-height: 1.5;
}
.rv-md { color: var(--text, #d7deeb); line-height: 1.6; }
.rv-md :deep(h1), .rv-md :deep(h2), .rv-md :deep(h3) { font-size: 12px; margin: 10px 0 4px; color: var(--text, #e6ecf5); }
.rv-md :deep(ul), .rv-md :deep(ol) { padding-left: 18px; margin: 4px 0; }
.rv-md :deep(li) { margin: 2px 0; }
.rv-md :deep(code) {
  font-family: ui-monospace, Consolas, monospace; font-size: 11px;
  background: rgba(255, 255, 255, 0.06); padding: 1px 4px; border-radius: 4px;
}
.rv-refs { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.rv-refs-title { font-size: 10px; color: var(--text-dim, #8a93a6); width: 100%; }
.rv-chip {
  font-size: 10px; padding: 2px 8px; border-radius: 10px; text-decoration: none;
  background: rgba(255, 255, 255, 0.05); color: var(--text-dim, #b6bdcc);
}
.rv-chip:hover { color: var(--accent, #d4af37); }
.rv-no-date { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
.rv-empty { color: var(--text-dim, #8a93a6); font-size: 11px; text-align: center; }
.rv-err { color: #ff6b78; font-size: 11px; }
.rv-foot { color: var(--text-dim, #7a8496); font-size: 10px; }
</style>
