// DOM 矩形 → 蜘蛛锚点的几何纯函数：不碰 document，可在 node 单测。
import type { Quote } from "../../api/types";

export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
  code?: string;
  name?: string;
  price?: number;
  pct?: number;
  /** 行的类型：行/标题/统计块 */
  kind?: "row" | "header" | "stat" | "card-center";
}

export interface Anchor extends AnchorRect {
  id: string;
  cardId: string;
  /** 落脚/光束目标点：行左缘垂直居中 */
}

type QuoteMap = Record<string, Pick<Quote, "name" | "price" | "pct">>;

const EDGE_PAD = 8;

/**
 * 将原始 DOM 矩形数组转换为蜘蛛锚点数组。
 * - 过滤掉不可见/尺寸为 0 的
 * - 取左缘垂直居中作为蜘蛛落脚点（更像蜘蛛停在一行的开头）
 * - 用 quotes map 补全价格/名称
 */
export function rectsToAnchors(
  cardId: string,
  rects: AnchorRect[],
  vp: { w: number; h: number },
  quotes: QuoteMap,
): Anchor[] {
  const out: Anchor[] = [];
  rects.forEach((r, i) => {
    if (r.width <= 0 || r.height <= 0) return;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    // 整行中心需在视口内（虚拟滚动只保留已渲染且可见的行）
    if (cx < 0 || cy < 0 || cx > vp.w || cy > vp.h) return;

    const code = r.code?.trim();
    const q = code ? quotes[code] : undefined;
    out.push({
      ...r,
      id: code ? `${cardId}:${code}` : `${cardId}:${i}`,
      cardId,
      // 落脚点：行左缘内缩一点，垂直居中
      x: r.x + EDGE_PAD,
      y: cy,
      name: q?.name ?? r.name,
      price: q?.price ?? r.price,
      pct: q?.pct ?? r.pct,
      kind: r.kind ?? "row",
    });
  });
  return out;
}

/**
 * 卡片类型 → 行选择器配置。
 * - rowSel: 股票行选择器（返回的每一行都包含 code/name 等）
 * - extract: 从单个行元素中提取 code/name/price/pct
 * - headerSel: 标题栏选择器（无行卡片时停在标题栏）
 */
export interface CardAnchorConfig {
  rowSel: string;
  headerSel: string;
  extract: (el: Element) => { code?: string; name?: string; price?: number; pct?: number };
  /** 最多取多少行（避免全市场列表太长） */
  maxRows?: number;
}

