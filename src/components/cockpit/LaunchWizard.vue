<script setup lang="ts">
// P5 交易上线向导：三道选择（模拟盘 / 半自动实盘 / 全自动模型接管）。
// 每道都给出风险说明、前置 checklist、故障演练与风控确认；真实武装与限额由后端闸门强制。
import { computed, onMounted, ref } from "vue";
import {
  brainRolloutGet,
  drillRunAll,
  type RolloutView,
  type DrillReport,
} from "../../broker/api";

const emit = defineEmits<{ (e: "close"): void }>();

const step = ref(0);
const path = ref<"paper" | "semi" | "auto" | "">("");
const rollout = ref<RolloutView | null>(null);
const drill = ref<DrillReport | null>(null);
const busy = ref(false);
const err = ref("");
// 人工确认项
const armed = ref(false);
const riskSet = ref(false);
const whitelist = ref(false);
const smallFund = ref(false);
const knowRollback = ref(false);

const PATHS = [
  {
    key: "paper" as const,
    name: "模拟盘 · 零风险",
    tag: "推荐新手",
    color: "#ffb13d",
    desc: "用模拟资金跑完整交易闭环，AI 与规则脑照常工作，但不碰真钱。",
    risk: "零资金风险。用于熟悉流程、观察信号、验证 AI 表现。",
  },
  {
    key: "semi" as const,
    name: "半自动实盘 · 人在回路",
    tag: "小资金起步",
    color: "#36b8e8",
    desc: "AI 出信号、你逐笔确认后才下单；配合白名单、单笔限额、武装闸门。",
    risk: "真实资金，但每笔都需你手动确认。建议先用小资金、白名单运行。",
  },
  {
    key: "auto" as const,
    name: "全自动模型接管",
    tag: "最高风险",
    color: "#f23645",
    desc: "AI 经影子对比、灰度接管后全量自动下单；规则脑兜底，故障自动回退。",
    risk: "真实资金自动交易。必须先影子达标、灰度稳定、演练通过，并长期保留小仓位。",
  },
];

const current = computed(() => PATHS.find((p) => p.key === path.value));

const canNext = computed(() => {
  if (step.value === 0) return path.value !== "";
  if (step.value === 1) {
    if (path.value === "paper") return true;
    if (path.value === "semi")
      return armed.value && riskSet.value && whitelist.value && smallFund.value && !!drill.value?.allPass;
    if (path.value === "auto")
      return (
        armed.value &&
        riskSet.value &&
        knowRollback.value &&
        !!drill.value?.allPass &&
        !!rollout.value?.stats.meetsCanary
      );
  }
  return false;
});

const finishText = computed(() => {
  if (path.value === "paper") return "开始模拟交易（驾驶舱第 ④ 步启动）";
  if (path.value === "semi") return "我已了解，去券商设置武装";
  return "我已了解，去接管控制台灰度推进";
});

async function load() {
  try {
    rollout.value = await brainRolloutGet();
  } catch {
    /* 忽略，向导可离线查看 */
  }
}

async function runDrill() {
  err.value = "";
  busy.value = true;
  try {
    drill.value = await drillRunAll();
  } catch (e) {
    err.value = String(e);
  } finally {
    busy.value = false;
  }
}

function pick(key: "paper" | "semi" | "auto") {
  path.value = key;
  step.value = 1;
}
function back() {
  if (step.value > 0) step.value -= 1;
}
function finish() {
  emit("close");
}

onMounted(load);
</script>

