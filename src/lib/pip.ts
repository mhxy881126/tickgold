// 画中岛（pip）纯函数：窗口 label 编解码、默认尺寸、几何持久化。
// 不依赖 Vue（除类型），便于单测。
import type { CardId } from "./cards";
import type { WidgetInstance } from "./widgets";

export type PipTarget =
  | { kind: "card"; cardId: CardId }
  | { kind: "widget"; cardId: CardId; widgetId: string };

// ===== label 编解码 =====
export function pipLabel(t: PipTarget): string {
  return t.kind === "card"
    ? `pip-card-${t.cardId}`
    : `pip-widget-${t.cardId}-${t.widgetId}`;
}

export function parsePipLabel(label: string): PipTarget | null {
  if (!label.startsWith("pip-")) return null;
  const rest = label.slice(4);
  const cardPrefix = "card-";
  const widgetPrefix = "widget-";
  if (rest.startsWith(cardPrefix)) {
    const cardId = rest.slice(cardPrefix.length);
    return cardId ? { kind: "card", cardId: cardId as CardId } : null;
  }
  if (rest.startsWith(widgetPrefix)) {
    const body = rest.slice(widgetPrefix.length);
    const sep = body.indexOf("-");
    if (sep <= 0 || sep >= body.length - 1) return null;
    const cardId = body.slice(0, sep);
    const widgetId = body.slice(sep + 1);
    return { kind: "widget", cardId: cardId as CardId, widgetId };
  }
  return null;
}

// ===== 默认窗口尺寸 =====
export const PIP_MIN_W = 280;
export const PIP_MIN_H = 180;
export const PIP_MAX_W = 720;
export const PIP_MAX_H = 560;
export const PIP_CARD_DEFAULT = { w: 480, h: 360 };

const COL_PX = 40;
const ROW_PX = 36;

function clampSize(w: number, h: number): { w: number; h: number } {
  return {
    w: Math.max(PIP_MIN_W, Math.min(PIP_MAX_W, Math.round(w))),
    h: Math.max(PIP_MIN_H, Math.min(PIP_MAX_H, Math.round(h))),
  };
}

// 单微件：跨度 → 像素（无边框小窗），clamp 到窗口上下限
export function widgetWindowSize(
  inst: Pick<WidgetInstance, "w" | "h">
): { w: number; h: number } {
  return clampSize(inst.w * COL_PX, inst.h * ROW_PX);
}

// ===== 几何持久化 =====
export interface PipGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PipGeometryMap = Record<string, PipGeometry>;

export function defaultGeometry(t: PipTarget, inst?: WidgetInstance): PipGeometry {
  if (t.kind === "card") return { ...PIP_CARD_DEFAULT, x: 120, y: 120 };
  const s = inst ? widgetWindowSize(inst) : { w: PIP_MIN_W, h: PIP_MIN_H };
  return { ...s, x: 120, y: 120 };
}

// 从持久化 JSON 解析某 label 的几何：无记录 / 越界 / 坏 JSON 均回落默认
export function resolveGeometry(
  raw: string | null | undefined,
  t: PipTarget,
  inst?: WidgetInstance
): PipGeometry {
  const fallback = defaultGeometry(t, inst);
  if (!raw) return fallback;
  let map: unknown;
  try {
    map = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof map !== "object" || map === null) return fallback;
  const g = (map as PipGeometryMap)[pipLabel(t)];
  if (!g) return fallback;
  const { x, y, w, h } = g;
  if (
    typeof x !== "number" || typeof y !== "number" ||
    typeof w !== "number" || typeof h !== "number"
  )
    return fallback;
  if (w < PIP_MIN_W || h < PIP_MIN_H) return fallback;
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(Math.min(w, 1920)),
    h: Math.round(Math.min(h, 1080)),
  };
}

// 几何写回：在已有 JSON 上更新某 label，返回新 JSON（解析失败则从空 map 开始）
export function upsertGeometry(
  raw: string | null | undefined,
  label: string,
  g: PipGeometry
): string {
  let map: PipGeometryMap = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) map = parsed as PipGeometryMap;
    } catch {
      /* 坏 JSON 重置 */
    }
  }
  map[label] = { ...g };
  return JSON.stringify(map);
}
