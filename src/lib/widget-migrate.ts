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
function isLegacyFactoryChart(c: SnapshotCard, w: CardWidgets): boolean {
  if (c.id !== "chart") return false;
  const defs = w.items.map((i) => i.def);
  return (
    defs.length === LEGACY_FACTORY_CHART_DEFS.length &&
    defs.every((d, i) => d === LEGACY_FACTORY_CHART_DEFS[i])
  );
}

// 迁移单卡；返回新卡与是否发生变化
export function migrateCard(c: SnapshotCard): { card: SnapshotCard; changed: boolean } {
  // 已是 v1：清洗后保持；内容未变即幂等（changed=false）
  if (c.v === WIDGET_V && c.widgets) {
    const clean = sanitizeWidgets(c.widgets);
    // 旧出厂微件化的 K线卡 → 还原经典完整 StockChart
    if (clean && isLegacyFactoryChart(c, clean)) {
      const { v: _v, widgets: _w, ...rest } = c;
      return { card: rest, changed: true };
    }
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
