// 卡片独立窗口的几何（位置 / 尺寸）持久化（localStorage），纯函数便于单测。
export interface Geometry {
  width: number;
  height: number;
  x?: number;
  y?: number;
}
const KEY = "tickgold.card-window.v1";
const DEFAULT: Geometry = { width: 960, height: 640 };

function safeLocal(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}
function readMap(s: Storage | undefined): Record<string, Geometry> {
  const raw = s?.getItem(KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, Geometry>;
  } catch {
    return {};
  }
}

export function loadGeometry(id: string, store?: Storage): Geometry {
  const s = store ?? safeLocal();
  const g = readMap(s)[id];
  if (g && g.width > 120 && g.height > 100) return { ...g };
  return { ...DEFAULT };
}

export function saveGeometry(id: string, g: Geometry, store?: Storage): void {
  const s = store ?? safeLocal();
  try {
    const map = readMap(s);
    map[id] = g;
    s?.setItem(KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}
