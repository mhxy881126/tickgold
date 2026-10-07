// 老布局（v0）→ 微件布局（v1）自动迁移纯函数。
// 无 widgets 的卡：有出厂模板则迁移；无模板保持 legacy 渲染（不加 v）。
// 已有 widgets 的卡：清洗（未知 def 丢弃、尺寸 clamp、重新装箱），往返幂等。
import type { SnapshotCard } from "./cards";
import {
  clampH,
  clampW,
  packWidgets,
  type CardWidgets,
  type WidgetInstance,
} from "./widgets";
import { widgetDefOf } from "../components/widgets/registry";
import { hasPreset, presetOf } from "./widget-presets";
import { logger } from "../utils/logger";

const WIDGET_V = 1;

// 校验并清洗单个实例：未知 def 丢弃并记日志；尺寸 clamp 到该 def 边界
function sanitizeItem(raw: unknown): WidgetInstance | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const def = typeof r.def === "string" ? r.def : "";
  const d = widgetDefOf(def);
  if (!d) {
    logger.warn("丢弃未知微件", "widget-migrate", { def });
    return null;
  }
  const id = typeof r.id === "string" && r.id ? r.id : `${def}_${Math.random().toString(36).slice(2)}`;
  const bind =
    typeof r.bind === "string" && r.bind ? r.bind : r.bind === null ? null : undefined;
  const text = typeof r.text === "string" ? r.text : undefined;
  const w = clampW(typeof r.w === "number" ? r.w : d.defaultW);
  const h = clampH(typeof r.h === "number" ? r.h : d.defaultH);
  return {
    id, def,
    w: Math.max(d.minW, w),
    h: Math.max(d.minH, h),
    x: 0, y: 0,
    bind, text,
  };
}

function sanitizeWidgets(raw: unknown): CardWidgets | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const primary =
    typeof r.primary === "string" && r.primary
      ? r.primary
      : r.primary === null
        ? null
        : undefined;
  const list = Array.isArray(r.items) ? r.items : [];
  const items = list
    .map(sanitizeItem)
    .filter((x): x is WidgetInstance => x !== null);
  if (!items.length) return null;
  return { primary, items: packWidgets(items) };
}

// 结构等价（字段级；primary 缺省/undefined 与 null 区分，按语义比较）
function widgetsEqual(a: CardWidgets, b: CardWidgets): boolean {
  if ((a.primary ?? null) !== (b.primary ?? null)) return false;
  if (a.items.length !== b.items.length) return false;
  return a.items.every((x, i) => {
    const y = b.items[i]!;
    return (
      x.id === y.id && x.def === y.def && x.w === y.w && x.h === y.h &&
      x.x === y.x && x.y === y.y &&
      (x.bind ?? null) === (y.bind ?? null) &&
      (x.text ?? null) === (y.text ?? null)
    );
  });
}

// 旧版本曾把 K线卡出厂微件化为「报价头+盘口+分时缩略图」，丢失完整
// StockChart。检测到该卡仍是这份未改动的旧出厂模板时，一次性还原为经典
// 完整组件；用户若自行编排过（增删/改绑定）则尊重其自定义，不还原。
const LEGACY_FACTORY_CHART_DEFS = ["quote-head", "orderbook-mini", "minute-chart"];
// 直接读未清洗的快照：orderbook-mini 已从注册表移除，清洗后该实例会被丢弃，
// 必须在 sanitize 之前比对原始 def 顺序才能识别旧出厂模板。
function isLegacyFactoryChart(c: SnapshotCard): boolean {
  if (c.id !== "chart") return false;
  const raw = c.widgets;
  if (!raw || typeof raw !== "object") return false;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return false;
  return (
    items.length === LEGACY_FACTORY_CHART_DEFS.length &&
    items.every(
      (it, i) =>
        typeof it === "object" &&
        it !== null &&
        (it as { def?: unknown }).def === LEGACY_FACTORY_CHART_DEFS[i]
    )
  );
}

