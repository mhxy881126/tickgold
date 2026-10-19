// 作战台时段模型：纯函数、按 Asia/Shanghai 计算，便于单测与回放。
export type PhaseId = "premarket" | "auction" | "open" | "midday" | "close" | "post" | "closed";

export interface PhaseDef {
  id: PhaseId;
  label: string;
  color: string;
  headline: string;
  checklist: string[];
}

export const CLOSED_PHASE: PhaseDef = {
  id: "closed",
  label: "休市",
  color: "#5d6670",
  headline: "非交易日，下一交易日再战",
  checklist: ["复盘上一交易日", "维护自选与题材", "检查明日作战卡"],
};

export const PHASES: PhaseDef[] = [
  {
    id: "premarket", label: "盘前", color: "#6aa6e8", headline: "确认今日作战卡",
    checklist: ["看昨日复盘结论", "核对作战卡前 3 条", "确认仓位与风控档位"],
  },
  {
    id: "auction", label: "集合竞价", color: "#e8c878", headline: "盯竞价，定开盘动作",
    checklist: ["09:20 后不可撤单", "计划股竞价强弱", "低开破位则放弃"],
  },
  {
    id: "open", label: "开盘", color: "#ff6b78", headline: "主战场：只打计划内的票",
    checklist: ["首波 5 分钟看承接", "触发计划再出手", "亏损单不加仓"],
  },
  {
    id: "midday", label: "盘中", color: "#2fbf95", headline: "管持仓，等新机会",
    checklist: ["持仓止损优先", "新开仓只做计划内", "午后缩量不追高"],
  },
  {
    id: "close", label: "尾盘", color: "#e89c3d", headline: "去弱留强，决定过夜",
    checklist: ["尾盘强度排序", "弱票减仓", "确定明日持仓"],
  },
  {
    id: "post", label: "盘后", color: "#8b97a8", headline: "复盘 + 生成明日作战卡",
    checklist: ["跑盘后流水线", "核对今日成交", "确认明日计划"],
  },
];

export interface PhaseState {
  phase: PhaseDef;
  progress: number;
  nextLabel: string;
  nextInSec: number;
  subLabel: string | null;
  weekend: boolean;
  minutes: number;
}

const B = {
  pre: 8 * 60 + 30,
  auction: 9 * 60 + 15,
  open: 9 * 60 + 30,
  midday: 10 * 60,
  close: 14 * 60 + 30,
  post: 15 * 60,
};

export function beijingClock(d: Date): { weekday: number; minutes: number; seconds: number } {
  const bj = new Date(d.getTime() + 8 * 3600_000);
  return {
    weekday: bj.getUTCDay(),
    minutes: bj.getUTCHours() * 60 + bj.getUTCMinutes(),
    seconds: bj.getUTCSeconds(),
  };
}

function phaseAt(m: number): PhaseDef {
  if (m >= B.pre && m < B.auction) return PHASES[0]!;
  if (m >= B.auction && m < B.open) return PHASES[1]!;
  if (m >= B.open && m < B.midday) return PHASES[2]!;
  if (m >= B.midday && m < B.close) return PHASES[3]!;
  if (m >= B.close && m < B.post) return PHASES[4]!;
  return PHASES[5]!;
}

function phaseRange(id: PhaseId): [number, number] {
  switch (id) {
    case "premarket": return [B.pre, B.auction];
    case "auction": return [B.auction, B.open];
    case "open": return [B.open, B.midday];
    case "midday": return [B.midday, B.close];
    case "close": return [B.close, B.post];
    default: return [B.post, B.post];
  }
}

function nextBoundary(m: number): { label: string; target: number; plusDay: boolean } {
  if (m < B.pre) return { label: "盘前", target: B.pre, plusDay: false };
  if (m < B.auction) return { label: "集合竞价", target: B.auction, plusDay: false };
  if (m < B.open) return { label: "开盘", target: B.open, plusDay: false };
  if (m < B.midday) return { label: "盘中", target: B.midday, plusDay: false };
  if (m < B.close) return { label: "尾盘", target: B.close, plusDay: false };
  if (m < B.post) return { label: "盘后", target: B.post, plusDay: false };
  return { label: "盘前", target: B.pre, plusDay: true };
}

function subLabelAt(id: PhaseId, m: number): string | null {
  if (id === "auction") return m < 9 * 60 + 20 ? "可撤单" : "不可撤单";
  if (id === "open") {
    if (m < 9 * 60 + 35) return "首波";
    if (m < 9 * 60 + 45) return "承接";
    return "分歧";
  }
  return null;
}

export const TIMELINE_SEGMENTS: { id: PhaseId; label: string; grow: number; color: string }[] = [
  { id: "premarket", label: "盘前", grow: 14, color: "#6aa6e8" },
  { id: "auction", label: "竞价", grow: 15, color: "#e8c878" },
  { id: "open", label: "开盘", grow: 31, color: "#ff6b78" },
  { id: "midday", label: "盘中", grow: 20, color: "#2fbf95" },
  { id: "close", label: "尾盘", grow: 10, color: "#e89c3d" },
  { id: "post", label: "盘后", grow: 10, color: "#8b97a8" },
];

export function mmss(sec: number): string {
  const m = Math.floor(Math.max(0, sec) / 60);
  const s = Math.max(0, sec) % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function computePhase(now: Date): PhaseState {
  const { weekday, minutes, seconds } = beijingClock(now);
  const weekend = weekday === 0 || weekday === 6;
  if (weekend) {
    return { phase: CLOSED_PHASE, progress: 0, nextLabel: "下一交易日", nextInSec: 0, subLabel: null, weekend, minutes };
  }
  const phase = phaseAt(minutes);
  const nb = nextBoundary(minutes);
  const diffMin = nb.plusDay ? 24 * 60 - minutes + nb.target : nb.target - minutes;
  const nextInSec = Math.max(0, diffMin * 60 - seconds);
  let progress = 0;
  if (phase.id !== "post") {
    const [start, end] = phaseRange(phase.id);
    progress = Math.min(1, Math.max(0, (minutes - start) / Math.max(1, end - start)));
  }
  return { phase, progress, nextLabel: nb.label, nextInSec, subLabel: subLabelAt(phase.id, minutes), weekend, minutes };
}
