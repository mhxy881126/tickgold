import type { OrderBook } from "../../api/types";

/**
 * 五档盘口方向自愈。
 *
 * 标准语义：asks = 卖盘，按 卖1(最低价)…卖5(最高价) 升序；bids = 买盘，按 买1(最高价)…买5(最低价) 降序。
 * 数据源反序分为两类，分别处理：
 * 1. 买卖盘整体互换（东财 qt/stock/get 的 f 字段实测与接口文档相反：asks 实为买盘降序、bids 实为卖盘升序）
 *    → 检测到 aDesc && bAsc 时 swap 恢复，保持买卖盘配对、避免价格倒挂；
 * 2. 单边反序（如一字涨停/跌停时另一侧为空，或部分数据源仅某一侧方向异常）
 *    → 单独反转该侧。不做价格大小假设（正常盘口 ask1 本就 ≥ bid1）。
 */
export function normalizeBook(ob: OrderBook): OrderBook {
  const a = ob?.asks ?? [];
  const b = ob?.bids ?? [];
  const px = ob?.price ?? 0;
  const aDesc = a.length >= 2 && (a[0]?.price ?? 0) > (a[1]?.price ?? 0);
  const bAsc = b.length >= 2 && (b[0]?.price ?? 0) < (b[1]?.price ?? 0);
  // 涨停/跌停单边兜底：一侧为空时方向无法判断，改用现价识别身份——
  // 卖盘整体应 ≥ 现价、买盘整体应 ≤ 现价；asks 中位低于现价 = 实为买盘，bids 中位高于现价 = 实为卖盘。
  // 用中位而非首档，避免"卖1=现价"的正常盘口被误判。
  const aIsBuy = px > 0 && a.length >= 3 && (a[Math.floor(a.length / 2)]?.price ?? 0) < px;
  const bIsSell = px > 0 && b.length >= 3 && (b[Math.floor(b.length / 2)]?.price ?? 0) > px;
  if ((aDesc && bAsc) || (aIsBuy && b.length === 0) || (bIsSell && a.length === 0)) {
    return { ...ob, asks: b, bids: a };
  }
  if (aDesc) return { ...ob, asks: [...a].reverse() };
  if (bAsc) return { ...ob, bids: [...b].reverse() };
  return ob;
}
