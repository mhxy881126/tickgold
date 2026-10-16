import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const invokeMock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock.invoke(...a),
}));

import { useWorkflowStore } from "../../../src/stores/workflow";
import type { Mission } from "../../../src/stores/workflow";

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
    invokeMock.invoke.mockResolvedValue(makeMission(2));
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
    expect(s.signals.length).toBeGreaterThan(0);
  });
});