// 出厂微件化的功能卡（完整组件被简化微件替代）→ 检测未改动出厂模板并还原经典：
// - rank  榜单卡 quote-list（自选列表）→ 还原 RankBoard（8 榜单 Tab）
// - watch 自选卡 quote-list（自选列表）→ 还原 WatchList（分组管理/移动分组/搜索添加）
// - news  快讯卡 news-tape（滚动快讯）→ 还原 NewsFlash（分页加载/去重/点击开窗）
// 用户若自行编排过（增删/改绑定/改尺寸）则尊重其自定义，不还原。
const FACTORY_RESTORE: Partial<Record<SnapshotCard["id"], string>> = {
  rank: "quote-list",
  watch: "quote-list",
  news: "news-tape",
};

// 通用检测：某卡仍是「未改动的单实例出厂模板」时返回 true（须在 sanitize 之前
// 读取原始快照）。判定：items 唯一、def 匹配、无绑定、尺寸为注册表默认。
function isUnmodifiedFactory(c: SnapshotCard, defId: string): boolean {
  const raw = c.widgets;
  if (!raw || typeof raw !== "object") return false;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length !== 1) return false;
  const it = items[0] as Record<string, unknown> | null | undefined;
  if (!it || typeof it !== "object") return false;
  if (it.def !== defId) return false;
  // bind 非空视为用户改过绑定；尺寸偏离出厂默认视为自定义
  if (typeof it.bind === "string" && it.bind) return false;
  const d = widgetDefOf(defId);
  if (!d) return false;
  if (typeof it.w === "number" && it.w !== d.defaultW) return false;
  if (typeof it.h === "number" && it.h !== d.defaultH) return false;
  return true;
}

// 迁移单卡；返回新卡与是否发生变化
export function migrateCard(c: SnapshotCard): { card: SnapshotCard; changed: boolean } {
  // 已是 v1：清洗后保持；内容未变即幂等（changed=false）
  if (c.v === WIDGET_V && c.widgets) {
    // 旧出厂微件化的 K线卡 → 还原经典完整 StockChart（须在清洗前检测）
    if (isLegacyFactoryChart(c)) {
      const { v: _v, widgets: _w, ...rest } = c;
      return { card: rest, changed: true };
    }
    // 旧出厂微件化的功能卡（watch/rank/news，简化微件替代完整组件）→ 还原经典
    const restoreDef = FACTORY_RESTORE[c.id];
    if (restoreDef && isUnmodifiedFactory(c, restoreDef)) {
      const { v: _v, widgets: _w, ...rest } = c;
      return { card: rest, changed: true };
    }
    const clean = sanitizeWidgets(c.widgets);
    if (!clean) {
      // widgets 全无效：回落出厂模板或移除 widgets
      const preset = presetOf(c.id);
      if (preset) return { card: { ...c, widgets: preset }, changed: true };
      const { v: _v, widgets: _w, ...rest } = c;
      return { card: rest, changed: true };
    }
    return { card: { ...c, widgets: clean }, changed: !widgetsEqual(c.widgets, clean) };
  }
  // 老布局：有出厂模板则迁移
  if (hasPreset(c.id)) {
    const preset = presetOf(c.id)!;
    return { card: { ...c, v: WIDGET_V, widgets: preset }, changed: true };
  }
  // 无模板：保持 legacy 不变
  return { card: c, changed: false };
}

// 迁移整份快照：返回新数组与是否有改动（幂等：再次迁移无模板卡不变）
export function migrateSnapshot(cards: SnapshotCard[]): {
  cards: SnapshotCard[];
  changed: boolean;
} {
  let changed = false;
  const next = cards.map((c) => {
    const r = migrateCard(c);
    if (r.changed) changed = true;
    return r.card;
  });
  return { cards: next, changed };
}
