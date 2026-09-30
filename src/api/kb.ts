// 采集类 command 封装（与行情 API 风格一致）。
import { invoke } from "@tauri-apps/api/core";

export interface AnnounceItem {
  id: string;
  code: string;
  name: string;
  title: string;
  time: number;
  url: string;
  category: string;
}

export interface IrmItem {
  platform: string;
  code: string;
  name: string;
  question: string;
  answer: string;
  time: number;
  url: string;
}

/** 指定交易日（YYYY-MM-DD）的公告；失败抛出由调度器捕获并降级。 */
export async function fetchAnnouncements(date: string): Promise<AnnounceItem[]> {
  return await invoke<AnnounceItem[]>("get_announcements", { date });
}

export async function fetchIrmLatest(): Promise<IrmItem[]> {
  return await invoke<IrmItem[]>("get_irm_latest");
}

/** 单只个股的题材标签（东财 f127=行业 / f128=概念，camelCase 由 Rust serde 给出）。 */
export interface StockThemeTags {
  code: string;
  industry: string;
  concepts: string[];
}

/** 批量取个股行业/概念标签；f127/f128 替代已失效的板块成分链路。 */
export async function fetchStockThemeTags(codes: string[]): Promise<StockThemeTags[]> {
  if (codes.length === 0) return [];
  return await invoke<StockThemeTags[]>("get_stock_theme_tags", { codes });
}
