import { ref, computed } from "vue";
import { useWatchlistStore } from "../stores/watchlist";
import { useQuotesStore } from "../stores/quotes";
import { usePaperStore } from "../stores/paper";
import {
  signalCreateSpider,
  runReview,
  evolutionRunLabeling,
  evolutionStats,
  generatePlan,
} from "../ai/api";
import {
  evolveFromStats,
  loadEvolvedParams,
  saveEvolvedParams,
  type EvolutionStatsLike,
} from "../ai/evolve";
import {
  fetchZtPool, fetchZbPool, fetchRankBoard, fetchSectors, fetchIndexQuotes, fetchKLine,
  fetchSectorStocks, fetchAuction, startSpider,
  type ZtStock, type AuctionStock, type SpiderEvent,
} from "../api/market";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  evaluateStock as evalStockScoring,
  STRATEGY_PRESETS,
  type StockScore,
  type ScoringConfig,
} from "../ai/scoring";
import {
  checkBuyRisk,
  checkSellRisk,
  checkPauseTrading,
  calcTotalValue,
  calcPositionPnlPct,
  calcMaxDrawdownPct,
  STRATEGY_RISK,
  type RiskConfig,
  type TradeRecord,
} from "../ai/risk";
import type { Quote, RankRow } from "../api/types";
import { decide, type Decision } from "../ai/decision";
import { planPosition, type MarketRegime } from "../ai/position";
import {
  boardReseal,
  boardWeak2Strong,
  auctionGrab,
  elfSurge,
  themeLeader,
  type SpecialSignal,
  type SpecialStrategy,
  type BoardStock,
  type ElfEventLike,
} from "../ai/specialStrategies";
import { regimeOfIndex } from "../ai/indicators";
import { CARD_META, type CardId } from "../lib/cards";
import {
  getTradingPhase,
  tourCardsForPhase,
  phaseAction,
  phaseLabel,
  canOpenNewPosition,
  type TradingPhase,
} from "../components/spider/tradingDay";

// ===== 扫描事件总线：驱动程序化蜘蛛覆盖层行走路径（无监听者时零开销）=====
// 开发提示：本文件 HMR 热替换后 Set 会重建，已挂载的蜘蛛组件仍持有旧总线订阅，
// 表现为热更后蜘蛛不动——重启一次爬虫（或刷新窗口）即可，生产环境无此问题。
export type SpiderSignalKind = "BUY" | "SELL" | null;
export type SpiderScanEvent =
  | { type: "card"; cardId: CardId }
  | { type: "target"; cardId: CardId; code: string; signal: SpiderSignalKind };

const scanListeners = new Set<(e: SpiderScanEvent) => void>();
export function onSpiderScan(cb: (e: SpiderScanEvent) => void): () => void {
  scanListeners.add(cb);
  return () => { scanListeners.delete(cb); };
}
function emitScan(e: SpiderScanEvent) {
  scanListeners.forEach((f) => f(e));
}

// ===== 智能漫游状态 =====
const running = ref(false);
const visible = ref(false); // 覆盖层是否显示
const paused = ref(false);  // 暂停（不推进轮次，蜘蛛停原地）
export const autoTrade = ref(false);
const semiAuto = ref(true); // 半自动模式（弹窗确认）
const currentStep = ref(0);
const currentCard = ref<CardId>("watch");

// ===== 每日复盘记录（盘后/休市自动产出，供面板展示）=====
export interface DailyReviewRecord {
  tradeDate: string;
  reviewedAt: string;
  reviews: { title?: string; scope?: string }[];
  evolutionNote: string;
  planTitle: string;
  planInstructions: number;
}
const dailyReview = ref<DailyReviewRecord | null>(null);

// ===== 爬取源配置：哪些数据源参与扫描 =====
export interface CrawlSourceConfig {
  watch: boolean;     // 自选股
  rank: boolean;      // 涨幅/跌幅排行榜
  sector: boolean;    // 行业板块
  concept: boolean;   // 概念板块
  radar: boolean;     // 涨停雷达
  market: boolean;    // 大盘指数
  dragon: boolean;    // 龙虎榜
  screener: boolean;  // 条件选股
  auction: boolean;   // 集合竞价
  elf: boolean;       // 短线精灵
  themelib: boolean;  // 题材库
}
const crawlSources = ref<CrawlSourceConfig>({
  watch: true,
  rank: true,
  sector: true,
  concept: true,
  radar: true,
  market: false,
  dragon: false,
  screener: false,
  auction: true,
  elf: true,
  themelib: true,
});

// ===== 自动交易白名单：哪些来源的信号允许自动交易 =====
// （仅在 autoTrade=true 时生效；半自动模式下所有信号都送确认桥）
const autoTradeSources = ref<CrawlSourceConfig>({
  watch: true,       // 自选股的信号最可靠，默认允许
  rank: false,       // 涨幅榜信号较激进，默认关闭自动交易
  sector: false,     // 板块联动信号，默认关闭
  concept: false,    // 概念板块，默认关闭
  radar: false,      // 涨停雷达，默认关闭
  market: false,     // 大盘只作参考，不直接交易
  dragon: false,
  screener: false,
  auction: false,    // 竞价抢筹，需显式授权
  elf: false,        // 精灵异动，需显式授权
  themelib: false,   // 题材库成分股，需显式授权
});

/** 将卡片 ID 映射到爬取源 key */
function cardToSource(cardId: CardId): keyof CrawlSourceConfig | null {
  const map: Partial<Record<CardId, keyof CrawlSourceConfig>> = {
    watch: "watch",
    rank: "rank",
    sector: "sector",
    radar: "radar",
    dragon: "dragon",
    screener: "screener",
    auction: "auction",
    spider: "elf",
    themelib: "themelib",
  };
  return map[cardId] ?? null;
}

/** 判断某卡片的信号是否允许自动交易（全局开关 + 分类开关） */
function canAutoTrade(cardId: CardId): boolean {
  if (!autoTrade.value) return false;
  const src = cardToSource(cardId);
  return src ? autoTradeSources.value[src] : false;
}

// ===== 智能决策：不是机械循环，而是根据情况动态调整 =====
// 优先级：发现好机会 → 深入分析；没机会 → 扫下一个卡片
let opportunityFound = false; // 当前是否发现了好机会
let deepAnalysisCount = 0; // 深度分析次数
const maxDeepAnalysis = 2; // 最多深度分析几次就换下一个

// ===== 卡片优先级（根据市场情况动态调整，且只包含启用的源）=====
function getCardPriority(): CardId[] {
  // 由交易日时间状态机决定当前时段巡回哪些卡（盘前/竞价/开盘/盘中/尾盘/盘后各有节奏）
  const tour = tourCardsForPhase(getTradingPhase());
  const src = crawlSources.value;
  // 数据源卡受 crawlSources 勾选过滤；其余浏览 / 分析 / 交易 / 复盘卡始终巡回
  const filtered = tour.filter((card) => {
    const source = cardToSource(card);
    return source ? !!src[source] : true;
  });
  // 兜底：休市等空清单时至少停在自选，不产生 undefined 空转
  return filtered.length ? filtered : ["watch"];
}
const cardNames: Record<string, string> = {
  watch: "自选股",
  rank: "涨幅榜",
  sector: "行业板块",
  concept: "概念板块",
  radar: "涨停雷达",
  chart: "K线图",
  trade: "交易面板",
  market: "大盘指数",
  dragon: "龙虎榜",
  screener: "条件选股",
};

// 卡片显示名：优先 CARD_META（覆盖全部 38 卡），其次旧映射，最后兜底 id（不再出现 undefined）
function cardTitle(id: CardId): string {
  return CARD_META[id]?.title ?? cardNames[id] ?? id;
}

