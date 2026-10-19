<script setup lang="ts">
// P1-c 8:45 盘前确认提醒（App 级常驻）：后端调度器 emit `battle:reminder`，
// 顶部横幅展示文案 +「去确认」（打开今日作战流卡片）+「稍后」（本次关闭）。
// 只做应用内提醒，不涉及系统通知；「稍后」不写后端幂等键，重启后当天不再重复提醒由后端保证。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";

interface ReminderPayload {
  kind?: string;
  planId?: number;
  planDate?: string;
  status?: string;
  text?: string;
}

const show = ref(false);
const text = ref("");
const planDate = ref("");
const status = ref("");

const subtitle = computed(() => {
  if (status.value === "missing") return "今日尚无作战卡，打开作战流先生成";
  const date = planDate.value ? `${planDate.value} ` : "";
  return `${date}作战卡 · 确认后转入今日盯盘`;
});

function onReminder(payload?: ReminderPayload) {
  if (payload?.kind && payload.kind !== "plan-confirm") return;
  text.value = payload?.text?.trim() || "今日作战卡待确认，请先确认后再盯盘";
  planDate.value = payload?.planDate ?? "";
  status.value = payload?.status ?? "";
  show.value = true;
}

// 去确认：复用现有「打开指定卡片」事件（App.vue 监听 island:open-card）。
function openConfirm() {
  show.value = false;
  void emit("island:open-card", "cockpit");
}

// 稍后：仅关闭本次横幅，不静默确认、不影响后端幂等（当天重启也不再弹）。
function dismiss() {
  show.value = false;
}

const un: UnlistenFn[] = [];
onMounted(() => {
  listen<ReminderPayload>("battle:reminder", (e) => onReminder(e.payload)).then((u) =>
    un.push(u),
  );
});
onBeforeUnmount(() => {
  un.forEach((u) => u());
});
</script>

<template>
  <transition name="rb-fade">
    <div
      v-if="show"
      class="rb-bar"
      role="status"
      aria-live="polite"
      data-testid="reminder-banner"
    >
      <span class="rb-dot"></span>
      <div class="rb-main">
        <div class="rb-title">{{ text }}</div>
        <div class="rb-sub">{{ subtitle }}</div>
      </div>
      <div class="rb-actions">
        <button
          type="button"
          class="rb-btn primary"
          data-testid="reminder-open"
          @click="openConfirm"
        >
          去确认
        </button>
        <button type="button" class="rb-btn" data-testid="reminder-dismiss" @click="dismiss">
          稍后
        </button>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.rb-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  /* 高于卡片/顶栏，低于设置与对话类弹窗（SettingsDialog 1000 / AppDialog 11000）。 */
  z-index: 990;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 16px;
  font-size: 12px;
  background: linear-gradient(135deg, rgba(232, 198, 106, 0.2), rgba(232, 198, 106, 0.06));
  border-bottom: 1px solid rgba(232, 198, 106, 0.55);
  color: #ffe9b8;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
}
.rb-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--accent, #e8c66a);
  flex-shrink: 0;
  animation: rb-blink 1.2s infinite;
}
@keyframes rb-blink {
  50% {
    opacity: 0.3;
  }
}
.rb-main {
  flex: 1;
  min-width: 0;
}
.rb-title {
  font-weight: 700;
  font-size: 13px;
}
.rb-sub {
  margin-top: 2px;
  opacity: 0.8;
}
.rb-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.rb-btn {
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  font-size: 12px;
  font-weight: 600;
  border-radius: 7px;
  padding: 6px 14px;
  cursor: pointer;
  white-space: nowrap;
}
.rb-btn.primary {
  background: rgba(232, 198, 106, 0.24);
  border-color: rgba(232, 198, 106, 0.7);
  color: #fff3d0;
}
.rb-btn:hover {
  background: rgba(255, 255, 255, 0.16);
}
.rb-fade-enter-active,
.rb-fade-leave-active {
  transition: opacity 0.2s;
}
.rb-fade-enter-from,
.rb-fade-leave-to {
  opacity: 0;
}
</style>
