// ===== 风控系统 =====
// 独立风控层：决定"能不能买、买多少、要不要卖、要不要停手"
// 纯函数，无 DOM / 无状态，可在 node 下单测。
export interface Position {
  code: string;
  name: string;
  vol: number;
  costAmount: number; // 持仓成本金额
}

export interface TradeRecord {
  id: string;
  code: string;
  name: string;
  side: "buy" | "sell";
  price: number;
  vol: number;
  amount: number;
  reason: string;
  timestamp: number;
  profit?: number; // 卖出时的盈亏金额
  profitPct?: number; // 卖出时的盈亏比例
}

export interface AccountState {
  initCash: number;
  cash: number;
  positions: Position[];
  trades: TradeRecord[];
  todayBuyCount: number;
  todaySellCount: number;
  dayHighValue: number; // 当日最高账户总值
  totalHighValue: number; // 历史最高账户总值
  pausedUntil?: number; // 风控暂停到什么时间
  pauseReason?: string;
}

export interface RiskConfig {
  // === 仓位控制 ===
  maxPositions: number;          // 最多持仓数
  singlePositionPct: number;     // 单票最大仓位比例（0-1）
  maxPositionPct: number;        // 总仓位上限比例（0-1，1 = 满仓）

  // === 止盈止损 ===
  takeProfitPct: number;         // 止盈比例（+8% 止盈）
  stopLossPct: number;           // 止损比例（-4% 止损）
  trailingStopPct: number;       // 移动止盈回撤比例（从高点回撤多少止盈）
  trailingStopEnabled: boolean;  // 移动止盈开关

  // === 回撤控制 ===
  maxDailyLossPct: number;       // 单日最大亏损比例（-3% 停手）
  maxDrawdownPct: number;        // 最大回撤比例（-10% 强制暂停）

  // === 涨跌停保护 ===
  limitUpProtect: boolean;       // 涨停不追买
  limitDownProtect: boolean;     // 跌停不卖（卖不出）

  // === 交易频率 ===
  maxDailyTrades: number;        // 单日最大交易次数（买+卖）

  // === 冷静期 ===
  openCoolDownMin: number;       // 开盘冷静期（分钟）
  closeCoolDownMin: number;      // 收盘冷静期（分钟）
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxPositions: 5,
  singlePositionPct: 0.25,
  maxPositionPct: 0.8,

  takeProfitPct: 0.08,
  stopLossPct: -0.04,
  trailingStopPct: 0.03,
  trailingStopEnabled: true,

  maxDailyLossPct: -0.03,
  maxDrawdownPct: -0.10,

  limitUpProtect: true,
  limitDownProtect: true,

  maxDailyTrades: 6,

  openCoolDownMin: 15,
  closeCoolDownMin: 15,
};

// 4 套策略对应的风控配置
export const STRATEGY_RISK: Record<string, Partial<RiskConfig>> = {
  conservative: {
    maxPositions: 4,
    singlePositionPct: 0.2,
    maxPositionPct: 0.6,
    takeProfitPct: 0.05,
    stopLossPct: -0.025,
    trailingStopPct: 0.02,
    maxDailyLossPct: -0.02,
    maxDrawdownPct: -0.06,
    maxDailyTrades: 4,
    openCoolDownMin: 30,
    closeCoolDownMin: 20,
  },
  balanced: {
    ...DEFAULT_RISK_CONFIG,
  },
  aggressive: {
    maxPositions: 4,
    singlePositionPct: 0.3,
    maxPositionPct: 0.9,
    takeProfitPct: 0.12,
    stopLossPct: -0.06,
    trailingStopPct: 0.04,
    maxDailyLossPct: -0.05,
    maxDrawdownPct: -0.15,
    maxDailyTrades: 8,
    openCoolDownMin: 5,
    closeCoolDownMin: 10,
  },
  scalping: {
    maxPositions: 2,
    singlePositionPct: 0.4,
    maxPositionPct: 0.8,
    takeProfitPct: 0.05,
    stopLossPct: -0.03,
    trailingStopPct: 0.02,
    trailingStopEnabled: false,
    maxDailyLossPct: -0.04,
    maxDrawdownPct: -0.08,
    maxDailyTrades: 10,
    openCoolDownMin: 5,
    closeCoolDownMin: 5,
  },
};

export type RiskDecision =
  | { allowed: true; suggestedVol?: number; reason?: string }
  | { allowed: false; reason: string; level: "info" | "warn" | "block" };

/**
 * 计算账户当前总值（现金 + 持仓市值）
 */
export function calcTotalValue(account: AccountState, priceMap: Record<string, number>): number {
  const posValue = account.positions.reduce((sum, p) => {
    const price = priceMap[p.code] ?? p.costAmount / Math.max(p.vol, 1);
    return sum + price * p.vol;
  }, 0);
  return account.cash + posValue;
}

