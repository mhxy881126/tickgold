import { ref, computed } from "vue";
import { useWatchlistStore } from "../stores/watchlist";
import { useQuotesStore } from "../stores/quotes";
import { usePaperStore } from "../stores/paper";
import { signalCreateSpider } from "../ai/api";
import type { Quote } from "../api/types";
import type { CardId } from "../lib/cards";

// ===== 扫描事件总线：驱动程序化蜘蛛覆盖层行走路径（无监听者时零开销）=====
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

// ===== 智能决策：不是机械循环，而是根据情况动态调整 =====
// 优先级：发现好机会 → 深入分析；没机会 → 扫下一个卡片
let opportunityFound = false; // 当前是否发现了好机会
let deepAnalysisCount = 0; // 深度分析次数
const maxDeepAnalysis = 2; // 最多深度分析几次就换下一个

// ===== 卡片优先级（根据市场情况动态调整） =====
function getCardPriority(): CardId[] {
  // 如果市场情绪亢奋，优先扫涨停雷达和涨幅榜
  if (marketSentiment.value.level === "hot") {
    return ["radar", "rank", "sector", "watch", "chart", "trade"];
  }
  // 如果市场冷清，优先扫自选股和板块（防守）
  else if (marketSentiment.value.level === "cold") {
    return ["watch", "sector", "trade", "rank", "radar", "chart"];
  }
  // 中性，正常顺序
  else {
    return ["watch", "rank", "sector", "radar", "chart", "trade"];
  }
}
const cardNames: Record<string, string> = {
  watch: "自选股",
  rank: "涨幅榜",
  sector: "板块行情",
  radar: "涨停雷达",
  chart: "K线图",
  trade: "交易面板",
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

// ===== 日志 =====
interface LogEntry {
  time: string;
  text: string;
  type: "info" | "buy" | "sell" | "warn";
}
const logs = ref<LogEntry[]>([]);

// ===== 股票评分 =====
interface StockScore {
  code: string;
  name: string;
  price: number;
  pct: number;
  amount: number;
  score: number;
  signals: string[];
  recommendation: "BUY" | "SELL" | "HOLD" | "SCAN";
}
const stockScores = ref<StockScore[]>([]);

// ===== 市场情绪 =====
const marketSentiment = ref({
  limitUp: 0,
  limitDown: 0,
  maxBoard: 0,
  bombRate: 0,
  level: "neutral" as "hot" | "neutral" | "cold",
});

let timer: number | null = null;

// ===== 评分逻辑 =====
function evaluateStock(q: Quote, code: string, name: string): StockScore {
  let score = 0;
  const signals: string[] = [];

  // 1. 涨跌幅评分
  if (q.pct >= 2 && q.pct <= 7) {
    score += 3;
    signals.push("放量上涨");
  } else if (q.pct > 7) {
    score -= 2;
    signals.push("涨停不追");
  } else if (q.pct <= -3) {
    score -= 3;
    signals.push("跌破止损");
  }

  // 2. 成交额评分
  if (q.amount >= 1e8) {
    score += 2;
    signals.push("成交额充足");
  } else if (q.amount < 5e7) {
    score -= 1;
    signals.push("成交额不足");
  }

  // 3. 市场情绪加成
  if (marketSentiment.value.level === "hot" && score > 0) {
    score += 1;
    signals.push("情绪好");
  } else if (marketSentiment.value.level === "cold" && score > 0) {
    score -= 1;
    signals.push("情绪差");
  }

  // 4. 决策
  let recommendation: StockScore["recommendation"] = "SCAN";
  if (score >= 4) {
    recommendation = "BUY";
  } else if (score >= 2) {
    recommendation = "HOLD";
  } else if (score <= -3) {
    recommendation = "SELL";
  }

  return {
    code,
    name: name || code,
    price: q.price,
    pct: q.pct,
    amount: q.amount,
    score,
    signals,
    recommendation,
  };
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
          type: "index",
          isCurrent: i === 0,
        });
      });
      // 日志显示前 3 名
      const top3 = sorted.slice(0, 3).map(q => `${q.name} ${q.pct >= 0 ? "+" : ""}${q.pct?.toFixed(1)}%`).join(" | ");
      addLog(`✅ 涨幅榜 TOP3：${top3}`, "info");
      break;

    case "sector":
      // 板块行情：模拟板块数据
      const mockSectors = [
        { name: "生物制药", pct: 2.46 },
        { name: "酿酒行业", pct: 2.11 },
        { name: "交通运输", pct: 1.80 },
        { name: "水泥行业", pct: 1.75 },
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
      // 日志显示领涨板块
      addLog(`✅ 热门板块：${mockSectors[0].name} +${mockSectors[0].pct}% | ${mockSectors[1].name} +${mockSectors[1].pct}%`, "info");
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
      if (autoTrade.value) {
        executeBuy(score, paperStore);
      } else {
        // 非全自动：信号送确认桥，人工确认后再下单
        void pushTicketToBridge(score, paperStore);
      }
    } else if (score.recommendation === "SELL") {
      addLog(`🔴 ${score.name}(${score.code}) 卖出信号: ${score.signals.join(", ")}`, "sell");
      if (autoTrade.value) {
        executeSell(score, paperStore);
      } else {
        void pushTicketToBridge(score, paperStore);
      }
    }
  });

  stockScores.value = scores;
  targetPoints.value = newPoints;
}

