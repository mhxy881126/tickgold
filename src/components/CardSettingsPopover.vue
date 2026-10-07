<template>
  <div v-if="open" class="csp" @pointerdown.stop>
    <div class="csp-tabs">
      <button type="button" :class="{ on: tab === 'look' }" @click="tab = 'look'">外观</button>
      <button type="button" :class="{ on: tab === 'behave' }" @click="tab = 'behave'">行为</button>
    </div>

    <div v-show="tab === 'look'" class="csp-pane">
      <div class="row skin-row">
        <span class="k">皮肤</span>
        <span class="skin-name">{{ currentSkinName }}</span>
      </div>
      <div class="row">
        <span class="k">本卡辉光</span>
        <button
          type="button"
          class="toggle"
          :class="{ on: look.glow !== false }"
          @click="$emit('look', { glow: look.glow === false })"
        >{{ look.glow === false ? "已关" : "开启" }}</button>
        <span class="k" style="width:auto">左条辉光</span>
        <button
          type="button"
          class="toggle"
          :class="{ on: look.barGlow !== false }"
          @click="$emit('look', { barGlow: look.barGlow === false })"
        >{{ look.barGlow === false ? "已关" : "开启" }}</button>
      </div>

      <div class="row">
        <span class="k">主色</span>
        <span class="sws">
          <button
            v-for="c in swatches"
            :key="c"
            type="button"
            class="sw"
            :class="{ on: look.color === c }"
            :style="{ background: c }"
            @click="$emit('look', { color: c })"
          ></button>
        </span>
        <input
          type="color"
          class="pick"
          :value="look.color"
          @input="$emit('look', { color: ($event.target as HTMLInputElement).value })"
        />
      </div>

      <div class="row">
        <span class="k">渐变</span>
        <input type="checkbox" :checked="!!look.gradientTo" @change="onGradToggle" />
        <input
          v-if="look.gradientTo"
          type="color"
          class="pick"
          :value="look.gradientTo"
          @input="$emit('look', { gradientTo: ($event.target as HTMLInputElement).value })"
        />
        <button v-if="look.gradientTo" type="button" class="mini" @click="$emit('look', { gradientTo: '' })">
          清除
        </button>
      </div>

      <div v-if="look.gradientTo" class="row">
        <span class="k">角度</span>
        <input
          type="range"
          min="0"
          max="360"
          :value="look.gradAngle"
          class="rng"
          @input="$emit('look', { gradAngle: Number(($event.target as HTMLInputElement).value) })"
        />
        <span class="val">{{ look.gradAngle }}°</span>
      </div>

      <div class="row">
        <span class="k">不透度</span>
        <input
          type="range"
          min="0.6"
          max="1"
          step="0.02"
          :value="look.opacity"
          class="rng"
          @input="$emit('look', { opacity: Number(($event.target as HTMLInputElement).value) })"
        />
      </div>

      <div class="row">
        <span class="k">圆角</span>
        <input
          type="range"
          min="6"
          max="18"
          step="1"
          :value="look.radius"
          class="rng"
          @input="$emit('look', { radius: Number(($event.target as HTMLInputElement).value) })"
        />
      </div>

      <div class="row">
        <span class="k">边框</span>
        <input
          type="range"
          min="0"
          max="2"
          step="1"
          :value="look.borderWidth"
          class="rng"
          @input="$emit('look', { borderWidth: Number(($event.target as HTMLInputElement).value) })"
        />
      </div>

      <div class="row">
        <span class="k">标题栏</span>
        <span class="seg">
          <button
            v-for="n in 5"
            :key="n"
            type="button"
            class="seg-btn"
            :class="{ on: look.headStyle === n }"
            @click="$emit('look', { headStyle: n })"
          >
            {{ n }}
          </button>
        </span>
      </div>
    </div>

    <div v-show="tab === 'behave'" class="csp-pane">
      <div class="row">
        <span class="k">尺寸</span>
        <input
          class="sz"
          type="number"
          min="1"
          max="12"
          :value="span"
          title="宽（12 列网格中的列数）"
          @change="onSizeChange('w', $event)"
        />
        <span class="sz-x">×</span>
        <input
          class="sz"
          type="number"
          min="1"
          max="12"
          :value="rspan"
          title="高（逻辑行数）"
          @change="onSizeChange('h', $event)"
        />
        <span class="sz-hint">格</span>
      </div>

      <div class="row">
        <span class="k">刷新</span>
        <select
          class="sel"
          :value="refresh"
          @change="$emit('refresh', Number(($event.target as HTMLSelectElement).value))"
        >
          <option :value="0">跟随全局</option>
          <option :value="3">3 秒</option>
          <option :value="5">5 秒</option>
          <option :value="10">10 秒</option>
          <option :value="30">30 秒</option>
        </select>
      </div>

      <div class="row">
        <span class="k">标签</span>
        <input
          class="txt"
          maxlength="4"
          :value="look.tag"
          placeholder="最多4字"
          @input="$emit('tag', ($event.target as HTMLInputElement).value)"
        />
      </div>

      <div class="row">
        <button type="button" class="toggle" :class="{ on: look.pinned }" @click="$emit('pin')">
          置顶{{ look.pinned ? " ✓" : "" }}
        </button>
        <button type="button" class="toggle" :class="{ on: look.locked }" @click="$emit('lock')">
          锁定{{ look.locked ? " ✓" : "" }}
        </button>
      </div>

      <button type="button" class="reset" @click="$emit('reset')">恢复该卡片默认外观</button>
      <button type="button" class="reset" @click="$emit('resetwidgets')">恢复出厂微件模板</button>
    </div>

    <button type="button" class="done" @click="$emit('close')">完成</button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { CARD_SWATCHES } from "../composables/useWorkbench";
