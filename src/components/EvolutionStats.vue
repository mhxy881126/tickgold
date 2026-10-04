<template>
  <div class="ev">
    <!-- 顶部工具栏 -->
    <div class="ev-bar">
      <div class="ev-params">
        <label>止损% <input v-model.number="cfg.stopPct" type="number" step="0.5" /></label>
        <label>止盈% <input v-model.number="cfg.targetPct" type="number" step="0.5" /></label>
        <label>周期 <input v-model.number="cfg.horizon" type="number" min="1" max="5" step="1" /></label>
        <label class="ev-chk"><input v-model="cfg.includeWatch" type="checkbox" />含观察</label>
      </div>
      <div class="ev-actions">
        <span v-if="lastMsg" class="ev-msg">{{ lastMsg }}</span>
        <button class="ev-btn" :disabled="running" @click="run(false)">
          {{ running ? '打标中…' : '运行打标' }}
        </button>
        <button class="ev-btn ghost" :disabled="running" @click="confirmForce">全量重算</button>
        <button class="ev-btn ghost" @click="doCheck(false)">数据校验</button>
        <button class="ev-btn ghost danger" @click="confirmCleanup">清理过期</button>
      </div>
    </div>

    <!-- 校验横幅 -->
    <div v-if="check" class="ev-check" :class="{ bad: check.issues > 0 }">
      <template v-if="check.issues > 0">
        发现 {{ check.issues }} 项待处理：缺标签 {{ check.missingLabelStale }} · 零周期
        {{ check.horizonZero }} · 孤儿标签 {{ check.orphanLabels }} · 未登记模型
        {{ check.missingModelRegistry }}
      </template>
      <template v-else>链路一致性正常（决策 {{ check.totalDecisions }} / 标签 {{ check.totalLabels }}）</template>
      <span v-if="check.cleanup" class="ev-cleaned">
        已清理：孤儿 {{ check.deletedOrphan }} · 旧标签 {{ check.deletedOldLabels }} · 旧决策
        {{ check.deletedOldDecisions }}
      </span>
    </div>

    <!-- Tab -->
    <div class="ev-tabs">
      <button :class="{ on: tab === 'stats' }" @click="tab = 'stats'">
        效果对照 <em>{{ stats?.totalLabels ?? 0 }}</em>
      </button>
      <button :class="{ on: tab === 'labels' }" @click="tab = 'labels'">标签明细</button>
      <div v-if="tab === 'labels'" class="ev-filter">
        <button
          v-for="f in filters"
          :key="f.v"
          :class="{ on: verdictFilter === f.v }"
          @click="setFilter(f.v)"
        >
          {{ f.t }}
        </button>
      </div>
    </div>

    <!-- 效果对照 -->
    <div v-if="tab === 'stats'" class="ev-scroll">
      <div v-if="!stats || !stats.groups.length" class="ev-empty">
        暂无效果数据，点击「运行打标」对历史决策回灌后续走势
      </div>
      <table v-else class="ev-table">
        <thead>
          <tr>
            <th>模型版本</th>
            <th>策略</th>
            <th class="r">样本</th>
            <th class="r">胜率</th>
            <th class="r">平均收益</th>
            <th class="r">均盈</th>
            <th class="r">均亏</th>
            <th class="r">盈亏比</th>
            <th class="r">期望</th>
            <th class="r">止盈</th>
            <th class="r">止损</th>
            <th class="r">误买</th>
            <th class="r">卖飞</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="g in stats.groups" :key="g.modelVersion + g.strategy">
            <td class="ev-mv">{{ g.modelVersion || '—' }}</td>
            <td>{{ g.strategy || '默认' }}</td>
            <td class="r">{{ g.samples }}</td>
            <td class="r">
              <span class="ev-wr">
                <i class="ev-wr-track"><i :style="wrStyle(g.winRate)" /></i>
                <b :class="wrCls(g.winRate)">{{ g.winRate.toFixed(1) }}%</b>
              </span>
            </td>
            <td class="r" :class="retCls(g.avgRet)">{{ signed(g.avgRet) }}</td>
            <td class="r up">{{ signed(g.avgWin) }}</td>
            <td class="r k">{{ g.avgLoss.toFixed(2) }}</td>
            <td class="r">{{ g.profitFactor === null ? '∞' : g.profitFactor.toFixed(2) }}</td>
            <td class="r" :class="retCls(g.expectancy)">{{ signed(g.expectancy) }}</td>
            <td class="r">{{ g.hitTarget }}</td>
            <td class="r">{{ g.hitStop }}</td>
            <td class="r k">{{ g.falsePositive }}</td>
            <td class="r k">{{ g.sellTooEarly }}</td>
          </tr>
        </tbody>
      </table>
      <p class="ev-note">{{ stats?.note }} 调参仅产出统计依据，参数变更须人工批准。</p>
    </div>

    <!-- 标签明细 -->
    <div v-else class="ev-scroll">
      <div v-if="!labels.length" class="ev-empty">暂无标签记录</div>
      <table v-else class="ev-table dense">
        <thead>
          <tr>
            <th>日期</th>
            <th>时间</th>
            <th>信号</th>
            <th>股票</th>
            <th class="r">置信</th>
            <th class="r">入场</th>
            <th class="r">+1d</th>
            <th class="r">+2d</th>
            <th class="r">+3d</th>
            <th class="r">+5d</th>
            <th class="r">最大涨</th>
            <th class="r">最大跌</th>
            <th>结果</th>
            <th>误判</th>
            <th>标记</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in labels" :key="l.id">
            <td class="ev-dim">{{ l.tradeDate }}</td>
            <td class="ev-dim">{{ l.ts }}</td>
            <td><span class="ev-sig" :data-l="l.decisionLabel">{{ sigTxt(l.decisionLabel) }}</span></td>
            <td class="ev-stock">{{ l.code }} <em>{{ l.name }}</em></td>
            <td class="r ev-dim">{{ Math.round(l.confidence * 100) }}%</td>
            <td class="r">{{ l.entryPrice.toFixed(2) }}</td>
            <td class="r" :class="retCls(l.ret1d)">{{ retTxt(l.ret1d) }}</td>
            <td class="r" :class="retCls(l.ret2d)">{{ retTxt(l.ret2d) }}</td>
            <td class="r" :class="retCls(l.ret3d)">{{ retTxt(l.ret3d) }}</td>
            <td class="r" :class="retCls(l.ret5d)">{{ retTxt(l.ret5d) }}</td>
            <td class="r up">{{ signed(l.maxGain) }}</td>
            <td class="r k">{{ signed(l.maxPain) }}</td>
            <td><span class="ev-verdict" :data-v="l.verdict">{{ verdictTxt(l.verdict) }}</span></td>
            <td class="ev-dim">{{ missTxt(l.missType) }}</td>
            <td class="ev-flags">
              <span v-if="l.hitTarget" class="ev-flag t">盈</span>
              <span v-if="l.hitStop" class="ev-flag s">损</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import {
  evolutionRunLabeling,
  evolutionListLabels,
  evolutionStats,
  evolutionDataCheck,
  type EvolutionConfigInfo,
  type EvolutionStatsInfo,
  type TradeLabelInfo,
  type EvolutionDataCheckInfo,
  type LabelRunResult,
} from "../ai/api";

