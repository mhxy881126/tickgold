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

// ===== v2.1 快脑 / 自动执行 / 决策日志 =====
export interface AutoExecConfigInfo {
  enabled: boolean;
  brainMode: string;
  layaUrl: string;
  hardStopPct: number;
  execConfidence: number;
  watchConfidence: number;
  slippagePct: number;
  maxSinglePct: number;
  maxTotalPct: number;
  noOpenAfter: string;
  bridgeEnabled: boolean;
  bridgeDefaultBroker: string;
  bridgeBrokerPath: string;
  bridgeDefaultAction: string;
  bridgeTtlMinutes: number;
  bridgePriceDeviatePct: number;
  bridgeOrderTemplate: string;
}

export interface DecisionLogInfo {
  id: number;
  tradeDate: string;
  ts: string;
  code: string;
  name: string;
  strategy: string;
  instrId: number | null;
  label: string;
  confidence: number;
  probs: Record<string, number>;
  features: Record<string, unknown>;
  mode: string;
  action: string;
  modelVersion: string;
  inferMs: number;
  createdAt: number;
}

export function autoexecGetConfig() {
  return invoke<AutoExecConfigInfo>("autoexec_get_config");
}

export function autoexecStart(cfg: AutoExecConfigInfo) {
  return invoke<void>("autoexec_start", { cfg });
}

export function autoexecStop() {
  return invoke<void>("autoexec_stop");
}

export function autoexecSetConfig(cfg: AutoExecConfigInfo) {
  return invoke<void>("autoexec_set_config", { cfg });
}

export function layaHealth(url: string) {
  return invoke<number>("laya_health", { url });
}

export function listDecisionLogs(date?: string | null, limit?: number) {
  return invoke<DecisionLogInfo[]>("list_decision_logs", {
    date: date ?? null,
    limit: limit ?? null,
  });
}

// ===== v2.2 回灌进化 =====
export interface EvolutionConfigInfo {
  stopPct: number;
  targetPct: number;
  horizon: number;
  includeWatch: boolean;
}

export interface LabelRunResult {
  total: number;
  labeled: number;
  insufficient: number;
  codes: number;
  stopPct: number;
  targetPct: number;
  horizon: number;
  ranAt: number;
}

export interface TradeLabelInfo {
  id: number;
  decisionId: number;
  tradeDate: string;
  code: string;
  name: string;
  decisionLabel: string;
  modelVersion: string;
  strategy: string;
  entryPrice: number;
  ret1d: number | null;
  ret2d: number | null;
  ret3d: number | null;
  ret5d: number | null;
  maxGain: number;
  maxPain: number;
  hitStop: boolean;
  hitTarget: boolean;
  horizonDays: number;
  verdict: string;
  missType: string;
  checkedAt: number;
  confidence: number;
  ts: string;
  action: string;
}

export interface EvolutionGroupInfo {
  modelVersion: string;
  strategy: string;
  samples: number;
  good: number;
  bad: number;
  neutral: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;
  expectancy: number;
  avgRet: number;
  hitStop: number;
  hitTarget: number;
  falsePositive: number;
  sellTooEarly: number;
}

export interface EvolutionStatsInfo {
  groups: EvolutionGroupInfo[];
  totalLabels: number;
  generatedAt: number;
  note: string;
}

export interface EvolutionDataCheckInfo {
  totalDecisions: number;
  totalLabels: number;
  missingLabelStale: number;
  horizonZero: number;
  orphanLabels: number;
  missingModelRegistry: number;
  issues: number;
  cleanup: boolean;
  keepDays: number;
  deletedOrphan: number;
  deletedOldLabels: number;
  deletedOldDecisions: number;
  checkedAt: number;
}

export function evolutionRunLabeling(config?: EvolutionConfigInfo | null, force = false) {
  return invoke<LabelRunResult>("evolution_run_labeling", {
    config: config ?? null,
    force,
  });
}

export function evolutionListLabels(verdict?: string | null, limit?: number) {
  return invoke<TradeLabelInfo[]>("evolution_list_labels", {
    verdict: verdict ?? null,
    limit: limit ?? null,
  });
}

export function evolutionStats() {
  return invoke<EvolutionStatsInfo>("evolution_stats");
}

export function evolutionDataCheck(cleanup = false, keepDays?: number) {
  return invoke<EvolutionDataCheckInfo>("evolution_data_check", {
    cleanup,
    keepDays: keepDays ?? null,
  });
}

// ===== v2.3 信号人工确认桥 =====
export interface SignalTicketInfo {
  id: number;
  sigId: string;
  tradeDate: string;
  createdAt: number;
  code: string;
  name: string;
  side: string;
  source: string;
  modelVersion: string;
  strategy: string;
  confidence: number;
  refPrice: number;
  price: number;
  vol: number;
  amount: number;
  reason: string;
  status: string;
  actionKind: string;
  broker: string;
  orderText: string;
  decidedBy: string;
  decidedAt: number;
}

export interface SignalConfirmResult {
  id: number;
  sigId: string;
  orderText: string;
  price: number;
  vol: number;
  amount: number;
  actionKind: string;
  broker: string;
}

export function signalList(status?: string | null, limit?: number) {
  return invoke<SignalTicketInfo[]>("signal_list", {
    status: status ?? null,
    limit: limit ?? null,
  });
}

export function signalConfirm(
  id: number,
  opts: {
    price?: number | null;
    vol?: number | null;
    actionKind?: string | null;
    broker?: string | null;
    orderTemplate?: string | null;
  },
) {
  return invoke<SignalConfirmResult>("signal_confirm", {
    id,
    price: opts.price ?? null,
    vol: opts.vol ?? null,
    actionKind: opts.actionKind ?? null,
    broker: opts.broker ?? null,
    orderTemplate: opts.orderTemplate ?? null,
  });
}

export function signalReject(id: number, reason?: string) {
  return invoke<void>("signal_reject", { id, reason: reason ?? null });
}

export function signalDone(id: number) {
  return invoke<void>("signal_done", { id });
}

export function signalExpire(ttlMinutes?: number) {
  return invoke<number>("signal_expire", { ttlMinutes: ttlMinutes ?? null });
}

export function signalCreateManual(
  code: string,
  name: string,
  side: string,
  price?: number,
  vol?: number,
  reason?: string,
) {
  return invoke<string>("signal_create_manual", {
    code,
    name,
    side,
    price: price ?? null,
    vol: vol ?? null,
    reason: reason ?? null,
  });
}

export function signalLaunchBroker(path: string) {
  return invoke<void>("signal_launch_broker", { path });
}

export function signalPreviewOrder(
  side: string,
  code: string,
  name: string,
  price: number,
  vol: number,
  broker?: string,
  template?: string,
) {
  return invoke<string>("signal_preview_order", {
    side,
    code,
    name,
    price,
    vol,
    broker: broker ?? null,
    template: template ?? null,
  });
}