export const CARD_ANCHOR_CONFIGS: Record<string, CardAnchorConfig> = {
  // ===== 自选股：table 行 =====
  watch: {
    rowSel: '[data-card-id="watch"] table.list tbody tr',
    headerSel: '[data-card-id="watch"] .list thead tr, [data-card-id="watch"] .groups',
    maxRows: 8,
    extract: (el) => {
      const code = el.querySelector(".cd")?.textContent?.trim() || undefined;
      const name = el.querySelector(".nm")?.textContent?.trim() || undefined;
      const priceText = el.querySelectorAll("td.r")[0]?.textContent?.trim();
      const pctText = el.querySelectorAll("td.r")[1]?.textContent?.trim();
      return {
        code,
        name,
        price: priceText ? parseFloat(priceText) : undefined,
        pct: pctText ? parseFloat(pctText.replace("%", "")) : undefined,
      };
    },
  },

  // ===== 涨幅榜：vrow 虚拟滚动行 =====
  rank: {
    rowSel: '[data-card-id="rank"] .vrow',
    headerSel: '[data-card-id="rank"] .thead-bar',
    maxRows: 8,
    extract: (el) => {
      const code = el.querySelector(".code")?.textContent?.trim() || undefined;
      const name = el.querySelector(".nm")?.textContent?.trim() || undefined;
      const priceText = el.querySelector(".price")?.textContent?.trim();
      const pctText = el.querySelector(".pct")?.textContent?.trim();
      return {
        code,
        name,
        price: priceText ? parseFloat(priceText) : undefined,
        pct: pctText ? parseFloat(pctText.replace("%", "")) : undefined,
      };
    },
  },

  // ===== 板块行情：trow 行 =====
  sector: {
    rowSel: '[data-card-id="sector"] .trow',
    headerSel: '[data-card-id="sector"] .thead',
    maxRows: 8,
    extract: (el) => {
      const name = el.querySelector(".c-name")?.textContent?.trim() || undefined;
      const pctText = el.querySelector(".c-pct")?.textContent?.trim();
      return {
        // 板块没有股票代码，用名称作唯一标识
        code: name ? `sector:${name}` : undefined,
        name,
        pct: pctText ? parseFloat(pctText.replace("%", "")) : undefined,
      };
    },
  },

  // ===== 概念题材：同板块（同组件不同 tab）=====
  concept: {
    rowSel: '[data-card-id="concept"] .trow',
    headerSel: '[data-card-id="concept"] .thead',
    maxRows: 8,
    extract: (el) => {
      const name = el.querySelector(".c-name")?.textContent?.trim() || undefined;
      const pctText = el.querySelector(".c-pct")?.textContent?.trim();
      return {
        code: name ? `concept:${name}` : undefined,
        name,
        pct: pctText ? parseFloat(pctText.replace("%", "")) : undefined,
      };
    },
  },

  // ===== 涨停雷达：list .row（涨停/炸板/跌停列表）=====
  radar: {
    rowSel: '[data-card-id="radar"] .list .row',
    headerSel: '[data-card-id="radar"] .tabs',
    maxRows: 6,
    extract: (el) => {
      const name = el.querySelector(".nm")?.textContent?.trim() || undefined;
      const pctText = el.querySelector(".pct")?.textContent?.trim();
      const priceText = el.querySelector(".pr")?.textContent?.trim();
      return {
        code: undefined, // 雷达行没暴露 code，留空
        name,
        price: priceText ? parseFloat(priceText) : undefined,
        pct: pctText ? parseFloat(pctText.replace("%", "")) : undefined,
      };
    },
  },

  // ===== 龙虎榜 =====
  dragon: {
    rowSel: '[data-card-id="dragon"] .list-row, [data-card-id="dragon"] .stock-item',
    headerSel: '[data-card-id="dragon"] .card-header, [data-card-id="dragon"] .tabs',
    maxRows: 6,
    extract: (el) => {
      const name = el.querySelector(".name, .nm")?.textContent?.trim() || undefined;
      const pctText = el.querySelector(".pct")?.textContent?.trim();
      return {
        code: undefined,
        name,
        pct: pctText ? parseFloat(pctText.replace("%", "")) : undefined,
      };
    },
  },

  // ===== 条件选股 =====
  screener: {
    rowSel: '[data-card-id="screener"] .result-row, [data-card-id="screener"] .vrow, [data-card-id="screener"] .trow',
    headerSel: '[data-card-id="screener"] .filter-bar, [data-card-id="screener"] .card-header',
    maxRows: 6,
    extract: (el) => {
      const code = el.querySelector(".code, .cd")?.textContent?.trim() || undefined;
      const name = el.querySelector(".name, .nm")?.textContent?.trim() || undefined;
      return { code, name };
    },
  },

  // ===== 盘中快讯 =====
  news: {
    rowSel: '[data-card-id="news"] .nf-item',
    headerSel: '[data-card-id="news"] .nf-status',
    maxRows: 6,
    extract: (el) => {
      const time = el.querySelector(".nf-time")?.textContent?.trim() || "";
      const text = el.querySelector(".nf-text")?.textContent?.trim() || "";
      const tag = el.querySelector(".nf-tag")?.textContent?.trim() || "";
      return {
        code: `news:${time}:${text.slice(0, 20)}`,
        name: tag ? `${tag} ${text.slice(0, 15)}` : text.slice(0, 20),
      };
    },
  },

  // ===== 短线精灵 =====
  spider: {
    rowSel: '[data-card-id="spider"] .stream .row',
    headerSel: '[data-card-id="spider"] .tabs, [data-card-id="spider"] .grid.head',
    maxRows: 8,
    extract: (el) => {
      const name = el.querySelector(".nm")?.textContent?.trim() || undefined;
      const pctText = el.querySelector(".pct")?.textContent?.trim();
      const desc = el.querySelector(".ds")?.textContent?.trim() || "";
      return {
        code: `spider:${name || desc.slice(0, 10)}`,
        name: name || desc.slice(0, 12),
        pct: pctText ? parseFloat(pctText.replace("%", "")) : undefined,
      };
    },
  },

  // ===== 板块异动 =====
  sectorevent: {
    rowSel: '[data-card-id="sectorevent"] .body .row',
    headerSel: '[data-card-id="sectorevent"] .tabs, [data-card-id="sectorevent"] .grid.head',
    maxRows: 6,
    extract: (el) => {
      const name = el.querySelector(".nm")?.textContent?.trim() || undefined;
      const pctText = el.querySelector(".pct")?.textContent?.trim();
      const label = el.querySelector(".ds")?.textContent?.trim() || "";
      return {
        code: name ? `sector:${name}` : undefined,
        name: name || label.slice(0, 12),
        pct: pctText ? parseFloat(pctText.replace("%", "")) : undefined,
      };
    },
  },

  // ===== 逐笔成交 =====
  trades: {
    rowSel: '[data-card-id="trades"] .trow',
    headerSel: '[data-card-id="trades"] .tape-head',
    maxRows: 8,
    extract: (el) => {
      const time = el.querySelector(".tm")?.textContent?.trim() || "";
      const price = el.querySelector(".pr")?.textContent?.trim();
      const vol = el.querySelector(".vl")?.textContent?.trim() || "";
      const side = el.querySelector(".arrow")?.textContent?.trim();
      return {
        code: `trade:${time}:${price}`,
        name: `${side || ""} ${vol}手`,
        price: price ? parseFloat(price) : undefined,
      };
    },
  },

  // ===== 集合竞价 =====
  auction: {
    rowSel: '[data-card-id="auction"] .grid.row',
    headerSel: '[data-card-id="auction"] .tabs, [data-card-id="auction"] .card-head',
    maxRows: 6,
    extract: (el) => {
      const code = el.querySelector(".code, .cd")?.textContent?.trim() || undefined;
      const name = el.querySelector(".name, .nm")?.textContent?.trim() || undefined;
      const pctText = el.querySelector(".pct")?.textContent?.trim();
      return {
        code,
        name,
        pct: pctText ? parseFloat(pctText.replace("%", "")) : undefined,
      };
    },
  },

  // ===== 涨停池明细 =====
  limitpool: {
    rowSel: '[data-card-id="limitpool"] .grid.zt.row, [data-card-id="limitpool"] .grid.zb.row',
    headerSel: '[data-card-id="limitpool"] .tabs, [data-card-id="limitpool"] .card-head',
    maxRows: 6,
    extract: (el) => {
      const code = el.querySelector(".code, .cd")?.textContent?.trim() || undefined;
      const name = el.querySelector(".name, .nm")?.textContent?.trim() || undefined;
      return { code, name };
    },
  },

  // ===== 大盘指数 =====
  market: {
    rowSel: '[data-card-id="market"] .idx',
    headerSel: '[data-card-id="market"] .card-head',
    maxRows: 5,
    extract: (el) => {
      const name = el.querySelector(".name")?.textContent?.trim() || undefined;
      const priceText = el.querySelector(".price")?.textContent?.trim();
      const pctText = el.querySelector(".pct")?.textContent?.trim();
      return {
        code: `index:${name || ""}`,
        name,
        price: priceText ? parseFloat(priceText) : undefined,
        pct: pctText ? parseFloat(pctText.replace("%", "")) : undefined,
      };
    },
  },

  // ===== 连板选股器 =====
  sieve: {
    rowSel: '[data-card-id="sieve"] .rows .row',
    headerSel: '[data-card-id="sieve"] .tabs, [data-card-id="sieve"] .card-head',
    maxRows: 6,
    extract: (el) => {
      const name = el.querySelector(".nm, .name")?.textContent?.trim() || undefined;
      const code = el.querySelector(".cd, .code")?.textContent?.trim() || undefined;
      const pctText = el.querySelector(".pct")?.textContent?.trim();
      return {
        code: code || `sieve:${name || ""}`,
        name,
        pct: pctText ? parseFloat(pctText.replace("%", "")) : undefined,
      };
    },
  },

  // ===== 题材库 =====
  themelib: {
    rowSel: '[data-card-id="themelib"] .tl-row',
    headerSel: '[data-card-id="themelib"] .card-head',
    maxRows: 6,
    extract: (el) => {
      const name = el.querySelector(".tl-row-top")?.textContent?.trim() || undefined;
      return {
        code: name ? `theme:${name}` : undefined,
        name: name?.slice(0, 16),
      };
    },
  },

  // ===== 复盘时间线 =====
  reviewtimeline: {
    rowSel: '[data-card-id="reviewtimeline"] .tl-item',
    headerSel: '[data-card-id="reviewtimeline"] .card-head',
    maxRows: 6,
    extract: (el) => {
      const text = el.textContent?.trim().slice(0, 20) || "";
      return {
        code: `review:${text}`,
        name: text,
      };
    },
  },

  // ===== 盯盘日记 =====
  journal: {
    rowSel: '[data-card-id="journal"] .jitem',
    headerSel: '[data-card-id="journal"] .card-head',
    maxRows: 5,
    extract: (el) => {
      const text = el.textContent?.trim().slice(0, 20) || "";
      return {
        code: `journal:${text}`,
        name: text,
      };
    },
  },
};

/** 获取某卡片的标题栏锚点（无行时的兜底落点） */
export function extractHeaderAnchor(
  cardId: string,
  config: CardAnchorConfig | undefined,
): Anchor | null {
  if (!config) return null;
  const el = document.querySelector(config.headerSel);
  if (!el) return null;
  const rc = el.getBoundingClientRect();
  if (rc.width <= 0 || rc.height <= 0) return null;
  return {
    id: `${cardId}:header`,
    cardId,
    x: rc.left + EDGE_PAD,
    y: rc.top + rc.height / 2,
    width: rc.width,
    height: rc.height,
    name: "标题栏",
    kind: "header",
  };
}
