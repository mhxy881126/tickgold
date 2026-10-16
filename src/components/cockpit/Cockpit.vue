<script setup lang="ts">
// 作战流驾驶舱：账户条 + 六步进度 + 当前作战卡（P1 前三步真实产物：态势包/候选池/作战卡）+ 作战日志。
// P1 串起 采集→分析→计划（真实行情/六战法/规则作战卡，无需大模型）；后三步盯盘/执行/回灌为 P2 占位。
import { computed, onMounted, ref } from "vue";
import {
  useWorkflowStore,
  STEP_META,
  TACTIC_LABEL,
  type StepState,
  type SignalRow,
} from "../../stores/workflow";

const wf = useWorkflowStore();
onMounted(() => {
  wf.loadToday();
});

// 六步语义色：采集青 / 分析紫 / 计划金 / 盯盘橙 / 执行红 / 回灌绿
const STEP_COLORS = ["#36b8e8", "#b07cff", "#e8c878", "#ff9f43", "#ff4d6a", "#2fbf95"];

const selected = ref<number | null>(null);

interface StepView {
  index: number;
  key: string;
  title: string;
  short: string;
  input: string;
  output: string;
  action: string;
  color: string;
  state: StepState;
}

const steps = computed<StepView[]>(() =>
  STEP_META.map((m, i) => ({
    ...m,
    color: STEP_COLORS[i]!,
    state:
      wf.mission?.steps[i] ??
      ({ key: m.key, status: i === 0 ? "doing" : "todo", snapshot: "", at: 0 } as StepState),
  })),
);

const viewIdx = computed(() => {
  if (wf.allDone) return 5;
  if (selected.value != null && selected.value >= 0 && selected.value < STEP_META.length)
    return selected.value;
  return wf.currentStep;
});
const view = computed<StepView>(() => steps.value[viewIdx.value]!);
const isCurrentView = computed(() => !wf.allDone && viewIdx.value === wf.currentStep);
const isLocked = computed(() => !wf.allDone && viewIdx.value > wf.currentStep);

const statusLabel: Record<string, string> = {
  todo: "未开始",
  doing: "进行中",
  done: "已完成",
};

const tierLabel: Record<string, string> = {
  candidate: "备选",
  watch: "观察",
  trigger: "触发",
};

function selectStep(i: number) {
  selected.value = i;
}
function backToCurrent() {
  selected.value = null;
}
async function doCollect() {
  await wf.collect();
  selected.value = null;
}
async function doAnalyze() {
  await wf.analyze();
  selected.value = null;
}
async function doPlanGenerate() {
  await wf.planGenerate();
  selected.value = null;
}
async function doPlanConfirm() {
  await wf.planConfirm();
  selected.value = null;
}
async function doReset() {
  await wf.reset();
  selected.value = null;
}

