// 自由布局工厂：卡片绝对定位、拖拽磁吸、碰撞整理、一键整齐排列
// 从 useWorkbench 抽出（行为不变）；通过 ctx 读写共享状态。
import { computed, ref } from "vue";
import type { Ref } from "vue";
import type { CardId } from "../../lib/cards";
import {
  GAP,
  COLS,
  ROW_UNIT,
  freeSizeOf,
  packFree,
  settleFreeRects,
} from "../../lib/layout";
import type { FreeRect } from "../../lib/layout";

export interface FreeLayoutContext {
  openCards: Ref<CardId[]>;
  timeMode: Ref<string | null>;
  pushUndo: () => void;
}

export function useFreeLayout(ctx: FreeLayoutContext) {
  const { openCards, timeMode, pushUndo } = ctx;

  const freeMode = ref(false);
  const freeRects = ref<Record<string, FreeRect>>({});
  const freeDrag = ref<(FreeRect & { id: CardId }) | null>(null);
  // 对齐辅助线（画布坐标 px；空数组=不显示）
  const alignGuides = ref<{ v: number[]; h: number[] }>({ v: [], h: [] });
  const freeCanvasRef = ref<HTMLElement | null>(null);

  // ===== 自由布局：开关 / 拖拽 =====
  function enableFree() {
    if (timeMode.value) timeMode.value = null;
    if (!freeMode.value) {
      pushUndo();
      freeRects.value = packFree(openCards.value);
    }
    freeMode.value = true;
  }
  function disableFree() {
    if (freeMode.value) pushUndo();
    freeMode.value = false;
    freeRects.value = {};
    freeDrag.value = null;
  }
  // 自由模式下新卡：放在画布最下方，再碰撞整理
  function placeNewFree(id: CardId) {
    const s = freeSizeOf(id);
    let maxY = 0;
    Object.values(freeRects.value).forEach((r) => { maxY = Math.max(maxY, r.y + r.h); });
    freeRects.value[id] = { x: 0, y: maxY, w: s.w, h: s.h };
    settleFreeRects(freeRects.value);
  }
  function clampNum(v: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, v));
  }
  function startFreeDrag(e: PointerEvent, id: CardId) {
    const rect = freeRects.value[id];
    const canvas = freeCanvasRef.value;
    if (!rect || !canvas) return;
    e.preventDefault();
    const base = { ...rect };
    freeDrag.value = { id, ...base };
    const cr = canvas.getBoundingClientRect();
    const cellW = (cr.width - (COLS + 1) * GAP) / COLS;
    let lastX = 0;
    let lastY = 0;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const mx = lastX - cr.left;
      const my = lastY - cr.top;
      const col = Math.round((mx - GAP) / (cellW + GAP));
      const row = Math.round((my - GAP) / (ROW_UNIT + GAP));
      let nx = clampNum(col - Math.round(base.w / 2), 0, COLS - base.w);
      let ny = clampNum(row - Math.round(base.h / 2), 0, 60);

      // ===== 边缘对齐 + 磁吸（在 nx/ny clamp 之后）=====
      const SNAP_X = 0.12; // 列单位（约 10px）
      const SNAP_Y = 10 / (ROW_UNIT + GAP); // 行单位（约 10px）
      alignGuides.value = { v: [], h: [] };
      const otherRects = Object.entries(freeRects.value)
        .filter(([k]) => k !== id)
        .map(([, r]) => r) as FreeRect[];
      type Cand = { d: number; axis: "x" | "y"; edge: number; move: number };
      const cands: Cand[] = [];
      const push = (d: number, axis: "x" | "y", edge: number, move: number) => {
        if (d <= (axis === "x" ? SNAP_X : SNAP_Y)) cands.push({ d, axis, edge, move });
      };
      for (const r of otherRects) {
        push(Math.abs(nx - r.x), "x", r.x, r.x - nx);
        push(Math.abs(nx - (r.x + r.w)), "x", r.x + r.w, r.x + r.w - nx);
        push(Math.abs(nx + base.w - r.x), "x", r.x, r.x - (nx + base.w));
        push(Math.abs(nx + base.w - (r.x + r.w)), "x", r.x + r.w, r.x + r.w - (nx + base.w));
        push(Math.abs(ny - r.y), "y", r.y, r.y - ny);
        push(Math.abs(ny - (r.y + r.h)), "y", r.y + r.h, r.y + r.h - ny);
        push(Math.abs(ny + base.h - r.y), "y", r.y, r.y - (ny + base.h));
        push(Math.abs(ny + base.h - (r.y + r.h)), "y", r.y + r.h, r.y + r.h - (ny + base.h));
      }
      if (cands.length) {
        const best = cands.reduce((a, b) => (a.d <= b.d ? a : b));
        if (best.axis === "x") {
          nx = clampNum(nx + best.move, 0, COLS - base.w);
          // 与 freeCellStyle 同一换算：x 像素 = edge * (画布宽 + GAP) / COLS
          alignGuides.value.v = [best.edge * ((cr.width + GAP) / COLS)];
        } else {
          ny = clampNum(ny + best.move, 0, 60);
          alignGuides.value.h = [GAP + best.edge * (ROW_UNIT + GAP)];
        }
      }

      freeDrag.value = { id, x: nx, y: ny, w: base.w, h: base.h };
    };
    const move = (ev: PointerEvent) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (!raf) raf = requestAnimationFrame(compute);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (raf) cancelAnimationFrame(raf);
      const g = freeDrag.value;
      if (g) {
        freeRects.value[id] = { x: g.x, y: g.y, w: g.w, h: g.h };
        settleFreeRects(freeRects.value);
      }
      alignGuides.value = { v: [], h: [] };
      freeDrag.value = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // 一键整理：以默认尺寸 shelf 装箱得到整齐坐标，保留用户当前尺寸，再碰撞收敛
  function tidyFree() {
    if (!freeMode.value) return;
    pushUndo();
    const ids = openCards.value;
    const packed = packFree(ids);
    const cur = freeRects.value;
    const next: Record<string, FreeRect> = {};
    ids.forEach((id) => {
      const p = packed[id];
      const keep = cur[id] ?? freeSizeOf(id);
      next[id] = { x: p.x, y: p.y, w: keep.w, h: keep.h };
    });
    settleFreeRects(next);
    freeRects.value = next;
  }
  // 自由卡定位样式（宽用百分比、高用固定像素）
  function freeCellStyle(id: CardId): Record<string, string> {
    const g = freeDrag.value && freeDrag.value.id === id ? freeDrag.value : freeRects.value[id];
    if (!g) return { display: "none" };
    return {
      position: "absolute",
      left: `calc(${g.x} * (100% + ${GAP}px) / ${COLS})`,
      width: `calc(${g.w} * (100% + ${GAP}px) / ${COLS} - ${GAP}px)`,
      top: `${GAP + g.y * (ROW_UNIT + GAP)}px`,
      height: `${g.h * (ROW_UNIT + GAP) - GAP}px`,
      zIndex: freeDrag.value && freeDrag.value.id === id ? "20" : "1",
    };
  }
  const freeHeight = computed(() => {
    let maxY = 0;
    const all: Record<string, FreeRect> = { ...freeRects.value };
    if (freeDrag.value) all[freeDrag.value.id] = freeDrag.value;
    Object.values(all).forEach((r) => { maxY = Math.max(maxY, r.y + r.h); });
    return GAP + maxY * (ROW_UNIT + GAP) + GAP;
  });

  return {
    freeMode,
    freeRects,
    freeDrag,
    alignGuides,
    freeCanvasRef,
    enableFree,
    disableFree,
    placeNewFree,
    startFreeDrag,
    tidyFree,
    freeCellStyle,
    freeHeight,
    clampNum,
  };
}
