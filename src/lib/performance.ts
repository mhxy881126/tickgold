// 交易绩效纯函数（P2-4）：FIFO 买卖配对 → 闭环交易归因；胜率/盈亏比/期望/最大回撤/月度归因。
// 口径说明：
//  - 闭环交易采用 FIFO（先进先出）逐批配对，是交易绩效的行业标准口径；
//  - 单次"闭环"在买入批次与卖出成交之间建立，含买卖费用；
//  - 全部平仓后，FIFO 汇总已实现盈亏与系统平均成本法总额一致；过程中两者可能不同；
//  - 含浮动的总盈亏请用系统现价口径（paper.totalPnl），本模块只做"已闭环"的交易归因。
// 所有函数无副作用，便于单元测试。

export interface TradeLike {
  code: string;
  side: "buy" | "sell";
  price: number;
  vol: number;
  amount: number;
  fee: number;
  createdAt: number;
  tradeDate: string;
}

export interface RoundTrip {
  code: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  vol: number;
  cost: number; // 配对买入成本（含买入费）
  proceeds: number; // 配对卖出净收入（扣卖出费）
  pnl: number; // proceeds - cost
  retPct: number; // 单笔收益率（%）
  holdingDays: number;
}

export interface MonthlyPerf {
  month: string; // YYYY-MM
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
}

export interface EquityPoint {
  date: string;
  t: number;
  equity: number;
}

export interface PerformanceStats {
  roundTrips: RoundTrip[];
  realizedPnl: number;
  totalFees: number;
  trades: number;
  wins: number;
  losses: number;
  scratch: number;
  winRate: number; // %
  grossProfit: number;
  grossLoss: number; // 正数
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  profitFactor: number | null;
  expectancy: number;
  avgHoldDays: number;
  equityCurve: EquityPoint[];
  maxDrawdown: number;
  maxDrawdownPct: number;
  monthly: MonthlyPerf[];
}

const EPS = 1e-9;

/** 两个交易日（YYYY-MM-DD）之间的自然日差（b - a）。 */
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(a + "T00:00:00");
  const tb = Date.parse(b + "T00:00:00");
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return Math.round((tb - ta) / 86_400_000);
}

interface Lot {
  vol: number;
  price: number;
  feePerShare: number;
  date: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 计算绩效。trades 可为任意顺序（内部按 createdAt 排序）；initCash 为账户初始资金，
 * 用于构建"交易点净值 = 初始资金 + 累计已实现盈亏（成本口径）"及其最大回撤。
 */
export function analyzePerformance(
  trades: TradeLike[],
  initCash: number
): PerformanceStats {
  const sorted = [...trades].sort((a, b) => a.createdAt - b.createdAt);
  const lots = new Map<string, Lot[]>();
  const roundTrips: RoundTrip[] = [];
  let realized = 0;
  let totalFees = 0;
  let cumulative = 0;
  const curve: EquityPoint[] = [{ date: "", t: 0, equity: initCash }];

  for (const tr of sorted) {
    totalFees += tr.fee;
    let queue = lots.get(tr.code);
    if (!queue) {
      queue = [];
      lots.set(tr.code, queue);
    }

    if (tr.side === "buy") {
      const feePerShare = tr.vol > 0 ? tr.fee / tr.vol : 0;
      queue.push({ vol: tr.vol, price: tr.price, feePerShare, date: tr.tradeDate });
    } else {
      // 卖出：每股净收入 =（成交金额 - 卖出费）/ 股数
      const netPerShare = tr.vol > 0 ? (tr.amount - tr.fee) / tr.vol : 0;
      let need = tr.vol;
      while (need > EPS) {
        const lot = queue[0];
        if (!lot) break; // 容错：找不到买入批次（理论上 T+1 已阻止），丢弃剩余
        const take = Math.min(lot.vol, need);
        const costPerShare = lot.price + lot.feePerShare;
        const cost = take * costPerShare;
        const proceeds = take * netPerShare;
        const pnl = proceeds - cost;
        roundTrips.push({
          code: tr.code,
          entryDate: lot.date,
          exitDate: tr.tradeDate,
          entryPrice: lot.price,
          exitPrice: tr.price,
          vol: take,
          cost,
          proceeds,
          pnl,
          retPct: cost > 0 ? (pnl / cost) * 100 : 0,
          holdingDays: Math.max(0, daysBetween(lot.date, tr.tradeDate)),
        });
        realized += pnl;
        cumulative += pnl;
        need -= take;
        lot.vol -= take;
        if (lot.vol <= EPS) queue.shift();
      }
    }

    curve.push({ date: tr.tradeDate, t: tr.createdAt, equity: initCash + cumulative });
  }

  // —— 胜负与盈亏统计 ——
  let wins = 0;
  let losses = 0;
  let scratch = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let largestWin = 0;
  let largestLoss = 0;
  let holdSum = 0;
  for (const rt of roundTrips) {
    if (rt.pnl > EPS) {
      wins += 1;
      grossProfit += rt.pnl;
      largestWin = Math.max(largestWin, rt.pnl);
    } else if (rt.pnl < -EPS) {
      losses += 1;
      grossLoss += -rt.pnl;
      largestLoss = Math.min(largestLoss, rt.pnl);
    } else {
      scratch += 1;
    }
    holdSum += rt.holdingDays;
  }
  const n = roundTrips.length;
  const avgWin = wins > 0 ? grossProfit / wins : 0;
  const avgLoss = losses > 0 ? grossLoss / losses : 0;
  let profitFactor: number | null = null;
  if (grossLoss > EPS) profitFactor = grossProfit / grossLoss;
  else if (grossProfit > EPS) profitFactor = null; // 无亏损，盈亏比无定义（无穷）

  // —— 最大回撤（成本口径净值曲线）——
  let peak = initCash;
  let maxDrawdown = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  const maxDrawdownPct = peak > 0 ? (maxDrawdown / peak) * 100 : 0;

  // —— 月度归因（按闭环 exitDate）——
  const mm = new Map<string, MonthlyPerf>();
  for (const rt of roundTrips) {
    const month = rt.exitDate.substring(0, 7);
    let m = mm.get(month);
    if (!m) {
      m = { month, pnl: 0, trades: 0, wins: 0, losses: 0 };
      mm.set(month, m);
    }
    m.pnl += rt.pnl;
    m.trades += 1;
    if (rt.pnl > EPS) m.wins += 1;
    else if (rt.pnl < -EPS) m.losses += 1;
  }
  const monthly = [...mm.values()].sort((a, b) => (a.month < b.month ? -1 : 1));

  return {
    roundTrips,
    realizedPnl: realized,
    totalFees,
    trades: n,
    wins,
    losses,
    scratch,
    winRate: n > 0 ? (wins / n) * 100 : 0,
    grossProfit,
    grossLoss,
    avgWin,
    avgLoss,
    largestWin,
    largestLoss,
    profitFactor,
    expectancy: n > 0 ? realized / n : 0,
    avgHoldDays: n > 0 ? holdSum / n : 0,
    equityCurve: curve,
    maxDrawdown,
    maxDrawdownPct,
    monthly: monthly.map((m) => ({ ...m, pnl: round2(m.pnl) })),
  };
}