const cfg = reactive<EvolutionConfigInfo>({
  stopPct: -7,
  targetPct: 10,
  horizon: 5,
  includeWatch: true,
});
const tab = ref<"stats" | "labels">("stats");
const stats = ref<EvolutionStatsInfo | null>(null);
const labels = ref<TradeLabelInfo[]>([]);
const check = ref<EvolutionDataCheckInfo | null>(null);
const running = ref(false);
const lastMsg = ref("");
const verdictFilter = ref("all");

const filters = [
  { v: "all", t: "全部" },
  { v: "good", t: "正确" },
  { v: "bad", t: "错误" },
  { v: "neutral", t: "中性" },
];

const SIG: Record<string, string> = { BUY: "买入", SELL: "卖出", HOLD: "持有", NO_BUY: "不买" };
const MISS: Record<string, string> = {
  false_positive: "误买",
  sell_too_early: "卖飞",
  none: "—",
};

function sigTxt(k: string) {
  return SIG[k] || k;
}
function missTxt(k: string) {
  return MISS[k] || k;
}
function verdictTxt(k: string) {
  return k === "good" ? "正确" : k === "bad" ? "错误" : "中性";
}
function signed(v: number | null) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return (v > 0 ? "+" : "") + v.toFixed(2);
}
function retTxt(v: number | null) {
  if (v === null || v === undefined) return "—";
  return signed(v);
}
function retCls(v: number | null) {
  if (v === null || v === undefined) return "";
  return v > 0 ? "up" : v < 0 ? "k" : "";
}
function wrCls(v: number) {
  return v >= 60 ? "up" : v < 40 ? "k" : "";
}
function wrStyle(v: number) {
  const c = v >= 60 ? "#FF3232" : v < 40 ? "#54FCFC" : "var(--accent,#d4af37)";
  return { width: Math.max(2, v) + "%", background: c };
}

