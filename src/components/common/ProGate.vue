<script setup lang="ts">
import { emit } from "@tauri-apps/api/event";
import { useLicenseStore } from "../../stores/license";

// Pro 功能门控：未激活订阅时展示引导占位；激活后渲染插槽内容，
// 并在卡片内容上方以行内标注条显示「PRO 已激活」（不遮挡卡片自身 UI）。
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
  <div v-if="license.isPro" class="pg-active">
    <div class="pg-active-bar">
      <span class="pg-active-badge">
        <svg class="pg-crown" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path fill="currentColor" d="M3 17h18l1.2-8.6-5.7 3.3L12 5 7.5 11.7 1.8 8.4 3 17zM2 19h20v2H2v-2z" />
        </svg>
        <span>PRO 已激活</span>
      </span>
    </div>
    <div class="pg-slot">
      <slot />
    </div>
  </div>
  <div v-else class="pro-gate">
    <div class="pg-badge">PRO</div>
    <div class="pg-title">{{ title || "Pro 订阅专享" }}</div>
    <div class="pg-desc">{{ desc || "激活年卡后解锁完整内容与能力" }}</div>
    <button class="pg-btn" @click="goSubscribe">订阅 Pro · ¥199/年</button>
  </div>
</template>

<style scoped>
.pg-slot {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pg-active {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}
.pg-active-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 8px 12px 4px;
}
.pg-active-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 1.5px;
  color: #f6dd8e;
  background: linear-gradient(135deg, rgba(232, 198, 106, 0.18), rgba(217, 164, 65, 0.08));
  border: 1px solid rgba(232, 198, 106, 0.45);
  border-radius: 20px;
  padding: 3px 10px 3px 8px;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.2), 0 2px 8px rgba(232, 198, 106, 0.12);
  animation: pg-breathe 2.6s ease-in-out infinite;
}
.pg-crown { flex: none; filter: drop-shadow(0 0 3px rgba(232, 198, 106, 0.55)); }
@keyframes pg-breathe {
  0%, 100% { box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.2), 0 2px 8px rgba(232, 198, 106, 0.10); }
  50% { box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.2), 0 2px 14px rgba(232, 198, 106, 0.28); }
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
