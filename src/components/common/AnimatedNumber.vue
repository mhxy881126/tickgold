<template>
  <component :is="tag" ref="el" class="animated-number" :class="flashCls">{{ text }}</component>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from "vue";
import {
  fmtPrice, fmtPct, fmtAmount, fmtMoney, isNum,
} from "../../utils/format";
import {
  ticker, tier, TIER_DURATION, easeOutCubic,
} from "../../composables/useMotion";

type Kind = "price" | "pct" | "amount" | "money" | "raw";

const props = withDefaults(
  defineProps<{
    value: number | null | undefined;
    kind?: Kind;
    decimals?: number;
    flash?: boolean;
    tag?: string;
  }>(),
  { kind: "price", decimals: 2, flash: true, tag: "span" }
);

const el = ref<HTMLElement | null>(null);
const shown = ref<number>(isNum(props.value) ? props.value : 0);
const flashCls = ref("");
let unsub: (() => void) | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

const text = computed(() => {
  if (!isNum(props.value)) return "--";
  switch (props.kind) {
    case "pct": return fmtPct(shown.value, props.decimals);
    case "amount": return fmtAmount(shown.value);
    case "money": return fmtMoney(shown.value);
    case "raw": return shown.value.toFixed(props.decimals);
    default: return fmtPrice(shown.value, props.decimals);
  }
});

function clearTween() {
  if (unsub) { unsub(); unsub = null; }
}

function pulseFlash(dir: 1 | -1) {
  if (!props.flash) return;
  if (tier.value === "power") return;
  const cls = dir > 0 ? "flash-up" : "flash-down";
  flashCls.value = "";
  void el.value?.offsetWidth; // 重启动画
  flashCls.value = cls;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashCls.value = ""; }, 720);
}

// 数值变化：判定方向 → 补间（power 档瞬时）
watch(
  () => props.value,
  (n, o) => {
    if (!isNum(n)) return;
    if (!isNum(o)) { shown.value = n; return; }
    if (n === o) return;
    const dir: 1 | -1 = n > o ? 1 : -1;
    pulseFlash(dir);

    const dur = TIER_DURATION[tier.value];
    clearTween();
    if (dur === 0) { shown.value = n; return; }

    const from = shown.value;
    const delta = n - from;
    const start = performance.now();
    unsub = ticker.subscribe((dt) => {
      void dt;
      const p = Math.min(1, (performance.now() - start) / dur);
      shown.value = from + delta * easeOutCubic(p);
      if (p >= 1) {
        shown.value = n;
        clearTween();
      }
    });
  }
);

// 档位切到 power：进行中的补间立即落到终值
watch(tier, (t) => {
  if (t === "power" && isNum(props.value)) {
    clearTween();
    shown.value = props.value;
  }
});

onBeforeUnmount(() => {
  clearTween();
  if (flashTimer) clearTimeout(flashTimer);
});
</script>

<style scoped>
.animated-number {
  display: inline-block;
  font-variant-numeric: tabular-nums;
}
</style>
