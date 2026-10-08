// 交易时间 X 轴：让底部刻度严格对齐 A 股标准时刻（整点 / 半小时），
// 而不是 klinecharts 默认按 bar index 均匀采样——后者在午休（11:30→13:00 只跳 1 个 index）
// 之后会把下午刻度错标成 13:59 / 14:29 / 14:59。
//
// 一个页面可能有多个 chart（主图 + 复盘弹窗），createTicks 是各 chart 独立调用的，
// 用 chart 栈取当前正在绘制的实例：弹窗打开时在栈顶，关闭 pop 后回到主图。
import { registerXAxis } from "klinecharts";
import { hhmmUTC } from "./chart";

// A 股连续竞价标准刻度（含开盘 / 收盘）
const TICK_HM = [
  "09:30", "10:00", "10:30", "11:00", "11:30",
  "13:00", "13:30", "14:00", "14:30", "15:00",
];

const chartStack: any[] = [];

/** chart 创建后压栈，dispose 前出栈 */
export function pushChart(chart: any) {
  if (chart && chartStack.indexOf(chart) < 0) chartStack.push(chart);
}
export function popChart(chart: any) {
  const i = chartStack.indexOf(chart);
  if (i >= 0) chartStack.splice(i, 1);
}

function createTicks({ defaultTicks, bounding }: any): any {
  const chart = chartStack[chartStack.length - 1];
  if (!chart || !bounding) return defaultTicks;
  const list = chart.getDataList() ?? [];
  const scale = chart.getChartStore().getTimeScaleStore();
  const ticks: any[] = [];
  for (const d of list) {
    const hm = hhmmUTC(d.timestamp);
    if (TICK_HM.indexOf(hm) < 0) continue;
    const dataIndex = scale.timestampToDataIndex(d.timestamp);
    const coord = scale.dataIndexToCoordinate(dataIndex);
    if (coord == null || coord < -4 || coord > bounding.width + 4) continue;
    ticks.push({ coord, text: hm, value: d.timestamp });
  }
  // 午休 11:30（index120）与 13:00（index121）只差 1 个 bar，坐标几乎重合，
  // 标签会叠在一起；相邻刻度过近时保留先出现的 11:30，跳过 13:00。
  const shown: any[] = [];
  for (const t of ticks) {
    const prev = shown[shown.length - 1];
    if (prev && Math.abs(t.coord - prev.coord) < 46) continue;
    shown.push(t);
  }
  return shown.length ? shown : defaultTicks;
}

registerXAxis({ name: "tradingTime", createTicks } as any);