async function loadStats() {
  stats.value = await evolutionStats();
}
async function loadLabels() {
  labels.value = await evolutionListLabels(verdictFilter.value, 300);
}
function setFilter(v: string) {
  verdictFilter.value = v;
  loadLabels();
}

async function run(force: boolean) {
  running.value = true;
  lastMsg.value = "";
  try {
    const r: LabelRunResult = await evolutionRunLabeling({ ...cfg }, force);
    lastMsg.value = `打标 ${r.labeled} 条 · 数据不足 ${r.insufficient} 条`;
    await Promise.all([loadStats(), loadLabels()]);
  } catch (e) {
    lastMsg.value = "打标失败：" + String(e);
  } finally {
    running.value = false;
  }
}

function confirmForce() {
  if (window.confirm("将清空全部标签并按当前参数全量重算，是否继续？")) run(true);
}

async function doCheck(cleanup: boolean, keepDays?: number) {
  check.value = await evolutionDataCheck(cleanup, keepDays);
}

function confirmCleanup() {
  const keep = window.prompt("清理多少天前的决策与标签？", "180");
  if (keep === null) return;
  const days = parseInt(keep, 10);
  if (!Number.isFinite(days) || days < 1) return;
  if (window.confirm(`将删除 ${days} 天前的决策与标签，且不可恢复，是否继续？`)) {
    doCheck(true, days);
  }
}

onMounted(async () => {
  try {
    await Promise.all([loadStats(), loadLabels()]);
  } catch {
    /* 无数据时静默 */
  }
});
</script>

<style scoped>
.ev {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
}

