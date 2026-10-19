// P2-a 对账常驻 chip 的纯逻辑：把 `broker_recon_status` / `broker:recon` 归一到
// 一句可点击的状态文案。抽成纯函数便于 Node 单测，组件只负责取数与跳转。
import type { ReconReport, ReconStatus } from "./api";

export type ReconChipTone = "ok" | "bad" | "muted";

export interface ReconChip {
  /** 展示文案，如「对账正常 · 3 分钟前」。 */
  label: string;
  /** ok=绿 / bad=红 / muted=灰。 */
  tone: ReconChipTone;
  /** 报告是否已超过 30 分钟（过期后不再给出「正常」结论）。 */
  stale: boolean;
}

/** 超过 30 分钟未对账视为过期，避免旧结论误导。 */
export const RECON_STALE_MS = 30 * 60 * 1000;
export const RECON_LABEL_NONE = "未对账";
export const RECON_LABEL_OK = "对账正常";
export const RECON_LABEL_BAD = "账实不符";
export const RECON_LABEL_STALE = "对账已过期";

/** 后端/旧前端可能给 `{}`（空报告）或字段缺失，一律按「无报告」处理。 */
function validReport(report: ReconReport | null | undefined): ReconReport | null {
  if (!report || typeof report !== "object") return null;
  if (typeof report.matched !== "boolean" || !Number.isFinite(report.at)) return null;
  return report;
}

function isStale(report: ReconReport | null, now: number): boolean {
  return !!report && now - report.at > RECON_STALE_MS;
}

/**
 * 对账 chip 文案：
 * 1. 后端仍有冲突标记 → 「账实不符」（即使报告缺失，也不能显示正常）；
 * 2. 无有效报告 → 「未对账」；
 * 3. 报告未匹配 → 「账实不符」；
 * 4. 报告超过 30 分钟 → 「对账已过期」；
 * 5. 匹配 → 「对账正常 · N 分钟前」（不足 1 分钟显示「刚刚」）。
 */
export function reconChip(status: ReconStatus | null | undefined, now: number): ReconChip {
  const report = validReport(status?.report);
  const ts = Number.isFinite(now) ? now : Date.now();

  if (status?.conflict === true) {
    return { label: RECON_LABEL_BAD, tone: "bad", stale: isStale(report, ts) };
  }
  if (!report) {
    return { label: RECON_LABEL_NONE, tone: "muted", stale: false };
  }
  if (!report.matched) {
    return { label: RECON_LABEL_BAD, tone: "bad", stale: isStale(report, ts) };
  }
  if (isStale(report, ts)) {
    return { label: RECON_LABEL_STALE, tone: "muted", stale: true };
  }
  const mins = Math.max(0, Math.floor((ts - report.at) / 60_000));
  const ago = mins <= 0 ? "刚刚" : `${mins} 分钟前`;
  return { label: `${RECON_LABEL_OK} · ${ago}`, tone: "ok", stale: false };
}
