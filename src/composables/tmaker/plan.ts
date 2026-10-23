/**
 * P3-7 盘前做T计划（纯函数）：9:25 竞价后生成当日网格表。
 *
 * 中枢 = 竞价价（开盘价，9:25 后 quote.open）或昨收兜底；
 * 区间 = 日线 ATR%；档位 = 中枢 ± ATR×k 的等差网格（k=0.5/1.0/1.5）；
 * 买入档不破近 5 日支撑，卖出档不超近 5 日压力；每档数量均分 baseVol（不足一手剔除）；
 * 不做名单：昨日强平>2、连续亏损≥2、波动过小、涨跌停附近、流动性不足。
 */
import { round2, clamp } from "./features";

export type PlanSide = "buy" | "sell";

export interface PlanLevel {
  side: PlanSide;
  price: number;       // 挂单价（round2）
  vol: number;         // 该档数量（100 的整数倍）
  gapPct: number;      // 距中枢 %（正=高于中枢）
  note: string;        // 如 "低吸档2" / "回补档1"
}

export interface DayPlanInput {
  code: string;
  name: string;
  date: string;              // YYYYMMDD
  auctionPrice: number;      // 竞价价（今开）；0/NaN 时回退 prevClose
  prevClose: number;
  atrPct: number;            // 日线 ATR%（>0）
  supportLow: number;        // 近 5 日支撑（买入档最低价不下破）
  resistHigh: number;        // 近 5 日压力（卖出档最高价不上破）
  baseVol: number;           // 计划总量（股）
  skipReasons: string[];     // 不做名单原因（已有则跳过生成）
  limitUpPct?: number;       // 涨停幅%（如 10），竞价贴板时禁买
  limitDownPct?: number;     // 跌停幅%，竞价贴板时禁卖
}

export interface DayPlan {
  date: string;
  code: string;
  name: string;
  center: number;
  atrPct: number;
  levels: PlanLevel[];
  skip: string[];
  generatedAt: number;
}

/** 档位阶梯系数 */
const STEPS = [0.5, 1.0, 1.5];

export function buildDayPlan(inp: DayPlanInput): DayPlan {
  const skip = [...inp.skipReasons];
  const center = inp.auctionPrice > 0 && Number.isFinite(inp.auctionPrice) ? inp.auctionPrice : inp.prevClose;
  const base = center > 0 ? center : 10; // 兜底防除零

  const plan: DayPlan = {
    date: inp.date,
    code: inp.code,
    name: inp.name,
    center: base,
    atrPct: inp.atrPct,
    levels: [],
    skip,
    generatedAt: Date.now(),
  };

  if (skip.length > 0) return plan; // 不做名单命中 → 只留原因

  const atr = Math.max(0.1, inp.atrPct || 0.5); // ATR 过小兜底 0.5%
  const volPer = Math.floor(inp.baseVol / (STEPS.length * 2) / 100) * 100;

  for (const k of STEPS) {
    const gap = atr * k;
    const buy = round2(base * (1 - gap / 100));
    const sell = round2(base * (1 + gap / 100));
    // 买入档不破支撑（留 0.3% 余量）；卖出档不超压力
    if (inp.supportLow > 0 && buy < inp.supportLow * 0.997) {
      // 下破支撑的档位剔除
    } else if (volPer >= 100) {
      plan.levels.push({ side: "buy", price: buy, vol: volPer, gapPct: -gap, note: `低吸档${k === 0.5 ? "1" : k === 1 ? "2" : "3"}` });
    }
    if (inp.resistHigh > 0 && sell > inp.resistHigh * 1.003) {
      // 上破压力的档位剔除
    } else if (volPer >= 100) {
      plan.levels.push({ side: "sell", price: sell, vol: volPer, gapPct: gap, note: `高抛档${k === 0.5 ? "1" : k === 1 ? "2" : "3"}` });
    }
  }

  // 贴板守卫：竞价涨幅接近涨停 → 禁买入档；接近跌停 → 禁卖出档
  if (inp.limitUpPct && inp.prevClose > 0) {
    const upPct = ((base - inp.prevClose) / inp.prevClose) * 100;
    if (upPct >= inp.limitUpPct - 0.3) {
      plan.levels = plan.levels.filter((l) => l.side !== "buy");
      plan.skip.push(`竞价接近涨停（+${upPct.toFixed(1)}%），禁低吸`);
    }
  }
  if (inp.limitDownPct && inp.prevClose > 0) {
    const dnPct = ((inp.prevClose - base) / inp.prevClose) * 100;
    if (dnPct >= inp.limitDownPct - 0.3) {
      plan.levels = plan.levels.filter((l) => l.side !== "sell");
      plan.skip.push(`竞价接近跌停（-${dnPct.toFixed(1)}%），禁高抛`);
    }
  }

  // 数量兜底：单档不足一手时置 0 并剔除
  plan.levels = plan.levels.filter((l) => l.vol >= 100);
  return plan;
}

/** 不做名单规则（给调用方装配 skipReasons） */
export function skipReasonsOf(opts: {
  forcedCloseToday: number;   // 昨日强平笔数
  streakLoss: number;         // 连续亏损笔数
  atrPct: number;             // ATR%
  amount5d: number;           // 近 5 日成交额（元）
  minAmount?: number;         // 默认 3e8
}): string[] {
  const minAmt = opts.minAmount ?? 3e8;
  const out: string[] = [];
  if (opts.forcedCloseToday > 2) out.push(`昨日尾盘强平 ${opts.forcedCloseToday} 笔，纪律休息一日`);
  if (opts.streakLoss >= 2) out.push(`连续亏损 ${opts.streakLoss} 笔，触发熔断休息`);
  if (opts.atrPct < 0.5) out.push(`波动过小（ATR ${opts.atrPct.toFixed(2)}%），做T空间不足`);
  if (opts.amount5d < minAmt) out.push(`流动性不足（近5日成交额 ${(opts.amount5d / 1e8).toFixed(1)}亿 < ${(minAmt / 1e8).toFixed(0)}亿）`);
  return out;
}

export { clamp };
