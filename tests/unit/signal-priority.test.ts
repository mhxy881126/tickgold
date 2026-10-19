// @vitest-environment node
// 信号优先级纯函数：徽标阈值（80/60 边界）与默认排序（待确认优先 → 置信度降 → 时间降）。
import { describe, it, expect } from "vitest";
import type { SignalTicketInfo } from "../../src/ai/api";
import { priorityOf, sortTickets } from "../../src/components/signalPriority";

function ticket(over: Partial<SignalTicketInfo> & { id: number }): SignalTicketInfo {
  return {
    sigId: `S${over.id}`,
    tradeDate: "2026-10-20",
    createdAt: 0,
    code: "600519",
    name: "贵州茅台",
    side: "BUY",
    source: "test",
    modelVersion: "",
    strategy: "",
    confidence: 0.5,
    refPrice: 10,
    price: 10,
    vol: 100,
    amount: 1000,
    reason: "",
    status: "pending",
    actionKind: "copy",
    broker: "",
    orderText: "",
    decidedBy: "",
    decidedAt: 0,
    ...over,
  };
}

describe("priorityOf: 置信度徽标", () => {
  it("≥0.8 为高", () => {
    expect(priorityOf(0.8)).toEqual({ label: "高", tone: "high" });
    expect(priorityOf(0.95).label).toBe("高");
    expect(priorityOf(1).tone).toBe("high");
  });

  it("0.6 ~ 0.8（不含）为中", () => {
    expect(priorityOf(0.6)).toEqual({ label: "中", tone: "mid" });
    expect(priorityOf(0.79).label).toBe("中");
  });

  it("低于 0.6 为低，非法值降级为低", () => {
    expect(priorityOf(0.599)).toEqual({ label: "低", tone: "low" });
    expect(priorityOf(0).label).toBe("低");
    expect(priorityOf(Number.NaN)).toEqual({ label: "低", tone: "low" });
  });
});

describe("sortTickets: 默认排序", () => {
  it("待确认优先，即使置信度更低、时间更早", () => {
    const confirmed = ticket({ id: 1, status: "confirmed", confidence: 0.99, createdAt: 200 });
    const pending = ticket({ id: 2, status: "pending", confidence: 0.3, createdAt: 100 });
    expect(sortTickets([confirmed, pending]).map((t) => t.id)).toEqual([2, 1]);
  });

  it("同状态按置信度降序", () => {
    const low = ticket({ id: 1, confidence: 0.4, createdAt: 300 });
    const high = ticket({ id: 2, confidence: 0.9, createdAt: 100 });
    const mid = ticket({ id: 3, confidence: 0.7, createdAt: 200 });
    expect(sortTickets([low, high, mid]).map((t) => t.id)).toEqual([2, 3, 1]);
  });

  it("同置信度按时间降序", () => {
    const old = ticket({ id: 1, confidence: 0.9, createdAt: 100 });
    const fresh = ticket({ id: 2, confidence: 0.9, createdAt: 300 });
    const middle = ticket({ id: 3, confidence: 0.9, createdAt: 200 });
    expect(sortTickets([old, fresh, middle]).map((t) => t.id)).toEqual([2, 3, 1]);
  });

  it("不修改入参数组", () => {
    const a = ticket({ id: 1, confidence: 0.2 });
    const b = ticket({ id: 2, confidence: 0.9 });
    const input = [a, b];
    const out = sortTickets(input);
    expect(out).not.toBe(input);
    expect(input.map((t) => t.id)).toEqual([1, 2]);
    expect(out.map((t) => t.id)).toEqual([2, 1]);
  });
});
