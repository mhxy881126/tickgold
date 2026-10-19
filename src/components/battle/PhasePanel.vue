<script setup lang="ts">
import { computed } from "vue";
import type { Quote } from "../../api/types";
import { useWorkflowStore } from "../../stores/workflow";
import { CLOSED_PHASE, PHASES, type PhaseId, type PhaseState } from "./useBattlePhase";

const props = defineProps<{
  state: PhaseState;
  preview: PhaseId | null;
  quotes: Record<string, Quote>;
}>();
const emit = defineEmits<{ (e: "pick", code: string): void; (e: "preview", id: PhaseId | null): void }>();

const wf = useWorkflowStore();
const shown = computed(() => {
  if (props.preview) return PHASES.find((p) => p.id === props.preview) ?? props.state.phase;
  return props.state.phase;
});
const isPreview = computed(() => !!props.preview && props.preview !== props.state.phase.id);
const plan = computed(() => (wf.battlePlan?.instructions ?? []).slice(0, 5));
const feedback = computed(() => wf.feedback);
</script>

<template>
  <section class="bpp" data-testid="battle-panel">
    <header class="bpp-head">
      <span class="bpp-title" :style="{ color: shown.color }">{{ shown.label }}</span>
      <span class="bpp-headline">{{ shown.headline }}</span>
      <button v-if="isPreview" type="button" class="bpp-back" @click="emit('preview', null)">回到当前</button>
    </header>

    <ul class="bpp-list">
      <li v-for="item in shown.checklist" :key="item">{{ item }}</li>
    </ul>

    <div v-if="!state.weekend && plan.length" class="bpp-plan">
      <button
        v-for="p in plan"
        :key="p.code"
        type="button"
        class="bpp-stock"
        @click="emit('pick', p.code)"
      >
        <span class="bpp-code mono">{{ p.code }}</span>
        <span class="bpp-name">{{ p.name }}</span>
        <span
          class="bpp-pct mono"
          :class="{ up: (quotes[p.code]?.pct ?? 0) >= 0, down: (quotes[p.code]?.pct ?? 0) < 0 }"
        >
          {{ (quotes[p.code]?.pct ?? 0).toFixed(2) }}%
        </span>
      </button>
    </div>

    <p v-if="state.weekend" class="bpp-dim">{{ CLOSED_PHASE.headline }}</p>
    <p v-else-if="feedback && state.phase.id === 'post'" class="bpp-dim">
      今日 {{ feedback.fills.total }} 笔成交 · 已实现 {{ feedback.realizedPnl }} 元 · 胜率 {{ feedback.winRate }}%
    </p>
  </section>
</template>

<style scoped>
.bpp { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; background: var(--bg-card); }
.bpp-head { display: flex; align-items: baseline; gap: 8px; }
.bpp-title { font-size: 12px; font-weight: 700; }
.bpp-headline { font-size: 12px; color: var(--text); }
.bpp-back { margin-left: auto; background: transparent; border: 0; color: var(--accent); font-size: 11px; cursor: pointer; }
.bpp-list { margin: 0; padding-left: 16px; color: var(--text-dim); font-size: 11.5px; line-height: 1.6; }
.bpp-plan { display: flex; flex-wrap: wrap; gap: 4px; }
.bpp-stock { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text); font-size: 11.5px; cursor: pointer; }
.bpp-stock:hover { background: var(--bg-hover); }
.bpp-pct.up { color: var(--up); }
.bpp-pct.down { color: var(--down); }
.bpp-dim { margin: 0; color: var(--text-dim); font-size: 11.5px; }
.mono { font-variant-numeric: tabular-nums; }
</style>
