// v2.25 智能赋能：AI 自然语言层 API 封装
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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

export type Sentiment = "bull" | "bear" | "neutral";
export type ImpactScope = "market" | "sector" | "stock";

export interface NewsDigestItem {
  title: string;
  summary: string;
  category: "macro" | "industry" | "stock";
  related_codes: string[];
  time: string;
  url: string;
  sentiment: Sentiment;
  importance: number; // 1-3
  impact_scope: ImpactScope;
  source: string;
}

export interface NewsDigest {
  generated_at: number;
  ai_brief: string;
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

// ==================== 流式 API（v2.25.6） ====================

export interface StreamHandle {
  onDelta: (cb: (text: string) => void) => void;
  onDone: (cb: (fullText: string) => void) => void;
  onError: (cb: (msg: string) => void) => void;
  onCached: (cb: (fullText: string) => void) => void;
  unlisten: () => void;
}

function genStreamId(): string {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function startStream(command: string): Promise<StreamHandle> {
  const streamId = genStreamId();
  let deltaCb: ((t: string) => void) | null = null;
  let doneCb: ((t: string) => void) | null = null;
  let errorCb: ((m: string) => void) | null = null;
  let cachedCb: ((t: string) => void) | null = null;
  let unlistenFn: UnlistenFn | null = null;

  const eventName = `ai:stream:${streamId}`;
  unlistenFn = await listen(eventName, (event) => {
    const payload = event.payload as { type: string; content?: string; full_text?: string; message?: string };
    if (payload.type === "delta" && payload.content && deltaCb) deltaCb(payload.content);
    else if (payload.type === "done" && payload.full_text !== undefined && doneCb) doneCb(payload.full_text);
    else if (payload.type === "cached" && payload.full_text !== undefined && cachedCb) cachedCb(payload.full_text);
    else if (payload.type === "error" && payload.message && errorCb) errorCb(payload.message);
  });

  // fire-and-forget，不等待 command 返回
  invoke(command, { streamId }).catch((e) => {
    if (errorCb) errorCb(String(e));
  });

  return {
    onDelta: (cb) => { deltaCb = cb; },
    onDone: (cb) => { doneCb = cb; },
    onError: (cb) => { errorCb = cb; },
    onCached: (cb) => { cachedCb = cb; },
    unlisten: () => { if (unlistenFn) unlistenFn(); },
  };
}

/** 盘中实时解读（流式） */
export function aiIntradayCommentaryStream(): Promise<StreamHandle> {
  return startStream("ai_intraday_commentary_stream");
}

/** 资讯聚合（流式） */
export function aiNewsDigestStream(): Promise<StreamHandle> {
  return startStream("ai_news_digest_stream");
}

/** 明日主线（流式） */
export function aiTomorrowMainlineStream(): Promise<StreamHandle> {
  return startStream("ai_tomorrow_mainline_stream");
}