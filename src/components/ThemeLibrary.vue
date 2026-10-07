<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { db } from "../db/database";
import type { Db } from "../kb/repo";
import {
  listCatalysts,
  listThemes,
  listThemeStocks,
  listThemeStockStats,
  listAllThemeSummaries,
  type ThemeStockStat,
  type ThemeSummary,
} from "../kb/repo";
import { collectorStatus, runCollectionNow } from "../composables/useCollector";
import type { CatalystRow, ThemeRow, ThemeStockRow } from "../kb/types";

const emit = defineEmits<{ (e: "select", code: string): void }>();

const themes = ref<ThemeRow[]>([]);
const currentId = ref<number | null>(null);
const stocks = ref<ThemeStockRow[]>([]);
const stockStats = ref<Map<string, ThemeStockStat>>(new Map());
const summaries = ref<Map<number, ThemeSummary>>(new Map());
const catalysts = ref<CatalystRow[]>([]);
const loading = ref(false);
const keyword = ref("");
const stageFilter = ref<string>("全部");

const STAGE_TABS = ["全部", "萌芽", "发酵", "高潮", "退潮"];
const STAGE_ORDER = ["萌芽", "发酵", "高潮", "退潮"] as const;
const STAGE_IDX: Record<string, number> = { 萌芽: 0, 发酵: 1, 高潮: 2, 退潮: 3 };

const stageColor: Record<string, string> = {
  萌芽: "#8ab4ff", 发酵: "#d4af37", 高潮: "#ff5a6a", 退潮: "#7a8699",
};

const stageAdvice: Record<string, { title: string; text: string }> = {
  萌芽: { title: "观察确认", text: "题材刚出现，涨停家数少，等待明日确认持续性。可小仓位试错龙头。" },
  发酵: { title: "顺势参与", text: "板块持续走强，龙头连板打开空间。聚焦龙一龙二，回避后排跟风。" },
  高潮: { title: "警惕分化", text: "涨停家数多、连板高，短期情绪过热。逢高减仓，不追后排。" },
  退潮: { title: "回避为主", text: "板块退潮，资金流出。持仓者逢反弹减仓，空仓者观望。" },
};

const dirColor: Record<string, string> = { 利好: "#ff5a6a", 利空: "#2fd6a0", 中性: "#8a94a6" };
const kindLabel: Record<string, string> = {
  policy: "政策", industry: "行业", company: "公司", order: "订单",
  earnings: "业绩", price: "价格", event: "事件",
};

const current = computed(() => themes.value.find((t) => t.id === currentId.value) ?? null);

const filteredThemes = computed(() => {
  let list = themes.value;
  if (stageFilter.value !== "全部") list = list.filter((t) => t.stage === stageFilter.value);
  const kw = keyword.value.trim().toLowerCase();
  if (kw) list = list.filter((t) => t.name.toLowerCase().includes(kw) || t.aliases.toLowerCase().includes(kw));
  return list;
});

const currentSummary = computed(() => (currentId.value ? summaries.value.get(currentId.value) ?? null : null));
const currentAdvice = computed(() => (current.value ? stageAdvice[current.value.stage] ?? null : null));

