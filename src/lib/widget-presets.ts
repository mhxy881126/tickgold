// 出厂微件模板：CardId → 微件布局（实例 id 每次生成，尺寸/绑定来自注册表默认）。
// 尚无对应微件的卡片不定义模板——老布局保持 legacy 渲染，迁移时跳过。
import type { CardId } from "./cards";
import {
  makeWidgetId,
  packWidgets,
  type CardWidgets,
  type WidgetInstance,
} from "./widgets";
import { widgetDefOf } from "../components/widgets/registry";

// 按 defId 列表构造一份全新装箱实例
export function buildItems(defIds: string[]): WidgetInstance[] {
  const made: WidgetInstance[] = defIds
    .map((def) => {
      const d = widgetDefOf(def);
      if (!d) return null;
      return {
        id: makeWidgetId(def),
        def,
        w: d.defaultW,
        h: d.defaultH,
        x: 0,
        y: 0,
      } satisfies WidgetInstance;
    })
    .filter((x): x is WidgetInstance => x !== null);
  return packWidgets(made);
}

// 内置出厂微件模板（当前为空）。
// watch / rank / news 三个卡曾被出厂微件化为简化微件（quote-list 自选列表、
// news-tape 滚动快讯），导致完整组件功能丢失（自选分组管理、榜单 8 Tab、
// 快讯分页/开窗）。已全部移除模板，恢复经典组件渲染；历史已迁移数据由
// widget-migrate 的 isUnmodifiedFactory 一次性还原。
// 机制保留：插件或后续卡片可继续通过 presetOf 提供出厂模板。
const PRESET_DEFS: Partial<Record<CardId, string[]>> = {};

export function presetOf(id: CardId): CardWidgets | undefined {
  const defs = PRESET_DEFS[id];
  if (!defs) return undefined;
  return { primary: null, items: buildItems(defs) };
}

export function hasPreset(id: CardId): boolean {
  return PRESET_DEFS[id] !== undefined;
}
