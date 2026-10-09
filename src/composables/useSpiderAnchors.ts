// 锚点采集的 DOM 层：查询真实股票行 → getBoundingClientRect → 交给纯函数。
// 支持多种卡片类型：watch / rank / sector / concept / radar / dragon / screener
import {
  rectsToAnchors,
  CARD_ANCHOR_CONFIGS,
  extractHeaderAnchor,
  type Anchor,
  type AnchorRect,
} from "../components/spider/anchors";
import { useQuotesStore } from "../stores/quotes";
import type { CardId } from "../lib/cards";

function readRow(el: Element, cardId: string): AnchorRect | null {
  const rc = el.getBoundingClientRect();
  if (rc.width <= 0 || rc.height <= 0) return null;

  const cfg = CARD_ANCHOR_CONFIGS[cardId];
  if (!cfg) return { x: rc.left, y: rc.top, width: rc.width, height: rc.height };

  const data = cfg.extract(el);
  return {
    x: rc.left,
    y: rc.top,
    width: rc.width,
    height: rc.height,
    code: data.code,
    name: data.name,
    price: data.price,
    pct: data.pct,
    kind: "row",
  };
}

/** 判断矩形是否完全在视口外（快速跳过，不调用 getBoundingClientRect） */
function isOffscreenQuick(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  return false;
}

/** 计算一组矩形的粗略哈希，用于缓存判断 */
function hashRects(rects: AnchorRect[]): string {
  if (rects.length === 0) return "empty";
  let h = rects.length.toString();
  for (let i = 0; i < Math.min(rects.length, 6); i++) {
    const r = rects[i];
    h += `|${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.width)}:${r.code || ""}`;
  }
  return h;
}

export function useSpiderAnchors() {
  const quotes = useQuotesStore();
  const vp = () => ({ w: window.innerWidth, h: window.innerHeight });

  // 缓存：cardId -> { hash, result, time }
  const cache = new Map<string, { hash: string; result: Anchor[]; time: number }>();
  const CACHE_TTL = 800; // 缓存 800ms，足够蜘蛛走完一张卡

  /**
   * 采集某卡片的所有行锚点。
   * - 有行选择器的卡片：返回真实行锚点（含 code/name/price/pct）
   * - 无行选择器或无行的卡片：返回标题栏锚点（蜘蛛停在标题栏）
   * - 带缓存 + 离屏快速跳过，性能更优
   */
  function collect(cardId: CardId): Anchor[] {
    const now = Date.now();
    const cfg = CARD_ANCHOR_CONFIGS[cardId];

    // 没有配置的卡片：返回卡片中心（轻量，不需要缓存）
    if (!cfg) {
      const title = cardCenter(cardId);
      return title ? [title] : [];
    }

    // 先查卡片是否存在且可见（快速跳过）
    const cardEl = document.querySelector(`[data-card-id="${cardId}"]`);
    if (!cardEl || isOffscreenQuick(cardEl)) {
      return [];
    }

    const rows = document.querySelectorAll(cfg.rowSel);
    const rects: AnchorRect[] = [];
    const maxRows = cfg.maxRows ?? 8;

    // 视口边界（用于快速离屏判断）
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const PAD = 100; // 容错边距

    for (let i = 0; i < rows.length && rects.length < maxRows; i++) {
      const el = rows[i];

      // 快速离屏判断：先看元素位置再取 rect（减少 reflow）
      if (isOffscreenQuick(el)) continue;

      const r = readRow(el, cardId);
      if (!r) continue;

      // 完全在视口外的跳过（减少后续处理）
      if (r.y + r.height < -PAD || r.y > vh + PAD) continue;
      if (r.x + r.width < -PAD || r.x > vw + PAD) continue;

      rects.push(r);
    }

    // 计算哈希，检查缓存
    const hash = hashRects(rects);
    const cached = cache.get(cardId);
    if (cached && cached.hash === hash && now - cached.time < CACHE_TTL) {
      return cached.result;
    }

    let result: Anchor[];

    // 有行 → 行锚点
    if (rects.length > 0) {
      result = rectsToAnchors(cardId, rects, vp(), quotes.map);
    } else {
      // 无行 → 标题栏锚点（蜘蛛停在标题栏）
      const header = extractHeaderAnchor(cardId, cfg);
      result = header ? [header] : [];
    }

    // 写入缓存
    cache.set(cardId, { hash, result, time: now });

    // 清理过期缓存（最多保留 10 个）
    if (cache.size > 10) {
      let oldest = "";
      let oldestTime = Infinity;
      for (const [k, v] of cache) {
        if (v.time < oldestTime) {
          oldestTime = v.time;
          oldest = k;
        }
      }
      if (oldest) cache.delete(oldest);
    }

    return result;
  }

  /** 卡片中心（兜底落脚点 / 信号桥飞行终点）。 */
  function cardCenter(cardId: CardId): Anchor | null {
    const el = document.querySelector(`[data-card-id="${cardId}"]`);
    return elCenter(el, cardId);
  }

  /** 任意元素中心（爬虫日志面板兜底终点用）。 */
  function elCenter(el: Element | null | undefined, cardId = "log"): Anchor | null {
    if (!el) return null;
    const rc = el.getBoundingClientRect();
    if (rc.width <= 0 || rc.height <= 0) return null;
    return {
      id: `${cardId}:center`,
      cardId,
      x: rc.left + rc.width / 2,
      y: rc.top + rc.height / 2,
      width: rc.width,
      height: rc.height,
      kind: "card-center",
    };
  }

  /** 手动清除某卡片的缓存（滚动时调用） */
  function invalidateCache(cardId: CardId) {
    cache.delete(cardId);
  }

  return { collect, cardCenter, elCenter, invalidateCache };
}
