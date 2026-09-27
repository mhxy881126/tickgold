import { describe, it, expect } from "vitest";
import {
  newGateState,
  checkGate,
  markGateFired,
} from "../../../src/alert/gates";
import type { AlertRuleV2 } from "../../../src/alert/types";
import { defaultActions } from "../../../src/alert/types";

const NOW = new Date(2026, 8, 28, 10, 0, 0).getTime(); // 周一 10:00

function rule(partial: Partial<AlertRuleV2> = {}): AlertRuleV2 {
  return {
    id: "r1",
    name: "规则",
    scope: { kind: "all" },
    tree: { id: "n", op: "AND", children: [] },
    actions: defaultActions(),
    tone: "auto",
    frequency: "persistent",
    cooldownSec: 300,
    quiet: [],
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

describe("checkGate 三道闸", () => {
  it("默认通过", () => {
    expect(checkGate({ rule: rule(), now: NOW, state: newGateState() }).pass).toBe(true);
  });

  it("静默时段拦截", () => {
    const r = rule({ quiet: [{ start: "09:30", end: "11:30" }] });
    const g = checkGate({ rule: r, now: NOW, state: newGateState() });
    expect(g.pass).toBe(false);
    expect(g.reason).toBe("quiet");
  });

  it("冷却期内拦截", () => {
    const state = newGateState();
    markGateFired(state, "r1", NOW);
    const g = checkGate({ rule: rule({ cooldownSec: 300 }), now: NOW + 100_000, state });
    expect(g.pass).toBe(false);
    expect(g.reason).toBe("cooldown");
    // 冷却过后通过
    expect(checkGate({ rule: rule(), now: NOW + 400_000, state }).pass).toBe(true);
  });

  it("once/daily：当日只触发一次", () => {
    const state = newGateState();
    const r = rule({ frequency: "daily" });
    markGateFired(state, "r1", NOW);
    const g = checkGate({ rule: r, now: NOW + 1_000_000, state });
    expect(g.pass).toBe(false);
    expect(g.reason).toBe("frequency");
  });
});
