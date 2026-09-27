<template>
  <Teleport to="body">
    <div class="toast-stack">
      <TransitionGroup name="pop">
        <div
          v-for="t in alertToasts"
          :key="t.key"
          class="toast"
          :class="t.tone"
          @click="onClick(t)"
        >
          <div class="tt-head">
            <span class="dot" />
            <span class="tt-title">{{ t.title }}</span>
            <button class="tt-x" @click.stop="dismissToast(t.key)">×</button>
          </div>
          <div class="tt-body">{{ t.body }}</div>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { alertToasts, dismissToast, navPickStock } from "../../alert/bus";

function onClick(t: { code: string; key: string }) {
  navPickStock(t.code);
  dismissToast(t.key);
}
</script>

<style scoped>
.toast-stack {
  position: fixed; top: 16px; right: 16px; z-index: 9500;
  display: flex; flex-direction: column; gap: 10px; width: 320px;
}
.toast {
  background: var(--bg-card, #1b1e24);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
  border-left: 3px solid var(--accent, #d4af37);
  border-radius: 10px; padding: 10px 12px; cursor: pointer;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
}
.toast.up { border-left-color: var(--up, #ef5350); }
.toast.down { border-left-color: var(--down, #26a69a); }
.tt-head { display: flex; align-items: center; gap: 7px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent, #d4af37); }
.tt-title { font-size: 12.5px; font-weight: 600; flex: 1; }
.tt-x { background: none; border: none; color: var(--text-dim, #9aa0a6); font-size: 15px; cursor: pointer; }
.tt-body { font-size: 12px; color: var(--text-dim, #b6bac1); margin-top: 5px; line-height: 1.5; }

.pop-enter-active, .pop-leave-active { transition: all 0.25s ease; }
.pop-enter-from { opacity: 0; transform: translateX(30px); }
.pop-leave-to { opacity: 0; transform: translateX(20px); }
</style>
