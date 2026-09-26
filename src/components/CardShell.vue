<template>
  <div
    ref="rootEl"
    class="card-shell"
    :class="{ focused, dragging, 'free-drag': freeDrag, collapsed, resizing }"
    :style="{ '--accent-var': effectiveColor }"
  >
    <div class="card-head" @pointerdown="onHeadDown" @dblclick="onDbl">
      <span class="card-bar" :style="{ background: effectiveColor }"></span>
      <svg class="head-ic grip" viewBox="0 0 24 24">
        <circle cx="9" cy="6" r="1.7" /><circle cx="15" cy="6" r="1.7" />
        <circle cx="9" cy="12" r="1.7" /><circle cx="15" cy="12" r="1.7" />
        <circle cx="9" cy="18" r="1.7" /><circle cx="15" cy="18" r="1.7" />
      </svg>
      <span class="card-title">{{ title }}</span>
      <span class="head-spacer"></span>
      <span class="head-tools">
        <button type="button" class="head-btn" :title="collapsed ? '展开' : '折叠'" @click.stop="$emit('collapse')">
          <svg viewBox="0 0 24 24"><path fill="currentColor" :d="collapsed ? 'M9 6l6 6-6 6z' : 'M6 9l6 6 6-6z'" /></svg>
        </button>
        <button v-if="!focused" type="button" class="head-btn" title="聚焦（主区放大）" @click.stop="$emit('focus')">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" /></svg>
        </button>
        <button v-else type="button" class="head-btn" title="还原布局" @click.stop="$emit('restore')">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" /></svg>
        </button>
        <button type="button" class="head-btn" title="卡片设置" @click.stop="cfgOpen = !cfgOpen">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0,.59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1112 8.4a3.6 3.6 0 010 7.2z" /></svg>
        </button>
        <button type="button" class="head-btn" title="关闭卡片" @click.stop="$emit('close')">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
        </button>
      </span>
    </div>

    <div class="card-body" :class="{ collapsed }">
      <slot />
    </div>

    <!-- 单卡设置弹层 -->
    <div v-if="cfgOpen" class="card-cfg" @pointerdown.stop>
      <div class="cfg-row">
        <span class="cfg-k">刷新频率</span>
        <select class="cfg-sel" :value="refresh" @change="onRefresh($event)">
          <option :value="0">跟随全局</option>
          <option :value="3">3 秒</option>
          <option :value="5">5 秒</option>
          <option :value="10">10 秒</option>
          <option :value="30">30 秒</option>
        </select>
      </div>
      <div class="cfg-row">
        <span class="cfg-k">强调色</span>
        <span class="cfg-sw">
          <button
            v-for="c in COLORS"
            :key="c"
            type="button"
            class="sw"
            :class="{ on: effectiveColor === c }"
            :style="{ background: c }"
            @click="onColor(c)"
          ></button>
        </span>
      </div>
      <button type="button" class="cfg-done" @click="cfgOpen = false">完成</button>
    </div>

    <!-- 右下角 resize 手柄 -->
    <button
      v-if="resizable"
      type="button"
      class="resize-h"
      title="拖拽调整卡片大小"
      @pointerdown="startResize"
    >
      <svg viewBox="0 0 24 24"><path fill="currentColor" d="M22 22h-6v-2h2.6L8 9.4V12H6V6h6v2H9.4L20 18.6V16h2v6z" /></svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";

const props = withDefaults(
  defineProps<{
    title: string;
    accent?: string;
    dragging?: boolean;
    freeDrag?: boolean;
    focused?: boolean;
    collapsed?: boolean;
    resizable?: boolean;
    span?: number;
    rspan?: number;
    refresh?: number;
    color?: string;
  }>(),
  {
    accent: "#e8c878",
    dragging: false,
    freeDrag: false,
    focused: false,
    collapsed: false,
    resizable: false,
    span: 3,
    rspan: 2,
    refresh: 0,
    color: "",
  }
);

const emit = defineEmits<{
  (e: "close"): void;
  (e: "focus"): void;
  (e: "restore"): void;
  (e: "grab", ev: PointerEvent): void;
  (e: "pdrag", ev: PointerEvent): void;
  (e: "collapse"): void;
  (e: "color", c: string): void;
  (e: "refresh", n: number): void;
  (e: "resize", w: number, h: number): void;
}>();

