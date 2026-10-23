import type { OrderBook } from "../../api/types";

/**
 * 五档盘口方向自愈。
 *
 * 标准语义：asks = 卖盘，按 卖1(最低价)…卖5(最高价) 升序；bids = 买盘，按 买1(最高价)…买5(最低价) 降序。
 * 部分数据源（如东财 qt/stock/get 的 f 字段实测与接口文档相反）会把买卖盘互换返回：
 * asks 实为买盘（降序）、bids 实为卖盘（升序）。此处按"方向"检测并互换一次恢复标准语义，
 * 不做价格大小假设（正常盘口 ask1 本就 ≥ bid1）。
 */
export function normalizeBook(ob: OrderBook): OrderBook {
  const a = ob?.asks ?? [];
  const b = ob?.bids ?? [];
  const aDesc = a.length >= 2 && (a[0]?.price ?? 0) > (a[1]?.price ?? 0);
  const bAsc = b.length >= 2 && (b[0]?.price ?? 0) < (b[1]?.price ?? 0);
  if (aDesc && bAsc) return { ...ob, asks: b, bids: a };
  return ob;
}
