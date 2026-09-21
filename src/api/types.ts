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
