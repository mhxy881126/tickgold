// P6 一键智驾模式：前端 API 封装与类型（对接后端 ai::pilot 6 个 Tauri 命令）。
// 智驾 = 模拟盘全自动：一键开始后由后端排程器按触发点自动完成 采集→分析→计划→确认→盯盘→执行→收盘回灌。
// 安全红线在后端（仅模拟盘 / 非急停），前端只负责展示与触发。

import { invoke } from "@tauri-apps/api/core";

/** 当日智驾运行日志（pilot_daily_log 单日行） */
export interface PilotToday {
  scanCount: number;
  buyCount: number;
  sellCount: number;
  /** 已实现盈亏（分） */
  pnlCents: number;
  /** 当前资产（分） */
  assetCents: number;
  /** 收盘小结（回灌 conclusion） */
  summary: string;
}

/** pilot_status 完整状态 */
export interface PilotStatus {
  mode: "off" | "paused" | "running";
  accountType: string;
  /** 虚拟资金（元） */
  virtualCash: number;
  /** 战法模板 id（0 = 默认六战法） */
  tacticProfileId: number;
  /** 风控档位：steady / aggressive / defensive */
  riskProfile: "steady" | "aggressive" | "defensive";
  scheduleEnabled: boolean;
  /** 每日扫描目标次数（默认 15） */
  todayScanTarget: number;
  /** 今日已扫描次数 */
  todayScanCount: number;
  lastScanAt: number;
  running: boolean;
  /** 下一次触发点（当日分钟数 570..930；收盘结算为 930；无则为 null） */
  nextScanMinute: number | null;
  tradeDate: string;
  updatedAt: number;
  today: PilotToday;
}

/** pilot_config_set 可写字段（后端仅 mode=off 允许写入） */
export interface PilotConfigPatch {
  riskProfile?: "steady" | "aggressive" | "defensive";
  virtualCash?: number;
  tacticProfileId?: number;
  scheduleEnabled?: boolean;
  todayScanTarget?: number;
}

export const RISK_PROFILE_META: Record<
  PilotStatus["riskProfile"],
  { label: string; desc: string }
> = {
  steady: { label: "稳健", desc: "硬止损 -7% · 总仓 80% · 日亏 5% · 回撤 20%" },
  aggressive: { label: "进取", desc: "硬止损 -8% · 总仓 90% · 日亏 6% · 回撤 25%" },
  defensive: { label: "保守", desc: "硬止损 -4% · 总仓 60% · 日亏 3% · 回撤 12%" },
};

export function pilotStart(): Promise<PilotStatus> {
  return invoke<PilotStatus>("pilot_start");
}
export function pilotPause(): Promise<PilotStatus> {
  return invoke<PilotStatus>("pilot_pause");
}
export function pilotStop(): Promise<PilotStatus> {
  return invoke<PilotStatus>("pilot_stop");
}
export function pilotStatus(): Promise<PilotStatus> {
  return invoke<PilotStatus>("pilot_status");
}
export function pilotConfigGet(): Promise<PilotStatus> {
  return invoke<PilotStatus>("pilot_config_get");
}
export function pilotConfigSet(patch: PilotConfigPatch): Promise<PilotStatus> {
  return invoke<PilotStatus>("pilot_config_set", {
    riskProfile: patch.riskProfile,
    virtualCash: patch.virtualCash,
    tacticProfileId: patch.tacticProfileId,
    scheduleEnabled: patch.scheduleEnabled,
    todayScanTarget: patch.todayScanTarget,
  });
}

/** 分钟数 → "HH:MM"（570 → 09:30；930 → 15:30） */
export function minuteToHm(minute: number | null): string {
  if (minute == null) return "—";
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}`;
}
