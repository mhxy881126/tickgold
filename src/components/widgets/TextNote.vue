<script setup lang="ts">
import { ref } from "vue";

// 文字/分隔线（binding=none）：内容由卡快照 text 字段持久化，编辑事件上交画布
const props = defineProps<{ text?: string | null }>();
const emit = defineEmits<{ edit: [text: string] }>();

const editing = ref(false);
const draft = ref("");

function startEdit() {
  draft.value = props.text ?? "";
  editing.value = true;
}
function commit() {
  editing.value = false;
  emit("edit", draft.value.trim());
}
</script>

<template>
  <div class="w-note" @dblclick="startEdit">
    <textarea
      v-if="editing"
      v-model="draft"
      class="area"
      autofocus
      @blur="commit"
      @keydown.esc.prevent="editing = false"
    ></textarea>
    <div v-else-if="text" class="txt">{{ text }}</div>
    <div v-else class="ph">双击输入备注 / 分隔标题</div>
  </div>
</template>

<style scoped>
.w-note { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  padding: 6px 10px; min-height: 0; }
.txt { font-size: 11px; line-height: 1.5; text-align: center; white-space: pre-wrap;
  word-break: break-word; color: var(--text); width: 100%;
  overflow: hidden; }
.ph { font-size: 10px; color: var(--text-dim); text-align: center; }
.area { width: 100%; height: 100%; resize: none; border: 1px solid var(--accent, #e8c66a);
  border-radius: 7px; background: rgba(0, 0, 0, .3); color: var(--text);
  font-size: 11px; line-height: 1.5; padding: 6px 8px; outline: none;
  font-family: inherit; }
</style>
