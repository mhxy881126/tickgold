// 交易日时间状态机：按北京时间时段切换"盘前 / 竞价 / 开盘 / 盘中 / 午间 / 尾盘 / 盘后"，
// 决定每个时段蜘蛛该去哪几张卡、做什么、是否允许新开仓、是否该自动复盘。
// 纯函数（输入 Date），可在 node 单测；不处理节假日（周末判断），节假日可后续接日历数据。
import type { CardId } from "../../lib/cards";
import { tradingTourCards, reviewTourCards } from "./cardRegistry";

export type TradingPhase =
  | "closed"
  | "pre-market"
  | "auction"
  | "open"
  | "morning"
  | "midday"
  | "afternoon"
  | "close"
  | "post-market";

/** 是否交易日（简单剔除周末；法定节假日待接财经日历） */
export function isTradingDay(d: Date = new Date()): boolean {
  const w = d.getDay();
  return w !== 0 && w !== 6;
}

function minutesOf(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function getTradingPhase(d: Date = new Date()): TradingPhase {
  if (!isTradingDay(d)) return "closed";
  const m = minutesOf(d);
  if (m >= 510 && m < 555) return "pre-market";   // 08:30–09:15
  if (m >= 555 && m < 565) return "auction";       // 09:15–09:25
  if (m >= 565 && m < 575) return "open";          // 09:25–09:35
  if (m >= 575 && m < 690) return "morning";       // 09:35–11:30
  if (m >= 690 && m < 780) return "midday";        // 11:30–13:00
  if (m >= 780 && m < 885) return "afternoon";     // 13:00–14:45
  if (m >= 885 && m < 900) return "close";         // 14:45–15:00
  if (m >= 900 && m < 960) return "post-market";   // 15:00–16:00
  return "closed";
}

// 各时段重点巡回卡片（操盘手节奏）
const PRE_MARKET_CARDS: CardId[] = ["news", "calendar", "watch", "sector", "concept", "themelib", "radar"];
const AUCTION_CARDS: CardId[] = ["auction", "watch", "limitpool"];
const OPEN_CARDS: CardId[] = ["radar", "rank", "watch"];
const MIDDAY_CARDS: CardId[] = ["watch", "sector", "rank", "trade"];
const CLOSE_CARDS: CardId[] = ["watch", "trade", "radar", "rank"];

// 盘后 / 休市的研究巡回：交易相关卡片（不含交易执行卡 trade），用于非交易时段做研究扫描与模拟验证
const RESEARCH_CARDS: CardId[] = [
  "rank", "radar", "sector", "concept", "themelib",
  "auction", "spider", "limitpool", "dragon", "screener", "watch",
];

/** 该时段的巡回卡片顺序（closed 返回空数组，系统空转等待） */
export function tourCardsForPhase(phase: TradingPhase): CardId[] {
  switch (phase) {
    case "pre-market": return PRE_MARKET_CARDS;
    case "auction": return AUCTION_CARDS;
    case "open": return OPEN_CARDS;
    case "morning": return tradingTourCards();
    case "midday": return MIDDAY_CARDS;
    case "afternoon": return tradingTourCards();
    case "close": return CLOSE_CARDS;
    case "post-market": return [...reviewTourCards(), ...RESEARCH_CARDS];
    case "closed":
      // 休市（晚间 / 周末）：研究卡优先（让用户随时能看到扫描与模拟交易），复盘卡随后
      return [...RESEARCH_CARDS, ...reviewTourCards()];
  }
}

/** 该时段的动作说明（日志 / 提示用） */
export function phaseAction(phase: TradingPhase): string {
  switch (phase) {
    case "pre-market": return "盘前自检，读消息/日历，预扫描自选与题材";
    case "auction": return "分析集合竞价，排候选股，定挂单计划";
    case "open": return "开盘观察方向，暂不开仓";
    case "morning": return "按 环境→主线→个股 巡回，研判并交易";
    case "midday": return "复盘上午，更新候选与仓位计划";
    case "afternoon": return "继续巡回，持仓跟踪与预警";
    case "close": return "尾盘决策：新开 / 减仓 / 持有";
    case "post-market": return "自动复盘、绩效归因、策略进化、写次日计划";
    case "closed": return "非交易时段，等待开盘";
  }
}

/** 时段开仓门控：仅盘中主时段允许自动新开仓（开盘观察期 / 尾盘默认不开，P2 可细化） */
export function canOpenNewPosition(phase: TradingPhase): boolean {
  return phase === "morning" || phase === "afternoon";
}

/** 是否应在该时段自动跑盘后复盘 */
export function shouldRunReview(phase: TradingPhase): boolean {
  return phase === "post-market";
}

const PHASE_LABEL: Record<TradingPhase, string> = {
  closed: "休市",
  "pre-market": "盘前",
  auction: "集合竞价",
  open: "开盘",
  morning: "上午盘",
  midday: "午间",
  afternoon: "下午盘",
  close: "尾盘",
  "post-market": "盘后",
};

/** 时段中文名 */
export function phaseLabel(phase: TradingPhase): string {
  return PHASE_LABEL[phase];
}
