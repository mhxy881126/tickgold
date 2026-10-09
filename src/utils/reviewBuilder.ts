// 复盘数据构建：从历史接口（涨停池/炸板池/龙虎榜/板块行情）构建统一的复盘数据结构
import type { ZtPool, LhbList } from "../api/market";
import type { Sector } from "../api/types";

export interface TimelineNode {
  time: number;           // 时间戳（毫秒）
  type: "limit_up" | "broken" | "reseal" | "lhb" | "sector" | "promote";
  code: string;
  name: string;
  title: string;
  desc: string;
  pct?: number;
  tone: "up" | "down" | "neutral";
  extra?: Record<string, any>;
}

export interface ReviewEmotion {
  sentiment: number;      // 0-100
  mood: string;           // 冰点/低迷/中性/活跃/亢奋
  hist: number[];         // 情绪曲线数据点
  change: number;         // 较昨日变化
}

export interface ReviewStructure {
  limitUp: number;
  limitDown: number;
  broken: number;
  sealRate: number;       // %
  upCount: number;
  downCount: number;
  mainFund: number;       // 亿
  maxBoards: number;
  topStock: string;
  distribution: number[]; // 10档分布
}

export interface SectorRow {
  code: string;
  name: string;
  changePct: number;
  netAmount: number;      // 元
  leadStock: string;
  kind: "industry" | "concept";
}

export interface LadderGroup {
  boards: number;
  count: number;
  items: { code: string; name: string; pct: number; firstSeal: number; broken: number }[];
}

export interface LhbStock {
  code: string;
  name: string;
  pct: number;
  netAmt: number;
  reasons: string[];
}

export interface ReviewData {
  date: string;
  mode: "history" | "realtime";
  emotion: ReviewEmotion;
  structure: ReviewStructure;
  timeline: TimelineNode[];
  sectors: SectorRow[];
  ladder: LadderGroup[];
  lhb: LhbStock[];
}

export function buildReviewData(
  ztPool: ZtPool,
  zbPool: ZtPool,
  lhbList: LhbList | null,
  sectors: Sector[]
): ReviewData {
  return {
    date: (ztPool as any).date || "",
    mode: "history",
    emotion: buildEmotion(ztPool, zbPool),
    structure: buildStructure(ztPool, zbPool, sectors),
    timeline: buildTimeline(ztPool, zbPool, lhbList, sectors),
    sectors: buildSectors(sectors),
    ladder: buildLadder(ztPool),
    lhb: buildLhb(lhbList),
  };
}

// ===== 涨跌结构 =====
function buildStructure(
  ztPool: ZtPool,
  zbPool: ZtPool,
  sectors: Sector[]
): ReviewStructure {
  const ztList = (ztPool as any).list || [];
  const zbList = (zbPool as any).list || [];

  const limitUp = ztList.length;
  const brokenInZt = ztList.filter((s: any) => s.broken > 0).length;
  const broken = zbList.length + brokenInZt;
  const sealRate = limitUp + broken > 0 ? (limitUp / (limitUp + broken)) * 100 : 0;

  // 主力资金：板块净流入总和（亿）
  const mainFund =
    sectors.reduce((sum: number, s: any) => sum + (s.netAmount || 0), 0) / 1e8;

  // 最高连板
  let maxBoards = 0;
  let topStock = "—";
  for (const s of ztList) {
    if (s.boards > maxBoards) {
      maxBoards = s.boards;
      topStock = s.name;
    }
  }

  return {
    limitUp,
    limitDown: 0,
    broken,
    sealRate: Math.round(sealRate * 10) / 10,
    upCount: 0,
    downCount: 0,
    mainFund: Math.round(mainFund * 10) / 10,
    maxBoards,
    topStock,
    distribution: new Array(10).fill(0),
  };
}

