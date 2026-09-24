<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { fetchSectors } from "../api/market";
import type { Sector } from "../api/types";

const emit = defineEmits<{ select: [code: string] }>();

const sectors = ref<Sector[]>([]);
const mode = ref<"up" | "down" | "all">("up");
const source = ref<"concept" | "industry">("concept");

interface Tag extends Sector {
  fs: number;
  hot: boolean;
  inflow: boolean;
}
const list = computed<Tag[]>(() => {
  let a = [...sectors.value];
  if (mode.value === "up") a = a.filter((x: Sector) => x.changePct > 0);
  if (mode.value === "down") a = a.filter((x: Sector) => x.changePct < 0);
  a.sort((x, y) => Math.abs(y.changePct) - Math.abs(x.changePct));
  a = a.slice(0, 34);
  const max = Math.max(...a.map((x) => Math.abs(x.changePct)), 1);
  return a.map((s) => {
    const r = Math.abs(s.changePct) / max;
    return { ...s, fs: 11 + r * 6, hot: r > 0.62, inflow: s.netAmount > 0 };
  });
});

const upCount = computed(() => sectors.value.filter((x) => x.changePct > 0).length);
const downCount = computed(() => sectors.value.filter((x) => x.changePct < 0).length);

function fmt(p: number) {
  return (p >= 0 ? "+" : "") + p.toFixed(2);
}

onMounted(async () => {
  let s = await fetchSectors("concept");
  if (!s.length) {
    s = await fetchSectors("industry");
    source.value = "industry";
  }
  sectors.value = s;
});
</script>

<template>
  <div class="theme">
    <div class="th-tabs">
      <div class="tt">
        <button :class="{ on: mode === 'up' }" @click="mode = 'up'">领涨 {{ upCount }}</button>
        <button :class="{ on: mode === 'down' }" @click="mode = 'down'">领跌 {{ downCount }}</button>
        <button :class="{ on: mode === 'all' }" @click="mode = 'all'">全部</button>
      </div>
      <span class="th-src">{{ source === "concept" ? "概念题材" : "行业板块" }}</span>
    </div>
    <div class="th-cloud">
      <button
        v-for="s in list"
        :key="s.code"
        class="tag"
        :class="{ hot: s.hot, inflow: s.inflow }"
        :style="{ fontSize: s.fs + 'px' }"
        @click="emit('select', s.leadCode)"
      >
        <span class="tn">{{ s.name }}</span>
        <span class="tp" :class="s.changePct >= 0 ? 'up' : 'down'">{{ fmt(s.changePct) }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.theme {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 7px 10px 8px;
  overflow: hidden;
}
.th-tabs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 7px;
  flex: none;
}
.tt {
  display: flex;
  gap: 4px;
}
.tt button {
  font-size: 10px;
  color: var(--text-dim);
  background: var(--bg-card2);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 2px 8px;
  cursor: pointer;
}
.tt button.on {
  color: var(--text);
  background: var(--bg-hover);
  border-color: var(--border-light);
}
.th-src {
  font-size: 9px;
  color: var(--text-dim);
}
.th-cloud {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 5px;
  overflow-y: auto;
  min-height: 0;
  padding-right: 2px;
}
.tag {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--bg-card2);
  cursor: pointer;
  line-height: 1.3;
  transition: transform 0.12s, border-color 0.15s;
}
.tag:hover {
  transform: translateY(-1px);
  border-color: var(--border-light);
}
.tn {
  color: var(--text);
}
.tp {
  font-size: 9px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.tp.up {
  color: var(--up);
}
.tp.down {
  color: var(--down);
}
.tag.hot {
  border-color: var(--accent);
}
.tag.hot .tn {
  color: var(--accent);
}
.tag.inflow {
  box-shadow: inset 2px 0 0 var(--accent);
}
</style>