/**
 * 计算持仓盈亏比例
 */
export function calcPositionPnlPct(
  pos: Position,
  currentPrice: number,
): number {
  if (pos.vol <= 0) return 0;
  const costPrice = pos.costAmount / pos.vol;
  if (costPrice <= 0) return 0;
  return (currentPrice - costPrice) / costPrice;
}

/**
 * 计算今日盈亏比例（相对今日最高账户总值的回撤/新高）
 * 注意：用日内最高值做基准，作为"当日回撤"的近似
 */
export function calcTodayPnlPct(
  account: AccountState,
  priceMap: Record<string, number>,
): number {
  const totalValue = calcTotalValue(account, priceMap);
  const baseValue = account.dayHighValue;
  if (baseValue <= 0) return 0;
  return (totalValue - baseValue) / baseValue;
}

/**
 * 计算最大回撤（相对历史最高值）
 */
export function calcMaxDrawdownPct(
  account: AccountState,
  priceMap: Record<string, number>,
): number {
  const totalValue = calcTotalValue(account, priceMap);
  const high = Math.max(account.totalHighValue, totalValue);
  if (high <= 0) return 0;
  return (totalValue - high) / high;
}

/**
 * 买入风控检查：能不能买？买多少？
 */
export function checkBuyRisk(
  code: string,
  name: string,
  price: number,
  account: AccountState,
  priceMap: Record<string, number>,
  now: Date,
  cfg: Partial<RiskConfig> = {},
): RiskDecision {
  const c: RiskConfig = { ...DEFAULT_RISK_CONFIG, ...cfg };

  // 1. 全局暂停检查
  if (account.pausedUntil && now.getTime() < account.pausedUntil) {
    return { allowed: false, reason: `风控暂停中（${account.pauseReason || ""}）`, level: "block" };
  }

  // 2. 涨跌停保护
  if (c.limitUpProtect) {
    // 涨停价估算：昨收 * 1.1（简化，实际需要精确计算）
    // 这里用涨跌幅判断：涨幅 > 9.3% 认为接近涨停
    const pct = priceMap[code] ? (price - priceMap[code]) / priceMap[code] : 0;
    if (pct >= 0.093) {
      return { allowed: false, reason: "涨停不追买", level: "warn" };
    }
  }

  // 3. 冷静期检查
  const hour = now.getHours();
  const minute = now.getMinutes();
  const timeMin = hour * 60 + minute;
  // 上午 9:30 开盘 = 570min，下午 13:00 开盘 = 780min
  // 上午收盘 11:30 = 690min，下午收盘 15:00 = 900min
  const inOpenCoolDown =
    (timeMin >= 570 && timeMin < 570 + c.openCoolDownMin) ||
    (timeMin >= 780 && timeMin < 780 + c.openCoolDownMin);
  const inCloseCoolDown =
    (timeMin > 690 - c.closeCoolDownMin && timeMin <= 690) ||
    (timeMin > 900 - c.closeCoolDownMin && timeMin <= 900);
  if (inOpenCoolDown) {
    return { allowed: false, reason: "开盘冷静期", level: "info" };
  }
  if (inCloseCoolDown) {
    return { allowed: false, reason: "收盘冷静期", level: "info" };
  }

  // 4. 交易频率
  const totalTrades = account.todayBuyCount + account.todaySellCount;
  if (totalTrades >= c.maxDailyTrades) {
    return { allowed: false, reason: `今日交易次数达上限（${c.maxDailyTrades}）`, level: "block" };
  }

  // 5. 最大回撤
  const drawdown = calcMaxDrawdownPct(account, priceMap);
  if (drawdown <= c.maxDrawdownPct) {
    return {
      allowed: false,
      reason: `最大回撤 ${(drawdown * 100).toFixed(1)}% 触线，暂停交易`,
      level: "block",
    };
  }

  // 6. 单日亏损
  const todayPnl = calcTodayPnlPct(account, priceMap);
  if (todayPnl <= c.maxDailyLossPct) {
    return {
      allowed: false,
      reason: `当日亏损 ${(todayPnl * 100).toFixed(1)}% 触线，今日停手`,
      level: "block",
    };
  }

  // 7. 持仓数量上限
  const existingPos = account.positions.find(p => p.code === code);
  if (!existingPos && account.positions.length >= c.maxPositions) {
    return {
      allowed: false,
      reason: `持仓数达上限（${c.maxPositions}只）`,
      level: "warn",
    };
  }

  // 8. 计算建议买入量
  const totalValue = calcTotalValue(account, priceMap);
  const singleBudget = totalValue * c.singlePositionPct; // 单票预算
  const maxPosBudget = totalValue * c.maxPositionPct; // 总仓位上限
  const currentPosValue = account.positions.reduce((sum, p) => {
    const px = priceMap[p.code] ?? p.costAmount / Math.max(p.vol, 1);
    return sum + px * p.vol;
  }, 0);

  if (currentPosValue >= maxPosBudget && !existingPos) {
    return { allowed: false, reason: "总仓位达上限", level: "warn" };
  }

  let vol = 0;
  if (price > 0) {
    // 按单票预算算，取整到 100 股
    const budget = Math.min(
      singleBudget - (existingPos ? existingPos.costAmount : 0),
      maxPosBudget - currentPosValue,
      account.cash,
    );
    vol = Math.floor(budget / price / 100) * 100;
  }

  if (vol < 100) {
    return { allowed: false, reason: "可用资金不足一手", level: "info" };
  }

  return {
    allowed: true,
    suggestedVol: vol,
    reason: `建议买入 ${vol} 股（单票仓位 ${((vol * price) / totalValue * 100).toFixed(1)}%）`,
  };
}

