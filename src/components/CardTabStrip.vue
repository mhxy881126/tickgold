<script setup lang="ts">
import { inject, computed } from "vue";
import { CARD_META, type CardId } from "../lib/cards";
import type { useWorkbench } from "../composables/useWorkbench";

const emit = defineEmits<{
  (e: "activate", id: CardId): void;
  (e: "close", id: CardId): void;
  (e: "add"): void;
}>();

const bench = inject<ReturnType<typeof useWorkbench>>("workbench")!;

// 折叠态卡片在 tab 上给个小标记
const tabs = computed(() =>
  bench.openCards.value.map((id) => ({
    id,
    title: CARD_META[id]?.title ?? id,
    accent: CARD_META[id]?.accent ?? "#d4af37",
    collapsed: bench.isCollapsed(id),
  }))
);

function onTabClick(id: CardId) {
  emit("activate", id);
}
function onTabClose(id: CardId, e: MouseEvent) {
  e.stopPropagation();
  emit("close", id);
}
function onMiddleClose(id: CardId, e: MouseEvent) {
  if (e.button === 1) {
    e.preventDefault();
    emit("close", id);
  }
}
</script>

<template>
  <div class="card-tabstrip">
    <button
      v-for="t in tabs"
      :key="t.id"
      type="button"
      class="ctab"
      :class="{ on: bench.focusId.value === t.id, collapsed: t.collapsed }"
      @click="onTabClick(t.id)"
      @auxclick="(e) => onMiddleClose(t.id, e)"
    >
      <span class="ct-bar" :style="{ background: t.accent }"></span>
      <span class="ct-title">{{ t.title }}</span>
      <span v-if="t.collapsed" class="ct-fold" title="已折叠">▾</span>
      <span class="ct-x" @click="onTabClose(t.id, $event)">✕</span>
    </button>
    <button type="button" class="ct-add" title="打开卡片 (Ctrl+K)" @click="emit('add')">＋</button>
  </div>
</template>

<style scoped>
.card-tabstrip {
  flex: none;
  height: 34px;
  margin-top: 8px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px 10px 0 0;
  display: flex;
  align-items: stretch;
  padding: 0 6px;
  gap: 3px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}
.card-tabstrip::-webkit-scrollbar { height: 4px; }
.card-tabstrip::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

.ctab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font-size: 11.5px;
  cursor: pointer;
  white-space: nowrap;
  border-radius: 7px 7px 0 0;
  transition: background 0.14s, color 0.14s;
  max-width: 160px;
}
.ctab:hover { color: var(--text); background: var(--bg-hover); }
.ctab.on {
  color: var(--text);
  background: color-mix(in srgb, var(--accent) 10%, var(--bg));
}
.ctab.on::before {
  content: "";
  position: absolute; left: 10px; right: 10px; top: 0;
  height: 2px; border-radius: 2px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
}
.ct-bar {
  width: 3px; height: 14px; border-radius: 2px; flex: none;
}
.ct-title {
  overflow: hidden; text-overflow: ellipsis;
}
.ct-fold { font-size: 9px; opacity: 0.7; }
.ct-x {
  font-size: 10px; opacity: 0;
  padding: 0 2px; border-radius: 4px;
  transition: opacity 0.12s, background 0.12s;
}
.ctab:hover .ct-x { opacity: 0.7; }
.ct-x:hover { opacity: 1 !important; background: rgba(242, 54, 69, 0.2); color: #ff6b78; }

.ct-add {
  flex: none;
  width: 28px;
  border: 0; background: transparent;
  color: var(--text-dim);
  font-size: 16px; line-height: 1;
  cursor: pointer;
  border-radius: 6px;
}
.ct-add:hover { color: var(--accent-2); background: var(--bg-hover); }
</style>
