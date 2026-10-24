<template>
  <div class="dl">
    <!-- 快脑决策条 -->
    <div class="dl-bar" :class="{ 'is-on': brainOn }">
      <span class="dl-dot" />
      <template v-if="latest">
        <span class="dl-lbadge" :style="lbStyle(latest.label)">{{ lbTxt(latest.label) }}</span>
        <span class="dl-code">{{ latest.code }} {{ latest.name }}</span>
        <span class="dl-conf">
          <i class="dl-conf-track"><i :style="{ width: pct(latest.confidence), background: lbColor(latest.label) }" /></i>
          {{ pct(latest.confidence) }}
        </span>
        <span class="dl-action" :data-a="latest.action">{{ actionTxt(latest.action) }}</span>
        <QualityChip v-if="latest.quality" :q="latest.quality" />
        <span class="dl-ts">{{ latest.ts }}</span>
      </template>
      <template v-else>
        <span class="dl-idle">快脑待命中 · 盘中出现特征信号将在此实时显示</span>
      </template>
      <button class="dl-refresh" @click="load">刷新</button>
    </div>

    <!-- 日志列表 -->
    <div class="dl-list">
      <div v-if="loading && !logs.length" class="dl-empty">加载中…</div>
      <div v-else-if="!logs.length" class="dl-empty">
        <div class="empty-icon">🧠</div>
        <div class="empty-title">暂无决策记录</div>
        <div class="empty-desc">快脑在交易时段自动扫描自选股和持仓，归纳行情特征信号。</div>
        <div class="empty-steps">
          <div class="step">
            <span class="step-num">1</span>
            <div class="step-body">
              <div class="step-title">开启快脑自动执行</div>
              <div class="step-sub">在「机器人」页面启动快脑引擎</div>
            </div>
          </div>
          <div class="step">
            <span class="step-num">2</span>
            <div class="step-body">
              <div class="step-title">加入自选股</div>
              <div class="step-sub">快脑会盯你的自选股和持仓股</div>
            </div>
          </div>
          <div class="step">
            <span class="step-num">3</span>
            <div class="step-body">
              <div class="step-title">等待交易时段</div>
              <div class="step-sub">9:30-15:00 盘中才会产生决策</div>
            </div>
          </div>
        </div>
      </div>

      <div v-for="row in logs" :key="row.id" class="dl-row" :class="{ on: expanded === row.id }">
        <div class="dl-row-head" @click="toggle(row.id)">
          <span class="dl-time">{{ row.ts }}</span>
          <span class="dl-lbadge sm" :style="lbStyle(row.label)">{{ lbTxt(row.label) }}</span>
          <span class="dl-stock">{{ row.code }} <em>{{ row.name }}</em></span>
          <span class="dl-confmini" :style="{ color: lbColor(row.label) }">{{ pct(row.confidence) }}</span>
          <span class="dl-mode">{{ row.mode === 'laya' ? 'Laya' : '规则' }}</span>
          <span class="dl-action sm" :data-a="row.action">{{ actionTxt(row.action) }}</span>
          <span class="dl-chevron">{{ expanded === row.id ? '−' : '+' }}</span>
        </div>

        <div v-if="expanded === row.id" class="dl-detail">
          <!-- v2.31 同型历史命中率 -->
          <div class="dl-qline">
            <QualityChip v-if="row.quality" :q="row.quality" />
            <span v-else-if="qualityLoading[row.id]" class="dl-qload">命中率查询中…</span>
            <span v-else class="dl-qna">同型样本未统计</span>
          </div>
          <!-- v2.31 因子归因 -->
          <div v-if="factorRowsOf(row).length" class="dl-factors">
            <div v-for="f in factorRowsOf(row)" :key="f.factor" class="dl-factor">
              <span class="dl-fname">{{ factorLabel(f.factor) }}</span>
              <span class="dl-ftrack">
                <i class="dl-fzero" />
                <i class="dl-fbar" :style="factorBarStyle(f.contribution)" />
              </span>
              <span class="dl-fval" :class="f.contribution >= 0 ? 'up' : 'k'">
                {{ signed3(f.contribution) }}
              </span>
            </div>
          </div>
          <!-- 四类概率 -->
          <div class="dl-probs">
            <div v-for="k in probKeys" :key="k" class="dl-prob">
              <span class="dl-prob-label" :style="{ color: lbColor(k) }">{{ lbTxt(k) }}</span>
              <i class="dl-prob-track"><i :style="{ width: pct(row.probs[k] || 0), background: lbColor(k) }" /></i>
              <span class="dl-prob-val">{{ pct(row.probs[k] || 0) }}</span>
            </div>
          </div>
          <!-- 关键特征 -->
          <div class="dl-feats">
            <span v-for="f in featRows(row)" :key="f.k" class="dl-feat">
              <em>{{ f.k }}</em><b :class="f.cls">{{ f.v }}</b>
            </span>
          </div>
          <div class="dl-meta">
            战法：{{ row.strategy || '—' }} · 模型：{{ row.modelVersion }} · 推理：{{ row.inferMs.toFixed(1) }}ms
            <span v-if="(row.features as any).hardStop" class="dl-hard">硬止损</span>
          </div>
        </div>
      </div>
    </div>
  </div>
