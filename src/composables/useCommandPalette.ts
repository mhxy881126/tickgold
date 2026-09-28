// 命令面板（Ctrl / ⌘ + K）：模糊搜索所有已注册动作并执行。
// v0.72：从"只列卡片"升级为统一动作表（开卡 / 场景 / 窗口 / 设置），与快捷键共用。
import { computed, nextTick, ref, watch } from "vue";
import { useActions } from "./useActions";

export interface PaletteRow {
  icon: string;
  label: string;
  desc: string;
  cat: string;
  keywords?: string;
  run: () => void;
}

const FALLBACK_ICON = "M12 2a10 10 0 100 20 10 10 0 000-20z";
const PINNED_CATS = ["应用", "场景模板", "窗口"];

export function useCommandPalette() {
  const { list } = useActions();
  const paletteOpen = ref(false);
  const paletteQuery = ref("");
  const pSel = ref(0);
  const pInput = ref<HTMLInputElement | null>(null);

  const all = computed<PaletteRow[]>(() =>
    list()
      .filter((a) => !a.hidden)
      .map((a) => ({
        icon: a.icon ?? FALLBACK_ICON,
        label: a.title,
        desc: a.desc ?? "",
        cat: a.category,
        keywords: a.keywords,
        run: a.run,
      }))
  );

  const pFiltered = computed<PaletteRow[]>(() => {
    const q = paletteQuery.value.trim().toLowerCase();
    if (!q) {
      const pinned = all.value.filter((r) => PINNED_CATS.includes(r.cat));
      const rest = all.value.filter((r) => !PINNED_CATS.includes(r.cat));
      return pinned.concat(rest);
    }
    return all.value.filter((r) =>
      `${r.label} ${r.desc} ${r.cat} ${r.keywords ?? ""}`.toLowerCase().includes(q)
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
    t.run();
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
