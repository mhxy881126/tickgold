import { describe, it, expect } from "vitest";
import { currentTimeSlot } from "../../src/composables/useWorkbench";

// 函数只依赖时、分，固定一个日期构造，避免日期/星期影响结果
function at(h: number, m: number = 0): Date {
  return new Date(2026, 8, 27, h, m, 0);
}

describe("currentTimeSlot 交易时段判定", () => {
  it("集合竞价 09:15–09:30 → auction", () => {
    expect(currentTimeSlot(at(9, 15))).toBe("auction");
    expect(currentTimeSlot(at(9, 20))).toBe("auction");
    expect(currentTimeSlot(at(9, 29))).toBe("auction");
  });

  it("早盘连续 09:30–11:30 → morning", () => {
    expect(currentTimeSlot(at(9, 30))).toBe("morning");
    expect(currentTimeSlot(at(10, 0))).toBe("morning");
    expect(currentTimeSlot(at(11, 29))).toBe("morning");
  });

  it("午间 11:30–14:30 → midday", () => {
    expect(currentTimeSlot(at(11, 30))).toBe("midday");
    expect(currentTimeSlot(at(13, 0))).toBe("midday");
    expect(currentTimeSlot(at(14, 29))).toBe("midday");
  });

  it("尾盘 14:30–15:00 → tail", () => {
    expect(currentTimeSlot(at(14, 30))).toBe("tail");
    expect(currentTimeSlot(at(14, 45))).toBe("tail");
    expect(currentTimeSlot(at(14, 59))).toBe("tail");
  });

  it("盘前 / 收盘后 / 深夜 → review", () => {
    expect(currentTimeSlot(at(0, 0))).toBe("review");
    expect(currentTimeSlot(at(8, 0))).toBe("review");
    expect(currentTimeSlot(at(15, 0))).toBe("review");
    expect(currentTimeSlot(at(20, 0))).toBe("review");
  });
});
