// 静态预设：模式分组、时段驾驶舱、V3 场景模板
// 纯数据 / 纯函数，无响应式状态，便于单测。
import type { CardId } from "./cards";
import type { BentoPos } from "./layout";

// 模式预设：一键切换一整套卡片
export const MODES: Record<string, CardId[]> = {
  pro: ["radar", "chart", "spider", "watch", "alert"],
  sector: ["sectorheat", "sector", "sectorevent"],
  scanner: ["screener", "rank", "watch"],
  full: [
    "radar",
    "chart",
    "sectorheat",
    "sector",
    "screener",
    "spider",
    "sectorevent",
    "watch",
    "rank",
    "alert",
  ],
  chart: ["chart"],
};

// ===== 时段驾驶舱 Bento 布局 =====
export interface TimePreset {
  id: string;
  label: string;
  from: string;
  to: string;
  cards: CardId[];
  bento: Partial<Record<CardId, BentoPos>>;
}
// 款5 Bento：12 列 × 3 大行（热力图大卡 + 雷达/异动 + 快讯整行垫底）
const BENTO: Partial<Record<CardId, BentoPos>> = {
  sectorheat: { col: 1, colEnd: 9, row: 1, rowEnd: 3 },
  radar: { col: 9, colEnd: 13, row: 1, rowEnd: 2 },
  spider: { col: 9, colEnd: 13, row: 2, rowEnd: 3 },
  news: { col: 1, colEnd: 13, row: 3, rowEnd: 4 },
};
const TIME_CARDS: CardId[] = ["sectorheat", "radar", "spider", "news"];
// 盘后复盘：把 news（盘中快讯）换成 reviewtimeline（复盘时间线）
const REVIEW_CARDS: CardId[] = ["sectorheat", "radar", "spider", "reviewtimeline"];
const REVIEW_BENTO: Partial<Record<CardId, BentoPos>> = {
  sectorheat: { col: 1, colEnd: 9, row: 1, rowEnd: 3 },
  radar: { col: 9, colEnd: 13, row: 1, rowEnd: 2 },
  spider: { col: 9, colEnd: 13, row: 2, rowEnd: 3 },
  reviewtimeline: { col: 1, colEnd: 13, row: 3, rowEnd: 4 },
};
export const TIME_PRESETS: TimePreset[] = [
  { id: "auction", label: "集合竞价", from: "09:15", to: "09:30", cards: TIME_CARDS, bento: BENTO },
  { id: "morning", label: "早盘 9:30", from: "09:30", to: "11:30", cards: TIME_CARDS, bento: BENTO },
  { id: "midday", label: "午盘", from: "11:30", to: "14:30", cards: TIME_CARDS, bento: BENTO },
  { id: "tail", label: "尾盘 14:30", from: "14:30", to: "15:00", cards: TIME_CARDS, bento: BENTO },
  { id: "review", label: "盘后复盘", from: "15:00", to: "09:15", cards: REVIEW_CARDS, bento: REVIEW_BENTO },
];

/// 根据时间判断当前 A 股时段
export function currentTimeSlot(d: Date = new Date()): string {
  const hm = d.getHours() * 60 + d.getMinutes();
  const m = (s: string) => {
    const [a, b] = s.split(":").map(Number);
    return a * 60 + b;
  };
  if (hm >= m("09:15") && hm < m("09:30")) return "auction";
  if (hm >= m("09:30") && hm < m("11:30")) return "morning";
  if (hm >= m("11:30") && hm < m("14:30")) return "midday";
  if (hm >= m("14:30") && hm < m("15:00")) return "tail";
  return "review";
}