// ===== 目标点（蜘蛛腿要连到哪里） =====
interface TargetPoint {
  x: number;
  y: number;
  label: string;
  type: "stock" | "index" | "button" | "card";
  isCurrent?: boolean;
  action?: "buy" | "sell" | "scan";
}
const targetPoints = ref<TargetPoint[]>([]);

// ===== 策略配置（评分 + 风控）=====
const currentStrategy = ref<"conservative" | "balanced" | "aggressive" | "scalping">("balanced");

const scoringConfig = ref<Partial<ScoringConfig>>({
  ...STRATEGY_PRESETS.balanced,
});

const riskConfig = ref<Partial<RiskConfig>>({
  ...STRATEGY_RISK.balanced,
});

const strategyNamesMap: Record<string, string> = {
  conservative: "🛡️ 稳健型",
  balanced: "⚖️ 均衡型",
  aggressive: "🚀 进取型",
  scalping: "⚡ 短线打板",
};

function applyStrategy(name: "conservative" | "balanced" | "aggressive" | "scalping") {
  currentStrategy.value = name;
  scoringConfig.value = { ...STRATEGY_PRESETS[name] };
  riskConfig.value = { ...STRATEGY_RISK[name] };
  addLog(`⚙️ 切换到【${strategyNamesMap[name]}】策略`, "info");
}

// ===== 绩效统计 =====
const performance = ref({
  totalReturnPct: 0,
  winRate: 0,
  profitFactor: 0,
  maxDrawdownPct: 0,
  totalTrades: 0,
  winTrades: 0,
  lossTrades: 0,
});

// ===== 日志 =====
interface LogEntry {
  time: string;
  text: string;
  type: "info" | "buy" | "sell" | "warn";
}
const logs = ref<LogEntry[]>([]);

// ===== 股票评分 =====
// 股票评分类型直接从 ai/scoring 导入（上面已 import）
const stockScores = ref<StockScore[]>([]);

// ===== 市场情绪 =====
const marketSentiment = ref({
  limitUp: 0,
  limitDown: 0,
  maxBoard: 0,
  bombRate: 0,
  level: "neutral" as "hot" | "neutral" | "cold",
});

// ===== 事件驱动推进 =====
// 蜘蛛走完一张卡（含数据包飞完）由覆盖层调 advanceRound() 推进；
// 30s 看门狗仅作兜底，防止异常情况下轮次永久停滞（旧实现固定 3s 切卡，蜘蛛单卡需 ~18s）。
const WATCHDOG_MS = 30000;
let switchRef: ((id: CardId) => boolean) | null = null;
let watchdog: number | null = null;

// ===== 评分函数（调用新的 ai/scoring 多因子引擎）=====
export function evaluateStock(q: Quote, code: string, name: string): StockScore {
  return evalStockScoring(q, code, name, marketSentiment.value.level, scoringConfig.value);
}

// ===== 各卡片真实采集：见下方 scanWatchlist / scanRank / scanMarket / scanSector / scanConcept / scanRadar =====
// 说明：旧的 collectFromStore（含 mock 板块/指数 + 硬编码坐标）已整体删除，
// 它与真实 scan* 函数重复，且会在 300ms 后覆盖真实结果，造成假数据与闪烁。

// ===== 评分信号送「信号确认桥」（半自动/人工确认模式的落桥通道）=====
// 后端按 code+side+pending 自动去重：同一只票同一方向已有待确认单时返回错误，静默忽略。
function suggestTicketVol(score: StockScore, paperStore: ReturnType<typeof usePaperStore>): number {
  if (score.recommendation === "SELL") {
    const pos = paperStore.positions.find((p) => p.code === score.code);
    if (pos && pos.vol > 0) return Math.floor(pos.vol / 100) * 100 || 100;
    return 100;
  }
  // 买入：按现金 20% 预算向下取整到 100 股（与后端 maxSinglePct 默认一致；人工确认时可改）
  try {
    const budget = paperStore.account.cash * 0.2;
    return Math.max(100, Math.floor(budget / (score.price * 100)) * 100);
  } catch {
    return 100;
  }
}

async function pushTicketToBridge(
  score: StockScore,
  paperStore: ReturnType<typeof usePaperStore>,
) {
  // 卖出信号仅在实际持仓时落桥；未持仓不存在可卖标的，不产生无意义待确认单
  if (score.recommendation === "SELL") {
    const held = paperStore.positions.find((p) => p.code === score.code);
    if (!held || held.vol <= 0) return;
  }
  try {
    const strength = Math.min(0.95, Math.max(0.55, 0.5 + Math.abs(score.score) * 0.07));
    await signalCreateSpider(
      score.code,
      score.name,
      score.recommendation,
      score.price,
      suggestTicketVol(score, paperStore),
      strength,
      score.signals.join("，"),
    );
    addLog(
      `🌉 信号已送确认桥：${score.name}(${score.code}) ${score.recommendation === "BUY" ? "买入" : "卖出"}`,
      score.recommendation === "BUY" ? "buy" : "sell",
    );
  } catch {
    // 已有同方向待确认单（去重）或后端未就绪：静默，不打扰扫描
  }
}

// ===== 扫描自选股 =====
// 大盘状态：拉上证指数日K判定 up/flat/down，缓存 60s
let regimeAt = 0;
let regimeCache: MarketRegime = "flat";
let regimeInflight: Promise<MarketRegime> | null = null;
async function getMarketRegime(): Promise<MarketRegime> {
  const now = Date.now();
  if (now - regimeAt < 60_000) return regimeCache;
  if (regimeInflight) return regimeInflight;
  regimeInflight = (async () => {
    try {
      const bars = await fetchKLine("sh000001", 101, 80);
      if (bars.length >= 25) {
        let r = regimeOfIndex(bars);
        // 情绪修正：指数走弱但情绪亢奋（涨停多 / 炸板率低 / 有连板高度）属结构性行情，
        // 不全面禁买，降为震荡，允许在强势方向按纪律开仓；指数弱且情绪冰点才保持 down。
        if (r === "down") {
          await ensureSentiment();
          const s = marketSentiment.value;
          if (s.limitUp >= 50 && s.bombRate < 0.3 && s.maxBoard >= 3) r = "flat";
        }
        regimeCache = r;
        regimeAt = now;
      }
    } catch {
      /* 保留旧值 */
    }
    return regimeCache;
  })();
  const r = await regimeInflight;
  regimeInflight = null;
  return r;
}

// ===== 盘后自动复盘流水线：复盘 → 结果标注 → 参数调权 → 次日作战计划（按交易日幂等）=====
let autoReviewInflight = false;
let autoReviewedTradeDate = "";

// 买入信号冷却：同一 code 在冷却期内不重复发买入信号 / 下单 / 送桥（针对被资金拦截或
// 送桥未成交，避免短时间反复"信号→拦截"空转）。成功买入后另由"已持仓"去重。
const buySignalAt = new Map<string, number>();
const BUY_SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;
function buyInCooldown(code: string): boolean {
  const last = buySignalAt.get(code);
  return last !== undefined && Date.now() - last < BUY_SIGNAL_COOLDOWN_MS;
}
function markBuySignal(code: string): void {
  buySignalAt.set(code, Date.now());
}

