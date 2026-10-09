// 四类专门短线策略的信号判定。
// 与普通趋势 / 评分买点不同：打板买涨停、竞价买高开、精灵追异动、题材选领涨；
// 每类有自己的纪律门槛，输出统一 SpecialSignal，下单仍走统一管线
// （买入冷却 → 凯利仓位 → 风控 → 下单 → 成交回报）。

export type SpecialStrategy =
  | "board-reseal" // 炸板回封
  | "board-weak2strong" // 弱转强（低位早盘快速板）
  | "auction-grab" // 集合竞价抢筹
  | "elf-surge" // 短线精灵强异动
  | "theme-leader"; // 题材领涨（未涨停）

export interface SpecialSignal {
  code: string;
  name: string;
  price: number;
  pct: number;
  action: "BUY";
  strategy: SpecialStrategy;
  confidence: number; // 0~1，供凯利仓位
  reasons: string[];
}

// 输入的最小数据形状（兼容 API 返回，判定内全部做防御）
export interface BoardStock {
  code: string;
  name: string;
  price: number;
  pct: number;
  amount: number;
  fund: number; // 封单金额（元）
  boards: number; // 连板数
  firstSeal: number; // 首次封板时间（HHMM 或 HHMMSS）
  lastSeal: number;
  broken: number; // 炸板次数
  turnover: number; // 换手 %
  industry: string;
  limitPrice: number;
}
export interface AuctionStockLike {
  code: string;
  name: string;
  open: number;
  prevClose: number;
  gap: number; // 开盘缺口 %
  amount: number; // 竞价成交额（元）
  price: number;
  pct: number;
}
export interface ElfEventLike {
  time: number;
  code: string;
  name: string;
  price: number;
  pct: number;
  kind: string;
  label: string;
  tone: string; // up / down / neutral
}
export interface ThemeStockLike {
  code: string;
  name: string;
  price: number;
  pct: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
/** HHMM / HHMMSS 归一为 HHMMSS，便于比较时刻。 */
function normClock(v: number): number {
  return v > 10000 ? v : v * 100;
}

// ═══════════════════════ 打板：炸板回封 ═══════════════════════
// 当前仍封住涨停、盘中炸过板但已回封；要求封单厚实、换手不极端、非高位连板。
export function boardReseal(s: BoardStock): SpecialSignal | null {
  if (s.broken < 1) return null;
  if (s.pct < 9.5) return null; // 必须当前封住
  if ((s.boards || 1) > 5) return null; // 高位连板不打
  const fundYi = (s.fund || 0) / 1e8;
  if (fundYi < 0.3) return null; // 封单 <3000万，回封不牢
  if ((s.turnover || 0) > 25) return null; // 换手过高，筹码松动

  return {
    code: s.code, name: s.name, price: s.price, pct: s.pct, action: "BUY",
    strategy: "board-reseal",
    confidence: clamp(0.55 + Math.min(fundYi, 3) * 0.08 - s.broken * 0.03, 0.45, 0.85),
    reasons: [
      `炸板${s.broken}次后回封`,
      `封单${fundYi.toFixed(2)}亿`,
      `换手${(s.turnover || 0).toFixed(1)}%`,
      `${s.boards || 1}板`,
    ],
  };
}

// ═══════════════════════ 打板：弱转强 ═══════════════════════
// 低位（首板/2板）、早盘 10:30 前快速封板、封单大、炸板少。
export function boardWeak2Strong(s: BoardStock): SpecialSignal | null {
  const boards = s.boards || 1;
  if (boards > 2) return null; // 只做低位
  if (s.pct < 9.5) return null;
  if (s.broken > 2) return null;
  const fundYi = (s.fund || 0) / 1e8;
  if (fundYi < 0.5) return null;
  if (normClock(s.firstSeal || 1500) > 103000) return null; // 尾盘板不算弱转强

  return {
    code: s.code, name: s.name, price: s.price, pct: s.pct, action: "BUY",
    strategy: "board-weak2strong",
    confidence: clamp(
      0.5 + Math.min(fundYi, 4) * 0.07 + (normClock(s.firstSeal) < 100000 ? 0.08 : 0),
      0.45, 0.85,
    ),
    reasons: [
      `${boards}板弱转强`,
      `早盘${s.firstSeal || ""}封板`,
      `封单${fundYi.toFixed(2)}亿`,
      `换手${(s.turnover || 0).toFixed(1)}%`,
    ],
  };
}

// ═══════════════════════ 集合竞价抢筹 ═══════════════════════
// 高开 2~7%（不接过高高开 / 一字）、竞价成交额放大、大盘不崩。
export function auctionGrab(
  a: AuctionStockLike, marketRegime: "up" | "flat" | "down",
): SpecialSignal | null {
  if (marketRegime === "down") return null;
  const gap = a.gap ?? a.pct;
  if (gap < 2 || gap > 7) return null;
  if (gap >= 9) return null; // 一字 / 接近涨停不追
  const amountYi = (a.amount || 0) / 1e8;
  if (amountYi < 0.3) return null; // 竞价额 <3000万，关注度不足

  return {
    code: a.code, name: a.name, price: a.price || a.open, pct: a.pct ?? gap, action: "BUY",
    strategy: "auction-grab",
    confidence: clamp(0.5 + Math.min(gap, 7) * 0.03 + Math.min(amountYi, 5) * 0.03, 0.45, 0.8),
    reasons: [`高开${gap.toFixed(2)}%`, `竞价成交${amountYi.toFixed(2)}亿`],
  };
}

// ═══════════════════════ 短线精灵强异动 ═══════════════════════
const STRONG_ELF = ["火箭发射", "快速反弹", "大笔买入", "封涨停板", "有大买盘", "竞价上涨", "高开阳线"];
export function elfSurge(e: ElfEventLike): SpecialSignal | null {
  if (e.tone !== "up") return null;
  const text = `${e.kind}${e.label}`;
  if (!STRONG_ELF.some((k) => text.includes(k))) return null;
  const pct = e.pct || 0;
  if (pct > 9) return null; // 已涨停交给打板策略
  if (pct < 0.5) return null;
  const isSeal = text.includes("封涨停");

  return {
    code: e.code, name: e.name, price: e.price, pct, action: "BUY",
    strategy: "elf-surge",
    confidence: isSeal ? 0.7 : clamp(0.5 + Math.min(pct, 8) * 0.025, 0.45, 0.75),
    reasons: [`异动·${e.kind || e.label}`, `涨幅${pct.toFixed(2)}%`],
  };
}

// ═══════════════════════ 题材领涨（未涨停） ═══════════════════════
export function themeLeader(s: ThemeStockLike): SpecialSignal | null {
  const pct = s.pct || 0;
  if (pct < 2 || pct > 8) return null; // 领涨但未涨停，留有空间
  return {
    code: s.code, name: s.name, price: s.price, pct, action: "BUY",
    strategy: "theme-leader",
    confidence: clamp(0.5 + Math.min(pct, 8) * 0.03, 0.45, 0.72),
    reasons: [`题材领涨 +${pct.toFixed(2)}%`],
  };
}
