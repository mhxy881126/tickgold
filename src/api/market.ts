// 行情 API：通过 Tauri command 调 Rust 端（Rust 负责请求东财/新浪公开接口，避免浏览器 CORS 与限频）
import { invoke } from "@tauri-apps/api/core";
import type { Quote, KBar, StockItem, FundFlow, Sector, ScreenFilter, ScreenResult, AlertRule } from "./types";

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

/** 当日分时（同花顺式分时图） */
export async function fetchMinute(code: string): Promise<KBar[]> {
  return await invoke<KBar[]>("get_minute", { code });
}

/** 榜单：gainers=涨幅榜 losers=跌幅榜 amount=成交额榜（失败抛出错误供上层展示） */
export async function fetchRankPage(
  sort: "gainers" | "losers" | "amount",
  page: number,
  num = 50,
): Promise<Quote[]> {
  return await invoke<Quote[]>("get_rank_page", { sort, page, num });
}

/** 个股资金流向（主力 / 散户 + 四档分布） */
export async function fetchFundFlow(code: string): Promise<FundFlow> {
  return await invoke<FundFlow>("get_fund_flow", { code });
}

/** 板块行情：industry=行业板块, concept=概念板块 */
export async function fetchSectors(kind: "industry" | "concept"): Promise<Sector[]> {
  return await invoke<Sector[]>("get_sectors", { kind });
}

/** 条件选股：技术面 + 基本面组合筛选（失败抛出供上层展示） */
export async function fetchScreener(filter: ScreenFilter): Promise<ScreenResult[]> {
  return await invoke<ScreenResult[]>("get_screener", { filter });
}

// ===== 短线精灵 / 异动实时流 =====
export interface SpiderEvent {
  time: number;
  code: string;
  name: string;
  price: number;
  pct: number;
  kind: string;
  label: string;
  desc: string;
  tone: string; // up / down / neutral
}
export interface SpiderStatus {
  trading: boolean;
  poolSize: number;
  time: number;
}

/** 启动异动监控（watch = 自选股，会并入活跃股池） */
export async function startSpider(watch: string[]): Promise<string> {
  return await invoke<string>("start_spider", { watch });
}
/** 停止异动监控 */
export async function stopSpider(): Promise<string> {
  return await invoke<string>("stop_spider");
}

/** 检查最新版本（Tauri updater 检查失败时的兜底，Rust 多镜像拉取） */
export interface LatestInfo {
  version: string;
  notes: string;
  pubDate: string;
}
export async function fetchLatest(): Promise<LatestInfo> {
  return await invoke<LatestInfo>("check_latest");
}

// ===== 涨停雷达 =====
export interface RadarStock {
  code: string;
  name: string;
  price: number;
  pct: number;
}
export interface LimitStock extends RadarStock {
  boards: number;
}
export interface LadderGroup {
  boards: number;
  count: number;
  items: LimitStock[];
}
export interface RadarData {
  trading: boolean;
  updated: number;
  total: number;
  upCount: number;
  downCount: number;
  flatCount: number;
  limitUp: number;
  limitDown: number;
  broken: number;
  brokenRate: number;
  maxBoards: number;
  sentiment: number;
  mood: string;
  hist: number[];
  ladder: LadderGroup[];
  limitUpList: LimitStock[];
  brokenList: RadarStock[];
  limitDownList: RadarStock[];
}
export interface RadarStatus {
  scanning: boolean;
  trading: boolean;
  time: number;
}

/** 启动涨停雷达（全市场扫描） */
export async function startRadar(): Promise<string> {
  return await invoke<string>("start_radar");
}
/** 停止涨停雷达 */
export async function stopRadar(): Promise<string> {
  return await invoke<string>("stop_radar");
}

// ===== 价格 / 涨跌幅预警 =====
export interface AlertEvent {
  time: number;
  id: string;
  code: string;
  name: string;
  kind: string; // price_up / price_down / pct_up / pct_down
  label: string;
  message: string;
  price: number;
  pct: number;
  target: number;
  tone: string; // up / down
}
/** 启动（或更新）预警引擎，传入启用规则快照 */
export async function startAlertEngine(rules: AlertRule[]): Promise<string> {
  return await invoke<string>("start_alert_engine", { rules });
}
export async function stopAlertEngine(): Promise<string> {
  return await invoke<string>("stop_alert_engine");
}

// ===== F10 个股资料 =====
export interface Kv {
  key: string;
  value: string;
}
export interface CompanyProfile {
  code: string;
  name: string;
  enName: string;
  market: string;
  listDate: string;
  issuePrice: string;
  underwriter: string;
  establishDate: string;
  regCapital: string;
  orgType: string;
  secretary: string;
  phone: string;
  fax: string;
  email: string;
  website: string;
  postcode: string;
  regAddress: string;
  officeAddress: string;
  intro: string;
  mainBusiness: string;
  fields: Kv[];
}
export interface FinanceRow {
  name: string;
  values: (number | null)[];
}
export interface FinanceGroup {
  name: string;
  rows: FinanceRow[];
}
export interface FinanceReport {
  periods: string[];
  groups: FinanceGroup[];
}
export interface ChipDistribution {
  currentPrice: number;
  avgCost: number;
  profitRatio: number;
  low90: number;
  high90: number;
  concentration90: number;
  low70: number;
  high70: number;
  concentration70: number;
  prices: number[];
  chips: number[];
}

export async function fetchF10Profile(code: string): Promise<CompanyProfile> {
  return await invoke<CompanyProfile>("get_f10_profile", { code });
}
export async function fetchF10Finance(code: string): Promise<FinanceReport> {
  return await invoke<FinanceReport>("get_f10_finance", { code });
}
export async function fetchF10Chips(code: string): Promise<ChipDistribution> {
  return await invoke<ChipDistribution>("get_f10_chips", { code });
}

// ===== 新股 / 解禁日历 =====
export interface IpoItem {
  code: string;
  name: string;
  applyDate: string;  // 申购日
  listDate: string;   // 上市日
  payDate: string;    // 中签缴款日
  issuePrice: number | null;
  pe: number | null;
  lotRate: number | null;  // 中签率（小数）
  applyLimit: number | null; // 申购上限（万股）
  totalQty: number | null;
  onlineQty: number | null;
}
export interface RestrictedItem {
  code: string;
  name: string;
  liftDate: string;
  liftQty: number | null;   // 万股
  liftValue: number | null; // 亿元
  batch: number | null;
  noticeDate: string;
}
export async function fetchIpoList(): Promise<IpoItem[]> {
  return await invoke<IpoItem[]>("get_ipo_list");
}
export async function fetchRestrictedQueue(code: string): Promise<RestrictedItem[]> {
  return await invoke<RestrictedItem[]>("get_restricted_queue", { code });
}
