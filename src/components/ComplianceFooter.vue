<script setup lang="ts">
// 全局合规免责声明组件（P2-4）：统一文案「仅供参考，不构成投资建议，不承诺收益」。
// 挂载于交易/信号/统计/选股等对外展示面，避免逐个组件手写免责导致覆盖不完整。
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });
</script>

<template>
  <div class="compliance-footer" :class="{ compact }">
    <svg viewBox="0 0 24 24" class="cf-icon" aria-hidden="true">
      <path
        d="M12 2L2 7v5c0 5.25 3.4 9.74 10 12 6.6-2.26 10-6.75 10-12V7L12 2zm-1 15.5h2V20h-2v-2.5zm0-11h2v9h-2v-9z"
        fill="currentColor"
      />
    </svg>
    <span>本软件数据与提示仅供参考，不构成任何投资建议，不承诺收益。据此操作风险自担。</span>
  </div>
</template>

<style scoped>
.compliance-footer {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  margin-top: 10px;
  border: 1px dashed rgba(150, 160, 184, 0.35);
  border-radius: 8px;
  background: rgba(150, 160, 184, 0.06);
  color: #8a93a8;
  font-size: 12px;
  line-height: 1.6;
}
.compliance-footer.compact {
  padding: 5px 8px;
  margin-top: 6px;
  font-size: 11px;
}
.cf-icon {
  width: 14px;
  height: 14px;
  flex: none;
  margin-top: 1px;
  opacity: 0.85;
}
</style>
