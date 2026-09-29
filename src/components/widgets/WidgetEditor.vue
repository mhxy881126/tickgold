<script setup lang="ts">
import { computed } from "vue";
import type { CardId } from "../../composables/useWorkbench";
import { useWorkbench } from "../../composables/useWorkbench";
import WidgetCanvas from "./WidgetCanvas.vue";
import WidgetTray from "./WidgetTray.vue";
import SearchBox from "../SearchBox.vue";

// 编排模式：覆盖卡体；工具条（卡主标的/恢复出厂/完成）+ 画布 + 托盘
const props = defineProps<{ id: CardId }>();
const emit = defineEmits<{ close: [] }>();

const bench = useWorkbench();
const widgets = computed(() => bench.ensureWidgets(props.id));
const present = computed(() => widgets.value.items.map((i) => i.def));

function pickPrimary(code: string, _name: string) {
  bench.setCardPrimary(props.id, code);
}
function followGlobal() {
  bench.setCardPrimary(props.id, null);
}
</script>

<template>
  <div class="we-root">
    <div class="we-bar">
      <span class="we-title">编排模式</span>
      <div class="we-primary">
        <span class="we-k">卡主标的</span>
        <div class="we-search">
          <SearchBox @select="pickPrimary" />
        </div>
        <button type="button" class="we-follow" @click="followGlobal">跟随全局</button>
      </div>
      <span class="we-spacer"></span>
      <button type="button" class="we-reset" @click="bench.resetCardWidgets(id)">恢复出厂模板</button>
      <button type="button" class="we-done" @click="emit('close')">完成</button>
    </div>
    <div class="we-stage">
      <WidgetCanvas :id="id" :editing="true" />
    </div>
    <WidgetTray :present="present" @add="(d) => bench.addWidget(id, d)" />
  </div>
</template>

<style scoped>
.we-root { position: absolute; inset: 0; display: flex; flex-direction: column;
  background: var(--bg-card, #0f141d); border-radius: inherit; overflow: hidden; z-index: 20; }
.we-bar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; flex: none;
  border-bottom: 1px solid var(--border); }
.we-title { font-size: 11px; font-weight: 700; color: var(--accent, #e8c878); }
.we-primary { display: flex; align-items: center; gap: 7px; }
.we-k { font-size: 10px; color: var(--text-dim); }
.we-search { width: 200px; }
.we-search :deep(.searchbox) { flex: none; width: 200px; }
.we-follow { height: 24px; padding: 0 10px; border: 1px solid var(--border); background: transparent;
  color: var(--text-dim); font-size: 10px; border-radius: 6px; cursor: pointer; }
.we-follow:hover { color: var(--text); border-color: var(--accent, #e8c878); }
.we-spacer { flex: 1; }
.we-reset { height: 26px; padding: 0 12px; border: 1px solid var(--border); background: transparent;
  color: var(--text); font-size: 10.5px; border-radius: 6px; cursor: pointer; }
.we-reset:hover { border-color: var(--accent, #e8c878); color: var(--accent, #e8c878); }
.we-done { height: 26px; padding: 0 16px; border: 0; background: var(--accent, #e8c878);
  color: #1a1606; font-size: 11px; font-weight: 700; border-radius: 6px; cursor: pointer; }
.we-stage { flex: 1; position: relative; min-height: 0; padding: 10px; }
</style>