async function maybeAutoReview(): Promise<void> {
  const phase = getTradingPhase();
  if (phase !== "post-market" && phase !== "closed") return;
  if (autoReviewInflight) return;
  autoReviewInflight = true;
  let evolutionNote = "";
  let planTitle = "";
  let planCount = 0;
  try {
    addLog("🌆 盘后自动复盘启动：复盘 → 进化 → 次日计划", "info");

    // 1) 三层复盘（后端同日幂等，返回含真实最近交易日）
    let reviews: Awaited<ReturnType<typeof runReview>> = [];
    try {
      reviews = await runReview(null, false);
    } catch (e) {
      addLog(`⚠️ 自动复盘失败：${e}`, "warn");
    }
    const tdate = reviews[0]?.trade_date;
    if (tdate && autoReviewedTradeDate === tdate) {
      addLog("✅ 该交易日已复盘，跳过", "info");
      return;
    }
    addLog(
      `📖 复盘 ${reviews.length} 篇：${reviews.slice(0, 4).map((r) => r.title || r.scope).join("、") || "无"}`,
      "info",
    );

    // 2) 交易结果标注（结果回灌，false 不重复标注）
    try {
      const lab = await evolutionRunLabeling(null, false);
      addLog(`🧬 结果标注：新增 ${lab.labeled} 条（止损线 ${lab.stopPct}% / 目标线 ${lab.targetPct}%）`, "info");
    } catch (e) {
      addLog(`⚠️ 进化标注失败：${e}`, "warn");
    }

    // 3) 依据统计有界调权并持久化
    try {
      const stats = await evolutionStats();
      const next = evolveFromStats(stats as unknown as EvolutionStatsLike, loadEvolvedParams());
      saveEvolvedParams(next);
      evolutionNote = next.note;
      addLog(`🧠 参数进化（样本 ${next.samples}）：${next.note}`, "info");
    } catch (e) {
      addLog(`⚠️ 参数调权失败：${e}`, "warn");
    }

    // 4) 次日作战计划
    try {
      const plan = await generatePlan(null, null);
      planTitle = plan.title || "";
      planCount = plan.instructions?.length ?? 0;
      addLog(`🗺 次日作战计划：${plan.title || "已生成"}（${plan.instructions?.length ?? 0} 条指令）`, "buy");
    } catch (e) {
      addLog(`⚠️ 生成作战计划失败：${e}`, "warn");
    }

    if (tdate) autoReviewedTradeDate = tdate;
    dailyReview.value = {
      tradeDate: tdate || new Date().toISOString().slice(0, 10),
      reviewedAt: new Date().toLocaleString("zh-CN"),
      reviews: reviews.map((r) => ({ title: r.title, scope: r.scope })),
      evolutionNote,
      planTitle,
      planInstructions: planCount,
    };
    addLog(`📋 每日复盘记录已生成（${dailyReview.value.tradeDate}），可在面板查看`, "buy");
  } finally {
    autoReviewInflight = false;
  }
}

/** 榜单行 → Quote（缺失字段补默认，供统一评分 / 决策使用）。 */
function quoteFromRank(r: RankRow): Quote {
  const prev = r.pct ? r.price / (1 + r.pct / 100) : r.price;
  return {
    code: r.code, name: r.name, price: r.price, change: r.price - prev, pct: r.pct,
    open: r.price, high: r.price, low: r.price, prevClose: prev,
    volume: 0, amount: r.amount, time: Date.now(), source: "rank",
    turnover: r.turnover, pe: 0, pb: 0, amplitude: 0, volumeRatio: r.volumeRatio,
    circMv: 0, totalMv: 0,
  };
}

/**
 * 单票统一交易管线：评分 → K线 → decide 三重否决 → 信号冷却 → 凯利仓位 → 下单 / 送桥 → 看回报。
 * 自选 / 涨幅榜 / 涨停雷达等所有"出个股"的卡共用，保证交易口径一致、可无人值守。
 */
async function evaluateAndTrade(
  code: string,
  name: string,
  quote: Quote,
  category: CardId,
  regime: MarketRegime,
  paperStore: ReturnType<typeof usePaperStore>,
  points: TargetPoint[],
  rowIndex: number,
): Promise<"BUY" | "SELL" | "WATCH"> {
  const held = paperStore.positions.some((p) => p.code === code);
  const score = evaluateStock(quote, code, name);
  const daily = await withTimeout(fetchKLine(code, 101, 80), 8000, `${name} K线`);
  const evolved = loadEvolvedParams();
  let decision: Decision | null = null;
  if (daily.length >= 25) {
    decision = decide({ code, name, daily, quote, marketRegime: regime, held, params: evolved });
  }

  // 无 decision（数据不足）只允许卖出 / 观望；买入必须过 decide 三重否决。
  let action: "BUY" | "SELL" | "WATCH" = decision
    ? decision.action === "BUY" ? "BUY" : decision.action === "SELL" ? "SELL" : "WATCH"
    : score.recommendation === "SELL" ? "SELL" : "WATCH";

  // 买入信号冷却：同票冷却期内降级观望。
  if (action === "BUY") {
    if (buyInCooldown(code)) action = "WATCH";
    else markBuySignal(code);
  }

  emitScan({
    type: "target",
    cardId: category,
    code,
    signal: action === "BUY" ? "BUY" : action === "SELL" ? "SELL" : null,
  });

  points.push({
    x: 150,
    y: 200 + rowIndex * 42,
    label: `${score.name} ${score.price.toFixed(2)} ${score.pct >= 0 ? "+" : ""}${score.pct.toFixed(1)}%${decision ? ` | ${decision.score}分` : ""}`,
    type: "stock",
    isCurrent: rowIndex === 0,
    action: action === "BUY" ? "buy" : action === "SELL" ? "sell" : "scan",
  });

  if (action === "BUY") {
    const basis = decision ? decision.reasons.join("、") : score.signals.join(", ");
    addLog(
      `🟢 ${score.name}(${score.code}) 买入信号${decision ? ` [${decision.score}分·${decision.setup}·置信${(decision.confidence * 100).toFixed(0)}%]` : ""}: ${basis}`,
      "buy",
    );
    opportunityFound = true;
    if (canAutoTrade(category)) {
      let vol: number | undefined;
      if (decision) {
        const conf = Math.max(0, Math.min(1, decision.confidence * evolved.confidenceScale));
        const plan = planPosition({
          code,
          price: score.price,
          confidence: conf,
          cash: paperStore.account.cash,
          totalAssets: paperStore.totalAssets || paperStore.account.initCash,
          holdings: paperStore.positions.map((p) => ({ code: p.code, value: p.costAmount })),
          marketRegime: regime,
        });
        vol = plan.vol || undefined;
        addLog(`   ${plan.reason}`, "info");
      }
      await executeBuy(score, paperStore, vol);
    } else {
      void pushTicketToBridge(score, paperStore);
      addLog(`   ↪ 未授权【${cardTitle(category)}】自动交易，信号已送确认桥，可人工确认`, "info");
    }
  } else if (action === "SELL") {
    const basis = decision ? decision.reasons.join("、") : score.signals.join(", ");
    addLog(`🔴 ${score.name}(${score.code}) 卖出信号: ${basis}`, "sell");
    if (canAutoTrade(category)) {
      await executeSell(score, paperStore);
    } else {
      void pushTicketToBridge(score, paperStore);
      addLog(`   ↪ 未授权【${cardTitle(category)}】自动交易，信号已送确认桥，可人工确认`, "info");
    }
  } else if (decision && decision.risks.length) {
    addLog(`👁 ${score.name}(${code}) 观望：${decision.risks[0]}`, "info");
  }
  return action;
}

