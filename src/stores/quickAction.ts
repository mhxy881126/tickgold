// 待处理下单方向（P2-b1 B/S 快捷键）。
// 快捷键触发时作战台卡片可能尚未挂载：方向先入队，BattleStation 挂载后消费一次，
// 避免「事件发出时监听方还没 mount」导致快捷键丢失方向。模块级单例，跨组件共享。
import { ref } from "vue";

export type OrderSide = "BUY" | "SELL";

/** 待消费的下单方向；null = 无待处理方向。 */
export const pendingOrderSide = ref<OrderSide | null>(null);

/** 请求作战台切到指定方向（只记账，不直接操作 DOM/组件）。 */
export function requestOrder(side: OrderSide) {
  pendingOrderSide.value = side;
}

/** 消费并清空待处理方向：同一方向只生效一次。 */
export function consumeOrderSide(): OrderSide | null {
  const side = pendingOrderSide.value;
  pendingOrderSide.value = null;
  return side;
}
