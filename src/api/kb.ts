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
