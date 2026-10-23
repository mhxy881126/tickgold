// 前端费用估算：与 Rust 端 broker::portfolio::calc_fee 保持同口径（全应用唯一费用口径）。
// 佣金万 2.5（双向，最低 5 元）+ 印花税千 0.5（卖出单边）+ 过户费十万 1（双向）。
// 用途：做T决策台预估算费、门槛价、成本提示；模拟盘实际费用以后端 FillResult.fee 为准。

export const COMMISSION_RATE = 0.00025; // 佣金 万2.5（双向，最低 5 元）
export const COMMISSION_MIN = 5;
export const STAMP_RATE = 0.0005; // 印花税 卖出 千0.5
export const TRANSFER_RATE = 0.00001; // 过户费 十万分之一（双向）

export interface FeeBreakdown {
  commission: number;
  stamp: number;
  transfer: number;
  total: number;
}

/** 单边费用（与 Rust calc_fee 一致） */
export function estimateFee(side: "buy" | "sell", amount: number): FeeBreakdown {
  if (!(amount > 0)) return { commission: 0, stamp: 0, transfer: 0, total: 0 };
  const commission = Math.max(amount * COMMISSION_RATE, COMMISSION_MIN);
  const stamp = side === "sell" ? amount * STAMP_RATE : 0;
  const transfer = amount * TRANSFER_RATE;
  return { commission, stamp, transfer, total: commission + stamp + transfer };
}

/** 往返（买+卖）成本占成交额的百分比；vol 为股数、price 为成交价 */
export function roundTripFeeRate(vol: number, price: number): number {
  if (!(vol > 0) || !(price > 0)) return 0;
  const amount = vol * price;
  const buy = estimateFee("buy", amount).total;
  const sell = estimateFee("sell", amount).total;
  return ((buy + sell) / amount) * 100;
}

/** 单笔金额的往返费率百分比（按 1 手 = 100 股） */
export function roundTripFeeRateOfHands(price: number, lots: number = 1): number {
  return roundTripFeeRate(lots * 100, price);
}
