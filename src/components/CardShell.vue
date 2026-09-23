<script setup lang="ts">
const props = defineProps<{
  title: string;
  accent?: string;
  dragging?: boolean;
  freeDrag?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  dragstart: [];
  dragend: [];
  dragover: [ratio: number];
  drop: [];
  grab: [e: PointerEvent];
}>();

function onGrab(e: PointerEvent) {
  if (props.freeDrag) emit("grab", e);
}

function onDragStart(e: DragEvent) {
  // 从关闭按钮发起的拖拽不处理
  const t = e.target as HTMLElement;
  if (t.closest(".card-close")) {
    e.preventDefault();
    return;
  }
  e.dataTransfer?.setData("text/plain", props.title);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  emit("dragstart");
}
function onDragOver(e: DragEvent) {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  const head = e.currentTarget as HTMLElement;
  const r = head.getBoundingClientRect();
  emit("dragover", (e.clientY - r.top) / r.height);
}
function onDrop(e: DragEvent) {
  e.preventDefault();
  emit("drop");
}
</script>

<template>
  <div
    class="card-shell"
    :class="{ dragging }"
    :style="accent ? { '--accent-var': accent } : {}"
  >
    <header
      class="card-head"
      :draggable="!freeDrag"
      @dragstart="onDragStart"
      @dragend="emit('dragend')"
      @dragover="onDragOver"
      @drop="onDrop"
      @pointerdown="onGrab"
    >
      <span class="card-bar"></span>
      <svg viewBox="0 0 24 24" class="card-grip" title="按住拖动可调整位置">
        <circle cx="9" cy="6" r="1.4" fill="currentColor" />
        <circle cx="15" cy="6" r="1.4" fill="currentColor" />
        <circle cx="9" cy="12" r="1.4" fill="currentColor" />
        <circle cx="15" cy="12" r="1.4" fill="currentColor" />
        <circle cx="9" cy="18" r="1.4" fill="currentColor" />
        <circle cx="15" cy="18" r="1.4" fill="currentColor" />
      </svg>
      <span class="card-title">{{ title }}</span>
      <button class="card-close" title="关闭卡片" draggable="false" @click="emit('close')">
        <svg viewBox="0 0 24 24" width="13" height="13">
          <path
            fill="currentColor"
            d="M18.3 5.71 12 12.01l-6.3-6.3-1.4 1.4 6.3 6.3-6.3 6.3 1.4 1.4 6.3-6.3 6.3 6.3 1.4-1.4-6.3-6.3 6.3-6.3z"
          />
        </svg>
      </button>
    </header>
    <div class="card-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.card-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: linear-gradient(180deg, var(--bg-card) 0%, var(--bg-card2) 100%);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  transition: border-color 0.2s, opacity 0.2s, box-shadow 0.2s;
}
.card-shell:hover {
  border-color: var(--border-light);
}
/* 正在被拖拽的源卡片 */
.card-shell.dragging {
  opacity: 0.45;
  border-color: var(--accent-var, var(--accent));
  box-shadow: 0 0 0 1px var(--accent-var, var(--accent));
}

.card-head {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 8px 0 10px;
  border-bottom: 1px solid var(--border-light);
  flex-shrink: 0;
  cursor: grab;
}
.card-head:active {
  cursor: grabbing;
}
.card-bar {
  width: 3px;
  height: 13px;
  border-radius: 2px;
  background: var(--accent-var, var(--accent));
  flex-shrink: 0;
}
.card-grip {
  width: 12px;
  height: 12px;
  color: var(--text-dim);
  flex-shrink: 0;
}
.card-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.3px;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.card-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s;
}
.card-close:hover {
  background: var(--up);
  color: #fff;
}

.card-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