function fmtMoney(n: number): string {
  if (!n) return "—";
  const yi = n / 1e8;
  if (yi >= 1) return yi.toFixed(2) + "亿";
  const wan = n / 1e4;
  if (wan >= 1) return wan.toFixed(0) + "万";
  return n.toFixed(0);
}
function fmtDate(d: string | null): string { return d && d.length >= 10 ? d.slice(5) : (d ?? "—"); }
function activeDays(t: ThemeRow): number {
  if (!t.firstSeenDate || !t.lastActiveDate) return 1;
  return Math.max(1, Math.round((new Date(t.lastActiveDate).getTime() - new Date(t.firstSeenDate).getTime()) / 86_400_000) + 1);
}
function fmtCatalystTime(ts: number | null): string {
  if (!ts || ts <= 0) return "";
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function reload() {
  const d: Db = db();
  themes.value = await listThemes(d);
  summaries.value = await listAllThemeSummaries(d);
  if (currentId.value === null && themes.value[0]) await selectTheme(themes.value[0].id);
  else if (currentId.value !== null) await selectTheme(currentId.value);
}

async function selectTheme(id: number) {
  currentId.value = id;
  const d: Db = db();
  stocks.value = await listThemeStocks(d, id);
  const stats = await listThemeStockStats(d, id);
  stockStats.value = new Map(stats.map((s) => [s.code, s]));
  catalysts.value = await listCatalysts(d, { themeId: id, limit: 30 });
}

function pickStock(code: string) { if (code) emit("select", code); }

async function collectNow() {
  loading.value = true;
  try { await runCollectionNow("attribution"); await reload(); }
  finally { loading.value = false; }
}

onMounted(() => { void reload().catch(() => {}); });
</script>

<template>
  <div class="tl">
    <div class="tl-head">
      <div class="tl-title">题材库</div>
      <div class="tl-head-right">
        <input v-model="keyword" class="tl-search" placeholder="搜题材…" @keydown.esc="keyword = ''" />
        <button class="tl-btn" :disabled="loading" @click="collectNow">{{ loading ? "采集中…" : "立即归因" }}</button>
      </div>
    </div>

    <div class="tl-tabs">
      <button v-for="tab in STAGE_TABS" :key="tab" class="tl-tab" :class="{ on: stageFilter === tab }" @click="stageFilter = tab">{{ tab }}</button>
      <span class="tl-tab-count">{{ filteredThemes.length }} / {{ themes.length }}</span>
    </div>

    <div class="tl-sub" v-if="collectorStatus.lastAttribution">
      最近归因 {{ collectorStatus.lastAttribution }} · {{ collectorStatus.attributionThemes }} 个活跃题材
    </div>

    <div class="tl-body">
      <div class="tl-list">
        <div v-for="t in filteredThemes" :key="t.id" class="tl-row" :class="{ on: t.id === currentId }" @click="selectTheme(t.id)">
          <span class="tl-stage" :style="{ color: stageColor[t.stage] }">●</span>
          <div class="tl-row-main">
            <div class="tl-row-top">
              <span class="tl-name">{{ t.name }}</span>
              <span class="tl-badge" :style="{ color: stageColor[t.stage] }">{{ t.stage }}</span>
            </div>
            <div class="tl-row-meta" v-if="summaries.get(t.id)">
              <span>涨停 {{ summaries.get(t.id)!.sealCount }}</span>
              <span>最高 {{ summaries.get(t.id)!.maxBoards }}板</span>
              <span v-if="summaries.get(t.id)!.totalSealFund">封单 {{ fmtMoney(summaries.get(t.id)!.totalSealFund) }}</span>
            </div>
          </div>
        </div>
        <div v-if="filteredThemes.length === 0" class="tl-empty">
          {{ themes.length === 0 ? "尚无题材。收盘后自动归因，或点击「立即归因」。" : "无匹配题材" }}
        </div>
      </div>

      <div class="tl-detail" v-if="current">
        <div class="tl-d-head">
          <span class="tl-d-name">{{ current.name }}</span>
          <span class="tl-d-level" :style="{ color: stageColor[current.stage] }">{{ current.level }} / {{ current.stage }}</span>
        </div>

        <div class="tl-stats" v-if="currentSummary && currentSummary.sealCount > 0">
          <div class="tl-stat"><span class="tl-stat-num">{{ currentSummary.sealCount }}</span><span class="tl-stat-label">涨停家数</span></div>
          <div class="tl-stat"><span class="tl-stat-num up">{{ currentSummary.maxBoards }}</span><span class="tl-stat-label">最高连板</span></div>
          <div class="tl-stat"><span class="tl-stat-num">{{ fmtMoney(currentSummary.totalSealFund) }}</span><span class="tl-stat-label">总封单</span></div>
          <div class="tl-stat"><span class="tl-stat-num" :class="{ down: currentSummary.brokenCount > 0 }">{{ currentSummary.brokenCount }}</span><span class="tl-stat-label">炸板数</span></div>
        </div>

        <div class="tl-stage-bar">
          <div v-for="(s, i) in STAGE_ORDER" :key="s" class="tl-stage-seg"
            :style="{ background: i <= (STAGE_IDX[current.stage] ?? 0) ? stageColor[s] : 'var(--border)' }"></div>
        </div>

        <div class="tl-advice" v-if="currentAdvice">
          <span class="tl-advice-tag">{{ currentAdvice.title }}</span>
          <span class="tl-advice-text">{{ currentAdvice.text }}</span>
        </div>

        <div class="tl-meta">
          <span>首现 {{ fmtDate(current.firstSeenDate) }}</span>
          <span>活跃 {{ activeDays(current) }}天</span>
        </div>

        <div v-if="current.logic" class="tl-logic">{{ current.logic }}</div>

        <div class="tl-sec">成分角色（{{ stocks.length }}）<span class="tl-sec-tip">点击股票查看 K 线</span></div>
        <div class="tl-stock-table">
          <div class="tl-stock-head"><span>股票</span><span class="tl-col-boards">连板</span><span class="tl-col-seal">封单</span><span class="tl-col-role">角色</span></div>
          <div v-for="s in stocks" :key="s.id" class="tl-stock-row" :data-role="s.role"
            @click="pickStock(s.code)" :title="`${s.name}（${s.code}）— 点击查看 K 线`">
            <span class="tl-stock-name"><b>{{ s.name }}</b><i>{{ s.code }}</i></span>
            <span class="tl-col-boards" v-if="stockStats.get(s.code)"><em :class="{ 'boards-high': stockStats.get(s.code)!.boards >= 3 }">{{ stockStats.get(s.code)!.boards }}板</em></span>
            <span class="tl-col-boards dim" v-else>—</span>
            <span class="tl-col-seal" v-if="stockStats.get(s.code)">{{ fmtMoney(stockStats.get(s.code)!.sealFund) }}</span>
            <span class="tl-col-seal dim" v-else>—</span>
            <span class="tl-col-role" :data-role="s.role">{{ s.role }}</span>
          </div>
          <div v-if="stocks.length === 0" class="tl-empty-sm">暂无成分股</div>
        </div>

        <div class="tl-sec">催化剂 / 事件</div>
        <div class="tl-cats">
          <div v-for="c in catalysts" :key="c.id" class="tl-cat">
            <div class="tl-cat-main">
              <span class="tl-cat-dir" :style="{ color: dirColor[c.direction] }">{{ c.direction }}</span>
              <span class="tl-cat-kind">{{ kindLabel[c.kind] || c.kind }}</span>
              <span class="tl-cat-title" :title="c.title">{{ c.title }}</span>
            </div>
            <div class="tl-cat-sub">
              <span class="tl-cat-meta">{{ c.source }}<template v-if="fmtCatalystTime(c.publishedAt)"> · {{ fmtCatalystTime(c.publishedAt) }}</template></span>
              <div class="tl-fresh"><div class="tl-fresh-track"><div class="tl-fresh-fill" :style="{ width: Math.max(0, Math.min(100, c.freshScore * 100)) + '%' }"></div></div><span class="tl-fresh-num">{{ c.freshScore.toFixed(2) }}</span></div>
            </div>
          </div>
          <div v-if="catalysts.length === 0" class="tl-empty">暂无关联催化</div>
        </div>
      </div>
    </div>

    <div class="tl-foot">数据来自公开接口，仅供参考，不构成投资建议</div>
  </div>
</template>

<style scoped>
.tl { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
.tl-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tl-title { font-weight: 700; color: var(--text, #e6ecf5); }
.tl-head-right { display: flex; align-items: center; gap: 6px; }
.tl-search { width: 90px; padding: 3px 8px; font-size: 11px; border: 1px solid var(--border, #2a3344); border-radius: 6px; background: var(--bg-card, #15181f); color: var(--text); outline: none; }
.tl-search::placeholder { color: var(--text-dim); }
.tl-search:focus { border-color: var(--accent, #d4af37); }
.tl-btn { padding: 3px 12px; border: 1px solid var(--border, #2a3344); border-radius: 7px; background: var(--bg-card, #15181f); color: var(--accent, #d4af37); font-size: 11px; cursor: pointer; }
.tl-btn:hover { border-color: var(--accent, #d4af37); }
.tl-btn:disabled { opacity: .6; cursor: default; }

.tl-tabs { display: flex; align-items: center; gap: 4px; }
.tl-tab { padding: 2px 10px; font-size: 10.5px; border-radius: 12px; cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--text-dim); }
.tl-tab.on { border-color: var(--accent, #d4af37); color: var(--accent, #d4af37); background: rgba(212, 175, 55, .1); }
.tl-tab-count { margin-left: auto; font-size: 10px; color: var(--text-dim); }

.tl-sub { color: var(--text-dim); font-size: 11px; }
.tl-body { flex: 1; min-height: 0; display: flex; gap: 8px; }
.tl-list { width: 38%; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.tl-row { display: flex; align-items: flex-start; gap: 6px; padding: 6px 8px; border-radius: 7px; cursor: pointer; }
.tl-row:hover { background: rgba(212, 175, 55, .08); }
.tl-row.on { background: rgba(212, 175, 55, .16); }
.tl-stage { font-size: 9px; flex: none; margin-top: 3px; }
.tl-row-main { flex: 1; min-width: 0; }
.tl-row-top { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.tl-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.tl-badge { font-size: 9.5px; flex: none; }
.tl-row-meta { display: flex; gap: 8px; margin-top: 2px; font-size: 9.5px; color: var(--text-dim); }

.tl-detail { flex: 1; min-width: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.tl-d-head { display: flex; align-items: baseline; gap: 8px; }
.tl-d-name { font-weight: 700; color: var(--text); font-size: 14px; }
.tl-d-level { font-size: 11px; font-weight: 600; }

.tl-stats { display: flex; gap: 0; padding: 8px 4px; border: 1px solid var(--border, #2a3344); border-radius: 8px; background: rgba(212, 175, 55, .04); }
.tl-stat { flex: 1; text-align: center; display: flex; flex-direction: column; gap: 1px; }
.tl-stat + .tl-stat { border-left: 1px solid var(--border, #2a3344); }
.tl-stat-num { font-size: 15px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.tl-stat-num.up { color: #ff5a6a; }
.tl-stat-num.down { color: #2fd6a0; }
.tl-stat-label { font-size: 9.5px; color: var(--text-dim); }

.tl-stage-bar { display: flex; gap: 3px; padding: 1px 0; }
.tl-stage-seg { flex: 1; height: 3px; border-radius: 2px; opacity: .25; }

.tl-advice { display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px; border-radius: 6px; background: rgba(138, 180, 255, .06); border-left: 2px solid #8ab4ff; }
.tl-advice-tag { flex: none; font-size: 10px; font-weight: 700; color: #8ab4ff; padding: 1px 6px; border-radius: 4px; background: rgba(138, 180, 255, .12); }
.tl-advice-text { font-size: 10.5px; color: var(--text-dim); line-height: 1.4; }

.tl-meta { display: flex; gap: 12px; font-size: 10px; color: var(--text-dim); }
.tl-logic { color: var(--text-dim); line-height: 1.5; font-size: 11px; padding: 6px 8px; background: rgba(212, 175, 55, .05); border-left: 2px solid var(--accent, #d4af37); border-radius: 0 6px 6px 0; }

.tl-sec { color: var(--accent, #d4af37); font-size: 11px; margin-top: 4px; display: flex; align-items: center; gap: 8px; }
.tl-sec-tip { color: var(--text-dim); font-size: 9.5px; font-weight: 400; }

.tl-stock-table { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.tl-stock-head, .tl-stock-row { display: grid; grid-template-columns: 1fr 48px 60px 40px; align-items: center; gap: 4px; padding: 5px 8px; }
.tl-stock-head { font-size: 9.5px; color: var(--text-dim); background: var(--bg-card, #15181f); border-bottom: 1px solid var(--border); }
.tl-stock-row { cursor: pointer; transition: background .12s; }
.tl-stock-row + .tl-stock-row { border-top: 1px solid var(--border); }
.tl-stock-row:hover { background: rgba(212, 175, 55, .08); }
.tl-stock-row[data-role="龙一"] { background: rgba(255, 90, 106, .06); }
.tl-stock-row[data-role="龙一"]:hover { background: rgba(255, 90, 106, .14); }
.tl-stock-name { display: flex; flex-direction: column; line-height: 1.2; min-width: 0; }
.tl-stock-name b { font-size: 12px; color: var(--text); }
.tl-stock-name i { font-style: normal; font-size: 9px; color: var(--text-dim); }
.tl-col-boards { text-align: center; font-size: 11px; }
.tl-col-boards em { font-style: normal; font-weight: 600; }
.tl-col-boards em.boards-high { color: #ff5a6a; }
.tl-col-boards.dim, .tl-col-seal.dim { color: var(--text-dim); opacity: .5; }
.tl-col-seal { text-align: right; font-size: 10.5px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.tl-col-role { text-align: center; font-size: 9.5px; padding: 1px 4px; border-radius: 4px; }
.tl-col-role[data-role="龙一"] { color: #ff5a6a; background: rgba(255, 90, 106, .12); }
.tl-col-role[data-role="龙二"] { color: #d4af37; background: rgba(212, 175, 55, .12); }
.tl-col-role[data-role="助攻"] { color: #8ab4ff; background: rgba(138, 180, 255, .1); }
.tl-col-role[data-role="跟风"] { color: var(--text-dim); }

.tl-cats { display: flex; flex-direction: column; gap: 5px; }
.tl-cat { padding: 5px 8px; border-radius: 6px; background: var(--bg-card, #15181f); border: 1px solid var(--border); }
.tl-cat:hover { border-color: rgba(212, 175, 55, .3); }
.tl-cat-main { display: flex; align-items: center; gap: 6px; }
.tl-cat-dir { font-size: 10px; font-weight: 700; }
.tl-cat-kind { font-size: 9.5px; padding: 1px 5px; border-radius: 4px; background: rgba(138, 180, 255, .12); color: #8ab4ff; }
.tl-cat-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }
.tl-cat-sub { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 3px; }
.tl-cat-meta { color: var(--text-dim); font-size: 10px; }
.tl-fresh { display: flex; align-items: center; gap: 4px; }
.tl-fresh-track { width: 40px; height: 3px; border-radius: 2px; background: var(--border); overflow: hidden; }
.tl-fresh-fill { height: 100%; border-radius: 2px; background: linear-gradient(90deg, #2fd6a0, #d4af37, #ff5a6a); }
.tl-fresh-num { font-size: 9px; color: var(--text-dim); }

.tl-empty { color: var(--text-dim); padding: 8px 0; text-align: center; }
.tl-empty-sm { color: var(--text-dim); font-size: 11px; padding: 8px; text-align: center; }
.tl-foot { color: var(--text-dim); font-size: 10px; text-align: right; }
</style>
