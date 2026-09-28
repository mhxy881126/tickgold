<script setup lang="ts">
import { onMounted, provide, ref, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import CardContent from "./CardContent.vue";
import { useWorkbench } from "../composables/useWorkbench";
import { useWatchlistStore } from "../stores/watchlist";
import { saveGeometry } from "../lib/cardWindowGeometry";
import type { CardId } from "../lib/cards";

const props = defineProps<{ cardId: CardId }>();

const bench = useWorkbench();
provide("workbench", bench);

const wl = useWatchlistStore();
const selected = ref<string | null>(wl.codes[0] ?? null);
watch(
  () => wl.codes,
  (c) => {
    if (!selected.value && c[0]) selected.value = c[0];
  }
);
function onSelect(code: string) {
  selected.value = code;
}

onMounted(async () => {
  bench.open(props.cardId);
  try {
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const save = async () => {
      const pos = await win.outerPosition();
      const size = await win.innerSize();
      const sf = await win.scaleFactor();
      saveGeometry(props.cardId, {
        width: size.width / sf,
        height: size.height / sf,
        x: pos.x / sf,
        y: pos.y / sf,
      });
    };
    const debounce = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void save(), 400);
    };
    await win.onMoved(debounce);
    await win.onResized(debounce);
  } catch {
    /* web 预览环境忽略 */
  }
});
</script>

<template>
  <div class="card-window">
    <CardContent :id="cardId" :selected="selected" @select="onSelect" />
  </div>
</template>

<style scoped>
.card-window {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  /* 独立窗口需自带不透明底色：Island 的全局透明样式会把 body 置透明 */
  background: var(--bg-card);
  color: var(--text);
  overflow: hidden;
}
</style>