<template>
  <div class="wizard-mask" @click.self="emit('close')">
    <div class="wizard">
      <button class="wz-close" @click="emit('close')">×</button>

      <!-- 步骤指示 -->
      <div class="wz-steps">
        <span :class="step >= 0 ? 'on' : ''">1 选择模式</span>
        <span class="wz-line" />
        <span :class="step >= 1 ? 'on' : ''">2 前置检查</span>
        <span class="wz-line" />
        <span :class="step >= 2 ? 'on' : ''">3 风险确认</span>
      </div>

      <!-- Step 0：三道选择 -->
      <div v-if="step === 0" class="wz-body">
        <h2 class="wz-title">你想怎样让系统参与交易？</h2>
        <p class="wz-sub">三道关卡，风险从低到高。建议从模拟盘开始，稳定后再逐步放权。</p>
        <div class="path-list">
          <div
            v-for="p in PATHS"
            :key="p.key"
            class="path-card"
            :style="{ '--pc': p.color }"
            @click="pick(p.key)"
          >
            <div class="path-tag">{{ p.tag }}</div>
            <div class="path-name">{{ p.name }}</div>
            <div class="path-desc">{{ p.desc }}</div>
            <div class="path-risk">{{ p.risk }}</div>
            <div class="path-go">选择此项 →</div>
          </div>
        </div>
      </div>

      <!-- Step 1：前置检查 -->
      <div v-else-if="step === 1 && current" class="wz-body">
        <h2 class="wz-title" :style="{ color: current.color }">{{ current.name }}</h2>
        <p class="wz-sub">{{ current.desc }}</p>

        <div class="check-block">
          <div class="cb-title">故障演练（模型超时 / 断网 / 客户端崩溃 / 行情陈旧 / 急停）</div>
          <button class="btn-primary" :disabled="busy" @click="runDrill">
            {{ busy ? "演练中…" : drill ? "重新运行演练" : "运行故障演练" }}
          </button>
          <div v-if="drill" class="drill-flash" :class="drill.allPass ? 'ok' : 'fail'">
            {{ drill.allPass ? `✓ 全部 ${drill.passed}/${drill.total} 项通过，系统可降级、可急停、可回退` : `✕ 有 ${drill.total - drill.passed} 项未通过，请先排查` }}
          </div>
          <div v-if="err" class="drill-flash fail">{{ err }}</div>
        </div>

        <!-- 模拟盘 -->
        <div v-if="path === 'paper'" class="check-block">
          <ul class="cb-list">
            <li>模拟通道默认就绪，无需武装、无需真钱。</li>
            <li>可在「券商设置」选择本地模拟或实盘（同花顺客户端）。</li>
            <li>建议先在模型接管控制台开启「影子对比」，观察 AI 与规则脑差异。</li>
          </ul>
        </div>

        <!-- 半自动实盘 -->
        <template v-else-if="path === 'semi'">
          <label class="cb-check"><input type="checkbox" v-model="armed" /> 我已在「券商设置」完成实盘武装（设置单笔限额、单日限额）。</label>
          <label class="cb-check"><input type="checkbox" v-model="riskSet" /> 我已设置单票仓位上限、日亏止损与连续亏损保护。</label>
          <label class="cb-check"><input type="checkbox" v-model="whitelist" /> 我已配置可交易标的白名单（白名单外一律拒绝）。</label>
          <label class="cb-check"><input type="checkbox" v-model="smallFund" /> 我先用可承受的小额资金运行，不追加杠杆。</label>
        </template>

        <!-- 全自动 -->
        <template v-else>
          <div class="cb-status" :class="rollout?.stats.meetsCanary ? 'ok' : 'warn'">
            影子达标：{{ rollout?.stats.samples ?? 0 }} 个样本、一致率 {{ (rollout?.stats.agreePct ?? 0).toFixed(1) }}%
            （需 ≥ {{ rollout?.shadowMinSamples ?? 100 }} 样本且 ≥ {{ rollout?.shadowMinAgreePct ?? 60 }}% 一致）
            → {{ rollout?.stats.meetsCanary ? "达标" : "未达标，请先在接管控制台积累影子样本" }}
          </div>
          <label class="cb-check"><input type="checkbox" v-model="armed" /> 我已完成实盘武装，且理解全自动会真实下单。</label>
          <label class="cb-check"><input type="checkbox" v-model="riskSet" /> 我已设置并复核全部风控参数（仓位 / 日亏 / 限额 / 白名单）。</label>
          <label class="cb-check"><input type="checkbox" v-model="knowRollback" /> 我知道 AI 连续失败 5 次会自动回退规则脑，且我可随时一键回退。</label>
          <div class="cb-tip">建议长期停留在「灰度接管」小比例、小仓位运行，观察足够久再考虑全量，不要急于 100% 交给模型。</div>
        </template>

        <div class="wz-nav">
          <button class="btn-ghost" @click="back">上一步</button>
          <button class="btn-primary" :disabled="!canNext" @click="step = 2">下一步</button>
        </div>
      </div>

      <!-- Step 2：风险确认 -->
      <div v-else class="wz-body">
        <h2 class="wz-title">最后的风险确认</h2>
        <ul class="final-list">
          <li><b>急停随时可用：</b>驾驶舱第 ⑤ 步「一键熔断」与接管控制台「一键回退」会立刻停止新委托。</li>
          <li><b>系统只做辅助：</b>AI 与规则信号都可能出错，最终交易决策与后果由你本人承担。</li>
          <li><b>市场有风险：</b>任何模型都无法保证盈利，历史表现不代表未来收益。</li>
          <li v-if="path !== 'paper'"><b>真实资金：</b>请只用可承受亏损的资金，切勿借贷或加杠杆。</li>
        </ul>
        <div class="wz-nav">
          <button class="btn-ghost" @click="back">上一步</button>
          <button class="btn-primary" @click="finish">{{ finishText }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wizard-mask {
  position: fixed;
  inset: 0;
  background: rgba(4, 8, 13, 0.72);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
  padding: 20px;
}
.wizard {
  position: relative;
  width: min(820px, 96vw);
  max-height: 90vh;
  overflow-y: auto;
  background: #0f161f;
  border: 1px solid #22303f;
  border-radius: 16px;
  padding: 22px 26px;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
}
.wz-close {
  position: absolute;
  top: 14px;
  right: 16px;
  background: transparent;
  border: none;
  color: #7d8a99;
  font-size: 24px;
  cursor: pointer;
  line-height: 1;
}
.wz-close:hover {
  color: #e6edf3;
}
.wz-steps {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #5b6877;
  margin-bottom: 20px;
}
.wz-steps span.on {
  color: #36b8e8;
  font-weight: 700;
}
.wz-line {
  width: 28px;
  height: 1px;
  background: #2a3846;
}
.wz-title {
  font-size: 19px;
  font-weight: 700;
  color: #e6edf3;
  margin: 0 0 6px;
}
.wz-sub {
  font-size: 12.5px;
  color: #8a97a6;
  margin: 0 0 18px;
  line-height: 1.6;
}
.path-list {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.path-card {
  border: 1px solid #243241;
  border-radius: 12px;
  padding: 15px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.02);
  transition: 0.15s;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.path-card:hover {
  border-color: var(--pc);
  transform: translateY(-2px);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.35);
}
.path-tag {
  font-size: 10.5px;
  color: var(--pc);
  border: 1px solid var(--pc);
  border-radius: 20px;
  padding: 1px 9px;
  align-self: flex-start;
  font-weight: 600;
}
.path-name {
  font-size: 15px;
  font-weight: 700;
  color: #e6edf3;
}
.path-desc {
  font-size: 12px;
  color: #b7c2cf;
  line-height: 1.6;
}
.path-risk {
  font-size: 11.5px;
  color: #8a97a6;
  line-height: 1.5;
  border-left: 2px solid var(--pc);
  padding-left: 8px;
}
.path-go {
  margin-top: auto;
  font-size: 12px;
  color: var(--pc);
  font-weight: 600;
}
.check-block {
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid #1f2b39;
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.cb-title {
  font-size: 12.5px;
  font-weight: 600;
  color: #d6dee8;
  margin-bottom: 9px;
}
.cb-list {
  margin: 0;
  padding-left: 18px;
  color: #9fb0c0;
  font-size: 12.5px;
  line-height: 1.9;
}
.cb-check {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  font-size: 12.5px;
  color: #c2ccd8;
  line-height: 1.6;
  margin-bottom: 11px;
  cursor: pointer;
}
.cb-check input {
  margin-top: 2px;
  width: 15px;
  height: 15px;
  accent-color: #36b8e8;
}
.cb-status {
  font-size: 12.5px;
  border-radius: 8px;
  padding: 9px 12px;
  margin-bottom: 12px;
  line-height: 1.6;
}
.cb-status.ok {
  color: #37d67a;
  background: rgba(55, 214, 122, 0.08);
  border: 1px solid rgba(55, 214, 122, 0.3);
}
.cb-status.warn {
  color: #ffb13d;
  background: rgba(255, 177, 61, 0.08);
  border: 1px solid rgba(255, 177, 61, 0.3);
}
.cb-tip {
  font-size: 11.5px;
  color: #ffb13d;
  background: rgba(255, 177, 61, 0.06);
  border-radius: 8px;
  padding: 9px 12px;
  line-height: 1.6;
}
.drill-flash {
  margin-top: 10px;
  font-size: 12.5px;
  border-radius: 8px;
  padding: 8px 11px;
  font-weight: 600;
}
.drill-flash.ok {
  color: #37d67a;
  background: rgba(55, 214, 122, 0.08);
  border: 1px solid rgba(55, 214, 122, 0.28);
}
.drill-flash.fail {
  color: #ff5a6a;
  background: rgba(242, 54, 69, 0.08);
  border: 1px solid rgba(242, 54, 69, 0.28);
}
.btn-primary,
.btn-ghost {
  font-size: 12.5px;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
  border: 1px solid transparent;
}
.btn-primary {
  background: #36b8e8;
  color: #061018;
}
.btn-ghost {
  background: transparent;
  color: #b7c2cf;
  border-color: #2c3a4a;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.wz-nav {
  display: flex;
  justify-content: space-between;
  margin-top: 18px;
}
.final-list {
  margin: 0 0 10px;
  padding-left: 20px;
  color: #b7c2cf;
  font-size: 13px;
  line-height: 2;
}
.final-list b {
  color: #e6edf3;
}
@media (max-width: 720px) {
  .path-list {
    grid-template-columns: 1fr;
  }
}
</style>
