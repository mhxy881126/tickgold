// 交易成本模型（P2-4）：A 股费用 + 滑点 + 市场冲击成本。纯函数，可配置。
// 费用默认口径与后端 portfolio.rs 严格一致：
//   佣金 万2.5（双向，最低 5 元）；印花税 卖出 千0.5；过户费 双向 十万分之1。
// 滑点/冲击用于"回测与预期成交价估算"，不是实际成交价（实际成交以券商/交易所为准）。

export type Side = "buy" | "sell";

export interface FeeConfig {
  commissionRate: number; // 佣金费率（双向）
  commissionMin: number; // 单笔佣金最低（元）
  stampRate: number; // 印花税率（仅卖出）
  transferRate: number; // 过户费率（双向）
}

export const DEFAULT_FEE: FeeConfig = {
  commissionRate: 0.00025,
  commissionMin: 5,
  stampRate: 0.0005,
  transferRate: 0.00001,
};

/** 计算成交费用。amount=成交金额（价×量）。 */
export function calcFee(side: Side, amount: number, cfg: FeeConfig = DEFAULT_FEE): number {
  if (!(amount > 0)) return 0;
  const commission = Math.max(amount * cfg.commissionRate, cfg.commissionMin);
  const stamp = side === "sell" ? amount * cfg.stampRate : 0;
  const transfer = amount * cfg.transferRate;
  return commission + stamp + transfer;
}

export interface SlippageConfig {
  baseSlippage: number; // 固定滑点（比例，0.001=0.1%）
  linearImpact: number; // 线性冲击系数（参与率→价格冲击）
  nonlinearImpact: number; // 非线性冲击系数
  impactPower: number; // 非线性冲击幂次（>1，常见 1.5）
}

export const DEFAULT_SLIPPAGE: SlippageConfig = {
  baseSlippage: 0.001,
  linearImpact: 0.1,
  nonlinearImpact: 0.2,
  impactPower: 1.5,
};

/**
 * 市场冲击（比例）：参与率 participation = 订单股数 / 参考时段成交量（如日均量 ADV）。
 * 线性项刻画小单的比例冲击，非线性（幂）项刻画大单的加速冲击。
 */
export function marketImpact(
  participation: number,
  cfg: SlippageConfig = DEFAULT_SLIPPAGE
): number {
  const p = Math.max(0, participation);
  return cfg.linearImpact * p + cfg.nonlinearImpact * Math.pow(p, cfg.impactPower);
}

/**
 * 预期成交价（建模/估算）：
 * 买入在参考价上方、卖出在下方，让步 = 固定滑点 + 冲击。
 * participation 为订单相对参考成交量的参与率。
 */
export function expectedFillPrice(
  ref: number,
  side: Side,
  participation: number,
  cfg: SlippageConfig = DEFAULT_SLIPPAGE
): number {
  if (!(ref > 0)) return ref;
  const adj = cfg.baseSlippage + marketImpact(participation, cfg);
  return side === "buy" ? ref * (1 + adj) : ref * (1 - adj);
}

/**
 * 单笔订单的"预期总成本"（元）：显性费用 + 滑点/冲击的隐性成本。
 * refVolume=参考时段成交量（股）；用于估算参与率。
 */
export function expectedTotalCost(
  ref: number,
  side: Side,
  vol: number,
  refVolume: number,
  feeCfg: FeeConfig = DEFAULT_FEE,
  slipCfg: SlippageConfig = DEFAULT_SLIPPAGE
): { fee: number; slippageCost: number; fillPrice: number; total: number } {
  const participation = refVolume > 0 ? vol / refVolume : 0;
  const fill = expectedFillPrice(ref, side, participation, slipCfg);
  const amount = fill * vol;
  const fee = calcFee(side, amount, feeCfg);
  // 隐性成本 = 相对参考价的让步金额（买入多付、卖出少收）
  const slippageCost = Math.abs(fill - ref) * vol;
  return { fee, slippageCost, fillPrice: fill, total: fee + slippageCost };
}