async function scanWatchlist(
  wl: ReturnType<typeof useWatchlistStore>,
  quotes: ReturnType<typeof useQuotesStore>,
  paperStore: ReturnType<typeof usePaperStore>,
) {
  const list = wl.currentStocks;
  if (!list.length) return;

  addLog(`📋 扫描自选股（${list.length} 只）...`, "info");
  const regime = await getMarketRegime();
  addLog(
    `🧭 大盘状态：${regime === "up" ? "偏多" : regime === "down" ? "走弱" : "震荡"}`,
    regime === "down" ? "warn" : "info",
  );

  const scores: StockScore[] = [];
  const newPoints: TargetPoint[] = [];

  let row = 0;
  let noQuote = 0;
  for (const s of list) {
    const q = quotes.map[s.code];
    if (!q) {
      noQuote++;
      addLog(`   ⏭ ${s.name || s.code} 暂无实时行情，跳过（可检查行情订阅 / 刷新）`, "info");
      continue;
    }
    const nm = q.name || s.name;
    try {
      // 单票隔离 + 硬超时：一只挂起 / 抛错不影响其余票
      await withTimeout(
        evaluateAndTrade(s.code, nm, q, "watch", regime, paperStore, newPoints, row),
        14000,
        `${nm}研判`,
      );
    } catch (e) {
      addLog(
        `⚠️ ${nm}(${s.code}) 研判/交易异常，已跳过不影响其他票：${String((e as Error)?.message ?? e)}`,
        "warn",
      );
    }
    scores.push(evaluateStock(q, s.code, nm)); // 评分供面板 / K线点选复用
    row++;
  }

  stockScores.value = scores;
  targetPoints.value = newPoints;

  // 整轮无买点：明确数量与原因，避免用户误以为系统不工作
  if (!newPoints.some((p) => p.action === "buy")) {
    addLog(
      `📭 自选 ${list.length} 只本轮均无符合纪律买点（下跌 / 下降趋势 / 数据不足${noQuote ? `，其中 ${noQuote} 只无行情` : ""}）`,
      "info",
    );
    addLog(`   ↪ 想捕捉强势机会：爬虫配置 → 自动交易授权勾选「涨幅榜 / 涨停雷达 / 题材库」`, "info");
  }
}

// ===== 市场情绪：从真实涨跌停池读取（60s TTL，启动首轮前先确定，避免首轮全 neutral）=====
let sentimentAt = 0;
let sentimentInflight: Promise<void> | null = null;

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 今日池为空（休市/周末）时按工作日向前回退最多 4 天重取。 */
async function fetchPoolWithFallback(): Promise<{ ztTotal: number; maxBoard: number; zbTotal: number }> {
  const today = new Date();
  for (let back = 0; back <= 4; back++) {
    const d = new Date(today);
    d.setDate(today.getDate() - back);
    if (d.getDay() === 0 || d.getDay() === 6) continue; // 周末跳过
    const date = back === 0 ? "" : ymd(d);
    try {
      const [zt, zb] = await Promise.all([fetchZtPool(date), fetchZbPool(date)]);
      if (zt.total > 0 || zb.total > 0) {
        const maxBoard = zt.list.reduce((m, s) => Math.max(m, s.boards || 0), 0);
        return { ztTotal: zt.total, maxBoard, zbTotal: zb.total };
      }
    } catch {
      // 该日取不到，继续向前回退
    }
  }
  return { ztTotal: 0, maxBoard: 0, zbTotal: 0 };
}

async function ensureSentiment(force = false): Promise<void> {
  const fresh = Date.now() - sentimentAt < 60_000;
  if (!force && fresh) return;
  if (sentimentInflight) return sentimentInflight;
  sentimentInflight = (async () => {
    try {
      const { ztTotal, maxBoard, zbTotal } = await fetchPoolWithFallback();
      marketSentiment.value = {
        limitUp: ztTotal,
        limitDown: 0, // 后端暂无跌停池
        maxBoard,
        bombRate: ztTotal + zbTotal > 0 ? zbTotal / (ztTotal + zbTotal) : 0,
        level: ztTotal >= 50 ? "hot" : ztTotal >= 20 ? "neutral" : "cold",
      };
      sentimentAt = Date.now();
    } catch {
      // 取不到保持上次/中性，不阻断扫描
    } finally {
      sentimentInflight = null;
    }
  })();
  return sentimentInflight;
}

// ===== 扫描涨停雷达（情绪判断） =====
/** 无数据时显式提示等待（不使用虚构数据），下一轮 scanRound 会自动重试 */
function showWaiting(what: string): void {
  targetPoints.value = [
    { x: 120, y: 260, label: `⏳ 等待${what}行情…`, type: "index", isCurrent: true, action: "scan" },
  ];
}

async function scanRadar(_quotes: ReturnType<typeof useQuotesStore>) {
  addLog(`🚀 扫描涨停雷达，判断情绪并找炸板回封 / 弱转强...`, "info");

  await ensureSentiment(true);
  const { limitUp, limitDown, maxBoard, level } = marketSentiment.value;
  const levelText = level === "hot" ? "亢奋" : level === "cold" ? "冷清" : "中性";
  addLog(`📊 市场情绪：${levelText}（涨停${limitUp}家，最高${maxBoard}板）`, "info");

  // 涨停池：逐只判定炸板回封 / 弱转强（其余不盲目打板）
  let zt: ZtStock[] = [];
  try {
    const pool = await withTimeout(fetchZtPool(), 8000, "涨停池");
    zt = pool?.list ?? [];
  } catch (e) {
    addLog(`⚠️ 涨停池获取失败：${String((e as Error)?.message ?? e)}`, "warn");
  }

  targetPoints.value = [
    { x: 1100, y: 250, label: `涨停 ${limitUp}家`, type: "index", isCurrent: true },
    { x: 1100, y: 300, label: `跌停 ${limitDown}家`, type: "index" },
    { x: 1100, y: 350, label: `最高 ${maxBoard}板`, type: "index" },
    ...zt.slice(0, 6).map((z, i) => ({
      x: 150, y: 200 + i * 42,
      label: `${z.name} ${z.boards}板 封单${(z.fund / 1e8).toFixed(1)}亿 炸${z.broken}`,
      type: "stock" as const, isCurrent: i === 0, action: "scan" as const,
    })),
  ];

  let n = 0;
  for (const z of zt) {
    const sig =
      boardReseal(z as unknown as BoardStock) ?? boardWeak2Strong(z as unknown as BoardStock);
    if (sig) { await executeSpecialBuy(sig, "radar"); n++; }
  }
  addLog(
    `🎯 涨停池 ${zt.length} 只：回封 / 弱转强信号 ${n} 个（其余不盲目打板）`,
    n ? "buy" : "info",
  );
}

// ===== 扫描涨幅榜（真实数据）=====
let rankCache: RankRow[] = [];
let rankCacheAt = 0;
const RANK_CACHE_MS = 15_000; // 榜单缓存 15s

async function scanRank(_quotes: ReturnType<typeof useQuotesStore>) {
  addLog(`📈 扫描涨幅榜，找领涨股...`, "info");

  let rows: RankRow[] | null = null;
  if (Date.now() - rankCacheAt < RANK_CACHE_MS && rankCache.length) {
    rows = rankCache; // 缓存命中
  } else {
    try {
      rows = await fetchRankBoard("gainers", 1, 20);
      rankCache = rows;
      rankCacheAt = Date.now();
    } catch (e) {
      addLog(`⚠️ 涨幅榜数据获取失败: ${e}`, "warn");
      rows = rankCache; // 回退上次缓存
    }
  }
  await processRankData(rows);
}

