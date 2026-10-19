// P2-a 下单耗时埋点（纯前端 localStorage 环形 20 条）：
// 只记录「确认下单 → broker 返回」的整体耗时与点击数，作为作战台体验指标；
// 不参与任何下单 / 风控判断，读写失败一律静默降级，绝不影响下单主流程。

/** 单笔下单耗时样本。 */
export interface OrderTiming {
  /** 从点击「确认」到 broker 返回的毫秒数。 */
  ms: number;
  /** 本次下单的人工点击数（触发后确认 = 2）。 */
  clicks: number;
  /** broker 是否成功返回委托。 */
  ok: boolean;
  /** 记录时间（毫秒时间戳）。 */
  at: number;
}

/** 作战台头部展示用的汇总（近 20 笔）。 */
export interface OrderTimingSummary {
  /** 最近一笔耗时。 */
  lastMs: number;
  /** 近 N 笔（最多 20）耗时中位数。 */
  medianMs: number;
  /** 最近一笔的点击数。 */
  clicks: number;
  /** 已记录的样本数（最多 20）。 */
  count: number;
}

export const ORDER_TIMING_KEY = "tickgold_order_timing";
export const ORDER_TIMING_MAX = 20;

/** localStorage 可能不存在（Node 单测 / 隐私模式）或访问即抛错，统一走这里。 */
function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function isTiming(v: unknown): v is OrderTiming {
  if (!v || typeof v !== "object") return false;
  const t = v as Partial<OrderTiming>;
  return (
    Number.isFinite(t.ms) &&
    (t.ms as number) >= 0 &&
    Number.isFinite(t.clicks) &&
    (t.clicks as number) >= 1 &&
    typeof t.ok === "boolean" &&
    Number.isFinite(t.at)
  );
}

/** 读取环形缓冲（按写入顺序旧→新，最多 20 条）；损坏 / 越界数据直接丢弃。 */
function readAll(): OrderTiming[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(ORDER_TIMING_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTiming).slice(-ORDER_TIMING_MAX);
  } catch {
    return [];
  }
}

/**
 * 记录一笔下单耗时；追加到环形缓冲并只保留最近 20 条。
 * ms / clicks 非法时不记录；at 缺省取当前时间。
 */
export function recordOrderTiming(input: {
  ms: number;
  clicks: number;
  ok: boolean;
  at?: number;
}): void {
  if (!input || !Number.isFinite(input.ms) || input.ms < 0) return;
  if (!Number.isFinite(input.clicks) || input.clicks < 1) return;
  const record: OrderTiming = {
    ms: Math.round(input.ms),
    clicks: Math.max(1, Math.round(input.clicks)),
    ok: input.ok === true,
    at: Number.isFinite(input.at) ? (input.at as number) : Date.now(),
  };
  const s = storage();
  if (!s) return;
  try {
    const list = [...readAll(), record].slice(-ORDER_TIMING_MAX);
    s.setItem(ORDER_TIMING_KEY, JSON.stringify(list));
  } catch {
    /* 配额 / 隐私模式：埋点失败不影响下单 */
  }
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 汇总最近样本；没有任何记录时返回 null（作战台据此隐藏耗时）。 */
export function orderTimingSummary(): OrderTimingSummary | null {
  const list = readAll();
  if (!list.length) return null;
  const last = list[list.length - 1];
  return {
    lastMs: last.ms,
    medianMs: median(list.map((t) => t.ms)),
    clicks: last.clicks,
    count: list.length,
  };
}

/** 毫秒格式化：`1.2s` / `850ms`；非法值返回 `—`。 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 清空耗时记录（单测 / 重置用）。 */
export function clearOrderTimings(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(ORDER_TIMING_KEY);
  } catch {
    /* 静默降级 */
  }
}