// ===== 扫描涨停雷达（情绪判断） =====
function scanRadar(quotes: ReturnType<typeof useQuotesStore>) {
  addLog(`🚀 扫描涨停雷达，判断市场情绪...`, "info");

  // 模拟情绪数据（实际应该从 radar store 读）
  const limitUp = 59; // 涨停家数
  const limitDown = 0; // 跌停家数
  const maxBoard = 7; // 最高连板
  const bombRate = 0.05; // 炸板率

  marketSentiment.value = {
    limitUp,
    limitDown,
    maxBoard,
    bombRate,
    level: limitUp >= 50 ? "hot" : limitUp >= 20 ? "neutral" : "cold",
  };

  const levelText = marketSentiment.value.level === "hot" ? "亢奋" : marketSentiment.value.level === "cold" ? "冷清" : "中性";
  addLog(`📊 市场情绪：${levelText}（涨停${limitUp}家，最高${maxBoard}板）`, "info");

  // 在右侧设置几个情绪点
  targetPoints.value = [
    { x: 1100, y: 250, label: `涨停 ${limitUp}家`, type: "index", isCurrent: true },
    { x: 1100, y: 300, label: `跌停 ${limitDown}家`, type: "index" },
    { x: 1100, y: 350, label: `最高 ${maxBoard}板`, type: "index" },
    { x: 1100, y: 400, label: `情绪 ${levelText}`, type: "index", action: marketSentiment.value.level === "hot" ? "buy" : "scan" },
  ];
}

// ===== 扫描涨幅榜 =====
function scanRank(quotes: ReturnType<typeof useQuotesStore>) {
  addLog(`📈 扫描涨幅榜，找领涨股...`, "info");

  // 模拟涨幅榜前 5
  const topGainers = [
    { code: "600000", name: "浦发银行", pct: 3.27 },
    { code: "000001", name: "平安银行", pct: 1.94 },
    { code: "600519", name: "贵州茅台", pct: 1.86 },
    { code: "300750", name: "宁德时代", pct: 1.50 },
    { code: "601318", name: "中国平安", pct: 1.50 },
  ];

  const newPoints: TargetPoint[] = topGainers.map((g, i) => ({
    x: 100,
    y: 250 + i * 40,
    label: `${i+1}. ${g.name} +${g.pct.toFixed(1)}%`,
    type: "index",
    isCurrent: i === 0,
    action: g.pct >= 2 ? "buy" : "scan",
  }));

  targetPoints.value = newPoints;
}

// ===== 扫描板块 =====
function scanSector() {
  addLog(`🏭 扫描板块行情，找热门板块...`, "info");

  // 模拟板块数据
  const sectors = [
    { name: "银行", pct: 2.3, leader: "浦发银行" },
    { name: "白酒", pct: 1.8, leader: "贵州茅台" },
    { name: "新能源", pct: 1.5, leader: "宁德时代" },
  ];

  const newPoints: TargetPoint[] = sectors.map((s, i) => ({
    x: 100,
    y: 250 + i * 60,
    label: `${s.name} +${s.pct}% 领涨: ${s.leader}`,
    type: "index",
    isCurrent: i === 0,
    action: s.pct >= 2 ? "buy" : "scan",
  }));

  targetPoints.value = newPoints;
}

