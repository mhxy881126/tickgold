// 券商对接前端 API：封装 broker_* 命令。类型与 Rust 侧 BrokerOrderInfo / 状态字段一一对应。
import { invoke } from "@tauri-apps/api/core";

export interface BrokerStatus {
  kind: string;
  liveEnabled: boolean;
  connected: boolean;
  killSwitch: boolean;
  accountId: string;
}

export interface BrokerOrderInfo {
  id: number;
  sigId: string;
  brokerKind: string;
  brokerAccount: string;
  brokerOrderId: string;
  code: string;
  side: string;
  price: number;
  vol: number;
  status: string;
  filledVol: number;
  filledAvgPrice: number;
  errorMsg: string;
  createdAt: number;
  updatedAt: number;
}

export interface BrokerAsset {
  cash?: number;
  marketValue?: number;
  totalAsset?: number;
  floatPnl?: number; // 浮动盈亏
  dayPnl?: number; // 当日参考盈亏
  note?: string;
}

export interface BrokerPosition {
  code: string;
  name?: string;
  vol: number;
  avail: number;
  cost?: number;
  marketValue?: number;
}

export interface BrokerConfigPatch {
  kind?: string;
  pythonPath?: string;
  qmtPath?: string;
  accountId?: string;
  maxSinglePct?: number;
  maxTotalPct?: number;
  noOpenAfter?: string;
  feePct?: number;
  mockAllowAnytime?: boolean;
  mockInitCash?: number;
  // v3.0.0-rc 账户级风控阈值 / 实盘限额
  dailyLossLimitPct?: number;
  maxDrawdownLimitPct?: number;
  consecutiveLossLimit?: number;
  liveMaxOrderAmount?: number;
  // P3 客户端自动化通道（同花顺模拟）
  clientVendor?: string;
  clientSim?: boolean;
  clientPath?: string;
  clientTemplateDir?: string;
  clientAutoConfirm?: boolean;
  clientMinIntervalMs?: number;
  clientDryRun?: boolean;
  // P4 真实通道安全护栏
  liveMaxDailyAmount?: number;
  liveCodesWhitelist?: string[];
  liveSimDrillPassed?: boolean;
}

export function brokerGetStatus() {
  return invoke<BrokerStatus>("broker_get_status");
}

export interface BrokerConfigFull {
  kind: string;
  liveEnabled: boolean;
  pythonPath: string;
  qmtPath: string;
  accountId: string;
  maxSinglePct: number;
  maxTotalPct: number;
  noOpenAfter: string;
  feePct: number;
  mockAllowAnytime: boolean;
  mockInitCash: number;
  dailyLossLimitPct: number;
  maxDrawdownLimitPct: number;
  consecutiveLossLimit: number;
  liveMaxOrderAmount: number;
  // P3 客户端自动化通道
  clientVendor: string;
  clientSim: boolean;
  clientPath: string;
  clientTemplateDir: string;
  clientAutoConfirm: boolean;
  clientMinIntervalMs: number;
  clientDryRun: boolean;
  // P4 真实通道安全护栏
  liveMaxDailyAmount: number;
  liveCodesWhitelist: string[];
  liveSimDrillPassed: boolean;
  liveArmedAt: number;
}

export function brokerGetConfig() {
  return invoke<BrokerConfigFull>("broker_get_config");
}

export function brokerSetConfig(patch: BrokerConfigPatch) {
  return invoke<void>("broker_set_config", {
    kind: patch.kind ?? null,
    pythonPath: patch.pythonPath ?? null,
    qmtPath: patch.qmtPath ?? null,
    accountId: patch.accountId ?? null,
    maxSinglePct: patch.maxSinglePct ?? null,
    maxTotalPct: patch.maxTotalPct ?? null,
    noOpenAfter: patch.noOpenAfter ?? null,
    feePct: patch.feePct ?? null,
    mockAllowAnytime: patch.mockAllowAnytime ?? null,
    mockInitCash: patch.mockInitCash ?? null,
    dailyLossLimitPct: patch.dailyLossLimitPct ?? null,
    maxDrawdownLimitPct: patch.maxDrawdownLimitPct ?? null,
    consecutiveLossLimit: patch.consecutiveLossLimit ?? null,
    liveMaxOrderAmount: patch.liveMaxOrderAmount ?? null,
    clientVendor: patch.clientVendor ?? null,
    clientSim: patch.clientSim ?? null,
    clientPath: patch.clientPath ?? null,
    clientTemplateDir: patch.clientTemplateDir ?? null,
    clientAutoConfirm: patch.clientAutoConfirm ?? null,
    clientMinIntervalMs: patch.clientMinIntervalMs ?? null,
    clientDryRun: patch.clientDryRun ?? null,
    liveMaxDailyAmount: patch.liveMaxDailyAmount ?? null,
    liveCodesWhitelist: patch.liveCodesWhitelist ?? null,
    liveSimDrillPassed: patch.liveSimDrillPassed ?? null,
  });
}

export function brokerEnableLive(enable: boolean, ack: boolean) {
  return invoke<void>("broker_enable_live", { enable, ack });
}

