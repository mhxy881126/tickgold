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

const PRESET_DEFS: Partial<Record<CardId, string[]>> = {
  // K线图卡恢复为经典完整组件（StockChart：全周期/指标/画线），不再出厂微件化
  watch: ["quote-list"],
  rank: ["quote-list"],
  news: ["news-tape"],
};

export function presetOf(id: CardId): CardWidgets | undefined {
  const defs = PRESET_DEFS[id];
  if (!defs) return undefined;
  return { primary: null, items: buildItems(defs) };
}

export function hasPreset(id: CardId): boolean {
  return PRESET_DEFS[id] !== undefined;
}
