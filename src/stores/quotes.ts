import { defineStore } from "pinia";
import { ref } from "vue";
import { fetchQuotes } from "../api/market";
import type { Quote } from "../api/types";
import { useWatchlistStore } from "./watchlist";

/** 实时行情：轮询全部自选股（跨分组），按 code 索引 */
export const useQuotesStore = defineStore("quotes", () => {
  const map = ref<Record<string, Quote>>({});
  const lastUpdate = ref<number>(0);
  const polling = ref(false);
  const error = ref("");
  let timer: number | null = null;

  async function tick() {
    const wl = useWatchlistStore();
    if (!wl.loaded || wl.codes.length === 0) {
      map.value = {};
      error.value = "";
      return;
    }
    try {
      const list = await fetchQuotes(wl.codes);
      const next: Record<string, Quote> = {};
      for (const q of list) {
        next[q.code] = q;
        // 行情名称回填到自选记录
        wl.ensureName(q.code, q.name);
      }
      map.value = next;
      lastUpdate.value = Date.now();
      error.value = "";
    } catch (e) {
      // 失败不清空已有行情，仅记录错误，便于界面提示与排查
      error.value = String(e);
    }
  }

  function start(intervalMs = 2000) {
    if (timer != null) return;
    polling.value = true;
    tick();
    timer = window.setInterval(tick, intervalMs);
  }
  function stop() {
    polling.value = false;
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
  }
  /** 按涨跌幅排序的列表（灵动岛等场景使用） */
  function sortedByPct(): Quote[] {
    return Object.values(map.value).sort((a, b) => b.pct - a.pct);
  }

  return { map, lastUpdate, polling, error, tick, start, stop, sortedByPct };
});
