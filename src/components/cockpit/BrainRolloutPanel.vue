<script setup lang="ts">
// P5 模型接管控制台：rule → shadow → canary → live 四阶段灰度推进。
// 影子模型只记录不执行 → 达标后小比例灰度 → 全量接管；规则脑随时一键回退。
import { computed, onMounted, ref } from "vue";
import {
  brainRolloutGet,
  brainRolloutRequest,
  brainRolloutApprove,
  brainRolloutRollback,
  drillRunAll,
  type RolloutView,
  type DrillReport,
} from "../../broker/api";
import LaunchWizard from "./LaunchWizard.vue";

const loading = ref(false);
const busy = ref(false);
const view = ref<RolloutView | null>(null);
const error = ref("");
const hint = ref("");
const drill = ref<DrillReport | null>(null);
const showWizard = ref(false);

// 灰度 / 达标参数（shadow → canary 时可调）
const grayPct = ref(10);
const smallPositionPct = ref(5);
const shadowMinSamples = ref(100);
const shadowMinAgreePct = ref(60);

const STAGES = [
  { key: "rule", name: "规则脑", desc: "成熟规则引擎全量决策", color: "#5b8db8" },
  { key: "shadow", name: "影子对比", desc: "AI 并行出主意，只记录不执行", color: "#36b8e8" },
  { key: "canary", name: "灰度接管", desc: "小比例、小仓位让 AI 执行", color: "#ffb13d" },
  { key: "live", name: "模型接管", desc: "AI 全量执行，规则脑兜底", color: "#f23645" },
];

const stageIdx = computed(() => {
  const s = view.value?.stage ?? "rule";
  return Math.max(0, STAGES.findIndex((x) => x.key === s));
});
const pendingTarget = computed(() => view.value?.requestedStage || "");
const nextTarget = computed(() => {
  const i = stageIdx.value;
  return i < STAGES.length - 1 ? STAGES[i + 1]!.key : "";
});
const isLive = computed(() => view.value?.stage === "live");
const stats = computed(() => view.value?.stats);

function stageClass(key: string, i: number) {
  const cur = stageIdx.value;
  if (i < cur) return "done";
  if (i === cur) return pendingTarget.value ? "pending" : "active";
  return "todo";
}