// ===== 情绪数据 =====
function buildEmotion(ztPool: ZtPool, zbPool: ZtPool): ReviewEmotion {
  const ztCount = (ztPool as any).list?.length || 0;
  const zbCount = (zbPool as any).list?.length || 0;
  const total = ztCount + zbCount;

  // 情绪计算（参考 limitup.rs 算法简化版）
  const s_limit = Math.min(25, ztCount * 0.4);
  const s_broken = -Math.min(15, zbCount * 0.5);
  const maxBoards = Math.max(
    0,
    ...((ztPool as any).list || []).map((s: any) => s.boards || 0)
  );
  const s_height = Math.min(12, Math.max(0, maxBoards - 1) * 1.5);
  const s_seal = total > 0 ? (ztCount / total - 0.5) * 10 : 0;

  const sentiment = Math.max(
    2,
    Math.min(99, 50 + s_limit + s_broken + s_height + s_seal)
  );

  // mood
  let mood = "中性";
  if (sentiment < 20) mood = "冰点";
  else if (sentiment < 40) mood = "低迷";
  else if (sentiment < 60) mood = "中性";
  else if (sentiment < 80) mood = "活跃";
  else mood = "亢奋";

  // 情绪曲线
  const hist = buildEmotionHist(ztPool, sentiment);

  return {
    sentiment: Math.round(sentiment * 10) / 10,
    mood,
    hist,
    change: 0,
  };
}

function buildEmotionHist(ztPool: ZtPool, baseSentiment: number): number[] {
  const points = 20;
  const hist: number[] = [];

  // 按时间段统计涨停数
  const buckets = new Array(4).fill(0); // 早盘/午前/午后/尾盘
  const ztList = (ztPool as any).list || [];

  for (const s of ztList) {
    const seal = s.firstSeal || 0;
    const h = Math.floor(seal / 10000);
    const m = Math.floor((seal % 10000) / 100);
    const mins = h * 60 + m;

    if (mins >= 570 && mins < 630) buckets[0]++;
    else if (mins >= 630 && mins < 690) buckets[1]++;
    else if (mins >= 780 && mins < 840) buckets[2]++;
    else if (mins >= 840 && mins <= 900) buckets[3]++;
  }

  // 用插值生成平滑曲线
  const total = buckets.reduce((a, b) => a + b, 0) || 1;

  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);

    let ratio = 0;
    if (t < 0.25) ratio = (buckets[0] / total) * (t / 0.25);
    else if (t < 0.5)
      ratio = buckets[0] / total + (buckets[1] / total) * ((t - 0.25) / 0.25);
    else if (t < 0.75)
      ratio =
        (buckets[0] + buckets[1]) / total +
        (buckets[2] / total) * ((t - 0.5) / 0.25);
    else
      ratio =
        (buckets[0] + buckets[1] + buckets[2]) / total +
        (buckets[3] / total) * ((t - 0.75) / 0.25);

    const val = Math.max(
      5,
      Math.min(95, baseSentiment - 10 + ratio * 20 + Math.sin(t * Math.PI) * 5)
    );
    hist.push(Math.round(val * 10) / 10);
  }

  return hist;
}

