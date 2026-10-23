// A股交易日历：休市区间（交易所/国务院官方安排，按年维护；周末自动视为休市）
// 2026 数据源口径与 EcoCalendar.vue 原本地常量一致（2026 官方休市区间）。
// 每年更新：新增下一自然年的 HolidaySpan；区间含首尾日期（休市期间通常已含周末）。

export interface HolidaySpan {
  name: string; // 节日名称
  start: string; // 休市起始日 YYYY-MM-DD（含）
  end: string;   // 休市结束日 YYYY-MM-DD（含）
}

export const A_SHARE_HOLIDAYS: HolidaySpan[] = [
  { name: "元旦", start: "2026-01-01", end: "2026-01-03" },
  { name: "春节", start: "2026-02-15", end: "2026-02-23" },
  { name: "清明节", start: "2026-04-04", end: "2026-04-06" },
  { name: "劳动节", start: "2026-05-01", end: "2026-05-05" },
  { name: "端午节", start: "2026-06-19", end: "2026-06-21" },
  { name: "中秋节", start: "2026-09-25", end: "2026-09-27" },
  { name: "国庆节", start: "2026-10-01", end: "2026-10-07" },
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Date -> "YYYY-MM-DD"（本地时区） */
export function dateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 是否处于法定休市区间（不含周末判定，周末由调用方另行处理） */
export function isHoliday(d: Date): boolean {
  const s = dateStr(d);
  return A_SHARE_HOLIDAYS.some((h) => s >= h.start && s <= h.end);
}

/** 命中休市区间的节日名（未命中返回 undefined） */
export function holidayNameOf(d: Date): string | undefined {
  const s = dateStr(d);
  return A_SHARE_HOLIDAYS.find((h) => s >= h.start && s <= h.end)?.name;
}
