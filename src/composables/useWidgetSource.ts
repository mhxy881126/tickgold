// 微件只读数据源：弹窗（PipWindow）provide 一份只读 widgetsOf，
// 覆盖 WidgetCanvas 默认的 useWorkbench 取值，避免弹窗挂第二份可写状态。
import { inject, provide, type InjectionKey } from "vue";
import type { CardId } from "../lib/cards";
import type { CardWidgets } from "../lib/widgets";

export interface WidgetSource {
  widgetsOf(id: CardId): CardWidgets | undefined;
}

const KEY: InjectionKey<WidgetSource> = Symbol("widget-source");

export function provideWidgetSource(src: WidgetSource): void {
  provide(KEY, src);
}

// 缺省返回 null：主窗未 provide，WidgetCanvas 回落 useWorkbench
export function useWidgetSource(): WidgetSource | null {
  return inject(KEY, null);
}
