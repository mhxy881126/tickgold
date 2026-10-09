import { describe, expect, it } from "vitest";
import {
  getTradingPhase,
  isTradingDay,
  tourCardsForPhase,
  phaseAction,
  phaseLabel,
  canOpenNewPosition,
  shouldRunReview,
} from "../../../src/components/spider/tradingDay";

// 基准：2026-10-09 周五 → 2026-10-07 周三、2026-10-10 周六
function wed(h: number, m = 0): Date {
  return new Date(2026, 9, 7, h, m);
}

describe("tradingDay", () => {
  it("周末休市，工作日为交易日", () => {
    expect(isTradingDay(new Date(2026, 9, 10, 10))).toBe(false); // 周六
    expect(getTradingPhase(new Date(2026, 9, 10, 10))).toBe("closed");
    expect(isTradingDay(wed(10))).toBe(true);
  });

  it("各时段判定正确", () => {
    expect(getTradingPhase(wed(7, 0))).toBe("closed");
    expect(getTradingPhase(wed(9, 0))).toBe("pre-market");
    expect(getTradingPhase(wed(9, 20))).toBe("auction");
    expect(getTradingPhase(wed(9, 30))).toBe("open");
    expect(getTradingPhase(wed(10, 0))).toBe("morning");
    expect(getTradingPhase(wed(12, 0))).toBe("midday");
    expect(getTradingPhase(wed(13, 30))).toBe("afternoon");
    expect(getTradingPhase(wed(14, 50))).toBe("close");
    expect(getTradingPhase(wed(15, 20))).toBe("post-market");
    expect(getTradingPhase(wed(20, 0))).toBe("closed");
  });

  it("时段巡回卡片集合正确", () => {
    expect(tourCardsForPhase("morning").length).toBeGreaterThan(10);
    expect(tourCardsForPhase("morning")).toContain("watch");
    expect(tourCardsForPhase("auction")).toContain("auction");
    expect(tourCardsForPhase("post-market")).toContain("review");
    const closedTour = tourCardsForPhase("closed");
    expect(closedTour).toContain("review"); // 休市做复盘研究
    expect(closedTour).toContain("watch");
    expect(closedTour).not.toContain("trade"); // 休市不进交易卡、不交易
  });

  it("开仓门控仅盘中主时段", () => {
    expect(canOpenNewPosition("morning")).toBe(true);
    expect(canOpenNewPosition("afternoon")).toBe(true);
    expect(canOpenNewPosition("open")).toBe(false);
    expect(canOpenNewPosition("close")).toBe(false);
  });

  it("盘后才复盘，时段名与动作文案齐全", () => {
    expect(shouldRunReview("post-market")).toBe(true);
    expect(shouldRunReview("morning")).toBe(false);
    expect(phaseLabel("morning")).toBeTruthy();
    expect(phaseAction("morning")).toBeTruthy();
  });
});
