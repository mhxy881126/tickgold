<script setup lang="ts">
import { computed, ref } from "vue";
import type { CardId } from "../../lib/cards";
import type { WidgetInstance } from "../../lib/widgets";
import { widgetDefOf } from "./registry";
import { useMarketContext } from "../../composables/useMarketContext";
import SearchBox from "../SearchBox.vue";

// 单个微件的外壳：编辑态显示标题栏/绑定徽标/删除/resize；始终渲染动态微件
const props = defineProps<{
  inst: WidgetInstance;
  editing: boolean;
  strideW: number; // 列步距（单元宽 + gap）px
  strideH: number; // 行步距（单元高 + gap）px
  gap: number;
  cardId?: CardId; // 单微件弹出用（非 editing 态显示 popout 钮）
}>();
const emit = defineEmits<{
  remove: [id: string];
  dragStart: [id: string, e: PointerEvent];
  resizeStart: [id: string, e: PointerEvent];
  bind: [id: string, code: string | null];
  editText: [id: string, text: string];
  popout: [cardId: CardId, widgetId: string];
}>();

const ctx = useMarketContext();
const def = computed(() => widgetDefOf(props.inst.def));

// 绑定徽标文案：自身 bind > 卡/全局主标的
const bindLabel = computed(() => {
  if (props.inst.bind) {
    return ctx.nameOf(props.inst.bind) || props.inst.bind;
  }
  const p = ctx.primaryCode.value;
  return p ? (ctx.nameOf(p) || p) : "未绑定";
});

const bindOpen = ref(false);
function pickBind(code: string) {
  bindOpen.value = false;
  emit("bind", props.inst.id, code);
}
function followCard() {
  bindOpen.value = false;
  emit("bind", props.inst.id, null);
}

const pos = computed(() => ({
  left: `${props.inst.x * props.strideW}px`,
  top: `${props.inst.y * props.strideH}px`,
  width: `${props.inst.w * props.strideW - props.gap}px`,
  height: `${props.inst.h * props.strideH - props.gap}px`,
}));

function onCompEdit(text: string) {
  emit("editText", props.inst.id, text);
}
</script>

<template>
  <div
    class="widget-cell"
    :class="{ editing }"
    :data-widget-id="inst.id"
    :style="pos"
  >
    <div v-if="editing" class="wsh-head" @pointerdown="emit('dragStart', inst.id, $event)">
      <span class="wsh-title">{{ def?.title ?? inst.def }}</span>
      <button
        type="button"
        class="wsh-bind"
        :title="inst.bind ? '微件独立绑定' : '跟随卡主标的'"
        @pointerdown.stop
        @click.stop="bindOpen = !bindOpen"
      >
        {{ bindLabel }}
      </button>
      <span class="wsh-spacer"></span>
      <button
        type="button"
        class="wsh-x"
        title="移除微件"
        @pointerdown.stop
        @click.stop="emit('remove', inst.id)"
      >×</button>

      <div v-if="bindOpen" class="bind-pop" @pointerdown.stop @click.stop>
        <SearchBox @select="(c: string) => pickBind(c)" />
        <div class="bind-quick">
          <button type="button" class="bind-follow" @click="followCard">跟随卡主</button>
        </div>
        <div v-if="ctx.bindings.value.length" class="bind-list">
          <button
            v-for="c in ctx.bindings.value"
            :key="c"
            type="button"
            class="bind-item"
            @click="pickBind(c)"
          >
            <span>{{ ctx.nameOf(c) || c }}</span><em>{{ c }}</em>
          </button>
        </div>
      </div>
    </div>

    <button
      v-if="!editing && cardId"
      type="button"
      class="wsh-pop"
      title="弹出为画中岛"
      @pointerdown.stop
      @click.stop="emit('popout', cardId, inst.id)"
    >
      <svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
    </button>

    <div class="wsh-body">
      <component
        :is="def?.component"
        :bind="inst.bind"
        :text="inst.text"
        @edit="onCompEdit"
      />
    </div>

    <button
      v-if="editing"
      type="button"
      class="wsh-resize"
      @pointerdown.stop="emit('resizeStart', inst.id, $event)"
    ></button>
  </div>
</template>

<style scoped>
.widget-cell { position: absolute; min-width: 0; min-height: 0; }
.widget-cell.editing { border: 1px dashed rgba(232, 200, 120, .55); border-radius: 8px;
  background: rgba(255, 255, 255, .02); }
.wsh-head { position: absolute; inset: 0 0 auto 0; height: 22px; display: flex;
  align-items: center; gap: 6px; padding: 0 6px; cursor: grab; z-index: 3;
  border-bottom: 1px solid rgba(255, 255, 255, .08); }
.wsh-head:active { cursor: grabbing; }
.wsh-title { font-size: 10px; font-weight: 700; color: var(--text); flex-shrink: 0; }
.wsh-bind { border: 1px solid var(--border); background: rgba(0, 0, 0, .25);
  color: var(--text-dim); font-size: 9px; border-radius: 5px; padding: 1px 6px;
  max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.wsh-bind:hover { color: var(--text); border-color: var(--accent, #e8c878); }
.wsh-spacer { flex: 1; }
.wsh-x { width: 18px; height: 18px; border: 0; background: transparent; color: var(--text-dim);
  font-size: 13px; cursor: pointer; border-radius: 4px; line-height: 1; }
.wsh-x:hover { color: #ff6b78; background: rgba(255, 107, 120, .12); }
.wsh-body { position: absolute; inset: 0; }
.editing .wsh-body { inset: 22px 0 0; }
.wsh-resize { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px;
  cursor: nwse-resize; border: 0; background: transparent; z-index: 4; }
.wsh-resize::after { content: ""; position: absolute; right: 3px; bottom: 3px;
  width: 7px; height: 7px; border-right: 2px solid var(--accent, #e8c878);
  border-bottom: 2px solid var(--accent, #e8c878); }

/* 非编辑态微件弹出钮：默认隐藏，hover 显现 */
.wsh-pop { position: absolute; right: 4px; top: 4px; width: 20px; height: 20px;
  border: 1px solid var(--border); background: var(--bg-panel); color: var(--text-dim);
  border-radius: 6px; cursor: pointer; z-index: 5; padding: 3px; opacity: 0;
  transition: opacity .15s ease; }
.wsh-pop svg { width: 100%; height: 100%; }
.widget-cell:hover .wsh-pop { opacity: 1; }
.wsh-pop:hover { color: var(--accent, #e8c878); border-color: var(--accent, #e8c878); }

.bind-pop { position: absolute; top: 24px; left: 4px; width: 230px; z-index: 30;
  padding: 8px; background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 9px; box-shadow: 0 14px 36px rgba(0, 0, 0, .6); }
.bind-quick { margin-top: 7px; }
.bind-follow { width: 100%; height: 24px; border: 1px solid var(--border); background: transparent;
  color: var(--text); font-size: 10px; border-radius: 6px; cursor: pointer; }
.bind-follow:hover { border-color: var(--accent, #e8c878); color: var(--accent, #e8c878); }
.bind-list { margin-top: 7px; max-height: 160px; overflow-y: auto; display: flex;
  flex-direction: column; gap: 2px; }
.bind-item { display: flex; justify-content: space-between; gap: 8px; padding: 4px 7px;
  border: 0; background: transparent; color: var(--text); font-size: 10px;
  border-radius: 5px; cursor: pointer; text-align: left; }
.bind-item:hover { background: var(--bg-hover); }
.bind-item em { font-style: normal; color: var(--text-dim); font-size: 9px; }
</style>
