import { describe, expect, it } from "vitest";
import { computePhase, TIMELINE_SEGMENTS, mmss } from "../../src/components/battle/useBattlePhase";

const at = (iso: string) => computePhase(new Date(iso));

describe("timeline model", () => {
  it("六段、开盘占比 31、倒计时格式化", () => {
    expect(TIMELINE_SEGMENTS).toHaveLength(6);
    expect(TIMELINE_SEGMENTS.find((s) => s.id === "open")!.grow).toBe(31);
    expect(mmss(1740)).toBe("29:00");
    expect(mmss(59)).toBe("00:59");
    expect(mmss(0)).toBe("00:00");
  });
});

describe("computePhase", () => {
  it("盘前：08:59", () => {
    const s = at("2026-10-19T08:59:00+08:00");
    expect(s.phase.id).toBe("premarket");
    expect(s.nextLabel).toBe("集合竞价");
    expect(s.nextInSec).toBe(16 * 60);
  });

  it("竞价：09:15 可撤单，09:20 起不可撤单", () => {
    expect(at("2026-10-19T09:15:00+08:00").phase.id).toBe("auction");
    expect(at("2026-10-19T09:19:59+08:00").subLabel).toBe("可撤单");
    expect(at("2026-10-19T09:20:00+08:00").subLabel).toBe("不可撤单");
    expect(at("2026-10-19T09:29:59+08:00").phase.id).toBe("auction");
  });

  it("开盘：三子段与进度", () => {
    expect(at("2026-10-19T09:30:00+08:00").phase.id).toBe("open");
    expect(at("2026-10-19T09:34:59+08:00").subLabel).toBe("首波");
    expect(at("2026-10-19T09:35:00+08:00").subLabel).toBe("承接");
    expect(at("2026-10-19T09:45:00+08:00").subLabel).toBe("分歧");
    const half = at("2026-10-19T09:45:00+08:00");
    expect(half.progress).toBeCloseTo(0.5, 5);
    expect(half.nextInSec).toBe(15 * 60);
  });

  it("盘中 / 尾盘 / 盘后 / 跨日", () => {
    expect(at("2026-10-19T10:00:00+08:00").phase.id).toBe("midday");
    expect(at("2026-10-19T14:30:00+08:00").phase.id).toBe("close");
    expect(at("2026-10-19T15:00:00+08:00").phase.id).toBe("post");
    expect(at("2026-10-20T00:30:00+08:00").phase.id).toBe("post");
    expect(at("2026-10-20T00:30:00+08:00").nextLabel).toBe("盘前");
  });

  it("周末休市", () => {
    const s = at("2026-10-24T10:00:00+08:00"); // 周六
    expect(s.phase.id).toBe("closed");
    expect(s.weekend).toBe(true);
  });
});
