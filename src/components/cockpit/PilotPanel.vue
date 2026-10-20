<script setup lang="ts">
// P6 一键智驾面板：驾驶舱「一键开始自动交易」入口 + 三问（今天买了什么 / 赚亏多少 / 为什么动）。
// 智驾 = 模拟盘全自动：后端排程器自动完成 盘前(采集→分析→计划→确认) → 盘中盯盘执行 → 收盘回灌。
// 真实通道安全细节（武装/白名单/演练/接管）折叠进「进阶设置」，保持"点一下就跑"的简单体验。
import { computed, onMounted, onUnmounted, ref } from "vue";
import { minuteToHm, RISK_PROFILE_META, type PilotStatus } from "../../ai/pilot";
import { usePilotStore } from "../../stores/pilot";
import { useWorkflowStore } from "../../stores/workflow";
import { brokerLiveUsage, type LiveUsage } from "../../broker/api";
import BrainRolloutPanel from "./BrainRolloutPanel.vue";

const pilot = usePilotStore();
const wf = useWorkflowStore();

onMounted(() => {
  pilot.refresh();
  refreshLiveUsage();
});
onUnmounted(() => {
  pilot.stopPolling();
});

// ===== 展示态 =====
const st = computed(() => pilot.status);
const isRunning = computed(() => pilot.running);
const isOff = computed(() => pilot.mode === "off");
const isPaused = computed(() => pilot.mode === "paused");

const statusText = computed(() => {
  if (pilot.mockMode) return "演示";
  if (isRunning.value) return "运行中";
  if (isPaused.value) return "已暂停";
  return "未启动";
});

const nextText = computed(() =>
  st.value?.nextScanMinute != null ? minuteToHm(st.value.nextScanMinute) : "—",
);

const riskMeta = computed(() =>
  RISK_PROFILE_META[st.value?.riskProfile ?? "steady"],
);

const scanPct = computed(() => {
  const t = st.value?.todayScanTarget ?? 15;
  const c = st.value?.todayScanCount ?? 0;
  return Math.min(100, Math.round((c / Math.max(t, 1)) * 100));
});

// ===== 三问数据 =====
// ① 今天买了什么：今日买入成交（复用 workflow 执行层成交流）
const todayBuys = computed(() =>
  (wf.execStatus?.fills.recent ?? []).filter((f) => f.side === "buy"),
);
const buyCount = computed(
  () => st.value?.today?.buyCount ?? todayBuys.value.length,
);

// ② 赚亏多少：已实现盈亏（分→元）+ 当前资产 + 账户当日盈亏
const pnlYuan = computed(() => (st.value?.today?.pnlCents ?? 0) / 100);
const assetYuan = computed(() => (st.value?.today?.assetCents ?? 0) / 100);
const dayPnl = computed(() => wf.account.dayPnl ?? 0);
const dayPnlPct = computed(() => wf.account.dayPnlPct ?? 0);

// ③ 为什么动：收盘小结 + 最近信号流
const summaryText = computed(
  () => st.value?.today?.summary || wf.feedback?.conclusion || "",
);
const recentSignals = computed(() => wf.execStatus?.signals.recent ?? []);

// ===== 操作 =====
async function doStart() {
  await pilot.start();
  if (!pilot.error) wf.loadToday();
}
async function doPause() {
  await pilot.pause();
}
async function doStop() {
  await pilot.stop();
}

// ===== 进阶设置（仅 mode=off 可编辑；后端同规则） =====
const showSettings = ref(false);
const formRisk = ref<PilotStatus["riskProfile"]>("steady");
const formCash = ref(100_000);
const formScanTarget = ref(15);
const formSchedule = ref(true);
const dirty = ref(false);

// ===== 真实通道与接管（P4/P5 高级能力收敛于此，保持主入口简单） =====
const live = ref<LiveUsage | null>(null);
const liveError = ref("");
const showBrain = ref(false);

