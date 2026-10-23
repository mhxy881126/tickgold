// 共享类型定义：与 Rust 端返回结构保持一致

/** 单只股票实时快照 */
export interface Quote {
  code: string;        // 证券代码，如 600519
  name: string;        // 名称，如 贵州茅台
  price: number;       // 最新价
  change: number;      // 涨跌额
  pct: number;         // 涨跌幅 %
  open: number;        // 今开
  high: number;        // 最高
  low: number;         // 最低
  prevClose: number;  // 昨收
  volume: number;      // 成交量（手）
  amount: number;      // 成交额（元）
  time: number;        // 行情时间戳 ms
  source: string;      // 数据源：eastmoney/sina/tencent
  turnover: number;    // 换手率 %
  pe: number;          // 市盈率
  pb: number;          // 市净率
  amplitude: number;   // 振幅 %
  volumeRatio: number; // 量比
  circMv: number;      // 流通市值（亿元）
  totalMv: number;     // 总市值（亿元）
  insideVol: number;   // 内盘（主动卖成交，手）
  outsideVol: number;  // 外盘（主动买成交，手）
}

/** 增强榜单行（东方财富：换手/量比/5分钟涨速/主力净流入/大单净流入） */
export interface RankRow {
  code: string;
  name: string;
  price: number;
  pct: number;
  amount: number;       // 成交额（元）
  turnover: number;     // 换手率 %
  volumeRatio: number;  // 量比
  speed5: number;       // 5分钟涨速 %
  mainNet: number;      // 主力净流入（元）
  bigNet: number;       // 大单净流入（元）
  /** 可转债专项（仅可转债榜单有值） */
  convertValue?: number;   // 转股价值
  convertPremium?: number; // 转股溢价率 %
}

