import { describe, it, expect } from "vitest";
import {
  isWeekday,
  isTrading,
  isAuction,
  inQuietRange,
} from "../../../src/utils/sessions";

// 2026-09-27 是周日；2026-09-28 周一
function at(day: number, h: number, m = 0): Date {
  return new Date(2026, 8, day, h, m, 0);
}

describe("isWeekday", () => {
  it("工作日 true，周末 false", () => {
    expect(isWeekday(at(28, 10))).toBe(true); // 周一
    expect(isWeekday(at(27, 10))).toBe(false); // 周日
  });
});

describe("isTrading", () => {
  it("连续竞价时段", () => {
    expect(isTrading(at(28, 10))).toBe(true);
    expect(isTrading(at(28, 9, 30))).toBe(true);
    expect(isTrading(at(28, 14, 0))).toBe(true);
  });
  it("非交易时段", () => {
    expect(isTrading(at(28, 9, 29))).toBe(false);
    expect(isTrading(at(28, 12))).toBe(false);
    expect(isTrading(at(28, 15, 1))).toBe(false);
    expect(isTrading(at(27, 10))).toBe(false); // 周末
  });
});

describe("isAuction", () => {
  it("9:15-9:25", () => {
    expect(isAuction(at(28, 9, 20))).toBe(true);
    expect(isAuction(at(28, 9, 25))).toBe(false);
  });
});

describe("inQuietRange", () => {
  it("当日区间", () => {
    const q = [{ start: "11:30", end: "13:00" }];
    expect(inQuietRange(q, at(28, 12))).toBe(true);
    expect(inQuietRange(q, at(28, 11))).toBe(false);
    expect(inQuietRange(q, at(28, 13))).toBe(false);
  });
  it("跨 0 点区间", () => {
    const q = [{ start: "22:00", end: "08:00" }];
    expect(inQuietRange(q, at(28, 23))).toBe(true);
    expect(inQuietRange(q, at(28, 7))).toBe(true);
    expect(inQuietRange(q, at(28, 12))).toBe(false);
  });
  it("空区间 / 起止相同不静默", () => {
    expect(inQuietRange([], at(28, 12))).toBe(false);
    expect(inQuietRange([{ start: "10:00", end: "10:00" }], at(28, 10))).toBe(false);
  });
});
