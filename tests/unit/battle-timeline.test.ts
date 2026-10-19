import { describe, expect, it } from "vitest";
import { computePhase, TIMELINE_SEGMENTS, mmss } from "../../src/components/battle/useBattlePhase";

describe("battle timeline model", () => {
  it("开盘时段：六段、开盘占比 31、进度 1/30、倒计时 29:00", () => {
    const s = computePhase(new Date("2026-10-19T09:31:00+08:00"));
    expect(TIMELINE_SEGMENTS).toHaveLength(6);
    expect(TIMELINE_SEGMENTS.find((x) => x.id === "open")!.grow).toBe(31);
    expect(s.phase.id).toBe("open");
    expect(s.progress).toBeCloseTo(1 / 30, 5);
    expect(mmss(s.nextInSec)).toBe("29:00");
  });

  it("周末无当前段", () => {
    const s = computePhase(new Date("2026-10-24T10:00:00+08:00"));
    expect(s.weekend).toBe(true);
    expect(s.phase.id).toBe("closed");
  });
});