// P4 真实通道安全护栏
export interface LiveUsage {
  liveEnabled: boolean;
  kind: string;
  isLive: boolean;
  singleLimit: number;
  dailyLimit: number;
  usedToday: number;
  remaining: number;
  whitelist: string[];
  drillPassed: boolean;
  armedAt: number;
}

export function brokerLiveWhitelistSet(codes: string[]) {
  return invoke<string[]>("broker_live_whitelist_set", { codes });
}

export function brokerLiveMarkDrill(passed: boolean) {
  return invoke<void>("broker_live_mark_drill", { passed });
}

export function brokerLiveUsage() {
  return invoke<LiveUsage>("broker_live_usage");
}

export function brokerConnect() {
  return invoke<string>("broker_connect");
}

export function brokerDisconnect() {
  return invoke<void>("broker_disconnect");
}

export function brokerSubmit(sigId: string) {
  return invoke<BrokerOrderInfo>("broker_submit", { sigId });
}

export function brokerCancel(sigId: string) {
  return invoke<void>("broker_cancel", { sigId });
}

export function brokerListOrders(status?: string | null) {
  return invoke<BrokerOrderInfo[]>("broker_list_orders", {
    status: status ?? null,
    limit: 200,
  });
}

export function brokerQueryAsset() {
  return invoke<BrokerAsset>("broker_query_asset");
}

export function brokerQueryPosition() {
  return invoke<{ positions: BrokerPosition[]; note?: string }>("broker_query_position");
}

export function brokerKillSwitch(cancelAll = false) {
  return invoke<string>("broker_kill_switch", { cancelAll });
}

// v3.0.0-rc 一键急停：封新委托 + 停自动执行 + 撤全部条件单 + 撤全部在途委托
export interface EmergencyHaltResult {
  coCount: number;
  orderCount: number;
}

export function brokerEmergencyHalt() {
  return invoke<EmergencyHaltResult>("broker_emergency_halt");
}

export function brokerReleaseKill() {
  return invoke<void>("broker_release_kill");
}

// ===== P3 客户端自动化通道（同花顺模拟）=====

export interface ClientSelfcheckItem {
  name: string;
  ok: boolean;
  msg?: string;
}

export interface ClientSelfcheck {
  vendor?: string;
  sim?: boolean;
  dryRun?: boolean;
  mode?: string;
  checks?: ClientSelfcheckItem[];
}

export interface ClientShotExpect {
  code?: string;
  side?: string;
  price?: number;
  vol?: number;
  amount?: number;
  sim?: boolean;
  autoConfirm?: boolean;
}

export interface ClientShot {
  client_order_id?: string;
  shot?: string;
  expect?: ClientShotExpect;
  message?: string;
}

/** 半自动确认桥：人工核对截图后确认 / 拒绝在客户端挂起的委托。 */
export function brokerClientConfirm(sigId: string, approved: boolean) {
  return invoke<void>("broker_client_confirm", { sigId, approved });
}

/** 读取最近一次连接自检结果（connect 时由 sidecar 推送并缓存）。 */
export function brokerClientSelfcheck() {
  return invoke<ClientSelfcheck>("broker_client_selfcheck");
}

/** 读取指定委托（或最近一张）下单前截图。 */
export function brokerClientShot(sigId?: string | null) {
  return invoke<ClientShot | null>("broker_client_shot", { sigId: sigId ?? null });
}

export interface FillResult {
  orderId: string;
  amount: number;
  fee: number;
  cash: number;
}

export function portfolioBuy(code: string, name: string, price: number, vol: number) {
  return invoke<FillResult>("portfolio_buy", { code, name, price, vol });
}

export function portfolioSell(code: string, price: number, vol: number) {
  return invoke<FillResult>("portfolio_sell", { code, price, vol });
}

export function mockSeedPosition(code: string, vol: number, price: number) {
  return invoke<void>("mock_seed_position", { code, vol, price });
}

export function mockReset() {
  return invoke<void>("mock_reset");
}

// ===== 风险仪表盘（v2.28）=====

export interface PositionRisk {
  code: string;
  name: string;
  marketValue: number;
  pct: number; // 占总资产 %
  floatPnl: number;
  floatPnlPct: number;
}

export interface SectorExposure {
  theme: string;
  marketValue: number;
  pct: number;
  count: number;
}

export interface RiskWarning {
  level: string; // danger / warn
  code: string;
  text: string;
}

export interface RiskSnapshot {
  equity: number;
  cash: number;
  marketValue: number;
  positionPct: number;
  maxSinglePct: number;
  maxSingleCode: string;
  totalPnl: number;
  totalPnlPct: number;
  floatPnl: number;
  dayPnl: number;
  dayPnlPct: number;
  drawdownPct: number;
  peakEquity: number;
  dayDrawdownPct: number;
  sectorExposure: SectorExposure[];
  marketEmotion: number;
  indexChg: number;
  systemicRiskLevel: string; // low / mid / high
  stopTriggerCount: number;
  dailyLossPct: number;
  consecutiveLosses: number;
  warnings: RiskWarning[];
  killSwitch: boolean;
  positions: PositionRisk[];
}

export function riskSnapshot() {
  return invoke<RiskSnapshot>("risk_snapshot");
}
