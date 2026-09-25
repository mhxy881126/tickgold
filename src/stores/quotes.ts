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
  let period = 2000;
  let inflight = false; // 防重入：上一次 tick 未返回则跳过，慢网络不堆叠

  async function tick() {
    if (inflight) return;
    const wl = useWatchlistStore();
    if (!wl.loaded || wl.codes.length === 0) {
      map.value = {};
      error.value = "";
      return;
    }
    inflight = true;
    try {
      const list = await fetchQuotes(wl.codes);
      const next: Record<string, Quote> = {};
      for (const q of list) {
        next[q.code] = q;
        // 行情名称回填到自选记录
        wl.ensureName(q.code, q.name);
      }
      // 增量合并：保留旧 Quote 对象引用、就地更新字段，并删除已移除标的，
      // 避免整表替换（map.value = next）导致依赖行情的所有行同时重渲染
      const cur = map.value;
      for (const k of Object.keys(cur)) if (!(k in next)) delete cur[k];
      for (const k of Object.keys(next)) {
        if (cur[k]) Object.assign(cur[k], next[k]);
        else cur[k] = next[k];
      }
      lastUpdate.value = Date.now();
      error.value = "";
    } catch (e) {
      // 失败不清空已有行情，仅记录错误，便于界面提示与排查
      error.value = String(e);
    } finally {
      inflight = false;
    }
  }

  function arm() {
    if (timer != null) return;
    timer = window.setInterval(tick, period);
    polling.value = true;
  }
  function disarm() {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
    polling.value = false;
  }

  // 页面 / 网络状态联动：隐藏或断网立即暂停轮询（省资源、不发无效请求），
  // 回到前台或恢复网络立即 tick 一次再续上轮询，做到断网恢复自动续上、无雪崩
  function onVisibility() {
    if (document.hidden) disarm();
    else {
      arm();
      void tick();
    }
  }
  function onOnline() {
    arm();
    void tick();
  }
  function onOffline() {
    disarm();
  }

  function start(intervalMs = 2000) {
    period = intervalMs;
    if (!document.hidden && navigator.onLine) arm();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    if (navigator.onLine) void tick();
  }
  function stop() {
    disarm();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  }
  /** 按涨跌幅排序的列表（灵动岛等场景使用） */
  function sortedByPct(): Quote[] {
    return Object.values(map.value).sort((a, b) => b.pct - a.pct);
  }

  return { map, lastUpdate, polling, error, tick, start, stop, sortedByPct };
});
