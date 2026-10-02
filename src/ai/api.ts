// AI 命令封装（风格对齐 src/api/kb.ts）。
import { invoke } from "@tauri-apps/api/core";
import type { AiConfig, ConnTest, KbStats, MessageInfo, SessionInfo } from "./types";

export function getAiConfig(): Promise<AiConfig> {
  return invoke<AiConfig>("ai_get_config");
}

export function saveAiConfig(cfg: AiConfig): Promise<void> {
  return invoke("ai_save_config", { cfg });
}

export function getCloudKeySet(): Promise<boolean> {
  return invoke<boolean>("ai_get_cloud_key_set");
}

export function setCloudKey(secret: string): Promise<void> {
  return invoke("ai_set_cloud_key", { secret });
}

export function clearCloudKey(): Promise<void> {
  return invoke("ai_clear_cloud_key");
}

export function testConnection(): Promise<ConnTest> {
  return invoke<ConnTest>("ai_test_connection");
}

export function newSession(): Promise<number> {
  return invoke<number>("ai_new_session");
}

export function listSessions(): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>("ai_list_sessions");
}

export function loadSession(sessionId: number): Promise<MessageInfo[]> {
  return invoke<MessageInfo[]>("ai_load_session", { sessionId });
}

export function deleteSession(sessionId: number): Promise<void> {
  return invoke("ai_delete_session", { sessionId });
}

export function chatSend(sessionId: number, text: string): Promise<void> {
  return invoke("ai_chat_send", { sessionId, text });
}

export function chatAbort(sessionId: number): Promise<void> {
  return invoke("ai_chat_abort", { sessionId });
}

export function kbStats(): Promise<KbStats> {
  return invoke<KbStats>("ai_kb_stats");
}

export function listDocs(): Promise<Array<[string, number]>> {
  return invoke<Array<[string, number]>>("ai_list_docs");
}

/** 弹出原生多选框导入 md/txt；返回实际产生新分块的文件名。 */
export function importDocs(): Promise<string[]> {
  return invoke<string[]>("ai_import_docs");
}

export function deleteDoc(fileName: string): Promise<number> {
  return invoke<number>("ai_delete_doc", { fileName });
}

export function reindex(): Promise<number> {
  return invoke<number>("ai_reindex");
}

export function indexDaily(tradeDate: string): Promise<number> {
  return invoke<number>("ai_index_daily", { tradeDate });
}

// ===== v2.0 决策 / 复盘 / 计划 =====
// ReviewSummary 为 Rust struct 直接序列化，字段为 snake_case；Plan / ReviewDetail 为 json! 构造，camelCase。
export interface ReviewSummaryInfo {
  id: number;
  trade_date: string;
  scope: string;
  subject: string;
  title: string;
  summary: string;
  reused: boolean;
}

export interface ReviewDetailInfo {
  id: number;
  tradeDate: string;
  scope: string;
  subject: string;
  title: string;
  summary: string;
  content: string;
  evidence: string;
  model: string;
  createdAt: number;
}

export interface PlanInstructionInfo {
  id: number;
  tier: string;
  code: string;
  name: string;
  theme: string;
  condition: string;
  action: string;
  positionHint: string;
  alertRule: string;
  status: string;
  sort: number;
}

export interface PlanInfo {
  id: number;
  planDate: string;
  title: string;
  marketView: string;
  status: string;
  profileKey: string;
  sourceReviewDate: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  instructions: PlanInstructionInfo[];
}

export function buildDecisionPack(date?: string | null) {
  return invoke<Record<string, unknown>>("ai_build_decision_pack", { date: date ?? null });
}

export function runReview(date?: string | null, force = false) {
  return invoke<ReviewSummaryInfo[]>("ai_run_review", { date: date ?? null, force });
}

export function listReviews(date: string) {
  return invoke<ReviewSummaryInfo[]>("ai_list_reviews", { date });
}

export function getReview(id: number) {
  return invoke<ReviewDetailInfo>("ai_get_review", { id });
}

export function generatePlan(profileKey?: string | null, reviewDate?: string | null) {
  return invoke<PlanInfo>("ai_generate_plan", {
    profileKey: profileKey ?? null,
    reviewDate: reviewDate ?? null,
  });
}

export function getLatestPlan() {
  return invoke<PlanInfo>("ai_get_latest_plan");
}

export function getPlan(id: number) {
  return invoke<PlanInfo>("ai_get_plan", { id });
}

export function setPlanStatus(id: number, status: string) {
  return invoke<void>("ai_set_plan_status", { id, status });
}

export function updatePlanText(id: number, field: string, value: string) {
  return invoke<void>("ai_update_plan_text", { id, field, value });
}

export function updateInstruction(instrId: number, field: string, value: string) {
  return invoke<void>("ai_update_instruction", { instrId, field, value });
}

export function convertInstructionAlert(instrId: number) {
  return invoke<string>("ai_convert_instruction_alert", { instrId });
}
