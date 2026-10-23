/**
 * 做T决策台 · 单票日内回转（T+0）决策引擎
 *
 * 面向 A 股短线散户：必须持有底仓，当日等量闭环（正T先买后卖 / 倒T先卖后买）。
 * 纯信号提示 + 模拟盘做T，零风险跑通闭环。
 *
 * P0 修复（v3.17）：日K切片 / leg 按 code 隔离 / 费用同源 / 交易日历 / 信号防抖 /
 *                涨跌停取整 / 尾盘闭环兜底 / 轮询治理。
 * P1 信号引擎（v3.18）：特征层 / Regime 闸门 / 打分卡 / 1R 风控 / 熔断 / 流动性门槛。
 * P1-5+P2 执行闭环（v3.19）：
 * - 分批网格：同标的可持多腿（legs[code] 数组），2-3 档分批、一键全平
 * - 对手盘撮合：买入按卖一×(1+滑点)、卖出按买一×(1−滑点)；网格档位按限价成交
 * - 做T台账跨日入库 SQL（tmaker_record），统计页读历史聚合
 * - 行情新鲜度：报价 >10s 陈旧即暂停信号并提示
 * - 多票扫描：持仓股实时做T性价比排序
 * P3-3 历史分时归档（v3.20）：启动 + 每日收盘后补拉腾讯近 5 日分钟数据落本地库，
 *               为分钟级回测累积样本（archiveState 供面板展示）。
 */
import { ref, computed, watch, onUnmounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  fetchMinute, fetchOrderBook, fetchQuotes, fetchKLine, fetchIndexQuotes,
  fetchTrades, fetchDepthEnhance, archiveHistMinute,
  fetchHistMinuteDays, fetchArchivedMinuteDays,
} from "../api/market";
import type { Quote, KBar, OrderBook, TradeTick, DepthEnhance } from "../api/types";
import { normalizeBook as bookNormalize } from "./tmaker/bookNormalize";
import type { HistDayMinute } from "../api/market";
import { usePaperStore, type PaperPosition } from "../stores/paper";
import { mockSeedPosition, tmakerRecordsUpsert, tmakerRecordsList } from "../broker/api";
import type { TmakerRecordRow } from "../broker/api";
import { buildAvgMap, limitRateOf, sameDay } from "../lib/chart";
import { isTrading, isCloseWindow, isTradingDay } from "../utils/sessions";
import { roundTripFeeRate, estimateFee } from "../utils/fees";
import { pushToast } from "../alert/bus";
import { playAlert } from "../utils/sound";
import {
  clamp, biasZOf, vwapSlopeBpMin, sideStreakOf, minuteR2,
  bookImbalance, bidAskSpreadPct, activeNetVol, priceClusters,
  relativeStrength, atrPctOf, regimeOf, regimeAllows,
  scoreLong, scoreShort, summarize, gradeOf,
} from "./tmaker/features";
import type { Regime, ScoreResult } from "./tmaker/features";
import { gridPlanLong, gridPlanShort } from "./tmaker/grid";
import type { GridPlan } from "./tmaker/grid";
import { runBacktest, DEFAULT_BT_PARAMS } from "./tmaker/backtest";
import type { BtParams, BtResult } from "./tmaker/backtest";
import { gridSearch } from "./tmaker/optimize";
import type { OptimizeOutcome, OptimizeRow } from "./tmaker/optimize";
import { recordSignal, loadSignalLog, evaluateLog } from "./tmaker/signalLog";
import type { SignalLogStats } from "./tmaker/signalLog";
import { buildTmakerReportHtml } from "../utils/tmakerReport";
import type { ReportBtHint } from "../utils/tmakerReport";
import { buildDayPlan, skipReasonsOf } from "./tmaker/plan";
import type { DayPlan } from "./tmaker/plan";

// ============ 阈值参数（操盘手经验值，可后续做成可配置）============
const MIN_AMPLITUDE = 2;        // 可做T最低振幅 %
const LONG_BIAS = -0.8;         // 正T买入乖离率阈值（现价在均线下 -0.8%）
const SHORT_BIAS = 1.2;         // 倒T卖出乖离率阈值（现价在均线上 +1.2%）
const MAX_BIAS = 3;             // 乖离极端值（超过说明可能有消息，不追）
const MIN_SPREAD_BASE = 0.5;    // 最小做T价差门槛（%）；实际取 max(基数, 预估往返成本×系数)
const MIN_SPREAD_COST_MULT = 2.5; // 门槛 = 往返成本率的多少倍（覆盖手续费并留安全垫）
const HYSTERESIS = 0.15;        // 平仓迟滞（%）：触发后需回落该幅度才退回持仓状态
const MARKET_CRASH = -1.5;      // 大盘急跌阈值，停止正T
const MAX_T_PER_DAY = 2;        // 单日最多做T次数（P1 默认 ≤2，抑制过度交易）
const COOLDOWN_MS = 5 * 60 * 1000; // 同方向开仓冷却（防抖，5 分钟）
const OPEN_CONFIRM_TICKS = 2;   // 开仓信号需连续确认的刷新周期数
const LIMIT_GUARD_PCT = 0.3;    // 距涨/跌停单向禁开仓比例 %
const CLOSE_TIME = "14:50";     // 强制闭环时间

// P1 风控参数
const RISK_PER_TRADE = 0.005;   // 单笔风险 = 底仓市值 0.5%（1R）
const STOP_MIN = 1.0;           // ATR 自适应止损下限 %
const STOP_MAX = 1.5;           // ATR 自适应止损上限 %
const TARGET_MULT = 1.5;        // 目标 = 止损 × 1.5（约 1.5R 盈亏比）
const TARGET_MIN = 0.8;         // 目标下限 %
const TARGET_MAX = 2.5;         // 目标上限 %
const MAX_SPREAD_PCT = 0.15;    // 盘口价差率上限 %（流动性）
const MIN_TURNOVER = 1;         // 换手下限 %
const MAX_TURNOVER = 15;        // 换手上限 %
const MIN_AMOUNT_5D = 3e8;      // 近5日日均成交额下限（3 亿）
const OPEN_OBSERVE_UNTIL = 9 * 60 + 45; // 9:30-9:45 观察期
const LATE_BLOCK_FROM = 14 * 60 + 30;   // 14:30 后不开新仓

// P2 执行参数
const SLIP_PCT = 0.05;          // 对手盘滑点 %（模拟撮合，可调）
const STALE_SEC = 10;           // 行情陈旧阈值（秒），超过暂停信号
const SCAN_INTERVAL_MS = 30_000; // 多票扫描刷新周期

// ============ 类型 ============
export type TAction =
  | "wait"          // 观望
  | "long-open"     // 正T：买入开仓
  | "long-close"    // 正T：卖出闭环
  | "short-open"    // 倒T：卖出开仓
  | "short-close"   // 倒T：买回闭环
  | "force-close"   // 尾盘强制闭环
  | "stop-loss";    // 止损闭环

export interface TSignal {
  action: TAction;
  title: string;
  side: "buy" | "sell" | "hold";
  urgency: "strong" | "normal" | "none";
  price: number;       // 参考价
  target: number;      // 目标价
  stop: number;        // 止损价
  vol: number;         // 建议数量（股）
  spread: number;      // 预期价差 %
  reasons: string[];
  // P1 扩展
  score?: number;      // 信号总分 0-100
  grade?: "strong" | "prep" | "wait";
  regime?: Regime;
}

/** 在途做T单腿（按标的 code 隔离，同标的多腿数组） */
export interface TLeg {
  type: "long" | "short";  // long=正T(先买) short=倒T(先卖)
  code: string;
  vol: number;
  openPrice: number;
  openTime: number;
  openFee: number;      // 开仓实际费用（模拟盘成交返回）
  stopPct: number;      // 开仓时快照的 ATR 自适应止损 %
  targetPct: number;    // 开仓时快照的目标 %
  gridId?: string;      // 网格批次标识（同一批网格共用一个 id）
}

/** 已闭环的一笔做T */
export interface TRecord {
  code: string;
  name: string;
  type: "long" | "short";
  vol: number;
  openPrice: number;
  closePrice: number;
  pnl: number;          // 毛利 - 开仓费 - 平仓费（与模拟盘实际资金流一致）
  fee: number;          // openFee + closeFee
  openFee: number;
  closeFee: number;
  openTime: number;
  closeTime: number;
}

interface KeyLevels {
  vwap: number;
  cost: number;
  supportLow: number;   // 近5日最低（剔除当日）
  resistHigh: number;   // 近5日最高（剔除当日）
  ma5: number;
  limitUp: number;
  limitDown: number;
}

/** 昨日未闭环遗留腿（用于次日提示） */
export interface LegacyUnclosed {
  date: string;         // YYYYMMDD
  code: string;
  name: string;
  type: "long" | "short";
  vol: number;
  openPrice: number;
}

