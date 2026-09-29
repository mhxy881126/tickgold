<script setup lang="ts">
import { WIDGET_DEFS } from "./registry";

// 微件托盘：点击添加（singleton 已存在的禁用）
defineProps<{ present: string[] }>();
const emit = defineEmits<{ add: [defId: string] }>();
</script>

<template>
  <div class="wtray">
    <span class="wt-label">添加微件</span>
    <div class="wt-items">
      <button
        v-for="d in WIDGET_DEFS"
        :key="d.id"
        type="button"
        class="wt-btn"
        :disabled="!!d.singleton && present.includes(d.id)"
        :title="d.singleton && present.includes(d.id) ? '该微件每卡仅一个' : d.title"
        @click="emit('add', d.id)"
      >
        <span class="wt-ic">+</span>
        <span class="wt-name">{{ d.title }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.wtray { display: flex; align-items: center; gap: 9px; padding: 6px 4px; }
.wt-label { font-size: 10px; color: var(--text-dim); flex-shrink: 0; }
.wt-items { display: flex; gap: 5px; flex-wrap: wrap; }
.wt-btn { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px;
  border: 1px solid var(--border); background: rgba(255, 255, 255, .03);
  color: var(--text); font-size: 10px; border-radius: 6px; cursor: pointer; }
.wt-btn:hover:not(:disabled) { border-color: var(--accent, #e8c878); color: var(--accent, #e8c878); }
.wt-btn:disabled { opacity: .35; cursor: not-allowed; }
.wt-ic { font-size: 12px; line-height: 1; font-weight: 700; }
</style>
