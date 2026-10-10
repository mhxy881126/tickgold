// v2.25 智能赋能：AI 自然语言层 API 封装
import { invoke } from "@tauri-apps/api/core";

// ==================== 类型定义 ====================

export interface IntradayCommentary {
  timestamp: number;
  market_view: string;
  key_drivers: string[];
  risk_notes: string[];
  raw: string;
}

export interface SignalAttribution {
  code: string;
  name: string;
  summary: string;
  technical: string;
  fund_flow: string;
  sector: string;
  news: string;
  confidence: number;
}

export interface AlertSuggestion {
  code: string;
  name: string;
  field: string;
  op: string;
  value: number;
  reason: string;
  priority: "high" | "medium" | "low";
}

export interface NewsDigestItem {
  title: string;
  summary: string;
  category: "macro" | "industry" | "stock";
  related_codes: string[];
  time: string;
  url: string;
}

export interface NewsDigest {
  generated_at: number;
  macro_count: number;
  industry_count: number;
  stock_count: number;
  items: NewsDigestItem[];
}

export interface MainlineTheme {
  theme: string;
  logic: string;
  leaders: string[];
  catalysts: string[];
  risk: string;
  strength: "strong" | "medium" | "weak";
}

export interface TomorrowMainline {
  generated_at: number;
  market_review: string;
  themes: MainlineTheme[];
  overall_risk: string;
}

// ==================== API 调用 ====================

/** 盘中实时解读：聚合大盘/板块/涨停池/快讯，AI 生成市场解读 */
export function aiIntradayCommentary(): Promise<IntradayCommentary> {
  return invoke<IntradayCommentary>("ai_intraday_commentary");
}

/** 信号归因：对个股异动做技术/资金/板块/消息四维度归因 */
export function aiExplainSignal(
  code: string,
  name: string,
  kind: string,
): Promise<SignalAttribution> {
  return invoke<SignalAttribution>("ai_explain_signal", { code, name, kind });
}

/** 智能预警推荐：基于自选股行情，AI 推荐 3-5 条预警规则 */
export function aiSuggestAlerts(watchlist: string[]): Promise<AlertSuggestion[]> {
  return invoke<AlertSuggestion[]>("ai_suggest_alerts", { watchlist });
}

/** 资讯聚合：对盘中快讯去重/分类/摘要，关联个股 */
export function aiNewsDigest(): Promise<NewsDigest> {
  return invoke<NewsDigest>("ai_news_digest");
}

/** 明日主线：基于涨停池/板块/快讯，AI 预测明日 3-5 条市场主线 */
export function aiTomorrowMainline(): Promise<TomorrowMainline> {
  return invoke<TomorrowMainline>("ai_tomorrow_mainline");
}

/** 个股资讯摘要：从快讯中筛选相关资讯，生成个股资讯摘要 */
export function aiNewsForStock(code: string, name: string): Promise<string> {
  return invoke<string>("ai_news_for_stock", { code, name });
}
