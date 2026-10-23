import { describe, it, expect } from "vitest";
import { A_SHARE_HOLIDAYS, isHoliday, holidayNameOf, dateStr } from "../../src/utils/tradingCalendar";
import { isTrading, isCloseWindow, isAuction, isTradingDay } from "../../src/utils/sessions";

describe("tradingCalendar 休市区间（2026 官方口径）", () => {
  it("休市表覆盖主要法定假期", () => {
    const names = A_SHARE_HOLIDAYS.map((h) => h.name);
    expect(names).toContain("元旦");
    expect(names).toContain("春节");
    expect(names).toContain("国庆节");
  });

  it("区间含首尾日期", () => {
    expect(isHoliday(new Date(2026, 0, 1))).toBe(true); // 元旦当天
    expect(isHoliday(new Date(2026, 0, 3))).toBe(true); // 元旦最后一天
    expect(isHoliday(new Date(2026, 1, 17))).toBe(true); // 春节 2/17 初一
    expect(isHoliday(new Date(2026, 9, 7))).toBe(true); // 国庆最后一天
  });

  it("区间外普通工作日不算休市", () => {
    expect(isHoliday(new Date(2026, 2, 10))).toBe(false); // 2026-03-10
    expect(isHoliday(new Date(2026, 5, 10))).toBe(false); // 2026-06-10
  });

  it("holidayNameOf 返回节日名", () => {
    expect(holidayNameOf(new Date(2026, 9, 1))).toBe("国庆节");
    expect(holidayNameOf(new Date(2026, 2, 10))).toBeUndefined();
  });

  it("dateStr 输出 YYYY-MM-DD", () => {
    expect(dateStr(new Date(2026, 9, 23))).toBe("2026-10-23");
  });
});

describe("sessions 交易时段感知休市", () => {
  it("法定休市日盘中不视为交易时段", () => {
    // 2026-10-01 国庆，10:00
    expect(isTrading(new Date(2026, 9, 1, 10, 0))).toBe(false);
    expect(isCloseWindow(new Date(2026, 9, 1, 14, 55))).toBe(false);
    expect(isAuction(new Date(2026, 9, 1, 9, 20))).toBe(false);
  });

  it("工作日盘中正常判定", () => {
    // 2026-10-23 是周五（工作日）
    expect(isTradingDay(new Date(2026, 9, 23))).toBe(true);
    expect(isTrading(new Date(2026, 9, 23, 10, 0))).toBe(true);
    expect(isCloseWindow(new Date(2026, 9, 23, 14, 55))).toBe(true);
  });

  it("周末不交易", () => {
    expect(isTradingDay(new Date(2026, 9, 24))).toBe(false); // 周六
    expect(isTradingDay(new Date(2026, 9, 25))).toBe(false); // 周日
  });
});
