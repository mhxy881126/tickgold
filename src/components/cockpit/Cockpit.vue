<script setup lang="ts">
// P0 作战流驾驶舱：账户条 + 六步进度条 + 当前作战卡（输入→产出→主按钮）+ 信号流。
// P0 为编排骨架：状态机真实持久化（Rust daily_mission），账户条/信号流为占位假数据，P1/P2 接入真实引擎。
import { computed, onMounted, ref } from "vue";
import {
  useWorkflowStore,
  STEP_META,
  PLACEHOLDER_SIGNALS,
  type StepState,
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

function selectStep(i: number) {
  selected.value = i;
}
async function doAdvance() {
  await wf.advance();
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
        <span v-if="wf.mockMode" class="mode-badge">演示状态</span>
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

    <!-- 主区域：作战卡 + 信号流 -->
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
          <div class="io-grid">
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

          <div v-if="view.state.status === 'done'" class="snapshot">
            <div class="snap-label">产物快照</div>
            <p class="dim">{{ view.state.snapshot || "P1 / P2 起该步产物将自动写入并在此展示（态势包 / 候选池 / 计划 / 信号 / 订单 / 打标）。" }}</p>
          </div>
          <div v-else-if="isLocked" class="locked-tip">
            <svg viewBox="0 0 24 24" width="15" height="15">
              <path
                fill="currentColor"
                d="M12 1a5 5 0 00-5 5v3H6a2 2 0 00-2 2v9a2 2 0 002 2h12a2 2 0 002-2v-9a2 2 0 00-2-2h-1V6a5 5 0 00-5-5zm-3 8V6a3 3 0 116 0v3H9z"
              />
            </svg>
            <span>未解锁：请先按顺序完成前序步骤</span>
          </div>
        </template>

        <div class="bc-actions">
          <button
            v-if="!wf.allDone && isCurrentView"
            class="btn-primary"
            :disabled="wf.busy"
            @click="doAdvance"
          >
            {{ wf.busy ? "推进中…" : view.action }}
          </button>
          <button class="btn-ghost" :disabled="wf.busy" @click="doReset">
            重置今日流程
          </button>
        </div>
      </section>

      <aside class="signal-feed">
        <div class="sf-head">
          <span class="sf-title">作战信号流</span>
          <span class="sf-live">P0 占位</span>
        </div>
        <div class="sf-list">
          <div v-for="(sig, i) in PLACEHOLDER_SIGNALS" :key="i" class="sf-row" :class="sig.tone">
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
.snapshot {
  border: 1px dashed var(--border-light); border-radius: 9px;
  padding: 10px 12px; background: var(--bg-panel);
}
.snap-label { font-size: 10.5px; color: var(--accent); font-weight: 700; margin-bottom: 4px; }
.snapshot p { margin: 0; font-size: 11.5px; line-height: 1.5; }
.locked-tip {
  display: flex; align-items: center; gap: 8px;
  color: var(--text-dim); font-size: 12px;
  padding: 10px 12px; border: 1px dashed var(--border); border-radius: 9px;
}
.bc-actions { display: flex; gap: 10px; margin-top: 2px; }
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

.done-hero { text-align: center; padding: 14px 8px; }
.done-badge {
  width: 48px; height: 48px; border-radius: 50%; margin: 0 auto 10px;
  display: grid; place-items: center; color: var(--down);
  border: 2px solid var(--down);
}
.done-hero h3 { margin: 0 0 6px; font-size: 17px; color: var(--text); }
.done-hero p { margin: 0; font-size: 12px; line-height: 1.6; }

/* 信号流 */
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
.sf-time { font-size: 10.5px; color: var(--text-dim); width: 34px; padding-top: 1px; }
.sf-dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 5px; background: var(--border-light); flex: none; }
.sf-row.info .sf-dot { background: #36b8e8; }
.sf-row.up .sf-dot { background: var(--up); }
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
}
@media (prefers-reduced-motion: reduce) {
  .step-pulse { animation: none; }
}
</style>
