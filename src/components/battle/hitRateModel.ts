// 作战台头部命中率文案（纯函数，node 可测）。
// 百分比口径由后端 ai::hitrate 计算；前端只做空值/小样本降级与文案拼装。
//
// 展示规则（spec §四）：
// - 无数据 / 样本 < 3 笔成交 → 「样本不足」，完整计数放进 title 供悬停查看；
// - 有样本 → `近20日 触发 x% · 执行 y% · 胜率 z%`。

/** `workflow_hit_rate` 返回结构（字段可能缺省：旧后端 / e2e fake）。 */
export interface HitRate {
  days?: number;
  plans?: number;
  instructions?: number;
  triggered?: number;
  triggeredPct?: number | null;
  executed?: number;
  executedPct?: number | null;
  wins?: number;
  winPct?: number | null;
  samples?: number;
}

export interface HitRateText {
  /** 头部单行文案。 */
  text: string;
  /** 悬停明细：计划/指令/触发/执行/成交计数与口径说明。 */
  title: string;
}

/** 低于该成交样本数不出百分比，避免 1 笔盈利就显示 100%。 */
export const MIN_HIT_SAMPLES = 3;
export const DEFAULT_HIT_DAYS = 20;

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function pctNum(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

/** 命中率 → 头部文案 + 悬停明细；null / 小样本降级为「样本不足」但仍保留计数。 */
export function formatHitRate(hit: HitRate | null | undefined): HitRateText {
  const days = num(hit?.days) > 0 ? Math.round(num(hit?.days)) : DEFAULT_HIT_DAYS;
  const plans = num(hit?.plans);
  const instructions = num(hit?.instructions);
  const triggered = num(hit?.triggered);
  const executed = num(hit?.executed);
  const samples = num(hit?.samples);
  const wins = num(hit?.wins);
  const triggeredPct = pctNum(hit?.triggeredPct);
  const executedPct = pctNum(hit?.executedPct);
  const winPct = pctNum(hit?.winPct);

  const counts =
    `计划 ${plans} 个 · 指令 ${instructions} 条 · 触发 ${triggered} 条 · ` +
    `执行 ${executed} 条 · 成交 ${samples} 笔 · 盈利 ${wins} 笔`;
  const title = `近${days}日 ${counts}（胜率按成交后现价浮盈口径）`;

  // 无返回 / 无成交样本 / 百分比缺失：一律不出数字，避免小样本误导。
  const insufficient =
    !hit ||
    samples < MIN_HIT_SAMPLES ||
    triggeredPct === null ||
    executedPct === null ||
    winPct === null;
  if (insufficient) {
    return { text: "样本不足", title: `${title}（成交样本不足 ${MIN_HIT_SAMPLES} 笔，暂不展示百分比）` };
  }
  return {
    text: `近${days}日 触发 ${triggeredPct}% · 执行 ${executedPct}% · 胜率 ${winPct}%`,
    title,
  };
}
