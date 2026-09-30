// 微件注册表：id → WidgetDef。卡内编排的托盘与渲染都从这里取定义。
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

const MAP = new Map<string, WidgetDef>(WIDGET_DEFS.map((d) => [d.id, d]));

export function widgetDefOf(id: string): WidgetDef | undefined {
  return MAP.get(id);
}

export function hasSingleton(items: { def: string }[], defId: string): boolean {
  const def = MAP.get(defId);
  return !!def?.singleton && items.some((i) => i.def === defId);
}