// ===== 时间线 =====
function buildTimeline(
  ztPool: ZtPool,
  zbPool: ZtPool,
  lhbList: LhbList | null,
  sectors: Sector[]
): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  const date = (ztPool as any).date || "";
  const baseTs = date ? parseYmdToTs(date) : Date.now();

  // 1. 涨停 / 回封 节点
  for (const s of (ztPool as any).list || []) {
    const sealTs = baseTs + firstSealToMinutes(s.firstSeal) * 60 * 1000;
    const isReseal = s.broken > 0;

    nodes.push({
      time: sealTs,
      type: isReseal ? "reseal" : "limit_up",
      code: s.code,
      name: s.name,
      title: isReseal ? "回封涨停" : "首封涨停",
      desc: `${s.boards}连板 · ${s.broken > 0 ? `炸板${s.broken}次` : "硬板"}`,
      pct: s.pct,
      tone: "up",
      extra: {
        boards: s.boards,
        firstSeal: s.firstSeal,
        broken: s.broken,
        amount: s.amount,
      },
    });
  }

  // 2. 炸板节点（炸板池，没有精确时间的放到午后随机）
  const zbList = (zbPool as any).list || [];
  for (let i = 0; i < zbList.length; i++) {
    const s = zbList[i];
    // 没有 firstSeal 的话随机分布在午后
    const offset = 13 * 60 + (i % 60);
    const ts = baseTs + offset * 60 * 1000;
    nodes.push({
      time: ts,
      type: "broken",
      code: s.code,
      name: s.name,
      title: "炸板",
      desc: `炸板后 ${(s.pct || 0).toFixed(1)}%`,
      pct: s.pct,
      tone: "down",
      extra: {},
    });
  }

  // 3. 龙虎榜节点（收盘后）
  if ((lhbList as any)?.stocks?.length) {
    const closeTs = baseTs + 15 * 60 * 60 * 1000;
    for (const s of (lhbList as any).stocks.slice(0, 10)) {
      nodes.push({
        time: closeTs,
        type: "lhb",
        code: s.code,
        name: s.name,
        title: "龙虎榜",
        desc: `净${s.netAmt >= 0 ? "买入" : "卖出"}${(
          Math.abs(s.netAmt) / 1e8
        ).toFixed(2)}亿`,
        pct: s.pct,
        tone: s.netAmt >= 0 ? "up" : "down",
        extra: { reasons: s.reasons },
      });
    }
  }

  // 4. 板块异动（涨幅前3的板块，时间标记在午盘）
  const topSectors = [...sectors]
    .sort(
      (a: any, b: any) => Math.abs(b.changePct) - Math.abs(a.changePct)
    )
    .slice(0, 3);
  const sectorTs = baseTs + 10 * 60 * 60 * 1000 + 30 * 60 * 1000;

  for (const s of topSectors) {
    nodes.push({
      time: sectorTs,
      type: "sector",
      code: (s as any).code,
      name: s.name,
      title: "板块异动",
      desc: `${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(1)}%`,
      pct: s.changePct,
      tone: s.changePct >= 0 ? "up" : "down",
      extra: { netAmount: (s as any).netAmount },
    });
  }

  // 按时间排序
  nodes.sort((a, b) => a.time - b.time);

  return nodes;
}

// ===== 连板梯队 =====
function buildLadder(ztPool: ZtPool): LadderGroup[] {
  const groups = new Map<number, any[]>();

  for (const s of (ztPool as any).list || []) {
    const boards = s.boards || 1;
    if (!groups.has(boards)) groups.set(boards, []);
    groups.get(boards)!.push({
      code: s.code,
      name: s.name,
      pct: s.pct,
      firstSeal: s.firstSeal,
      broken: s.broken || 0,
    });
  }

  const ladder: LadderGroup[] = [];
  for (const boards of [...groups.keys()].sort((a, b) => b - a)) {
    const items = groups.get(boards)!;
    items.sort(
      (a, b) => (a.firstSeal || 0) - (b.firstSeal || 0)
    );
    ladder.push({ boards, count: items.length, items });
  }

  return ladder;
}

// ===== 板块 =====
function buildSectors(sectors: Sector[]): SectorRow[] {
  return [...sectors]
    .sort((a: any, b: any) => (b.netAmount || 0) - (a.netAmount || 0))
    .map((s: any) => ({
      code: s.code,
      name: s.name,
      changePct: s.changePct,
      netAmount: s.netAmount || 0,
      leadStock: "",
      kind: s.kind || "industry",
    }));
}

// ===== 龙虎榜 =====
function buildLhb(lhbList: LhbList | null): LhbStock[] {
  if (!(lhbList as any)?.stocks) return [];
  return (lhbList as any).stocks.map((s: any) => ({
    code: s.code,
    name: s.name,
    pct: s.pct,
    netAmt: s.netAmt || 0,
    reasons: s.reasons || [],
  }));
}

// ===== 辅助函数 =====
function parseYmdToTs(ymd: string): number {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6)) - 1;
  const d = Number(ymd.slice(6, 8));
  return new Date(y, m, d, 0, 0, 0).getTime();
}

function firstSealToMinutes(seal: number): number {
  if (!seal) return 9 * 60 + 30;
  const h = Math.floor(seal / 10000);
  const m = Math.floor((seal % 10000) / 100);
  return h * 60 + m;
}