<ComplianceFooter />
</template>

<script setup lang="ts">
import ComplianceFooter from "./ComplianceFooter.vue";
import { onMounted, onUnmounted, reactive, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import {
  autoexecGetConfig,
  listDecisionLogs,
  signalQualityLookup,
  type DecisionLogInfo,
  type FactorContribInfo,
} from "../ai/api";
import QualityChip from "./QualityChip.vue";

/// 因子名中文标签（与快脑打分 key 对齐；未列出的原样显示）。
const FACTOR_LABELS: Record<string, string> = {
  pct: "涨跌幅",
  speed5m: "5分钟涨速",
  volumeRatio: "量比",
  turnover: "换手率",
  distToLimit: "距涨停",
  pullback: "回撤",
  blastCount: "炸板次数",
  marketEmotion: "市场情绪",
  indexChg: "指数涨跌",
  themeRank: "题材地位",
  catalystFreshness: "催化剂新鲜度",
  mainNetInflowYi: "主力净流入",
  macdHist: "MACD柱",
  rsi14: "RSI",
  maBullish: "均线多头",
  maBearish: "均线空头",
  distToSupportPct: "距支撑位",
  distToResistancePct: "距压力位",
  klineIsHammer: "锤子线",
  klineIsBullishEngulfing: "看涨吞没",
  klineIsBearishEngulfing: "看跌吞没",
  volRatio20: "量比20日",
  brokenLimit: "破板",
};

const logs = ref<DecisionLogInfo[]>([]);
const loading = ref(false);
const expanded = ref<number | null>(null);
const latest = ref<DecisionLogInfo | null>(null);
const brainOn = ref(false);
const probKeys = ["watch_up", "calm", "hold", "watch_down"];
let timer: number | null = null;
let unlisten: (() => void) | null = null;

const LB_COLOR: Record<string, string> = {
  watch_up: "#FF3232",
  watch_down: "#54FCFC",
  hold: "#9aa4b8",
  calm: "#1DBE7D",
  // 兼容历史 DB 中旧标签
  BUY: "#FF3232",
  SELL: "#54FCFC",
  HOLD: "#9aa4b8",
  NO_BUY: "#1DBE7D",
};
const LB_TXT: Record<string, string> = {
  watch_up: "上涨特征",
  watch_down: "下跌特征",
  hold: "持平",
  calm: "无明显特征",
  // 兼容历史 DB 中旧标签
  BUY: "上涨特征",
  SELL: "下跌特征",
  HOLD: "持平",
  NO_BUY: "无明显特征",
};
const ACTION_TXT: Record<string, string> = {
  executed: "已执行",
  watch: "观察",
  drop: "放弃",
};

function lbColor(k: string) {
  return LB_COLOR[k] || "#9aa4b8";
}
function lbTxt(k: string) {
  return LB_TXT[k] || k;
}
function actionTxt(k: string) {
  return ACTION_TXT[k] || k;
}
function lbStyle(k: string) {
  const c = lbColor(k);
  return { color: c, borderColor: c, background: c + "1f" };
}
function pct(v: number) {
  return Math.round((v || 0) * 100) + "%";
}
/// 展开行按需补查命中率；因子归因直接取行数据（实时信号），历史行可能为空。
const qualityLoading = reactive<Record<number, boolean>>({});

function factorRowsOf(row: DecisionLogInfo): FactorContribInfo[] {
  return row.factorContributions ?? [];
}
function factorLabel(k: string) {
  return FACTOR_LABELS[k] ?? k;
}
function signed3(v: number) {
  return (v > 0 ? "+" : "") + v.toFixed(2);
}
/// 归因条：中线为 0，正贡献红色向右、负贡献青色向左；最大宽度按 |c|/w 归一。
const MAX_ABS_CONTRIB = 1.5;
function factorBarStyle(c: number) {
  const widthPct = Math.min(Math.abs(c) / MAX_ABS_CONTRIB, 1) * 50;
  const color = c >= 0 ? "#FF3232" : "#1dbe7d";
  if (c >= 0) {
    return { left: "50%", width: widthPct + "%", background: color };
  }
  return { right: "50%", width: widthPct + "%", background: color };
}

async function ensureQuality(row: DecisionLogInfo) {
  if (row.quality || qualityLoading[row.id]) {
    return;
  }
  qualityLoading[row.id] = true;
  try {
    row.quality = await signalQualityLookup({
      strategy: row.strategy || "",
      session: "",
      side: row.label === "SELL" || row.label === "watch_down" ? "sell" : "buy",
    });
  } catch {
    row.quality = null;
  } finally {
    qualityLoading[row.id] = false;
  }
}

function toggle(id: number) {
  if (expanded.value === id) {
    expanded.value = null;
    return;
  }
  expanded.value = id;
  const row = logs.value.find((r) => r.id === id);
  if (row) {
    void ensureQuality(row);
  }
}

interface FeatRow {
  k: string;
  v: string;
  cls?: string;
}
function featRows(row: DecisionLogInfo): FeatRow[] {
  const f = row.features as Record<string, number | undefined>;
  const num = (v: number | undefined, d = 2) =>
    v === undefined || v === null || Number.isNaN(v) ? "—" : Number(v).toFixed(d);
  const signed = (v: number | undefined, d = 2) => {
    if (v === undefined || v === null || Number.isNaN(v)) return "—";
    return (v > 0 ? "+" : "") + Number(v).toFixed(d);
  };
  return [
    { k: "现价", v: num(f.price) },
    { k: "涨跌%", v: signed(f.pct), cls: (f.pct || 0) >= 0 ? "up" : "k" },
    { k: "涨速5m", v: signed(f.speed5m), cls: (f.speed5m || 0) >= 0 ? "up" : "k" },
    { k: "量比", v: num(f.volumeRatio) },
    { k: "换手%", v: num(f.turnover) },
    { k: "距涨停%", v: num(f.distToLimit) },
    { k: "回撤%", v: signed(f.pullback), cls: "k" },
    { k: "炸板", v: num(f.blastCount, 0) },
    { k: "情绪", v: num(f.marketEmotion, 0) },
    { k: "主力净亿", v: signed(f.mainNetInflowYi), cls: (f.mainNetInflowYi || 0) >= 0 ? "up" : "k" },
  ];
}

async function load() {
  loading.value = true;
  try {
    logs.value = await listDecisionLogs(null, 200);
    latest.value = logs.value[0] ?? null;
    brainOn.value = (await autoexecGetConfig()).enabled;
  } catch {
    /* 静默，等待下一次刷新 */
  } finally {
    loading.value = false;
  }
}

/// 实时事件携带的命中率/因子归因合并进最新行（DB 重读不带这两列）。
async function onSignal(event: { payload: Record<string, unknown> }) {
  await load();
  const p = event.payload;
  const target = logs.value.find(
    (r) => r.code === p.code && r.ts === p.ts,
  ) ?? logs.value[0];
  if (target) {
    if (p.quality) target.quality = p.quality as DecisionLogInfo["quality"];
    if (p.factorContributions) {
      target.factorContributions = p.factorContributions as FactorContribInfo[];
    }
    latest.value = target;
  }
}

onMounted(async () => {
  await load();
  unlisten = await listen("fastbrain-signal", onSignal);
  timer = window.setInterval(load, 8000);
});
onUnmounted(() => {
  if (timer) window.clearInterval(timer);
  unlisten?.();
});
</script>

<style scoped>
.dl {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
}

/* 决策条 */
.dl-bar {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border: 1px solid var(--border, #2a3344);
  border-radius: 10px;
  background: var(--bg-card, #15181f);
  font-size: 11px;
}
.dl-bar.is-on {
  border-color: var(--accent, #d4af37);
}
.dl-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim, #6b7488);
  flex: none;
}
.dl-bar.is-on .dl-dot {
  background: var(--accent, #d4af37);
  box-shadow: 0 0 8px var(--accent, #d4af37);
}
.dl-code {
  color: var(--text, #e6ecf5);
  font-weight: 600;
}
.dl-idle {
  flex: 1;
  color: var(--text-dim, #8a93a6);
}
.dl-conf {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-dim, #aab2c4);
}
.dl-conf-track {
  width: 52px;
  height: 5px;
  border-radius: 3px;
  background: var(--ov-08);
  overflow: hidden;
  display: inline-block;
}
.dl-conf-track i {
  display: block;
  height: 100%;
  border-radius: 3px;
}
.dl-ts {
  margin-left: auto;
  color: var(--text-dim, #8a93a6);
}
.dl-refresh {
  border: 1px solid var(--border, #2a3344);
  background: transparent;
  color: var(--text-dim, #aab2c4);
  border-radius: 6px;
  padding: 2px 9px;
  font-size: 10px;
  cursor: pointer;
}
.dl-refresh:hover {
  color: var(--accent, #d4af37);
  border-color: var(--accent, #d4af37);
}

.dl-lbadge {
  border: 1px solid;
  border-radius: 6px;
  padding: 1px 7px;
  font-weight: 700;
  flex: none;
}
.dl-lbadge.sm {
  font-size: 10px;
  padding: 0 6px;
}
.dl-action {
  border-radius: 5px;
  padding: 1px 6px;
  font-size: 10px;
  border: 1px solid var(--border, #2a3344);
  color: var(--text-dim, #9aa4b8);
}
.dl-action[data-a="executed"] {
  color: var(--down);
  border-color: var(--down);
  background: #1DBE7D1a;
}
.dl-action[data-a="watch"] {
  color: var(--accent);
  border-color: var(--accent);
  background: #f5d02014;
}

/* 列表 */
.dl-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dl-empty {
  text-align: center;
  color: var(--text-dim, #8a93a6);
  font-size: 11px;
  padding: 20px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.empty-icon { font-size: 28px; }
.empty-title { font-size: 13px; font-weight: 600; color: var(--text, #e8dcc8); }
.empty-desc { font-size: 10.5px; color: var(--text-dim, #8a93a6); line-height: 1.5; max-width: 260px; }
.empty-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  max-width: 280px;
  margin-top: 4px;
}
.empty-steps .step {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 6px 8px;
  background: var(--bg-card2, #1a1712);
  border: 1px solid var(--border, #2c2619);
  border-radius: 6px;
  text-align: left;
}
.empty-steps .step-num {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(212, 175, 55, 0.15);
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.empty-steps .step-body { flex: 1; min-width: 0; }
.empty-steps .step-title { font-size: 10.5px; font-weight: 600; color: var(--text, #e8dcc8); }
.empty-steps .step-sub { font-size: 9.5px; color: var(--text-dim, #8a93a6); margin-top: 1px; line-height: 1.4; }
.dl-row {
  border: 1px solid var(--border, #263043);
  border-radius: 9px;
  overflow: hidden;
}
.dl-row.on {
  border-color: var(--accent, #d4af37);
}
.dl-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  cursor: pointer;
  font-size: 11px;
}
.dl-row-head:hover {
  background: var(--bg-hover, var(--ov-04));
}
.dl-time {
  color: var(--text-dim, #8a93a6);
  width: 58px;
  flex: none;
  font-variant-numeric: tabular-nums;
}
.dl-stock {
  flex: 1;
  color: var(--text, #dde4f0);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dl-stock em {
  color: var(--text-dim, #98a1b5);
  font-style: normal;
}
.dl-confmini {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.dl-mode {
  color: var(--text-dim, #7e879b);
  font-size: 10px;
}
.dl-chevron {
  color: var(--text-dim, #8a93a6);
  width: 14px;
  text-align: center;
}

/* 命中率行 */
.dl-qline {
  padding: 7px 0 3px;
}
.dl-qload,
.dl-qna {
  font-size: 10px;
  color: var(--text-dim, #7e879b);
}
/* 因子归因条形 */
.dl-factors {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px 18px;
  padding: 6px 0 4px;
}
.dl-factor {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
}
.dl-fname {
  width: 64px;
  flex: none;
  color: var(--text-dim, #98a1b5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dl-ftrack {
  position: relative;
  flex: 1;
  height: 7px;
  background: var(--ov-05);
  border-radius: 3px;
}
.dl-fzero {
  position: absolute;
  left: 50%;
  top: -1px;
  bottom: -1px;
  width: 1px;
  background: var(--ov-25);
}
.dl-fbar {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 2px;
}
.dl-fval {
  width: 40px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim, #aab2c4);
}
.dl-fval.up {
  color: var(--up);
}
.dl-fval.k {
  color: var(--down);
}

/* 详情 */
.dl-detail {
  padding: 4px 10px 9px;
  border-top: 1px solid var(--border, #263043);
}
.dl-probs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 16px;
  padding: 8px 0;
}
.dl-prob {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
}
.dl-prob-label {
  width: 30px;
  flex: none;
}
.dl-prob-track {
  flex: 1;
  height: 5px;
  border-radius: 3px;
  background: var(--ov-07);
  overflow: hidden;
}
.dl-prob-track i {
  display: block;
  height: 100%;
}
.dl-prob-val {
  width: 38px;
  text-align: right;
  color: var(--text-dim, #aab2c4);
  font-variant-numeric: tabular-nums;
}
.dl-feats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding: 6px 0;
}
.dl-feat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  border: 1px solid var(--border, #263043);
  border-radius: 6px;
  padding: 2px 7px;
}
.dl-feat em {
  color: var(--text-dim, #8a93a6);
  font-style: normal;
}
.dl-feat b {
  color: var(--text, #dce3f0);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dl-feat b.up {
  color: var(--up);
}
.dl-feat b.k {
  color: #54FCFC;
}
.dl-meta {
  color: var(--text-dim, #7e879b);
  font-size: 10px;
  padding-top: 5px;
}
.dl-hard {
  color: #fff;
  background: var(--up);
  border-radius: 5px;
  padding: 0 6px;
  margin-left: 6px;
  font-weight: 700;
}
</style>
