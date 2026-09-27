// 触发门禁纯函数：静默时段 / 频率 / 冷却
import type { AlertRuleV2 } from "./types";
import { inQuietRange } from "../utils/sessions";

export interface GateState {
  /** ruleId -> 上次触发 ms（冷却用） */
  cooldowns: Map<string, number>;
  /** ruleId -> 当日已触发（daily/once 用），键 `${ruleId}:${yyyy-mm-dd}` */
  firedMarks: Map<string, boolean>;
}

export function newGateState(): GateState {
  return { cooldowns: new Map(), firedMarks: new Map() };
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export interface GateInput {
  rule: AlertRuleV2;
  now: number;
  state: GateState;
}

export interface GateResult {
  pass: boolean;
  reason?: "quiet" | "cooldown" | "frequency";
}

/**
 * 三道闸：静默时段 → 冷却 → 频率（once/daily）。
 * 通过后须调用 {@link markFired} 记录状态。
 */
export function checkGate({ rule, now, state }: GateInput): GateResult {
  const d = new Date(now);
  if (inQuietRange(rule.quiet, d)) return { pass: false, reason: "quiet" };

  const last = state.cooldowns.get(rule.id) ?? 0;
  if (now - last < rule.cooldownSec * 1000)
    return { pass: false, reason: "cooldown" };

  if (rule.frequency !== "persistent") {
    const k = `${rule.id}:${dayKey(d)}`;
    if (state.firedMarks.get(k)) return { pass: false, reason: "frequency" };
  }
  return { pass: true };
}

/** 触发成功后更新门禁状态 */
export function markGateFired(state: GateState, ruleId: string, now: number): void {
  state.cooldowns.set(ruleId, now);
  const d = new Date(now);
  state.firedMarks.set(`${ruleId}:${dayKey(d)}`, true);
}