const rootEl = ref<HTMLElement | null>(null);
const cfgOpen = ref(false);
const resizing = ref(false);
const GAP = 12;
const COLORS = ["#e8c878", "#ef5f6b", "#6aa6e8", "#2fbf95", "#b08ce8"];
const effectiveColor = computed(() => props.color || props.accent);

// 头部按下：排除按钮区，其余触发拖拽（自由 / 网格）
function onHeadDown(e: PointerEvent) {
  if (e.button !== 0) return;
  const t = e.target as HTMLElement;
  if (t.closest("button,.card-cfg")) return;
  if (props.freeDrag) emit("grab", e);
  else emit("pdrag", e);
}
function onDbl() {
  emit("collapse");
}
function onColor(c: string) {
  emit("color", c);
}
function onRefresh(e: Event) {
  emit("refresh", Number((e.target as HTMLSelectElement).value));
}
function clampNum(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// resize：以当前跨度反推单元格宽高，按指针步进，实时 emit
function startResize(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const el = rootEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const w0 = props.span;
  const h0 = props.rspan;
  const colW = (r.width - (w0 - 1) * GAP) / w0;
  const rowH = (r.height - (h0 - 1) * GAP) / h0;
  const sx = e.clientX;
  const sy = e.clientY;
  resizing.value = true;
  const move = (ev: PointerEvent) => {
    const cw = clampNum(w0 + Math.round((ev.clientX - sx) / colW), 1, 12);
    const ch = clampNum(h0 + Math.round((ev.clientY - sy) / rowH), 1, 12);
    emit("resize", cw, ch);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    resizing.value = false;
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
</script>

<style scoped>
.card-shell {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: linear-gradient(180deg, var(--bg-card), var(--bg-card2));
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.card-shell:hover {
  border-color: color-mix(in srgb, var(--accent-var) 45%, var(--border));
}
.card-shell.focused {
  border-color: var(--accent-var);
  box-shadow: 0 0 0 1px var(--accent-var), 0 18px 44px rgba(0, 0, 0, 0.5);
}
.card-shell.resizing {
  border-color: var(--accent-var);
  box-shadow: 0 0 0 1px var(--accent-var);
}
.card-shell.dragging {
  opacity: 0.94;
  border-color: var(--accent-var);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.5);
}
.card-bar {
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 2px;
  background: var(--accent-var);
}
.card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px 7px 10px;
  cursor: grab;
  user-select: none;
  flex: none;
}
.card-shell.free-drag .card-head {
  cursor: move;
}
.card-head:active {
  cursor: grabbing;
}
.head-ic {
  width: 14px;
  height: 14px;
  color: var(--text-dim);
  flex: none;
}
.grip {
  opacity: 0.7;
}
.card-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.head-spacer {
  flex: 1;
}
.head-tools {
  display: flex;
  align-items: center;
  gap: 1px;
  opacity: 0;
  transition: opacity 0.16s;
}
.card-shell:hover .head-tools,
.card-shell.focused .head-tools {
  opacity: 1;
}
.head-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: 5px;
  cursor: pointer;
}
.head-btn svg {
  width: 13px;
  height: 13px;
}
.head-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.card-body {
  flex: 1;
  min-height: 0;
  padding: 8px 10px 10px;
  overflow: hidden;
}
.card-body.collapsed {
  display: none;
}
.resize-h {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-dim);
  opacity: 0;
  cursor: nwse-resize;
  border-radius: 4px;
}
.resize-h svg {
  width: 14px;
  height: 14px;
}
.card-shell:hover .resize-h {
  opacity: 0.75;
}
.resize-h:hover {
  opacity: 1 !important;
  color: var(--accent-var);
  background: var(--bg-hover);
}
.card-cfg {
  position: absolute;
  top: 34px;
  right: 8px;
  width: 214px;
  z-index: 40;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-panel);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.6);
}
.cfg-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 9px;
}
.cfg-k {
  font-size: 11px;
  color: var(--text-dim);
  width: 52px;
  flex: none;
}
.cfg-sel {
  flex: 1;
  height: 24px;
  background: var(--bg-card);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 11px;
  padding: 0 4px;
}
.cfg-sw {
  display: flex;
  gap: 6px;
}
.sw {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  cursor: pointer;
}
.sw.on {
  outline: 2px solid rgba(255, 255, 255, 0.55);
  outline-offset: 1px;
}
.cfg-done {
  width: 100%;
  height: 26px;
  margin-top: 2px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: 11px;
  cursor: pointer;
}
.cfg-done:hover {
  border-color: var(--accent-var);
  color: var(--accent-var);
}
</style>