/* 工具栏 */
.ev-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px solid var(--border, #2a3344);
  border-radius: 10px;
  background: var(--bg-card, #15181f);
}
.ev-params {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 10px;
  color: var(--text-dim, #9aa4b8);
}
.ev-params label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.ev-params input[type="number"] {
  width: 52px;
  background: transparent;
  border: 1px solid var(--border, #2a3344);
  border-radius: 5px;
  color: var(--text, #e6ecf5);
  padding: 2px 4px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.ev-chk input {
  accent-color: var(--accent, #d4af37);
}
.ev-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ev-msg {
  font-size: 10px;
  color: var(--text-dim, #9aa4b8);
}
.ev-btn {
  border: 1px solid var(--accent, #d4af37);
  background: var(--accent, #d4af37);
  color: #14110a;
  border-radius: 6px;
  padding: 3px 11px;
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
}
.ev-btn.ghost {
  background: transparent;
  color: var(--text-dim, #aab2c4);
  border-color: var(--border, #2a3344);
}
.ev-btn.ghost:hover {
  color: var(--accent, #d4af37);
  border-color: var(--accent, #d4af37);
}
.ev-btn.danger:hover {
  color: #ff6b6b;
  border-color: #ff6b6b;
}
.ev-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

/* 校验横幅 */
.ev-check {
  font-size: 10px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid #1dbe7d55;
  background: #1dbe7d12;
  color: #88e0b0;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.ev-check.bad {
  border-color: #f5d02055;
  background: #f5d02012;
  color: #f0d878;
}
.ev-cleaned {
  color: var(--text-dim, #9aa4b8);
}

/* tabs */
.ev-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ev-tabs > button {
  border: 1px solid var(--border, #2a3344);
  background: transparent;
  color: var(--text-dim, #9aa4b8);
  border-radius: 7px 7px 0 0;
  padding: 5px 12px;
  font-size: 10px;
  cursor: pointer;
}
.ev-tabs > button.on {
  color: var(--accent, #d4af37);
  border-color: var(--accent, #d4af37);
  border-bottom-color: transparent;
}
.ev-tabs em {
  font-style: normal;
  opacity: 0.8;
}
.ev-filter {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.ev-filter button {
  border: 1px solid var(--border, #2a3344);
  background: transparent;
  color: var(--text-dim, #9aa4b8);
  border-radius: 6px;
  padding: 2px 9px;
  font-size: 10px;
  cursor: pointer;
}
.ev-filter button.on {
  color: var(--accent, #d4af37);
  border-color: var(--accent, #d4af37);
}

/* 滚动 + 表格 */
.ev-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border, #263043);
  border-radius: 0 8px 8px 8px;
}
.ev-empty {
  text-align: center;
  color: var(--text-dim, #8a93a6);
  font-size: 11px;
  padding: 34px 0;
}
.ev-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
}
.ev-table.dense {
  font-size: 9.5px;
}
.ev-table th {
  position: sticky;
  top: 0;
  z-index: 2;
  text-align: left;
  padding: 6px 8px;
  background: var(--bg-panel, #10131a);
  color: var(--text-dim, #98a1b5);
  font-weight: 600;
  white-space: nowrap;
  border-bottom: 1px solid var(--border, #263043);
}
.ev-table th.r,
.ev-table td.r {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.ev-table td {
  padding: 5px 8px;
  white-space: nowrap;
  color: var(--text, #dce3f0);
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.ev-table tbody tr:hover {
  background: var(--bg-hover, rgba(255, 255, 255, 0.04));
}
.ev-mv {
  color: var(--text-dim, #aab2c4);
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ev-dim {
  color: var(--text-dim, #8a93a6);
}
.ev-stock em {
  color: var(--text-dim, #98a1b5);
  font-style: normal;
}
.up {
  color: #ff3232;
}
.k {
  color: #54fcfc;
}

/* 胜率条 */
.ev-wr {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ev-wr-track {
  width: 44px;
  height: 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
  display: inline-block;
}
.ev-wr-track i {
  display: block;
  height: 100%;
}

/* 徽标 */
.ev-sig {
  border: 1px solid var(--border, #2a3344);
  border-radius: 5px;
  padding: 0 5px;
  font-size: 9px;
}
.ev-sig[data-l="BUY"] {
  color: #ff3232;
  border-color: #ff3232;
}
.ev-sig[data-l="SELL"] {
  color: #54fcfc;
  border-color: #54fcfc;
}
.ev-verdict {
  border-radius: 5px;
  padding: 1px 7px;
  font-size: 9px;
  font-weight: 700;
}
.ev-verdict[data-v="good"] {
  color: #1dbe7d;
  background: #1dbe7d1a;
}
.ev-verdict[data-v="bad"] {
  color: #ff6b6b;
  background: #ff6b6b1a;
}
.ev-verdict[data-v="neutral"] {
  color: var(--text-dim, #9aa4b8);
  background: rgba(255, 255, 255, 0.05);
}
.ev-flags {
  white-space: nowrap;
}
.ev-flag {
  border-radius: 4px;
  padding: 0 4px;
  font-size: 9px;
  margin-right: 3px;
}
.ev-flag.t {
  color: #ff3232;
  border: 1px solid #ff3232;
}
.ev-flag.s {
  color: #54fcfc;
  border: 1px solid #54fcfc;
}
.ev-note {
  color: var(--text-dim, #7e879b);
  font-size: 9px;
  padding: 8px;
}
</style>
