import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { AlertRule } from "../../../src/api/types";

const { dbMock, startEngine, stopEngine } = vi.hoisted(() => ({
  dbMock: { select: vi.fn(), execute: vi.fn() },
  startEngine: vi.fn(async () => "ok"),
  stopEngine: vi.fn(async () => "stopped"),
}));
vi.mock("../../../src/db/database", () => ({
  db: () => dbMock,
  ensureDb: vi.fn(async () => dbMock),
}));
vi.mock("../../../src/api/market", () => ({
  startAlertEngine: startEngine,
  stopAlertEngine: stopEngine,
}));

import { useAlertStore, newAlertId } from "../../../src/stores/alert";
import type { AlertEvent } from "../../../src/api/market";

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return {
    id: "r1", code: "600519", name: "贵州茅台",
    cooldownSec: 300, enabled: true, ...over,
  };
}
function dbRuleRow(over: Record<string, unknown> = {}) {
  return {
    id: "r1", code: "600519", name: "贵州茅台",
    upPrice: 1800, downPrice: null, upPct: null, downPct: null,
    minVolumeRatio: null, riseSpeed: null, downSpeed: null, speedWindowSec: null,
    minTurnover: null, minAmount: null, sealLimitUp: 1, sealLimitDown: null,
    brokenLimit: null, cooldownSec: null, enabled: 1, lastFiredAt: null, ...over,
  };
}
function alertEvent(over: Partial<AlertEvent> = {}): AlertEvent {
  return {
    time: 100, id: "r1", code: "600519", name: "贵州茅台",
    kind: "price_up", label: "上穿", message: "突破1800",
    price: 1800, pct: 1.2, target: 1800, tone: "up", ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  dbMock.execute.mockResolvedValue({ lastInsertId: undefined, rowsAffected: 1 });
});

describe("alert store", () => {
  it("starts empty and unloaded", () => {
    const s = useAlertStore();
    expect(s.rules).toEqual([]);
    expect(s.loaded).toBe(false);
    expect(s.history).toEqual([]);
    expect(s.historyLoaded).toBe(false);
  });

  it("generates a unique id", () => {
    const a = newAlertId();
    const b = newAlertId();
    expect(a).toMatch(/^a_\d+_[a-z0-9]{5}$/);
    expect(a).not.toBe(b);
  });

  it("loads rules mapping db nulls to undefined and defaults", async () => {
    dbMock.select.mockResolvedValueOnce([dbRuleRow()]);
    const s = useAlertStore();
    await s.load();
    expect(s.loaded).toBe(true);
    const r = s.rules[0];
    expect(r.upPrice).toBe(1800);
    expect(r.downPrice).toBeUndefined();
    expect(r.cooldownSec).toBe(300);
    expect(r.enabled).toBe(true);
    expect(r.sealLimitUp).toBe(true);
    expect(r.sealLimitDown).toBeUndefined();
  });

  it("saves a new rule and starts the engine", async () => {
    const s = useAlertStore();
    await s.save(rule());
    expect(s.rules).toHaveLength(1);
    expect(dbMock.execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO alerts"),
      expect.any(Array)
    );
    expect(startEngine).toHaveBeenCalledWith([rule()]);
  });

  it("updates an existing rule in place", async () => {
    dbMock.select.mockResolvedValueOnce([dbRuleRow()]);
    const s = useAlertStore();
    await s.load();
    const updated = rule({ name: "Maotai", upPrice: 1900 });
    await s.save(updated);
    expect(s.rules).toHaveLength(1);
    expect(s.rules[0].name).toBe("Maotai");
    expect(s.rules[0].upPrice).toBe(1900);
  });

  it("removes a rule and stops the engine when none remain", async () => {
    const s = useAlertStore();
    s.rules.push(rule());
    await s.remove("r1");
    expect(s.rules).toEqual([]);
    expect(dbMock.execute).toHaveBeenCalledWith("DELETE FROM alerts WHERE id=?", ["r1"]);
    expect(stopEngine).toHaveBeenCalled();
  });

  it("toggles a rule enabled state and syncs", async () => {
    const s = useAlertStore();
    const r = rule({ enabled: true });
    s.rules.push(r);
    await s.toggle(r);
    expect(r.enabled).toBe(false);
    expect(dbMock.execute).toHaveBeenCalledWith(
      "UPDATE alerts SET enabled=? WHERE id=?", [0, "r1"]
    );
    expect(stopEngine).toHaveBeenCalled();
  });

  it("marks a rule as fired with the timestamp", async () => {
    const s = useAlertStore();
    s.rules.push(rule());
    await s.markFired("r1", 555);
    expect(s.rules[0].lastFiredAt).toBe(555);
    expect(dbMock.execute).toHaveBeenCalledWith(
      "UPDATE alerts SET last_fired_at=? WHERE id=?", [555, "r1"]
    );
  });

  it("does not prepend an event into history until history is loaded", async () => {
    const s = useAlertStore();
    await s.addEvent(alertEvent());
    expect(s.history).toHaveLength(0);
    expect(dbMock.execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO alert_event"),
      expect.any(Array)
    );
  });

  it("prepends the event once history has been loaded", async () => {
    dbMock.select.mockResolvedValueOnce([]);
    const s = useAlertStore();
    await s.loadHistory();
    await s.addEvent(alertEvent());
    expect(s.history).toHaveLength(1);
    expect(s.history[0]).toMatchObject({
      ruleId: "r1", triggeredAt: 100, tone: "up",
    });
  });

  it("loads history with a limit and clears it", async () => {
    dbMock.select.mockResolvedValueOnce([{ id: 9, triggeredAt: 1 }]);
    const s = useAlertStore();
    await s.loadHistory(50);
    expect(s.historyLoaded).toBe(true);
    expect(s.history[0].id).toBe(9);
    expect(dbMock.select.mock.calls[0][1]).toEqual([50]);

    await s.clearHistory();
    expect(s.history).toEqual([]);
  });

  it("syncEngine stops when no enabled rules", async () => {
    const s = useAlertStore();
    await s.syncEngine();
    expect(stopEngine).toHaveBeenCalled();
    expect(startEngine).not.toHaveBeenCalled();
  });
});