async function processRankData(list: RankRow[]) {
  if (!list || !list.length) {
    addLog(`⏳ 涨幅榜暂无数据，等待下一轮重试`, "warn");
    showWaiting("涨幅榜");
    return;
  }
  const regime = await getMarketRegime();
  const paperStore = usePaperStore();
  const top = list.slice(0, 8);
  const newPoints: TargetPoint[] = [];
  let row = 0;
  for (const g of top) {
    const pct = g.pct ?? 0;
    if (pct >= 2 && pct <= 8) {
      // 领涨未涨停：走统一决策 / 交易管线（受涨幅榜授权控制，未授权送确认桥）
      try {
        await withTimeout(
          evaluateAndTrade(g.code, g.name || g.code, quoteFromRank(g), "rank", regime, paperStore, newPoints, row),
          14000,
          `${g.name || g.code}研判`,
        );
      } catch (e) {
        addLog(`⚠️ ${g.name || g.code} 研判异常已跳过：${String((e as Error)?.message ?? e)}`, "warn");
      }
    } else {
      // 已涨停(>9.5)不追 / 涨幅过小：仅作扫描点
      newPoints.push({
        x: 150,
        y: 200 + row * 42,
        label: `${g.name || g.code} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
        type: "stock",
        isCurrent: false,
        action: pct > 9.5 ? "sell" : "scan",
      });
    }
    row++;
  }
  targetPoints.value = newPoints;

  const top3 = top.slice(0, 3).map((g) => `${g.name || g.code} ${(g.pct ?? 0) >= 0 ? "+" : ""}${(g.pct ?? 0).toFixed(1)}%`).join(" | ");
  addLog(`✅ 涨幅榜 TOP3：${top3}`, "info");
  if (!newPoints.some((p) => p.action === "buy")) {
    addLog(`📭 涨幅榜本轮无符合纪律买点（多已涨停不追 / 趋势不达标）`, "info");
  }
}

// ===== 扫描大盘指数 =====
let marketCache: Quote[] = [];
let marketCacheAt = 0;
const MARKET_CACHE_MS = 10_000;

async function scanMarket() {
  addLog(`📊 扫描大盘指数...`, "info");

  if (Date.now() - marketCacheAt < MARKET_CACHE_MS && marketCache.length) {
    processMarketData(marketCache);
    return;
  }

  try {
    const indices = await fetchIndexQuotes();
    marketCache = indices;
    marketCacheAt = Date.now();
    processMarketData(indices);
  } catch (e) {
    addLog(`⚠️ 大盘指数获取失败: ${e}`, "warn");
    addLog(`⏳ 不使用虚构数据，下一轮自动重试`, "warn");
    showWaiting("大盘指数");
  }
}

function processMarketData(list: Quote[]) {
  if (!list || !list.length) {
    addLog(`⏳ 大盘指数暂无数据，等待下一轮重试`, "warn");
    showWaiting("大盘指数");
    return;
  }
  const items = list.slice(0, 5);
  const newPoints: TargetPoint[] = items.map((q, i) => ({
    x: 120,
    y: 230 + i * 48,
    label: `${q.name || q.code} ${q.pct >= 0 ? "+" : ""}${q.pct.toFixed(2)}%`,
    type: "index",
    isCurrent: i === 0,
    action: q.pct > 1 ? "buy" : q.pct < -1 ? "sell" : "scan",
  }));

  targetPoints.value = newPoints;

  // 大盘信号事件
  items.forEach((q, i) => {
    const signal: SpiderSignalKind = q.pct > 2 ? "BUY" : q.pct < -2 ? "SELL" : null;
    setTimeout(() => {
      emitScan({ type: "target", cardId: "radar", code: q.code, signal });
    }, 140 * i);
  });

  const summary = list.slice(0, 3).map(q => `${q.name || q.code} ${q.pct >= 0 ? "+" : ""}${q.pct.toFixed(2)}%`).join(" | ");
  addLog(`✅ 大盘：${summary}`, "info");
}

// ===== 扫描板块行情（真实数据）=====
let sectorCache: any[] = [];
let sectorCacheAt = 0;
const SECTOR_CACHE_MS = 20_000;

async function scanSector() {
  addLog(`🏭 扫描行业板块，找热门板块...`, "info");

  if (Date.now() - sectorCacheAt < SECTOR_CACHE_MS && sectorCache.length) {
    processSectorData(sectorCache);
    return;
  }

  try {
    const sectors = await fetchSectors("industry");
    sectorCache = sectors;
    sectorCacheAt = Date.now();
    processSectorData(sectors);
  } catch (e) {
    addLog(`⚠️ 行业板块数据获取失败: ${e}`, "warn");
    addLog(`⏳ 不使用虚构数据，下一轮自动重试`, "warn");
    showWaiting("行业板块");
  }
}

function processSectorData(list: Array<{ name: string; changePct?: number; pct?: number; leadStock?: string; leader?: string }>) {
  if (!list || !list.length) {
    addLog(`⏳ 行业板块暂无数据，等待下一轮重试`, "warn");
    showWaiting("行业板块");
    return;
  }
  const top = list.slice(0, 5);
  const newPoints: TargetPoint[] = top.map((s, i) => {
    const pct = s.changePct ?? s.pct ?? 0;
    return {
      x: 100,
      y: 230 + i * 52,
      label: `${s.name} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
      type: "index",
      isCurrent: i === 0,
      action: pct >= 2 ? "buy" : pct <= -2 ? "sell" : "scan",
    };
  });

  targetPoints.value = newPoints;

  // 板块信号事件（供蜘蛛可视化）
  top.forEach((s, i) => {
    const pct = s.changePct ?? s.pct ?? 0;
    const code = `sector:${s.name}`;
    const signal: SpiderSignalKind = pct >= 3 ? "BUY" : pct <= -3 ? "SELL" : null;
    setTimeout(() => {
      emitScan({ type: "target", cardId: "sector", code, signal });
    }, 140 * i);
  });

  const topNames = top.slice(0, 3).map(s => `${s.name} +${(s.changePct ?? s.pct ?? 0).toFixed(1)}%`).join(" | ");
  addLog(`✅ 领涨板块：${topNames}`, "info");
}

// ===== 扫描概念板块 =====
let conceptCache: any[] = [];
let conceptCacheAt = 0;
const CONCEPT_CACHE_MS = 20_000;

async function scanConcept() {
  addLog(`💡 扫描概念板块，找题材热点...`, "info");

  if (Date.now() - conceptCacheAt < CONCEPT_CACHE_MS && conceptCache.length) {
    processConceptData(conceptCache);
    return;
  }

  try {
    const concepts = await fetchSectors("concept");
    conceptCache = concepts;
    conceptCacheAt = Date.now();
    processConceptData(concepts);
  } catch (e) {
    addLog(`⚠️ 概念板块数据获取失败: ${e}`, "warn");
    addLog(`⏳ 不使用虚构数据，下一轮自动重试`, "warn");
    showWaiting("概念板块");
  }
}

function processConceptData(list: Array<{ name: string; changePct?: number; pct?: number }>) {
  if (!list || !list.length) {
    addLog(`⏳ 概念板块暂无数据，等待下一轮重试`, "warn");
    showWaiting("概念板块");
    return;
  }
  const top = list.slice(0, 5);
  const newPoints: TargetPoint[] = top.map((c, i) => {
    const pct = c.changePct ?? c.pct ?? 0;
    return {
      x: 100,
      y: 230 + i * 52,
      label: `${c.name} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
      type: "index",
      isCurrent: i === 0,
      action: pct >= 3 ? "buy" : pct <= -3 ? "sell" : "scan",
    };
  });

  targetPoints.value = newPoints;

  const topNames = top.slice(0, 3).map(c => `${c.name} +${(c.changePct ?? c.pct ?? 0).toFixed(1)}%`).join(" | ");
  addLog(`✅ 热门概念：${topNames}`, "info");
}

// ═══════════════════════ 集合竞价抢筹 ═══════════════════════
async function scanAuction() {
  addLog(`🔔 扫描集合竞价，找高开抢筹标的...`, "info");
  let data;
  try {
    data = await withTimeout(fetchAuction(), 8000, "集合竞价");
  } catch (e) {
    addLog(`⚠️ 集合竞价获取失败：${String((e as Error)?.message ?? e)}`, "warn");
    showWaiting("集合竞价");
    return;
  }
  const high = data?.highOpen ?? [];
  if (!high.length) {
    addLog(`⏳ 暂无高开抢筹数据（仅 9:15–9:25 有效）`, "info");
    return;
  }
  const regime = await getMarketRegime();
  targetPoints.value = high.slice(0, 8).map((a, i) => ({
    x: 150, y: 200 + i * 42,
    label: `${a.name} 高开${(a.gap ?? a.pct).toFixed(2)}% 竞价${(a.amount / 1e8).toFixed(2)}亿`,
    type: "stock", isCurrent: i === 0, action: "scan",
  }));
  let n = 0;
  for (const a of high.slice(0, 8)) {
    const sig = auctionGrab(a as AuctionStock, regime);
    if (sig) { await executeSpecialBuy(sig, "auction"); n++; }
  }
  if (!n) addLog(`📭 竞价无符合纪律抢筹标的（高开幅度 / 竞价额不达标，或大盘走弱）`, "info");
}

// ═══════════════════════ 题材库 / 板块成分股 ═══════════════════════
function normalizeThemeStock(x: any): { code: string; name: string; price: number; pct: number } | null {
  const code = String(x.symbol || x.code || "").replace(/^(sh|sz)/, "");
  if (!code) return null;
  return {
    code,
    name: x.name || x.stockname || code,
    price: parseFloat(x.trade || x.price || 0),
    pct: parseFloat(x.changeratio || x.changepercent || x.pct || 0),
  };
}

async function scanThemeStocks(category: "sector" | "themelib") {
  const kind: "industry" | "concept" = category === "sector" ? "industry" : "concept";
  addLog(`🏭 扫描【${cardTitle(category)}】，定位最强题材并下钻成分股...`, "info");
  let boards: Array<{ name: string; changePct?: number; pct?: number }> = [];
  try {
    boards = await withTimeout(fetchSectors(kind), 8000, "板块列表");
  } catch (e) {
    addLog(`⚠️ 板块列表获取失败：${String((e as Error)?.message ?? e)}`, "warn");
    showWaiting(cardTitle(category));
    return;
  }
  if (!boards.length) { showWaiting(cardTitle(category)); return; }

  const sorted = [...boards].sort(
    (a, b) => (b.changePct ?? b.pct ?? 0) - (a.changePct ?? a.pct ?? 0),
  );
  const topBoards = sorted.slice(0, 5);
  targetPoints.value = topBoards.map((s, i) => {
    const pct = s.changePct ?? s.pct ?? 0;
    return {
      x: 100, y: 230 + i * 52, label: `${s.name} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
      type: "index", isCurrent: i === 0,
      action: pct >= 2 ? "buy" : pct <= -2 ? "sell" : "scan",
    };
  });
  addLog(
    `✅ 强势题材：${topBoards.slice(0, 3).map((s) => `${s.name} +${(s.changePct ?? s.pct ?? 0).toFixed(1)}%`).join(" | ")}`,
    "info",
  );

  // 下钻最强 2 个板块，在成分股里找领涨未涨停
  let bought = 0;
  for (const b of topBoards.slice(0, 2)) {
    let members: any[] = [];
    try {
      members = await withTimeout(fetchSectorStocks(b.name, kind), 8000, `${b.name}成分股`);
    } catch { continue; }
    for (const x of members.slice(0, 10)) {
      const m = normalizeThemeStock(x);
      if (!m) continue;
      const sig = themeLeader(m);
      if (sig) { await executeSpecialBuy(sig, category); bought++; }
    }
  }
  if (!bought) {
    addLog(`📭 【${cardTitle(category)}】成分股本轮无未涨停领涨买点（多已涨停 / 涨幅不足）`, "info");
  }
}

// ═══════════════════════ 短线精灵异动 ═══════════════════════
const elfBuffer: ElfEventLike[] = [];
const elfHandled = new Set<string>();
let elfUnlisten: UnlistenFn | null = null;

async function ensureSpiderFeed(wl: ReturnType<typeof useWatchlistStore>): Promise<void> {
  if (!elfUnlisten) {
    elfUnlisten = await listen<SpiderEvent[]>("spider:events", (e) => {
      (e.payload ?? []).forEach((ev) => {
        elfBuffer.unshift(ev as unknown as ElfEventLike);
      });
      if (elfBuffer.length > 120) elfBuffer.length = 120;
    });
  }
  try {
    if (!wl.loaded) await wl.load();
    await startSpider(wl.codes);
  } catch { /* 后端未就绪则用已有 buffer */ }
}

async function scanSpider(wl: ReturnType<typeof useWatchlistStore>) {
  addLog(`⚡ 扫描短线精灵异动...`, "info");
  await ensureSpiderFeed(wl);
  const recent = elfBuffer.slice(0, 30);
  targetPoints.value = recent.slice(0, 8).map((e, i) => ({
    x: 150, y: 200 + i * 42,
    label: `${e.name} ${e.kind} ${e.pct >= 0 ? "+" : ""}${e.pct.toFixed(2)}%`,
    type: "stock", isCurrent: i === 0, action: "scan",
  }));
  let n = 0;
  for (const e of recent) {
    const key = `${e.code}:${e.kind}:${e.time}`;
    if (elfHandled.has(key)) continue;
    const sig = elfSurge(e);
    if (sig) { elfHandled.add(key); await executeSpecialBuy(sig, "spider"); n++; }
  }
  if (!n) addLog(`📭 短线精灵近期无符合纪律强异动（或已处理）`, "info");
}

// ===== 执行交易（带完整风控检查）=====
async function executeBuy(score: StockScore, paperStore: ReturnType<typeof usePaperStore>, volOverride?: number) {
  try {
    const phase = getTradingPhase();
    const afterHours = !canOpenNewPosition(phase);
    if (afterHours) {
      addLog(
        `🌙 【盘后模拟】非交易时段（${phaseLabel(phase)}），按当前价模拟买入（仅模拟盘，实盘不生效）`,
        "info",
      );
    }
    const priceMap: Record<string, number> = {};
    paperStore.positions.forEach(p => {
      priceMap[p.code] = p.costAmount / Math.max(p.vol, 1);
    });
    // 用当前价更新 priceMap
    priceMap[score.code] = score.price;

    const dec = checkBuyRisk(
      score.code, score.name, score.price,
      {
        initCash: paperStore.account.initCash,
        cash: paperStore.account.cash,
        positions: paperStore.positions.map(p => ({
          code: p.code, name: p.name, vol: p.vol, costAmount: p.costAmount,
        })),
        trades: [],
        todayBuyCount: 0,
        todaySellCount: 0,
        dayHighValue: paperStore.account.initCash,
        totalHighValue: paperStore.account.initCash * 1.1,
      },
      priceMap,
      new Date(),
      riskConfig.value,
    );

    if (!dec.allowed) {
      addLog(`⚠️ 风控拦截（${dec.reason}）：${score.name}(${score.code})`, "warn");
      return;
    }

    const riskVol = dec.suggestedVol ?? 100;
    // 凯利仓位（已含大盘/单票上限）再与风控资金/总仓上限取小，双重兜底
    const vol = volOverride && volOverride > 0 ? Math.min(volOverride, riskVol) : riskVol;
    await paperStore.buy(score.code, score.name, score.price, vol);
    addLog(
      `${afterHours ? "🌙" : "✅"} 买入 ${score.name}(${score.code}) ${vol}股 @ ${score.price.toFixed(2)} (${score.signals.slice(0, 2).join("、")})`,
      "buy",
    );
  } catch (e) {
    addLog(`❌ 买入失败 ${score.code}: ${e}`, "warn");
  }
}

async function executeSell(score: StockScore, paperStore: ReturnType<typeof usePaperStore>) {
  try {
    const position = paperStore.positions.find(p => p.code === score.code);
    if (!position) {
      addLog(`⚠️ 没有持仓 ${score.code}，无法卖出`, "warn");
      return;
    }

    // 估算持仓期间最高价（简化：用现价和成本价的较高值作为"最高"，后续可接入真实最高价追踪）
    const costPrice = position.costAmount / Math.max(position.vol, 1);
    const highestPrice = Math.max(costPrice, score.price);

    const dec = checkSellRisk(
      { code: position.code, name: position.name, vol: position.vol, costAmount: position.costAmount },
      score.price,
      highestPrice,
      riskConfig.value,
    );

    // 评分触发卖出 或 风控触发止盈止损，都卖
    const signalSell = score.recommendation === "SELL" || score.recommendation === "SELL_STRONG";
    if (!dec.allowed && !signalSell) {
      return;
    }

    const reason = dec.allowed
      ? dec.reason
      : `评分卖出（${score.recommendation}，${score.signals.slice(0, 2).join("、")}）`;

    await paperStore.sell(score.code, score.price, position.vol);
    addLog(`✅ 卖出 ${score.name}(${score.code}) ${position.vol}股 @ ${score.price.toFixed(2)} | ${reason}`, "sell");
  } catch (e) {
    addLog(`❌ 卖出失败 ${score.code}: ${e}`, "warn");
  }
}

let lastPhase: TradingPhase | null = null;

// ===== 特殊策略信号 → 统一交易执行（打板 / 竞价 / 精灵 / 题材，复用冷却·凯利·风控·成交）=====
const STRATEGY_LABEL: Record<SpecialStrategy, string> = {
  "board-reseal": "炸板回封打板",
  "board-weak2strong": "弱转强打板",
  "auction-grab": "集合竞价抢筹",
  "elf-surge": "短线精灵异动",
  "theme-leader": "题材领涨",
};

function scoreFromSpecial(sig: SpecialSignal): StockScore {
  return {
    code: sig.code,
    name: sig.name,
    price: sig.price,
    pct: sig.pct,
    score: Math.round(sig.confidence * 100),
    maxScore: 100,
    signals: sig.reasons,
    risks: [],
    recommendation: "BUY",
    breakdown: { trend: 0, volume: 0, volatility: 0, valuation: 0, sentiment: 0, riskPenalty: 0 },
  };
}

async function executeSpecialBuy(
  sig: SpecialSignal,
  category: CardId,
  paperStore?: ReturnType<typeof usePaperStore>,
): Promise<void> {
  if (buyInCooldown(sig.code)) {
    addLog(`⏳ ${sig.name} 买入信号冷却中，本轮跳过`, "info");
    return;
  }
  markBuySignal(sig.code);
  const store = paperStore ?? usePaperStore();
  const score = scoreFromSpecial(sig);
  addLog(
    `🟢 ${sig.name}(${sig.code}) ${STRATEGY_LABEL[sig.strategy]}信号 [置信${(sig.confidence * 100).toFixed(0)}%]：${sig.reasons.join("、")}`,
    "buy",
  );
  opportunityFound = true;

  if (canAutoTrade(category)) {
    const regime = await getMarketRegime();
    const conf = Math.max(0, Math.min(1, sig.confidence * loadEvolvedParams().confidenceScale));
    const plan = planPosition({
      code: sig.code,
      price: sig.price,
      confidence: conf,
      cash: store.account.cash,
      totalAssets: store.totalAssets || store.account.initCash,
      holdings: store.positions.map((p) => ({ code: p.code, value: p.costAmount })),
      marketRegime: regime,
    });
    addLog(`   ${plan.reason}`, "info");
    await executeBuy(score, store, plan.vol || undefined);
  } else {
    void pushTicketToBridge(score, store);
    addLog(`   ↪ 未授权【${cardTitle(category)}】自动交易，信号已送确认桥，可人工确认`, "info");
  }
}


// ===== 扫描一轮（智能决策，不是机械循环） =====
function scanRound(
  wl: ReturnType<typeof useWatchlistStore>,
  quotes: ReturnType<typeof useQuotesStore>,
  paperStore: ReturnType<typeof usePaperStore>,
  onSwitchCard: (cardId: CardId) => boolean,
) {
  // 暂停中不推进轮次
  if (paused.value) return;

  // 时段切换：日志提示当前阶段与动作（交易大脑的时间节奏）
  const phase = getTradingPhase();
  if (phase !== lastPhase) {
    lastPhase = phase;
    addLog(`🕐 进入【${phaseLabel(phase)}】：${phaseAction(phase)}`, "info");
  }

  // 盘后 / 休市：自动复盘流水线（按交易日幂等，异步不阻断巡回）
  void maybeAutoReview();

  // 智能决定下一个扫哪个卡片
  const priority = getCardPriority();
  let cardId: CardId;

  // 如果发现了好机会，并且还没深度分析够次数，就继续在当前卡片深入
  if (opportunityFound && deepAnalysisCount < maxDeepAnalysis) {
    cardId = currentCard.value;
    deepAnalysisCount++;
    addLog(`🔍 发现好机会，继续深入分析【${cardTitle(cardId)}】（第 ${deepAnalysisCount} 次）...`, "info");
    // 深度分析留在当前卡：不回调切卡，按已切换处理并补发 card 事件驱动蜘蛛重走本轮
    emitScan({ type: "card", cardId });
  } else {
    // 换下一个卡片（按优先级，先不写 currentCard——卡片未打开时不顶包顶栏）
    const step = currentStep.value;
    const cardIdx = step % priority.length;
    cardId = priority[cardIdx];
    opportunityFound = false;
    deepAnalysisCount = 0;

    // 切换卡片（回调返回卡片是否真的处于打开状态）
    const switched = onSwitchCard(cardId);

    // targetPoints 一律由下方各 scan* 真实函数产出；
    // 已移除旧的 collectFromStore + 300ms 二次覆盖（那是面板闪烁 / mock 假数据的根源）。

    if (switched) {
      currentCard.value = cardId; // 确认打开后才更新「📍 当前」，避免顶栏为关闭卡背锅
      addLog(`🔄 智能切换到【${cardTitle(cardId)}】`, "info");
      emitScan({ type: "card", cardId });
    } else {
      // 卡片未打开：沿优先级顺序向后找下一张已打开的卡片，最多找一整轮
      // 避免 50ms 极速空转（旧实现），也避免死循环
      const startIdx = currentStep.value % priority.length;
      let found = false;
      for (let offset = 1; offset <= priority.length; offset++) {
        const tryIdx = (startIdx + offset) % priority.length;
        const tryCard = priority[tryIdx];
        const trySwitched = onSwitchCard(tryCard);
        if (trySwitched) {
          cardId = tryCard;
          currentStep.value = currentStep.value - (currentStep.value % priority.length) + tryIdx;
          currentCard.value = cardId;
          addLog(`🔄 智能切换到【${cardTitle(cardId)}】`, "info");
          emitScan({ type: "card", cardId });
          found = true;
          break;
        }
      }
      if (!found) {
        // 一整轮都没找到打开的卡片：按正常节奏（2s）兜底重试，不极速空转
        currentStep.value++;
        window.setTimeout(() => { if (running.value) advanceRound(); }, 2000);
        return;
      }
    }
  }

  // 根据卡片类型扫描
  switch (cardId) {
    case "watch":
      safeAsync(scanWatchlist(wl, quotes, paperStore), "自选扫描");
      break;
    case "rank":
      safeAsync(scanRank(quotes), "榜单扫描");
      break;
    case "sector":
      safeAsync(scanThemeStocks("sector"), "板块成分股");
      break;
      break;
    case "themelib":
      safeAsync(scanThemeStocks("themelib"), "题材库成分股");
      break;
    case "auction":
      safeAsync(scanAuction(), "集合竞价");
      break;
    case "spider":
      safeAsync(scanSpider(wl), "短线精灵");
      break;
      break;
    case "radar":
      safeAsync(scanRadar(quotes), "雷达扫描");
      break;
    case "chart":
      addLog(`📈 分析 K 线图...`, "info");
      break;
    case "trade":
      addLog(`💰 检查交易面板...`, "info");
      break;
    case "dragon":
      addLog(`🐉 扫描龙虎榜...`, "info");
      break;
    case "screener":
      addLog(`🔍 条件选股扫描...`, "info");
      break;
    default:
      // 无专属深度扫描器的卡：蜘蛛已按 card 事件逐行扫描，这里记录真实浏览，不产出假研判
      addLog(`👁 浏览【${cardTitle(cardId)}】，逐行扫描中...`, "info");
      break;
  }

  currentStep.value++;
}

/** 异步扫描统一兜底：捕获 reject 并写日志，避免静默中断、无任何记录。 */
function safeAsync(p: Promise<unknown>, tag: string): void {
  p.catch((e) => {
    addLog(`⚠️ ${tag}异常（已兜底，看门狗将继续推进）：${String((e as Error)?.message ?? e)}`, "warn");
  });
}

/** 给任意 Promise 加硬超时：IPC / 请求挂起时到时 reject，绝不永久等待。 */
function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  let t = 0;
  const timer = new Promise<never>((_, reject) => {
    t = window.setTimeout(() => reject(new Error(`${tag}超时(${Math.round(ms / 1000)}s)`)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

// ===== 看门狗：30s 未收到蜘蛛完成推进时兜底进入下一轮 =====
function armWatchdog(): void {
  if (watchdog !== null) clearTimeout(watchdog);
  watchdog = window.setTimeout(() => {
    if (running.value) advanceRound();
  }, WATCHDOG_MS);
}

/**
 * 进入下一轮：由覆盖层在蜘蛛走完当前卡（身体到位且数据包飞完）后事件驱动调用，
 * 也用于关卡跳过与看门狗兜底。每次调用重新装裱看门狗。
 */
export function advanceRound(): void {
  if (!running.value) return;
  armWatchdog();   // 先装看门狗：即使本轮同步抛错，30s 后仍能自愈推进
  try {
    const wl = useWatchlistStore();
    const quotes = useQuotesStore();
    const paperStore = usePaperStore();
    scanRound(wl, quotes, paperStore, (id) => (switchRef ? switchRef(id) : true));
  } catch (e) {
    addLog(`⚠️ 本轮同步异常（已兜底，看门狗将重试）：${String((e as Error)?.message ?? e)}`, "warn");
  }
}

/** 蜘蛛仍在活动时的心跳：重置看门狗，避免大视口下一轮正常行走被 30s 兜底误切 */
export function heartbeat(): void {
  if (running.value) armWatchdog();
}

// ===== 控制函数 =====
async function start(onSwitchCard: (cardId: CardId) => boolean) {
  // 重入守卫：两个宿主（悬浮层/dock 卡片）重复启动会重叠 scanRound 并覆盖 switchRef
  if (running.value) return;
  const wl = useWatchlistStore();
  const quotes = useQuotesStore();
  const paperStore = usePaperStore();

  running.value = true;
  visible.value = true; // 显示覆盖层
  paused.value = false;
  addLog("🕷 AI 爬虫机器人启动...", "info");

  // 切卡回调存引用：advanceRound 与看门狗通过它回调 UI 层
  switchRef = onSwitchCard;

  // 首轮排卡序与评分都依赖市场情绪：先取真实涨跌停情绪，避免首轮全 neutral 少加分
  await ensureSentiment();
  if (!running.value) return; // await 期间已被停止

  // 立即执行一轮（同步异常兜底，绝不静默退出）
  try {
    scanRound(wl, quotes, paperStore, (id) => (switchRef ? switchRef(id) : true));
  } catch (e) {
    addLog(`⚠️ 首轮异常（已兜底）：${String((e as Error)?.message ?? e)}`, "warn");
  }

  // 后续轮次由蜘蛛完成事件 advanceRound() 推进；看门狗仅兜底
  armWatchdog();
}

function stop() {
  running.value = false;
  visible.value = false; // 隐藏覆盖层
  paused.value = false;
  if (watchdog !== null) { clearTimeout(watchdog); watchdog = null; }
  switchRef = null;
  addLog("爬虫机器人已停止", "info");
}

function pause() {
  if (!running.value || paused.value) return;
  paused.value = true;
  addLog("⏸ 爬虫已暂停（蜘蛛停在原地，不推进扫描）", "info");
}

function resume() {
  if (!running.value || !paused.value) return;
  paused.value = false;
  addLog("▶️ 爬虫已继续", "info");
  window.setTimeout(() => {
    if (running.value && !paused.value) advanceRound();
  }, 150);
}

export function addLog(text: string, type: LogEntry["type"] = "info") {
  const now = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  logs.value.unshift({ time: now, text, type });
  if (logs.value.length > 500) logs.value.pop();
}

function clearLogs() {
  logs.value = [];
}

// HMR：模块热替换前必须停掉后台定时器。
// 否则旧模块闭包攥着旧 switchRef/onSwitchCard，看门狗到期仍会开卡切卡，
// 而 UI 上点"停止"只清新模块的 watchdog，旧定时器泄漏。
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stop();
  });
}

export function useSpiderBotEngine() {
  return {
    // 状态
    running,
    visible,
    paused,
    dailyReview,
    autoTrade,
    semiAuto,
    currentStep,
    currentCard,
    targetPoints,
    logs,
    stockScores,
    marketSentiment,
    crawlSources,
    autoTradeSources,
    // 方法
    start,
    heartbeat,
    stop,
    pause,
    resume,
    clearLogs,
    advanceRound,
    setAutoTrade: (v: boolean) => { autoTrade.value = v; },
    setSemiAuto: (v: boolean) => { semiAuto.value = v; },
    /** 设置单个爬取源是否启用 */
    setCrawlSource: (key: keyof CrawlSourceConfig, v: boolean) => {
      crawlSources.value[key] = v;
    },
    /** 设置单个来源是否允许自动交易 */
    setAutoTradeSource: (key: keyof CrawlSourceConfig, v: boolean) => {
      autoTradeSources.value[key] = v;
    },
    /** 批量更新爬取源配置 */
    updateCrawlSources: (patch: Partial<CrawlSourceConfig>) => {
      Object.assign(crawlSources.value, patch);
    },
    /** 批量更新自动交易来源配置 */
    updateAutoTradeSources: (patch: Partial<CrawlSourceConfig>) => {
      Object.assign(autoTradeSources.value, patch);
    },
    // 策略配置
    currentStrategy,
    scoringConfig,
    riskConfig,
    applyStrategy,
    strategyNames: strategyNamesMap,
    // 绩效统计
    performance,
  };
}
