/**
 * P3-5 参数寻优：在分钟级回测引擎上做网格搜索。
 *
 * 防过拟合纪律：
 *  1. 交易日按时间顺序切成 in-sample（前 70%）/ out-of-sample（后 30%）；
 *  2. 排序优先样本外单笔期望（样本外为正才值得上线），样本外笔数过少降权；
 *  3. 候选参数都在实盘语义范围内（止损 0.8-1.2%、目标 1.2-1.8×、开仓线 70-80），
 *     不搜索极端值——参数是"微调"不是"炼丹"。
 */
import { runBacktest, DEFAULT_BT_PARAMS } from "./backtest";
import type { BtParams, BtResult } from "./backtest";
import type { HistDayMinute } from "../../api/market";
import type { KBar } from "../../api/types";

/** 网格：每个键的候选值；未给出的键保持基线参数 */
export interface OptimizeGrid {
  scoreOpen?: number[];
  stopMinPct?: number[];
  targetMult?: number[];
  maxPerDay?: number[];
  confirmBars?: number[];
}

export interface OptimizeOptions {
  inRatio?: number;   // 样本内比例，默认 0.7
  topN?: number;      // 返回组数，默认 5
  minOutTrades?: number; // 样本外最少笔数才参与排名，默认 2
}

/** 一组寻优结果 */
export interface OptimizeRow {
  params: BtParams;
  in: BtResult;
  out: BtResult;
  /** 综合分：样本外单笔期望（元）为主，样本外笔数 <minOutTrades 或期望<=0 时压低 */
  score: number;
}

export interface OptimizeOutcome {
  rows: OptimizeRow[];
  combos: number;      // 总组合数
  sampleDays: number;  // 总样本交易日
  inDays: number;
  outDays: number;
}

const DEFAULT_GRID: Required<Pick<OptimizeGrid, "scoreOpen" | "stopMinPct" | "targetMult" | "maxPerDay" | "confirmBars">> = {
  scoreOpen: [70, 75, 80],
  stopMinPct: [0.8, 1.0, 1.2],
  targetMult: [1.2, 1.5, 1.8],
  maxPerDay: [2, 3],
  confirmBars: [2],
};

/** 展开笛卡尔积 */
function expandGrid(base: BtParams, grid: OptimizeGrid): BtParams[] {
  const cand = {
    scoreOpen: grid.scoreOpen ?? DEFAULT_GRID.scoreOpen,
    stopMinPct: grid.stopMinPct ?? DEFAULT_GRID.stopMinPct,
    targetMult: grid.targetMult ?? DEFAULT_GRID.targetMult,
    maxPerDay: grid.maxPerDay ?? DEFAULT_GRID.maxPerDay,
    confirmBars: grid.confirmBars ?? DEFAULT_GRID.confirmBars,
  };
  const out: BtParams[] = [];
  for (const scoreOpen of cand.scoreOpen) {
    for (const stopMinPct of cand.stopMinPct) {
      for (const targetMult of cand.targetMult) {
        for (const maxPerDay of cand.maxPerDay) {
          for (const confirmBars of cand.confirmBars) {
            out.push({
              ...base,
              scoreOpen,
              stopMinPct,
              targetMult,
              maxPerDay,
              confirmBars,
            });
          }
        }
      }
    }
  }
  return out;
}

/** 综合分：样本外单笔期望为主；笔数不足或期望≤0 大幅降权；盈亏比>1 加成 */
function comboScore(out: BtResult, minOutTrades: number): number {
  if (out.count < minOutTrades) return out.avgPnl - 1000; // 样本不足：强烈压后
  if (out.avgPnl <= 0) return out.avgPnl - 500;
  const pfBonus = Math.min(1, out.profitFactor) * 50;     // 盈亏比越高越稳
  return out.avgPnl + pfBonus;
}

export function gridSearch(
  minuteDays: HistDayMinute[],
  dailyBars: KBar[],
  base: BtParams = DEFAULT_BT_PARAMS,
  grid: OptimizeGrid = {},
  opts: OptimizeOptions = {},
): OptimizeOutcome | null {
  const total = minuteDays.length;
  if (total < 4) return null; // 至少 4 个交易日才切分得开

  const inRatio = opts.inRatio ?? 0.7;
  const inDays = Math.max(2, Math.round(total * inRatio));
  const outDays = total - inDays;
  if (outDays < 1) return null;

  const inData = minuteDays.slice(0, inDays);
  const outData = minuteDays.slice(inDays);

  const paramsList = expandGrid(base, grid);
  const rows: OptimizeRow[] = [];

  for (const p of paramsList) {
    const rIn = runBacktest("grid", inData, dailyBars, p);
    const rOut = runBacktest("grid", outData, dailyBars, p);
    rows.push({
      params: p,
      in: rIn,
      out: rOut,
      score: comboScore(rOut, opts.minOutTrades ?? 2),
    });
  }

  rows.sort((a, b) => b.score - a.score);
  const topN = opts.topN ?? 5;
  return {
    rows: rows.slice(0, topN),
    combos: paramsList.length,
    sampleDays: total,
    inDays,
    outDays,
  };
}
