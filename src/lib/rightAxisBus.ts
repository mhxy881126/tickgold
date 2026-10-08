// 右侧涨跌百分比轴事件总线。
// 作用：thsLevels 指标在任意 chart 实例中 draw 时，把百分比刻度按 axisId 广播，
// 主图 / 历史复盘弹窗各自订阅属于自己的 axisId，更新自己的 HTML 右轴，
// 避免指标闭包只能指向单一组件、以及 canvas 内文字被裁剪的问题。

export interface RightAxisItem {
  coord: number; // y 像素（相对该 pane bounding）
  pct: number;   // 涨跌幅 %
}

type Listener = (items: RightAxisItem[]) => void;

const listeners = new Map<string, Set<Listener>>();

/** 订阅某个 axisId 的右轴数据，返回取消订阅函数 */
export function onRightAxis(axisId: string, fn: Listener): () => void {
  let set = listeners.get(axisId);
  if (!set) {
    set = new Set();
    listeners.set(axisId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
  };
}

/** 广播某个 axisId 的右轴刻度 */
export function emitRightAxis(axisId: string, items: RightAxisItem[]) {
  const set = listeners.get(axisId);
  if (!set) return;
  set.forEach((fn) => fn(items));
}