// ===== V3 场景模板：一键切换卡片集 + 预设尺寸（每个场景精确铺满 12×6）=====
export interface Scene {
  id: string;
  label: string;
  icon: string;
  cards: CardId[];
  size?: Partial<Record<CardId, { w: number; h: number }>>;
  // v2.23 打法模板新增（可选，向后兼容）
  /** 一键应用时联动创建的预警模板 key（ALERT_TEMPLATES），同名去重、不覆盖已启用 */
  presetAlertKeys?: string[];
  /** 关联的条件单快捷方案 id（在条件单卡片「打法方案」对具体标的落地） */
  presetCoPlans?: string[];
  /** 建议自选分组（提示，不强制切换） */
  watchGroup?: string;
  /** 是否出厂打法（区分自定义模板） */
  builtin?: boolean;
}
export const SCENES: Scene[] = [
  { id: "pan", label: "盘中盯盘", icon: "M12 8a4 4 0 100 8 4 4 0 000-8zm0-4C7 4 3 12 3 12s4 8 9 8 9-8 9-8-4-8-9-8z",
    cards: ["chart", "radar", "watch", "spider", "sectorevent"],
    // 12×6=72 精确铺满：图表 8×4 + 雷达 4×4，底两行为自选 6 格 + 精灵/板块异动各 3 格
    size: { chart: { w: 8, h: 4 }, radar: { w: 4, h: 4 }, watch: { w: 6, h: 2 }, spider: { w: 3, h: 2 }, sectorevent: { w: 3, h: 2 } } },
  { id: "auction", label: "开盘竞价", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm1 10.5V6h-2v8h8v-2h-6z",
    cards: ["auction", "radar", "watch", "spider", "sectorevent"],
    // 12×6=72 精确铺满：竞价榜 12×3，雷达/自选各 6×2，精灵/板块异动各 6×1 垫底
    size: { auction: { w: 12, h: 3 }, radar: { w: 6, h: 2 }, watch: { w: 6, h: 2 }, spider: { w: 6, h: 1 }, sectorevent: { w: 6, h: 1 } } },
  { id: "review", label: "盘后复盘", icon: "M12 4a8 8 0 108 8h-2a6 6 0 11-6-6v3l4-4-4-4v3z",
    cards: ["themelib", "chart", "reviewtimeline", "sectorheat", "news"],
    // 12×6=72 精确铺满：题材库/图表 6×3 占前三行，复盘时间线/热力图占中两行，快讯整行垫底
    size: { themelib: { w: 6, h: 3 }, chart: { w: 6, h: 3 }, reviewtimeline: { w: 6, h: 2 }, sectorheat: { w: 6, h: 2 }, news: { w: 12, h: 1 } } },
  { id: "screen", label: "条件选股", icon: "M3 4h18l-7 8v6l-4 2v-8z",
    cards: ["screener", "sectorheat", "sector", "rank", "watch"],
    size: { screener: { w: 8, h: 3 }, sectorheat: { w: 4, h: 3 }, sector: { w: 6, h: 2 }, rank: { w: 6, h: 2 }, watch: { w: 12, h: 1 } } },
  { id: "mini", label: "极简看盘", icon: "M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z",
    cards: ["chart", "radar", "watch"],
    // 12×6=72：图表 8×4 + 雷达 4×4，自选整行垫底
    size: { chart: { w: 8, h: 4 }, radar: { w: 4, h: 4 }, watch: { w: 12, h: 2 } } },
  { id: "trade", label: "交易盯盘", icon: "M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z",
    // 方案 D · 交易指挥舱（B 交易场景）：App 内以 TradeDeck 范式渲染（账户条 + 主图 + 信号桥 + 逐笔/模拟持仓/自选 + Kill Switch），
    // 此处 size 保证 12×6=72 铺满校验，同时为「恢复自动布局」等 Bento 回落提供尺寸。
    cards: ["chart", "signalbridge", "trades", "trade", "watch"],
    size: { chart: { w: 6, h: 4 }, signalbridge: { w: 6, h: 4 }, trades: { w: 3, h: 2 }, trade: { w: 3, h: 2 }, watch: { w: 6, h: 2 } } },

  // ───── v2.23 打法模板：卡片 + 布局 + 默认预警 / 条件单方案，一键应用 ─────
  { id: "daban", label: "打板接力", icon: "M12 4l8 8h-5v8h-6v-8H4z", builtin: true,
    cards: ["limitpool", "radar", "auction", "spider", "sectorevent", "co"],
    // 12×6=72：涨停池 8×4 + 雷达 4×4；竞价/精灵各 4×2，板块异动/条件单各 2×2 垫底
    size: { limitpool: { w: 8, h: 4 }, radar: { w: 4, h: 4 }, auction: { w: 4, h: 2 },
      spider: { w: 4, h: 2 }, sectorevent: { w: 2, h: 2 }, co: { w: 2, h: 2 } },
    presetAlertKeys: ["seal-up", "broken"], presetCoPlans: ["daban-seal-buy", "daban-broken-exit"],
    watchGroup: "打板接力" },
  { id: "dixi", label: "低吸埋伏", icon: "M12 20l-8-8h5V4h6v8h5z", builtin: true,
    cards: ["chart", "sectorheat", "screener", "watch", "co"],
    // 12×6=72：主图 8×4 + 板块热力 4×4；选股/自选/条件单各 4×2 垫底
    size: { chart: { w: 8, h: 4 }, sectorheat: { w: 4, h: 4 }, screener: { w: 4, h: 2 },
      watch: { w: 4, h: 2 }, co: { w: 4, h: 2 } },
    presetAlertKeys: ["pullback-ma", "volume-surge"], presetCoPlans: ["dixi-buy-pullback", "dixi-stoploss"],
    watchGroup: "低吸池" },
  { id: "jingjia", label: "竞价抢筹", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm1 10.5V6h-2v8h8v-2h-6z", builtin: true,
    cards: ["auction", "radar", "watch", "spider"],
    // 12×6=72：竞价榜 8×4 + 雷达 4×4；自选 4×2 + 精灵 8×2 垫底
    size: { auction: { w: 8, h: 4 }, radar: { w: 4, h: 4 }, watch: { w: 4, h: 2 }, spider: { w: 8, h: 2 } },
    presetAlertKeys: ["auction-grab", "volume-surge"], presetCoPlans: [],
    watchGroup: "竞价关注" },
  { id: "qushi", label: "趋势跟踪", icon: "M12 8a4 4 0 100 8 4 4 0 000-8zm0-4C7 4 3 12 3 12s4 8 9 8 9-8 9-8-4-8-9-8z", builtin: true,
    cards: ["chart", "sector", "trades", "watch", "co"],
    // 12×6=72：主图 8×4 + 板块 4×4；逐笔/自选/条件单各 4×2 垫底
    size: { chart: { w: 8, h: 4 }, sector: { w: 4, h: 4 }, trades: { w: 4, h: 2 },
      watch: { w: 4, h: 2 }, co: { w: 4, h: 2 } },
    presetAlertKeys: ["breakout", "pullback-ma"], presetCoPlans: ["qushi-break-exit"],
    watchGroup: "趋势持仓" },
];

export interface NamedLayout {
  id: number;
  name: string;
  cards: string;
  updated_at: number;
}
