<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { CardId } from "../../composables/useWorkbench";
import { useWorkbench } from "../../composables/useWorkbench";
import { useCardMarketLayer } from "../../composables/useMarketContext";
import { useWidgetSource } from "../../composables/useWidgetSource";
import { WIDGET_COLS, type WidgetInstance } from "../../lib/widgets";
import { widgetDefOf } from "./registry";
import WidgetShell from "./WidgetShell.vue";

// 卡内 12 列网格画布：与外层 Bento 解耦；编辑态显示微件外壳与下方托盘
const props = defineProps<{ id: CardId; editing: boolean }>();
const emitCanvas = defineEmits<{
  popout: [cardId: CardId, widgetId: string];
}>();

// 弹窗 provide 只读源时用只读源；主窗缺省回落可写 bench
const source = useWidgetSource();
const bench = useWorkbench();
const widgets = computed(() =>
  source ? source.widgetsOf(props.id) : bench.widgetsOf(props.id)
);
// 卡级行情层：卡主绑定覆盖全局选中（primary 缺省跟随全局）
const primaryRef = computed(() => widgets.value?.primary ?? null);
useCardMarketLayer(primaryRef);

const wrapEl = ref<HTMLElement | null>(null);
const wrapW = ref(0);
const wrapH = ref(0);
let ro: ResizeObserver | null = null;

const rows = computed(() =>
  Math.max(1, ...(widgets.value?.items ?? []).map((i) => i.y + i.h))
);
const GAP = 8;
// 单元尺寸：宽按容器 12 列反算；行高按实际行数铺满容器
const colW = computed(() =>
  wrapW.value ? (wrapW.value - (WIDGET_COLS - 1) * GAP) / WIDGET_COLS : 0
);
const rowH = computed(() =>
  wrapH.value ? (wrapH.value - (rows.value - 1) * GAP) / rows.value : 0
);
const strideW = computed(() => colW.value + GAP);
const strideH = computed(() => rowH.value + GAP);
const canvasH = computed(() => rows.value * strideH.value - GAP);

// ===== 微件拖拽（rAF + elementFromPoint，阈值 6px，Esc 还原）=====
interface DragState {
  sx: number; sy: number; active: boolean; esc: boolean;
  wId: string; before: WidgetInstance[];
}
let drag: DragState | null = null;
let lastX = 0, lastY = 0, raf = 0;

function targetIndex(wId: string): number | null {
  const el = document.elementFromPoint(lastX, lastY) as HTMLElement | null;
  const cellEl = el?.closest?.(".widget-cell") as HTMLElement | null;
  const targetId = cellEl?.getAttribute("data-widget-id");
  const items = widgets.value?.items ?? [];
  if (targetId && targetId !== wId) {
    const rest = items.filter((i) => i.id !== wId);
    const ti = rest.findIndex((i) => i.id === targetId);
    if (ti < 0) return null;
    const r = cellEl!.getBoundingClientRect();
    // 纵向为主、横向为辅判定插入前/后
    const score =
      0.7 * ((lastY - r.top) / r.height) +
      0.3 * ((lastX - r.left) / r.width);
    return score > 0.5 ? ti + 1 : ti;
  }
  return null;
}
function compute() {
  raf = 0;
  if (!drag) return;
  const idx = targetIndex(drag.wId);
  if (idx !== null) bench.reorderWidgetInst(props.id, drag.wId, idx);
}
function onDragStart(wId: string, e: PointerEvent) {
  if (e.button !== 0) return;
  drag = {
    sx: e.clientX, sy: e.clientY, active: false, esc: false, wId,
    before: (widgets.value?.items ?? []).map((i) => ({ ...i })),
  };
  lastX = e.clientX; lastY = e.clientY;
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("keydown", onKey);
}
function onMove(ev: PointerEvent) {
  if (!drag) return;
  const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
  if (!drag.active && Math.hypot(dx, dy) < 6) return;
  drag.active = true;
  lastX = ev.clientX; lastY = ev.clientY;
  if (!raf) raf = requestAnimationFrame(compute);
}
function onKey(ev: KeyboardEvent) {
  if (drag && ev.key === "Escape") drag.esc = true;
}
function onUp() {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("keydown", onKey);
  if (raf) cancelAnimationFrame(raf);
  // Esc：整体还原拖拽前布局
  if (drag?.esc && drag.active && widgets.value) {
    bench.setWidgets(props.id, { ...widgets.value, items: drag.before });
  }
  drag = null;
}

// ===== resize：跨度反算，clamp 到 def 最小跨度与 12 列 =====
function onResizeStart(wId: string, e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const inst = widgets.value?.items.find((i) => i.id === wId);
  const def = inst ? widgetDefOf(inst.def) : undefined;
  if (!inst || !def) return;
  const sx = e.clientX, sy = e.clientY;
  const w0 = inst.w, h0 = inst.h;
  const move = (ev: PointerEvent) => {
    const cw = Math.round(w0 + (ev.clientX - sx) / strideW.value);
    const ch = Math.round(h0 + (ev.clientY - sy) / strideH.value);
    bench.resizeWidgetInst(props.id, wId, cw, ch);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function onRemove(wId: string) {
  bench.removeWidgetInst(props.id, wId);
}
function onBind(wId: string, code: string | null) {
  bench.patchWidgetInst(props.id, wId, { bind: code });
}
function onEditText(wId: string, text: string) {
  bench.patchWidgetInst(props.id, wId, { text });
}

function measure() {
  const el = wrapEl.value;
  if (!el) return;
  wrapW.value = el.clientWidth;
  wrapH.value = el.clientHeight;
}
onMounted(async () => {
  await nextTick();
  measure();
  if (wrapEl.value) {
    ro = new ResizeObserver(measure);
    ro.observe(wrapEl.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());
watch(() => props.id, () => nextTick(measure));
</script>

<template>
  <div ref="wrapEl" class="wc-wrap">
    <div class="wc-canvas" :style="{ height: `${canvasH}px` }">
      <WidgetShell
        v-for="it in widgets?.items"
        :key="it.id"
        :inst="it"
        :editing="editing"
        :stride-w="strideW"
        :stride-h="strideH"
        :gap="GAP"
        :card-id="props.id"
        @remove="onRemove"
        @drag-start="onDragStart"
        @resize-start="onResizeStart"
        @bind="onBind"
        @edit-text="onEditText"
        @popout="(c: CardId, w: string) => emitCanvas('popout', c, w)"
      />
      <div
        v-if="editing && !(widgets?.items.length)"
        class="wc-empty"
      >从下方托盘添加微件，开始编排本卡</div>
    </div>
  </div>
</template>

<style scoped>
.wc-wrap { position: absolute; inset: 0; min-height: 0; overflow: hidden; }
.wc-canvas { position: relative; width: 100%; }
.wc-empty { position: absolute; inset: 0; display: flex; align-items: center;
  justify-content: center; color: var(--text-dim); font-size: 11px;
  border: 1px dashed var(--border); border-radius: 8px; }
</style>