/** K线单根 */
export interface KBar {
  timestamp: number;   // ms
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

/** 盘口单档（价 / 量，量单位手） */
export interface OrderLevel {
  price: number;
  vol: number;
}

/** 盘口快照（免费源动态档数，通常 5 档） */
export interface OrderBook {
  name: string;
  code: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
  asks: OrderLevel[];  // 卖盘（档数随数据源）
  bids: OrderLevel[];  // 买盘（档数随数据源）
  bidTotal: number;    // 五档买盘挂单合计（手）
  askTotal: number;    // 五档卖盘挂单合计（手）
  weiBi: number;       // 委比 % =(bid-ask)/(bid+ask)
  weiCha: number;      // 委差（手）=bid-ask
  insideVol: number;   // 内盘（主动卖成交，手）
  outsideVol: number;  // 外盘（主动买成交，手）
  // v2.32 品种专项
  iopv?: number;          // ETF 参考净值
  convertValue?: number;  // 可转债转股价值
  convertPremium?: number; // 可转债转股溢价率 %
}

/** 逐笔成交（时间 / 价 / 量 / 主动方向） */
export interface TradeTick {
  code?: string; // 归属标的（后端回填，用于切票隔离）
  time: string;
  price: number;
  vol: number; // 手
  side: "buy" | "sell" | "neutral";
}

// ===== v2.32 盘口增强 =====
/** 分价成交桶（当日累计，量单位手） */
export interface PriceBucket {
  price: number;
  vol: number;
  buyVol: number;
  sellVol: number;
}
/** 集合竞价虚拟快照（09:15–09:25） */
export interface AuctionPoint {
  time: string;
  price: number;
  matchVol: number;
}
/** 封单额趋势点（元） */
export interface SealPoint {
  time: string;
  fund: number;
}
/** 盘口增强聚合 */
export interface DepthEnhance {
  priceDist: PriceBucket[];
  auction: AuctionPoint[];
  sealTrend: SealPoint[];
}

/** 单日资金流（元；占比 %） */
export interface FundFlowDay {
  date: string;
  mainNet: number;    // 主力净流入 = 超大+大单
  superNet: number;   // 超大单净流入
  largeNet: number;   // 大单净流入
  mediumNet: number;  // 中单净流入
  smallNet: number;   // 小单净流入
  mainPct: number;    // 主力净流入占比 %
  close: number;
  pct: number;        // 涨跌幅 %
}

/** 个股多日四档资金流 */
export interface StockFundFlow {
  code: string;
  name: string;
  days: FundFlowDay[];
}

/** 大盘主力资金全景（沪深两市合计） */
export interface MarketFundPanorama {
  mainNetToday: number;       // 今日主力净流入合计（元）
  minuteTimes: string[];      // HH:MM
  minuteMain: number[];       // 分时主力净流入累计（元）
  trend: FundFlowDay[];       // 多日主力趋势
}

/** 板块资金排名行 */
export interface FundRankRow {
  code: string;
  name: string;
  pct: number;
  mainNet: number;
}

/** 股票搜索结果项 */
export interface StockItem {
  code: string;
  name: string;
  market: "SH" | "SZ" | "BJ";
}

/** 板块（行业 / 概念） */
export interface Sector {
  code: string;
  name: string;
  changePct: number; // 板块平均涨跌幅 %
  netAmount: number; // 净流入（元）
  inAmount: number;
  outAmount: number;
  leadCode: string; // 领涨股
  leadName: string;
  leadPct: number; // 领涨股涨幅 %
}

/** 条件选股过滤器（区间留空表示不限） */
export interface ScreenFilter {
  priceMin?: number | null;
  priceMax?: number | null;
  pctMin?: number | null;
  pctMax?: number | null;
  turnoverMin?: number | null;
  turnoverMax?: number | null;
  vrMin?: number | null;
  vrMax?: number | null;
  peMin?: number | null;
  peMax?: number | null;
  pbMin?: number | null;
  pbMax?: number | null;
  mcapMin?: number | null; // 流通市值（亿）
  mcapMax?: number | null;
  ampMin?: number | null; // 振幅 %
  ampMax?: number | null;
  maBull: boolean;    // 均线多头
  macdGolden: boolean; // MACD 金叉
  volumeUp: boolean;  // 放量上涨
  breakout: boolean;  // 突破新高
  aboveMa20: boolean; // 站上20日线
  kdjGolden: boolean;  // KDJ 低位金叉
  rsiOversold: boolean; // RSI 超卖反弹
  bollBreak: boolean;  // BOLL 开口突破
  limit: number;
}

/** 选股结果（Quote 字段 + 命中信号） */
export interface ScreenResult extends Quote {
  signals: string[];
}

/** 预警规则 */
export interface AlertRule {
  id: string;
  code: string;
  name: string;
  // 触发条件：上穿价 / 下穿价 / 涨跌幅阈值(%)
  upPrice?: number;
  downPrice?: number;
  upPct?: number;
  downPct?: number;
  minVolumeRatio?: number; // 量比 ≥
  riseSpeed?: number;      // 涨速 ≥ %（窗口内涨幅）
  downSpeed?: number;      // 跳水 ≥ %（窗口内跌幅，正数）
  speedWindowSec?: number; // 涨速 / 跳水窗口（秒），默认 300
  minTurnover?: number;    // 换手率 ≥ %
  minAmount?: number;      // 成交额 ≥ 亿元
  sealLimitUp?: boolean;   // 涨停封板
  sealLimitDown?: boolean; // 跌停封板
  brokenLimit?: boolean;   // 涨停炸板（封板后打开）
  cooldownSec: number;   // 触发冷却
  enabled: boolean;
  lastFiredAt?: number;
}

/** secid 前缀：1=沪市, 0=深市/北交所（北交所新号段 920 须先于 '9' 判定） */
export function marketPrefix(code: string): string {
  if (code.startsWith("920")) return "0";
  if (code.startsWith("6") || code.startsWith("9") || code.startsWith("5") || code.startsWith("11")) return "1";
  return "0";
}

/** 智能分组规则（v2.31）：按战法（板高）或题材关键词，从近 N 日涨停记录自动归类 */
export interface SmartGroupRule {
  /** first_board（首板）/ multi_board（连板）；空 = 不按战法限 */
  tactic?: string;
  /** 行业/题材关键词（命中 industry 或 concepts） */
  theme?: string;
  /** 回看交易日数，默认 5 */
  days?: number;
}

/** 自选分组 */
export interface Group {
  id: number;
  name: string;
  sortOrder: number;
  /** manual 普通分组 / smart 智能分组（成员按规则动态计算） */
  kind?: "manual" | "smart";
  ruleJson?: string;
}

/** 自选股记录（含分组归属与排序） */
export interface WatchStock {
  code: string;
  name: string;
  groupId: number;
  sortOrder: number;
}
