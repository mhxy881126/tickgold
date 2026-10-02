// 布局 / 装箱纯函数模块（从 useWorkbench 抽出）。
// 全部为无副作用的纯函数，便于单元测试；useWorkbench 负责状态与调用。

import type { CardId, Zone } from "./cards";

export interface BentoPos { col: number; colEnd: number; row: number; rowEnd: number }
export interface FreeRect { x: number; y: number; w: number; h: number }

// 宽卡片（主干区域）与窄卡片（右侧）的默认排列顺序，也决定卡片的默认分区
const WIDE_ORDER: CardId[] = ["auction", "limitpool", "radar", "radarsweep", "reviewtimeline", "multigrid", "heatmatrix", "telegraph", "chart", "sectorheat", "sector", "screener", "f10", "trade", "journal", "calendar", "ipo", "calc", "export", "dragon", "themelib", "ai", "review", "battleplan", "strategy"];
const NARROW_ORDER: CardId[] = ["alert", "spider", "sectorevent", "trades", "news", "watch", "rank"];
export const ALL_IDS: CardId[] = [...WIDE_ORDER, ...NARROW_ORDER];

export const GAP = 12;
export const COLS = 12;
const ROWS = 6;

// 卡片在 Bento 网格中的默认尺寸（12 列 × 6 逻辑行）
const DEFAULT_SIZE: Partial<Record<CardId, { w: number; h: number }>> = {
  chart: { w: 6, h: 3 }, sectorheat: { w: 6, h: 3 }, heatmatrix: { w: 8, h: 3 },
  multigrid: { w: 6, h: 3 }, dragon: { w: 6, h: 3 }, reviewtimeline: { w: 6, h: 3 },
  themelib: { w: 6, h: 3 },
  ai: { w: 8, h: 4 },
  review: { w: 6, h: 3 },
  battleplan: { w: 8, h: 3 },
  strategy: { w: 6, h: 3 },
  radar: { w: 4, h: 2 }, radarsweep: { w: 4, h: 2 },
  sector: { w: 4, h: 2 }, screener: { w: 4, h: 2 }, f10: { w: 4, h: 2 },
  trade: { w: 4, h: 2 }, calendar: { w: 4, h: 2 },
  ipo: { w: 4, h: 2 }, journal: { w: 4, h: 2 }, auction: { w: 4, h: 2 },
  limitpool: { w: 4, h: 2 }, telegraph: { w: 4, h: 2 },
};
export function defaultSizeOf(id: CardId): { w: number; h: number } {
  return DEFAULT_SIZE[id] ?? { w: 3, h: 2 };
}

// ===== Bento 自动排布：12 列 first-fit，动态行，输出每卡网格线坐标 =====
interface BentoPack { pos: Record<string, BentoPos>; rows: number }
export function packBento(
  cards: CardId[],
  getSize: (id: CardId) => { w: number; h: number }
): BentoPack {
  const MAXR = 60;
  const occ: boolean[][] = Array.from({ length: MAXR }, () => Array(12).fill(false));
  const pos = {} as Record<string, BentoPos>;
  let maxRowEnd = 0;
  for (const id of cards) {
    const s = getSize(id);
    const cw = Math.max(1, Math.min(12, s.w));
    const ch = Math.max(1, s.h);
    let placed = false;
    for (let y = 0; y <= MAXR - ch && !placed; y++) {
      for (let x = 0; x + cw <= 12; x++) {
        let ok = true;
        for (let dy = 0; dy < ch && ok; dy++)
          for (let dx = 0; dx < cw; dx++) if (occ[y + dy][x + dx]) { ok = false; break; }
        if (!ok) continue;
        for (let dy = 0; dy < ch; dy++)
          for (let dx = 0; dx < cw; dx++) occ[y + dy][x + dx] = true;
        pos[id] = { col: x + 1, colEnd: x + 1 + cw, row: y + 1, rowEnd: y + 1 + ch };
        if (y + ch > maxRowEnd) maxRowEnd = y + ch;
        placed = true;
        break;
      }
    }
    if (!placed) {
      const y = maxRowEnd;
      pos[id] = { col: 1, colEnd: 1 + cw, row: y + 1, rowEnd: y + 1 + ch };
      maxRowEnd = y + ch;
    }
  }
  return { pos, rows: Math.max(1, maxRowEnd) };
}

export const ROW_UNIT = 88; // 自由布局每个逻辑行的像素高度
// 各卡在自由画布上的默认尺寸（w=12 列网格中的列数，h=逻辑行数）
const FREE_SIZE: Partial<Record<CardId, { w: number; h: number }>> = {
  chart: { w: 8, h: 5 },
  sectorheat: { w: 8, h: 5 },
  sector: { w: 6, h: 4 },
  screener: { w: 6, h: 4 },
  f10: { w: 6, h: 4 },
  trade: { w: 6, h: 4 },
  calendar: { w: 6, h: 4 },
  ipo: { w: 6, h: 4 },
  journal: { w: 6, h: 4 },
  radar: { w: 4, h: 3 },
  dragon: { w: 8, h: 5 },
  themelib: { w: 8, h: 5 },
  ai: { w: 8, h: 5 },
  review: { w: 8, h: 5 },
  battleplan: { w: 10, h: 5 },
  strategy: { w: 8, h: 5 },
};
export function freeSizeOf(id: CardId): { w: number; h: number } {
  return FREE_SIZE[id] ?? { w: 4, h: 3 };
}

