<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { fetchZtPool, fetchQuotes, type ZtStock } from "../api/market";

const emit = defineEmits<{ select: [code: string] }>();

// 当前选哪个板位接力：level=N 表示"昨日 N 板 → 博 N+1 板"
const level = ref(2);
const loading = ref(false);
const dateLabel = ref("");
const rows = ref<ScoredRow[]>([]);
const excludedRows = ref<ScoredRow[]>([]);
const error = ref("");

interface Factor { name: string; val: string; pts: number }
interface ScoredRow {
  s: ZtStock;
  score: number;
  factors: Factor[];
  note: string;
  excluded?: string;
}

const LEVELS = [1, 2, 3, 4, 5];

function ymdOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
function money(v: number): string {
  if (!v) return "—";
  if (v >= 1e8) return (v / 1e8).toFixed(1) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(0) + "万";
  return String(v);
}
function sealTime(v: number): string {
  if (!v) return "—";
  const s = String(v).padStart(6, "0");
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}

/** 单票打分；返回总分、各因子、排除原因 */
function scoreStock(z: ZtStock, industryMax: Map<string, number>): ScoredRow {
  const factors: Factor[] = [];
  let score = 0;
  const reasons: string[] = [];

  // —— 硬性排除 ——
  if (z.broken >= 3) reasons.push(`炸板${z.broken}次`);
  if (z.firstSeal && z.firstSeal >= 143000) reasons.push("尾盘偷袭板");
  if (z.turnover > 0 && z.turnover < 1.5) reasons.push("一字无量");

  // —— 1) 首封时间（25）—— 越早越强
  let p: number;
  if (!z.firstSeal) p = 5;
  else if (z.firstSeal <= 93500) p = 25;
  else if (z.firstSeal <= 100000) p = 20;
  else if (z.firstSeal <= 113000) p = 13;
  else if (z.firstSeal <= 140000) p = 7;
  else p = 3;
  factors.push({ name: "首封", val: sealTime(z.firstSeal), pts: p });
  score += p;

  // —— 2) 炸板次数（15）—— 0 次最强
  p = z.broken === 0 ? 15 : z.broken === 1 ? 8 : 2;
  factors.push({ name: "炸板", val: `${z.broken}次`, pts: p });
  score += p;

  // —— 3) 封单强度 = 封单额/成交额（20）
  const ratio = z.amount > 0 ? z.fund / z.amount : 0;
  p = ratio >= 0.1 ? 20 : ratio >= 0.05 ? 14 : ratio >= 0.02 ? 8 : 3;
  factors.push({ name: "封单/额", val: `${(ratio * 100).toFixed(1)}%`, pts: p });
  score += p;

  // —— 4) 换手健康度（15）—— 10~25% 最佳
  const t = z.turnover;
  if (t >= 10 && t <= 25) p = 15;
  else if ((t >= 5 && t < 10) || (t > 25 && t <= 35)) p = 9;
  else if (t < 2) p = 3;
  else p = 5;
  factors.push({ name: "换手", val: `${t.toFixed(1)}%`, pts: p });
  score += p;

  // —— 5) 题材地位（15）—— 同题材连板最高=龙一
  const maxB = industryMax.get(z.industry) ?? z.boards;
  p = z.boards >= maxB ? 15 : z.boards >= maxB - 1 ? 10 : 6;
  factors.push({ name: "题材", val: z.industry || "—", pts: p });
  score += p;

  // —— 6) 股价位置（10）—— 低价情绪票弹性大
  const pr = z.price;
  p = pr < 15 ? 10 : pr < 30 ? 7 : pr < 60 ? 4 : 2;
  factors.push({ name: "价位", val: `¥${pr.toFixed(1)}`, pts: p });
  score += p;

  // —— 一句话评语 ——
  const tags: string[] = [];
  if (z.firstSeal && z.firstSeal <= 100000) tags.push("早盘板");
  else if (z.firstSeal && z.firstSeal >= 140000) tags.push("午后板");
  if (z.broken === 0) tags.push("封板干净");
  if (z.turnover >= 10 && z.turnover <= 25) tags.push("换手充分");
  if (z.boards >= maxB) tags.push("题材领涨");
  const note = tags.join(" · ") || "普通";

  return { s: z, score, factors, note, excluded: reasons.join("；") || undefined };
}

