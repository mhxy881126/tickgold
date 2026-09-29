// 画中岛主窗侧管理：开窗 / 关窗 / 开窗状态 / 主窗 widgets 变更实时同步。
import { onBeforeUnmount, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { db, ensureDb } from "../db/database";
import { pipLabel, resolveGeometry, type PipTarget } from "../lib/pip";
import type { CardId } from "../lib/cards";
import type { CardWidgets } from "../lib/widgets";

export interface PipSyncPayload {
  cardId: CardId;
  widgets: CardWidgets;
}

interface BenchLike {
  widgetsOf(id: CardId): CardWidgets | undefined;
}

export function usePip(
  bench: BenchLike,
  opts: { onSelect?: (code: string) => void } = {}
) {
  const openLabels = ref<Set<string>>(new Set());

  function isOpen(t: PipTarget): boolean {
    return openLabels.value.has(pipLabel(t));
  }

  // 把某卡最新 widgets 推送给对应弹窗（若开着）
  function syncCard(cardId: CardId) {
    const widgets = bench.widgetsOf(cardId);
    if (!widgets || !widgets.items.length) return;
    const payload: PipSyncPayload = { cardId, widgets };
    const cardLabel = pipLabel({ kind: "card", cardId });
    if (openLabels.value.has(cardLabel)) {
      emit("pip:sync", payload);
    }
    for (const inst of widgets.items) {
      const wLabel = pipLabel({ kind: "widget", cardId, widgetId: inst.id });
      if (openLabels.value.has(wLabel)) emit("pip:sync", payload);
    }
  }

  async function openPip(t: PipTarget): Promise<void> {
    const label = pipLabel(t);
    const widgets = bench.widgetsOf(t.cardId);
    if (!widgets || !widgets.items.length) return;
    // 单微件需实例存在
    let inst;
    if (t.kind === "widget") {
      inst = widgets.items.find((i) => i.id === t.widgetId);
      if (!inst) return;
    }

    await ensureDb();
    const rows = await db().select<{ value: string }[]>(
      "SELECT value FROM meta WHERE key='pip_geometry'"
    );
    const geo = resolveGeometry(rows[0]?.value ?? null, t, inst);

    await invoke("open_pip_window", {
      label,
      title: label,
      w: geo.w,
      h: geo.h,
      x: geo.x,
      y: geo.y,
    });
    openLabels.value = new Set(openLabels.value).add(label);

    // 开窗后立即推一次最新布局（弹窗也会自己读快照，双保险）
    syncCard(t.cardId);
  }

  async function closePip(t: PipTarget): Promise<void> {
    const label = pipLabel(t);
    await invoke("close_pip_window", { label });
    const next = new Set(openLabels.value);
    next.delete(label);
    openLabels.value = next;
  }

  let unlistenClosed: (() => void) | null = null;
  let unlistenSelect: (() => void) | null = null;

  onMounted(async () => {
    unlistenClosed = await listen<{ label: string }>("pip:closed", (ev) => {
      const next = new Set(openLabels.value);
      next.delete(ev.payload.label);
      openLabels.value = next;
    });
    if (opts.onSelect) {
      unlistenSelect = await listen<string>("pip:select", (ev) => {
        opts.onSelect?.(ev.payload);
      });
    }
  });

  onBeforeUnmount(() => {
    unlistenClosed?.();
    unlistenSelect?.();
  });

  return { openPip, closePip, isOpen, syncCard, openLabels };
}