function fmtMoney(n: number) {
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}
function pctText(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}
function tacticLabel(k: string) {
  return TACTIC_LABEL[k] ?? k;
}
function sealTime(hm: number) {
  const s = String(hm).padStart(6, "0");
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}
function hhmm(ts: number) {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 候选池分层：备选（≥80 分或 ≥3 板）/ 观察。
const candidateInstructions = computed(() =>
  wf.battlePlan?.instructions.filter((x) => x.tier === "candidate") ?? [],
);
const watchInstructions = computed(() =>
  wf.battlePlan?.instructions.filter((x) => x.tier !== "candidate") ?? [],
);

// 右侧作战日志：由真实产物与步骤状态推导。
const journal = computed<SignalRow[]>(() => {
  const st = wf.mission?.steps;
  const b = wf.briefing;
  const cands = wf.candidates;
  const rows: SignalRow[] = [];
  rows.push({
    time: hhmm(st?.[0]?.at ?? 0),
    title: "采集战场态势",
    desc: b
      ? `涨停 ${b.limitUp} 家 · 炸板 ${b.broken} 家 · 炸板率 ${b.brokenRate}% · 最高 ${b.maxBoards} 板`
      : "收盘后执行第①步，产出战场态势包",
    tone: b ? "info" : "muted",
  });
  rows.push({
    time: hhmm(st?.[1]?.at ?? 0),
    title: "六战法量化分析",
    desc: cands.length
      ? `候选 ${cands.length} 只 · 榜首 ${cands[0]!.name}（${cands[0]!.score} 分）`
      : "执行第②步，六战法打分排序产出候选池",
    tone: cands.length ? "info" : "muted",
  });
  rows.push({
    time: hhmm(st?.[2]?.at ?? 0),
    title: "生成并确认作战卡",
    desc: wf.planConfirmed
      ? `次日作战卡已转 ${wf.alertsCreated} 条预警，进入明日盯盘`
      : wf.battlePlan
        ? `${wf.battlePlan.planDate} 作战卡已生成，待确认`
        : "执行第③步，生成次日作战卡",
    tone: wf.planConfirmed ? "up" : wf.battlePlan ? "info" : "muted",
  });
  rows.push({
    time: "P2",
    title: "盯盘 · 执行 · 回灌",
    desc: wf.planConfirmed
      ? "预警已就位；P2 起实时盯盘、风控闸门、模拟/券商下单、进化回灌"
      : "P2 上线：快脑信号、信号桥下单、成交打标",
    tone: "muted",
  });
  return rows;
});

// Kill Switch：P0 仅本地演示态，P2 接 broker 真实熔断。
const killOn = ref(false);
function toggleKill() {
  killOn.value = !killOn.value;
}
</script>

<template>
  <div class="cockpit">
    <!-- 账户条 -->
    <div class="acct-bar" :class="{ killed: killOn }">
      <div class="acct-mode">
        <span class="mode-dot" />
        <span class="mode-name">{{ wf.account.modeLabel }}</span>
        <span v-if="wf.mockMode" class="mode-badge">演示数据</span>
      </div>
      <div class="acct-items">
        <div class="acct-item">
          <div class="ai-label">总资产</div>
          <div class="ai-val mono">{{ fmtMoney(wf.account.totalAsset) }}</div>
        </div>
        <div class="acct-item">
          <div class="ai-label">持仓市值</div>
          <div class="ai-val mono">{{ fmtMoney(wf.account.marketValue) }}</div>
        </div>
        <div class="acct-item">
          <div class="ai-label">仓位</div>
          <div class="ai-val mono">{{ wf.account.positionPct.toFixed(1) }}%</div>
        </div>
        <div class="acct-item">
          <div class="ai-label">当日盈亏</div>
          <div class="ai-val mono" :class="wf.account.dayPnl >= 0 ? 'up' : 'down'">
            {{ fmtMoney(wf.account.dayPnl) }}
            <span class="ai-sub">({{ pctText(wf.account.dayPnlPct) }})</span>
          </div>
        </div>
        <div class="acct-item">
          <div class="ai-label">风控</div>
          <div class="ai-val risk-ok">{{ killOn ? "已熔断" : "正常" }}</div>
        </div>
      </div>
      <button class="kill-btn" :class="{ on: killOn }" @click="toggleKill">
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2 1 21h22L12 2zm0 6 7.5 11.5h-15L12 8zm-1 4v4h2v-4h-2zm0 5v2h2v-2h-2z"
          />
        </svg>
        <span>{{ killOn ? "解除熔断" : "一键熔断" }}</span>
      </button>
    </div>

    <!-- 六步进度条 -->
    <div class="flow-head">
      <div class="flow-title">
        <span class="flow-name">今日作战流</span>
        <span class="flow-date mono">{{ wf.mission?.tradeDate ?? "—" }}</span>
      </div>
      <div class="flow-progress">
        <span class="prog-num mono">{{ wf.currentStep }} / 6</span>
        <div class="prog-track"><div class="prog-fill" :style="{ width: wf.progressPct + '%' }" /></div>
      </div>
    </div>

    <div class="step-bar">
      <button
        v-for="(s, i) in steps"
        :key="s.key"
        class="step"
        :class="[s.state.status, { active: viewIdx === i }]"
        :style="{ '--sc': s.color }"
        @click="selectStep(i)"
      >
        <span class="step-line" v-if="i > 0" />
        <span class="step-dot">
          <svg v-if="s.state.status === 'done'" viewBox="0 0 24 24" width="15" height="15">
            <path
              fill="none"
              stroke="#0a0e14"
              stroke-width="3.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M4 12.5l5 5L20 6.5"
            />
          </svg>
          <span v-else class="step-num">{{ i + 1 }}</span>
          <span class="step-pulse" v-if="s.state.status === 'doing'" />
        </span>
        <span class="step-text">
          <span class="step-title">{{ s.title }}</span>
          <span class="step-short">{{ s.short }}</span>
        </span>
      </button>
    </div>

    <!-- 主区域：作战卡 + 作战日志 -->
    <div class="cockpit-body">
      <section class="battle-card" :style="{ '--bc': view.color }">
        <template v-if="wf.allDone">
          <div class="done-hero">
            <div class="done-badge">
              <svg viewBox="0 0 24 24" width="22" height="22">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M4 12.5l5 5L20 6.5"
                />
              </svg>
            </div>
            <h3>六步作战流已闭环</h3>
            <p class="dim">今日的采集 → 分析 → 计划 → 盯盘 → 执行 → 回灌已全部走完。结果已进入回灌，明日盘前自动进入下一循环。</p>
          </div>
        </template>
        <template v-else>
          <div class="bc-head">
            <span class="bc-no mono">第 {{ view.index + 1 }} 步 · {{ view.title }}</span>
            <span class="bc-status" :class="view.state.status">{{ statusLabel[view.state.status] }}</span>
          </div>
          <h3 class="bc-title">{{ view.short }}</h3>

          <!-- ① 采集 · 战场态势包 -->
          <div v-if="view.index === 0 && wf.briefing" class="panel">
            <div class="stat-grid">
              <div class="stat up">
                <div class="stat-v mono">{{ wf.briefing.limitUp }}</div>
                <div class="stat-k">涨停</div>
              </div>
              <div class="stat down">
                <div class="stat-v mono">{{ wf.briefing.broken }}</div>
                <div class="stat-k">炸板</div>
              </div>
              <div class="stat">
                <div class="stat-v mono">{{ wf.briefing.brokenRate }}%</div>
                <div class="stat-k">炸板率</div>
              </div>
              <div class="stat gold">
                <div class="stat-v mono">{{ wf.briefing.maxBoards }} 板</div>
                <div class="stat-k">最高标</div>
              </div>
            </div>
            <div class="blk">
              <div class="blk-t">连板梯队</div>
              <div class="ladder">
                <span v-for="l in wf.briefing.ladder" :key="l.boards" class="lad">
                  <b class="mono">{{ l.boards }} 板</b><i class="mono">{{ l.count }}</i>
                </span>
                <span v-if="!wf.briefing.ladder.length" class="dim">暂无连板数据</span>
              </div>
            </div>
            <div class="blk">
              <div class="blk-t">主线题材</div>
              <div class="theme-list">
                <div v-for="t in wf.briefing.themes" :key="t.name" class="theme-row">
                  <span class="theme-name">{{ t.name }}</span>
                  <span class="theme-meta mono">{{ t.count }} 家 · 最高 {{ t.maxBoards }} 板</span>
                  <span class="theme-leader">龙头 {{ t.leader?.name ?? "—" }}</span>
                </div>
              </div>
            </div>
            <div class="blk">
              <div class="blk-t">高标梯队</div>
              <div class="high-scroll">
                <div v-for="h in wf.briefing.highStocks" :key="h.code" class="high-chip">
                  <div class="hc-name">{{ h.name }}</div>
                  <div class="hc-b">{{ h.boards }} 板</div>
                  <div class="hc-sub mono">封单 {{ h.fundYi }} 亿</div>
                  <div class="hc-sub dim">{{ h.industry }} · {{ sealTime(h.firstSeal) }} 封</div>
                </div>
                <span v-if="!wf.briefing.highStocks.length" class="dim">当日无连板高标</span>
              </div>
            </div>
          </div>

          <!-- ② 分析 · 候选池 -->
          <div v-else-if="view.index === 1 && wf.candidates.length" class="panel">
            <div class="cand-head">
              <span class="cand-total">统一候选池 · {{ wf.candidates.length }} 只</span>
              <span class="dim">六战法共振打分，按分数降序</span>
            </div>
            <div class="cand-list">
              <div v-for="c in wf.candidates" :key="c.code" class="cand-row" :class="{ hot: c.score >= 80 }">
                <div class="cand-rank mono">#{{ c.rank }}</div>
                <div class="cand-main">
                  <div class="cand-line1">
                    <span class="cand-name">{{ c.name }}</span>
                    <span class="cand-code mono">{{ c.code }}</span>
                    <span class="cand-board mono">{{ c.boards }} 板</span>
                  </div>
                  <div class="cand-tags">
                    <span v-for="t in c.tactics" :key="t" class="t-tag">{{ tacticLabel(t) }}</span>
                    <span class="cand-industry">{{ c.industry }}</span>
                  </div>
                  <div class="cand-reason dim">{{ c.reasons.join("；") }}</div>
                </div>
                <div class="cand-score">
                  <div class="score-num mono" :class="{ hot: c.score >= 80 }">{{ c.score.toFixed(0) }}</div>
                  <div class="score-bar"><div class="score-fill" :style="{ width: c.score + '%' }" /></div>
                </div>
              </div>
            </div>
          </div>

          <!-- ③ 计划 · 作战卡 -->
          <div v-else-if="view.index === 2 && wf.battlePlan" class="panel">
            <div class="plan-head">
              <span class="plan-title">{{ wf.battlePlan.title }}</span>
              <span class="plan-status" :class="wf.planConfirmed ? 'confirmed' : 'draft'">
                {{ wf.planConfirmed ? "已确认 · 已入明日盯盘" : "草稿 · 待确认" }}
              </span>
            </div>
            <div class="market-view">
              <div class="mv-tag">市场观点</div>
              <p class="mv-text">{{ wf.battlePlan.marketView }}</p>
            </div>
            <div v-if="candidateInstructions.length" class="inst-group">
              <div class="ig-tag cand">备选 · 重点跟踪</div>
              <div v-for="(x, i) in candidateInstructions" :key="'c' + i" class="inst">
                <div class="inst-head">
                  <span class="inst-name">{{ x.name }}</span>
                  <span class="inst-code mono">{{ x.code }}</span>
                  <span class="tier-badge cand">{{ tierLabel[x.tier] ?? x.tier }}</span>
                  <span class="inst-theme">{{ x.theme }}</span>
                </div>
                <p class="inst-cond">{{ x.condition }}</p>
              </div>
            </div>
            <div v-if="watchInstructions.length" class="inst-group">
              <div class="ig-tag watch">观察名单</div>
              <div v-for="(x, i) in watchInstructions" :key="'w' + i" class="inst">
                <div class="inst-head">
                  <span class="inst-name">{{ x.name }}</span>
                  <span class="inst-code mono">{{ x.code }}</span>
                  <span class="tier-badge watch">{{ tierLabel[x.tier] ?? x.tier }}</span>
                  <span class="inst-theme">{{ x.theme }}</span>
                </div>
                <p class="inst-cond dim">{{ x.condition }}</p>
              </div>
            </div>
            <div v-if="wf.planConfirmed" class="plan-confirmed-tip">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M4 12.5l5 5L20 6.5" />
              </svg>
              <span>已将 {{ wf.alertsCreated }} 条作战指令转为价格/涨跌幅预警，明日盘中自动监控提醒。</span>
            </div>
          </div>

          <!-- 后三步（P2） -->
          <div v-else-if="view.index >= 3" class="future-tip">
            <div class="future-title">第 {{ view.index + 1 }} 步「{{ view.title }}」将在 P2 上线</div>
            <p v-if="wf.planConfirmed" class="future-ready">
              作战卡已确认，{{ wf.alertsCreated }} 条预警已就位，明日盘中会先以预警提醒方式工作；
              P2 起接入实时盯盘、风控闸门、模拟/券商下单与成交回灌。
            </p>
            <p v-else class="dim">完成前序采集→分析→计划后，这里接入实时盯盘、信号桥下单与进化回灌。</p>
          </div>

          <!-- 锁定/输入产出说明 -->
          <div v-else-if="isLocked" class="locked-tip">
            <svg viewBox="0 0 24 24" width="15" height="15">
              <path fill="currentColor" d="M12 1a5 5 0 00-5 5v3H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2v-9a2 2 0 00-2-2h-1V6a5 5 0 00-5-5zm-3 8V6a3 3 0 116 0v3H9z" />
            </svg>
            <span>未解锁：请先按顺序完成前序步骤</span>
          </div>
          <div v-else class="io-grid">
            <div class="io-box">
              <div class="io-tag in">输入</div>
              <p>{{ view.input }}</p>
            </div>
            <div class="io-arrow">
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path fill="currentColor" d="M4 11h11.2l-4.6-4.6L12 5l7 7-7 7-1.4-1.4L15.2 13H4z" />
              </svg>
            </div>
            <div class="io-box">
              <div class="io-tag out">产出</div>
              <p>{{ view.output }}</p>
            </div>
          </div>

          <p v-if="wf.error" class="err-line">{{ wf.error }}</p>
        </template>

        <div class="bc-actions">
          <template v-if="isCurrentView">
            <button v-if="view.index === 0" class="btn-primary" :disabled="wf.busy" @click="doCollect">
              {{ wf.busy ? "采集中…（拉取涨停/炸板池）" : "采集完成，开始 AI 分析" }}
            </button>
            <button v-else-if="view.index === 1" class="btn-primary" :disabled="wf.busy" @click="doAnalyze">
              {{ wf.busy ? "分析中…（六战法扫描）" : "分析完成，生成作战计划" }}
            </button>
            <template v-else-if="view.index === 2">
              <button v-if="!wf.battlePlan" class="btn-primary" :disabled="wf.busy" @click="doPlanGenerate">
                {{ wf.busy ? "生成中…" : "生成次日作战卡" }}
              </button>
              <template v-else>
                <button class="btn-ghost" :disabled="wf.busy" @click="doPlanGenerate">重新生成</button>
                <button v-if="!wf.planConfirmed" class="btn-primary" :disabled="wf.busy" @click="doPlanConfirm">
                  {{ wf.busy ? "确认中…" : "确认作战卡 · 转明日盯盘" }}
                </button>
                <span v-else class="confirmed-ok">已转入明日盯盘</span>
              </template>
            </template>
            <button v-else class="btn-primary" disabled>第 {{ view.index + 1 }} 步将在 P2 上线</button>
          </template>
          <button v-else-if="!wf.allDone" class="btn-ghost" @click="backToCurrent">返回当前步</button>
          <button class="btn-ghost" :disabled="wf.busy" @click="doReset">重置今日流程</button>
        </div>
      </section>

      <aside class="signal-feed">
        <div class="sf-head">
          <span class="sf-title">作战日志</span>
          <span class="sf-live">{{ wf.mockMode ? "演示" : "实时" }}</span>
        </div>
        <div class="sf-list">
          <div v-for="(sig, i) in journal" :key="i" class="sf-row" :class="sig.tone">
            <span class="sf-time mono">{{ sig.time }}</span>
            <span class="sf-dot" />
            <div class="sf-body">
              <div class="sf-t">{{ sig.title }}</div>
              <div class="sf-d dim">{{ sig.desc }}</div>
            </div>
          </div>
        </div>
        <div class="sf-foot dim">
          每一步都携带 mission_id，从任意卡片点入都能看到它在今日作战流中的位置。
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.cockpit {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 12.5px;
}
.mono { font-family: "JetBrains Mono", Consolas, monospace; }
.dim { color: var(--text-dim); }
.up { color: var(--up); }
.down { color: var(--down); }
.gold { color: #e8c878; }

/* 账户条 */
.acct-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: linear-gradient(180deg, var(--bg-card), var(--bg-card2));
}
.acct-bar.killed { border-color: var(--up); }
.acct-mode { display: flex; align-items: center; gap: 8px; }
.mode-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}
.mode-name { font-weight: 700; color: var(--text); }
.mode-badge {
  font-size: 10px; padding: 1px 7px; border-radius: 999px;
  color: var(--accent); border: 1px solid var(--border-light);
}
.acct-items { display: flex; flex-wrap: wrap; gap: 18px; flex: 1; }
.ai-label { font-size: 10.5px; color: var(--text-dim); }
.ai-val { font-size: 14px; font-weight: 700; color: var(--text); margin-top: 1px; }
.ai-sub { font-size: 11px; font-weight: 500; }
.risk-ok { color: var(--down); }
.kill-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 12px; border-radius: 8px; cursor: pointer;
  font-size: 12px; font-weight: 700;
  color: var(--up); background: rgba(255, 77, 106, 0.08);
  border: 1px solid rgba(255, 77, 106, 0.4);
  transition: background 0.15s;
}
.kill-btn:hover { background: rgba(255, 77, 106, 0.18); }
.kill-btn.on { background: var(--up); color: #fff; border-color: var(--up); }

/* 流程标题与进度 */
.flow-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.flow-title { display: flex; align-items: baseline; gap: 10px; }
.flow-name { font-size: 15px; font-weight: 800; color: var(--text); }
.flow-date { font-size: 11.5px; color: var(--text-dim); }
.flow-progress { display: flex; align-items: center; gap: 8px; flex: 1; max-width: 280px; }
.prog-num { font-size: 11px; color: var(--accent); font-weight: 700; }
.prog-track {
  flex: 1; height: 5px; border-radius: 999px;
  background: var(--bg-hover); overflow: hidden;
}
.prog-fill {
  height: 100%; border-radius: 999px;
  background: linear-gradient(90deg, #36b8e8, #b07cff, #e8c878, #ff9f43, #ff4d6a, #2fbf95);
  transition: width 0.35s ease;
}

/* 六步条 */
.step-bar {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 4px;
}
.step {
  position: relative;
  display: flex; flex-direction: column; align-items: center; gap: 7px;
  padding: 10px 4px 8px;
  background: transparent; border: 1px solid transparent; border-radius: 10px;
  cursor: pointer; color: var(--text-dim);
  transition: background 0.15s, border-color 0.15s;
}
.step:hover { background: var(--bg-hover); }
.step.active { background: var(--bg-card); border-color: var(--sc); }
.step-line {
  position: absolute; top: 23px; left: -50%; width: 100%; height: 2px;
  background: var(--border); z-index: 0;
}
.step.done .step-line { background: var(--sc); }
.step-dot {
  position: relative; z-index: 1;
  width: 28px; height: 28px; border-radius: 50%;
  display: grid; place-items: center;
  border: 2px solid var(--border-light);
  background: var(--bg-card); color: var(--text-dim);
  font-size: 12px; font-weight: 800;
  transition: all 0.2s;
}
.step.done .step-dot { background: var(--sc); border-color: var(--sc); color: #0a0e14; }
.step.doing .step-dot {
  border-color: var(--sc); color: var(--sc);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--sc) 18%, transparent);
}
.step-pulse {
  position: absolute; inset: -2px; border-radius: 50%;
  border: 2px solid var(--sc); opacity: 0;
  animation: pulse 1.6s ease-out infinite;
}
@keyframes pulse {
  0% { opacity: 0.7; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.5); }
}
.step-text { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.step-title { font-size: 12.5px; font-weight: 700; color: var(--text); }
.step.todo .step-title { color: var(--text-dim); }
.step-short { font-size: 10px; color: var(--text-dim); text-align: center; line-height: 1.3; }

/* 主区域 */
.cockpit-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 12px;
  align-items: start;
}
.battle-card {
  border: 1px solid var(--border);
  border-left: 3px solid var(--bc);
  border-radius: 10px;
  padding: 16px;
  background: linear-gradient(180deg, var(--bg-card), var(--bg-card2));
  display: flex; flex-direction: column; gap: 12px;
  min-width: 0;
}
.bc-head { display: flex; align-items: center; justify-content: space-between; }
.bc-no { font-size: 11.5px; color: var(--bc); font-weight: 700; }
.bc-status {
  font-size: 10.5px; padding: 2px 9px; border-radius: 999px; font-weight: 700;
  border: 1px solid var(--border-light); color: var(--text-dim);
}
.bc-status.doing { color: var(--bc); border-color: var(--bc); }
.bc-status.done { color: var(--down); border-color: var(--down); }
.bc-title { font-size: 17px; font-weight: 800; color: var(--text); margin: 0; }
.err-line {
  margin: 0; color: var(--up); font-size: 11.5px;
  border: 1px solid rgba(255, 77, 106, 0.35); background: rgba(255, 77, 106, 0.08);
  border-radius: 8px; padding: 7px 10px;
}
.io-grid {
  display: grid; grid-template-columns: 1fr 26px 1fr;
  gap: 8px; align-items: stretch;
}
.io-box {
  border: 1px solid var(--border); border-radius: 9px;
  padding: 10px 12px; background: var(--bg-panel);
}
.io-tag {
  display: inline-block; font-size: 10px; font-weight: 700;
  padding: 1px 8px; border-radius: 5px; margin-bottom: 6px;
}
.io-tag.in { color: var(--text-dim); background: var(--bg-hover); }
.io-tag.out { color: #0a0e14; background: var(--bc); }
.io-box p { margin: 0; font-size: 12px; line-height: 1.55; color: var(--text); }
.io-arrow { display: grid; place-items: center; color: var(--bc); }
.locked-tip {
  display: flex; align-items: center; gap: 8px;
  color: var(--text-dim); font-size: 12px;
  padding: 10px 12px; border: 1px dashed var(--border); border-radius: 9px;
}
.bc-actions { display: flex; gap: 10px; margin-top: 2px; align-items: center; flex-wrap: wrap; }
.btn-primary {
  flex: 1; padding: 11px 16px; border-radius: 9px; cursor: pointer;
  font-size: 13px; font-weight: 800; color: #0a0e14;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #fff));
  border: none;
  transition: filter 0.15s, transform 0.05s;
}
.btn-primary:hover { filter: brightness(1.08); }
.btn-primary:active { transform: translateY(1px); }
.btn-primary:disabled, .btn-ghost:disabled { opacity: 0.55; cursor: not-allowed; }
.btn-ghost {
  padding: 11px 16px; border-radius: 9px; cursor: pointer;
  font-size: 13px; font-weight: 600; color: var(--text);
  background: transparent; border: 1px solid var(--border-light);
}
.btn-ghost:hover { background: var(--bg-hover); }
.confirmed-ok { color: var(--down); font-weight: 700; font-size: 12.5px; }

.done-hero { text-align: center; padding: 14px 8px; }
.done-badge {
  width: 48px; height: 48px; border-radius: 50%; margin: 0 auto 10px;
  display: grid; place-items: center; color: var(--down);
  border: 2px solid var(--down);
}
.done-hero h3 { margin: 0 0 6px; font-size: 17px; color: var(--text); }
.done-hero p { margin: 0; font-size: 12px; line-height: 1.6; }

/* ===== P1 产物面板 ===== */
.panel { display: flex; flex-direction: column; gap: 12px; }
.stat-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
}
.stat {
  border: 1px solid var(--border); border-radius: 9px;
  background: var(--bg-panel); padding: 10px 8px; text-align: center;
}
.stat-v { font-size: 20px; font-weight: 800; color: var(--text); }
.stat-k { font-size: 10.5px; color: var(--text-dim); margin-top: 2px; }
.stat.up .stat-v { color: var(--up); }
.stat.down .stat-v { color: var(--down); }
.stat.gold .stat-v { color: #e8c878; }
.blk { display: flex; flex-direction: column; gap: 6px; }
.blk-t { font-size: 11px; font-weight: 800; color: var(--bc); letter-spacing: 0.5px; }
.ladder { display: flex; flex-wrap: wrap; gap: 6px; }
.lad {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border-light); border-radius: 7px;
  padding: 4px 10px; background: var(--bg-panel); font-size: 11.5px;
}
.lad b { color: var(--text); font-weight: 700; }
.lad i { color: var(--up); font-style: normal; font-weight: 700; }
.theme-list { display: flex; flex-direction: column; gap: 4px; }
.theme-row {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-panel); font-size: 11.5px;
}
.theme-name { font-weight: 700; color: var(--text); min-width: 64px; }
.theme-meta { color: var(--text-dim); }
.theme-leader { margin-left: auto; color: #e8c878; }
.high-scroll { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
.high-chip {
  flex: none; width: 108px; border: 1px solid var(--border-light); border-radius: 9px;
  padding: 8px 9px; background: var(--bg-panel);
}
.hc-name { font-size: 12px; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hc-b { font-size: 12px; font-weight: 800; color: var(--up); margin: 2px 0; }
.hc-sub { font-size: 10px; line-height: 1.5; }

/* 候选池 */
.cand-head { display: flex; align-items: baseline; justify-content: space-between; font-size: 11px; }
.cand-total { font-weight: 800; color: #b07cff; }
.cand-list { display: flex; flex-direction: column; gap: 7px; max-height: 420px; overflow-y: auto; }
.cand-row {
  display: grid; grid-template-columns: 34px minmax(0, 1fr) 78px; gap: 10px;
  border: 1px solid var(--border); border-radius: 9px; padding: 9px 11px;
  background: var(--bg-panel); align-items: center;
}
.cand-row.hot { border-color: color-mix(in srgb, #e8c878 45%, var(--border)); }
.cand-rank { font-size: 13px; font-weight: 800; color: var(--text-dim); text-align: center; }
.cand-line1 { display: flex; align-items: center; gap: 8px; }
.cand-name { font-size: 13px; font-weight: 700; color: var(--text); }
.cand-code { font-size: 10.5px; color: var(--text-dim); }
.cand-board {
  font-size: 10px; font-weight: 700; color: #0a0e14;
  background: var(--up); border-radius: 5px; padding: 1px 6px;
}
.cand-tags { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
.t-tag {
  font-size: 10px; padding: 1px 7px; border-radius: 5px;
  color: #b07cff; background: rgba(176, 124, 255, 0.12);
  border: 1px solid rgba(176, 124, 255, 0.3);
}
.cand-industry { font-size: 10px; color: var(--text-dim); padding: 1px 4px; }
.cand-reason { font-size: 10.5px; line-height: 1.45; }
.cand-score { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.score-num { font-size: 18px; font-weight: 800; color: var(--text-dim); }
.score-num.hot { color: #e8c878; }
.score-bar { width: 60px; height: 4px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; }
.score-fill { height: 100%; background: linear-gradient(90deg, #b07cff, #e8c878); }

/* 作战卡 */
.plan-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.plan-title { font-size: 14px; font-weight: 800; color: var(--text); }
.plan-status { font-size: 10.5px; font-weight: 700; padding: 2px 9px; border-radius: 999px; }
.plan-status.draft { color: #e8c878; border: 1px solid rgba(232, 200, 120, 0.5); }
.plan-status.confirmed { color: var(--down); border: 1px solid rgba(47, 191, 149, 0.5); }
.market-view { border: 1px solid var(--border); border-radius: 9px; background: var(--bg-panel); padding: 10px 12px; }
.mv-tag { font-size: 10px; font-weight: 800; color: var(--bc); margin-bottom: 5px; }
.mv-text { margin: 0; font-size: 12px; line-height: 1.7; color: var(--text); white-space: pre-line; }
.inst-group { display: flex; flex-direction: column; gap: 7px; }
.ig-tag { font-size: 10.5px; font-weight: 800; }
.ig-tag.cand { color: #e8c878; }
.ig-tag.watch { color: var(--text-dim); }
.inst { border: 1px solid var(--border); border-radius: 9px; padding: 9px 11px; background: var(--bg-panel); }
.inst-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.inst-name { font-size: 12.5px; font-weight: 700; color: var(--text); }
.inst-code { font-size: 10.5px; color: var(--text-dim); }
.inst-theme { font-size: 10.5px; color: var(--text-dim); }
.tier-badge { font-size: 10px; font-weight: 700; border-radius: 5px; padding: 1px 7px; }
.tier-badge.cand { color: #0a0e14; background: #e8c878; }
.tier-badge.watch { color: var(--text-dim); background: var(--bg-hover); }
.inst-cond { margin: 6px 0 0; font-size: 11.5px; line-height: 1.6; }
.plan-confirmed-tip {
  display: flex; align-items: center; gap: 8px;
  color: var(--down); font-size: 11.5px;
  border: 1px solid rgba(47, 191, 149, 0.4); background: rgba(47, 191, 149, 0.08);
  border-radius: 9px; padding: 9px 11px;
}

/* 后三步占位 */
.future-tip {
  border: 1px dashed var(--border-light); border-radius: 9px;
  padding: 16px 14px; background: var(--bg-panel);
}
.future-title { font-weight: 800; color: var(--text); margin-bottom: 6px; }
.future-ready { margin: 0; color: var(--down); font-size: 11.5px; line-height: 1.6; }
.future-tip p.dim { margin: 0; font-size: 11.5px; line-height: 1.6; }

/* 作战日志 */
.signal-feed {
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-card2);
  display: flex; flex-direction: column;
  min-width: 0;
}
.sf-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-bottom: 1px solid var(--border);
}
.sf-title { font-weight: 800; color: var(--text); font-size: 12.5px; }
.sf-live { font-size: 10px; color: var(--text-dim); border: 1px solid var(--border); padding: 1px 7px; border-radius: 999px; }
.sf-list { padding: 6px 12px; display: flex; flex-direction: column; }
.sf-row { position: relative; display: flex; gap: 10px; padding: 9px 0; }
.sf-row + .sf-row { border-top: 1px dashed var(--border); }
.sf-time { font-size: 10.5px; color: var(--text-dim); width: 38px; padding-top: 1px; }
.sf-dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; background: var(--border-light); flex: none; }
.sf-row.info .sf-dot { background: #36b8e8; }
.sf-row.up .sf-dot { background: var(--down); }
.sf-row.down .sf-dot { background: var(--down); }
.sf-body { min-width: 0; }
.sf-t { font-size: 12px; font-weight: 700; color: var(--text); }
.sf-d { font-size: 10.5px; line-height: 1.45; margin-top: 2px; }
.sf-foot { padding: 10px 12px; font-size: 10.5px; line-height: 1.5; border-top: 1px solid var(--border); }

@media (max-width: 1100px) {
  .cockpit-body { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .step-bar { grid-template-columns: repeat(3, 1fr); }
  .step-line { display: none; }
  .io-grid { grid-template-columns: 1fr; }
  .io-arrow { transform: rotate(90deg); justify-self: center; }
  .stat-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .step-pulse { animation: none; }
}
</style>
