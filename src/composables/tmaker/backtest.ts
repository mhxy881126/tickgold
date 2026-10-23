/**
 * P3 分钟级做T回测器（前端 TS，与实盘信号引擎同源）。
 *
 * 为什么放前端而不是文档建议的 Rust（tbacktest.rs）：
 * 1) 信号判定复用 `src/composables/tmaker/features.ts`（biasZ/regime/打分卡全部同源），
 *    避免"回测一套、实盘一套"的作弊风险——这是量化回测的第一原则；
 * 2) 费用用 `src/utils/fees.ts`（P0 已与 Rust calc_fee 对拍一致），滑点口径与 P2 撮合同源；
 * 3) 迭代与单测快。数据源 `get_hist_minute_days`（免费源仅近 5 日，每日收盘落库累积是 P3 后续项）。
 *
 * 正确性纪律（防未来函数）：
 * - 支撑/压力/ATR/近5日成交额：只用该日【之前】的日线（截至昨日收盘）；
 * - biasZ/分时特征：用截至当前 bar 的日内数据（逐根推进，天然无未来）；
 * - 撮合：触发 bar 的收盘价 ×(1±滑点)，分钟粒度保守近似。
 *
 * 口径说明：盘口/逐笔因子在分钟回测中不可用 → 给中性值（0），打分因此偏保守，
 * 回测结果宁低估不虚高；A股 T+1 实盘下"先买后卖"的正T闭环需隔日，本回测按项目
 * 模拟盘"当日闭环"口径运行并如实标注。
 */
import type { KBar } from "../../api/types";
import type { HistDayMinute } from "../../api/market";
import {
  clamp, biasZOf, atrPctOf, vwapSlopeBpMin, sideStreakOf, minuteR2,
  relativeStrength, regimeOf, regimeAllows, scoreLong, scoreShort,
  summarize, gradeOf,
} from "./features";
import type { Regime, ScoreResult } from "./features";
import { estimateFee } from "../../utils/fees";

// ============ 回测参数（默认值与实盘 useTmaker 常量一致） ============
export interface BtParams {
  maxBiasPct: number;       // 乖离极端阈值（extreme 禁开仓）
  scoreOpen: number;        // 强信号开仓分数线（默认 75）
  scorePrep: number;        // 预备信号线（默认 60，仅展示）
  minSpreadBasePct: number; // 价差门槛下限 %
  minSpreadCostMult: number; // 门槛 = 往返成本率 × 倍数
  stopMinPct: number;       // ATR 止损下限 %
  stopMaxPct: number;       // ATR 止损上限 %
  targetMult: number;       // 目标 = 止损 × 倍数
  targetMinPct: number;
  targetMaxPct: number;
  slipPct: number;          // 滑点 %（与 P2 撮合同源）
  riskPerTrade: number;     // 单笔风险 = 底仓市值比例（1R）
  baseVol: number;          // 模拟底仓股数（用于 1R 反推与倒T可用量）
  maxPerDay: number;        // 单日最多开仓次数
  cooldownBars: number;     // 同方向冷却（分钟数）
  confirmBars: number;      // 开仓信号连续确认根数
  forceCloseMin: number;    // 尾盘强平分钟（14:50 → 890）
  openObserveUntilMin: number; // 观察期（9:45 → 585）
  lateBlockFromMin: number; // 14:30 → 870 后不开新仓
  minAmount5d: number;      // 近5日日均成交额下限（元）
  minTurnoverPct: number;
  maxTurnoverPct: number;
  limitGuardPct: number;    // 距涨跌停禁开仓比例（0.3%）
  marketCrashPct: number;   // 大盘急跌阈值（回测无大盘 → 0，不触发）
}

export const DEFAULT_BT_PARAMS: BtParams = {
  maxBiasPct: 3,
  scoreOpen: 75,
  scorePrep: 60,
  minSpreadBasePct: 0.5,
  minSpreadCostMult: 2.5,
  stopMinPct: 1.0,
  stopMaxPct: 1.5,
  targetMult: 1.5,
  targetMinPct: 0.8,
  targetMaxPct: 2.5,
  slipPct: 0.05,
  riskPerTrade: 0.005,
  baseVol: 10000,
  maxPerDay: 2,
  cooldownBars: 5,
  confirmBars: 2,
  forceCloseMin: 890,
  openObserveUntilMin: 585,
  lateBlockFromMin: 870,
  minAmount5d: 3e8,
  minTurnoverPct: 1,
  maxTurnoverPct: 15,
  limitGuardPct: 0.3,
  marketCrashPct: -1.5,
};

