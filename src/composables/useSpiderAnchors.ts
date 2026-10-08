// 锚点采集的 DOM 层：查询真实股票行 → getBoundingClientRect → 交给纯函数。
// 无单测（项目无 jsdom）；几何正确性由 anchors.ts 单测覆盖。
import { rectsToAnchors, type Anchor, type AnchorRect } from "../components/spider/anchors";
import { useQuotesStore } from "../stores/quotes";
import type { CardId } from "../lib/cards";

const ROW_SELECTORS: Partial<Record<CardId, string>> = {
  watch: '[data-card-id="watch"] table.list tbody tr',
  rank: '[data-card-id="rank"] .vrow',
};

function readRow(el: Element): AnchorRect | null {
  const rc = el.getBoundingClientRect();
  if (rc.width <= 0 || rc.height <= 0) return null;
  const code =
    el.querySelector(".cd")?.textContent?.trim() ||
    el.querySelector(".code")?.textContent?.trim() ||
    undefined;
  const name = el.querySelector(".nm")?.textContent?.trim() || undefined;
  return { x: rc.left, y: rc.top, width: rc.width, height: rc.height, code, name };
}

export function useSpiderAnchors() {
  const quotes = useQuotesStore();
  const vp = () => ({ w: window.innerWidth, h: window.innerHeight });

  function collect(cardId: CardId): Anchor[] {
    const sel = ROW_SELECTORS[cardId];
    if (!sel) {
      const title = cardCenter(cardId);
      return title ? [title] : [];
    }
    const rects: AnchorRect[] = [];
    document.querySelectorAll(sel).forEach((el) => {
      const r = readRow(el);
      if (r) rects.push(r);
    });
    return rectsToAnchors(cardId, rects, vp(), quotes.map);
  }

  /** 卡片中心（无股票行的卡片兜底落脚点 / 信号桥飞行终点）。 */
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
    };
  }

  return { collect, cardCenter, elCenter };
}
