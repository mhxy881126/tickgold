// 条件字段元数据：供条件构建器渲染下拉、单位、可用运算符与额外参数
import type { Op } from "./types";

export type FieldCategory =
  | "quote" // 行情基础
  | "speed" // 涨速跳水
  | "event" // 涨跌停事件
  | "indicator" // 技术指标
  | "book" // 盘口
  | "auction"; // 竞价

export type ParamSpec = {
  key: string;
  label: string;
  default: number;
  min?: number;
  step?: number;
};

export interface FieldSpec {
  field: string;
  label: string;
  category: FieldCategory;
  unit?: string;
  ops: Op[];
  /** 叶子的默认阈值 */
  default: number;
  /** 额外参数（指标周期 / 涨速窗口） */
  params?: ParamSpec[];
}

const SCALAR_OPS: Op[] = [">=", "<=", ">", "<", "==", "crossUp", "crossDown"];
const THRESH_OPS: Op[] = [">=", "<=", ">", "<", "=="];
const CROSS_OPS: Op[] = ["crossUp", "crossDown"];
const EVENT_OPS: Op[] = [">="];

export const FIELD_SPECS: FieldSpec[] = [
  // ===== 行情基础 =====
  { field: "price", label: "现价", category: "quote", unit: "元", ops: SCALAR_OPS, default: 0 },
  { field: "pct", label: "涨跌幅", category: "quote", unit: "%", ops: SCALAR_OPS, default: 5 },
  { field: "volumeRatio", label: "量比", category: "quote", ops: THRESH_OPS, default: 2 },
  { field: "turnover", label: "换手率", category: "quote", unit: "%", ops: THRESH_OPS, default: 5 },
  { field: "amountYi", label: "成交额", category: "quote", unit: "亿", ops: THRESH_OPS, default: 5 },
  // ===== 涨速 / 跳水 =====
  {
    field: "speedPct",
    label: "区间涨速",
    category: "speed",
    unit: "%",
    ops: SCALAR_OPS,
    default: 3,
    params: [{ key: "windowSec", label: "窗口(秒)", default: 300, min: 30, step: 30 }],
  },
  // ===== 涨跌停事件（边沿，阈值固定为 1） =====
  { field: "evt.sealUp", label: "涨停封板", category: "event", ops: EVENT_OPS, default: 1 },
  { field: "evt.sealDn", label: "跌停封板", category: "event", ops: EVENT_OPS, default: 1 },
  { field: "evt.broken", label: "涨停炸板", category: "event", ops: EVENT_OPS, default: 1 },
  // ===== 技术指标 =====
  {
    field: "ind.ma",
    label: "MA 均线",
    category: "indicator",
    unit: "元",
    ops: SCALAR_OPS,
    default: 0,
    params: [{ key: "period", label: "周期", default: 20, min: 1, step: 1 }],
  },
  {
    field: "ind.ema",
    label: "EMA 均线",
    category: "indicator",
    unit: "元",
    ops: SCALAR_OPS,
    default: 0,
    params: [{ key: "period", label: "周期", default: 20, min: 1, step: 1 }],
  },
  {
    field: "ind.macd",
    label: "MACD 柱",
    category: "indicator",
    ops: SCALAR_OPS,
    default: 0,
    params: [
      { key: "fast", label: "快", default: 12, min: 1, step: 1 },
      { key: "slow", label: "慢", default: 26, min: 1, step: 1 },
      { key: "signal", label: "信号", default: 9, min: 1, step: 1 },
    ],
  },
  {
    field: "ind.dif",
    label: "DIF",
    category: "indicator",
    ops: SCALAR_OPS,
    default: 0,
    params: [
      { key: "fast", label: "快", default: 12, min: 1, step: 1 },
      { key: "slow", label: "慢", default: 26, min: 1, step: 1 },
    ],
  },
  { field: "ind.dea", label: "DEA", category: "indicator", ops: SCALAR_OPS, default: 0 },
  {
    field: "ind.k",
    label: "KDJ-K",
    category: "indicator",
    ops: SCALAR_OPS,
    default: 20,
    params: [{ key: "period", label: "周期", default: 9, min: 1, step: 1 }],
  },
  { field: "ind.d", label: "KDJ-D", category: "indicator", ops: SCALAR_OPS, default: 20 },
  { field: "ind.j", label: "KDJ-J", category: "indicator", ops: SCALAR_OPS, default: 0 },
  {
    field: "ind.rsi",
    label: "RSI",
    category: "indicator",
    ops: SCALAR_OPS,
    default: 70,
    params: [{ key: "period", label: "周期", default: 14, min: 1, step: 1 }],
  },
  // ===== 五档盘口 =====
  { field: "book.bidAskRatio", label: "委比(买/卖量比)", category: "book", ops: THRESH_OPS, default: 1.5 },
  // ===== 竞价 =====
  { field: "auction.gap", label: "竞价缺口", category: "auction", unit: "%", ops: SCALAR_OPS, default: 3 },
  { field: "auction.amountYi", label: "竞价成交额", category: "auction", unit: "亿", ops: THRESH_OPS, default: 1 },
];

const SPEC_MAP: Record<string, FieldSpec> = Object.fromEntries(
  FIELD_SPECS.map((s) => [s.field, s])
);

export function fieldSpec(field: string): FieldSpec | undefined {
  return SPEC_MAP[field];
}

export const CATEGORY_LABELS: Record<FieldCategory, string> = {
  quote: "行情",
  speed: "涨速",
  event: "涨跌停",
  indicator: "指标",
  book: "盘口",
  auction: "竞价",
};