// ============ 输出结构 ============
export interface BtTrade {
  date: string;             // YYYYMMDD
  type: "long" | "short";
  openIdx: number;          // 日内分钟序号
  openTime: string;         // HH:mm
  openPrice: number;
  closeIdx: number;
  closeTime: string;
  closePrice: number;
  vol: number;
  gross: number;            // 毛利
  fee: number;              // 往返实际费用（与实盘同口径）
  pnl: number;              // 净盈亏
  holdBars: number;
  reason: string;           // 平仓原因：target/stop/force
  score: number;            // 开仓信号分
  regime: Regime;
}

export interface BtDay {
  date: string;
  trades: BtTrade[];
  dayPnl: number;
  dayFees: number;
  forcedClose: boolean;
  baselineDayPnl: number;   // 底仓不动当日收益（对照）
}

export interface BtHourBucket {
  label: string;
  count: number;
  pnl: number;
  winRate: number;
}

export interface BtResult {
  code: string;
  days: BtDay[];
  trades: BtTrade[];
  params: BtParams;
  // 总体统计
  totalPnl: number;
  feeTotal: number;
  count: number;
  winRate: number;
  avgPnl: number;
  profitFactor: number;
  maxDrawdown: number;
  forcedCloseCount: number;
  // 分组
  long: { count: number; winRate: number; pnl: number };
  short: { count: number; winRate: number; pnl: number };
  byHour: BtHourBucket[];
  perDayPnl: number[];
  baselinePnl: number;      // 区间底仓不动总收益（对照）
  // 保本胜率参考：在成本模型下的做T保本胜率
  breakEvenWinRate: number;
  sampleDays: number;
}

