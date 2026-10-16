// P0 作战流编排层 + P1 盘前闭环（采集→分析→计划）前端 store。
// 真实状态机与引擎在 Rust（ai::workflow / ai::workflow_p1），前端只负责展示与触发；
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
    key: "analyze", index: 1, title: "分析", short: "AI 复盘 · 六战法找潜龙",
    input: "态势包 + 六战法量化引擎（涨停池/涨幅榜/日K）",
    output: "候选池（统一打分排序，含战法与理由）",
    action: "分析完成，生成作战计划",
  },
  {
    key: "plan", index: 2, title: "计划", short: "作战计划 · 决策文档",
    input: "候选池 + 情绪态势（规则引擎，不依赖大模型）",
    output: "次日作战卡、触发条件、观察名单",
    action: "确认作战卡，转入明日盯盘",
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

// 六战法中文标签（与后端 strategy_scan::TACTICS / tactic_label 对齐）。
export const TACTIC_LABEL: Record<string, string> = {
  first_board: "首板",
  multi_board: "连板",
  reversal: "超跌反转",
  weak_to_strong: "弱转强",
  fund_resonance: "资金共振",
  theme_leader: "题材龙头",
};

// ============================ P1 产物类型 ============================

export interface LadderItem { boards: number; count: number }
export interface ThemeItem {
  name: string; count: number; maxBoards: number;
  leader?: { code: string; name: string; boards: number } | null;
}
export interface HighStock {
  code: string; name: string; boards: number; fundYi: number;
  industry: string; firstSeal: number; turnover: number; pct: number; broken: number;
}
export interface Briefing {
  tradeDate: string;
  rawDate?: string;
  limitUp: number;
  broken: number;
  brokenRate: number;
  maxBoards: number;
  ladder: LadderItem[];
  themes: ThemeItem[];
  highStocks: HighStock[];
  degraded?: string[];
  collectedAt?: number;
}

export interface Candidate {
  code: string;
  name: string;
  tactics: string[];
  score: number;
  rank: number;
  boards: number;
  price: number;
  pct: number;
  turnover: number;
  fundYi: number;
  mainNetYi: number;
  industry: string;
  reasons: string[];
  status: string;
}

export interface PlanInstruction {
  id?: number;
  tier: string;
  code: string;
  name: string;
  theme: string;
  condition: string;
  action: string;
  positionHint: string;
  alertRule?: string;
  status?: string;
  sort?: number;
}
export interface BattlePlan {
  id?: number;
  planDate: string;
  title: string;
  marketView: string;
  status: string;
  profileKey?: string;
  model?: string;
  instructions: PlanInstruction[];
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function nextTradeStr(): string {
  const d = new Date();
  const day = d.getDay();
  const add = day === 5 ? 3 : day === 6 ? 2 : 1;
  d.setDate(d.getDate() + add);
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

// ============================ 浏览器 mock 产物（演示用，非真实行情） ============================

const MOCK_BRIEFING: Briefing = {
  tradeDate: todayStr(),
  limitUp: 58,
  broken: 14,
  brokenRate: 19.4,
  maxBoards: 4,
  ladder: [
    { boards: 1, count: 42 },
    { boards: 2, count: 11 },
    { boards: 3, count: 4 },
    { boards: 4, count: 1 },
  ],
  themes: [
    { name: "机器人", count: 9, maxBoards: 4, leader: { code: "300xxx", name: "示例龙头", boards: 4 } },
    { name: "消费电子", count: 7, maxBoards: 3, leader: { code: "002xxx", name: "示例二板", boards: 3 } },
    { name: "算力", count: 6, maxBoards: 2, leader: { code: "600xxx", name: "示例三板", boards: 2 } },
    { name: "光伏", count: 4, maxBoards: 2, leader: null },
  ],
  highStocks: [
    { code: "300xxx", name: "示例龙头", boards: 4, fundYi: 3.8, industry: "机器人", firstSeal: 93502, turnover: 12.4, pct: 10.0, broken: 0 },
    { code: "002xxx", name: "示例二板", boards: 3, fundYi: 2.1, industry: "消费电子", firstSeal: 95810, turnover: 15.1, pct: 10.0, broken: 0 },
    { code: "600xxx", name: "示例三板", boards: 2, fundYi: 1.6, industry: "算力", firstSeal: 101245, turnover: 9.8, pct: 10.0, broken: 1 },
    { code: "301xxx", name: "示例四板", boards: 2, fundYi: 1.2, industry: "机器人", firstSeal: 103500, turnover: 18.2, pct: 10.0, broken: 0 },
  ],
  degraded: [],
  collectedAt: Date.now(),
};

const MOCK_CANDIDATES: Candidate[] = [
  { code: "300xxx", name: "示例龙头", tactics: ["multi_board", "theme_leader", "fund_resonance"], score: 96, rank: 1, boards: 4, price: 18.62, pct: 10.0, turnover: 12.4, fundYi: 3.8, mainNetYi: 2.4, industry: "机器人", reasons: ["四连板市场最高标", "机器人主线涨停 9 家", "封单 3.8 亿、早盘秒板", "主力净流入 2.4 亿"], status: "candidate" },
  { code: "002xxx", name: "示例二板", tactics: ["multi_board", "weak_to_strong"], score: 88, rank: 2, boards: 3, price: 9.84, pct: 10.0, turnover: 15.1, fundYi: 2.1, mainNetYi: 1.3, industry: "消费电子", reasons: ["三连板身位领先", "弱转强快速回封", "换手充分承接强"], status: "candidate" },
  { code: "600xxx", name: "示例三板", tactics: ["multi_board", "fund_resonance"], score: 81, rank: 3, boards: 2, price: 6.37, pct: 10.0, turnover: 9.8, fundYi: 1.6, mainNetYi: 0.9, industry: "算力", reasons: ["二板加速", "主力资金净流入", "板块梯队完整"], status: "candidate" },
  { code: "301xxx", name: "示例四板", tactics: ["first_board", "theme_leader"], score: 74, rank: 4, boards: 2, price: 12.05, pct: 10.0, turnover: 18.2, fundYi: 1.2, mainNetYi: 0.6, industry: "机器人", reasons: ["机器人跟风首板", "题材内联动"], status: "candidate" },
  { code: "000xxx", name: "示例反包", tactics: ["reversal"], score: 68, rank: 5, boards: 1, price: 5.21, pct: 10.0, turnover: 8.6, fundYi: 0.7, mainNetYi: 0.4, industry: "光伏", reasons: ["超跌后放量反包", "低位安全边际"], status: "candidate" },
  { code: "001xxx", name: "示例首板", tactics: ["first_board", "weak_to_strong"], score: 64, rank: 6, boards: 1, price: 7.88, pct: 10.0, turnover: 11.3, fundYi: 0.6, mainNetYi: 0.3, industry: "消费电子", reasons: ["首板突破平台", "分时弱转强"], status: "candidate" },
];

function mockPlan(cands: Candidate[]): BattlePlan {
  const planDate = nextTradeStr();
  const top = cands.slice(0, 6);
  const instructions: PlanInstruction[] = top.map((c, i) => ({
    tier: c.score >= 80 || c.boards >= 3 ? "candidate" : "watch",
    code: c.code,
    name: c.name,
    theme: c.industry,
    condition: `战法：${c.tactics.map((t) => TACTIC_LABEL[t] ?? t).join("、")}；依据：${c.reasons.join("；")}；断板、低开走弱或无量一字则放弃，不追高`,
    action: c.score >= 80 ? "备选待人工确认，是否参与由用户自行决定" : "仅观察，不动作",
    positionHint: "不设仓位指令，确认后转为价格/涨跌幅预警辅助盯盘",
    sort: i,
  }));
  return {
    planDate,
    title: `${planDate} 盘前作战卡`,
    marketView:
      "情绪偏暖（涨停 58 家、炸板率 19%、最高 4 板）。情绪尚可，可围绕主线龙头试错，严格控制仓位。次日总仓位 ≤60%。\n本作战卡由规则引擎基于当日真实涨停池与六战法量化候选生成，仅为客观观察条件与风险提示，不构成投资建议。",
    status: "draft",
    profileKey: "p1-rules",
    model: "rule-based",
    instructions,
  };
}

export const useWorkflowStore = defineStore("workflow", () => {
  const mission = ref<Mission | null>(null);
  const loading = ref(false);
  const busy = ref(false);
  const error = ref("");
  const mockMode = ref(false);

  // P1 产物
  const briefing = ref<Briefing | null>(null);
  const candidates = ref<Candidate[]>([]);
  const battlePlan = ref<BattlePlan | null>(null);
  const planConfirmed = ref(false);
  const alertsCreated = ref(0);

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

  function clearProducts() {
    briefing.value = null;
    candidates.value = [];
    battlePlan.value = null;
    planConfirmed.value = false;
    alertsCreated.value = 0;
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
      await loadProducts();
    } catch {
      // 浏览器 dev / 后端未就绪：本地内存兜底，保证交互可走查。
      mockMode.value = true;
      if (!mission.value) setLocalMission(0);
    } finally {
      loading.value = false;
    }
  }

  // 真实 Tauri：回显当日已产出的态势包/候选池/次日作战卡（次日盘前可见）。
  async function loadProducts() {
    if (mockMode.value) return;
    try {
      const r = await invoke<{
        briefing: Briefing | null;
        candidates: Candidate[];
        plan: BattlePlan | null;
        planConfirmed: boolean;
      }>("workflow_p1_products", { tradeDate: todayStr() });
      const b = r.briefing as Briefing | null;
      briefing.value = b && b.limitUp !== undefined ? b : null;
      candidates.value = r.candidates ?? [];
      battlePlan.value = r.plan ?? null;
      planConfirmed.value = !!r.planConfirmed;
    } catch {
      // 后端尚未具备 P1 或表为空：忽略，保持空态。
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

  // P1 第①步：采集战场态势。
  async function collect() {
    busy.value = true;
    error.value = "";
    try {
      if (mockMode.value) {
        briefing.value = { ...MOCK_BRIEFING, tradeDate: todayStr(), collectedAt: Date.now() };
        if (mission.value) mission.value = localAdvance(mission.value, "战场态势包");
      } else {
        const r = await invoke<{ mission: Mission; briefing: Briefing }>("workflow_collect", {
          tradeDate: todayStr(),
        });
        mission.value = r.mission;
        briefing.value = r.briefing;
      }
    } catch (e) {
      error.value = (e as { message?: string })?.message ?? String(e);
    } finally {
      busy.value = false;
    }
  }

  // P1 第②步：六战法选股 + 打分。
  async function analyze() {
    busy.value = true;
    error.value = "";
    try {
      if (mockMode.value) {
        candidates.value = MOCK_CANDIDATES.map((c) => ({ ...c }));
        if (mission.value) mission.value = localAdvance(mission.value, `候选池 ${candidates.value.length} 只`);
      } else {
        const r = await invoke<{ mission: Mission; candidates: Candidate[]; total: number }>(
          "workflow_analyze",
          { tradeDate: todayStr() },
        );
        mission.value = r.mission;
        candidates.value = r.candidates ?? [];
      }
    } catch (e) {
      error.value = (e as { message?: string })?.message ?? String(e);
    } finally {
      busy.value = false;
    }
  }

  // P1 第③步：生成次日作战卡草稿（不推进）。
  async function planGenerate() {
    busy.value = true;
    error.value = "";
    try {
      if (mockMode.value) {
        battlePlan.value = mockPlan(candidates.value.length ? candidates.value : MOCK_CANDIDATES);
        planConfirmed.value = false;
      } else {
        const r = await invoke<{ mission: Mission; plan: BattlePlan }>("workflow_plan", {
          tradeDate: todayStr(),
        });
        mission.value = r.mission;
        battlePlan.value = r.plan;
        planConfirmed.value = false;
      }
    } catch (e) {
      error.value = (e as { message?: string })?.message ?? String(e);
    } finally {
      busy.value = false;
    }
  }

  // P1 第③步确认：作战卡转预警（入明日盯盘），推进到盯盘步。
  async function planConfirm() {
    busy.value = true;
    error.value = "";
    try {
      if (mockMode.value) {
        const n = battlePlan.value?.instructions.length ?? 0;
        alertsCreated.value = n;
        planConfirmed.value = true;
        if (battlePlan.value) battlePlan.value = { ...battlePlan.value, status: "confirmed" };
        if (mission.value) mission.value = localAdvance(mission.value, `作战卡已转 ${n} 条预警`);
      } else {
        const r = await invoke<{ mission: Mission; plan: BattlePlan; alertsCreated: number }>(
          "workflow_plan_confirm",
          { tradeDate: todayStr() },
        );
        mission.value = r.mission;
        battlePlan.value = r.plan;
        alertsCreated.value = r.alertsCreated ?? 0;
        planConfirmed.value = true;
      }
    } catch (e) {
      error.value = (e as { message?: string })?.message ?? String(e);
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
      clearProducts();
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
    // P1 产物
    briefing,
    candidates,
    battlePlan,
    planConfirmed,
    alertsCreated,
    signals: [] as SignalRow[],
    stepMeta: STEP_META,
    loadToday,
    loadProducts,
    advance,
    collect,
    analyze,
    planGenerate,
    planConfirm,
    reset,
  };
});
