// 回测引擎 API（v2.30）：对应 src-tauri/src/ai/backtest.rs
import { invoke } from "@tauri-apps/api/core";

export interface BacktestReq {
  codes: string[];
  start: string;
  end: string;
  initCash?: number;
  buyThreshold?: number;
  sellThreshold?: number;
  maxPositions?: number;
  maxSinglePct?: number;
  participationPct?: number;
  slippagePct?: number;
  benchmark?: string;
  name?: string;
  weights?: Record<string, number> | null;
}

export interface Trade {
  code: string;
  name: string;
  side: string;
  date: string;
  price: number;
  vol: number;
  amount: number;
  fee: number;
  pnl: number;
  holdingDays: number;
  confidence: number;
}

export interface EquityPoint {
  date: string;
  equity: number;
  drawdown: number;
  benchmark: number;
}

export interface PerfStats {
  totalReturnPct: number;
  annualReturnPct: number;
  benchmarkReturnPct: number;
  excessReturnPct: number;
  winRatePct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpe: number;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  avgPnl: number;
  avgHoldingDays: number;
}

export interface MonthlyReturn {
  month: string;
  returnPct: number;
}

export interface BacktestResult {
  id?: number | null;
  name: string;
  start: string;
  end: string;
  stats: PerfStats;
  equityCurve: EquityPoint[];
  trades: Trade[];
  monthly: MonthlyReturn[];
  params: Record<string, number>;
}

export interface RunMeta {
  id: number;
  name: string;
  start: string;
  end: string;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  createdAt: number;
}

export interface WindowRow {
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  bestBuyThreshold: number;
  bestWeightFactor: string;
  bestWeightValue: number;
  trainSharpe: number;
  trainReturnPct: number;
  testSharpe: number;
  testReturnPct: number;
  testMaxDrawdownPct: number;
}

export interface OptimizeReq {
  base: BacktestReq;
  trainDays?: number;
  testDays?: number;
  buyThresholdGrid?: number[];
  weightGrids?: Record<string, number[]>;
  maxCombos?: number;
}

export interface OptimizeReport {
  avgOosSharpe: number;
  oosCompoundPct: number;
  avgIsSharpe: number;
  comboCount: number;
  windows: WindowRow[];
}

export function runBacktest(req: BacktestReq): Promise<BacktestResult> {
  return invoke<BacktestResult>("backtest_run", { req });
}

export function saveBacktest(result: BacktestResult): Promise<number> {
  return invoke<number>("backtest_save", { result });
}

export function listBacktests(): Promise<RunMeta[]> {
  return invoke<RunMeta[]>("backtest_list");
}

export function loadBacktest(id: number): Promise<BacktestResult> {
  return invoke<BacktestResult>("backtest_load", { id });
}

export function deleteBacktest(id: number): Promise<void> {
  return invoke<void>("backtest_delete", { id });
}

export function optimizeBacktest(req: OptimizeReq): Promise<OptimizeReport> {
  return invoke<OptimizeReport>("backtest_optimize", { req });
}

// ===== v2.30 回测→实盘人工审批护栏 =====

export interface TuningPayload {
  weights: Record<string, number>;
  note?: string;
}

export interface ProposalView {
  id: number;
  backtestId: number | null;
  payload: TuningPayload;
  baseline: Record<string, number>;
  status: string;
  decidedAt: number;
  createdAt: number;
}

export function createTuningProposal(
  backtestId: number | null,
  payload: TuningPayload,
): Promise<number> {
  return invoke<number>("tuning_proposal_create", { backtestId, payload });
}

export function listTuningProposals(): Promise<ProposalView[]> {
  return invoke<ProposalView[]>("tuning_proposal_list");
}

export function approveTuningProposal(id: number): Promise<void> {
  return invoke<void>("tuning_proposal_approve", { id });
}

export function rejectTuningProposal(id: number): Promise<void> {
  return invoke<void>("tuning_proposal_reject", { id });
}

export function revertTuningProposal(id: number): Promise<void> {
  return invoke<void>("tuning_proposal_revert", { id });
}
