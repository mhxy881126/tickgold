<template>
  <div class="ev">
    <!-- 顶部说明 -->
    <div class="ev-intro">
      <div class="ev-intro-title">🧠 机器人进化实验室</div>
      <div class="ev-intro-desc">
        机器人做过的每一个决策（买/卖/观察），过几天回头看：<b>对了还是错了？</b>
        攒多了就能知道：机器人到底行不行，哪些策略好用，哪些要改。
      </div>
    </div>

    <!-- 参数设置 -->
    <div class="ev-section">
      <div class="ev-section-title">📏 评判标准（怎么算对、怎么算错）</div>
      <div class="ev-params">
        <div class="ev-param">
          <div class="ev-param-label">涨多少算对</div>
          <div class="ev-param-input">
            <input v-model.number="cfg.targetPct" type="number" step="0.5" />%
          </div>
          <div class="ev-param-hint">比如：涨 10% 以上，说明买对了</div>
        </div>
        <div class="ev-param">
          <div class="ev-param-label">跌多少算错</div>
          <div class="ev-param-input">
            <input v-model.number="cfg.stopPct" type="number" step="0.5" />%
          </div>
          <div class="ev-param-hint">比如：跌 7% 以上，说明买错了</div>
        </div>
        <div class="ev-param">
          <div class="ev-param-label">等几天看结果</div>
          <div class="ev-param-input">
            <input v-model.number="cfg.horizon" type="number" min="1" max="5" step="1" />天
          </div>
          <div class="ev-param-hint">做完决策后，等几天再判断对错</div>
        </div>
        <div class="ev-param ev-chk">
          <label>
            <input v-model="cfg.includeWatch" type="checkbox" />
            连"观察"的信号一起评判
          </label>
        </div>
      </div>
      <div class="ev-save-row">
        <button class="ev-btn save-btn" @click="saveCfg">💾 保存设置</button>
        <span v-if="cfgSaved" class="ev-saved-tip">✅ 已保存</span>
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="ev-section">
      <div class="ev-section-title">🎬 开始分析</div>
      <div class="ev-actions">
        <button class="ev-btn primary" :disabled="running" @click="run(false)">
          {{ running ? '⏳ 分析中...' : '🔍 分析历史决策' }}
        </button>
        <button class="ev-btn ghost" :disabled="running" @click="confirmForce">
          🔄 全部重新分析
        </button>
        <button class="ev-btn ghost" @click="doCheck(false)">
          ✅ 检查数据
        </button>
        <button class="ev-btn ghost danger" @click="confirmCleanup">
          🗑️ 清理旧数据
        </button>
      </div>
      <div v-if="lastMsg" class="ev-msg">{{ lastMsg }}</div>
    </div>

    <!-- 数据状态 -->
    <div v-if="check" class="ev-status" :class="{ bad: check.issues > 0 }">
      <template v-if="check.issues > 0">
        ⚠️ 有 {{ check.issues }} 个问题需要处理
      </template>
      <template v-else>
        ✅ 数据正常：共 {{ check.totalDecisions }} 个决策，{{ check.totalLabels }} 个已评判
      </template>
    </div>

    <!-- Tab -->
    <div class="ev-tabs">
      <button :class="{ on: tab === 'stats' }" @click="tab = 'stats'">
        📊 机器人战绩 <em>{{ stats?.totalLabels ?? 0 }}</em>
      </button>
      <button :class="{ on: tab === 'labels' }" @click="tab = 'labels'">
        📋 决策明细
      </button>
    </div>

    <!-- 机器人战绩 -->
    <div v-if="tab === 'stats'" class="ev-scroll">
      <div v-if="!stats || !stats.groups.length" class="ev-empty">
        <div class="empty-icon">📈</div>
        <div class="empty-title">还没有战绩数据</div>
        <div class="empty-desc">进化回灌会回测历史决策的涨跌结果，帮你验证机器人的真实胜率。</div>
        <div class="empty-steps">
          <div class="step">
            <span class="step-num">1</span>
            <div class="step-body">
              <div class="step-title">先有决策记录</div>
              <div class="step-sub">开启快脑自动执行，产生买卖决策</div>
            </div>
          </div>
          <div class="step">
            <span class="step-num">2</span>
            <div class="step-body">
              <div class="step-title">等待评判周期</div>
              <div class="step-sub">默认 5 天后，才能看到涨跌结果</div>
            </div>
          </div>
          <div class="step">
            <span class="step-num">3</span>
            <div class="step-body">
              <div class="step-title">点击「分析历史决策」</div>
              <div class="step-sub">回测计算胜率、盈亏比等指标</div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- 统计卡片 -->
      <div v-else class="ev-cards">
        <div class="ev-card">
          <div class="ev-card-num">{{ stats.totalLabels }}</div>
          <div class="ev-card-label">已评判决策</div>
        </div>
        <div class="ev-card">
          <div class="ev-card-num">{{ stats.groups[0]?.winRate ?? 0 }}%</div>
          <div class="ev-card-label">胜率</div>
        </div>
        <div class="ev-card">
          <div class="ev-card-num">{{ stats.groups[0]?.profitFactor ?? 0 }}</div>
          <div class="ev-card-label">盈亏比</div>
        </div>
        <div class="ev-card">
          <div class="ev-card-num">{{ stats.groups[0]?.expectancy ?? 0 }}%</div>
          <div class="ev-card-label">每次期望收益</div>
        </div>
      </div>
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
import { confirmDialog, promptDialog } from "../composables/useDialog";

