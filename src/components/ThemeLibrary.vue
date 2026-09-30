<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { db } from "../db/database";
import type { Db } from "../kb/repo";
import { listCatalysts, listThemes, listThemeStocks } from "../kb/repo";
import { collectorStatus, runCollectionNow } from "../composables/useCollector";
import type { CatalystRow, ThemeRow, ThemeStockRow } from "../kb/types";

const themes = ref<ThemeRow[]>([]);
const currentId = ref<number | null>(null);
const stocks = ref<ThemeStockRow[]>([]);
const catalysts = ref<CatalystRow[]>([]);
const loading = ref(false);

const current = computed(() => themes.value.find((t) => t.id === currentId.value) ?? null);

const stageColor: Record<string, string> = {
  萌芽: "#8ab4ff",
  发酵: "#d4af37",
  高潮: "#ff5a6a",
  退潮: "#7a8699",
};

async function reload() {
  const d: Db = db();
  themes.value = await listThemes(d);
  if (currentId.value === null && themes.value[0]) {
    await selectTheme(themes.value[0].id);
  } else if (currentId.value !== null) {
    await selectTheme(currentId.value);
  }
}

async function selectTheme(id: number) {
  currentId.value = id;
  const d: Db = db();
  stocks.value = await listThemeStocks(d, id);
  catalysts.value = await listCatalysts(d, { themeId: id, limit: 30 });
}

async function collectNow() {
  loading.value = true;
  try {
    await runCollectionNow("attribution");
    await reload();
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  // 挂载兜底：reload 任一步拒绝都不能变成未处理的 promise 拒绝
  void reload().catch(() => {});
});
</script>

<template>
  <div class="tl">
    <div class="tl-head">
      <div class="tl-title">题材库</div>
      <button class="tl-btn" :disabled="loading" @click="collectNow">
        {{ loading ? "采集中…" : "立即归因" }}
      </button>
    </div>
    <div class="tl-sub" v-if="collectorStatus.lastAttribution">
      最近归因 {{ collectorStatus.lastAttribution }} · {{ collectorStatus.attributionThemes }} 个活跃题材
    </div>

    <div class="tl-body">
      <div class="tl-list">
        <div
          v-for="t in themes"
          :key="t.id"
          class="tl-row"
          :class="{ on: t.id === currentId }"
          @click="selectTheme(t.id)"
        >
          <span class="tl-stage" :style="{ color: stageColor[t.stage] }">●</span>
          <span class="tl-name">{{ t.name }}</span>
          <span class="tl-badge" :style="{ color: stageColor[t.stage] }">{{ t.stage }}</span>
        </div>
        <div v-if="themes.length === 0" class="tl-empty">
          尚无题材。收盘后自动归因，或点击「立即归因」。
        </div>
      </div>

      <div class="tl-detail" v-if="current">
        <div class="tl-d-title">
          {{ current.name }}
          <span :style="{ color: stageColor[current.stage] }">· {{ current.level }} / {{ current.stage }}</span>
        </div>
        <div v-if="current.logic" class="tl-logic">{{ current.logic }}</div>

        <div class="tl-sec">成分角色（{{ stocks.length }}）</div>
        <div class="tl-stocks">
          <span v-for="s in stocks" :key="s.id" class="tl-chip" :data-role="s.role">
            {{ s.name }}<i>{{ s.role }}</i>
          </span>
        </div>

        <div class="tl-sec">催化剂 / 事件</div>
        <div class="tl-cats">
          <div v-for="c in catalysts" :key="c.id" class="tl-cat">
            <span class="tl-cat-title">{{ c.title }}</span>
            <span class="tl-cat-meta">{{ c.source }} · 新鲜度 {{ c.freshScore.toFixed(2) }}</span>
          </div>
          <div v-if="catalysts.length === 0" class="tl-empty">暂无关联催化</div>
        </div>
      </div>
    </div>

    <div class="tl-foot">数据来自公开接口，仅供参考，不构成投资建议</div>
  </div>
</template>

<style scoped>
.tl { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.tl-head { display: flex; align-items: center; justify-content: space-between; }
.tl-title { font-weight: 700; color: var(--text, #e6ecf5); }
.tl-btn {
  padding: 3px 12px; border: 1px solid var(--border, #2a3344); border-radius: 7px;
  background: var(--bg-card, #15181f); color: var(--accent, #d4af37);
  font-size: 11px; cursor: pointer;
}
.tl-btn:disabled { opacity: .6; cursor: default; }
.tl-sub { color: var(--text-dim); font-size: 11px; }
.tl-body { flex: 1; min-height: 0; display: flex; gap: 8px; }
.tl-list { width: 38%; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.tl-row {
  display: flex; align-items: center; gap: 6px; padding: 5px 8px;
  border-radius: 7px; cursor: pointer; color: var(--text, #d8dee9);
}
.tl-row:hover { background: rgba(212, 175, 55, .08); }
.tl-row.on { background: rgba(212, 175, 55, .16); }
.tl-stage { font-size: 9px; }
.tl-name { flex: 1; }
.tl-badge { font-size: 10px; }
.tl-detail { flex: 1; min-width: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.tl-d-title { font-weight: 700; color: var(--text); }
.tl-logic { color: var(--text-dim); line-height: 1.5; }
.tl-sec { color: var(--accent, #d4af37); font-size: 11px; margin-top: 2px; }
.tl-stocks { display: flex; flex-wrap: wrap; gap: 5px; }
.tl-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px;
  border: 1px solid var(--border, #2a3344); border-radius: 20px;
}
.tl-chip i { font-style: normal; font-size: 10px; color: var(--text-dim); }
.tl-chip[data-role="龙一"] { border-color: rgba(255, 90, 106, .6); }
.tl-chip[data-role="龙二"] { border-color: rgba(212, 175, 55, .6); }
.tl-cats { display: flex; flex-direction: column; gap: 4px; }
.tl-cat { display: flex; justify-content: space-between; gap: 8px; color: var(--text); }
.tl-cat-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl-cat-meta { color: var(--text-dim); font-size: 10px; white-space: nowrap; }
.tl-empty { color: var(--text-dim); padding: 8px 0; }
.tl-foot { color: var(--text-dim); font-size: 10px; text-align: right; }
</style>
