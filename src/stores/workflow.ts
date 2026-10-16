// P0 作战流编排层前端 store：订阅今日 daily_mission、六步状态机推进/重置。
// 真实状态机在 Rust（ai::workflow），前端只负责展示与触发；
// 非 Tauri 环境（浏览器 dev / 后端未就绪）自动降级为本地内存状态，保证驾驶舱交互可独立走查。
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

export type StepStatus = "todo" | "doing" | "done";

export interface StepState {
  key: string;
  status: StepStatus;
  snapshot: string;
  at: number;
}

export interface Mission {
  tradeDate: string;
  currentStep: number;
  stepCount: number;
  allDone: boolean;
  mode: string;
  account: Record<string, unknown>;
  steps: StepState[];
  createdAt: number;
  updatedAt: number;
}

export interface StepMeta {
  key: string;
  index: number;
  title: string;
  short: string;
  input: string;
  output: string;
  action: string;
}

// 六步闭环的唯一文案真相源（前端展示用，状态规则在后端）。
export const STEP_META: StepMeta[] = [
  {
    key: "collect", index: 0, title: "采集", short: "涨停复盘 · 题材催化",
    input: "收盘行情、涨停/炸板、连板梯队、题材催化剂、龙虎榜",
    output: "战场态势包（客观数据聚合）",
    action: "采集完成，开始 AI 分析",
  },
  {
    key: "analyze", index: 1, title: "分析", short: "AI 复盘 · 三战法找潜龙",
    input: "态势包 + 认知知识库 + 互联网当时行情",
    output: "候选池（龙头 / 1进2 / 抄底打分）",
    action: "分析完成，生成作战计划",
  },
  {
    key: "plan", index: 2, title: "计划", short: "作战计划 · 决策文档",
    input: "候选池 + 战法模板（龙头 / 1进2 / 抄底）",
    output: "次日作战卡、触发条件、观察名单",
    action: "计划确认，转入明日盯盘",
  },
  {
    key: "watch", index: 3, title: "盯盘", short: "AI 盯盘 · 快脑信号",
    input: "计划 + 实时行情（快脑毫秒级分类）",
    output: "买 / 卖 / 观察信号（含置信度与理由）",
    action: "盯盘完成，进入风控执行",
  },
  {
    key: "execute", index: 4, title: "执行", short: "信号桥 · 风控闸门 · 下单",
    input: "信号 + 九道风控闸门",
    output: "模拟 / 券商订单与成交、完整审计",
    action: "执行完成，等待成交结果",
  },
  {
    key: "feedback", index: 5, title: "回灌", short: "成交打标 · 进化回灌",
    input: "成交结果、买卖记录与信号",
    output: "自动打标、胜率统计、模型改进建议",
    action: "回灌完成，今日闭环",
  },
];

// P0 账户条占位：P2 起由 broker 真实账户（模拟盘 100 万）覆盖。
export const MOCK_ACCOUNT = {
  modeLabel: "模拟盘",
  totalAsset: 1_000_000,
  cash: 1_000_000,
  marketValue: 0,
  dayPnl: 0,
  dayPnlPct: 0,
  positionPct: 0,
  riskState: "normal" as const,
  killSwitch: false,
};

export interface SignalRow {
  time: string;
  title: string;
  desc: string;
  tone: "muted" | "info" | "up" | "down";
}

// P0 信号流占位：P1/P2 起接真实候选与快脑信号。
export const PLACEHOLDER_SIGNALS: SignalRow[] = [
  { time: "15:05", title: "等待「采集」", desc: "收盘完成第一步后，这里出现战场态势包", tone: "muted" },
  { time: "—", title: "信号流占位", desc: "P0 为流程骨架；P1 起此处推送候选池与快脑信号", tone: "muted" },
  { time: "—", title: "执行链路占位", desc: "P2 起此处实时显示 信号 → 风控 → 成交 全链路", tone: "muted" },
];

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localSteps(current: number): StepState[] {
  return STEP_META.map((m, i) => {
    let status: StepStatus = "todo";
    if (i < current) status = "done";
    else if (i === current) status = "doing";
    return { key: m.key, status, snapshot: "", at: i < current ? Date.now() : 0 };
  });
}

export const useWorkflowStore = defineStore("workflow", () => {
  const mission = ref<Mission | null>(null);
  const loading = ref(false);
  const busy = ref(false);
  const error = ref("");
  const mockMode = ref(false);

  const account = computed(() => {
    const a = mission.value?.account;
    return a && Object.keys(a).length ? { ...MOCK_ACCOUNT, ...a } : { ...MOCK_ACCOUNT };
  });
  const currentStep = computed(() => mission.value?.currentStep ?? 0);
  const allDone = computed(() => mission.value?.allDone ?? false);
  const progressPct = computed(() =>
    Math.round((Math.min(currentStep.value, STEP_META.length) / STEP_META.length) * 100));
  const currentMeta = computed<StepMeta | null>(() =>
    allDone.value ? null : STEP_META[currentStep.value] ?? null);

  function setLocalMission(current: number) {
    const steps = localSteps(current);
    mission.value = {
      tradeDate: todayStr(),
      currentStep: current,
      stepCount: steps.length,
      allDone: current >= steps.length,
      mode: "mock",
      account: {},
      steps,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // 本地兜底推进：与后端 advance_steps 同语义（保留已完成步的快照）。
  function localAdvance(prev: Mission, snapshot?: string): Mission {
    const cur = prev.currentStep;
    const steps = prev.steps.map((x) => ({ ...x }));
    if (cur >= 0 && cur < steps.length) {
      steps[cur].status = "done";
      steps[cur].at = Date.now();
      if (snapshot) steps[cur].snapshot = snapshot;
    }
    if (cur + 1 >= 0 && cur + 1 < steps.length) steps[cur + 1].status = "doing";
    const next = Math.min(cur + 1, steps.length);
    return { ...prev, currentStep: next, allDone: next >= steps.length, steps, updatedAt: Date.now() };
  }

  async function loadToday() {
    loading.value = true;
    error.value = "";
    try {
      mission.value = await invoke<Mission>("workflow_get_today", { tradeDate: todayStr() });
      mockMode.value = false;
    } catch {
      // 浏览器 dev / 后端未就绪：本地内存兜底，保证交互可走查。
      mockMode.value = true;
      if (!mission.value) setLocalMission(0);
    } finally {
      loading.value = false;
    }
  }

  async function advance(snapshot?: string) {
    busy.value = true;
    error.value = "";
    try {
      if (mockMode.value) throw new Error("local-mock");
      mission.value = await invoke<Mission>("workflow_advance", {
        tradeDate: todayStr(),
        snapshot: snapshot ?? null,
      });
    } catch {
      mockMode.value = true;
      if (!mission.value) setLocalMission(0);
      if (mission.value) mission.value = localAdvance(mission.value, snapshot);
    } finally {
      busy.value = false;
    }
  }

  async function reset() {
    busy.value = true;
    error.value = "";
    try {
      if (mockMode.value) throw new Error("local-mock");
      mission.value = await invoke<Mission>("workflow_reset", { tradeDate: todayStr() });
    } catch {
      mockMode.value = true;
      setLocalMission(0);
    } finally {
      busy.value = false;
    }
  }

  return {
    mission,
    loading,
    busy,
    error,
    mockMode,
    account,
    currentStep,
    allDone,
    progressPct,
    currentMeta,
    signals: PLACEHOLDER_SIGNALS,
    stepMeta: STEP_META,
    loadToday,
    advance,
    reset,
  };
});