const cfg = reactive<EvolutionConfigInfo>({
  stopPct: -7,
  targetPct: 10,
  horizon: 5,
  includeWatch: true,
});
const cfgSaved = ref(false);

// 从 localStorage 读取配置
function loadCfg() {
  try {
    const saved = localStorage.getItem("evolution_cfg");
    if (saved) {
      const parsed = JSON.parse(saved);
      Object.assign(cfg, parsed);
    }
  } catch {}
}

// 保存配置到 localStorage
function saveCfg() {
  localStorage.setItem("evolution_cfg", JSON.stringify(cfg));
  cfgSaved.value = true;
  setTimeout(() => { cfgSaved.value = false; }, 2000);
}

// 页面加载时读取配置
onMounted(() => {
  loadCfg();
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

async function confirmForce() {
  const ok = await confirmDialog({
    title: "全量重算",
    message: "将清空全部标签并按当前参数全量重算，是否继续？",
    confirmText: "重算",
    danger: true,
  });
  if (ok) run(true);
}

async function doCheck(cleanup: boolean, keepDays?: number) {
  check.value = await evolutionDataCheck(cleanup, keepDays);
}

async function confirmCleanup() {
  const keep = await promptDialog({
    title: "清理历史",
    message: "清理多少天前的决策与标签？",
    defaultValue: "180",
  });
  if (keep === null) return;
  const days = parseInt(keep, 10);
  if (!Number.isFinite(days) || days < 1) return;
  const ok = await confirmDialog({
    title: "确认清理",
    message: `将删除 ${days} 天前的决策与标签，且不可恢复，是否继续？`,
    confirmText: "删除",
    danger: true,
  });
  if (ok) doCheck(true, days);
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
  gap: 12px;
  padding: 12px;
  overflow-y: auto;
}

/* 顶部说明 */
.ev-intro {
  padding: 12px;
  background: linear-gradient(135deg, rgba(0,255,213,0.05), rgba(90,160,255,0.05));
  border: 1px solid rgba(0,255,213,0.2);
  border-radius: 10px;
}
.ev-intro-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--accent-2, #00ffd5);
  margin-bottom: 6px;
}
.ev-intro-desc {
  font-size: 13px;
  color: var(--text-dim, #8892a8);
  line-height: 1.6;
}
.ev-intro-desc b {
  color: var(--text, #e0e6f0);
}

/* 区块 */
.ev-section {
  padding: 12px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--border, #2a3344);
  border-radius: 10px;
}
.ev-section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text, #e0e6f0);
  margin-bottom: 10px;
}

/* 参数 */
.ev-params {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.ev-param {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ev-param-label {
  font-size: 12px;
  color: var(--text-dim, #8892a8);
}
.ev-param-input {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ev-param-input input {
  width: 60px;
  padding: 6px 8px;
  background: var(--bg-input, #1a2233);
  border: 1px solid var(--border, #2a3344);
  border-radius: 6px;
  color: var(--text, #e0e6f0);
  font-size: 14px;
}
.ev-param-hint {
  font-size: 11px;
  color: var(--text-dim, #666e80);
}
.ev-chk {
  display: flex;
  align-items: center;
  padding-top: 24px;
}
.ev-chk label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text, #e0e6f0);
}

/* 操作按钮 */
.ev-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.ev-btn.primary {
  background: var(--accent-2, #00ffd5);
  color: #000;
  font-weight: 600;
}

/* 保存设置 */
.ev-save-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border, #2a3344);
}
.ev-btn.save-btn {
  background: var(--accent, #5aa0ff);
  color: #fff;
  font-size: 13px;
}
.ev-saved-tip {
  font-size: 13px;
  color: #00ff64;
}

/* 数据状态 */
.ev-status {
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
  background: rgba(0,255,100,0.1);
  border: 1px solid rgba(0,255,100,0.3);
  color: #00ff64;
}
.ev-status.bad {
  background: rgba(255,100,100,0.1);
  border-color: rgba(255,100,100,0.3);
  color: #ff6464;
}

/* 空状态 */
.ev-empty {
  padding: 24px 20px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.empty-icon { font-size: 32px; }
.empty-title { font-size: 14px; font-weight: 600; color: var(--text, #e0e6f0); }
.empty-desc {
  font-size: 11px;
  color: var(--text-dim, #8892a8);
  line-height: 1.6;
  max-width: 280px;
}
.empty-steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 300px;
  margin-top: 6px;
}
.empty-steps .step {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 10px;
  background: var(--bg-card2, #1a1712);
  border: 1px solid var(--border, #2c2619);
  border-radius: 8px;
  text-align: left;
}
.empty-steps .step-num {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(212, 175, 55, 0.15);
  color: #d4af37;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.empty-steps .step-body { flex: 1; min-width: 0; }
.empty-steps .step-title { font-size: 11.5px; font-weight: 600; color: var(--text, #e0e6f0); }
.empty-steps .step-sub { font-size: 10px; color: var(--text-dim, #8892a8); margin-top: 2px; line-height: 1.4; }

/* 统计卡片 */
.ev-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  padding: 20px;
}
.ev-card {
  padding: 16px;
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--border, #2a3344);
  border-radius: 10px;
  text-align: center;
}
.ev-card-num {
  font-size: 28px;
  font-weight: 700;
  color: var(--accent-2, #00ffd5);
  margin-bottom: 4px;
}
.ev-card-label {
  font-size: 12px;
  color: var(--text-dim, #8892a8);
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
