<script setup lang="ts">
// 全局弹窗宿主（配合 composables/useDialog.ts）：深色主题、屏幕居中。
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useDialogState } from "../composables/useDialog";

const s = useDialogState();
const inputEl = ref<HTMLInputElement | null>(null);

function finish(v: boolean | string | null) {
  const r = s.resolve;
  s.open = false;
  s.resolve = null;
  if (r) r(v);
}
function onConfirm() {
  if (s.mode === "prompt") finish(s.inputValue);
  else finish(true);
}
function onCancel() {
  finish(s.mode === "prompt" ? null : false);
}
function onKey(e: KeyboardEvent) {
  if (!s.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    onCancel();
  } else if (e.key === "Enter" && s.mode !== "prompt") {
    e.preventDefault();
    onConfirm();
  }
}
function onPromptKey(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    onConfirm();
  }
}

watch(
  () => s.open,
  (v) => {
    if (v && s.mode === "prompt") {
      void nextTick(() => {
        inputEl.value?.focus();
        inputEl.value?.select();
      });
    }
  },
);

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <Transition name="ad">
    <div v-if="s.open" class="ad-mask" @click.self="onCancel">
      <div
        class="ad-card"
        role="dialog"
        aria-modal="true"
        :aria-label="s.title || '提示'"
      >
        <div v-if="s.title" class="ad-head">
          <span class="ad-title">{{ s.title }}</span>
        </div>
        <div class="ad-body">
          <p v-if="s.message" class="ad-msg">{{ s.message }}</p>
          <input
            v-if="s.mode === 'prompt'"
            ref="inputEl"
            v-model="s.inputValue"
            type="text"
            class="ad-in"
            :placeholder="s.placeholder"
            @keydown="onPromptKey"
          />
        </div>
        <div class="ad-foot">
          <button
            v-if="s.mode !== 'alert'"
            type="button"
            class="ad-btn cancel"
            @click="onCancel"
          >
            {{ s.cancelText }}
          </button>
          <button
            type="button"
            class="ad-btn ok"
            :class="{ danger: s.danger }"
            @click="onConfirm"
          >
            {{ s.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.ad-mask {
  position: fixed;
  inset: 0;
  z-index: 11000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(5, 8, 14, 0.55);
  backdrop-filter: blur(2px);
}
.ad-card {
  width: 400px;
  max-width: calc(100vw - 48px);
  background: #141a24;
  border: 1px solid #283346;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
.ad-head {
  padding: 16px 20px 0;
}
.ad-title {
  font-size: 15px;
  font-weight: 700;
  color: #e6ecf5;
}
.ad-body {
  padding: 12px 20px 4px;
}
.ad-msg {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.65;
  color: #c3ccd9;
  white-space: pre-wrap;
  word-break: break-word;
}
.ad-in {
  width: 100%;
  box-sizing: border-box;
  height: 34px;
  padding: 0 10px;
  margin-top: 10px;
  border-radius: 7px;
  border: 1px solid #2c3850;
  background: #0d121b;
  color: #e6ecf5;
  font-size: 13.5px;
  outline: none;
}
.ad-in:focus {
  border-color: #e8c878;
}
.ad-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 16px 20px 18px;
}
.ad-btn {
  min-width: 76px;
  height: 34px;
  padding: 0 16px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid #2c3850;
  transition: all 0.15s;
}
.ad-btn.cancel {
  background: transparent;
  color: #9aa6b6;
}
.ad-btn.cancel:hover {
  color: #e6ecf5;
  border-color: #45516a;
}
.ad-btn.ok {
  background: #e8c878;
  border-color: #e8c878;
  color: #1a1408;
}
.ad-btn.ok:hover {
  filter: brightness(1.08);
}
.ad-btn.ok.danger {
  background: #f23645;
  border-color: #f23645;
  color: #fff;
}
.ad-btn.ok.danger:hover {
  background: #e02b3a;
}

.ad-enter-active,
.ad-leave-active {
  transition: opacity 0.18s;
}
.ad-enter-active .ad-card,
.ad-leave-active .ad-card {
  transition: transform 0.18s, opacity 0.18s;
}
.ad-enter-from,
.ad-leave-to {
  opacity: 0;
}
.ad-enter-from .ad-card,
.ad-leave-to .ad-card {
  opacity: 0;
  transform: scale(0.96) translateY(6px);
}
</style>
