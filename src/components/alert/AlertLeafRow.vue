<template>
  <div class="leaf-row">
    <select v-model="model.field" class="sel">
      <optgroup v-for="cat in categories" :key="cat" :label="CATEGORY_LABELS[cat]">
        <option v-for="s in specsByCat(cat)" :key="s.field" :value="s.field">
          {{ s.label }}
        </option>
      </optgroup>
    </select>

    <select v-model="model.op" class="sel op">
      <option v-for="op in availableOps" :key="op" :value="op">{{ OP_LABELS[op] }}</option>
    </select>

    <input
      v-if="!isEvent"
      v-model.number="model.value"
      type="number"
      class="num"
      :step="spec?.unit === '%' ? 0.1 : 1"
    />
    <span v-else class="evt-tag">事件</span>

    <span v-if="spec?.unit" class="unit">{{ spec.unit }}</span>

    <template v-for="p in spec?.params ?? []" :key="p.key">
      <label class="param">{{ p.label }}
        <input
          v-model.number="paramVals[p.key]"
          type="number"
          class="num small"
          :min="p.min"
          :step="p.step ?? 1"
        />
      </label>
    </template>

    <button class="del" title="删除条件" @click="$emit('remove')">×</button>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type { Leaf, Op } from "../../alert/types";
import {
  FIELD_SPECS,
  CATEGORY_LABELS,
  fieldSpec,
  type FieldCategory,
} from "../../alert/fields";

const props = defineProps<{ model: Leaf }>();
defineEmits<{ remove: [] }>();

const categories: FieldCategory[] = [
  "quote",
  "speed",
  "event",
  "indicator",
  "book",
  "auction",
];

const OP_LABELS: Record<Op, string> = {
  ">=": "≥",
  "<=": "≤",
  ">": ">",
  "<": "<",
  "==": "=",
  crossUp: "上穿",
  crossDown: "下破",
};

const spec = computed(() => fieldSpec(props.model.field));
const isEvent = computed(() => spec.value?.category === "event");
const availableOps = computed<Op[]>(() => spec.value?.ops ?? [">="]);

function specsByCat(cat: FieldCategory) {
  return FIELD_SPECS.filter((s) => s.category === cat);
}

const paramVals = reactive<Record<string, number>>({});

// 初始化参数默认值（新叶子），并同步到 model.params
function syncParams() {
  for (const p of spec.value?.params ?? []) {
    if (paramVals[p.key] == null)
      paramVals[p.key] = props.model.params?.[p.key] ?? p.default;
  }
  const next: Record<string, number> = {};
  for (const p of spec.value?.params ?? []) next[p.key] = paramVals[p.key];
  props.model.params = Object.keys(next).length ? next : undefined;
}

watch(
  () => props.model.field,
  () => {
    // 字段切换：若当前运算符不被支持则回落到第一个可用运算符
    if (!availableOps.value.includes(props.model.op))
      props.model.op = availableOps.value[0];
    syncParams();
  },
  { immediate: true }
);
watch(paramVals, syncParams, { deep: true });
</script>

<style scoped>
.leaf-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.sel,
.num {
  background: var(--bg-elevated, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  color: var(--text, #e8eaed);
  border-radius: 6px;
  padding: 4px 6px;
  font-size: 12px;
}
.sel { min-width: 0; }
.op { width: 64px; flex: none; }
.num { width: 78px; }
.num.small { width: 56px; }
.unit { font-size: 11px; color: var(--text-dim, #9aa0a6); }
.param {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-dim, #9aa0a6);
}
.evt-tag {
  font-size: 11px;
  color: var(--accent, #d4af37);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  padding: 3px 8px;
}
.del {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--text-dim, #9aa0a6);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
}
.del:hover { color: var(--down, #ef5350); }
</style>
