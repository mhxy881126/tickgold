// DOM 矩形 → 蜘蛛锚点的几何纯函数：不碰 document，可在 node 单测。
import type { Quote } from "../../api/types";

export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
  code?: string;
  name?: string;
}

export interface Anchor extends AnchorRect {
  id: string;
  cardId: string;
  /** 落脚/光束目标点：行左缘垂直居中 */
  price?: number;
  pct?: number;
}

type QuoteMap = Record<string, Pick<Quote, "name" | "price" | "pct">>;

const EDGE_PAD = 6;

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
      x: r.x + EDGE_PAD,
      y: cy,
      name: q?.name ?? r.name,
      price: q?.price,
      pct: q?.pct,
    });
  });
  return out;
}