async function refreshLiveUsage() {
  try {
    live.value = await brokerLiveUsage();
  } catch {
    live.value = null;
    liveError.value = "非 Tauri 环境：真实通道状态不可用（模拟盘智驾不受影响）";
  }
}

const liveArmedText = computed(() => {
  const l = live.value;
  if (!l) return "—";
  if (l.liveEnabled && l.armedAt > 0) return "已武装";
  return "未武装";
});
const liveArmedClass = computed(() => {
  const l = live.value;
  if (!l) return "idle";
  return l.liveEnabled && l.armedAt > 0 ? "on" : "off";
});
const channelKindText = computed(() => {
  const k = live.value?.kind ?? "";
  if (k.includes("client")) return "实盘";
  return "本地模拟";
});

// ===== 智驾安全红线前置提示：实盘通道下后端会拒绝启动（verify_paper_only），
// 这里提前告知原因并给「去设置切换通道」入口，避免点按钮后才看到报错。=====
const isLiveChannel = computed(() => live.value?.isLive === true);
function goSwitchChannel() {
  window.dispatchEvent(new CustomEvent("open-broker-settings"));
}

function openSettings() {
  showSettings.value = !showSettings.value;
  if (showSettings.value && st.value) {
    formRisk.value = st.value.riskProfile;
    formCash.value = st.value.virtualCash;
    formScanTarget.value = st.value.todayScanTarget;
    formSchedule.value = st.value.scheduleEnabled;
  }
}

function markDirty() {
  dirty.value = true;
}

async function doSaveSettings() {
  await pilot.saveConfig({
    riskProfile: formRisk.value,
    virtualCash: formCash.value,
    todayScanTarget: formScanTarget.value,
    scheduleEnabled: formSchedule.value,
  });
  if (!pilot.error) {
    dirty.value = false;
    showSettings.value = false;
  }
}

function fmtMoney(n: number) {
  return Math.round(n).toLocaleString("zh-CN");
}
function fmtPnl(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}
</script>

