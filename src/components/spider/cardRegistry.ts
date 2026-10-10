// 卡片能力注册表：为全部 38 张卡声明"是什么分组 / 行主体类型 / 能否产出信号 /
// 建议停留时长 / 可交互语义 / 是否参与无人值守巡回"。
// 决策大脑与蜘蛛据此知道每张卡"怎么采、采什么、能不能出信号"，替代硬编码 switch。
import { CARD_META, type CardId } from "../../lib/cards";
import type { UiSemantic } from "./uiGraph";

export type CardGroup = "env" | "mainline" | "stock" | "trade" | "review";
/** 行主体类型：个股 / 板块 / 指数 / 逐笔委托(只观察) / 资讯 / 无行 */
export type RowKind = "stock" | "sector" | "index" | "order" | "info" | "none";

export interface CardCapability {
  id: CardId;
  title: string;
  group: CardGroup;
  rowKind: RowKind;
  /** 是否产出交易/风控信号 */
  producesSignal: boolean;
  /** 蜘蛛在该卡建议停留时长 ms */
  dwellMs: number;
  /** 是否参与无人值守巡回路径 */
  onTour: boolean;
  /** 该卡需要操作的交互语义（可选） */
  interactions?: UiSemantic[];
}

type RawCap = Omit<CardCapability, "id" | "title">;

const RAW: Record<CardId, RawCap> = {
  // ─── 环境（定大盘 / 情绪）───
  auction: { group: "env", rowKind: "stock", producesSignal: true, dwellMs: 4500, onTour: true },
  limitpool: { group: "env", rowKind: "stock", producesSignal: true, dwellMs: 5000, onTour: true },
  radar: { group: "env", rowKind: "stock", producesSignal: true, dwellMs: 5000, onTour: true },
  heatmatrix: { group: "env", rowKind: "none", producesSignal: false, dwellMs: 4000, onTour: true },
  sieve: { group: "env", rowKind: "stock", producesSignal: false, dwellMs: 4000, onTour: true },

  // ─── 主线（找资金 / 题材 / 龙头）───
  rank: { group: "mainline", rowKind: "stock", producesSignal: true, dwellMs: 5000, onTour: true },
  watch: { group: "mainline", rowKind: "stock", producesSignal: true, dwellMs: 6000, onTour: true },
  trades: { group: "mainline", rowKind: "order", producesSignal: false, dwellMs: 4000, onTour: true },
  spider: { group: "mainline", rowKind: "stock", producesSignal: true, dwellMs: 4500, onTour: true },
  sectorevent: { group: "mainline", rowKind: "sector", producesSignal: false, dwellMs: 4000, onTour: true },
  sector: { group: "mainline", rowKind: "sector", producesSignal: false, dwellMs: 4500, onTour: true },
  sectorheat: { group: "mainline", rowKind: "sector", producesSignal: false, dwellMs: 4000, onTour: true },
  themelib: { group: "mainline", rowKind: "sector", producesSignal: false, dwellMs: 4500, onTour: true },
  dragon: { group: "mainline", rowKind: "stock", producesSignal: true, dwellMs: 5000, onTour: true },

  // ─── 个股深度（研判）───
  chart: { group: "stock", rowKind: "none", producesSignal: false, dwellMs: 4000, onTour: true },
  multigrid: { group: "stock", rowKind: "stock", producesSignal: false, dwellMs: 4000, onTour: true },
  f10: { group: "stock", rowKind: "none", producesSignal: false, dwellMs: 3500, onTour: true },
  screener: { group: "stock", rowKind: "stock", producesSignal: true, dwellMs: 4500, onTour: true },
  alert: { group: "stock", rowKind: "none", producesSignal: false, dwellMs: 3000, onTour: true },
  news: { group: "stock", rowKind: "info", producesSignal: false, dwellMs: 3500, onTour: true },
  calendar: { group: "stock", rowKind: "none", producesSignal: false, dwellMs: 3000, onTour: true },
  ipo: { group: "stock", rowKind: "none", producesSignal: false, dwellMs: 3000, onTour: true },
  ai: { group: "stock", rowKind: "none", producesSignal: false, dwellMs: 3000, onTour: true },

  // ─── 交易（执行）───
  trade: {
    group: "trade", rowKind: "stock", producesSignal: false, dwellMs: 5000, onTour: true,
    interactions: ["buy", "sell", "confirm", "tab-switch"],
  },
  signalbridge: {
    group: "trade", rowKind: "none", producesSignal: false, dwellMs: 3000, onTour: true,
    interactions: ["confirm", "cancel"],
  },
  co: {
    group: "trade", rowKind: "stock", producesSignal: true, dwellMs: 4000, onTour: true,
    interactions: ["confirm", "cancel"],
  },

  // ─── 复盘 / 进化（盘后）───
  review: { group: "review", rowKind: "none", producesSignal: false, dwellMs: 3500, onTour: true },
  reviewtimeline: { group: "review", rowKind: "info", producesSignal: false, dwellMs: 3500, onTour: true },
  battleplan: { group: "review", rowKind: "none", producesSignal: false, dwellMs: 3000, onTour: true },
  decisionlog: { group: "review", rowKind: "none", producesSignal: false, dwellMs: 3000, onTour: true },
  strategy: { group: "review", rowKind: "none", producesSignal: false, dwellMs: 3000, onTour: true },
  evolution: { group: "review", rowKind: "none", producesSignal: false, dwellMs: 3000, onTour: true },
  performance: { group: "review", rowKind: "none", producesSignal: false, dwellMs: 3500, onTour: true },
  journal: { group: "review", rowKind: "info", producesSignal: false, dwellMs: 3000, onTour: true },
  calc: { group: "review", rowKind: "none", producesSignal: false, dwellMs: 2500, onTour: true },
  export: {
    group: "review", rowKind: "none", producesSignal: false, dwellMs: 2500, onTour: true,
    interactions: ["export"],
  },
  spiderbot: { group: "review", rowKind: "none", producesSignal: false, dwellMs: 2500, onTour: false },
  // ─── v2.25 智能赋能 ───
  intradayai: { group: "env", rowKind: "none", producesSignal: false, dwellMs: 5000, onTour: true },
  newsdigest: { group: "mainline", rowKind: "info", producesSignal: false, dwellMs: 5000, onTour: true },
  mainline: { group: "review", rowKind: "none", producesSignal: false, dwellMs: 5000, onTour: true },
};

