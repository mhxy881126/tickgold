<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { TIME_PRESETS, currentTimeSlot } from "../composables/useWorkbench";

defineProps<{ active: string | null }>();
const emit = defineEmits<{ select: [id: string] }>();

const now = ref(new Date());
let timer = 0;
onMounted(() => {
  timer = window.setInterval(() => (now.value = new Date()), 1000);
});
onBeforeUnmount(() => window.clearInterval(timer));

const pad = (n: number) => String(n).padStart(2, "0");
const clock = computed(
  () => `${pad(now.value.getHours())}:${pad(now.value.getMinutes())}:${pad(now.value.getSeconds())}`
);
const slot = computed(() => currentTimeSlot(now.value));
const slotLabel = computed(
  () => TIME_PRESETS.find((p) => p.id === slot.value)?.label ?? ""
);
const weekday = computed(() => {
  const w = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const d = now.value;
  return `${d.getMonth() + 1}/${d.getDate()} ${w[d.getDay()]}`;
});
</script>

<template>
  <div class="timetabs">
    <div class="tt-tabs">
      <button
        v-for="p in TIME_PRESETS"
        :key="p.id"
        class="tt-btn"
        :class="{ on: active === p.id, cur: slot === p.id && active !== p.id }"
        @click="emit('select', p.id)"
      >
        {{ p.label }}
        <span v-if="slot === p.id" class="tt-dot"></span>
      </button>
    </div>
    <div class="tt-right">
      <span class="tt-slot">{{ slotLabel }}</span>
      <span class="tt-date">{{ weekday }}</span>
      <span class="tt-clock">{{ clock }}</span>
    </div>
  </div>
</template>

<style scoped>
.timetabs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 36px;
  flex: none;
  padding: 0 4px;
  position: relative;
  z-index: 2;
  background: transparent;
  border: 0;
  border-radius: 0;
}
.tt-tabs {
  display: flex;
  gap: 4px;
}
.tt-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #8b949e;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 4px 11px;
  cursor: pointer;
  transition: all 0.15s;
}
.tt-btn:hover {
  color: #d6dde8;
  background: #1a2230;
}
.tt-btn.on {
  color: #f0d488;
  background: rgba(212, 175, 55, 0.13);
  border-color: rgba(212, 175, 55, 0.45);
}
.tt-btn.cur {
  color: #9fb4d4;
}
.tt-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #08c98a;
  box-shadow: 0 0 6px rgba(8, 201, 138, 0.9);
}
.tt-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.tt-slot {
  font-size: 10.5px;
  color: #b07cff;
}
.tt-date {
  font-size: 10.5px;
  color: #7d8792;
}
.tt-clock {
  font-size: 15px;
  font-weight: 700;
  color: #e9eef6;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.5px;
}
</style>
