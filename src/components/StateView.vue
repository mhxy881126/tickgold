<script setup lang="ts">
// 统一三态组件（P2-2）：loading / empty / error / ready 四态。
// 包装用法：
//   <StateView :state="s" empty-title="暂无持仓" @retry="load"> ...真实内容... </StateView>
//   state="ready" 时渲染默认插槽；其余渲染对应状态。
// 空态可经 #action 插槽放行动按钮；错误态自带"重试"按钮并 emit retry。
import type { PropType } from "vue";

const props = withDefaults(
  defineProps<{
    state: "loading" | "empty" | "error" | "ready";
    loadingText?: string;
    emptyTitle?: string;
    emptyDesc?: string;
    errorText?: string;
    skeleton?: boolean;
    compact?: boolean;
  }>(),
  {
    loadingText: "加载中…",
    emptyTitle: "暂无数据",
    emptyDesc: "",
    errorText: "加载失败",
    skeleton: false,
    compact: false,
  }
);

const emit = defineEmits<{ (e: "retry"): void }>();
</script>

<template>
  <!-- 内容态 -->
  <slot v-if="state === 'ready'" />

  <!-- 加载态 -->
  <div v-else-if="state === 'loading'" class="sv" :class="{ compact }">
    <slot name="skeleton" v-if="skeleton">
      <div class="sk-lines">
        <div class="sk-bar w70"></div>
        <div class="sk-bar w100"></div>
        <div class="sk-bar w85"></div>
        <div class="sk-bar w60"></div>
      </div>
    </slot>
    <template v-else>
      <span class="spinner" aria-hidden="true"></span>
      <span class="sv-text">{{ loadingText }}</span>
    </template>
  </div>

  <!-- 空态 -->
  <div v-else-if="state === 'empty'" class="sv" :class="{ compact }">
    <svg class="sv-ic" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 14H7v-2h10v2zm0-4H7v-2h10v2zm0-4H7V7h10v2z"
      />
    </svg>
    <div class="sv-title">{{ emptyTitle }}</div>
    <div v-if="emptyDesc" class="sv-desc">{{ emptyDesc }}</div>
    <div v-if="$slots.action" class="sv-action">
      <slot name="action" />
    </div>
  </div>

  <!-- 错误态 -->
  <div v-else class="sv" :class="{ compact }">
    <svg class="sv-ic err" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"
      />
    </svg>
    <div class="sv-title">出错了</div>
    <div class="sv-desc err-text">{{ errorText }}</div>
    <button type="button" class="sv-retry" @click="emit('retry')">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M17.65 6.35A7.95 7.95 0 0012 4a8 8 0 108 8h-2a6 6 0 11-6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
        />
      </svg>
      重试
    </button>
  </div>
</template>

<style scoped>
.sv {
  width: 100%;
  min-height: 140px;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 18px 16px;
  text-align: center;
  color: var(--text-dim);
}
.sv.compact {
  min-height: 84px;
  padding: 12px;
  gap: 5px;
}

.sv-ic { width: 30px; height: 30px; opacity: 0.5; color: var(--text-dim); }
.sv-ic.err { color: var(--up); opacity: 0.85; }
.sv-title { font-size: 13px; font-weight: 600; color: var(--text); }
.sv-desc {
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.5;
  max-width: 260px;
  word-break: break-word;
}
.err-text { color: var(--up); }
.sv-action { margin-top: 6px; }

.spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: sv-spin 0.8s linear infinite;
}
.sv-text { font-size: 12px; }
@keyframes sv-spin { to { transform: rotate(360deg); } }

.sk-lines { width: 100%; max-width: 300px; display: flex; flex-direction: column; gap: 9px; }
.sk-bar {
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--bg-hover), var(--bg-card2), var(--bg-hover));
  background-size: 200% 100%;
  animation: sv-shimmer 1.3s linear infinite;
}
.w60 { width: 60%; }
.w70 { width: 70%; }
.w85 { width: 85%; }
.w100 { width: 100%; }
@keyframes sv-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.sv-retry {
  margin-top: 6px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-card2);
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.sv-retry svg { width: 14px; height: 14px; }
.sv-retry:hover { border-color: var(--accent); color: var(--accent); }
</style>
