<script setup lang="ts">
import { emit } from "@tauri-apps/api/event";
import { useLicenseStore } from "../../stores/license";

// Pro 功能门控：未激活订阅时展示引导占位，激活后渲染插槽内容。
defineProps<{
  /** 功能名（默认 "Pro 订阅专享"） */
  title?: string;
  /** 引导副文案 */
  desc?: string;
}>();
const license = useLicenseStore();

function goSubscribe() {
  void emit("open-pro-settings");
}
</script>

<template>
  <div v-if="license.isPro" class="pg-slot">
    <slot />
  </div>
  <div v-else class="pro-gate">
    <div class="pg-badge">PRO</div>
    <div class="pg-title">{{ title || "Pro 订阅专享" }}</div>
    <div class="pg-desc">{{ desc || "激活年卡后解锁完整内容与能力" }}</div>
    <button class="pg-btn" @click="goSubscribe">订阅 Pro · ¥99/年</button>
  </div>
</template>

<style scoped>
.pg-slot {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pro-gate {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 28px 20px;
  border: 1px dashed var(--border, #2a3344);
  border-radius: 12px;
  background: linear-gradient(160deg, rgba(232, 198, 106, 0.05), rgba(20, 22, 28, 0.4));
  text-align: center;
}
.pg-badge {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 3px;
  color: var(--accent, #e8c66a);
  border: 1px solid rgba(232, 198, 106, 0.45);
  border-radius: 6px;
  padding: 3px 10px;
  background: rgba(232, 198, 106, 0.08);
}
.pg-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text, #e6ecf5);
}
.pg-desc {
  font-size: 12px;
  color: var(--text-dim, #8a93a6);
  max-width: 300px;
  line-height: 1.6;
}
.pg-btn {
  margin-top: 4px;
  padding: 9px 26px;
  border: none;
  border-radius: 9px;
  background: linear-gradient(135deg, #e8c66a, #d9a441);
  color: #1a1508;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: transform 0.12s ease, filter 0.12s ease;
}
.pg-btn:hover {
  filter: brightness(1.08);
  transform: translateY(-1px);
}
</style>