<template>
  <section class="pilot-panel" :class="{ running: isRunning, paused: isPaused }">
    <!-- 顶栏：标题 + 状态 + 操作 -->
    <div class="pp-head">
      <div class="pp-title">
        <svg class="pp-ico" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path
            fill="currentColor"
            d="M13 2 4.5 13.5h5L10 22l9.5-11.5h-5L13 2z"
          />
        </svg>
        <span class="pp-name">一键智驾</span>
        <span class="pp-tag">模拟盘全自动</span>
        <span v-if="pilot.mockMode" class="pp-badge">演示数据</span>
      </div>
      <div class="pp-right">
        <span class="pp-status" :class="isRunning ? 'on' : isPaused ? 'paused' : 'idle'">
          <span class="pp-dot" />{{ statusText }}
        </span>
        <button v-if="!isRunning" class="pp-btn solid" :disabled="pilot.busy" @click="doStart">
          {{ pilot.busy ? "启动中…" : "▶ 一键开始智驾" }}
        </button>
        <button v-if="isRunning" class="pp-btn ghost" :disabled="pilot.busy" @click="doPause">暂停</button>
        <button v-if="isRunning || isPaused" class="pp-btn ghost" :disabled="pilot.busy" @click="doStop">停止</button>
      </div>
    </div>

    <!-- 智驾安全红线：实盘通道互斥（后端拒绝启动），提前说明并给切换入口 -->
    <div v-if="isOff && isLiveChannel" class="pp-live-block" data-testid="pilot-live-block">
      <div class="pp-live-block-t">当前为实盘通道：一键智驾仅限模拟盘（安全红线，实盘与智驾互斥）</div>
      <div class="pp-live-block-s">
        智驾会自动买卖，绝不能触碰真实资金。请在「设置 → 券商」把通道切回
        <b>本地模拟</b> 或 <b>同花顺模拟</b> 后，即可一键开始自动交易。
      </div>
      <button type="button" class="pp-btn solid" @click="goSwitchChannel">去设置切换通道</button>
    </div>

    <!-- 主入口 / 运行状态行 -->
    <div v-if="isOff" class="pp-hero">
      <div class="pp-hero-text">
        <div class="pp-hero-title">点一下，自动跑完今天</div>
        <div class="pp-hero-sub">
          盘前自动采集复盘 → 六战法选股 → 生成并确认作战卡；盘中自动盯盘执行；收盘自动结算回灌。
          全程 <b>模拟盘</b>，默认战法 + 默认风控，<b>每日自动盯盘 {{ st?.todayScanTarget ?? 15 }} 次</b>。
        </div>
      </div>
      <button class="pp-start" :disabled="pilot.busy" @click="doStart">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M8 5v14l11-7L8 5z" />
        </svg>
        {{ pilot.busy ? "启动中…" : "一键开始自动交易" }}
      </button>
    </div>

    <div v-else class="pp-run">
      <div class="pp-run-line">
        <span class="pr-cell">
          <span class="pr-k">今日扫描</span>
          <span class="pr-v mono">{{ st?.todayScanCount ?? 0 }} / {{ st?.todayScanTarget ?? 15 }}</span>
          <span class="pr-track"><span class="pr-fill" :style="{ width: scanPct + '%' }" /></span>
        </span>
        <span class="pr-cell">
          <span class="pr-k">下次触发</span>
          <span class="pr-v mono">{{ nextText }}</span>
          <span class="pr-sub">{{ isPaused ? "已暂停排程" : "触发后自动补齐当日闭环" }}</span>
        </span>
        <span class="pr-cell">
          <span class="pr-k">风控档位</span>
          <span class="pr-v">{{ riskMeta.label }}</span>
          <span class="pr-sub dim">{{ riskMeta.desc }}</span>
        </span>
      </div>
      <div v-if="isPaused" class="pp-resume">
        已暂停：排程器已停止，进度保留。点「开始」继续今日闭环，或「停止」结束今日智驾。
      </div>
    </div>

    <p v-if="pilot.error" class="pp-err">{{ pilot.error }}</p>

    <!-- 三问：买了什么 / 赚亏多少 / 为什么动 -->
    <div v-if="!isOff || st?.today?.scanCount" class="pp-questions">
      <div class="pp-q">
        <div class="pp-q-head">
          <span class="pp-q-no">①</span>
          <span class="pp-q-t">今天买了什么</span>
          <span class="pp-q-meta mono">{{ buyCount }} 笔</span>
        </div>
        <div v-if="todayBuys.length" class="pp-q-list">
          <div v-for="(f, i) in todayBuys" :key="'b' + i" class="pp-q-row">
            <span class="up">{{ f.name }}</span>
            <span class="mono dim">{{ f.code }}</span>
            <span class="mono dim">{{ f.price.toFixed(2) }} × {{ f.vol }}</span>
            <span class="mono">{{ fmtMoney(f.amount) }} 元</span>
          </div>
        </div>
        <div v-else class="pp-q-empty dim">
          {{ isOff ? "尚未开始智驾：启动后自动买入选中的作战标的" : "今日暂无买入成交（或还未到买入触发点）" }}
        </div>
      </div>

      <div class="pp-q">
        <div class="pp-q-head">
          <span class="pp-q-no">②</span>
          <span class="pp-q-t">赚亏多少</span>
          <span class="pp-q-meta mono" :class="pnlYuan >= 0 ? 'up' : 'down'">{{ fmtPnl(pnlYuan) }} 元</span>
        </div>
        <div class="pp-q-stats">
          <div class="pqs-cell">
            <span class="pqs-k">当前资产</span>
            <span class="pqs-v mono">{{ fmtMoney(assetYuan) }} 元</span>
          </div>
          <div class="pqs-cell">
            <span class="pqs-k">账户当日盈亏</span>
            <span class="pqs-v mono" :class="dayPnl >= 0 ? 'up' : 'down'">
              {{ fmtPnl(dayPnl) }} 元（{{ dayPnlPct.toFixed(2) }}%）
            </span>
          </div>
          <div class="pqs-cell">
            <span class="pqs-k">虚拟资金</span>
            <span class="pqs-v mono">{{ fmtMoney(st?.virtualCash ?? 100000) }} 元</span>
          </div>
        </div>
      </div>

      <div class="pp-q wide">
        <div class="pp-q-head">
          <span class="pp-q-no">③</span>
          <span class="pp-q-t">为什么动</span>
          <span class="pp-q-meta">{{ recentSignals.length ? recentSignals.length + " 条信号" : "等待信号" }}</span>
        </div>
        <p v-if="summaryText" class="pp-q-summary">{{ summaryText }}</p>
        <div v-if="recentSignals.length" class="pp-q-list">
          <div v-for="(g, i) in recentSignals" :key="'s' + i" class="pp-q-row">
            <span class="mono dim">{{ g.ts }}</span>
            <span>{{ g.name }}<span class="mono dim">{{ g.code }}</span></span>
            <span class="mono dim">{{ g.label === "-1" ? "卖出" : g.label === "1" ? "买入" : "观望" }}</span>
            <span class="mono dim">{{ (g.confidence * 100).toFixed(0) }}%</span>
          </div>
        </div>
        <div v-else-if="!summaryText" class="pp-q-empty dim">
          信号与小结会在盯盘执行与收盘回灌后自动汇总到这里。
        </div>
      </div>
    </div>

    <!-- 进阶设置（折叠）：智驾参数 + 真实通道安全细节都藏在这里，保持主入口简单 -->
    <div class="pp-settings">
      <button class="pp-fold" @click="openSettings">
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 15.5 4 7.5 5.4 6.1l6.6 6.6 6.6-6.6 1.4 1.4-8 8z"
          />
        </svg>
        <span>进阶设置</span>
        <span class="dim">风控档位 / 虚拟资金 / 调度 / 真实通道与接管</span>
      </button>
      <div v-if="showSettings" class="pp-form">
        <div class="pp-form-grid">
          <label class="pp-field">
            <span class="pp-f-label">风控档位</span>
            <div class="pp-seg">
              <button
                v-for="(meta, key) in RISK_PROFILE_META"
                :key="key"
                class="pp-seg-btn"
                :class="{ active: formRisk === key }"
                :disabled="!isOff"
                @click="formRisk = key; markDirty()"
              >
                {{ meta.label }}
              </button>
            </div>
            <span class="pp-f-hint dim">{{ RISK_PROFILE_META[formRisk].desc }}</span>
          </label>
          <label class="pp-field">
            <span class="pp-f-label">虚拟资金（元）</span>
            <input
              v-model.number="formCash"
              type="number"
              min="1"
              step="1000"
              class="pp-input mono"
              :disabled="!isOff"
              @input="markDirty"
            />
          </label>
          <label class="pp-field">
            <span class="pp-f-label">每日自动盯盘次数（1–20）</span>
            <input
              v-model.number="formScanTarget"
              type="number"
              min="1"
              max="20"
              class="pp-input mono"
              :disabled="!isOff"
              @input="markDirty"
            />
          </label>
          <label class="pp-field pp-check">
            <span class="pp-f-label">启用自动排程</span>
            <input
              v-model="formSchedule"
              type="checkbox"
              class="pp-cbx"
              :disabled="!isOff"
              @change="markDirty"
            />
          </label>
        </div>
        <div class="pp-form-foot">
          <span v-if="!isOff" class="dim">运行 / 暂停中不可修改，请先「停止」。</span>
          <button v-else class="pp-btn solid" :disabled="pilot.busy || !dirty" @click="doSaveSettings">
            {{ pilot.busy ? "保存中…" : "保存智驾设置" }}
          </button>
        </div>

        <!-- 真实通道与接管（高级）：武装 / 白名单 / 演练 / 接管收敛入口 -->
        <div class="pp-live">
          <div class="pp-live-head">
            <span class="pp-live-title">真实通道与接管</span>
            <span class="pp-live-note dim">智驾本身仅限模拟盘；接真实券商需在此完成武装</span>
          </div>

          <div class="pp-live-status">
            <div class="pls-cell">
              <span class="pls-k">通道</span>
              <span class="pls-v">{{ live ? channelKindText : "—" }}</span>
            </div>
            <div class="pls-cell">
              <span class="pls-k">武装状态</span>
              <span class="pls-v" :class="liveArmedClass">{{ liveArmedText }}</span>
            </div>
            <div class="pls-cell">
              <span class="pls-k">模拟演练</span>
              <span class="pls-v" :class="live?.drillPassed ? 'on' : 'idle'">
                {{ live ? (live.drillPassed ? "已通过" : "未演练") : "—" }}
              </span>
            </div>
            <div class="pls-cell" v-if="live?.liveEnabled">
              <span class="pls-k">今日额度</span>
              <span class="pls-v mono">{{ fmtMoney(live.remaining) }} / {{ fmtMoney(live.dailyLimit) }}</span>
            </div>
          </div>

          <p v-if="liveError" class="pp-live-err dim">{{ liveError }}</p>

          <div class="pp-live-actions">
            <button class="pp-btn ghost" :disabled="pilot.busy" @click="showBrain = !showBrain">
              {{ showBrain ? "收起接管控制台" : "打开接管控制台" }}
            </button>
            <span class="pp-live-hint dim">含上线向导（武装/白名单）、故障演练、影子→灰度→接管</span>
          </div>

          <BrainRolloutPanel v-if="showBrain" />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pilot-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: linear-gradient(180deg, var(--bg-card), var(--bg-card2));
}
.pilot-panel.running { border-color: color-mix(in srgb, var(--down) 55%, transparent); }
.pilot-panel.paused { border-color: color-mix(in srgb, #e8c878 45%, transparent); }

.mono { font-family: "JetBrains Mono", Consolas, monospace; }
.dim { color: var(--text-dim); }
.up { color: var(--up); }
.down { color: var(--down); }

/* 顶栏 */
.pp-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.pp-title { display: flex; align-items: center; gap: 8px; }
.pp-ico { color: var(--accent); }
.pp-name { font-size: 14.5px; font-weight: 800; color: var(--text); }
.pp-tag {
  font-size: 10.5px; padding: 2px 8px; border-radius: 999px;
  color: var(--down); border: 1px solid color-mix(in srgb, var(--down) 45%, transparent);
  background: color-mix(in srgb, var(--down) 8%, transparent);
}
.pp-badge {
  font-size: 10px; padding: 1px 7px; border-radius: 999px;
  color: #e8c878; border: 1px solid color-mix(in srgb, #e8c878 45%, transparent);
}
.pp-right { display: flex; align-items: center; gap: 8px; }
.pp-status {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 999px;
  border: 1px solid var(--border-light); color: var(--text-dim);
}
.pp-status .pp-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-dim); }
.pp-status.on { color: var(--down); border-color: var(--down); }
.pp-status.on .pp-dot { background: var(--down); box-shadow: 0 0 8px var(--down); animation: ppblink 1.6s ease-in-out infinite; }
.pp-status.paused { color: #e8c878; border-color: #e8c878; }
.pp-status.paused .pp-dot { background: #e8c878; }
.pp-status.idle .pp-dot { background: var(--text-dim); }
@keyframes ppblink { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

/* 主按钮 */
.pp-hero { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.pp-hero-text { flex: 1; min-width: 0; }
.pp-hero-title { font-size: 15px; font-weight: 800; color: var(--text); margin-bottom: 4px; }
.pp-hero-sub { font-size: 11.5px; color: var(--text-dim); line-height: 1.6; }
.pp-start {
  flex: none;
  display: inline-flex; align-items: center; gap: 7px;
  padding: 12px 18px; border-radius: 10px; cursor: pointer;
  font-size: 13.5px; font-weight: 800; color: #0a0e14;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #fff));
  border: none;
  transition: filter 0.15s, transform 0.05s;
}
.pp-start:hover { filter: brightness(1.08); }
.pp-start:active { transform: translateY(1px); }
.pp-start:disabled { opacity: 0.55; cursor: not-allowed; }

/* 运行状态行 */
.pp-run { display: flex; flex-direction: column; gap: 8px; }
.pp-run-line { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.pr-cell {
  display: flex; flex-direction: column; gap: 3px;
  border: 1px solid var(--border); border-radius: 9px; padding: 9px 11px;
  background: var(--bg-panel);
}
.pr-k { font-size: 10px; color: var(--text-dim); }
.pr-v { font-size: 14px; font-weight: 800; color: var(--text); }
.pr-sub { font-size: 10px; color: var(--text-dim); }
.pr-track { height: 4px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; margin-top: 4px; }
.pr-fill { height: 100%; border-radius: 999px; background: var(--down); }
.pp-resume {
  font-size: 11.5px; line-height: 1.6; color: #e8c878;
  border: 1px dashed color-mix(in srgb, #e8c878 45%, transparent);
  border-radius: 8px; padding: 7px 11px; background: color-mix(in srgb, #e8c878 6%, transparent);
}

.pp-btn {
  padding: 7px 13px; border-radius: 8px; cursor: pointer;
  font-size: 12px; font-weight: 700;
  transition: background 0.15s;
}
.pp-btn.ghost { color: var(--text); background: transparent; border: 1px solid var(--border-light); }
.pp-btn.ghost:hover { background: var(--bg-hover); }
.pp-btn.solid {
  color: #0a0e14; border: none;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #fff));
}
.pp-btn:disabled { opacity: 0.55; cursor: not-allowed; }

.pp-err {
  margin: 0; color: var(--up); font-size: 11.5px;
  border: 1px solid rgba(255, 77, 106, 0.35); background: rgba(255, 77, 106, 0.08);
  border-radius: 8px; padding: 7px 10px;
}

/* 智驾安全红线提示条 */
.pp-live-block {
  display: flex; flex-direction: column; gap: 7px;
  border: 1px solid rgba(232, 200, 120, .45);
  border-radius: 9px;
  background: linear-gradient(135deg, rgba(232, 200, 120, .10), rgba(232, 200, 120, .03));
  padding: 10px 12px;
}
.pp-live-block-t { font-size: 12px; font-weight: 800; color: #e8c878; }
.pp-live-block-s { font-size: 11.5px; line-height: 1.6; color: var(--text-dim); }
.pp-live-block-s b { color: var(--text); }
.pp-live-block .pp-btn { align-self: flex-start; }

/* 三问 */
.pp-questions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.pp-q {
  display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--border); border-radius: 9px; padding: 10px 12px;
  background: var(--bg-panel);
}
.pp-q.wide { grid-column: 1 / -1; }
.pp-q-head { display: flex; align-items: baseline; gap: 7px; }
.pp-q-no { font-size: 11px; font-weight: 800; color: var(--accent); }
.pp-q-t { font-size: 12.5px; font-weight: 800; color: var(--text); }
.pp-q-meta { margin-left: auto; font-size: 11px; color: var(--text-dim); }
.pp-q-list { display: flex; flex-direction: column; gap: 5px; max-height: 150px; overflow-y: auto; }
.pp-q-row {
  display: flex; align-items: center; gap: 9px;
  font-size: 11.5px; color: var(--text);
  padding: 4px 0; border-bottom: 1px dashed var(--border);
}
.pp-q-row:last-child { border-bottom: none; }
.pp-q-row .mono { font-size: 10.5px; }
.pp-q-row > span:last-child { margin-left: auto; }
.pp-q-empty { font-size: 11.5px; line-height: 1.55; padding: 4px 0; }
.pp-q-summary {
  margin: 0; font-size: 11.5px; line-height: 1.65; color: var(--text);
  border-left: 2px solid var(--accent); padding-left: 10px;
}
.pp-q-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.pqs-cell { display: flex; flex-direction: column; gap: 3px; }
.pqs-k { font-size: 10px; color: var(--text-dim); }
.pqs-v { font-size: 12.5px; font-weight: 700; color: var(--text); }

/* 进阶设置 */
.pp-settings { display: flex; flex-direction: column; gap: 6px; }
.pp-fold {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 5px 8px; border-radius: 8px; cursor: pointer;
  font-size: 11px; font-weight: 600; color: var(--text-dim);
  background: transparent; border: 1px dashed var(--border);
  transition: background 0.15s, color 0.15s;
}
.pp-fold:hover { background: var(--bg-hover); color: var(--text); }
.pp-form {
  border: 1px solid var(--border); border-radius: 9px; padding: 11px 12px;
  background: var(--bg-panel);
}
.pp-form-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 11px; }
.pp-field { display: flex; flex-direction: column; gap: 6px; }
.pp-f-label { font-size: 10.5px; font-weight: 700; color: var(--text-dim); }
.pp-f-hint { font-size: 10.5px; line-height: 1.5; }
.pp-input {
  padding: 7px 10px; border-radius: 8px; font-size: 12.5px;
  color: var(--text); background: var(--bg-card); border: 1px solid var(--border-light);
}
.pp-input:disabled { opacity: 0.55; }
.pp-seg { display: flex; gap: 6px; }
.pp-seg-btn {
  flex: 1; padding: 7px 0; border-radius: 8px; cursor: pointer;
  font-size: 12px; font-weight: 700; color: var(--text-dim);
  background: var(--bg-card); border: 1px solid var(--border-light);
  transition: all 0.15s;
}
.pp-seg-btn.active {
  color: #0a0e14; border-color: var(--accent);
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #fff));
}
.pp-seg-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.pp-cbx { width: 16px; height: 16px; accent-color: var(--accent); }
.pp-form-foot { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 10px; }

/* 真实通道与接管（高级收敛区） */
.pp-live {
  margin-top: 12px; padding-top: 12px;
  border-top: 1px dashed var(--border);
  display: flex; flex-direction: column; gap: 10px;
}
.pp-live-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.pp-live-title { font-size: 12px; font-weight: 800; color: var(--text); }
.pp-live-note { font-size: 10px; }
.pp-live-status {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
}
.pls-cell {
  display: flex; flex-direction: column; gap: 3px;
  border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px;
  background: var(--bg-card);
}
.pls-k { font-size: 10px; color: var(--text-dim); }
.pls-v { font-size: 12.5px; font-weight: 700; color: var(--text); }
.pls-v.on { color: var(--down); }
.pls-v.off { color: #e8c878; }
.pls-v.idle { color: var(--text-dim); }
.pp-live-err { margin: 0; font-size: 10.5px; line-height: 1.5; }
.pp-live-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pp-live-hint { font-size: 10.5px; line-height: 1.5; }

@media (max-width: 860px) {
  .pp-questions { grid-template-columns: 1fr; }
  .pp-run-line { grid-template-columns: 1fr; }
  .pp-form-grid { grid-template-columns: 1fr; }
  .pp-live-status { grid-template-columns: 1fr 1fr; }
  .pp-hero { flex-direction: column; align-items: stretch; }
}
</style>
