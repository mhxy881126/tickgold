<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { SCENES, type Scene } from "../lib/scenes";

const props = defineProps<{ currentId: string | null }>();
const emit = defineEmits<{ (e: "select", sc: Scene): void }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

// currentId 为 null 表示当前处于时段驾驶舱 / 整组 / 自定义布局（无固定场景），
// 此时按钮显示中性入口，下拉内不高亮任何场景。
const TPL_ICON =
  "M3 11h8V3H3v8zm2-6h4v4H5V5zm8-2v8h8V3h-8zm6 6h-4V5h4v4zM3 21h8v-8H3v8zm2-6h4v4H5v-4zm8-2v8h8v-8h-8zm6 6h-4v-4h4v4z";

const current = computed<Scene | null>(
  () => SCENES.find((s) => s.id === props.currentId) ?? null
);
const btnLabel = computed(() => current.value?.label ?? "场景模板");
const btnIcon = computed(() => current.value?.icon ?? TPL_ICON);

function toggle() {
  open.value = !open.value;
}
function pick(sc: Scene) {
  open.value = false;
  if (sc.id !== props.currentId) emit("select", sc);
}
// 前一个场景是否为非打法模板（用于在首个打法模板前插入分隔标题）
function isBuiltinHead(i: number): boolean {
  const sc = SCENES[i];
  return !!sc.builtin && (i === 0 || !SCENES[i - 1].builtin);
}
function onDocClick(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") open.value = false;
}
onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div class="scene-switcher" ref="root">
    <button
      type="button"
      class="ss-btn"
      data-tauri-drag-region="false"
      :class="{ on: open, placeholder: !current }"
      :title="'切换盯盘场景'"
      @click="toggle"
    >
      <svg class="ss-ic" viewBox="0 0 24 24"><path fill="currentColor" :d="btnIcon" /></svg>
      <span class="ss-tx">{{ btnLabel }}</span>
      <svg class="ss-caret" viewBox="0 0 24 24" :class="{ up: open }"><path fill="currentColor" d="M7 10l5 5 5-5z" /></svg>
    </button>

    <Transition name="sspop">
      <div v-if="open" class="ss-menu" data-tauri-drag-region="false">
        <template v-for="(sc, i) in SCENES" :key="sc.id">
          <div v-if="isBuiltinHead(i)" class="ss-head">打法模板</div>
          <button
            type="button"
            class="ss-item"
            :class="{ cur: sc.id === currentId }"
            @click="pick(sc)"
          >
            <svg class="ss-ic-sm" viewBox="0 0 24 24"><path fill="currentColor" :d="sc.icon" /></svg>
            <span class="ss-nm">{{ sc.label }}</span>
            <svg v-if="sc.id === currentId" class="ss-check" viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.2l-3.5-3.5L4 14.2l5 5 11-11-1.5-1.5z" /></svg>
          </button>
        </template>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.scene-switcher {
  position: relative;
  margin-right: 10px;
}
.ss-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 26px;
  padding: 0 9px 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.ss-btn:hover,
.ss-btn.on {
  border-color: rgba(232, 184, 96, 0.45);
  color: var(--accent);
  background: rgba(232, 184, 96, 0.08);
}
.ss-ic {
  width: 14px;
  height: 14px;
  flex: none;
  color: var(--accent-2);
}
.ss-btn:hover .ss-ic,
.ss-btn.on .ss-ic {
  color: var(--accent);
}
.ss-caret {
  width: 13px;
  height: 13px;
  flex: none;
  color: var(--text-dim);
  transition: transform 0.16s ease;
}
.ss-caret.up {
  transform: rotate(180deg);
}
.ss-btn.placeholder .ss-ic {
  color: var(--text-dim);
}
.ss-btn.placeholder:hover .ss-ic,
.ss-btn.placeholder.on .ss-ic {
  color: var(--accent);
}
.ss-menu {
  position: absolute;
  top: calc(100% + 7px);
  left: 0;
  min-width: 176px;
  padding: 6px;
  background: rgba(14, 17, 22, 0.97);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 11px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
  z-index: 200;
}
.ss-head {
  padding: 7px 10px 4px;
  font-size: 9.5px;
  letter-spacing: 2px;
  color: var(--text-dim);
  border-top: 1px solid var(--border);
  margin-top: 4px;
}
.ss-head:first-child {
  border-top: 0;
  margin-top: 0;
  padding-top: 2px;
}
.ss-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.ss-item .ss-ic-sm {
  width: 15px;
  height: 15px;
  flex: none;
  color: var(--text-faint, var(--text-dim));
}
.ss-item .ss-nm {
  flex: 1;
  white-space: nowrap;
}
.ss-item .ss-check {
  width: 13px;
  height: 13px;
  flex: none;
  color: var(--accent);
}
.ss-item:hover {
  background: rgba(255, 255, 255, 0.055);
  color: var(--text);
}
.ss-item:hover .ss-ic-sm {
  color: var(--text);
}
.ss-item.cur {
  color: var(--accent);
  background: rgba(232, 184, 96, 0.12);
  font-weight: 600;
}
.ss-item.cur .ss-ic-sm {
  color: var(--accent);
}
.sspop-enter-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.sspop-leave-active {
  transition: opacity 0.1s ease, transform 0.1s ease;
}
.sspop-enter-from,
.sspop-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.985);
}
</style>