// 自由布局初始装箱：按 12 列 shelf 换行，行高取该行最高卡，输出整数坐标
export function packFree(cards: CardId[]): Record<string, FreeRect> {
  const out: Record<string, FreeRect> = {};
  const rows: { id: CardId; w: number; h: number }[][] = [];
  let cur: { id: CardId; w: number; h: number }[] = [];
  let cw = 0;
  for (const id of cards) {
    const s = freeSizeOf(id);
    if (cur.length && cw + s.w > COLS) { rows.push(cur); cur = []; cw = 0; }
    cur.push({ id, w: s.w, h: s.h });
    cw += s.w;
  }
  if (cur.length) rows.push(cur);
  let y = 0;
  for (const row of rows) {
    const rh = Math.max(...row.map((r) => r.h));
    let x = 0;
    for (const r of row) { out[r.id] = { x, y, w: r.w, h: rh }; x += r.w; }
    y += rh;
  }
  return out;
}

// 两个自由矩形是否相交（边界相接不算重叠）
export function rectsOverlap(a: FreeRect, b: FreeRect): boolean {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0;
}

// 碰撞推开：重复扫描，凡相交则把更靠下的卡下移，直到无重叠（只向下，收敛）
export function settleFreeRects(rects: Record<string, FreeRect>) {
  let guard = 0;
  let any = true;
  while (any && guard < 400) {
    any = false;
    guard++;
    const ids = Object.keys(rects);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = rects[ids[i]];
        const b = rects[ids[j]];
        if (rectsOverlap(a, b)) {
          if (a.y <= b.y) b.y = a.y + a.h;
          else a.y = b.y + b.h;
          any = true;
        }
      }
    }
  }
}

// 由网格线编号生成定位样式 + leave 脱标用的 CSS 变量
export function cell(s: number, e: number, r: number, er: number, totalRows: number = ROWS) {
  return {
    gridColumn: `${s} / ${e}`,
    gridRow: `${r} / ${er}`,
    "--x": `calc(${s - 1} * (100% + ${GAP}px) / ${COLS})`,
    "--w": `calc(${e - s} * (100% + ${GAP}px) / ${COLS} - ${GAP}px)`,
    "--y": `calc(${r - 1} * (100% + ${GAP}px) / ${totalRows})`,
    "--h": `calc(${er - r} * (100% + ${GAP}px) / ${totalRows} - ${GAP}px)`,
  } as Record<string, string>;
}

// x 的整数约数（用于在固定网格线上均匀分列）
function divisors(x: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= x; i++) if (x % i === 0) out.push(i);
  return out;
}

// 通用装箱：把 cards 均匀铺满一个 Lw 列 × 6 行的逻辑网格（列起点 colStart）。
// 任意卡片数都保证每卡有整数网格线坐标、不重叠；末行不满则拉伸铺满，无孤卡、无右侧空洞。
export function packZone(
  cards: CardId[],
  colStart: number,
  Lw: number,
  out: Record<string, Record<string, string>>
) {
  const n = cards.length;
  if (!n) return;
  let best: { k: number; m: number; cost: number } | null = null;
  for (const k of divisors(Lw)) {
    const m = Math.ceil(n / k);
    if (6 % m !== 0) continue; // 行高必须落在整数网格线
    const cw = Lw / k;
    const ch = 6 / m;
    const ratio = cw / ch;
    const fill = n / (k * m);
    const cost = Math.abs(ratio - 1.4) + (1 - fill) * 0.6;
    if (!best || cost < best.cost) best = { k, m, cost };
  }
  if (!best) {
    out[cards[0]] = cell(1 + colStart, 1 + colStart + Lw, 1, 7); // 极端兜底
    return;
  }
  const { k, m } = best;
  const colW = Lw / k;
  const rowH = 6 / m;
  let i = 0;
  for (let row = 0; row < m; row++) {
    const remain = n - i;
    const inRow = Math.min(k, remain);
    const grs = 1 + row * rowH;
    const gre = 1 + (row + 1) * rowH;
    if (remain < k) {
      // 末行不满：把 Lw 列分给 inRow 张（宽 base / base+1），铺满整行、无右侧空洞
      const base = Math.floor(Lw / inRow);
      const extra = Lw % inRow;
      let cx = 1 + colStart;
      for (let c = 0; c < inRow; c++) {
        const w = base + (c < extra ? 1 : 0);
        out[cards[i]] = cell(cx, cx + w, grs, gre);
        cx += w;
        i++;
      }
    } else {
      for (let c = 0; c < k; c++) {
        out[cards[i]] = cell(
          1 + colStart + c * colW,
          1 + colStart + (c + 1) * colW,
          grs,
          gre
        );
        i++;
      }
    }
  }
}

export function defaultZone(id: CardId): Zone {
  return WIDE_ORDER.includes(id) ? "main" : "side";
}

// 默认分区下的全局排序权重（用于"重置布局"）
export function rankDefault(id: CardId): number {
  const wi = WIDE_ORDER.indexOf(id);
  if (wi >= 0) return wi;
  const ni = NARROW_ORDER.indexOf(id);
  return 100 + (ni >= 0 ? ni : 999);
}
