// 题材库领域类型：字段与 SQLite 表一一对应（snake_case 行记录，repo 层负责映射）。

export type ThemeLevel = "主线" | "分支" | "一日游";
export type ThemeStage = "萌芽" | "发酵" | "高潮" | "退潮";
export type StockRole = "龙一" | "龙二" | "助攻" | "跟风";
export type CatalystKind =
  | "policy"
  | "industry"
  | "company"
  | "order"
  | "earnings"
  | "price"
  | "event";
export type CatalystDirection = "利好" | "利空" | "中性";
export type CollectorJob = "announcement" | "irm" | "attribution";
export type RunStatus = "running" | "success" | "failed";

export interface CollectorRunRow {
  id: number;
  tradeDate: string;
  job: CollectorJob;
  status: RunStatus;
  rowsAffected: number;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface ThemeRow {
  id: number;
  name: string;
  aliases: string;
  level: ThemeLevel;
  stage: ThemeStage;
  intro: string;
  logic: string;
  logicVersion: number;
  firstSeenDate: string | null;
  lastActiveDate: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ThemeStockRow {
  id: number;
  themeId: number;
  code: string;
  name: string;
  role: StockRole;
  roleScore: number;
  joinedDate: string;
  leftDate: string | null;
}

export interface CatalystRow {
  id: number;
  kind: CatalystKind;
  title: string;
  summary: string;
  source: string;
  sourceUrl: string;
  publishedAt: number | null;
  direction: CatalystDirection;
  themeId: number | null;
  code: string | null;
  freshScore: number;
  contentHash: string;
  collectedAt: number;
}

export interface LimitUpRecordRow {
  id: number;
  tradeDate: string;
  code: string;
  name: string;
  boards: number;
  firstSeal: number;
  lastSeal: number;
  sealFund: number;
  broken: number;
  turnover: number;
  industry: string;
  concepts: string;
}

/** 新建题材时的输入（id/时间戳由 repo 补） */
export interface ThemeDraft {
  name: string;
  aliases?: string;
  level?: ThemeLevel;
  stage?: ThemeStage;
  intro?: string;
  logic?: string;
  firstSeenDate?: string;
  lastActiveDate?: string;
}
