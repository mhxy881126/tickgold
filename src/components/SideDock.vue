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

// 每个分组已开卡片数（用于红色 badge）
function groupCount(g: DockGroup): number {
  return g.items.filter((it) => bench?.isOpen(it.id)).length;
}

function openGroup(g: DockGroup) {
  if (hoverTimer.value) { window.clearTimeout(hoverTimer.value); hoverTimer.value = null; }
  activeGroup.value = g.name;
}
function scheduleClose() {
  if (hoverTimer.value) window.clearTimeout(hoverTimer.value);
  hoverTimer.value = window.setTimeout(() => { activeGroup.value = null; }, 280);
}
function cancelClose() {
  if (hoverTimer.value) { window.clearTimeout(hoverTimer.value); hoverTimer.value = null; }
}
// 鼠标离开 Dock 时：如果是移向浮出面板（relatedTarget 在 .dock-panel 内），不关闭
function onDockLeave(e: MouseEvent) {
  const rt = e.relatedTarget as Node | null;
  if (rt && (rt as HTMLElement).closest?.(".dock-panel")) return;
  scheduleClose();
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
  <aside class="side-dock" @mouseleave="onDockLeave">
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
      <span v-if="groupCount(g) > 0" class="d-badge">{{ groupCount(g) }}</span>
      <span class="d-ic">
        <svg viewBox="0 0 24 24"><path fill="currentColor" :d="g.icon" /></svg>
      </span>
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
  width: 68px;
  flex: none;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 0;
  gap: 2px;
  z-index: 90;
}
.dock-btn {
  width: 54px; padding: 6px 0;
  border: 0; background: transparent;
  border-radius: 8px;
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  color: var(--text-dim);
  cursor: pointer;
  transition: background 0.14s, color 0.14s;
  position: relative;
}
.dock-btn .d-ic {
  width: 22px; height: 22px; border-radius: 6px;
  background: rgba(255,255,255,.05);
  display: flex; align-items: center; justify-content: center;
  transition: all .18s;
}
.d-ic svg { width: 13px; height: 13px; opacity: .85; }
.d-label { font-size: 9px; line-height: 1; letter-spacing: 1px; }
.dock-btn:hover { color: var(--text); background: rgba(232,184,96,.08); }
.dock-btn.on { color: var(--text); background: rgba(232,184,96,.08); }
.dock-btn.on .d-ic {
  background: linear-gradient(135deg, #e8c878, #b8923a);
}
.dock-btn.on .d-ic svg { opacity: 1; color: #000; }
.dock-sep { width: 30px; height: 1px; background: var(--border); margin: 6px 0; }
.d-badge {
  position: absolute; top: 2px; right: 4px;
  min-width: 14px; height: 14px; border-radius: 7px;
  background: #ef5f6b; color: #fff;
  font-size: 8.5px; font-weight: 700; line-height: 14px;
  text-align: center; padding: 0 3px;
  z-index: 2;
}

/* dock 右侧浮出面板 */
.dock-panel {
  position: absolute;
  left: calc(100% - 2px); top: 0;
  width: 250px;
  background: rgba(14,17,22,.97);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255,255,255,.1);
  border-left: 0;
  border-radius: 0 10px 10px 0;
  box-shadow: 20px 20px 50px rgba(0,0,0,.6);
  padding: 10px;
  max-height: calc(100vh - 80px);
  overflow-y: auto;
}
.dp-head {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-bottom: 8px; padding: 4px 6px;
}
.dp-head h3 { margin: 0; font-size: 10px; color: #e8c878; letter-spacing: 2px; font-weight: 600; }
.dp-head span { font-size: 9px; color: var(--text-dim); letter-spacing: 0; }
.dp-grid { display: flex; flex-direction: column; gap: 2px; }
.dp-item {
  display: grid;
  grid-template-columns: 28px 1fr;
  grid-template-rows: auto auto;
  align-items: center;
  column-gap: 8px;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  text-align: left; cursor: pointer;
  transition: background 0.14s, border-color 0.14s;
}
.dpi-ic {
  grid-row: 1 / 3;
  width: 28px; height: 28px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700;
}
.dpi-ic svg { width: 15px; height: 15px; }
.dpi-t { font-size: 12px; font-weight: 400; line-height: 1.2; display: flex; align-items: center; gap: 6px; }
.dpi-d { font-size: 9.5px; color: var(--text-dim); line-height: 1.3; margin-top: 1px; }
.dp-item:hover { background: rgba(255,255,255,.05); }
.dp-item.on { background: rgba(232,184,96,.08); border-color: rgba(232,184,96,.25); }
.dp-item.on .dpi-t::after {
  content: ""; width: 6px; height: 6px; border-radius: 50%;
  background: #e8c878; box-shadow: 0 0 6px #e8c878;
}

/* 面板过渡 */
.dpop-enter-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.dpop-leave-active { transition: opacity 0.1s ease, transform 0.1s ease; }
.dpop-enter-from, .dpop-leave-to { opacity: 0; transform: translateX(-8px); }
</style>