// ============ 工具 ============
function hhmmOf(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function minOf(ts: number): number {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round100(n: number): number {
  return Math.max(0, Math.floor(n / 100) * 100);
}
function dateOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
/** 近 N 个完整交易日（升序切片，剔除传入的当日） */
function recentDailyBars(bars: KBar[], n: number): KBar[] {
  if (!bars.length) return [];
  const sorted = [...bars].sort((a, b) => a.timestamp - b.timestamp);
  return sorted.slice(-n);
}
/** 分时均价序列 map（与实盘 buildAvgMap 同口径：累计额/累计量） */
function buildAvgMap(bars: KBar[]): Map<number, number> {
  const m = new Map<number, number>();
  let cAmt = 0, cVol = 0;
  for (const b of bars) {
    cVol += b.volume;
    cAmt += b.volume * 100 * b.close; // 无 amount 字段，按量×100×收估算
    m.set(b.timestamp, cVol > 0 ? cAmt / (cVol * 100) : b.close);
  }
  return m;
}
/** 日内拐头：止跌回升 / 冲高回落（与实盘 minuteTurn 同逻辑） */
function turnOf(bars: KBar[], dir: "up" | "down"): boolean {
  if (bars.length < 3) return false;
  const a = bars[bars.length - 3];
  const b = bars[bars.length - 2];
  const c = bars[bars.length - 1];
  if (dir === "up") {
    return c.close >= b.close && b.close <= a.close && c.volume > b.volume * 1.05;
  }
  return c.close <= b.close && b.close >= a.close && c.volume > b.volume * 1.05;
}

// ============ 主入口 ============
export function runBacktest(
  code: string,
  minuteDays: HistDayMinute[],
  dailyBars: KBar[],
  params: BtParams = DEFAULT_BT_PARAMS,
  debug?: (d: { day: string; idx: number; min: number; bias: number; z: number; regime: Regime; score: number; dir: "long" | "short" | ""; confirm: number; openCount: number; legs: number }) => void,
): BtResult {
  const P = params;
  const days = [...minuteDays].sort((a, b) => (a.date < b.date ? -1 : 1));
  const dailies = [...dailyBars].sort((a, b) => a.timestamp - b.timestamp);
  const trades: BtTrade[] = [];
  const dayResults: BtDay[] = [];
  const perDayPnl: number[] = [];

  for (const day of days) {
    const bars = [...day.bars].sort((a, b) => a.timestamp - b.timestamp);
    if (!bars.length) continue;
    // —— 截至昨日的日线上下文（防未来函数）——
    const dayStartTs = bars[0].timestamp;
    const priorDailies = dailies.filter((b) => b.timestamp < dayStartTs);
    const recent = recentDailyBars(priorDailies, 5);
    const supportLow = recent.length ? Math.min(...recent.map((b) => b.low)) : 0;
    const resistHigh = recent.length ? Math.max(...recent.map((b) => b.high)) : 0;
    const atrPct = atrPctOf(priorDailies, 14);
    const amount5d = recent.length
      ? recent.reduce((s, b) => s + b.volume * 100 * b.close, 0) / recent.length
      : 0;
    const prevClose = dailies.filter((b) => b.timestamp < dayStartTs).pop()?.close ?? bars[0].open;
    const dayLimitUp = prevClose * 1.1;
    const dayLimitDown = prevClose * 0.9;

    // —— 日内推进（升序）——
    const avgMap = buildAvgMap(bars);
    const avgOf = (ts: number) => avgMap.get(ts);
    const legs: {
      type: "long" | "short";
      openPrice: number;
      vol: number;
      openIdx: number;
      openTime: string;
      openFee: number;
      stopPct: number;
      targetPct: number;
      score: number;
      regime: Regime;
    }[] = [];
    let dayPnl = 0, dayFees = 0;
    let forcedClose = false;
    let lastOpenMin = -999;
    let openCount = 0;
    let confirmDir: "long" | "short" | "" = "";
    let confirmStreak = 0;

    const dayTrades: BtTrade[] = [];

    const closeLegs = (
      idx: number,
      reason: string,
      force: boolean,
    ) => {
      const price = bars[idx].close;
      for (const l of legs) {
        const side: "buy" | "sell" = l.type === "long" ? "sell" : "buy";
        const px = round2(side === "sell" ? price * (1 - P.slipPct / 100) : price * (1 + P.slipPct / 100));
        const amount = px * l.vol;
        const closeFee = estimateFee(side, amount).total;
        const gross = l.type === "long"
          ? (px - l.openPrice) * l.vol
          : (l.openPrice - px) * l.vol;
        const fee = l.openFee + closeFee;
        const pnl = gross - fee;
        dayPnl += pnl;
        dayFees += fee;
        const t: BtTrade = {
          date: day.date,
          type: l.type,
          openIdx: l.openIdx,
          openTime: l.openTime,
          openPrice: l.openPrice,
          closeIdx: idx,
          closeTime: hhmmOf(bars[idx].timestamp),
          closePrice: px,
          vol: l.vol,
          gross,
          fee,
          pnl,
          holdBars: idx - l.openIdx,
          reason,
          score: l.score,
          regime: l.regime,
        };
        dayTrades.push(t);
        trades.push(t);
      }
      legs.length = 0;
      if (force) forcedClose = true;
    };

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const px = b.close;
      const m = minOf(b.timestamp);
      // —— 1) 在途腿处理 ——
      if (legs.length) {
        // 尾盘强平（14:50 起）
        if (m >= P.forceCloseMin) {
          closeLegs(i, "force", true);
          continue;
        }
        // 止损 / 目标（逐腿）
        const l0 = legs[0];
        const stopP = l0.stopPct;
        const tgtP = l0.targetPct;
        const hitStop = l0.type === "long" ? px <= l0.openPrice * (1 - stopP / 100) : px >= l0.openPrice * (1 + stopP / 100);
        const hitTarget = l0.type === "long" ? px >= l0.openPrice * (1 + tgtP / 100) : px <= l0.openPrice * (1 - tgtP / 100);
        if (hitStop) { closeLegs(i, "stop", false); continue; }
        if (hitTarget) { closeLegs(i, "target", false); continue; }
        continue; // 持仓中不处理新开仓
      }

      // —— 2) 无在途：开仓判定 ——
      if (m < P.openObserveUntilMin) continue;       // 观察期
      if (m >= P.lateBlockFromMin) continue;          // 14:30 后不开新仓
      if (openCount >= P.maxPerDay) continue;         // 日次数熔断
      if (m - lastOpenMin < P.cooldownBars) continue; // 冷却
      if (amount5d < P.minAmount5d) continue;         // 流动性
      if (recent.length < 5) continue;                // 历史上下文不足

      // 涨跌停附近禁开仓
      if (px >= dayLimitUp * (1 - P.limitGuardPct / 100)) continue;
      if (px <= dayLimitDown * (1 + P.limitGuardPct / 100)) continue;

      // —— 特征（截至当前 bar，无未来）——
      const barsUpTo = bars.slice(0, i + 1);
      const curBias = avgOf(b.timestamp) && avgOf(b.timestamp)! > 0
        ? ((px - avgOf(b.timestamp)!) / avgOf(b.timestamp)!) * 100
        : 0;
      const biasZ = biasZOf(curBias, barsUpTo, avgOf);
      // VWAP 斜率：只取截至当前 bar 的序列（防止把当日未来数据算进 regime）
      const sortedTs = [...avgMap.keys()].sort((a, b) => a - b);
      const curIdx = sortedTs.indexOf(b.timestamp);
      const avgsUpTo = sortedTs.slice(0, curIdx + 1).map((ts) => avgMap.get(ts)!);
      const vwapSlope5 = vwapSlopeBpMin(avgsUpTo, 5);
      const sideStreak = sideStreakOf(barsUpTo, avgOf);
      const r2 = minuteR2(barsUpTo, 30);
      const regime: Regime = regimeOf({
        bias: curBias,
        maxBias: P.maxBiasPct,
        vwapSlope5,
        sideStreak,
        r2,
        marketPct: 0,
        marketCrash: P.marketCrashPct,
      });
      if (regime === "extreme") continue;

      // 打分（盘口/逐笔因子中性 0 → 结果偏保守）
      const nearSupportPct = supportLow > 0 ? ((px - supportLow) / supportLow) * 100 : 0;
      const nearResistPct = resistHigh > 0 ? ((px - resistHigh) / resistHigh) * 100 : 0;
      const f = {
        biasZ: biasZ.z,
        bookImb: 0,
        actNet: 0,
        turnUp: turnOf(barsUpTo, "up"),
        turnDown: turnOf(barsUpTo, "down"),
        nearSupportPct,
        nearVwapPct: curBias,
        nearResistPct,
        relStrength: relativeStrength(0, 0),
        atrPct,
      };
      let sc: ScoreResult;
      let dir: "long" | "short" | "";
      // 方向：负乖离且市况允许正T；正乖离且市况允许倒T
      if (curBias < 0 && regimeAllows(regime, "long")) {
        sc = summarize(scoreLong(f).parts);
        dir = gradeOf(sc.total) === "strong" ? "long" : "";
      } else if (curBias > 0 && regimeAllows(regime, "short")) {
        sc = summarize(scoreShort(f).parts);
        dir = gradeOf(sc.total) === "strong" ? "short" : "";
      } else {
        continue;
      }
      if (!dir) { confirmDir = ""; confirmStreak = 0; continue; }

      // 连续确认（与实盘防抖一致）
      if (confirmDir === dir) confirmStreak++;
      else { confirmDir = dir; confirmStreak = 1; }
      if (confirmStreak < P.confirmBars) continue;

      // 数量：1R 反推（底仓市值 × 风险率 / 止损距离），clamp 底仓半仓
      const stopPct = clamp(atrPct, P.stopMinPct, P.stopMaxPct);
      const targetPct = clamp(stopPct * P.targetMult, P.targetMinPct, P.targetMaxPct);
      const riskAmt = P.baseVol * px * P.riskPerTrade;
      const vol = round100(Math.min(riskAmt / (px * stopPct / 100), P.baseVol * 0.5));
      if (vol < 100) { confirmDir = ""; confirmStreak = 0; continue; }

      debug?.({ day: day.date, idx: i, min: m, bias: curBias, z: biasZ.z, regime, score: sc.total, dir, confirm: confirmStreak, openCount, legs: legs.length });

      // 成交：对手价 + 滑点
      const side: "buy" | "sell" = dir === "long" ? "buy" : "sell";
      const openPx = round2(side === "buy" ? px * (1 + P.slipPct / 100) : px * (1 - P.slipPct / 100));
      const openFee = estimateFee(side, openPx * vol).total;
      legs.push({
        type: dir,
        openPrice: openPx,
        vol,
        openIdx: i,
        openTime: hhmmOf(b.timestamp),
        openFee,
        stopPct,
        targetPct,
        score: sc.total,
        regime,
      });
      openCount++;
      lastOpenMin = m;
      confirmDir = "";
      confirmStreak = 0;
    }

    // 日末：若仍有在途（理论上 14:50 已强平，兜底）
    if (legs.length) {
      closeLegs(bars.length - 1, "force", true);
    }

    // 当日对照：底仓不动收益 = 底仓 × (日末 - 日首)
    const baselineDayPnl = P.baseVol * (bars[bars.length - 1].close - bars[0].open);
    dayResults.push({
      date: day.date,
      trades: dayTrades,
      dayPnl,
      dayFees,
      forcedClose,
      baselineDayPnl,
    });
    perDayPnl.push(dayPnl);
  }

  // ============ 汇总 ============
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const feeTotal = trades.reduce((s, t) => s + t.fee, 0);
  const count = trades.length;
  const win = trades.filter((t) => t.pnl > 0).length;
  const winRate = count ? (win / count) * 100 : 0;
  const avgPnl = count ? totalPnl / count : 0;
  const grossWin = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : 0;

  // 最大回撤（累计收益曲线）
  let peak = 0, maxDd = 0, cum = 0;
  for (const p of perDayPnl) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }

  const longT = trades.filter((t) => t.type === "long");
  const shortT = trades.filter((t) => t.type === "short");
  const g = (arr: BtTrade[]) => ({
    count: arr.length,
    winRate: arr.length ? (arr.filter((t) => t.pnl > 0).length / arr.length) * 100 : 0,
    pnl: arr.reduce((s, t) => s + t.pnl, 0),
  });

  // 时段分组
  const buckets: { label: string; items: BtTrade[] }[] = [
    { label: "9:30-10:30", items: [] },
    { label: "10:30-11:30", items: [] },
    { label: "13:00-14:00", items: [] },
    { label: "14:00-14:30", items: [] },
  ];
  const bucketMin = [9 * 60 + 30, 10 * 60 + 30, 13 * 60, 14 * 60, 14 * 60 + 30];
  for (const t of trades) {
    const m = minOf(new Date(`${t.date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}T${t.openTime}:00`).getTime());
    let bi = 0;
    for (let k = buckets.length - 1; k >= 0; k--) {
      if (m >= bucketMin[k]) { bi = k; break; }
    }
    buckets[bi].items.push(t);
  }
  const byHour: BtHourBucket[] = buckets.map((bk) => ({
    label: bk.label,
    count: bk.items.length,
    pnl: bk.items.reduce((s, t) => s + t.pnl, 0),
    winRate: bk.items.length ? (bk.items.filter((t) => t.pnl > 0).length / bk.items.length) * 100 : 0,
  }));

  const baselinePnl = dayResults.reduce((s, d) => s + d.baselineDayPnl, 0);

  // 保本胜率（成本模型下做T的胜率要求）：平均每笔毛利需覆盖往返费；近似
  // p_break = fee_avg / (fee_avg + avg_win_gross) 简化用 平均毛利为正的情况
  let breakEvenWinRate = 0;
  if (count) {
    const avgFee = feeTotal / count;
    const avgWin = grossWin / Math.max(win, 1);
    const avgLoss = grossLoss / Math.max(count - win, 1);
    // 盈亏平衡：p × avgWin - (1-p) × avgLoss - avgFee = 0 → p = (avgLoss + avgFee) / (avgWin + avgLoss)
    const denom = avgWin + avgLoss;
    if (denom > 0) breakEvenWinRate = ((avgLoss + avgFee) / denom) * 100;
  }

  return {
    code,
    days: dayResults,
    trades,
    params: P,
    totalPnl,
    feeTotal,
    count,
    winRate,
    avgPnl,
    profitFactor,
    maxDrawdown: maxDd,
    forcedCloseCount: dayResults.filter((d) => d.forcedClose).length,
    long: g(longT),
    short: g(shortT),
    byHour,
    perDayPnl,
    baselinePnl,
    breakEvenWinRate,
    sampleDays: dayResults.length,
  };
}
