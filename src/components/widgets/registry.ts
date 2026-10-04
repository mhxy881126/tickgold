// 微件注册表：id → WidgetDef。卡内编排的托盘与渲染都从这里取定义。
// v2.6：内置微件为编译期静态数组；插件微件在运行时经 addWidgetDef 动态注册、
// removeWidgetDef 注销（停用/卸载）。MAP 用 reactive 包裹，托盘列表自动更新。
import { reactive } from "vue";
import type { WidgetDef } from "../../lib/widgets";
import QuoteHead from "./QuoteHead.vue";
import MinuteChart from "./MinuteChart.vue";
import KlineMini from "./KlineMini.vue";
import QuoteList from "./QuoteList.vue";
import NewsTape from "./NewsTape.vue";
import TextNote from "./TextNote.vue";

export const WIDGET_DEFS: WidgetDef[] = [
  {
    id: "quote-head", title: "报价块", component: QuoteHead,
    minW: 4, minH: 3, defaultW: 5, defaultH: 3, binding: "stock",
  },
  {
    id: "minute-chart", title: "分时图", component: MinuteChart,
    minW: 4, minH: 3, defaultW: 8, defaultH: 5, binding: "stock",
  },
  {
    id: "kline-mini", title: "迷你K线", component: KlineMini,
    minW: 4, minH: 4, defaultW: 8, defaultH: 6, binding: "stock",
  },
  {
    id: "quote-list", title: "行情列表", component: QuoteList,
    minW: 4, minH: 4, defaultW: 12, defaultH: 7, binding: "none",
  },
  {
    id: "news-tape", title: "盘中快讯", component: NewsTape,
    minW: 4, minH: 3, defaultW: 12, defaultH: 6, binding: "none",
  },
  {
    id: "text-note", title: "文字/分隔线", component: TextNote,
    minW: 2, minH: 1, defaultW: 4, defaultH: 2, binding: "none",
  },
];

const MAP: Map<string, WidgetDef> = reactive(
  new Map(WIDGET_DEFS.map((d) => [d.id, d] as [string, WidgetDef])),
);
const BUILTIN_IDS = new Set(WIDGET_DEFS.map((d) => d.id));

export function widgetDefOf(id: string): WidgetDef | undefined {
  return MAP.get(id);
}

/** 托盘用：当前全部可用微件（内置 + 已注册插件）。 */
export function listWidgetDefs(): WidgetDef[] {
  return Array.from(MAP.values());
}

/** 注册一个（插件）微件定义；同 id 覆盖（热重载场景）。 */
export function addWidgetDef(def: WidgetDef): void {
  MAP.set(def.id, def);
}

/** 注销插件微件；内置微件不可删。 */
export function removeWidgetDef(id: string): void {
  if (BUILTIN_IDS.has(id)) return;
  MAP.delete(id);
}

export function hasSingleton(items: { def: string }[], defId: string): boolean {
  const def = MAP.get(defId);
  return !!def?.singleton && items.some((i) => i.def === defId);
}
