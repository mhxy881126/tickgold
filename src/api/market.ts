// 行情 API：通过 Tauri command 调 Rust 端（Rust 负责请求东财/新浪公开接口，避免浏览器 CORS 与限频）
import { invoke } from "@tauri-apps/api/core";
import type { Quote, KBar, StockItem } from "./types";

/** 批量拉实时行情 */
export async function fetchQuotes(codes: string[]): Promise<Quote[]> {
  if (codes.length === 0) return [];
  try {
    return await invoke<Quote[]>("get_quotes", { codes });
  } catch (e) {
    console.error("get_quotes failed", e);
    return [];
  }
}

/** 拉 K 线
 * @param period 1=1分 5=5分 15=15分 30=30分 60=60分 101=日 102=周 103=月
 */
export async function fetchKLine(
  code: string,
  period: number = 101,
  count: number = 500
): Promise<KBar[]> {
  try {
    return await invoke<KBar[]>("get_kline", { code, period, count });
  } catch (e) {
    console.error("get_kline failed", e);
    return [];
  }
}

/** 搜索股票（代码/名称/拼音） */
export async function searchStocks(keyword: string): Promise<StockItem[]> {
  if (!keyword.trim()) return [];
  try {
    return await invoke<StockItem[]>("search_stocks", { keyword });
  } catch (e) {
    console.error("search_stocks failed", e);
    return [];
  }
}

/** 大盘指数行情（上证/深成/创业板/沪深300/科创50） */
export async function fetchIndexQuotes(): Promise<Quote[]> {
  try {
    return await invoke<Quote[]>("get_index_quotes");
  } catch (e) {
    console.error("get_index_quotes failed", e);
    return [];
  }
}

/** 榜单：gainers=涨幅榜 losers=跌幅榜 amount=成交额榜 */
export async function fetchRank(sort: "gainers" | "losers" | "amount", pz = 30): Promise<Quote[]> {
  try {
    return await invoke<Quote[]>("get_rank", { sort, pz });
  } catch (e) {
    console.error("get_rank failed", e);
    return [];
  }
}
