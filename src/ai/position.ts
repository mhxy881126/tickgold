// 仓位管理：凯利公式（半凯利）+ 风险预算 + 单票 / 行业集中度 + 总仓位随大盘状态调节，
// 输出目标仓位比例与买入股数（向下取整到 100 股）。纯函数，可在 node 单测。

function clampNum(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** 凯利公式 f* = (b·p − q)/b；p=胜率、b=盈亏比、q=1−p */
export function kellyFraction(p: number, b: number): number {
  if (b <= 0) return 0;
  const f = (b * p - (1 - p)) / b;
  return Math.max(0, f);
}

/** 半凯利（实战更稳健，降低参数误差冲击） */
export function halfKelly(p: number, b: number): number {
  return kellyFraction(p, b) / 2;
}

export type MarketRegime = "up" | "flat" | "down";

export interface HoldingLike {
  code: string;
  value: number;
  sector?: string;
}

export interface PositionPlanInput {
  code: string;
  price: number;
  /** 信号置信度 0–1（映射为胜率，保守截断） */
  confidence: number;
  cash: number;
  totalAssets: number;
  holdings: HoldingLike[];
  marketRegime: MarketRegime;
  sector?: string;
  singleCap?: number;  // 单票上限，默认 0.25
  sectorCap?: number;  // 单行业上限，默认 0.4
  winLossRatio?: number; // 盈亏比，默认 2
}

export interface PositionPlan {
  targetPct: number;
  vol: number;
  reason: string;
}

const REGIME_CAP: Record<MarketRegime, number> = { up: 0.9, flat: 0.6, down: 0.3 };

/** 规划一次买入的目标仓位与股数 */
export function planPosition(input: PositionPlanInput): PositionPlan {
  const singleCap = input.singleCap ?? 0.25;
  const sectorCap = input.sectorCap ?? 0.4;
  const b = input.winLossRatio ?? 2;
  const regimeCap = REGIME_CAP[input.marketRegime];

  // 置信度 → 胜率（保守截断到 0.40–0.85，避免过度自信）
  const p = clampNum(input.confidence, 0.4, 0.85);
  const kelly = halfKelly(p, b);
  let targetPct = Math.min(kelly, singleCap);

  // 总仓位约束（当前敞口 + 目标 ≤ 大盘上限）
  const heldValue = input.holdings.reduce((s, h) => s + h.value, 0);
  const exposure = input.totalAssets > 0 ? heldValue / input.totalAssets : 0;
  targetPct = Math.min(targetPct, Math.max(0, regimeCap - exposure));

  // 行业集中度约束
  if (input.sector) {
    const sectorValue = input.holdings
      .filter((h) => h.sector === input.sector)
      .reduce((s, h) => s + h.value, 0);
    const sectorExposure = input.totalAssets > 0 ? sectorValue / input.totalAssets : 0;
    targetPct = Math.min(targetPct, Math.max(0, sectorCap - sectorExposure));
  }

  const budget = Math.min(input.totalAssets * targetPct, input.cash);
  const vol = input.price > 0 ? Math.floor(budget / input.price / 100) * 100 : 0;

  return {
    targetPct,
    vol,
    reason: `半凯利 ${(kelly * 100).toFixed(0)}% → 目标 ${(targetPct * 100).toFixed(0)}%、${vol} 股（大盘 ${input.marketRegime}，总仓上限 ${(regimeCap * 100).toFixed(0)}%）`,
  };
}
