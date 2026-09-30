// 卡片域核心类型与元信息（从 useWorkbench 抽出，供布局、组件、composable 共享）
import type { FreeRect } from "./layout";

export type CardId =
  | "auction"
  | "limitpool"
  | "radar"
  | "radarsweep"
  | "reviewtimeline"
  | "multigrid"
  | "heatmatrix"
  | "telegraph"
  | "chart"
  | "sectorheat"
  | "sector"
  | "screener"
  | "spider"
  | "sectorevent"
  | "watch"
  | "rank"
  | "alert"
  | "f10"
  | "trade"
  | "journal"
  | "calendar"
  | "ipo"
  | "news"
  | "calc"
  | "export"
  | "dragon"
  | "themelib"
  | "trades";

export type Zone = "main" | "side";

export interface CardMeta {
  title: string;
  accent: string;
  kind: "chart" | "narrow";
}

// 卡片元信息
export const CARD_META: Record<CardId, CardMeta> = {
  auction: { title: "集合竞价", accent: "#ffd76a", kind: "chart" },
  limitpool: { title: "涨停池明细", accent: "#e0455a", kind: "chart" },
  radar: { title: "涨停雷达", accent: "#e0455a", kind: "chart" },
  radarsweep: { title: "雷达扫盘", accent: "#2de1ff", kind: "chart" },
  reviewtimeline: { title: "复盘时间线", accent: "#c9a24a", kind: "chart" },
  multigrid: { title: "多股同列", accent: "#36b8e8", kind: "chart" },
  heatmatrix: { title: "全市场热力矩阵", accent: "#ff7a45", kind: "chart" },
  telegraph: { title: "异动电报墙", accent: "#1dffa0", kind: "chart" },
  chart: { title: "K线图", accent: "#2f6fed", kind: "chart" },
  sectorheat: { title: "板块热力图", accent: "#d4af37", kind: "chart" },
  sector: { title: "板块行情", accent: "#35c4a8", kind: "chart" },
  screener: { title: "条件选股", accent: "#d4af37", kind: "chart" },
  spider: { title: "短线精灵", accent: "#e0556b", kind: "narrow" },
  sectorevent: { title: "板块异动", accent: "#e0556b", kind: "narrow" },
  watch: { title: "自选股", accent: "#26d07c", kind: "narrow" },
  rank: { title: "榜单", accent: "#e0556b", kind: "narrow" },
  alert: { title: "预警管理", accent: "#ffd700", kind: "narrow" },
  f10: { title: "F10 个股资料", accent: "#d4af37", kind: "chart" },
  trade: { title: "模拟交易", accent: "#f0883e", kind: "chart" },
  journal: { title: "盯盘日记", accent: "#d4af37", kind: "chart" },
  calendar: { title: "财经日历", accent: "#4ea1ff", kind: "chart" },
  ipo: { title: "新股解禁", accent: "#ff8a3d", kind: "chart" },
  news: { title: "盘中快讯", accent: "#b07cff", kind: "narrow" },
  calc: { title: "投资计算器", accent: "#e8c878", kind: "chart" },
  export: { title: "数据导出", accent: "#6aa6e8", kind: "chart" },
  dragon: { title: "龙虎榜复盘", accent: "#e8c878", kind: "chart" },
  themelib: { title: "题材库", accent: "#d4af37", kind: "chart" },
  trades: { title: "逐笔成交", accent: "#ffb13d", kind: "narrow" },
};

// ===== 卡片个性化（V1 单卡设置 / V3 场景模板）=====
export interface CardCustom {
  span?: number;       // 用户覆盖的列跨度（1..12）
  rspan?: number;      // 用户覆盖的行跨度（逻辑行）
  collapsed?: boolean; // 折叠为标题栏
  color?: string;      // 强调色覆盖
  refresh?: number;    // 刷新频率（秒，0=跟随全局）
  // 外观（鎏金专业版）
  gradientTo?: string; // 渐变第二色（空=纯色）
  gradAngle?: number;  // 渐变角度 0..360
  opacity?: number;    // 背景不透明度 0.6..1
  radius?: number;     // 圆角 6..18
  borderWidth?: number;// 边框宽度 0..2
  headStyle?: 1 | 2 | 3 | 4 | 5; // 标题栏样式
  // 皮肤装饰（v0.90，未设置=跟随皮肤）
  glow?: boolean;      // 本卡常驻辉光开关
  barGlow?: boolean;   // 左条辉光开关
  // 行为
  pinned?: boolean;    // 置顶
  locked?: boolean;    // 锁定（禁止拖拽/resize）
  tag?: string;        // 文字标签（最多4字）
}

// 设置弹层的预设色板
export const CARD_SWATCHES = [
  "#e8c878", "#ef5f6b", "#6aa6e8", "#2fbf95",
  "#b08ce8", "#ff9f43", "#2de1ff", "#d4af37",
];

// 布局序列化快照中的单卡结构（仅在解析/恢复模块间共享）
export interface SnapshotCard {
  id: CardId;
  zone: Zone;
  /** 快照版本：1=含微件；缺省=v0 老布局，读取时自动迁移 */
  v?: number;
  widgets?: CardWidgets;
  rect?: FreeRect;
  cu?: CardCustom;
}

// 仅类型依赖，避免 cards.ts 运行时引入 widgets.ts
import type { CardWidgets } from "./widgets";