function build(id: CardId): CardCapability {
  return { id, title: CARD_META[id]?.title ?? id, ...RAW[id] };
}

export const CARD_REGISTRY: Record<CardId, CardCapability> = Object.keys(RAW).reduce(
  (acc, key) => {
    const id = key as CardId;
    acc[id] = build(id);
    return acc;
  },
  {} as Record<CardId, CardCapability>,
);

export function getCapability(id: CardId | string | null | undefined): CardCapability | undefined {
  return id ? CARD_REGISTRY[id as CardId] : undefined;
}

/** 个股代码硬校验：A 股个股为 6 位纯数字（伪 code 如 sector:名 / index:名 均不通过） */
export function isStockCode(code?: string | null): boolean {
  return !!code && /^\d{6}$/.test(code);
}

const GROUP_ORDER: CardGroup[] = ["env", "mainline", "stock", "trade", "review"];

/** 取某分组的全部巡回卡（按注册顺序） */
export function cardsByGroup(group: CardGroup): CardId[] {
  return (Object.keys(CARD_REGISTRY) as CardId[])
    .filter((id) => CARD_REGISTRY[id].group === group && CARD_REGISTRY[id].onTour);
}

/** 交易时段完整巡回：环境 → 主线 → 个股 → 交易（不含复盘组） */
export function tradingTourCards(): CardId[] {
  return GROUP_ORDER.filter((g) => g !== "review").flatMap(cardsByGroup);
}

/** 盘后巡回：复盘 / 进化组 */
export function reviewTourCards(): CardId[] {
  return cardsByGroup("review");
}
