// 待处理下单方向 / 预填（P2-b1 B/S 快捷键、P3-b 盘口与分时点击）。
// 快捷键或图表点击触发时作战台卡片可能尚未挂载：方向与价格先入队，
// BattleStation 挂载后消费一次，避免「事件发出时监听方还没 mount」导致输入丢失。
// 模块级单例，跨组件共享。
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

/** 盘口 / 分时点击要预填到下单条的内容：side 缺省表示沿用当前方向。 */
export interface OrderPrefill {
  code: string;
  side?: OrderSide;
  price: number;
}

/** 待消费的下单预填内容；null = 无。 */
export const pendingOrderPrefill = ref<OrderPrefill | null>(null);

/**
 * 待消费的预填价格（与 pendingOrderPrefill 同步，仅作 watcher 的触发信号）。
 * 作战台已挂载时 watch 它即可立即消费；未挂载则保留到挂载时 consume。
 */
export const pendingPrice = ref<number | null>(null);

/** 请求作战台预填下单条（代码 / 可选方向 / 价格）；非法输入直接忽略。 */
export function requestOrderPrefill(prefill: OrderPrefill) {
  const code = typeof prefill?.code === "string" ? prefill.code.trim() : "";
  const price = Number(prefill?.price);
  if (!code || !Number.isFinite(price) || price <= 0) return;
  pendingOrderPrefill.value = {
    code,
    ...(prefill.side ? { side: prefill.side } : {}),
    price,
  };
  pendingPrice.value = price;
}

/** 消费并清空预填：同一份预填只生效一次。 */
export function consumeOrderPrefill(): OrderPrefill | null {
  const prefill = pendingOrderPrefill.value;
  pendingOrderPrefill.value = null;
  pendingPrice.value = null;
  return prefill;
}
