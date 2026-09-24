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

/** 五档单档（价 / 量，量单位手） */
export interface OrderLevel {
  price: number;
  vol: number;
}

/** 五档盘口快照 */
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
  asks: OrderLevel[];  // 卖 1-5
  bids: OrderLevel[];  // 买 1-5
}

/** 股票搜索结果项 */
export interface StockItem {
  code: string;
  name: string;
  market: "SH" | "SZ" | "BJ";
}

/** 单档资金（特大 / 大 / 中 / 小单） */
export interface FundLevel {
  name: string;
  net: number; // 净流入（元）
  inFlow: number;
  outFlow: number;
}

/** 个股当日资金流向 */
export interface FundFlow {
  code: string;
  name: string;
  mainNet: number; // 主力（特大+大单）净流入
  mainIn: number;
  mainOut: number;
  mainNetPct: number;
  retailNet: number; // 散户（中+小单）净流入
  retailIn: number;
  retailOut: number;
  retailNetPct: number;
  netAmount: number; // 全部净流入
  levels: FundLevel[];
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
  cooldownSec: number;   // 触发冷却
  enabled: boolean;
  lastFiredAt?: number;
}

/** secid 前缀：1=沪市, 0=深市/北交所 */
export function marketPrefix(code: string): string {
  if (code.startsWith("6") || code.startsWith("9") || code.startsWith("5")) return "1";
  return "0";
}

/** 自选分组 */
export interface Group {
  id: number;
  name: string;
  sortOrder: number;
}

/** 自选股记录（含分组归属与排序） */
export interface WatchStock {
  code: string;
  name: string;
  groupId: number;
  sortOrder: number;
}