/**
 * 卖出风控检查：要不要卖？
 */
export function checkSellRisk(
  pos: Position,
  currentPrice: number,
  highestPrice: number, // 持仓期间最高价（用于移动止盈）
  cfg: Partial<RiskConfig> = {},
): RiskDecision & { side?: "take_profit" | "stop_loss" | "trailing_stop" | "manual" } {
  const c: RiskConfig = { ...DEFAULT_RISK_CONFIG, ...cfg };

  const pnlPct = calcPositionPnlPct(pos, currentPrice);

  // 跌停保护
  if (c.limitDownProtect) {
    const costPrice = pos.costAmount / Math.max(pos.vol, 1);
    const dayPct = costPrice > 0 ? (currentPrice - costPrice) / costPrice : 0;
    if (dayPct <= -0.095) {
      return { allowed: false, reason: "跌停卖不出", level: "warn" };
    }
  }

  // 止损
  if (pnlPct <= c.stopLossPct) {
    return {
      allowed: true,
      reason: `止损触发（${(pnlPct * 100).toFixed(1)}%）`,
      side: "stop_loss",
    };
  }

  // 移动止盈（优先于固定止盈：达到盈利目标后，从高点回撤才卖，让利润奔跑）
  if (c.trailingStopEnabled && highestPrice > 0 && pnlPct > c.takeProfitPct * 0.5) {
    const drawdownFromHigh = (currentPrice - highestPrice) / highestPrice;
    if (drawdownFromHigh <= -c.trailingStopPct && pnlPct > 0) {
      return {
        allowed: true,
        reason: `移动止盈（从高点回撤 ${(drawdownFromHigh * 100).toFixed(1)}%）`,
        side: "trailing_stop",
      };
    }
  }

  // 固定止盈（移动止盈未启用，或还没触发回撤时，到线就卖）
  if (pnlPct >= c.takeProfitPct && !c.trailingStopEnabled) {
    return {
      allowed: true,
      reason: `止盈触发（${(pnlPct * 100).toFixed(1)}%）`,
      side: "take_profit",
    };
  }

  // 如果已达到止盈线但启用了移动止盈 → 不触发，继续持有等回撤
  // （这就是移动止盈的意义：让利润奔跑）

  return { allowed: false, reason: "未触发止盈止损", level: "info" };
}

/**
 * 检查是否需要暂停交易（触达最大回撤等）
 * 返回 null = 不需要暂停；否则返回到期时间和原因
 */
export function checkPauseTrading(
  account: AccountState,
  priceMap: Record<string, number>,
  now: Date,
  cfg: Partial<RiskConfig> = {},
): { until: number; reason: string } | null {
  const c: RiskConfig = { ...DEFAULT_RISK_CONFIG, ...cfg };
  const drawdown = calcMaxDrawdownPct(account, priceMap);

  if (drawdown <= c.maxDrawdownPct) {
    // 最大回撤触线：暂停到次日
    const nextDay = new Date(now);
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(9, 30, 0, 0);
    return {
      until: nextDay.getTime(),
      reason: `最大回撤 ${(drawdown * 100).toFixed(1)}% 触线，暂停至明日`,
    };
  }

  const todayPnl = calcTodayPnlPct(account, priceMap);
  if (todayPnl <= c.maxDailyLossPct) {
    // 当日亏损触线：暂停到收盘后
    const end = new Date(now);
    end.setHours(15, 0, 0, 0);
    if (end.getTime() > now.getTime()) {
      return { until: end.getTime(), reason: `当日亏损 ${(todayPnl * 100).toFixed(1)}%，今日停手` };
    }
  }

  return null;
}
