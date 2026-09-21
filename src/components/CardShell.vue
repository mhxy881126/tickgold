<script setup lang="ts">
defineProps<{ title: string; accent?: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div class="card-shell" :style="accent ? { '--accent-var': accent } : {}">
    <header class="card-head">
      <span class="card-bar"></span>
      <span class="card-title">{{ title }}</span>
      <button class="card-close" title="关闭卡片" @click="emit('close')">
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
  background: linear-gradient(180deg, #141a23 0%, #10151d 100%);
  border: 1px solid #232b36;
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  transition: border-color 0.2s;
}
.card-shell:hover {
  border-color: #324052;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 8px 0 10px;
  border-bottom: 1px solid #20272f;
  flex-shrink: 0;
}
.card-bar {
  width: 3px;
  height: 13px;
  border-radius: 2px;
  background: var(--accent-var, #2f6fed);
  flex-shrink: 0;
}
.card-title {
  font-size: 12px;
  font-weight: 600;
  color: #c9d1d9;
  letter-spacing: 0.3px;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  color: #7d8792;
  cursor: pointer;
  transition: all 0.15s;
}
.card-close:hover {
  background: #f23645;
  color: #fff;
}

.card-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