/** 多票扫描候选 */
export interface ScanCandidate {
  code: string;
  name: string;
  price: number;
  pct: number;
  amplitude: number;
  amount: number;
  turnover: number;
  score: number;
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function round100(n: number): number {
  return Math.max(0, Math.floor(n / 100) * 100);
}

/** 按 0.01 元取整（A 股最小价格变动单位） */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 近 N 个完整交易日日K（升序兜底，剔除当日未收盘K）。
 * 修复 P0-1：原实现用升序数组的 slice(0,5)，实际取到的是最老的 5 根。
 */
export function recentDailyBars(bars: KBar[], n = 5): KBar[] {
  if (!bars.length) return [];
  const sorted = [...bars].sort((a, b) => a.timestamp - b.timestamp);
  const withoutToday = sorted.filter((b) => !sameDay(b.timestamp, new Date()));
  const pool = withoutToday.length >= n ? withoutToday : sorted;
  return pool.slice(-n);
}

export function useTmaker() {
  const paper = usePaperStore();

  // ============ 选中标的与原始数据 ============
  const SELECTED_KEY = "tmaker-selected-code";
  const selectedCode = ref<string>("");
  const quote = ref<Quote | null>(null);
  const minute = ref<KBar[]>([]);
  const orderBook = ref<OrderBook | null>(null);
  const trades = ref<TradeTick[]>([]);
  const depthEnhance = ref<DepthEnhance>({ priceDist: [], auction: [], sealTrend: [] });
  const daily = ref<KBar[]>([]);
  /** daily 归属标的：日K按代码隔离，仅当与当前选中一致时才用于 keyLevels（防止切票/启动竞态串票） */
  const dailyCode = ref<string>("");
  /** 分时归属标的：分时按代码隔离，仅归属当前标的时才渲染（防串票） */
  const minuteCode = ref<string>("");
  const marketPct = ref<number>(0);
  const loading = ref(false);
  /** 切票后多次重试仍无行情 → 空态显示"加载失败/点击重试"（避免无限"加载中"）；轮询拿到后自动清除 */
  const loadFailed = ref(false);
  const errorMsg = ref("");
  const now = ref(Date.now());

  // 持仓候选
  const positions = computed(() => paper.positions);
  const currentPos = computed<PaperPosition | undefined>(() =>
    positions.value.find((p) => p.code === selectedCode.value),
  );
  /** 当前标的分时（归属不匹配时返回空，避免图表渲染旧票分时串票） */
  const currentMinute = computed<KBar[]>(() =>
    minuteCode.value && minuteCode.value === selectedCode.value ? minute.value : [],
  );

  // ============ 做T状态（按交易日持久化；同标的多腿，按标的 code 隔离）============
  const STORAGE_KEY = `tmaker-day-${todayStr()}`;
  const LEGACY_KEY_RE = /^tmaker-(day-)?\d{8}$/;
  const legs = ref<Record<string, TLeg[]>>({});
  const records = ref<TRecord[]>([]);
  /** 当前标的全部在途腿 */
  const currentLegs = computed<TLeg[]>(() => legs.value[selectedCode.value] ?? []);
  /** 主腿（第一腿）：兼容旧引用，UI 多用 currentLegs */
  const leg = computed<TLeg | null>(() => currentLegs.value[0] ?? null);
  /** 昨日（近 7 日）未闭环遗留腿提示 */
  const legacyUnclosed = ref<LegacyUnclosed[]>([]);

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        legs: legs.value, records: records.value,
      }));
    } catch { /* 忽略存储失败 */ }
  }

  /** 扫描 localStorage 中近 N 个交易日 key 的遗留在途腿（仅当当日无腿时提示一次） */
  function scanLegacy() {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && LEGACY_KEY_RE.test(k)) keys.push(k);
      }
      keys.sort().reverse().slice(1, 8).forEach((k) => {
        try {
          const obj = JSON.parse(localStorage.getItem(k) || "{}");
          const ls = obj?.legs ?? (obj?.leg ? { [obj.leg.code]: [obj.leg] } : {});
          Object.values(ls as Record<string, TLeg | TLeg[]>).forEach((v) => {
            const arr = Array.isArray(v) ? v : [v];
            arr.forEach((l) => {
              if (l && l.code) {
                legacyUnclosed.value.push({
                  date: k.replace(/^tmaker-day-/, ""),
                  code: l.code,
                  name: currentPos.value?.name || "",
                  type: l.type,
                  vol: l.vol,
                  openPrice: l.openPrice,
                });
              }
            });
          });
        } catch { /* 单 key 解析失败忽略 */ }
      });
    } catch { /* 忽略 */ }
  }

  function normalizeLegs(raw: unknown): Record<string, TLeg[]> {
    const out: Record<string, TLeg[]> = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v as TLeg[];
      else if (v && typeof v === "object") out[k] = [v as TLeg];
    }
    return out;
  }

  function restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        legs.value = normalizeLegs(obj?.legs ?? (obj?.leg ? { [obj.leg.code]: [obj.leg] } : {}));
        records.value = obj?.records || [];
        return;
      }
    } catch { /* 忽略 */ }
    // 兼容旧格式（v3.16 及更早：tmaker-YYYYMMDD 单腿单键）
    try {
      const oldKey = `tmaker-${todayStr()}`;
      const raw = localStorage.getItem(oldKey);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj?.leg) legs.value = { [obj.leg.code]: [obj.leg] };
        records.value = obj?.records || [];
      }
    } catch { /* 忽略 */ }
    if (Object.keys(legs.value).length === 0) scanLegacy();
  }
  restore();

  // ============ 计算指标 ============
  const costPrice = computed(() => {
    const p = currentPos.value;
    return p && p.vol > 0 ? p.costAmount / p.vol : 0;
  });

  /** 分时均价线序列（VWAP） */
  const avgMap = computed<Map<number, number>>(() => buildAvgMap(minute.value));
  const vwap = computed(() => {
    if (minute.value.length === 0) {
      // 退化：用实时成交额/成交量
      const q = quote.value;
      if (q && q.volume > 0) return q.amount / (q.volume * 100);
      return 0;
    }
    const last = minute.value[minute.value.length - 1];
    return avgMap.value.get(last.timestamp) ?? last.close;
  });

  /** 乖离率：现价相对分时均价 */
  const bias = computed(() => {
    if (!vwap.value || !quote.value) return 0;
    return ((quote.value.price - vwap.value) / vwap.value) * 100;
  });

  // ============ P1 特征层 ============
  const avgOf = (ts: number) => avgMap.value.get(ts);

  /** 乖离 z-score（相对当日分时 bias 分布，替代固定阈值） */
  const biasZ = computed(() => biasZOf(bias.value, minute.value, avgOf));

  /** VWAP 最近 5 根斜率（bp/分钟） */
  const vwapSlope5 = computed(() => {
    const avgs = [...avgMap.value.keys()]
      .sort((a, b) => a - b)
      .map((ts) => avgMap.value.get(ts)!);
    return vwapSlopeBpMin(avgs, 5);
  });

  /** 价格在 VWAP 单侧连续根数（正=上方） */
  const sideStreak = computed(() => sideStreakOf(minute.value, avgOf));

  /** 分时 R²（单边度） */
  const minuteR2v = computed(() => minuteR2(minute.value, 30));

  /** 盘口失衡 */
  const bookImb = computed(() => bookImbalance(orderBook.value));

  /** 买卖价差率 % */
  const spreadPct = computed(() => bidAskSpreadPct(orderBook.value));

  /** 逐笔主动净量 */
  const actNet = computed(() => activeNetVol(trades.value, 500));

  /** 相对大盘强弱 % */
  const relStrength = computed(() =>
    relativeStrength(quote.value?.pct ?? 0, marketPct.value),
  );

  /** 日线 ATR % */
  const atrPct = computed(() => atrPctOf(daily.value, 14));

  /** 分价筹码峰（支撑/压力） */
  const clusters = computed(() =>
    priceClusters(depthEnhance.value.priceDist ?? [], quote.value?.price ?? 0, 3),
  );

  /** 市况识别 */
  const regime = computed<Regime>(() =>
    regimeOf({
      bias: bias.value,
      maxBias: MAX_BIAS,
      vwapSlope5: vwapSlope5.value,
      sideStreak: sideStreak.value,
      r2: minuteR2v.value,
      marketPct: marketPct.value,
      marketCrash: MARKET_CRASH,
    }),
  );

  /** 打分（正T/倒T 各算一次，供开仓分级；regime 由闸门一票否决，不入分） */
  function scoreFor(dir: "long" | "short"): ScoreResult {
    const f = {
      biasZ: biasZ.value.z,
      bookImb: bookImb.value,
      actNet: actNet.value.net,
      turnUp: minuteTurn("up").turn,
      turnDown: minuteTurn("down").turn,
      nearSupportPct: distPct(keyLevels.value.supportLow),
      nearVwapPct: bias.value,
      nearResistPct: distPct(keyLevels.value.resistHigh),
      relStrength: relStrength.value,
      atrPct: atrPct.value,
    };
    const parts = dir === "long" ? scoreLong(f).parts : scoreShort(f).parts;
    return summarize(parts);
  }

  // ============ 1R 风控与仓位 ============
  /** 单笔风险金额（底仓市值 0.5%） */
  const riskAmt = computed(() => {
    const p = currentPos.value, q = quote.value;
    if (!p || !q?.price) return 0;
    return p.vol * q.price * RISK_PER_TRADE;
  });

  /** ATR 自适应止损 %（1.0-1.5 区间） */
  const stopPct = computed(() => {
    const a = atrPct.value;
    if (a <= 0) return STOP_MAX;
    return clamp(a, STOP_MIN, STOP_MAX);
  });

  /** 目标 % = 1.5R */
  const targetPct = computed(() => clamp(stopPct.value * TARGET_MULT, TARGET_MIN, TARGET_MAX));

  /** 建议做T数量：min(可用半仓, 1R 反推数量)，100股整数倍 */
  const suggestVol = computed(() => {
    const p = currentPos.value, q = quote.value;
    if (!p || !q?.price) return 0;
    const maxHalf = round100(p.availVol * 0.5);
    const byRisk =
      riskAmt.value > 0 && stopPct.value > 0
        ? round100(riskAmt.value / (q.price * stopPct.value / 100))
        : maxHalf;
    return Math.max(0, Math.min(byRisk, maxHalf));
  });

  /** 预估往返成本率 %（按建议数量与现价，含最低佣金；与后端 calc_fee 同口径） */
  const estRoundTripFeePct = computed(() =>
    roundTripFeeRate(suggestVol.value, quote.value?.price ?? 0),
  );

  /** 做T价差门槛：至少覆盖往返成本的 2.5 倍，且不低于固定基数 */
  const minSpread = computed(() =>
    Math.max(MIN_SPREAD_BASE, estRoundTripFeePct.value * MIN_SPREAD_COST_MULT),
  );

  /** 近5日日均成交额（元，估算：Σ 量×100×收） */
  const avgAmount5d = computed(() => {
    const recent = recentDailyBars(daily.value, 5);
    if (!recent.length) return 0;
    return recent.reduce((s, b) => s + b.volume * 100 * b.close, 0) / recent.length;
  });

  // ============ 行情新鲜度（P2-9） ============
  const staleSec = computed(() => {
    const t = quote.value?.time;
    if (!t) return 0;
    return Math.max(0, Math.floor((Date.now() - t) / 1000));
  });
  const stale = computed(() => staleSec.value > STALE_SEC);

  // ============ 熔断 / 时段 / 流动性门槛 ============
  const dailyLossBlocked = computed(() => {
    const r = riskAmt.value;
    if (!(r > 0)) return false;
    return todayStats.value.pnl <= -2 * r; // 当日 -2R
  });
  const losingStreakBlocked = computed(() => {
    const recs = currentRecords.value;
    return recs.length >= 2 && recs[0].pnl < 0 && recs[1].pnl < 0;
  });
  const openObserveBlocked = computed(() => {
    const d = new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    return m >= 9 * 60 + 30 && m < OPEN_OBSERVE_UNTIL;
  });
  const lateBlocked = computed(() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes() >= LATE_BLOCK_FROM;
  });

  const keyLevels = computed<KeyLevels>(() => {
    const q = quote.value;
    const prev = q?.prevClose ?? 0;
    const code = selectedCode.value;
    const limit = prev > 0 ? limitRateOf(code, q?.name) : 0.1;
    // 近5日完整交易日（剔除当日；升序兜底）。仅当日K归属当前标的时才采用，否则回落当日高低点（防串票）。
    const recent = dailyCode.value === code ? recentDailyBars(daily.value, 5) : [];
    const supportLow = recent.length ? Math.min(...recent.map((b) => b.low)) : q?.low ?? 0;
    const resistHigh = recent.length ? Math.max(...recent.map((b) => b.high)) : q?.high ?? 0;
    const ma5 = recent.length
      ? recent.reduce((s, b) => s + b.close, 0) / recent.length
      : prev;
    return {
      vwap: vwap.value,
      cost: costPrice.value,
      supportLow,
      resistHigh,
      ma5,
      // 涨跌停价按 0.01 取整，与实际盘口涨停价对齐
      limitUp: round2(prev * (1 + limit)),
      limitDown: round2(prev * (1 - limit)),
    };
  });

  /** 分时是否放量拐头（最近2根1分钟K） */
  function minuteTurn(dir: "up" | "down"): { turn: boolean; detail: string } {
    const bars = minute.value;
    if (bars.length < 3) return { turn: false, detail: "" };
    const a = bars[bars.length - 3];
    const b = bars[bars.length - 2];
    const c = bars[bars.length - 1];
    if (dir === "up") {
      // 止跌回升：最后一根收阳、且高于前一根，量能放大
      const up = c.close >= b.close && b.close <= a.close;
      const vol = c.volume > b.volume * 1.05;
      return { turn: up && vol, detail: vol ? "分时放量止跌" : "分时止跌" };
    }
    // 冲高回落：最后一根收阴、低于前一根
    const down = c.close <= b.close && b.close >= a.close;
    const vol = c.volume > b.volume * 1.05;
    return { turn: down, detail: vol ? "放量滞涨" : "冲高回落" };
  }

  /** 距某价位的百分比（正=现价在上方） */
  function distPct(price: number): number {
    if (!price || !quote.value) return 0;
    return ((quote.value.price - price) / price) * 100;
  }

  // ============ 可做T判定（含 P1 门槛 + P2 新鲜度） ============
  const canT = computed(() => {
    const reasons: string[] = [];
    const q = quote.value;
    const p = currentPos.value;
    if (!p || p.vol <= 0) return { ok: false, reasons: ["无底仓，无法做T（需先持有该股票）"] };
    if (p.availVol < 100) return { ok: false, reasons: ["可用底仓不足100股（T+1当日买入不可卖）"] };
    if (!q || !q.price) return { ok: false, reasons: ["行情未加载"] };
    if (!isTrading()) return { ok: false, reasons: ["当前非连续竞价交易时段"] };
    if (stale.value)
      reasons.push(`行情已 ${staleSec.value}s 未更新，暂停信号（数据源可能卡住）`);
    if (q.amplitude < MIN_AMPLITUDE)
      reasons.push(`振幅不足（${q.amplitude?.toFixed(1)}% < ${MIN_AMPLITUDE}%），价差空间小`);
    // 一字涨跌停（涨停价已按分取整）
    const lv = keyLevels.value;
    if (Math.abs(q.price - lv.limitUp) < 0.005 && q.high === q.low)
      return { ok: false, reasons: ["一字涨停，无法买入做T"] };
    if (Math.abs(q.price - lv.limitDown) < 0.005 && q.high === q.low)
      return { ok: false, reasons: ["一字跌停，无法卖出做T"] };
    // 距板单向禁开仓（防卖飞 / 防抄底）
    if (q.price >= lv.limitUp * (1 - LIMIT_GUARD_PCT / 100))
      reasons.push(`距涨停不足 ${LIMIT_GUARD_PCT}%，禁倒T（防卖飞后封板买不回）`);
    if (q.price <= lv.limitDown * (1 + LIMIT_GUARD_PCT / 100))
      reasons.push(`距跌停不足 ${LIMIT_GUARD_PCT}%，禁正T（防抄底被埋）`);
    if (marketPct.value <= MARKET_CRASH)
      reasons.push(`大盘急跌(${marketPct.value.toFixed(2)}%)，正T需谨慎`);
    if (records.value.length >= MAX_T_PER_DAY)
      reasons.push(`今日已做${MAX_T_PER_DAY}次，防频繁磨损`);
    if (estRoundTripFeePct.value > 0 && minSpread.value > TARGET_MIN)
      reasons.push(`预估往返成本 ${estRoundTripFeePct.value.toFixed(2)}%，价差门槛高，本次做T性价比低`);
    // —— P1 熔断 / 时段 / 流动性 ——
    if (dailyLossBlocked.value)
      reasons.push("今日亏损已达 2R（单笔风险×2），熔断停做，只处理在途");
    if (losingStreakBlocked.value)
      reasons.push("连亏 2 笔，触发熔断，停止新开仓（先复盘）");
    if (openObserveBlocked.value)
      reasons.push("9:30-9:45 观察期，暂不开首单（开盘噪声大）");
    if (lateBlocked.value)
      reasons.push("14:30 后不再开新仓，只做在途闭环");
    if (regime.value === "extreme")
      reasons.push("极端市况（乖离异常或大盘急跌），停止新开仓，只处理在途");
    if (spreadPct.value > MAX_SPREAD_PCT)
      reasons.push(`盘口价差率 ${spreadPct.value.toFixed(2)}% > ${MAX_SPREAD_PCT}%，流动性不足，禁做`);
    const to = q.turnover ?? 0;
    if (to > 0 && (to < MIN_TURNOVER || to > MAX_TURNOVER))
      reasons.push(`换手 ${to.toFixed(1)}% 超出 ${MIN_TURNOVER}-${MAX_TURNOVER}% 区间（冷门/过热均不宜做T）`);
    if (avgAmount5d.value > 0 && avgAmount5d.value < MIN_AMOUNT_5D)
      reasons.push(`近5日日均成交额 ${(avgAmount5d.value / 1e8).toFixed(1)} 亿 < 3 亿，流动性不足`);
    return { ok: reasons.length === 0, reasons };
  });

  // ============ 信号防抖状态（advanceState 在每次刷新后推进）============
  const confirmCount = ref(0);
  const lastOpenAction = ref<TAction | "">("");
  const cooldownUntil = ref(0);
  const closeArmed = ref(false);

  /** 单腿浮盈/浮亏 %（long=现价-开仓；short=开仓-现价） */
  function gainOf(l: TLeg, price: number): number {
    if (!l || !(price > 0)) return 0;
    return l.type === "long"
      ? ((price - l.openPrice) / l.openPrice) * 100
      : ((l.openPrice - price) / l.openPrice) * 100;
  }

  /** 当前标的总在途浮盈（毛利，元） */
  const totalOpenPnl = computed(() => {
    const p = quote.value?.price ?? 0;
    return currentLegs.value.reduce((s, l) => {
      const gross = l.type === "long"
        ? (p - l.openPrice) * l.vol
        : (l.openPrice - p) * l.vol;
      return s + gross;
    }, 0);
  });

  /**
   * 挑出当前最需处理的腿：止损 > 达标 > 达门槛（仅当 closeArmed）。
   * @returns { leg, kind, gain } kind: "stop"|"target"|"threshold"|null
   */
  function pickPriorityLeg(list: TLeg[], price: number): {
    leg: TLeg;
    kind: "stop" | "target" | "threshold" | "hold";
    gain: number;
  } {
    if (!list.length || !(price > 0)) return { leg: list[0], kind: "hold", gain: 0 };
    for (const l of list) {
      const g = gainOf(l, price);
      const stopP = l.stopPct ?? STOP_MAX;
      if (g <= -stopP) return { leg: l, kind: "stop", gain: g };
    }
    for (const l of list) {
      const g = gainOf(l, price);
      const tgtP = l.targetPct ?? TARGET_MIN;
      if (g >= tgtP) return { leg: l, kind: "target", gain: g };
    }
    if (closeArmed.value) {
      for (const l of list) {
        const g = gainOf(l, price);
        if (g >= minSpread.value) return { leg: l, kind: "threshold", gain: g };
      }
    }
    return { leg: list[0], kind: "hold", gain: gainOf(list[0], price) };
  }

  /**
   * 刷新周期状态推进：开仓确认计数 + 平仓迟滞（任一腿达标即 armed）。
   * 必须在 refresh 数据落地后、UI 读取 signal 前调用。
   */
  function advanceState() {
    const s = signal.value;
    const openAction =
      s.action === "long-open" || s.action === "short-open" ? s.action : "";
    if (openAction && openAction === lastOpenAction.value) {
      confirmCount.value = Math.min(confirmCount.value + 1, OPEN_CONFIRM_TICKS);
    } else {
      confirmCount.value = openAction ? 1 : 0;
    }
    lastOpenAction.value = openAction;

    const list = currentLegs.value;
    const p = quote.value?.price ?? 0;
    if (list.length && p > 0) {
      const anyReady = list.some((l) => gainOf(l, p) >= minSpread.value);
      if (anyReady) closeArmed.value = true;
      else if (list.every((l) => gainOf(l, p) < minSpread.value - HYSTERESIS)) {
        closeArmed.value = false;
      }
    } else {
      closeArmed.value = false;
    }
  }

  // ============ 核心信号引擎 ============
  const signal = computed<TSignal>(() => {
    const q = quote.value;
    const lv = keyLevels.value;
    const idle: TSignal = {
      action: "wait", title: "观望等待", side: "hold", urgency: "none",
      price: q?.price ?? 0, target: 0, stop: 0, vol: 0, spread: 0,
      reasons: ["未出现满足条件的做T机会"],
      regime: regime.value,
    };
    if (!q || !q.price || !selectedCode.value) return idle;
    const price = q.price;
    const list = currentLegs.value;

    // 尾盘强制闭环优先（所有在途腿全平）
    if (isCloseWindow() && list.length) {
      const totalVol = list.reduce((s, l) => s + l.vol, 0);
      const first = list[0];
      const buy = first.type === "long";
      return {
        action: "force-close",
        title: buy ? `⚠️ 尾盘强制闭环：卖出 ${totalVol} 股` : `⚠️ 尾盘强制闭环：买回 ${totalVol} 股`,
        side: buy ? "sell" : "buy",
        urgency: "strong",
        price, vol: totalVol,
        target: price, stop: price, spread: 0,
        reasons: [`${CLOSE_TIME} 前必须闭环，防止隔夜变加仓（在途 ${list.length} 腿）`],
        regime: regime.value,
      };
    }

    // —— 有在途：只处理平仓（优先腿）——
    if (list.length) {
      const pri = pickPriorityLeg(list, price);
      const l = pri.leg;
      const stopP = l.stopPct ?? STOP_MAX;
      const tgtP = l.targetPct ?? TARGET_MIN;
      const targetPrice = l.type === "long"
        ? l.openPrice * (1 + tgtP / 100)
        : l.openPrice * (1 - tgtP / 100);
      const stopPrice = l.type === "long"
        ? l.openPrice * (1 - stopP / 100)
        : l.openPrice * (1 + stopP / 100);
      const legsSummary = list.slice(0, 3).map((x) => {
        const g = gainOf(x, price);
        return `${x.type === "long" ? "正T" : "倒T"}@${x.openPrice.toFixed(2)}(${x.vol}股) ${g >= 0 ? "+" : ""}${g.toFixed(2)}%`;
      }).join(" · ");

      if (pri.kind === "stop") {
        return {
          action: "stop-loss", title: "🛑 止损：立即卖出", side: "sell", urgency: "strong",
          price, target: price, stop: price, vol: l.vol, spread: pri.gain,
          reasons: [
            `在途腿已跌 ${pri.gain.toFixed(2)}%（止损线 -${stopP.toFixed(1)}%），认错卖出，不扛单`,
            `在途 ${list.length} 腿：${legsSummary}`,
          ],
          regime: regime.value,
        };
      }
      if (pri.kind === "target") {
        return {
          action: l.type === "long" ? "long-close" : "short-close",
          title: l.type === "long" ? "✅ 正T闭环：卖出" : "✅ 倒T闭环：买回",
          side: l.type === "long" ? "sell" : "buy",
          urgency: "strong",
          price, target: price, stop: stopPrice, vol: l.vol, spread: pri.gain,
          reasons: [`该腿已达 +${tgtP.toFixed(1)}% 目标价差，落袋为安`, `在途 ${list.length} 腿：${legsSummary}`],
          regime: regime.value,
        };
      }
      if (pri.kind === "threshold") {
        return {
          action: l.type === "long" ? "long-close" : "short-close",
          title: l.type === "long" ? "正T可卖出（达门槛）" : "倒T可买回（达门槛）",
          side: l.type === "long" ? "sell" : "buy",
          urgency: "normal",
          price, target: price, stop: stopPrice, vol: l.vol, spread: pri.gain,
          reasons: [
            `价差 ${pri.gain.toFixed(2)}% 已超门槛 ${minSpread.value.toFixed(2)}%（含预估成本 ${estRoundTripFeePct.value.toFixed(2)}%）`,
            "连续确认后出现操作按钮，防止阈值抖动误触",
            `在途 ${list.length} 腿：${legsSummary}`,
          ],
          regime: regime.value,
        };
      }
      return {
        action: "wait", title: `${l.type === "long" ? "正T" : "倒T"}持仓中（${list.length}腿）`,
        side: "hold", urgency: "none",
        price, target: targetPrice, stop: stopPrice, vol: l.vol, spread: pri.gain,
        reasons: [
          `主腿开仓价 ${l.openPrice.toFixed(2)}，浮盈 ${pri.gain.toFixed(2)}%，等待 +${tgtP.toFixed(1)}% 目标（含成本门槛 ${minSpread.value.toFixed(2)}%）`,
          `在途 ${list.length} 腿：${legsSummary}`,
          totalOpenPnl.value >= 0
            ? `总在途浮盈 +${totalOpenPnl.value.toFixed(0)} 元`
            : `总在途浮盈 ${totalOpenPnl.value.toFixed(0)} 元`,
        ],
        regime: regime.value,
      };
    }

    // —— 无在途：打分卡寻找开仓机会 ——
    if (!canT.value.ok) {
      return { ...idle, reasons: canT.value.reasons };
    }
    if (records.value.length >= MAX_T_PER_DAY) {
      return { ...idle, reasons: [`今日已做满 ${MAX_T_PER_DAY} 次，不再开新仓`] };
    }

    const vol = suggestVol.value;
    if (vol < 100) {
      return { ...idle, reasons: ["1R 反推数量不足一手（底仓市值偏小或波动过大），本次不做"] };
    }

    // 正T候选：现价在 VWAP 下方 + 市况允许
    if (bias.value < 0 && regimeAllows(regime.value, "long")) {
      const sc = scoreFor("long");
      const tgt = Math.max(lv.vwap, price * (1 + targetPct.value / 100));
      const stop = price * (1 - stopPct.value / 100);
      const reasons = [
        `乖离 ${bias.value.toFixed(2)}%（z=${biasZ.value.z.toFixed(1)}，历史均值${biasZ.value.biasMean.toFixed(2)}%/σ${biasZ.value.biasStd.toFixed(2)}%）`,
        `盘口失衡 ${(bookImb.value * 100).toFixed(0)}  ·  主动净量 ${actNet.value.net >= 0 ? "+" : ""}${actNet.value.net} 手`,
        `近支撑 ${distPct(lv.supportLow).toFixed(2)}%  ·  ATR ${atrPct.value.toFixed(2)}%  →  止损 -${stopPct.value.toFixed(1)}% / 目标 +${targetPct.value.toFixed(1)}%`,
        `预估往返成本 ${estRoundTripFeePct.value.toFixed(2)}%，价差门槛 ${minSpread.value.toFixed(2)}%`,
      ];
      if (sc.total >= 60) {
        const missing = sc.missing.length ? `  ·  失分 ${sc.missing.join(", ")}` : "";
        reasons.push(`信号分 ${sc.total}/100（${sc.parts.bias}/30 乖离 · ${sc.parts.book}/20 盘口 · ${sc.parts.volume}/15 量能 · ${sc.parts.position}/20 位置 · ${sc.parts.strength}/15 强弱）${missing}`);
      }
      if (gradeOf(sc.total) === "strong") {
        return {
          action: "long-open", title: "🟢 正T买入（强信号）", side: "buy", urgency: "strong",
          price, target: tgt, stop, vol,
          spread: ((tgt - price) / price * 100), reasons,
          score: sc.total, grade: "strong", regime: regime.value,
        };
      }
      if (gradeOf(sc.total) === "prep") {
        return {
          action: "wait", title: `预备信号（差 ${75 - sc.total} 分出现按钮）`, side: "hold", urgency: "none",
          price, target: tgt, stop, vol: 0, spread: 0, reasons,
          score: sc.total, grade: "prep", regime: regime.value,
        };
      }
      return {
        ...idle,
        reasons: [`正T打分 ${sc.total}/100 不足（最大失分：${sc.missing.join(", ") || "无"}），继续等待`],
        score: sc.total, grade: "wait", regime: regime.value,
      };
    }

    // 倒T候选：现价在 VWAP 上方 + 市况允许
    if (bias.value > 0 && regimeAllows(regime.value, "short")) {
      const sc = scoreFor("short");
      const tgt = Math.min(lv.vwap, price * (1 - targetPct.value / 100));
      const stop = price * (1 + stopPct.value / 100);
      const reasons = [
        `乖离 +${bias.value.toFixed(2)}%（z=${biasZ.value.z.toFixed(1)}）`,
        `盘口失衡 ${(bookImb.value * 100).toFixed(0)}  ·  主动净量 ${actNet.value.net >= 0 ? "+" : ""}${actNet.value.net} 手`,
        `近压力 ${distPct(lv.resistHigh).toFixed(2)}%  ·  ATR ${atrPct.value.toFixed(2)}%  →  止损 +${stopPct.value.toFixed(1)}% / 目标 -${targetPct.value.toFixed(1)}%`,
        `预估往返成本 ${estRoundTripFeePct.value.toFixed(2)}%，价差门槛 ${minSpread.value.toFixed(2)}%`,
      ];
      if (sc.total >= 60) {
        const missing = sc.missing.length ? `  ·  失分 ${sc.missing.join(", ")}` : "";
        reasons.push(`信号分 ${sc.total}/100（${sc.parts.bias}/30 乖离 · ${sc.parts.book}/20 盘口 · ${sc.parts.volume}/15 量能 · ${sc.parts.position}/20 位置 · ${sc.parts.strength}/15 强弱）${missing}`);
      }
      if (gradeOf(sc.total) === "strong") {
        return {
          action: "short-open", title: "🔴 倒T卖出（强信号）", side: "sell", urgency: "strong",
          price, target: tgt, stop, vol,
          spread: ((price - tgt) / price * 100), reasons,
          score: sc.total, grade: "strong", regime: regime.value,
        };
      }
      if (gradeOf(sc.total) === "prep") {
        return {
          action: "wait", title: `预备信号（差 ${75 - sc.total} 分出现按钮）`, side: "hold", urgency: "none",
          price, target: tgt, stop, vol: 0, spread: 0, reasons,
          score: sc.total, grade: "prep", regime: regime.value,
        };
      }
      return {
        ...idle,
        reasons: [`倒T打分 ${sc.total}/100 不足（最大失分：${sc.missing.join(", ") || "无"}），继续等待`],
        score: sc.total, grade: "wait", regime: regime.value,
      };
    }

    return { ...idle, reasons: [`市况 ${regime.value} 不允许当前方向开仓`] };
  });

  /** 对外信号：开仓需连续确认 + 冷却；平仓迟滞已在 signal 内处理 */
  const confirmedSignal = computed<TSignal>(() => {
    const s = signal.value;
    if (s.action !== "long-open" && s.action !== "short-open") return s;
    if (Date.now() < cooldownUntil.value) {
      return {
        ...s, action: "wait", side: "hold", urgency: "none",
        title: "冷却中", spread: 0,
        reasons: ["同方向开仓信号冷却中（5 分钟内不重复开仓），避免追单"],
      };
    }
    if (confirmCount.value < OPEN_CONFIRM_TICKS) {
      return {
        ...s, action: "wait", side: "hold", urgency: "none",
        title: "信号确认中", spread: 0,
        reasons: [...s.reasons, `连续 ${OPEN_CONFIRM_TICKS} 个刷新周期确认后出现操作按钮（防信号抖动）`],
      };
    }
    return s;
  });

  // ============ 对手盘撮合（P2-1） ============
  /** 对手价：买入=卖一×(1+滑点)；卖出=买一×(1−滑点)；缺档回退现价 */
  function opponentPrice(side: "buy" | "sell"): number {
    const ob = orderBook.value;
    if (side === "buy") {
      const ask = ob?.asks?.[0]?.price;
      if (ask && ask > 0) return round2(ask * (1 + SLIP_PCT / 100));
    } else {
      const bid = ob?.bids?.[0]?.price;
      if (bid && bid > 0) return round2(bid * (1 - SLIP_PCT / 100));
    }
    return round2(quote.value?.price ?? 0);
  }

  /** 执行确认层数据：对手价 / 数量 / 预估费用 / 净利差 */
  const preview = computed(() => {
    const s = confirmedSignal.value;
    if (s.side === "hold") return null;
    const side = s.side as "buy" | "sell";
    const px = opponentPrice(side);
    const amt = px * s.vol;
    const fee = estimateFee(side, amt);
    return {
      side,
      vol: s.vol,
      price: px,
      feeTotal: fee.total,
      feeRate: amt > 0 ? (fee.total / amt) * 100 : 0,
      // 相对信号参考价的偏离（提示滑点影响）
      slipPct: s.price > 0 ? Math.abs((px - s.price) / s.price) * 100 : 0,
    };
  });

  // ============ 网格规划（P1-5） ============
  /** 当前方向的网格规划（无在途且方向有效时可用） */
  const gridPlanNow = computed<GridPlan | null>(() => {
    const q = quote.value;
    const lv = keyLevels.value;
    const vol = suggestVol.value;
    if (!q || vol < 100 || currentLegs.value.length > 0) return null;
    if (bias.value < 0 && regimeAllows(regime.value, "long")) {
      return gridPlanLong(q.price, lv.supportLow, atrPct.value, vol);
    }
    if (bias.value > 0 && regimeAllows(regime.value, "short")) {
      return gridPlanShort(q.price, lv.resistHigh, atrPct.value, vol);
    }
    return null;
  });
  const gridDir = computed<"long" | "short" | null>(() => {
    if (!gridPlanNow.value) return null;
    return bias.value < 0 ? "long" : "short";
  });

  // ============ 当日做T统计（按当前标的） ============
  const currentRecords = computed<TRecord[]>(() =>
    records.value.filter((r) => r.code === selectedCode.value),
  );
  const todayStats = computed(() => {
    const recs = currentRecords.value;
    const count = recs.length;
    const win = recs.filter((r) => r.pnl > 0).length;
    const pnl = recs.reduce((s, r) => s + r.pnl, 0);
    return {
      count,
      win,
      winRate: count > 0 ? (win / count) * 100 : 0,
      pnl,
    };
  });

  // ============ 做T台账跨日统计（P2-4，SQL） ============
  const history = ref<TRecord[]>([]);
  async function loadHistory() {
    try {
      const rows = await tmakerRecordsList(1000);
      history.value = rows.map((r: TmakerRecordRow) => ({
        code: r.code,
        name: r.name,
        type: r.type,
        vol: r.vol,
        openPrice: r.openPrice,
        closePrice: r.closePrice,
        pnl: r.pnlCents / 100,
        fee: r.feeCents / 100,
        openFee: 0,
        closeFee: r.feeCents / 100,
        openTime: r.openTime,
        closeTime: r.closeTime,
      }));
    } catch { /* 首次无表时静默 */ }
  }

  const historyStats = computed(() => {
    const hs = history.value;
    const count = hs.length;
    if (!count) return null;
    const win = hs.filter((r) => r.pnl > 0).length;
    const loss = count - win;
    const grossWin = hs.filter((r) => r.pnl > 0).reduce((s, r) => s + r.pnl, 0);
    const grossLoss = Math.abs(hs.filter((r) => r.pnl <= 0).reduce((s, r) => s + r.pnl, 0));
    const long = hs.filter((r) => r.type === "long");
    const short = hs.filter((r) => r.type === "short");
    return {
      count,
      winRate: (win / count) * 100,
      totalPnl: hs.reduce((s, r) => s + r.pnl, 0),
      avgPnl: hs.reduce((s, r) => s + r.pnl, 0) / count,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : 0,
      longCount: long.length,
      longWinRate: long.length ? (long.filter((r) => r.pnl > 0).length / long.length) * 100 : 0,
      shortCount: short.length,
      shortWinRate: short.length ? (short.filter((r) => r.pnl > 0).length / short.length) * 100 : 0,
    };
  });

  // ============ 多票扫描（P2-5） ============
  const scanQuotes = ref<Record<string, Quote>>({});
  const scanUpdatedAt = ref(0);

  function scanScore(q: Quote): number {
    let s = 0;
    s += Math.min(q.amplitude || 0, 8) * 1.5; // 波动（核心）
    s += Math.min((q.amount || 0) / 1e8, 6) * 0.8; // 流动性
    s += (q.turnover >= MIN_TURNOVER && q.turnover <= MAX_TURNOVER) ? 4 : 0; // 换手适宜
    s += Math.min(Math.abs(q.pct || 0), 5) * 0.6; // 动能
    return Math.round(s);
  }

  async function refreshScan() {
    const codes = positions.value.map((p) => p.code);
    if (!codes.length) { scanQuotes.value = {}; return; }
    try {
      const qs = await fetchQuotes(codes.slice(0, 10));
      const m: Record<string, Quote> = {};
      for (const q of qs) m[q.code] = q;
      scanQuotes.value = m;
      scanUpdatedAt.value = Date.now();
    } catch { /* 静默 */ }
  }

  const scanCandidates = computed<ScanCandidate[]>(() => {
    const out: ScanCandidate[] = [];
    for (const p of positions.value) {
      const q = scanQuotes.value[p.code];
      if (!q || !q.price) continue;
      out.push({
        code: p.code,
        name: p.name,
        price: q.price,
        pct: q.pct,
        amplitude: q.amplitude,
        amount: q.amount,
        turnover: q.turnover,
        score: scanScore(q),
      });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 3);
  });
  const bestCandidate = computed<ScanCandidate | null>(() => scanCandidates.value[0] ?? null);

  // ============ 执行做T（走模拟盘，按真实费用记账，对手盘撮合） ============
  const busy = ref(false);
  const toast = ref("");
  function flash(msg: string) {
    toast.value = msg;
    setTimeout(() => { if (toast.value === msg) toast.value = ""; }, 3500);
  }

  /** 执行信号建议的动作（含确认层：executeSignal 由 UI 在确认后调用；volOverride 支持数量快捷档） */
  async function executeSignal(volOverride?: number) {
    const s = confirmedSignal.value;
    const name = currentPos.value?.name || quote.value?.name || "";
    if (s.side === "hold" || !quote.value || !selectedCode.value) return;
    const vol = volOverride && volOverride >= 100 ? round100(volOverride) : s.vol;
    if (!vol || vol < 100) { flash("做T数量须为100股整数倍"); return; }
    busy.value = true;
    try {
      const code = selectedCode.value;
      if (s.action === "long-open" || s.action === "short-open") {
        const side = s.side as "buy" | "sell";
        const px = opponentPrice(side);
        const fill = side === "buy"
          ? await paper.buy(code, name, px, vol)
          : await paper.sell(code, px, vol);
        legs.value = {
          ...legs.value,
          [code]: [...(legs.value[code] ?? []), {
            type: s.action === "long-open" ? "long" : "short",
            code, vol, openPrice: px, openTime: Date.now(),
            openFee: fill.fee,
            stopPct: stopPct.value, targetPct: targetPct.value,
          }],
        };
        persist();
        flash(`${s.action === "long-open" ? "正T" : "倒T"}已${side === "buy" ? "买入" : "卖出"} ${vol} 股 @ ${px.toFixed(2)}（费${fill.fee.toFixed(1)}元，含滑点）`);
      } else if (s.action === "force-close") {
        await closeAllLegs();
      } else if (["long-close", "short-close", "stop-loss"].includes(s.action)) {
        const pri = pickPriorityLeg(currentLegs.value, quote.value.price);
        if (pri.leg) {
          const side = s.side as "sell" | "buy";
          const px = opponentPrice(side);
          const fill = side === "sell"
            ? await paper.sell(code, px, pri.leg.vol)
            : await paper.buy(code, name, px, pri.leg.vol);
          closeLeg(code, pri.leg, px, fill.fee);
        }
      }
      // 开仓成功：重置确认计数并进入冷却
      lastOpenAction.value = "";
      confirmCount.value = 0;
      if (s.action === "long-open" || s.action === "short-open") {
        cooldownUntil.value = Date.now() + COOLDOWN_MS;
      }
      await paper.reloadAll();
      await refresh();
    } catch (e) {
      flash(`执行失败：${(e as Error)?.message || e}`);
    } finally {
      busy.value = false;
    }
  }

  /** 布网格：按档位一次性分批成交（每档独立成腿）；volOverride 支持数量快捷档 */
  async function executeGrid(dir: "long" | "short", volOverride?: number) {
    const total = volOverride && volOverride >= 100 ? round100(volOverride) : suggestVol.value;
    const plan = dir === "long"
      ? gridPlanLong(quote.value?.price ?? 0, keyLevels.value.supportLow, atrPct.value, total)
      : gridPlanShort(quote.value?.price ?? 0, keyLevels.value.resistHigh, atrPct.value, total);
    if (!plan.levels.length || !quote.value || !selectedCode.value) {
      flash("网格规划为空（数量不足一手或边界过近）");
      return;
    }
    const code = selectedCode.value;
    const name = currentPos.value?.name || quote.value?.name || "";
    const gridId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    busy.value = true;
    try {
      const newLegs: TLeg[] = [];
      const prices: string[] = [];
      for (const lv of plan.levels) {
        // 网格按限价档位成交（模拟盘即视为限价单成交）
        const fill = dir === "long"
          ? await paper.buy(code, name, lv.price, lv.vol)
          : await paper.sell(code, lv.price, lv.vol);
        newLegs.push({
          type: dir,
          code, vol: lv.vol, openPrice: lv.price, openTime: Date.now(),
          openFee: fill.fee,
          stopPct: stopPct.value, targetPct: targetPct.value,
          gridId,
        });
        prices.push(`${lv.price.toFixed(2)}(${lv.vol}股)`);
      }
      legs.value = {
        ...legs.value,
        [code]: [...(legs.value[code] ?? []), ...newLegs],
      };
      persist();
      flash(`${dir === "long" ? "正T" : "倒T"}网格已布 ${newLegs.length} 档：${prices.join(" / ")}${plan.truncated ? "（触及边界已少挂档）" : ""}`);
      lastOpenAction.value = "";
      confirmCount.value = 0;
      cooldownUntil.value = Date.now() + COOLDOWN_MS;
      await paper.reloadAll();
      await refresh();
    } catch (e) {
      flash(`网格执行失败：${(e as Error)?.message || e}`);
    } finally {
      busy.value = false;
    }
  }

  /** 一键全平：按对手价逐腿闭环 */
  async function closeAllLegs() {
    const code = selectedCode.value;
    const name = currentPos.value?.name || quote.value?.name || "";
    const list = [...currentLegs.value];
    if (!list.length || !quote.value) { flash("无在途腿可平"); return; }
    busy.value = true;
    try {
      for (const l of list) {
        const side: "buy" | "sell" = l.type === "long" ? "sell" : "buy";
        const px = opponentPrice(side);
        const fill = side === "sell"
          ? await paper.sell(code, px, l.vol)
          : await paper.buy(code, name, px, l.vol);
        closeLeg(code, l, px, fill.fee);
      }
      flash(`已全平 ${list.length} 腿（对手价+滑点）`);
      await paper.reloadAll();
      await refresh();
    } catch (e) {
      flash(`全平失败：${(e as Error)?.message || e}`);
    } finally {
      busy.value = false;
    }
  }

  /** 闭环记账：按两笔真实成交费（openFee + closeFee）计算净盈亏，并同步 SQL 台账 */
  function closeLeg(code: string, l: TLeg, closePrice: number, closeFee: number) {
    const gross = l.type === "long"
      ? (closePrice - l.openPrice) * l.vol
      : (l.openPrice - closePrice) * l.vol;
    const fee = l.openFee + closeFee;
    const rec: TRecord = {
      code: l.code,
      name: currentPos.value?.name || "",
      type: l.type,
      vol: l.vol,
      openPrice: l.openPrice,
      closePrice,
      pnl: gross - fee,
      fee,
      openFee: l.openFee,
      closeFee,
      openTime: l.openTime,
      closeTime: Date.now(),
    };
    records.value = [rec, ...records.value];
    const arr = [...(legs.value[code] ?? [])].filter((x) => x !== l);
    const next = { ...legs.value };
    if (arr.length) next[code] = arr;
    else delete next[code];
    legs.value = next;
    persist();
    // 跨日台账（SQL，失败不阻断）
    try {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      void tmakerRecordsUpsert([{
        tradeDate: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
        code: rec.code,
        name: rec.name,
        type: rec.type,
        vol: rec.vol,
        openPrice: rec.openPrice,
        closePrice: rec.closePrice,
        pnlCents: Math.round(rec.pnl * 100),
        feeCents: Math.round(rec.fee * 100),
        openTime: rec.openTime,
        closeTime: rec.closeTime,
      }]);
      void loadHistory();
    } catch { /* 静默 */ }
    // 闭环完成通知
    notify(
      l.type === "long" ? "正T已闭环" : "倒T已闭环",
      `${l.vol}股 ${l.code} @ ${closePrice.toFixed(2)}，净盈亏 ${(gross - fee) >= 0 ? "+" : ""}${(gross - fee).toFixed(0)} 元（费${fee.toFixed(1)}元）`,
      gross - fee >= 0 ? "up" : "down",
      "close",
    );
  }

  // ============ 尾盘闭环提醒（14:45/14:50/14:55 各一次） ============
  const closeNotified = ref<string[]>([]);
  function notify(title: string, body: string, tone: "up" | "down", key: string) {
    const today = todayStr();
    const k = `${today}-${key}`;
    if (closeNotified.value.includes(k)) return;
    closeNotified.value = [...closeNotified.value, k];
    try {
      pushToast({
        key: `tmaker-${k}`,
        title: `做T · ${title}`,
        body,
        code: selectedCode.value,
        tone,
        at: Date.now(),
      });
      if (localStorage.getItem("tickgold_alert_sound") !== "0") playAlert(tone);
    } catch { /* 通知失败不阻断 */ }
  }

  function checkCloseWindowNotify() {
    if (!isCloseWindow()) return;
    const d = new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    if (m >= 14 * 60 + 45 && m < 14 * 60 + 50) {
      notify("尾盘提醒", "已到 14:45，在途做T请准备在 14:50 前闭环", "up", "1445");
    }
    if (m >= 14 * 60 + 50 && m < 14 * 60 + 55) {
      notify("强制闭环窗口", "14:50 已到，未平仓的做T腿将隔夜变加仓，请立即闭环", "down", "1450");
    }
    if (m >= 14 * 60 + 55) {
      notify("最后5分钟", "14:55，剩余 5 分钟，请尽快闭环", "down", "1455");
    }
  }

  /** 关闭昨日未闭环遗留提示（仅本会话生效） */
  function dismissLegacy() {
    legacyUnclosed.value = [];
  }

  // ============ 数据加载 ============
  /** 单路超时降级：接口慢/挂起时先给默认值，保证切换股票 4s 内必出数据（慢源后续轮询自愈） */
  function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
  }
  /** 日K（切票后每次重拉；落地前校验标的，防止旧响应覆盖新票；失败清空不抛——不得阻断行情刷新） */
  async function loadDaily() {
    const c = selectedCode.value;
    if (!c) return;
    try {
      const bars = await withTimeout(fetchKLine(c, 101, 20), 4000, [] as KBar[]);
      if (selectedCode.value !== c) return; // 已切票，丢弃过期日K
      if (bars.length) { daily.value = bars; dailyCode.value = c; }
    } catch (e) {
      daily.value = [];
      dailyCode.value = "";
      errorMsg.value = `日K加载失败: ${e}`;
    }
  }

  /** 盘口方向自愈（数据源买卖互换时恢复标准语义，纯函数单测见 tmaker-book-normalize） */
  function normalizeBook(ob: OrderBook): OrderBook {
    return bookNormalize(ob);
  }

  /** 快速通道：盘口/逐笔/实时报价（3s，盘中）——各路 3s 超时降级，慢源不拖死轮询 */
  async function fastRefresh() {
    const c = selectedCode.value;
    if (!c) return;
    try {
      const [qs, ob, tr] = await Promise.all([
        withTimeout(fetchQuotes([c]), 3000, [] as Quote[]),
        withTimeout(fetchOrderBook(c).catch(() => null), 3000, null),
        withTimeout(fetchTrades(c, 40).catch(() => [] as TradeTick[]), 3000, [] as TradeTick[]),
      ]);
      if (selectedCode.value !== c) return; // 已切票，丢弃旧标的响应
      const q = qs.find((x) => x.code === c);
      if (q) { quote.value = q; loadFailed.value = false; }
      if (ob && ob.code === c) orderBook.value = normalizeBook(ob);
      const trOk = tr.filter((t) => !t.code || t.code === c);
      if (trOk.length) trades.value = trOk;
      checkCloseWindowNotify();
      advanceState();
    } catch (e) {
      errorMsg.value = String(e);
    }
  }

  /** 慢速通道：分时/大盘/盘口增强（15s，盘中）——分时 4s 超时降级 */
  async function slowRefresh() {
    const c = selectedCode.value;
    if (!c) return;
    try {
      const [mins, idx, de] = await Promise.all([
        withTimeout(fetchMinute(c).catch(() => [] as KBar[]), 4000, [] as KBar[]),
        withTimeout(fetchIndexQuotes().catch(() => [] as Quote[]), 5000, [] as Quote[]),
        withTimeout(fetchDepthEnhance(c).catch(() => ({ priceDist: [], auction: [], sealTrend: [] } as DepthEnhance)), 4000, { priceDist: [], auction: [], sealTrend: [] } as DepthEnhance),
      ]);
      if (selectedCode.value !== c) return; // 已切票，丢弃旧标的响应
      if (mins.length) { minute.value = mins; minuteCode.value = c; }
      if (de) depthEnhance.value = de;
      const sh = idx.find((i) => i.code === "000001" || i.name?.includes("上证"));
      if (sh) marketPct.value = sh.pct;
    } catch (e) {
      errorMsg.value = String(e);
    }
  }

  /** 全量刷新（切票/执行后调用）：每路 3.5s 超时降级——任何单源卡死都不阻断出数据 */
  async function refresh() {
    const c = selectedCode.value;
    if (!c) return;
    try {
      const [qs, ob, mins, idx, tr, de] = await Promise.all([
        withTimeout(fetchQuotes([c]), 3500, [] as Quote[]),
        withTimeout(fetchOrderBook(c).catch(() => null), 3500, null),
        withTimeout(fetchMinute(c).catch(() => [] as KBar[]), 3500, [] as KBar[]),
        withTimeout(fetchIndexQuotes().catch(() => [] as Quote[]), 5000, [] as Quote[]),
        withTimeout(fetchTrades(c, 40).catch(() => [] as TradeTick[]), 3000, [] as TradeTick[]),
        withTimeout(fetchDepthEnhance(c).catch(() => ({ priceDist: [], auction: [], sealTrend: [] } as DepthEnhance)), 3500, { priceDist: [], auction: [], sealTrend: [] } as DepthEnhance),
      ]);
      if (selectedCode.value !== c) return; // 已切票，丢弃旧标的响应
      const q = qs.find((x) => x.code === c);
      if (q) { quote.value = q; loadFailed.value = false; }
      if (ob && ob.code === c) orderBook.value = normalizeBook(ob);
      if (mins.length) { minute.value = mins; minuteCode.value = c; }
      const trOk = tr.filter((t) => !t.code || t.code === c);
      if (trOk.length) trades.value = trOk;
      if (de) depthEnhance.value = de;
      const sh = idx.find((i) => i.code === "000001" || i.name?.includes("上证"));
      if (sh) marketPct.value = sh.pct;
      checkCloseWindowNotify();
      advanceState();
    } catch (e) {
      errorMsg.value = String(e);
    }
  }

  function select(code: string) {
    if (!code || code === selectedCode.value) return;
    selectedCode.value = code;
    quote.value = null; minute.value = []; minuteCode.value = ""; orderBook.value = null;
    trades.value = []; depthEnhance.value = { priceDist: [], auction: [], sealTrend: [] };
    // 日K一并清空：防止旧标的的 keyLevels（近5日支撑/压力）残留串票
    daily.value = []; dailyCode.value = "";
    errorMsg.value = "";
    loadFailed.value = false;
    // 记住上次选中标的（重启后恢复）
    try { localStorage.setItem(SELECTED_KEY, code); } catch { /* 忽略 */ }
    // 在途按标的隔离：切换标的不带走腿，各票独立。
    void loadWithRetry();
  }

  /**
   * 切票/重试：行情全源偶发限频时，首轮并行拉取后若仍无报价，间隔再试最多 3 轮；
   * 3 轮仍失败置 loadFailed（空态给"点击重试"），后台 3s 轮询仍会继续自愈。
   */
  async function loadWithRetry() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const c = selectedCode.value;
      await Promise.allSettled([loadDaily(), refresh()]);
      if (quote.value?.price) { loadFailed.value = false; return; }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1200));
        if (selectedCode.value !== c) return; // 已切票，放弃本次重试
      }
    }
    if (!quote.value?.price) loadFailed.value = true;
  }

  /** 手动重试（空态"点击重试"） */
  function retryLoad() {
    loadFailed.value = false;
    errorMsg.value = "";
    void loadWithRetry();
  }

  /**
   * [DEV] 播种"昨日底仓"（T+1 已解锁，可卖），供模拟盘立即体验做T。
   */
  async function seedTestPosition(code: string, vol = 1000) {
    const c = code.trim();
    if (!/^\d{6}$/.test(c)) { flash("请输入 6 位股票代码"); return; }
    busy.value = true;
    try {
      const qs = await fetchQuotes([c]);
      const q = qs[0];
      if (!q?.price) { flash("未取到该股票行情，无法播种"); return; }
      await mockSeedPosition(c, vol, q.price);
      await paper.load();
      if (selectedCode.value === c) {
        await refresh();
      } else {
        select(c);
      }
      flash(`已播种昨日底仓 ${q.name || c} ${vol}股 @ ${q.price.toFixed(2)}（T+1可卖）`);
    } catch (e) {
      flash(`播种失败：${(e as Error)?.message || e}`);
    } finally {
      busy.value = false;
    }
  }

  // ============ P3-3 历史分时归档（为分钟级回测累积样本）============
  const archiveState = ref<{
    code: string;
    archived: string[];
    skipped: string[];
    failed: string[];
    at: number;
  } | null>(null);
  let archiving = false;
  let lastArchiveDay = ""; // YYYYMMDD：当天收盘归档完成标记，防重复

  function todayYmd(): string {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  }

  /** 单票归档（防重入，失败静默待下次补） */
  function archiveCode(c: string) {
    if (archiving) return;
    archiving = true;
    void archiveHistMinute(c, 5)
      .then((r) => {
        archiveState.value = { code: c, ...r, at: Date.now() };
      })
      .catch(() => {
        /* 单票失败不阻塞其余票；下次启动/收盘再补 */
      })
      .finally(() => {
        archiving = false;
      });
  }

  /** 对全部做T候选票归档：持仓 + 在途腿 + 当前选中票 */
  function archiveMinutes() {
    const codes = [
      ...new Set([
        ...positions.value.map((p) => p.code),
        ...Object.keys(legs.value),
        ...(selectedCode.value ? [selectedCode.value] : []),
      ]),
    ].filter(Boolean);
    for (const c of codes) archiveCode(c);
  }

  /** 交易日收盘后（15:05+）归档一次当日数据（幂等 upsert，盘中启动拉到的半日数据会被完整覆盖） */
  function maybeArchiveAfterClose() {
    const d = new Date();
    if (!isTradingDay(d)) return;
    const m = d.getHours() * 60 + d.getMinutes();
    if (m < 15 * 60 + 5) return;
    const today = todayYmd();
    if (today === lastArchiveDay) return;
    lastArchiveDay = today;
    archiveMinutes();
    // 归档完成后顺手评估当日信号质量（MFE/MAE）
    void evalSignalLog();
  }

  // ============ P3-4 信号留痕与 MFE/MAE 回灌 ============
  const signalStats = ref<SignalLogStats | null>(null);
  const signalEvalBusy = ref(false);

  // 对外强信号落痕（含未执行的；computed 依赖不变时 watch 不重复触发）
  watch(confirmedSignal, (s) => {
    if (s.action !== "long-open" && s.action !== "short-open") return;
    if (s.grade !== "strong") return;
    const now = new Date();
    recordSignal({
      code: selectedCode.value,
      date: todayYmd(),
      time: now.toTimeString().slice(0, 5),
      dir: s.action === "long-open" ? "long" : "short",
      score: s.score ?? 0,
      regime: s.regime ?? "range",
      bias: bias.value,
      biasZ: biasZ.value.z,
      price: s.price,
      stop: s.stop,
      target: s.target,
      at: now.getTime(),
    });
  });

  /** 评估历史信号质量：拉归档分钟数据 → MFE/MAE → 命中率统计 */
  async function evalSignalLog() {
    if (signalEvalBusy.value) return;
    const log = loadSignalLog();
    if (log.length === 0) return;
    signalEvalBusy.value = true;
    try {
      const codes = [...new Set(log.map((e) => e.code))];
      const days = new Map<string, { timestamp: number; high: number; low: number }[]>();
      for (const c of codes) {
        const dayData = await fetchArchivedMinuteDays(c, 10).catch(() => []);
        for (const d of dayData) {
          if (!days.has(d.date)) days.set(d.date, d.bars);
        }
      }
      signalStats.value = evaluateLog(log, days);
    } finally {
      signalEvalBusy.value = false;
    }
  }

  // ============ P3-7 盘前做T计划（9:25 竞价后生成网格表）============
  const dayPlan = ref<DayPlan | null>(null);
  let planDay = "";

  function toDayMin(msOrMin: number): number {
    if (msOrMin >= 100_000_000_000) {
      const d = new Date(msOrMin);
      return d.getHours() * 60 + d.getMinutes();
    }
    return msOrMin;
  }

  /** 生成当日计划：中枢=竞价价/昨收、区间=ATR、档位网格、不做名单 */
  function buildPlanNow() {
    const q = quote.value;
    const lv = keyLevels.value;
    const code = selectedCode.value;
    if (!q || !code) return;
    const recs = records.value ?? [];
    // 昨日及以前纪律数据（排除今日）：TRecord 无日期字段，用平仓时间判定
    const d = new Date();
    const sameDayMs = (ts: number) => {
      const cd = new Date(ts);
      return cd.getFullYear() === d.getFullYear() && cd.getMonth() === d.getMonth() && cd.getDate() === d.getDate();
    };
    const past = recs.filter((r) => !sameDayMs(r.closeTime));
    const yForced = past.filter((r) => toDayMin(r.closeTime) >= 885).length;
    // 连续亏损笔数（从最近往前数）
    const sorted = [...recs].sort((a, b) => b.closeTime - a.closeTime);
    let streakLoss = 0;
    for (const r of sorted) {
      if (r.pnl < 0) streakLoss++;
      else break;
    }
    const skips = skipReasonsOf({
      forcedCloseToday: yForced,
      streakLoss,
      atrPct: atrPct.value,
      amount5d: avgAmount5d.value,
    });
    dayPlan.value = buildDayPlan({
      code,
      name: q.name,
      date: todayYmd(),
      auctionPrice: q.open,
      prevClose: q.prevClose,
      atrPct: atrPct.value,
      supportLow: lv.supportLow,
      resistHigh: lv.resistHigh,
      baseVol: suggestVol.value || 1000,
      skipReasons: skips,
      limitUpPct: 10,
      limitDownPct: 10,
    });
    planDay = todayYmd();
  }

  /** 9:25 竞价后自动生成（当日只生成一次） */
  function maybeBuildPlanAfterAuction() {
    const d = new Date();
    if (!isTradingDay(d)) return;
    const m = d.getHours() * 60 + d.getMinutes();
    if (m < 9 * 60 + 25 || m >= 9 * 60 + 35) return; // 9:25-9:35 窗口
    if (planDay === todayYmd()) return;
    buildPlanNow();
  }

  // ============ P3 分钟级回测（引擎见 tmaker/backtest.ts，纯 TS 复用实盘信号判定）============
  const btResult = ref<BtResult | null>(null);
  const btLoading = ref(false);
  const btParams = ref<BtParams>({ ...DEFAULT_BT_PARAMS });
  /** 本地累积库覆盖交易日数（样本积累进度提示） */
  const btArchiveDays = ref(0);

  /** 数据合并：本地累积库（更长历史）+ 腾讯近 5 日（当日完整）→ 按日期去重升序；日线上下文 20 根 */
  async function loadBacktestData(code: string): Promise<{ minuteDays: HistDayMinute[]; dailyBars: KBar[] }> {
    const [local, remote, daily] = await Promise.all([
      fetchArchivedMinuteDays(code, 60).catch(() => [] as HistDayMinute[]),
      fetchHistMinuteDays(code, 5).catch(() => [] as HistDayMinute[]),
      fetchKLine(code, 101, 20).catch(() => [] as KBar[]),
    ]);
    const byDate = new Map<string, HistDayMinute>();
    // 本地更早日期为底座；腾讯近 5 日覆盖（当日完整，避免盘中半日数据污染回测）
    for (const d of local) byDate.set(d.date, d);
    for (const d of remote) byDate.set(d.date, d);
    const minuteDays = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    return { minuteDays, dailyBars: daily };
  }

  /** 跑回测：当前选中票 × 可调参数 → BtResult（含保本胜率 / vs 不做T对照） */
  async function runBacktestNow() {
    const code = selectedCode.value;
    if (!code || btLoading.value) return;
    btLoading.value = true;
    try {
      const { minuteDays, dailyBars } = await loadBacktestData(code);
      btArchiveDays.value = minuteDays.length;
      btResult.value = runBacktest(code, minuteDays, dailyBars, btParams.value);
      if (btResult.value.count === 0) {
        pushToast({
          key: `bt-empty-${Date.now()}`,
          title: "回测完成",
          body: `样本 ${btResult.value.sampleDays} 天，0 笔信号（样本不足或条件过严，建议积累历史分时后再跑）`,
          code,
          tone: "up",
          at: Date.now(),
        });
      }
    } catch (e) {
      errorMsg.value = `回测失败：${(e as Error)?.message || e}`;
    } finally {
      btLoading.value = false;
    }
  }

  // ============ P3-5 参数寻优（网格搜索 + 样本内外切分）============
  const optResult = ref<OptimizeOutcome | null>(null);
  const optLoading = ref(false);

  /** 在当前票的合并数据上跑网格寻优（默认网格 3×3×3×2=54 组，in/out 7:3 切分） */
  async function runOptimizeNow() {
    const code = selectedCode.value;
    if (!code || optLoading.value) return;
    optLoading.value = true;
    try {
      const { minuteDays, dailyBars } = await loadBacktestData(code);
      if (minuteDays.length < 4) {
        pushToast({
          key: `opt-short-${Date.now()}`,
          title: "样本不足",
          body: `仅 ${minuteDays.length} 天分时，至少 4 个交易日才能切分寻优（先积累历史分时）`,
          code,
          tone: "down",
          at: Date.now(),
        });
        return;
      }
      optResult.value = gridSearch(minuteDays, dailyBars, btParams.value, {}, { topN: 5, minOutTrades: 2 });
    } catch (e) {
      errorMsg.value = `寻优失败：${(e as Error)?.message || e}`;
    } finally {
      optLoading.value = false;
    }
  }

  /** 把某组参数应用到当前回测参数 */
  function applyOptParams(row: OptimizeRow) {
    btParams.value = { ...row.params };
    void runBacktestNow();
  }

  // ============ P3-6 盘后做T日报（Rust rfd 原生保存对话框写文件——WebView2 a.click 下载在部分环境被静默拦截）============
  async function saveDailyReportHtml(html: string, filename: string) {
    try {
      const ok = await invoke<boolean>("save_export_file", { defaultName: filename, content: html });
      flash(ok ? `日报已保存：${filename}` : "日报保存已取消");
    } catch (e) {
      // 兜底：原生对话框失败时退回 WebView2 下载
      try {
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        flash("已通过浏览器下载日报（原生对话框不可用）");
      } catch (e2) {
        flash(`日报保存失败：${(e as Error)?.message || e}`);
      }
    }
  }

  /** 生成当日做T日报（逐笔回放 + 纪律 + 信号质量 + 回测对照 + 次日参数建议） */
  function buildDailyReport() {
    const d = new Date();
    const today = todayYmd(); // YYYYMMDD（报表标题/日期用）
    const todayDash = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    // 当日成交 = 内存记录里 closeTime 落在今天的（TRecord 无日期字段，用平仓时间判定）
    const dayRecords = (records.value ?? []).filter((r) => {
      const cd = new Date(r.closeTime);
      return cd.getFullYear() === d.getFullYear() && cd.getMonth() === d.getMonth() && cd.getDate() === d.getDate();
    });
    const bt: ReportBtHint | null = btResult.value
      ? {
          count: btResult.value.count,
          winRate: btResult.value.winRate,
          breakEven: btResult.value.breakEvenWinRate,
          avgPnl: btResult.value.avgPnl,
          profitFactor: btResult.value.profitFactor,
          maxDrawdown: btResult.value.maxDrawdown,
        }
      : null;
    const best = optResult.value?.rows?.[0];
    const optHint = best
      ? `开${best.params.scoreOpen} 止${best.params.stopMinPct}% 倍${best.params.targetMult} 日${best.params.maxPerDay}（样本外 ${best.out.count} 笔/${best.out.avgPnl.toFixed(1)} 元）`
      : null;
    const html = buildTmakerReportHtml({
      date: today,
      records: dayRecords,
      signalStats: signalStats.value,
      bt,
      optHint,
    });
    void saveDailyReportHtml(html, `做T日报-${today}.html`);
  }

  // ============ 轮询治理：分级频率 + 非交易时段降频 + 页面隐藏暂停 ============
  const FAST_MS = 3000;
  const SLOW_MS = 15000;
  const IDLE_MS = 60000;
  let fastTimer: number | null = null;
  let slowTimer: number | null = null;
  let clockTimer: number | null = null;
  let scanTimer: number | null = null;
  let fastInterval = FAST_MS;
  let visible = true;

  function tuneTimers() {
    const want = isTrading() ? FAST_MS : IDLE_MS;
    if (want !== fastInterval) {
      fastInterval = want;
      if (fastTimer != null) {
        clearInterval(fastTimer);
        fastTimer = window.setInterval(fastRefresh, fastInterval);
      }
    }
  }

  function onVisibility() {
    const hidden = document.hidden;
    if (hidden) {
      visible = false;
      if (fastTimer != null) { clearInterval(fastTimer); fastTimer = null; }
      if (slowTimer != null) { clearInterval(slowTimer); slowTimer = null; }
    } else {
      visible = true;
      if (fastTimer == null) fastTimer = window.setInterval(fastRefresh, fastInterval);
      if (slowTimer == null) slowTimer = window.setInterval(slowRefresh, SLOW_MS);
      void refresh();
    }
  }

  function start() {
    if (fastTimer != null) return;
    void paper.load().finally(() => {
      archiveMinutes();
      void evalSignalLog();
    });
    void loadHistory();
    fastTimer = window.setInterval(fastRefresh, fastInterval);
    slowTimer = window.setInterval(slowRefresh, SLOW_MS);
    clockTimer = window.setInterval(() => {
      now.value = Date.now();
      tuneTimers();
      checkCloseWindowNotify();
      maybeArchiveAfterClose();
      maybeBuildPlanAfterAuction();
    }, 1000);
    scanTimer = window.setInterval(refreshScan, SCAN_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    void refreshScan();
  }
  function stop() {
    if (fastTimer != null) { clearInterval(fastTimer); fastTimer = null; }
    if (slowTimer != null) { clearInterval(slowTimer); slowTimer = null; }
    if (clockTimer != null) { clearInterval(clockTimer); clockTimer = null; }
    if (scanTimer != null) { clearInterval(scanTimer); scanTimer = null; }
    document.removeEventListener("visibilitychange", onVisibility);
  }

  // 首次有持仓时自动选中：优先恢复上次选中的标的（仍在持仓中），否则取持仓第一只
  watch(
    () => positions.value.length,
    () => {
      if (positions.value.length === 0 || selectedCode.value) return;
      let remembered = "";
      try { remembered = localStorage.getItem(SELECTED_KEY) || ""; } catch { /* 忽略 */ }
      const hit = remembered ? positions.value.find((p) => p.code === remembered) : undefined;
      select(hit ? hit.code : positions.value[0].code);
    },
    { immediate: true },
  );

  onUnmounted(stop);

  return {
    // 状态
    selectedCode, quote, minute, currentMinute, orderBook, trades, depthEnhance, daily, marketPct,
    loading, loadFailed, errorMsg, now, positions, currentPos,
    // 指标
    costPrice, vwap, bias, keyLevels, avgMap, suggestVol, minSpread, estRoundTripFeePct,
    canT, signal, confirmedSignal,
    // P1 特征与风控
    regime, biasZ, vwapSlope5, sideStreak, minuteR2v, bookImb, spreadPct, actNet,
    relStrength, atrPct, clusters, riskAmt, stopPct, targetPct, avgAmount5d,
    dailyLossBlocked, losingStreakBlocked,
    // P2 执行
    stale, staleSec, preview, opponentPrice, gridPlanNow, gridDir,
    scanCandidates, bestCandidate, scanUpdatedAt,
    history, historyStats, loadHistory,
    // 做T
    legs, leg, currentLegs, records, currentRecords, todayStats, totalOpenPnl,
    busy, toast, legacyUnclosed, dismissLegacy,
    // P3-3 归档
    archiveState,
    // P3 回测
    btResult, btLoading, btParams, btArchiveDays, runBacktestNow,
    // P3-4 信号质量
    signalStats, evalSignalLog,
    // P3-5 参数寻优
    optResult, optLoading, runOptimizeNow, applyOptParams,
    // P3-6 盘后日报
    buildDailyReport,
    // P3-7 盘前计划
    dayPlan, buildPlanNow,
    // 方法
    select, refresh, retryLoad, start, stop, executeSignal, executeGrid, closeAllLegs,
    distPct, seedTestPosition,
  };
}