async function run() {
  loading.value = true;
  error.value = "";
  try {
    // 往前找最近一个有涨停池的交易日 = "昨日"
    let prevYmd = "";
    const now = new Date();
    for (let i = 1; i <= 12; i++) {
      const d = new Date(now); d.setDate(now.getDate() - i);
      const ymd = ymdOf(d);
      try {
        const pool = await fetchZtPool(ymd);
        if (pool.list.length > 0) { prevYmd = ymd; break; }
      } catch { /* skip */ }
    }
    if (!prevYmd) { error.value = "近12日无涨停池数据"; loading.value = false; return; }
    const pool = await fetchZtPool(prevYmd);
    dateLabel.value = `${prevYmd.slice(4, 6)}-${prevYmd.slice(6, 8)}`;

    // 昨日 N 板池
    const poolN = pool.list.filter((s) => s.boards === level.value);
    // 同题材最高连板
    const indMax = new Map<string, number>();
    for (const s of pool.list) {
      const m = indMax.get(s.industry) ?? 0;
      if (s.boards > m) indMax.set(s.industry, s.boards);
    }

    const all = poolN.map((s) => scoreStock(s, indMax));
    const kept = all.filter((r) => !r.excluded).sort((a, b) => b.score - a.score);
    const ex = all.filter((r) => r.excluded).sort((a, b) => b.score - a.score);
    rows.value = kept;
    excludedRows.value = ex;
    await loadAuction();
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(run);
watch(level, run);

const totalPool = computed(() => rows.value.length + excludedRows.value.length);
function scoreColor(sc: number): string {
  if (sc >= 75) return "#ffd76a";
  if (sc >= 60) return "#e0455a";
  return "var(--text-dim)";
}

// ===== 历史回测：Top2 选股晋级率 vs 全体平均 =====
const btRunning = ref(false);
const bt = ref<null | { days: number; top2Hits: number; top2Total: number; allHits: number; allTotal: number }>(null);

async function runBacktest() {
  btRunning.value = true;
  bt.value = null;
  try {
    // 收集最近有涨停池的交易日（最多 25 个）
    const days: string[] = [];
    const now = new Date();
    for (let i = 1; i <= 60 && days.length < 25; i++) {
      const d = new Date(now); d.setDate(now.getDate() - i);
      try {
        const p = await fetchZtPool(ymdOf(d));
        if (p.list.length) days.push(ymdOf(d));
      } catch { /* skip */ }
    }
    let top2Hits = 0, top2Total = 0, allHits = 0, allTotal = 0;
    for (let i = 0; i + 1 < days.length; i++) {
      const [currPool, prevPool] = await Promise.all([
        fetchZtPool(days[i]), fetchZtPool(days[i + 1]),
      ]);
      const currMap = new Map<string, ZtStock>(currPool.list.map((s) => [s.code, s]));
      const prevN = prevPool.list.filter((s) => s.boards === level.value);
      if (!prevN.length) continue;
      const indMax = new Map<string, number>();
      for (const s of prevPool.list) {
        const m = indMax.get(s.industry) ?? 0;
        if (s.boards > m) indMax.set(s.industry, s.boards);
      }
      const scored = prevN
        .map((s) => scoreStock(s, indMax))
        .filter((r) => !r.excluded)
        .sort((a, b) => b.score - a.score);
      // 全体晋级率（含被排除票）
      for (const s of prevN) {
        allTotal++;
        const c = currMap.get(s.code);
        if (c && c.boards > s.boards) allHits++;
      }
      // Top2 晋级率
      for (const r of scored.slice(0, 2)) {
        top2Total++;
        const c = currMap.get(r.s.code);
        if (c && c.boards > r.s.boards) top2Hits++;
      }
    }
    bt.value = { days: days.length - 1, top2Hits, top2Total, allHits, allTotal };
  } finally {
    btRunning.value = false;
  }
}
const top2Rate = computed(() => bt.value && bt.value.top2Total > 0 ? bt.value.top2Hits / bt.value.top2Total : 0);
const allRate = computed(() => bt.value && bt.value.allTotal > 0 ? bt.value.allHits / bt.value.allTotal : 0);

// ===== 次日竞价二次确认：盘后候选 Top5 → 开盘后按缺口打标签 =====
const auctionTags = ref<Map<string, { gap: number; tag: string; cls: string }>>(new Map());
async function loadAuction() {
  auctionTags.value = new Map();
  const codes = rows.value.slice(0, 5).map((r) => r.s.code);
  if (!codes.length) return;
  try {
    const qs = await fetchQuotes(codes);
    const m = new Map<string, { gap: number; tag: string; cls: string }>();
    for (const q of qs) {
      const gap = q.prevClose > 0 ? ((q.open - q.prevClose) / q.prevClose) * 100 : 0;
      let tag: string, cls: string;
      if (gap < 0 || gap > 9) { tag = "放弃"; cls = "drop"; }       // 低开或高开近板=被核/买不进
      else if (gap >= 2 && gap <= 6) { tag = "强确认"; cls = "strong"; } // 理想高开
      else { tag = "观察"; cls = "watch"; }                          // 平开/高开过多
      m.set(q.code, { gap, tag, cls });
    }
    auctionTags.value = m;
  } catch { /* 非交易时段无竞价数据 */ }
}
</script>

<template>
  <div class="sieve">
    <!-- 板位选择 -->
    <div class="lvl-row">
      <button
        v-for="n in LEVELS" :key="n"
        class="lvl" :class="{ on: level === n }"
        @click="level = n"
      >{{ n }}进{{ n + 1 }}</button>
      <span class="lvl-more">…更高板同理</span>
    </div>

    <div class="env">
      <template v-if="dateLabel">{{ dateLabel }} · 昨日 {{ level }}板池 <b>{{ totalPool }}</b> 只 → 评分后保留 <b>{{ rows.length }}</b> 只</template>
      <template v-else>盘后拉取最近交易日涨停池</template>
    </div>

    <div class="body">
      <div v-if="loading" class="empty">正在打分…</div>
      <div v-else-if="error" class="empty err">{{ error }}</div>
      <template v-else>
        <div v-if="rows.length === 0" class="empty">该板位昨日无票</div>

        <!-- 候选列表 -->
        <div
          v-for="(r, i) in rows.slice(0, 5)" :key="r.s.code"
          class="row" :class="{ top: i < 2 }"
          @click="emit('select', r.s.code)"
        >
          <div class="row-main">
            <span class="rank" :class="{ gold: i < 2 }">{{ i + 1 }}</span>
            <span class="nm">{{ r.s.name }}</span>
            <span class="pc">¥{{ r.s.price.toFixed(2) }}</span>
            <span
              v-if="auctionTags.get(r.s.code)"
              class="auc" :class="auctionTags.get(r.s.code)!.cls"
            >{{ auctionTags.get(r.s.code)!.tag }} {{ auctionTags.get(r.s.code)!.gap.toFixed(1) }}%</span>
            <span class="score" :style="{ color: scoreColor(r.score) }">{{ r.score }}</span>
          </div>
          <div class="row-sub">
            <span v-for="f in r.factors" :key="f.name" class="fac" :title="f.name">
              {{ f.name }} {{ f.val }}<i>{{ f.pts }}</i>
            </span>
            <span class="note">{{ r.note }}</span>
          </div>
        </div>

        <!-- 已排除 -->
        <div v-if="excludedRows.length" class="ex-head">已排除（{{ excludedRows.length }}）</div>
        <div v-for="r in excludedRows" :key="'x'+r.s.code" class="row ex" @click="emit('select', r.s.code)">
          <div class="row-main">
            <span class="rank dim">✕</span>
            <span class="nm">{{ r.s.name }}</span>
            <span class="pc">¥{{ r.s.price.toFixed(2) }}</span>
            <span class="ex-reason">{{ r.excluded }}</span>
          </div>
        </div>
      </template>
    </div>

    <!-- 历史回测 -->
    <div class="bt">
      <div class="bt-head">
        <span>历史回测 · {{ level }}进{{ level + 1 }}</span>
        <button class="bt-run" :disabled="btRunning" @click="runBacktest">
          {{ btRunning ? "回测中…" : "跑近20日" }}
        </button>
      </div>
      <div v-if="bt" class="bt-body">
        <div class="bt-line">
          <span>Top2 选股晋级率</span>
          <b :style="{ color: top2Rate >= allRate ? '#ffd76a' : '#e0455a' }">
            {{ (top2Rate * 100).toFixed(0) }}%
          </b>
          <i>{{ bt.top2Hits }}/{{ bt.top2Total }}</i>
        </div>
        <div class="bt-line">
          <span>全体{{ level }}板平均晋级率</span>
          <b>{{ (allRate * 100).toFixed(0) }}%</b>
          <i>{{ bt.allHits }}/{{ bt.allTotal }}</i>
        </div>
        <div class="bt-concl" :class="{ good: top2Rate > allRate }">
          <template v-if="bt.top2Total === 0">样本不足</template>
          <template v-else-if="top2Rate > allRate">
            跑赢平均 {{ ((top2Rate - allRate) * 100).toFixed(0) }} 个点 · 打分有效
          </template>
          <template v-else>
            未跑赢平均 · 权重待调
          </template>
          <small>（{{ bt.days }} 个交易日样本 · 晋级=T+1成功连板）</small>
        </div>
      </div>
    </div>
    <div class="disclaimer">规则打分 · 概率参考，非投资建议</div>
  </div>
</template>

<style scoped>
.sieve { display: flex; flex-direction: column; height: 100%; font-size: 12px; }
.lvl-row { display: flex; gap: 5px; align-items: center; }
.lvl {
  background: var(--bg-card2); border: 1px solid var(--border); color: var(--text-dim);
  font-size: 11px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
}
.lvl:hover { color: var(--text); }
.lvl.on { background: var(--accent); border-color: var(--accent); color: #1a1a1a; font-weight: 700; }
.lvl-more { margin-left: auto; font-size: 10px; color: var(--text-dim); }
.env { margin: 8px 0; font-size: 11px; color: var(--text-dim); }
.env b { color: var(--text); }

.body { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.empty { color: var(--text-dim); font-size: 11px; text-align: center; padding: 30px 10px; }
.empty.err { color: var(--accent); }

.row { background: var(--bg-card2); border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; cursor: pointer; }
.row:hover { border-color: var(--up); }
.row.top { border-color: #8a6d1f; box-shadow: 0 0 0 1px #8a6d1f inset; }
.row.ex { opacity: .6; }
.row-main { display: flex; align-items: baseline; gap: 7px; }
.rank { font-size: 12px; font-weight: 800; color: var(--text-dim); width: 16px; }
.rank.gold { color: #ffd76a; }
.rank.dim { color: var(--accent); }
.nm { font-weight: 700; font-size: 12px; }
.pc { font-size: 10px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.score { margin-left: auto; font-size: 18px; font-weight: 800; font-variant-numeric: tabular-nums; }
.auc { font-size: 10px; padding: 1px 7px; border-radius: 9px; font-weight: 700; }
.auc.strong { background: rgba(255,215,106,.18); color: #ffd76a; }
.auc.watch { background: var(--bg-hover); color: var(--text-dim); }
.auc.drop { background: rgba(224,69,90,.18); color: var(--down); }
.row-sub { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; align-items: center; }
.fac {
  font-size: 9.5px; color: var(--text-dim); background: var(--bg-hover);
  border-radius: 4px; padding: 1px 5px; font-variant-numeric: tabular-nums;
}
.fac i { font-style: normal; color: var(--up); margin-left: 2px; }
.note { font-size: 9.5px; color: var(--accent); margin-left: auto; }
.ex-head { font-size: 10px; color: var(--text-dim); margin-top: 6px; }
.ex-reason { font-size: 10px; color: var(--accent); margin-left: auto; }

/* 回测 */
.bt { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; }
.bt-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--text-dim); }
.bt-run {
  background: var(--bg-hover); border: 1px solid var(--border); color: var(--text);
  font-size: 10px; padding: 3px 10px; border-radius: 6px; cursor: pointer;
}
.bt-run:disabled { opacity: .6; cursor: default; }
.bt-run:hover:not(:disabled) { border-color: var(--accent); }
.bt-body { margin-top: 6px; display: flex; flex-direction: column; gap: 3px; }
.bt-line { display: flex; align-items: baseline; gap: 8px; font-size: 11px; color: var(--text-dim); }
.bt-line b { font-size: 14px; font-variant-numeric: tabular-nums; }
.bt-line i { font-style: normal; font-size: 10px; color: var(--text-dim); }
.bt-concl { font-size: 10.5px; margin-top: 4px; color: var(--accent); }
.bt-concl.good { color: #ffd76a; }
.bt-concl small { color: var(--text-dim); margin-left: 6px; }
.disclaimer { font-size: 9px; color: var(--text-dim); text-align: center; padding-top: 6px; }
</style>
