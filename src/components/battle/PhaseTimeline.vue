<script setup lang="ts">
import { computed } from "vue";
import { mmss, TIMELINE_SEGMENTS as SEGMENTS, type PhaseId, type PhaseState } from "./useBattlePhase";

const props = defineProps<{ state: PhaseState; preview: PhaseId | null }>();
const emit = defineEmits<{ (e: "preview", id: PhaseId | null): void }>();

const currentId = computed<PhaseId | null>(() => (props.state.weekend ? null : props.state.phase.id));
const isOn = (id: PhaseId) => currentId.value === id;

function click(id: PhaseId) {
  emit("preview", props.preview === id ? null : id);
}
</script>

<template>
  <div class="btl" data-testid="battle-phase">
    <div v-if="state.weekend" class="btl-closed">休市 · 下一交易日再战</div>
    <div v-else class="btl-bar">
      <button
        v-for="seg in SEGMENTS"
        :key="seg.id"
        type="button"
        class="btl-seg"
        :class="{ on: isOn(seg.id), preview: preview === seg.id }"
        :style="{ flexGrow: seg.grow, '--c': seg.color }"
        :title="seg.label"
        @click="click(seg.id)"
      >
        <span class="btl-label">{{ seg.label }}</span>
        <span v-if="isOn(seg.id)" class="btl-fill" :style="{ width: state.progress * 100 + '%' }" />
      </button>
    </div>
    <div class="btl-meta">
      <span class="btl-cur" :style="{ color: state.phase.color }">
        {{ state.phase.label }} · {{ state.phase.headline }}
      </span>
      <span v-if="!state.weekend" class="btl-next mono" data-testid="battle-countdown">
        距{{ state.nextLabel }} {{ mmss(state.nextInSec) }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.btl { display: flex; flex-direction: column; gap: 6px; }
.btl-bar { display: flex; height: 30px; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
.btl-seg {
  position: relative; border: 0; border-right: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-card) 92%, transparent);
  color: var(--text-dim); font-size: 11px; cursor: pointer; padding: 0; overflow: hidden;
}
.btl-seg:last-child { border-right: 0; }
.btl-seg.on { background: color-mix(in srgb, var(--c) 22%, var(--bg-card)); color: var(--text); }
.btl-seg.preview { outline: 1px solid var(--c); outline-offset: -1px; }
.btl-fill { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--c); }
.btl-label { position: relative; z-index: 1; }
.btl-meta { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; }
.btl-closed { padding: 8px; text-align: center; color: var(--text-dim); border: 1px dashed var(--border); border-radius: 8px; }
.btl-cur { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-variant-numeric: tabular-nums; color: var(--text-dim); flex: none; }
</style>
