<script setup lang="ts">
import { useToast } from "../composables/useToast";

const { toasts, dismiss, ICONS } = useToast();
</script>

<template>
  <div class="toast-wrap" aria-live="polite" aria-atomic="true">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="`toast-${t.type}`"
        role="status"
        @click="dismiss(t.id)"
      >
        <span class="toast-icon">{{ ICONS[t.type] }}</span>
        <span class="toast-msg">{{ t.msg }}</span>
        <span class="toast-close">×</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-wrap {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
  max-width: 340px;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--radius);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  cursor: pointer;
  font-size: 13px;
  line-height: 1.45;
  color: var(--text);
  backdrop-filter: blur(8px);
}
.toast-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
}
.toast-success .toast-icon { background: var(--down); }
.toast-info .toast-icon { background: var(--blue); }
.toast-warn .toast-icon { background: #f59e0b; }
.toast-error .toast-icon { background: var(--up); }

.toast-success { border-left: 3px solid var(--down); }
.toast-info { border-left: 3px solid var(--blue); }
.toast-warn { border-left: 3px solid #f59e0b; }
.toast-error { border-left: 3px solid var(--up); }

.toast-msg { flex: 1; word-break: break-word; }
.toast-close {
  flex-shrink: 0;
  opacity: 0.4;
  font-size: 16px;
  line-height: 1;
  transition: var(--transition);
}
.toast:hover .toast-close { opacity: 0.8; }

/* 动画 */
.toast-enter-from { opacity: 0; transform: translateX(30px); }
.toast-enter-active { transition: var(--transition-lg); }
.toast-leave-to { opacity: 0; transform: translateX(30px); }
.toast-leave-active { transition: var(--transition); }
.toast-move { transition: var(--transition); }
</style>
