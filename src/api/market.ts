// 行情 API：通过 Tauri command 调 Rust 端（Rust 负责请求东财/新浪公开接口，避免浏览器 CORS 与限频）
import { invoke } from "@tauri-apps/api/core";
import type { Quote, KBar, StockItem, FundFlow, Sector, ScreenFilter, ScreenResult, AlertRule, OrderBook } from "./types";

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

/** 历史分时（最近 5 个交易日）；date="YYYYMMDD" 指定某天，缺省取最新交易日 */
export async function fetchHistMinute(code: string, date: string): Promise<KBar[]> {
  return await invoke<KBar[]>("get_hist_minute", { code, date });
}

/** 五档盘口（卖 1-5 / 买 1-5 + 当日概要） */
export async function fetchOrderBook(code: string): Promise<OrderBook> {
  return await invoke<OrderBook>("get_orderbook", { code });
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

// ===== 盘中快讯（新浪财经 7x24） =====
export interface NewsItem {
  id: number;
  time: string; // "2026-09-23 09:45:12"
  text: string;
  tags: string[];
  url: string;
}
/** 盘中快讯分页（page 从 1 开始，按时间倒序） */
export async function fetchNewsFlash(page: number, size = 30): Promise<NewsItem[]> {
  return await invoke<NewsItem[]>("get_news_flash", { page, size });
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

// ===== 全市场限售解禁一览 =====
export interface MarketRestricted {
  code: string;
  name: string;
  date: string;
  typeName: string;
  shares: number;      // 实际解禁数量（万股）
  ableShares: number;  // 解禁数量（万股）
  marketCap: number;   // 实际解禁市值（万元）
  freeRatio: number;   // 占解禁前流通市值比例（%）
}
export interface MarketRestrictedPage {
  total: number;
  pages: number;
  data: MarketRestricted[];
}
export async function fetchMarketRestricted(
  start: string,
  end: string,
  page: number,
  size = 50
): Promise<MarketRestrictedPage> {
  return await invoke<MarketRestrictedPage>("get_market_restricted", {
    start,
    end,
    page,
    size,
  });
}

// ===== 集合竞价（全市场开盘缺口排名）=====
export interface AuctionStock {
  code: string;
  name: string;
  open: number;
  prevClose: number;
  gap: number;    // 开盘涨幅（缺口）%
  amount: number; // 成交额（9:25 时刻即竞价成交额）
  price: number;
  pct: number;
}
export interface AuctionData {
  updated: number;
  total: number;
  highOpen: AuctionStock[]; // 高开抢筹榜
  lowOpen: AuctionStock[];  // 低开出逃榜
}
export async function fetchAuction(): Promise<AuctionData> {
  return await invoke<AuctionData>("get_auction");
}

// ===== 涨停池 / 炸板池明细 =====
export interface ZtStock {
  code: string;
  name: string;
  price: number;
  pct: number;
  amount: number;
  fund: number;        // 封单金额（元）
  boards: number;      // 连板数
  firstSeal: number;   // 首次封板时间
  lastSeal: number;    // 最后封板时间
  broken: number;      // 炸板次数
  turnover: number;    // 换手率 %
  industry: string;    // 所属行业
  statDays: number;    // N 天
  statCount: number;   // M 板
  limitPrice: number;  // 涨停价
}
export interface ZtPool {
  date: string;
  total: number;
  list: ZtStock[];
}
/** 涨停池（date 为空取今日，格式 YYYYMMDD） */
export async function fetchZtPool(date = ""): Promise<ZtPool> {
  return await invoke<ZtPool>("get_zt_pool", { date });
}
/** 炸板池 */
export async function fetchZbPool(date = ""): Promise<ZtPool> {
  return await invoke<ZtPool>("get_zb_pool", { date });
}

// ===== 龙虎榜复盘 =====
export interface LhbStock {
  code: string;
  name: string;
  price: number;
  pct: number;
  turnover: number;
  netAmt: number;    // 龙虎榜净买入（元）
  buyAmt: number;
  sellAmt: number;
  dealAmt: number;   // 龙虎榜成交额（元）
  freeMv: number;
  reasons: string[];
}
export interface LhbList {
  date: string;
  total: number;
  stocks: LhbStock[];
}
export interface LhbSeat {
  name: string;
  code: string;
  buy: number;
  sell: number;
  net: number;
  buyRatio: number;
  sellRatio: number;
  times3: number;
  tag: string; // 知名游资 / 机构 / 北向
}
export interface LhbReasonGroup {
  reason: string;
  buyers: LhbSeat[];
  sellers: LhbSeat[];
}
export interface LhbDetail {
  code: string;
  name: string;
  date: string;
  price: number;
  pct: number;
  groups: LhbReasonGroup[];
}
/** 当日龙虎榜个股列表（date 为空取最新交易日，格式 YYYY-MM-DD） */
export async function fetchLhbList(date = ""): Promise<LhbList> {
  return await invoke<LhbList>("get_lhb_list", { date });
}
/** 个股龙虎榜席位明细（买卖前五，按上榜原因分组） */
export async function fetchLhbDetail(code: string, date = ""): Promise<LhbDetail> {
  return await invoke<LhbDetail>("get_lhb_detail", { code, date });
}

// ===== 席位跟庄统计（营业部上榜后表现 / 历史上榜明细）=====
export interface SeatHorizonStat {
  avg: number;    // 上榜后平均涨幅 %
  prob: number;   // 上涨概率 %
  times: number;  // 样本（买入）次数
}
export interface SeatBackRow {
  cycle: string; // 近一月 / 近三月 / 近六月 / 近一年
  d1: SeatHorizonStat;
  d2: SeatHorizonStat;
  d3: SeatHorizonStat;
  d5: SeatHorizonStat;
  d10: SeatHorizonStat;
}
export interface SeatBack {
  code: string;
  name: string;
  rows: SeatBackRow[];
}
export interface SeatTrade {
  date: string;
  code: string;
  name: string;
  buy: number;
  sell: number;
  net: number;
  pct: number;
  reason: string;
  d1: number | null;
  d2: number | null;
  d3: number | null;
  d5: number | null;
  d10: number | null;
  d20: number | null;
  d30: number | null;
}
export interface SeatTrades {
  code: string;
  name: string;
  total: number;
  trades: SeatTrade[];
}
/** 营业部上榜后表现回测概况（近月/季/半年/一年 × 1/2/3/5/10 日胜率） */
export async function fetchSeatBack(code: string): Promise<SeatBack> {
  return await invoke<SeatBack>("get_seat_back", { code });
}
/** 营业部历史上榜明细（含上榜后 1/2/3/5/10/20/30 日涨跌幅，page 从 1 开始） */
export async function fetchSeatTrades(
  code: string,
  size = 50,
  page = 1
): Promise<SeatTrades> {
  return await invoke<SeatTrades>("get_seat_trades", { code, size, page });
}
