// 命令面板（Ctrl / ⌘ + K）
// 从 App.vue 抽出（行为不变）；toggleCard 由调用方提供，串联聚焦态新增逻辑。
import { computed, nextTick, ref, watch } from "vue";
import type { useWorkbench } from "./useWorkbench";
import { DOCK_GROUPS } from "../lib/dock";
import type { PaletteRow } from "../lib/dock";

type Bench = ReturnType<typeof useWorkbench>;

export function useCommandPalette(bench: Bench, toggleCard: (id: ReturnType<typeof useWorkbench>["openCards"]["value"][number]) => void) {
  const paletteOpen = ref(false);
  const paletteQuery = ref("");
  const pSel = ref(0);
  const pInput = ref<HTMLInputElement | null>(null);
  const paletteAll: PaletteRow[] = DOCK_GROUPS.flatMap((g) =>
    g.items.map((it) => ({ ...it, cat: g.name }))
  );
  const pFiltered = computed<PaletteRow[]>(() => {
    const q = paletteQuery.value.trim().toLowerCase();
    if (!q)
      return paletteAll
        .filter((r) => r.star)
        .concat(paletteAll.filter((r) => !r.star));
    return paletteAll.filter((r) =>
      (r.label + r.desc + r.cat).toLowerCase().includes(q)
    );
  });
  watch(pFiltered, () => {
    pSel.value = 0;
  });
  function openPalette() {
    paletteOpen.value = true;
    paletteQuery.value = "";
    pSel.value = 0;
    nextTick(() => pInput.value?.focus());
  }
  function closePalette() {
    paletteOpen.value = false;
  }
  function runPalette(r?: PaletteRow) {
    const t = r ?? pFiltered.value[pSel.value];
    if (!t) return;
    toggleCard(t.id);
    closePalette();
  }

  return {
    paletteOpen,
    paletteQuery,
    pSel,
    pInput,
    pFiltered,
    openPalette,
    closePalette,
    runPalette,
  };
}
