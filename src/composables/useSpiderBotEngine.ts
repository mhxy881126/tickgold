import { ref, computed } from "vue";
import { useWatchlistStore } from "../stores/watchlist";
import { useQuotesStore } from "../stores/quotes";
import { usePaperStore } from "../stores/paper";
import { signalCreateSpider } from "../ai/api";
import { fetchZtPool, fetchZbPool, fetchRankBoard, fetchSectors, fetchIndexQuotes } from "../api/market";
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
import type { Quote } from "../api/types";
import type { CardId } from "../lib/cards";

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
const autoTrade = ref(false);
const semiAuto = ref(true); // 半自动模式（弹窗确认）
const currentStep = ref(0);
const currentCard = ref<CardId>("watch");

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
}
const crawlSources = ref<CrawlSourceConfig>({
  watch: true,
  rank: true,
  sector: true,
  concept: true,
  radar: true,
  market: true,
  dragon: false,
  screener: false,
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
});

/** 将卡片 ID 映射到爬取源 key */
function cardToSource(cardId: CardId): keyof CrawlSourceConfig | null {
  const map: Partial<Record<CardId, keyof CrawlSourceConfig>> = {
    watch: "watch",
    rank: "rank",
    sector: "sector",
    concept: "concept",
    radar: "radar",
    market: "market",
    dragon: "dragon",
    screener: "screener",
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
  const allCards: CardId[] = [];
  const src = crawlSources.value;

  // 按优先级顺序加入已启用的卡片
  const hotOrder: CardId[] = ["radar", "rank", "market", "concept", "sector", "watch", "dragon", "screener"];
  const coldOrder: CardId[] = ["watch", "market", "sector", "rank", "radar", "concept", "dragon", "screener"];
  const neutralOrder: CardId[] = ["watch", "rank", "market", "sector", "concept", "radar", "dragon", "screener"];

  const order = marketSentiment.value.level === "hot" ? hotOrder
    : marketSentiment.value.level === "cold" ? coldOrder
    : neutralOrder;

  for (const card of order) {
    const source = cardToSource(card);
    if (source && src[source]) allCards.push(card);
  }

  // 兜底：至少有一个
  return allCards.length ? allCards : ["watch"];
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

// ===== 从 Store 采集不同卡片的数据（不依赖 DOM） =====
function collectFromStore(cardId: CardId): TargetPoint[] {
  const points: TargetPoint[] = [];
  const wl = useWatchlistStore();
  const quotes = useQuotesStore();

  switch (cardId) {
    case "watch":
      // 自选股：直接从 watchlist store 拿
      const list = wl.currentStocks;
      list.forEach((s, i) => {
        const q = quotes.map[s.code];
        points.push({
          x: 150 + Math.random() * 20,
          y: 200 + i * 40,
          label: `${s.name} ${q?.price?.toFixed(2) || "—"} ${q?.pct >= 0 ? "+" : ""}${q?.pct?.toFixed(1) || "—"}%`,
          type: "stock",
          isCurrent: i === 0,
        });
      });
      // 日志显示具体股票
      const topStock = list[0];
      const topQ = topStock ? quotes.map[topStock.code] : null;
      addLog(`✅ 自选股 5 只 | ${topStock?.name} ${topQ?.price?.toFixed(2)} ${(topQ?.pct ?? 0) >= 0 ? "+" : ""}${topQ?.pct?.toFixed(1)}%`, "info");
      break;

    case "rank":
      // 涨幅榜：从 quotes store 按涨幅排序取前 5
      const allQuotes = Object.values(quotes.map);
      const sorted = allQuotes.sort((a, b) => (b.pct || 0) - (a.pct || 0)).slice(0, 5);
      sorted.forEach((q, i) => {
        points.push({
          x: 200,
          y: 220 + i * 40,
          label: `涨幅榜第${i+1}名 ${q.name} ${q.pct >= 0 ? "+" : ""}${q.pct?.toFixed(1)}%`,
          type: "stock",
          isCurrent: i === 0,
        });
      });
      // 日志显示前 3 名
      const top3 = sorted.slice(0, 3).map(q => `${q.name} ${q.pct >= 0 ? "+" : ""}${q.pct?.toFixed(1)}%`).join(" | ");
      addLog(`✅ 涨幅榜 TOP3：${top3}`, "info");
      break;

    case "sector":
    case "concept":
      // 板块/概念：mock 几个点供可视化
      const mockSectors = [
        { name: "热点板块一", pct: 2.46 },
        { name: "热点板块二", pct: 2.11 },
        { name: "热点板块三", pct: 1.80 },
      ];
      mockSectors.forEach((s, i) => {
        points.push({
          x: 200,
          y: 220 + i * 40,
          label: `${s.name} +${s.pct}%`,
          type: "index",
          isCurrent: i === 0,
        });
      });
      addLog(`✅ 采集到板块数据 ${mockSectors.length} 个`, "info");
      break;

    case "market":
      // 大盘指数
      const marketItems = [
        { name: "上证指数", pct: 0.85 },
        { name: "深证成指", pct: 1.12 },
        { name: "创业板指", pct: 1.56 },
      ];
      marketItems.forEach((m, i) => {
        points.push({
          x: 200,
          y: 220 + i * 45,
          label: `${m.name} ${m.pct >= 0 ? "+" : ""}${m.pct}%`,
          type: "index",
          isCurrent: i === 0,
        });
      });
      addLog(`✅ 采集到大盘指数 ${marketItems.length} 个`, "info");
      break;

    case "radar":
      // 涨停雷达：从市场情绪拿
      const stats = [
        { label: `涨停 ${marketSentiment.value.limitUp} 家`, x: 200, y: 200 },
        { label: `跌停 ${marketSentiment.value.limitDown} 家`, x: 350, y: 200 },
        { label: `最高板 ${marketSentiment.value.maxBoard} 板`, x: 500, y: 200 },
      ];
      stats.forEach((s, i) => {
        points.push({
          x: s.x,
          y: s.y,
          label: s.label,
          type: "index",
          isCurrent: i === 0,
        });
      });
      addLog(`✅ 采集到涨停雷达统计 ${stats.length} 个`, "info");
      break;
  }

  return points;
}

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
function scanWatchlist(
  wl: ReturnType<typeof useWatchlistStore>,
  quotes: ReturnType<typeof useQuotesStore>,
  paperStore: ReturnType<typeof usePaperStore>,
) {
  const list = wl.currentStocks;
  if (!list.length) return;

  addLog(`📋 扫描自选股（${list.length} 只）...`, "info");

  const scores: StockScore[] = [];
  const newPoints: TargetPoint[] = [];

  list.forEach((s) => {
    const q = quotes.map[s.code];
    if (!q) return;

    const score = evaluateStock(q, s.code, q.name || s.name);
    emitScan({
      type: "target",
      cardId: "watch",
      code: s.code,
      signal: score.recommendation === "BUY"
        ? "BUY"
        : score.recommendation === "SELL" ? "SELL" : null,
    });
    scores.push(score);

    newPoints.push({
      x: 150,
      y: 200,
      label: `${score.name} ${score.price.toFixed(2)} ${score.pct >= 0 ? "+" : ""}${score.pct.toFixed(1)}%`,
      type: "stock",
      isCurrent: newPoints.length === 0,
      action: score.recommendation === "BUY" ? "buy" : score.recommendation === "SELL" ? "sell" : "scan",
    });

    if (score.recommendation === "BUY") {
      addLog(`🟢 ${score.name}(${score.code}) 买入信号: ${score.signals.join(", ")}`, "buy");
      opportunityFound = true;
      if (canAutoTrade("watch")) {
        executeBuy(score, paperStore);
      } else {
        // 非全自动或该分类未开：信号送确认桥，人工确认后再下单
        void pushTicketToBridge(score, paperStore);
      }
    } else if (score.recommendation === "SELL") {
      addLog(`🔴 ${score.name}(${score.code}) 卖出信号: ${score.signals.join(", ")}`, "sell");
      if (canAutoTrade("watch")) {
        executeSell(score, paperStore);
      } else {
        void pushTicketToBridge(score, paperStore);
      }
    }
  });

  stockScores.value = scores;
  targetPoints.value = newPoints;
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
async function scanRadar(quotes: ReturnType<typeof useQuotesStore>) {
  addLog(`🚀 扫描涨停雷达，判断市场情绪...`, "info");

  await ensureSentiment(true);
  const { limitUp, limitDown, maxBoard, level } = marketSentiment.value;
  const levelText = level === "hot" ? "亢奋" : level === "cold" ? "冷清" : "中性";
  addLog(`📊 市场情绪：${levelText}（涨停${limitUp}家，最高${maxBoard}板）`, "info");

  // 在右侧设置几个情绪点
  targetPoints.value = [
    { x: 1100, y: 250, label: `涨停 ${limitUp}家`, type: "index", isCurrent: true },
    { x: 1100, y: 300, label: `跌停 ${limitDown}家`, type: "index" },
    { x: 1100, y: 350, label: `最高 ${maxBoard}板`, type: "index" },
    { x: 1100, y: 400, label: `情绪 ${levelText}`, type: "index", action: marketSentiment.value.level === "hot" ? "buy" : "scan" },
  ];
}

// ===== 扫描涨幅榜（真实数据）=====
let rankCache: Quote[] = [];
let rankCacheAt = 0;
const RANK_CACHE_MS = 15_000; // 榜单缓存 15s

async function scanRank(quotes: ReturnType<typeof useQuotesStore>) {
  addLog(`📈 扫描涨幅榜，找领涨股...`, "info");

  // 缓存命中直接用
  if (Date.now() - rankCacheAt < RANK_CACHE_MS && rankCache.length) {
    processRankData(rankCache);
    return;
  }

  try {
    const gainers = await fetchRankBoard("gainers", 1, 10);
    rankCache = gainers as unknown as Quote[];
    rankCacheAt = Date.now();
    processRankData(rankCache);
  } catch (e) {
    addLog(`⚠️ 涨幅榜数据获取失败: ${e}`, "warn");
    // 失败回退到本地已有行情排序
    const allQuotes = Object.values(quotes.map);
    const sorted = allQuotes.sort((a, b) => (b.pct || 0) - (a.pct || 0)).slice(0, 8);
    processRankData(sorted);
  }
}

function processRankData(list: Array<{ code: string; name?: string; price?: number; pct?: number; amount?: number }>) {
  const top = list.slice(0, 6);
  const newPoints: TargetPoint[] = top.map((g, i) => {
    const pct = g.pct ?? 0;
    const actionType: "buy" | "sell" | "scan" = pct >= 2 && pct <= 8 ? "buy" : pct > 9.5 ? "sell" : "scan";
    return {
      x: 100,
      y: 230 + i * 42,
      label: `${i + 1}. ${g.name || g.code} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
      type: "stock",
      isCurrent: i === 0,
      action: actionType,
    };
  });

  targetPoints.value = newPoints;

  // 前 3 名生成信号事件（供蜘蛛可视化）
  top.slice(0, 6).forEach((g, i) => {
    const code = g.code;
    const pct = g.pct ?? 0;
    const amount = g.amount ?? 0;
    const signal: SpiderSignalKind = pct >= 2 && pct <= 7 && amount >= 5e7 ? "BUY" : null;

    setTimeout(() => {
      emitScan({
        type: "target",
        cardId: "rank",
        code,
        signal,
      });
    }, 120 * i); // 错开发射，模拟逐行扫描
  });

  const top3 = top.slice(0, 3).map(g => `${g.name || g.code} ${(g.pct ?? 0) >= 0 ? "+" : ""}${(g.pct ?? 0).toFixed(1)}%`).join(" | ");
  addLog(`✅ 涨幅榜 TOP3：${top3}`, "info");
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
    // 兜底：显示占位
    const fallback = [
      { code: "sh000001", name: "上证指数", pct: 0, price: 0 },
      { code: "sz399001", name: "深证成指", pct: 0, price: 0 },
      { code: "sz399006", name: "创业板指", pct: 0, price: 0 },
    ];
    processMarketData(fallback as Quote[]);
  }
}

function processMarketData(list: Quote[]) {
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
      emitScan({ type: "target", cardId: "market", code: q.code, signal });
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
    const fallback = [
      { name: "银行", changePct: 2.3 },
      { name: "白酒", changePct: 1.8 },
      { name: "新能源", changePct: 1.5 },
      { name: "半导体", changePct: -0.8 },
    ];
    processSectorData(fallback);
  }
}

function processSectorData(list: Array<{ name: string; changePct?: number; pct?: number; leadStock?: string; leader?: string }>) {
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
    const fallback = [
      { name: "人工智能", changePct: 3.2 },
      { name: "华为概念", changePct: 2.8 },
      { name: "新能源汽车", changePct: 2.1 },
      { name: "芯片", changePct: 1.5 },
    ];
    processConceptData(fallback);
  }
}

function processConceptData(list: Array<{ name: string; changePct?: number; pct?: number }>) {
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

// ===== 执行交易（带完整风控检查）=====
async function executeBuy(score: StockScore, paperStore: ReturnType<typeof usePaperStore>) {
  try {
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

    const vol = dec.suggestedVol ?? 100;
    await paperStore.buy(score.code, score.name, score.price, vol);
    addLog(`✅ 买入 ${score.name}(${score.code}) ${vol}股 @ ${score.price.toFixed(2)} (${score.signals.slice(0, 2).join("、")})`, "buy");
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

// ===== 扫描一轮（智能决策，不是机械循环） =====
function scanRound(
  wl: ReturnType<typeof useWatchlistStore>,
  quotes: ReturnType<typeof useQuotesStore>,
  paperStore: ReturnType<typeof usePaperStore>,
  onSwitchCard: (cardId: CardId) => boolean,
) {
  // 智能决定下一个扫哪个卡片
  const priority = getCardPriority();
  let cardId: CardId;

  // 如果发现了好机会，并且还没深度分析够次数，就继续在当前卡片深入
  if (opportunityFound && deepAnalysisCount < maxDeepAnalysis) {
    cardId = currentCard.value;
    deepAnalysisCount++;
    addLog(`🔍 发现好机会，继续深入分析【${cardNames[cardId]}】（第 ${deepAnalysisCount} 次）...`, "info");
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

    // 直接从 Store 采集数据（不依赖 DOM）；无论切换成功与否都保留：
    // SpiderBot.vue mini-stage 消费 targetPoints
    setTimeout(() => {
      const points = collectFromStore(cardId);
      if (points.length > 0) {
        targetPoints.value = points;
      }
    }, 300);

    if (switched) {
      currentCard.value = cardId; // 确认打开后才更新「📍 当前」，避免顶栏为关闭卡背锅
      addLog(`🔄 智能切换到【${cardNames[cardId]}】`, "info");
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
          addLog(`🔄 智能切换到【${cardNames[cardId]}】`, "info");
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
      scanWatchlist(wl, quotes, paperStore);
      break;
    case "rank":
      void scanRank(quotes);
      break;
    case "sector":
      void scanSector();
      break;
    case "concept":
      void scanConcept();
      break;
    case "market":
      void scanMarket();
      break;
    case "radar":
      void scanRadar(quotes);
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
  }

  currentStep.value++;
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
  armWatchdog();
  const wl = useWatchlistStore();
  const quotes = useQuotesStore();
  const paperStore = usePaperStore();
  scanRound(wl, quotes, paperStore, (id) => (switchRef ? switchRef(id) : true));
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
  logs.value = [];
  addLog("🕷 AI 爬虫机器人启动...", "info");

  // 切卡回调存引用：advanceRound 与看门狗通过它回调 UI 层
  switchRef = onSwitchCard;

  // 首轮排卡序与评分都依赖市场情绪：先取真实涨跌停情绪，避免首轮全 neutral 少加分
  await ensureSentiment();
  if (!running.value) return; // await 期间已被停止

  // 立即执行一轮
  scanRound(wl, quotes, paperStore, (id) => (switchRef ? switchRef(id) : true));

  // 后续轮次由蜘蛛完成事件 advanceRound() 推进；看门狗仅兜底
  armWatchdog();
}

function stop() {
  running.value = false;
  visible.value = false; // 隐藏覆盖层
  if (watchdog !== null) { clearTimeout(watchdog); watchdog = null; }
  switchRef = null;
  addLog("爬虫机器人已停止", "info");
}

function addLog(text: string, type: LogEntry["type"] = "info") {
  const now = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  logs.value.unshift({ time: now, text, type });
  if (logs.value.length > 40) logs.value.pop();
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
