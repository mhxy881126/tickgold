<script setup lang="ts">
import { stateMeta, triggerHint, type InstructionRow } from "./instructionModel";

defineProps<{ rows: InstructionRow[] }>();
const emit = defineEmits<{ (e: "pick", code: string): void }>();

function tierLabel(tier: string): string {
  return tier === "candidate" ? "备选" : tier === "trigger" ? "触发" : "观察";
}
function toneClass(state: string): string {
  return `tone-${stateMeta(state).tone}`;
}
</script>

<template>
  <section class="il" data-testid="instruction-list">
    <header class="il-head">
      <span class="il-title">今日指令</span>
      <span class="il-count">{{ rows.length }}</span>
    </header>
    <p v-if="!rows.length" class="il-empty">今日无计划指令，确认作战卡后自动生成</p>
    <div v-else class="il-rows">
      <button
        v-for="r in rows.slice(0, 5)"
        :key="r.id"
        type="button"
        class="il-row"
        @click="emit('pick', r.code)"
      >
        <span class="il-tier" :class="`tier-${r.tier}`">{{ tierLabel(r.tier) }}</span>
        <span class="il-code mono">{{ r.code }}</span>
        <span class="il-name">{{ r.name }}</span>
        <span class="il-hint">{{ triggerHint(r.triggerJson) }}</span>
        <span class="il-state" :class="toneClass(r.state)" :data-state="r.state">
          {{ stateMeta(r.state).label }}
        </span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.il { border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; background: var(--bg-card); }
.il-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.il-title { font-size: 12px; font-weight: 700; }
.il-count { font-size: 11px; color: var(--text-dim); }
.il-empty { margin: 0; font-size: 11.5px; color: var(--text-dim); }
.il-rows { display: flex; flex-direction: column; gap: 3px; }
.il-row { display: flex; align-items: center; gap: 8px; padding: 3px 6px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--text); font-size: 11.5px; cursor: pointer; text-align: left; }
.il-row:hover { background: var(--bg-hover); }
.il-tier { flex: none; padding: 0 5px; border-radius: 4px; font-size: 10px; border: 1px solid var(--border); color: var(--text-dim); }
.il-tier.tier-candidate { color: var(--accent); border-color: var(--accent); }
.il-code { flex: none; }
.il-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.il-hint { flex: none; color: var(--text-dim); font-size: 10.5px; }
.il-state { flex: none; padding: 0 6px; border-radius: 4px; font-size: 10.5px; border: 1px solid var(--border); }
.il-state.tone-info { color: #6aa6e8; border-color: #6aa6e8; }
.il-state.tone-gold { color: var(--accent); border-color: var(--accent); }
.il-state.tone-up { color: var(--up); border-color: var(--up); }
.il-state.tone-muted { color: var(--text-dim); }
.mono { font-variant-numeric: tabular-nums; }
</style>