import { useSkins } from "../composables/useSkins";

const props = defineProps<{
  open: boolean;
  look: {
    color: string;
    gradientTo: string;
    gradAngle: number;
    opacity: number;
    radius: number;
    borderWidth: number;
    headStyle: number;
    pinned: boolean;
    locked: boolean;
    tag: string;
    glow?: boolean;
    barGlow?: boolean;
  };
  refresh: number;
  span: number;
  rspan: number;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "look", p: Record<string, unknown>): void;
  (e: "refresh", n: number): void;
  (e: "pin"): void;
  (e: "lock"): void;
  (e: "tag", t: string): void;
  (e: "reset"): void;
  (e: "resetwidgets"): void;
  (e: "size", w: number, h: number): void;
}>();

const tab = ref<"look" | "behave">("look");
const swatches = CARD_SWATCHES;

const skins = useSkins();
const currentSkinName = computed(
  () => skins.appSkin.value?.name ?? "默认（无皮肤）"
);

function onGradToggle(ev: Event) {
  const on = (ev.target as HTMLInputElement).checked;
  emit("look", { gradientTo: on ? "#2f6fed" : "" });
}

// 尺寸输入：改宽 / 改高各自触发，另一维保持现值；钳制到 1..12 格
function onSizeChange(axis: "w" | "h", ev: Event) {
  const v = Math.max(1, Math.min(12, Number((ev.target as HTMLInputElement).value) || 1));
  if (axis === "w") emit("size", v, props.rspan);
  else emit("size", props.span, v);
}
</script>

<style scoped>
.csp {
  position: absolute;
  top: 34px;
  right: 8px;
  width: 248px;
  z-index: 60;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-panel);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.6);
}
.csp-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}
.csp-tabs button {
  flex: 1;
  height: 24px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  border-radius: 6px;
  font-size: 11px;
  cursor: pointer;
}
.csp-tabs button.on {
  color: var(--card-accent, var(--text));
  border-color: var(--card-accent, var(--border));
}
.csp-pane {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim);
}
.k {
  width: 42px;
  flex: none;
}
.sws {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  flex: 1;
}
.sw {
  width: 17px;
  height: 17px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  cursor: pointer;
}
.sw.on {
  outline: 2px solid rgba(255, 255, 255, 0.6);
  outline-offset: 1px;
}
.pick {
  width: 28px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  background: transparent;
  border-radius: 5px;
}
.rng {
  flex: 1;
}
.val {
  width: 30px;
  text-align: right;
}
.seg {
  display: flex;
  gap: 3px;
}
.seg-btn {
  width: 24px;
  height: 22px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  border-radius: 5px;
  font-size: 11px;
  cursor: pointer;
}
.seg-btn.on {
  color: var(--card-accent, var(--text));
  border-color: var(--card-accent, var(--border));
}
.sel,
.txt {
  flex: 1;
  height: 24px;
  background: var(--bg-card);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 11px;
  padding: 0 6px;
}
.sz {
  width: 44px;
  height: 24px;
  background: var(--bg-card);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 11px;
  padding: 0 4px;
  text-align: center;
}
.sz-x { color: var(--text-dim); }
.sz-hint { color: var(--text-dim); font-size: 10px; }
.mini {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  border-radius: 5px;
  font-size: 10px;
  padding: 2px 6px;
  cursor: pointer;
}
.toggle {
  flex: 1;
  height: 26px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  border-radius: 6px;
  font-size: 11px;
  cursor: pointer;
}
.toggle.on {
  color: var(--card-accent, var(--text));
  border-color: var(--card-accent, var(--border));
}
.reset {
  width: 100%;
  height: 26px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  border-radius: 6px;
  font-size: 11px;
  cursor: pointer;
}
.done {
  width: 100%;
  height: 26px;
  margin-top: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  border-radius: 6px;
  font-size: 11px;
  cursor: pointer;
}
.done:hover {
  border-color: var(--card-accent, var(--border));
  color: var(--card-accent, var(--text));
}
</style>
