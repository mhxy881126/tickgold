<template>
  <div
    class="ctx"
    :style="{ left: x + 'px', top: y + 'px' }"
    @pointerdown.stop
    @contextmenu.prevent
  >
    <button
      v-for="(it, i) in items"
      :key="it.act"
      type="button"
      class="ctx-item"
      :class="{ dis: it.dis, danger: it.act === 'close', sep: it.sep, focus: i === hi }"
      @click="choose(it)"
      @mouseenter="hi = i"
    >
      {{ it.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from "vue";

type Act =
  | "focus" | "collapse" | "pin" | "lock"
  | "copy" | "paste" | "color" | "tag" | "close";

const props = defineProps<{
  x: number;
  y: number;
  locked: boolean;
  pinned: boolean;
  collapsed: boolean;
  canPaste: boolean;
}>();

const emit = defineEmits<{
  (e: "action", a: string): void;
  (e: "close"): void;
}>();

const items = computed(() => [
  { act: "focus" as Act, label: "聚焦放大" },
  { act: "collapse" as Act, label: props.collapsed ? "展开" : "折叠" },
  { act: "pin" as Act, label: props.pinned ? "取消置顶" : "置顶" },
  { act: "lock" as Act, label: props.locked ? "解锁" : "锁定" },
  { act: "copy" as Act, label: "复制样式" },
  { act: "paste" as Act, label: "粘贴样式", dis: !props.canPaste },
  { act: "color" as Act, label: "改色", sep: true },
  { act: "tag" as Act, label: "加/改标签" },
  { act: "close" as Act, label: "关闭卡片", sep: true },
]);

const hi = ref(0);

function choose(it: { act: Act; dis?: boolean }) {
  if (it.dis) return;
  emit("action", it.act);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown") hi.value = (hi.value + 1) % items.value.length;
  else if (e.key === "ArrowUp") hi.value = (hi.value - 1 + items.value.length) % items.value.length;
  else if (e.key === "Enter") {
    const it = items.value[hi.value];
    if (!it.dis) choose(it);
  } else if (e.key === "Escape") emit("close");
}

function onDocDown(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".ctx")) emit("close");
}

onMounted(() => {
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onDocDown, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("pointerdown", onDocDown, true);
});
</script>

<style scoped>
.ctx {
  position: fixed;
  z-index: 200;
  min-width: 148px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-panel);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.65);
}
.ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  height: 28px;
  padding: 0 10px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  border-radius: 6px;
  cursor: pointer;
}
.ctx-item.focus,
.ctx-item:hover:not(.dis) {
  background: var(--bg-hover);
}
.ctx-item.dis {
  color: var(--text-dim);
  cursor: default;
}
.ctx-item.danger {
  color: #ef5f6b;
}
.ctx-item.sep {
  margin-top: 4px;
}
</style>
