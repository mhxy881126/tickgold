<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, inject } from "vue";
import { listen } from "@tauri-apps/api/event";
import { startRadar, type RadarData } from "../api/market";
import { DOCK_GROUPS } from "../lib/dock";
import type { CardId } from "../composables/useWorkbench";

const bench = inject<any>("workbench");
const data = ref<RadarData | null>(null);
let un: (() => void) | null = null;

const moodPos = computed(() => {
  const s = data.value ? data.value.sentiment : 50;
  return Math.min(99, Math.max(2, s));
});
const moodText = computed(() => (data.value ? data.value.mood : "--"));

function open(id: CardId) {
  bench?.open(id);
}

onMounted(async () => {
  un = await listen<RadarData>("radar:data", (e) => {
    data.value = e.payload;
  });
  try {
    await startRadar();
  } catch { /* 静默 */ }
});
onBeforeUnmount(() => un?.());
</script>

<template>
  <div class="wb-root">
    <div class="wb-mask"></div>

    <!-- 卡片入口栅格：按分组 -->
    <div class="wb-grid-wrap">
      <div v-for="g in DOCK_GROUPS" :key="g.name" class="wb-group">
        <div class="wb-group-head">
          <span class="wb-group-name">{{ g.name }}</span>
          <span class="wb-group-count">{{ g.items.length }}</span>
        </div>
        <div class="wb-cards">
          <button
            v-for="it in g.items"
            :key="it.id"
            type="button"
            class="wb-card"
            :class="{ opened: bench?.isOpen(it.id) }"
            :title="it.desc"
            @click="open(it.id)"
          >
            <span class="wb-card-icon">
              <svg viewBox="0 0 24 24"><path fill="currentColor" :d="it.icon" /></svg>
            </span>
            <span class="wb-card-title">{{ it.label }}</span>
            <svg v-if="it.star" class="wb-star" viewBox="0 0 24 24"><path fill="currentColor" d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wb-root {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 20px;
  overflow: hidden;
  color: var(--text);
  background: var(--bg);
}
.wb-mask {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px);
  background-size: 28px 28px;
}
.wb-root > * { position: relative; z-index: 2; }

/* 卡片栅格 */
.wb-grid-wrap {
  flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 18px;
  padding-right: 4px;
}
.wb-group { flex: none; }
.wb-group-head {
  display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding: 0 2px;
}
.wb-group-name {
  font-size: 10px; color: var(--gold); letter-spacing: 2px; font-weight: 600;
  text-transform: uppercase;
}
.wb-group-count {
  font-size: 9px; color: var(--text-dim);
  background: rgba(255,255,255,.05);
  padding: 1px 6px; border-radius: 8px;
}
.wb-cards {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 6px;
}

/* 单张卡片入口：紧凑图标+文字 */
.wb-card {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 12px 8px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-card); color: var(--text-dim); text-align: center; cursor: pointer;
  transition: all .15s;
}
.wb-card:hover {
  border-color: var(--gold);
  background: rgba(232,184,96,.06);
  color: var(--text);
  transform: translateY(-2px);
}
.wb-card.opened {
  border-color: rgba(232,184,96,.45);
  background: rgba(232,184,96,.1);
  color: var(--gold);
}
.wb-card-icon {
  width: 28px; height: 28px; border-radius: 8px;
  background: rgba(255,255,255,.05);
  display: flex; align-items: center; justify-content: center;
  transition: all .15s;
}
.wb-card:hover .wb-card-icon { background: rgba(232,184,96,.15); }
.wb-card-icon svg { width: 15px; height: 15px; }
.wb-card-title {
  font-size: 11px; font-weight: 500; line-height: 1.2;
  display: flex; align-items: center; gap: 4px;
}
.wb-star { width: 9px; height: 9px; color: var(--gold); flex: none; }
</style>