async function refresh() {
  loading.value = true;
  try {
    view.value = await brainRolloutGet();
    // 同步输入框为后端当前值
    grayPct.value = view.value.grayPct;
    smallPositionPct.value = view.value.smallPositionPct;
    shadowMinSamples.value = view.value.shadowMinSamples;
    shadowMinAgreePct.value = view.value.shadowMinAgreePct;
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function doRequest(target: string) {
  error.value = "";
  hint.value = "";
  if (!target) return;
  busy.value = true;
  try {
    view.value = await brainRolloutRequest({
      target,
      grayPct: grayPct.value,
      smallPositionPct: smallPositionPct.value,
      shadowMinSamples: shadowMinSamples.value,
      shadowMinAgreePct: shadowMinAgreePct.value,
      note: target === "live" ? "申请全量模型接管（live）" : `申请进入${stageName(target)}`,
    });
    hint.value = `已提交进入「${stageName(target)}」的申请，等待审批确认。`;
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function doApprove(ok: boolean) {
  error.value = "";
  hint.value = "";
  busy.value = true;
  try {
    view.value = await brainRolloutApprove(ok);
    hint.value = ok ? "已审批通过，阶段切换完成。" : "已拒绝该申请，维持当前阶段。";
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function doRollback() {
  error.value = "";
  hint.value = "";
  busy.value = true;
  try {
    view.value = await brainRolloutRollback("人工一键回退到规则脑");
    hint.value = "已回退到规则脑：全部交易信号恢复由成熟规则引擎决策。";
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function runDrill() {
  error.value = "";
  hint.value = "";
  busy.value = true;
  try {
    drill.value = await drillRunAll();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

function stageName(key: string) {
  return STAGES.find((s) => s.key === key)?.name ?? key;
}
function pct(v: number | undefined) {
  return v == null ? "—" : `${v.toFixed(1)}%`;
}
function ms(v: number | undefined) {
  return v == null || v <= 0 ? "—" : `${Math.round(v)}ms`;
}

onMounted(refresh);
</script>

<template>
  <section class="rollout" :class="{ live: isLive }">
    <div class="ro-head">
      <div class="ro-title">
        <span class="ro-dot" :style="{ background: STAGES[stageIdx]?.color }" />
        <span class="ro-name">模型接管控制台</span>
        <span class="ro-badge" :style="{ color: STAGES[stageIdx]?.color, borderColor: STAGES[stageIdx]?.color }">
          当前：{{ STAGES[stageIdx]?.name }}
        </span>
        <span v-if="pendingTarget" class="ro-badge pending">待审批 → {{ stageName(pendingTarget) }}</span>
        <span v-if="view && view.failCount > 0" class="ro-badge fail">连续失败 {{ view.failCount }}/5</span>
      </div>
      <div class="ro-actions">
        <button class="btn-ghost" :disabled="busy || loading" @click="refresh">刷新</button>
        <button class="btn-ghost" @click="showWizard = true">上线向导</button>
        <button v-if="view && view.stage !== 'rule'" class="btn-danger" :disabled="busy" @click="doRollback">
          一键回退规则脑
        </button>
      </div>
    </div>

    <!-- 四阶段流水线 -->
    <div class="pipeline">
      <template v-for="(s, i) in STAGES" :key="s.key">
        <div class="pl-stage" :class="stageClass(s.key, i)">
          <span class="pl-dot" :style="{ background: stageClass(s.key, i) === 'todo' ? '#2a3542' : s.color, borderColor: s.color }" />
          <div class="pl-text">
            <div class="pl-name">{{ s.name }}</div>
            <div class="pl-desc">{{ s.desc }}</div>
          </div>
        </div>
        <span v-if="i < STAGES.length - 1" class="pl-arrow" :class="{ on: i < stageIdx }">→</span>
      </template>
    </div>

    <!-- 影子统计 -->
    <div v-if="stats" class="stats-grid">
      <div class="stat">
        <div class="stat-k">影子样本</div>
        <div class="stat-v">{{ stats.samples }}<span class="stat-sub"> / {{ view?.shadowMinSamples ?? 100 }}</span></div>
      </div>
      <div class="stat">
        <div class="stat-k">影子脑可用</div>
        <div class="stat-v" :class="stats.layaAvailable ? 'ok' : 'warn'">{{ stats.layaAvailable ? "可用" : "未就绪" }}</div>
      </div>
      <div class="stat">
        <div class="stat-k">与规则脑一致率</div>
        <div class="stat-v">{{ pct(stats.agreePct) }}<span class="stat-sub"> ≥ {{ view?.shadowMinAgreePct ?? 60 }}%</span></div>
      </div>
      <div class="stat">
        <div class="stat-k">规则脑耗时</div>
        <div class="stat-v small">p50 {{ ms(stats.ruleP50Ms) }} · p99 {{ ms(stats.ruleP99Ms) }}</div>
      </div>
      <div class="stat">
        <div class="stat-k">影子脑耗时</div>
        <div class="stat-v small">p50 {{ ms(stats.shadowP50Ms) }} · p99 {{ ms(stats.shadowP99Ms) }}</div>
      </div>
      <div class="stat">
        <div class="stat-k">灰度达标</div>
        <div class="stat-v" :class="stats.meetsCanary ? 'ok' : 'warn'">{{ stats.meetsCanary ? "达标" : "未达标" }}</div>
      </div>
    </div>

    <!-- 操作区 -->
    <div class="op-area">
      <!-- 待审批 -->
      <div v-if="pendingTarget" class="op-card pending">
        <div class="op-line">
          有一笔进入「<b>{{ stageName(pendingTarget) }}</b>」的申请等待审批。
          <span v-if="pendingTarget === 'live'" class="danger-text">全量接管前请确认实盘已武装、风控参数已设置。</span>
        </div>
        <div class="op-btns">
          <button class="btn-primary" :disabled="busy" @click="doApprove(true)">同意并切换</button>
          <button class="btn-ghost" :disabled="busy" @click="doApprove(false)">拒绝</button>
        </div>
      </div>

      <!-- rule：申请 shadow -->
      <div v-else-if="view && view.stage === 'rule'" class="op-card">
        <div class="op-line">影子模式下，AI 与规则脑并行对每只盯盘标的出主意，但<b>只记录、不执行</b>；积累足够样本后再决定是否放权。</div>
        <div class="op-btns">
          <button class="btn-primary" :disabled="busy" @click="doRequest('shadow')">申请进入影子对比</button>
        </div>
      </div>

      <!-- shadow：达标后申请 canary -->
      <div v-else-if="view && view.stage === 'shadow'" class="op-card">
        <div class="op-line">影子达到 <b>样本数 + 一致率</b> 双门槛后，可申请让 AI 按小比例、小仓位灰度执行。</div>
        <div class="param-row">
          <label>灰度比例（%）<input type="number" min="0" max="100" step="1" v-model.number="grayPct" /></label>
          <label>AI 单票仓位上限（%）<input type="number" min="1" max="100" step="1" v-model.number="smallPositionPct" /></label>
          <label>达标样本数<input type="number" min="10" step="10" v-model.number="shadowMinSamples" /></label>
          <label>达标一致率（%）<input type="number" min="0" max="100" step="1" v-model.number="shadowMinAgreePct" /></label>
        </div>
        <div class="op-btns">
          <button class="btn-primary" :disabled="busy" @click="doRequest('canary')">申请灰度接管</button>
        </div>
      </div>

      <!-- canary：申请 live -->
      <div v-else-if="view && view.stage === 'canary'" class="op-card">
        <div class="op-line">灰度运行稳定后，可申请让 AI 全量接管。<span class="danger-text">此阶段实盘通道必须已在券商设置中「武装」。</span></div>
        <div class="op-btns">
          <button class="btn-danger" :disabled="busy" @click="doRequest('live')">申请全量模型接管</button>
        </div>
      </div>

      <!-- live -->
      <div v-else-if="view && view.stage === 'live'" class="op-card live-card">
        <div class="op-line danger-text">AI 已全量接管交易决策。规则脑作为兜底：影子脑连续失败 5 次将自动回退，你也可随时一键回退。</div>
      </div>
    </div>

    <!-- 故障演练 -->
    <div class="drill-area">
      <div class="drill-head">
        <span class="drill-title">故障注入 · 急停演练</span>
        <button class="btn-ghost" :disabled="busy" @click="runDrill">运行演练（5 项）</button>
      </div>
      <div v-if="drill" class="drill-result" :class="{ ok: drill.allPass }">
        <div class="drill-summary">
          {{ drill.allPass ? "全部通过" : "存在未通过项" }}：{{ drill.passed }}/{{ drill.total }}
        </div>
        <div v-for="it in drill.items" :key="it.kind" class="drill-row" :class="it.pass ? 'pass' : 'fail'">
          <span class="drill-mark">{{ it.pass ? "✓" : "✕" }}</span>
          <div class="drill-body">
            <div class="drill-name">{{ it.name }}</div>
            <div class="drill-ev">{{ it.evidence }}</div>
          </div>
        </div>
      </div>
      <div v-else class="drill-hint dim">演练模型超时、断网、交易客户端崩溃、行情陈旧、一键急停 5 类故障，验证系统能降级、能急停、能回退。仅在模拟环境可运行。</div>
    </div>

    <div v-if="error" class="ro-error">{{ error }}</div>
    <div v-if="hint" class="ro-hint">{{ hint }}</div>

    <LaunchWizard v-if="showWizard" @close="showWizard = false" />
  </section>
</template>

<style scoped>
.rollout {
  margin-top: 14px;
  background: linear-gradient(180deg, rgba(20, 27, 36, 0.96), rgba(13, 18, 25, 0.98));
  border: 1px solid #1f2a37;
  border-radius: 14px;
  padding: 16px 18px;
}
.rollout.live {
  border-color: rgba(242, 54, 69, 0.55);
  box-shadow: 0 0 0 1px rgba(242, 54, 69, 0.25), 0 8px 30px rgba(242, 54, 69, 0.08);
}
.ro-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.ro-title {
  display: flex;
  align-items: center;
  gap: 9px;
}
.ro-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  box-shadow: 0 0 8px currentColor;
}
.ro-name {
  font-size: 15px;
  font-weight: 700;
  color: #e6edf3;
}
.ro-badge {
  font-size: 11px;
  padding: 2px 9px;
  border: 1px solid;
  border-radius: 20px;
  font-weight: 600;
}
.ro-badge.pending {
  color: #ffb13d;
  border-color: #ffb13d;
  animation: blink 1.2s infinite;
}
.ro-badge.fail {
  color: #f23645;
  border-color: #f23645;
}
@keyframes blink {
  50% {
    opacity: 0.45;
  }
}
.ro-actions {
  display: flex;
  gap: 8px;
}
.btn-primary,
.btn-ghost,
.btn-danger {
  font-size: 12.5px;
  padding: 7px 14px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
  border: 1px solid transparent;
  transition: 0.15s;
}
.btn-primary {
  background: #36b8e8;
  color: #061018;
}
.btn-primary:hover {
  filter: brightness(1.08);
}
.btn-danger {
  background: #f23645;
  color: #fff;
}
.btn-danger:hover {
  background: #ff5a6a;
}
.btn-ghost {
  background: transparent;
  color: #b7c2cf;
  border-color: #2c3a4a;
}
.btn-ghost:hover {
  border-color: #4a5c70;
  color: #e6edf3;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.pipeline {
  display: flex;
  align-items: center;
  margin: 16px 0;
  gap: 6px;
  flex-wrap: wrap;
}
.pl-stage {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1;
  min-width: 150px;
}
.pl-dot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid;
  flex: none;
}
.pl-stage.done .pl-dot {
  box-shadow: 0 0 8px currentColor;
}
.pl-stage.active .pl-dot {
  box-shadow: 0 0 0 4px rgba(54, 184, 232, 0.18);
}
.pl-stage.pending .pl-dot {
  animation: blink 1s infinite;
}
.pl-name {
  font-size: 13px;
  font-weight: 700;
  color: #e6edf3;
}
.pl-stage.todo .pl-name {
  color: #6b7886;
}
.pl-desc {
  font-size: 10.5px;
  color: #7d8a99;
  margin-top: 1px;
}
.pl-arrow {
  color: #33414f;
  font-size: 16px;
  flex: none;
}
.pl-arrow.on {
  color: #36b8e8;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 10px;
  margin-bottom: 14px;
}
.stat {
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid #1c2734;
  border-radius: 10px;
  padding: 10px 12px;
}
.stat-k {
  font-size: 11px;
  color: #7d8a99;
  margin-bottom: 5px;
}
.stat-v {
  font-size: 17px;
  font-weight: 700;
  color: #e6edf3;
}
.stat-v.small {
  font-size: 13px;
  font-weight: 600;
}
.stat-sub {
  font-size: 11px;
  color: #6b7886;
  font-weight: 400;
}
.stat-v.ok {
  color: #37d67a;
}
.stat-v.warn {
  color: #ffb13d;
}

.op-area {
  margin-bottom: 12px;
}
.op-card {
  background: rgba(54, 184, 232, 0.05);
  border: 1px solid #20303f;
  border-radius: 10px;
  padding: 12px 14px;
}
.op-card.pending {
  background: rgba(255, 177, 61, 0.07);
  border-color: rgba(255, 177, 61, 0.4);
}
.op-card.live-card {
  background: rgba(242, 54, 69, 0.08);
  border-color: rgba(242, 54, 69, 0.4);
}
.op-line {
  font-size: 12.5px;
  color: #b7c2cf;
  line-height: 1.6;
  margin-bottom: 10px;
}
.danger-text {
  color: #ff5a6a;
  font-weight: 600;
}
.param-row {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  margin: 10px 0;
}
.param-row label {
  font-size: 11.5px;
  color: #8a97a6;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.param-row input {
  width: 96px;
  background: #0d141c;
  border: 1px solid #2c3a4a;
  border-radius: 7px;
  color: #e6edf3;
  padding: 6px 8px;
  font-size: 13px;
}
.op-btns {
  display: flex;
  gap: 9px;
}

.drill-area {
  border-top: 1px dashed #223040;
  padding-top: 12px;
}
.drill-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.drill-title {
  font-size: 13px;
  font-weight: 700;
  color: #e6edf3;
}
.drill-hint {
  font-size: 11.5px;
  line-height: 1.6;
}
.drill-summary {
  font-size: 12.5px;
  font-weight: 700;
  margin-bottom: 8px;
}
.drill-result.ok .drill-summary {
  color: #37d67a;
}
.drill-result:not(.ok) .drill-summary {
  color: #f23645;
}
.drill-row {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.drill-mark {
  font-size: 14px;
  font-weight: 700;
  flex: none;
  width: 18px;
}
.drill-row.pass .drill-mark {
  color: #37d67a;
}
.drill-row.fail .drill-mark {
  color: #f23645;
}
.drill-name {
  font-size: 12.5px;
  font-weight: 600;
  color: #d6dee8;
}
.drill-ev {
  font-size: 11.5px;
  color: #8a97a6;
  line-height: 1.5;
}
.ro-error {
  margin-top: 10px;
  font-size: 12px;
  color: #ff5a6a;
  background: rgba(242, 54, 69, 0.1);
  border: 1px solid rgba(242, 54, 69, 0.3);
  border-radius: 8px;
  padding: 8px 11px;
}
.ro-hint {
  margin-top: 10px;
  font-size: 12px;
  color: #6fd0a6;
  background: rgba(55, 214, 122, 0.08);
  border: 1px solid rgba(55, 214, 122, 0.25);
  border-radius: 8px;
  padding: 8px 11px;
}
.dim {
  color: #7d8a99;
}

@media (max-width: 900px) {
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .pl-stage {
    min-width: 130px;
  }
}
</style>