// ===== 执行交易 =====
async function executeBuy(score: StockScore, paperStore: ReturnType<typeof usePaperStore>) {
  try {
    const positions = paperStore.positions;
    if (positions.length >= 5) {
      addLog(`⚠️ 仓位已满（${positions.length}只），无法买入 ${score.code}`, "warn");
      return;
    }

    const cost = score.price * 100;
    if (paperStore.account.cash < cost) {
      addLog(`⚠️ 现金不足，无法买入 ${score.code}`, "warn");
      return;
    }

    await paperStore.buy(score.code, score.name, score.price, 100);
    addLog(`✅ 买入 ${score.name}(${score.code}) 100股 @ ${score.price.toFixed(2)}`, "buy");
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

    await paperStore.sell(score.code, score.price, position.vol);
    addLog(`✅ 卖出 ${score.name}(${score.code}) ${position.vol}股 @ ${score.price.toFixed(2)}`, "sell");
  } catch (e) {
    addLog(`❌ 卖出失败 ${score.code}: ${e}`, "warn");
  }
}

// ===== 扫描一轮（智能决策，不是机械循环） =====
function scanRound(
  wl: ReturnType<typeof useWatchlistStore>,
  quotes: ReturnType<typeof useQuotesStore>,
  paperStore: ReturnType<typeof usePaperStore>,
  onSwitchCard: (cardId: CardId) => void,
) {
  // 智能决定下一个扫哪个卡片
  const priority = getCardPriority();
  let cardId: CardId;

  // 如果发现了好机会，并且还没深度分析够次数，就继续在当前卡片深入
  if (opportunityFound && deepAnalysisCount < maxDeepAnalysis) {
    cardId = currentCard.value;
    deepAnalysisCount++;
    addLog(`🔍 发现好机会，继续深入分析【${cardNames[cardId]}】（第 ${deepAnalysisCount} 次）...`, "info");
  } else {
    // 换下一个卡片（按优先级）
    const step = currentStep.value;
    const cardIdx = step % priority.length;
    cardId = priority[cardIdx];
    currentCard.value = cardId;
    opportunityFound = false;
    deepAnalysisCount = 0;

    // 切换卡片
    onSwitchCard(cardId);
    addLog(`🔄 智能切换到【${cardNames[cardId]}】`, "info");
    emitScan({ type: "card", cardId });

    // 直接从 Store 采集数据（不依赖 DOM）
    setTimeout(() => {
      const points = collectFromStore(cardId);
      if (points.length > 0) {
        targetPoints.value = points;
      }
    }, 300);
  }

  // 根据卡片类型扫描
  switch (cardId) {
    case "watch":
      scanWatchlist(wl, quotes, paperStore);
      break;
    case "rank":
      scanRank(quotes);
      break;
    case "sector":
      scanSector();
      break;
    case "radar":
      scanRadar(quotes);
      break;
    case "chart":
      addLog(`📈 分析 K 线图...`, "info");
      break;
    case "trade":
      addLog(`💰 检查交易面板...`, "info");
      break;
  }

  currentStep.value++;
}

// ===== 控制函数 =====
function start(onSwitchCard: (cardId: CardId) => void) {
  const wl = useWatchlistStore();
  const quotes = useQuotesStore();
  const paperStore = usePaperStore();

  running.value = true;
  visible.value = true; // 显示覆盖层
  logs.value = [];
  addLog("🕷 AI 爬虫机器人启动...", "info");

  // 立即执行一轮
  scanRound(wl, quotes, paperStore, onSwitchCard);

  // 每 3 秒扫描一轮
  timer = window.setInterval(() => {
    scanRound(wl, quotes, paperStore, onSwitchCard);
  }, 3000);
}

function stop() {
  running.value = false;
  visible.value = false; // 隐藏覆盖层
  if (timer) { clearInterval(timer); timer = null; }
  addLog("爬虫机器人已停止", "info");
}

function addLog(text: string, type: LogEntry["type"] = "info") {
  const now = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  logs.value.unshift({ time: now, text, type });
  if (logs.value.length > 40) logs.value.pop();
}

// HMR：模块热替换前必须停掉后台定时器。
// 否则旧模块闭包攥着旧 bench/onSwitchCard，继续每 3 秒开卡切卡，
// 而 UI 上点"停止"只清新模块的 timer，旧 interval 泄漏。
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
    // 方法
    start,
    stop,
    setAutoTrade: (v: boolean) => { autoTrade.value = v; },
    setSemiAuto: (v: boolean) => { semiAuto.value = v; },
  };
}
