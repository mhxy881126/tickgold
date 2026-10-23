/**
 * 做T分批网格 · 档位规划（P1-5）：纯函数，可单测。
 *
 * 思路：在"支撑区 → VWAP"（正T）或"VWAP → 压力区"（倒T）之间，从现价起
 * 按 0.5×ATR% 间距向有利方向布 2-3 档，每档均分总量；超出支撑/压力边界的
 * 档位剔除（不挂破位单）。每档独立成腿，支持部分成交与一键全平。
 */
import { clamp, round2 } from "./features";

export interface GridLevel {
  price: number; // 档位委托价（0.01 取整）
  vol: number;   // 档位数量（100 股整数倍）
}

export interface GridPlan {
  levels: GridLevel[];
  count: number;
  totalVol: number;
  /** 是否因为触及边界而减少档数（提示用户） */
  truncated: boolean;
}

/** 间距 %：0.5×ATR%，下限 0.3%（波动太小不密布） */
export function gridGapPct(atrPct: number): number {
  return clamp(0.5 * atrPct, 0.3, 1.5);
}

function levelVol(totalVol: number, count: number): number {
  const v = Math.floor(totalVol / count / 100) * 100;
  return Math.max(0, v);
}

/**
 * 正T网格：从现价向下方布档（回踩分批买入），不低于近5日支撑。
 * @param price 现价
 * @param vwap 分时均价（上方边界，不强制使用）
 * @param support 近5日支撑（下限）
 * @param atrPct 日线 ATR%
 * @param totalVol 计划总量（100 股整数倍）
 * @param maxLevels 最多档数（默认 3）
 */
export function gridPlanLong(
  price: number,
  support: number,
  atrPct: number,
  totalVol: number,
  maxLevels = 3,
): GridPlan {
  if (!(price > 0) || !(totalVol >= 100)) return { levels: [], count: 0, totalVol: 0, truncated: false };
  const gap = gridGapPct(atrPct) / 100;
  const levels: GridLevel[] = [];
  let truncated = false;
  for (let i = 1; i <= maxLevels; i++) {
    const p = round2(price * (1 - gap * i));
    if (support > 0 && p < support) { truncated = true; break; } // 不挂破位单
    if (p >= price) break; // 浮点保护
    levels.push({ price: p, vol: 0 });
  }
  if (!levels.length) return { levels: [], count: 0, totalVol: 0, truncated };
  const count = levels.length;
  const each = levelVol(totalVol, count);
  if (each < 100) return { levels: [], count: 0, totalVol: 0, truncated };
  const withVol = levels.map((l) => ({ price: l.price, vol: each }));
  return {
    levels: withVol,
    count,
    totalVol: each * count,
    truncated,
  };
}

/**
 * 倒T网格：从现价向上方布档（反抽分批卖出），不高于近5日压力。
 */
export function gridPlanShort(
  price: number,
  resist: number,
  atrPct: number,
  totalVol: number,
  maxLevels = 3,
): GridPlan {
  if (!(price > 0) || !(totalVol >= 100)) return { levels: [], count: 0, totalVol: 0, truncated: false };
  const gap = gridGapPct(atrPct) / 100;
  const levels: GridLevel[] = [];
  let truncated = false;
  for (let i = 1; i <= maxLevels; i++) {
    const p = round2(price * (1 + gap * i));
    if (resist > 0 && p > resist) { truncated = true; break; } // 不挂追高单
    if (p <= price) break; // 浮点保护
    levels.push({ price: p, vol: 0 });
  }
  if (!levels.length) return { levels: [], count: 0, totalVol: 0, truncated };
  const count = levels.length;
  const each = levelVol(totalVol, count);
  if (each < 100) return { levels: [], count: 0, totalVol: 0, truncated };
  const withVol = levels.map((l) => ({ price: l.price, vol: each }));
  return {
    levels: withVol,
    count,
    totalVol: each * count,
    truncated,
  };
}
