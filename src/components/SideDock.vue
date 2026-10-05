<script setup lang="ts">
import { ref, inject, computed } from "vue";
import { DOCK_GROUPS, type DockGroup, type DockItem } from "../lib/dock";
import type { CardId } from "../lib/cards";

const emit = defineEmits<{ (e: "toggle", id: CardId): void; (e: "palette"): void }>();

// 工作台状态（从 App provide 注入；这里只需要 isOpen 判断高亮）
const bench = inject<{
  isOpen: (id: CardId) => boolean;
}>("workbench", null as any);

const activeGroup = ref<string | null>(null);
const hoverTimer = ref<number | null>(null);

function openGroup(g: DockGroup) {
  if (hoverTimer.value) { window.clearTimeout(hoverTimer.value); hoverTimer.value = null; }
  activeGroup.value = g.name;
}
function scheduleClose() {
  if (hoverTimer.value) window.clearTimeout(hoverTimer.value);
  hoverTimer.value = window.setTimeout(() => { activeGroup.value = null; }, 180);
}
function cancelClose() {
  if (hoverTimer.value) { window.clearTimeout(hoverTimer.value); hoverTimer.value = null; }
}
function pick(it: DockItem) {
  emit("toggle", it.id);
  // 打开卡片后不自动收起面板，方便连续开多张；Esc / 点击空白由 App 层处理
}

const current = computed<DockGroup | null>(
  () => DOCK_GROUPS.find((g) => g.name === activeGroup.value) ?? null
);
</script>

<template>
  <aside class="side-dock" @mouseleave="scheduleClose">
    <button
      v-for="g in DOCK_GROUPS"
      :key="g.name"
      type="button"
      class="dock-btn"
      :class="{ on: activeGroup === g.name }"
      @mouseenter="openGroup(g)"
      @focus="openGroup(g)"
      @click="activeGroup === g.name ? (activeGroup = null) : openGroup(g)"
    >
      <svg viewBox="0 0 24 24" class="d-ic"><path fill="currentColor" :d="g.icon" /></svg>
      <span class="d-label">{{ g.name.slice(0, 2) }}</span>
    </button>

    <div class="dock-sep"></div>

    <button type="button" class="dock-btn" title="命令面板 (Ctrl+K)" @click="emit('palette')">
      <svg viewBox="0 0 24 24" class="d-ic"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 10-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1114 9.5 4.5 4.5 0 019.5 14z" /></svg>
      <span class="d-label">命令</span>
    </button>

    <!-- 展开的分组面板：从 dock 右侧浮出 -->
    <Transition name="dpop">
      <div
        v-if="current"
        :key="current.name"
        class="dock-panel"
        @mouseenter="cancelClose"
        @mouseleave="scheduleClose"
      >
        <div class="dp-head">
          <h3>{{ current.name }}</h3>
          <span>{{ current.items.length }} 个功能</span>
        </div>
        <div class="dp-grid">
          <button
            v-for="it in current.items"
            :key="it.id"
            type="button"
            class="dp-item"
            :class="{ on: bench?.isOpen(it.id) }"
            @click="pick(it)"
          >
            <span class="dpi-ic">
              <svg viewBox="0 0 24 24"><path fill="currentColor" :d="it.icon" /></svg>
            </span>
            <span class="dpi-t">{{ it.label }}</span>
            <span class="dpi-d">{{ it.desc }}</span>
          </button>
        </div>
      </div>
    </Transition>
  </aside>
</template>

<style scoped>
.side-dock {
  position: relative;
  width: 56px;
  flex: none;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  gap: 2px;
  z-index: 45;
}
.dock-btn {
  width: 46px; height: 46px;
  border: 0; background: transparent;
  border-radius: 10px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
  color: var(--text-dim);
  cursor: pointer;
  transition: background 0.14s, color 0.14s;
  position: relative;
}
.d-ic { width: 19px; height: 19px; opacity: 0.85; }
.d-label { font-size: 9px; line-height: 1; letter-spacing: 0.2px; }
.dock-btn:hover { color: var(--text); background: var(--bg-hover); }
.dock-btn.on { color: var(--accent-2); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.dock-btn.on::before {
  content: ""; position: absolute; left: -5px; top: 10px; bottom: 10px;
  width: 3px; border-radius: 0 3px 3px 0; background: linear-gradient(180deg, var(--accent), var(--accent-2));
}
.dock-sep { width: 26px; height: 1px; background: var(--border); margin: 6px 0; }

/* dock 右侧浮出面板 */
.dock-panel {
  position: absolute;
  left: calc(100% - 2px); top: 0;
  width: 300px;
  background: color-mix(in srgb, var(--bg-panel) 97%, transparent);
  backdrop-filter: blur(18px);
  border: 1px solid var(--border);
  border-left: 0;
  border-radius: 0 12px 12px 0;
  box-shadow: 16px 16px 40px rgba(0, 0, 0, 0.5);
  padding: 12px 12px 14px;
  max-height: calc(100vh - 80px);
  overflow-y: auto;
}
.dp-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; padding: 0 4px; }
.dp-head h3 { margin: 0; font-size: 14px; color: var(--accent-2); }
.dp-head span { font-size: 11px; color: var(--text-dim); }
.dp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.dp-item {
  display: grid;
  grid-template-columns: 28px 1fr;
  grid-template-rows: auto auto;
  align-items: center;
  column-gap: 8px;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: var(--bg);
  color: var(--text);
  text-align: left; cursor: pointer;
  transition: border-color 0.14s, transform 0.14s;
}
.dpi-ic {
  grid-row: 1 / 3;
  width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--accent) 13%, transparent);
  color: var(--accent-2);
}
.dpi-ic svg { width: 15px; height: 15px; }
.dpi-t { font-size: 12px; font-weight: 700; line-height: 1.2; }
.dpi-d { font-size: 10px; color: var(--text-dim); line-height: 1.3; margin-top: 2px; }
.dp-item:hover {
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  transform: translateY(-1px);
}
.dp-item.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--bg)); }
.dp-item.on .dpi-t::after { content: " · 已开"; color: var(--accent-2); font-weight: 500; font-size: 10px; }

/* 面板过渡 */
.dpop-enter-active { transition: opacity 0.16s ease, transform 0.16s ease; }
.dpop-leave-active { transition: opacity 0.1s ease, transform 0.1s ease; }
.dpop-enter-from, .dpop-leave-to { opacity: 0; transform: translateX(-8px); }
</style>
