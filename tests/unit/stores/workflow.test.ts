import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const invokeMock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock.invoke(...a),
}));

import { useWorkflowStore } from "../../../src/stores/workflow";
import type { Mission, Briefing } from "../../../src/stores/workflow";

const KEYS = ["collect", "analyze", "plan", "watch", "execute", "feedback"];

function makeMission(currentStep: number): Mission {
  const steps = KEYS.map((key, i) => {
    let status: "todo" | "doing" | "done" = "todo";
    if (i < currentStep) status = "done";
    else if (i === currentStep) status = "doing";
    return { key, status, snapshot: "", at: i < currentStep ? 1 : 0 };
  });
  return {
    tradeDate: "2026-10-16",
    currentStep,
    stepCount: 6,
    allDone: currentStep >= 6,
    mode: "mock",
    account: {},
    steps,
    createdAt: 1,
    updatedAt: 1,
  };
}

const emptyProducts = { briefing: null, candidates: [], plan: null, planConfirmed: false };
const emptyP2Products = { feedback: null, running: false, killSwitch: false };

beforeEach(() => {
  vi.resetAllMocks();
  setActivePinia(createPinia());
});

describe("workflow store", () => {
  it("falls back to local mock when the backend command is unavailable", async () => {
    invokeMock.invoke.mockRejectedValue(new Error("not in tauri"));
    const s = useWorkflowStore();
    await s.loadToday();

    expect(s.mockMode).toBe(true);
    expect(s.currentStep).toBe(0);
    expect(s.allDone).toBe(false);
    expect(s.mission?.steps[0].status).toBe("doing");
    expect(s.mission?.steps.slice(1).every((x) => x.status === "todo")).toBe(true);
  });

  it("uses backend data when the command resolves", async () => {
    invokeMock.invoke
      .mockResolvedValueOnce(makeMission(2))
      .mockResolvedValueOnce(emptyProducts)
      .mockResolvedValueOnce(emptyP2Products);
    const s = useWorkflowStore();
    await s.loadToday();

    expect(s.mockMode).toBe(false);
    expect(s.currentStep).toBe(2);
    expect(invokeMock.invoke).toHaveBeenCalledWith("workflow_get_today", expect.objectContaining({
      tradeDate: expect.any(String),
    }));
  });

  it("walks the six steps strictly in order via local fallback", async () => {
    invokeMock.invoke.mockRejectedValue(new Error("offline"));
    const s = useWorkflowStore();
    await s.loadToday();

    for (let i = 0; i < 6; i++) {
      // 每一步推进前：当前步 doing，后续步 todo，保证不可跳步。
      expect(s.mission?.steps[i].status).toBe("doing");
      // 推进命令携带 camelCase 参数。
      await s.advance(i === 0 ? "战场态势包" : undefined);
      expect(s.currentStep).toBe(i + 1);
      expect(s.mission?.steps[i].status).toBe("done");
      if (i + 1 < 6) expect(s.mission?.steps[i + 1].status).toBe("doing");
    }

    expect(s.allDone).toBe(true);
    expect(s.progressPct).toBe(100);
    // 快照写入第一步。
    expect(s.mission?.steps[0].snapshot).toBe("战场态势包");
  });

  it("passes the snapshot through to the backend advance command", async () => {
    invokeMock.invoke
      .mockResolvedValueOnce(makeMission(0))
      .mockResolvedValueOnce(emptyProducts)
      .mockResolvedValueOnce(emptyP2Products)
      .mockResolvedValueOnce(makeMission(1));
    const s = useWorkflowStore();
    await s.loadToday();
    await s.advance("候选池");

    expect(invokeMock.invoke).toHaveBeenLastCalledWith(
      "workflow_advance",
      expect.objectContaining({ snapshot: "候选池" }),
    );
  });

  it("resets the local mission back to the first step", async () => {
    invokeMock.invoke.mockRejectedValue(new Error("offline"));
    const s = useWorkflowStore();
    await s.loadToday();
    await s.advance();
    await s.advance();
    expect(s.currentStep).toBe(2);

    await s.reset();
    expect(s.currentStep).toBe(0);
    expect(s.allDone).toBe(false);
    expect(s.mission?.steps[0].status).toBe("doing");
    expect(s.mission?.steps.slice(1).every((x) => x.status === "todo")).toBe(true);
  });

  it("exposes the six-step metadata and placeholder account", () => {
    const s = useWorkflowStore();
    expect(s.stepMeta.map((m) => m.key)).toEqual(KEYS);
    expect(s.account.totalAsset).toBe(1_000_000);
    // P1 产物初始为空。
    expect(s.candidates).toEqual([]);
    expect(s.battlePlan).toBeNull();
    expect(s.planConfirmed).toBe(false);
  });

  it("P1 drives collect -> analyze -> plan -> confirm via local mock", async () => {
    invokeMock.invoke.mockRejectedValue(new Error("offline"));
    const s = useWorkflowStore();
    await s.loadToday();
    expect(s.currentStep).toBe(0);

    // ① 采集：产出态势包，推进到分析。
    await s.collect();
    expect(s.currentStep).toBe(1);
    expect(s.briefing?.limitUp).toBeGreaterThan(0);
    expect(s.briefing?.highStocks.length).toBeGreaterThan(0);

    // ② 分析：候选池按分数降序，推进到计划。
    await s.analyze();
    expect(s.currentStep).toBe(2);
    expect(s.candidates.length).toBeGreaterThan(0);
    const scores = s.candidates.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    // ③ 生成作战卡草稿：不推进、待确认。
    await s.planGenerate();
    expect(s.currentStep).toBe(2);
    expect(s.battlePlan?.instructions.length).toBeGreaterThan(0);
    expect(s.planConfirmed).toBe(false);

    // ③ 确认：转预警、推进到盯盘步。
    const n = s.battlePlan?.instructions.length ?? 0;
    await s.planConfirm();
    expect(s.currentStep).toBe(3);
    expect(s.planConfirmed).toBe(true);
    expect(s.alertsCreated).toBe(n);
  });

  it("P1 calls the real collect command and hydrates the briefing", async () => {
    const briefing: Briefing = {
      tradeDate: "2026-10-16",
      limitUp: 61,
      broken: 9,
      brokenRate: 12.9,
      maxBoards: 5,
      ladder: [{ boards: 1, count: 40 }],
      themes: [],
      highStocks: [],
    };
    invokeMock.invoke
      .mockResolvedValueOnce(makeMission(0))
      .mockResolvedValueOnce(emptyProducts)
      .mockResolvedValueOnce(emptyP2Products)
      .mockResolvedValueOnce({ mission: makeMission(1), briefing });
    const s = useWorkflowStore();
    await s.loadToday();
    await s.collect();

    expect(s.mockMode).toBe(false);
    expect(s.currentStep).toBe(1);
    expect(s.briefing?.limitUp).toBe(61);
    expect(invokeMock.invoke).toHaveBeenCalledWith(
      "workflow_collect",
      expect.objectContaining({ tradeDate: expect.any(String) }),
    );
  });

  it("P1 resets clear produced artifacts", async () => {
    invokeMock.invoke.mockRejectedValue(new Error("offline"));
    const s = useWorkflowStore();
    await s.loadToday();
    await s.collect();
    await s.analyze();
    expect(s.candidates.length).toBeGreaterThan(0);

    await s.reset();
    expect(s.briefing).toBeNull();
    expect(s.candidates).toEqual([]);
    expect(s.battlePlan).toBeNull();
    expect(s.planConfirmed).toBe(false);
  });

  it("P2 drives watch -> execute -> feedback closed loop via local mock", async () => {
    invokeMock.invoke.mockRejectedValue(new Error("offline"));
    const s = useWorkflowStore();
    await s.loadToday();

    // 先走到第④步盯盘（collect/analyze/planConfirm 各推进一步）。
    await s.collect();
    await s.analyze();
    await s.planGenerate();
    await s.planConfirm();
    expect(s.currentStep).toBe(3);

    // ④ 启动盯盘：进入执行，运行态开启。
    await s.watchStart();
    expect(s.currentStep).toBe(4);
    expect(s.watchStarted).toBe(true);
    expect(s.running).toBe(true);

    // ⑤ 消费完全部脚本事件（8 信号：5 成交 / 3 观察；3 买 2 卖）。
    for (let i = 0; i < 10; i++) await s.refreshExec();
    expect(s.execStatus?.signals.total).toBe(8);
    expect(s.execStatus?.signals.executed).toBe(5);
    expect(s.execStatus?.signals.observe).toBe(3);
    expect(s.execStatus?.fills.total).toBe(5);
    expect(s.execStatus?.fills.buy).toBe(3);
    expect(s.execStatus?.fills.sell).toBe(2);
    expect(s.execStatus?.fills.realizedPnl).toBe(50);
    expect(s.execStatus?.fills.winRate).toBe(50);

    // 一键熔断真实生效（运行态停止）。
    await s.emergencyHalt();
    expect(s.killSwitch).toBe(true);
    expect(s.running).toBe(false);

    // ⑥ 收盘结算：两步闭环，产出当日作战小结。
    await s.feedbackClose();
    expect(s.allDone).toBe(true);
    expect(s.feedback).not.toBeNull();
    expect(s.feedback?.killSwitch).toBe(true);
    expect(s.feedback?.conclusion).toContain("紧急停止");
  });
});
