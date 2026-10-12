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
  vol: number;
  avail: number;
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
  });
}

export function brokerEnableLive(enable: boolean) {
  return invoke<void>("broker_enable_live", { enable });
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

export function brokerReleaseKill() {
  return invoke<void>("broker_release_kill");
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
  positions: PositionRisk[];
}

export function riskSnapshot() {
  return invoke<RiskSnapshot>("risk_snapshot");
}
