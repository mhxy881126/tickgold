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
  price?: number;
  pnl?: number;
  dayPnl?: number;
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
  clientTesseract?: string;
  clientApiPort?: number;
  clientApiToken?: string;
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
  clientTesseract: string;
  clientApiPort: number;
  clientApiToken: string;
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
    clientTesseract: patch.clientTesseract ?? null,
    clientApiPort: patch.clientApiPort ?? null,
    clientApiToken: patch.clientApiToken ?? null,
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
  captcha?: boolean; // 复制表格验证码（需人工输入）
  cancelPage?: boolean; // 撤单页面核对
  position?: string; // 仓位下单档位文案
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

// ===== P7 同花顺真实通道（移植 THSAutoTrader 键盘精灵自动化）=====

/** 当日成交记录（客户端查询树 → 当日成交，剪贴板读表）。 */
export interface BrokerTrade {
  code: string;
  name?: string;
  side?: string;
  price: number;
  vol: number;
  time?: string;
  status?: string;
}

/** 当日挂单（未成交委托）。 */
export interface BrokerPending {
  code: string;
  name?: string;
  side?: string;
  price: number;
  vol: number;
  filledVol?: number;
  time?: string;
  status?: string;
}

/** 同花顺下单程序进程 / 窗口运行状态。 */
export interface ClientAppState {
  running?: boolean;
  page?: string;
  note?: string;
}

/** 当前前台窗口信息（句柄 / 标题 / 最小化等，用于校准与排查）。 */
export interface ClientCurrentPage {
  found?: boolean;
  hwnd?: number;
  pid?: number;
  title?: string;
  className?: string;
  running?: boolean;
  isMinimized?: boolean;
  isMaximized?: boolean;
  note?: string;
}

/** 当日成交：优先缓存，空则向客户端查询（结果经 broker:trades 事件回传）。 */
export function brokerClientQueryTrades() {
  return invoke<{ trades?: BrokerTrade[]; note?: string }>("broker_client_query_trades");
}

/** 当日挂单（未成交委托）。 */
export function brokerClientQueryPending() {
  return invoke<{ orders?: BrokerPending[]; note?: string }>("broker_client_query_pending");
}

/** 一键撤单：kind = A(全撤) / X(撤买) / C(撤卖)。 */
export function brokerClientCancelAll(kind: string) {
  return invoke<void>("broker_client_cancel_all", { kind });
}

/**
 * 仓位下单：position 0/1=全仓、2=半仓、3=1/3、4=1/4。
 * 返回 client_order_id，供半自动确认桥 / 下单前截图关联。
 */
export function brokerClientPositionOrder(
  code: string,
  side: string,
  position: number,
  refPrice: number,
) {
  return invoke<string>("broker_client_position_order", {
    code,
    side,
    position,
    refPrice,
  });
}

/** 探测同花顺下单程序进程 / 窗口状态。 */
export function brokerClientCheckApp() {
  return invoke<ClientAppState>("broker_client_check_app");
}

/** 读取当前前台窗口信息。 */
export function brokerClientCurrentPage() {
  return invoke<ClientCurrentPage>("broker_client_current_page");
}

/** 高级调试：向同花顺窗口发送键盘序列（空格分隔）。 */
export function brokerClientSendKey(key: string) {
  return invoke<void>("broker_client_send_key", { key });
}

/** 高级调试：在同花顺窗口客户区点击坐标。 */
export function brokerClientClick(x: number, y: number) {
  return invoke<void>("broker_client_click", { x, y });
}

/** 人工验证码：复制表格遇到验证码时弹窗输入数字回传。 */
export function brokerClientCaptchaInput(text: string) {
  return invoke<void>("broker_client_captcha_input", { text });
}

// ===== P8 券商路径一键自检 =====

export interface PathProbe {
  field: string;
  label: string;
  /** ok（可用）/ empty（未配置但有建议）/ missing（无效且无建议） */
  status: string;
  configured: string;
  exists: boolean;
  suggested: string;
  hint: string;
}

export interface ProbeResult {
  mode: string;
  probes: PathProbe[];
  summary: { ok: number; bad: number };
}

/** 本机探测券商相关路径（python / qmt / 同花顺 / tesseract），mode 缺省用当前配置。 */
export function brokerProbePaths(mode?: string | null) {
  return invoke<ProbeResult>("broker_probe_paths", { mode: mode ?? null });
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

// ===== P5 模型接管（影子 / 灰度 / 接管 / 回退）=====

/** 大脑接管状态机四阶段：rule 规则脑 → shadow 影子对比 → canary 灰度 → live 模型接管。 */
export interface BrainRollout {
  stage: string; // rule / shadow / canary / live
  requestedStage: string; // 空串 = 无待审批
  requestJson: string;
  status: string; // active / pending
  grayPct: number; // 灰度比例 0-100
  smallPositionPct: number; // 灰度/接管时单票小仓位上限 %
  shadowMinSamples: number; // 影子达标所需最少样本
  shadowMinAgreePct: number; // 影子达标所需一致率 %
  failCount: number; // 连续失败计数（达 5 自动回退）
  approvedAt: number;
  approveNote: string;
  rollbackReason: string;
  updatedAt: number;
}

export interface ShadowStats {
  samples: number;
  shadowOkSamples: number;
  layaAvailable: boolean;
  agreePct: number;
  disagreePct: number;
  ruleP50Ms: number;
  ruleP99Ms: number;
  shadowP50Ms: number;
  shadowP99Ms: number;
  meetsCanary: boolean;
}

export interface RolloutView extends BrainRollout {
  stats: ShadowStats;
}

export function brainRolloutGet() {
  return invoke<RolloutView>("brain_rollout_get");
}

export interface BrainRolloutRequest {
  target: string;
  grayPct?: number;
  smallPositionPct?: number;
  shadowMinSamples?: number;
  shadowMinAgreePct?: number;
  note?: string;
}

export function brainRolloutRequest(args: BrainRolloutRequest) {
  return invoke<RolloutView>("brain_rollout_request", {
    target: args.target,
    grayPct: args.grayPct ?? null,
    smallPositionPct: args.smallPositionPct ?? null,
    shadowMinSamples: args.shadowMinSamples ?? null,
    shadowMinAgreePct: args.shadowMinAgreePct ?? null,
    note: args.note ?? null,
  });
}

export function brainRolloutApprove(approve: boolean) {
  return invoke<RolloutView>("brain_rollout_approve", { approve });
}

export function brainRolloutRollback(reason?: string) {
  return invoke<RolloutView>("brain_rollout_rollback", { reason: reason ?? null });
}

// ===== P5 故障注入与急停演练 =====

export interface DrillItem {
  kind: string; // model_timeout / network_down / sidecar_crash / quote_stale / kill_switch
  name: string;
  pass: boolean;
  evidence: string;
}

export interface DrillReport {
  armed: boolean;
  passed: number;
  total: number;
  allPass: boolean;
  items: DrillItem[];
  ranAt: number;
}

export function drillRunAll() {
  return invoke<DrillReport>("drill_run_all");
}
