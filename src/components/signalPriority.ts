// 信号优先级：纯函数，供信号桥徽标与默认排序共用（阈值只定义一处，避免 UI 与排序打架）。
// 只读 SignalTicketInfo，不引入任何运行时依赖，便于 Node 单测。
import type { SignalTicketInfo } from "../ai/api";

export type PriorityTone = "high" | "mid" | "low";

export interface SignalPriority {
  label: "高" | "中" | "低";
  tone: PriorityTone;
}

/** 置信度 → 高/中/低（≥80% 高、≥60% 中、其余低；非法值按低处理）。 */
export function priorityOf(confidence: number): SignalPriority {
  const c = Number.isFinite(confidence) ? confidence : 0;
  if (c >= 0.8) return { label: "高", tone: "high" };
  if (c >= 0.6) return { label: "中", tone: "mid" };
  return { label: "低", tone: "low" };
}

/**
 * 信号桥默认排序：待确认优先 → 置信度降序 → 时间降序。
 * 返回新数组，不修改入参；同置信度同时间时保持原有顺序（Array#sort 稳定）。
 */
export function sortTickets(tickets: SignalTicketInfo[]): SignalTicketInfo[] {
  const pendingRank = (t: SignalTicketInfo) => (t.status === "pending" ? 0 : 1);
  const confidence = (t: SignalTicketInfo) =>
    Number.isFinite(t.confidence) ? t.confidence : 0;
  const createdAt = (t: SignalTicketInfo) =>
    Number.isFinite(t.createdAt) ? t.createdAt : 0;

  return [...tickets].sort((a, b) => {
    const rank = pendingRank(a) - pendingRank(b);
    if (rank !== 0) return rank;
    const byConfidence = confidence(b) - confidence(a);
    if (byConfidence !== 0) return byConfidence;
    return createdAt(b) - createdAt(a);
  });
}
