// 盯盘模式共享：统一订阅涨停雷达 / 短线精灵 / 板块行情，并确保引擎运行
// 说明：radar / spider 为 Rust 单例，start 幂等；这里卸载时只取消前端监听、不 stop 引擎，
// 避免模式切换时「新组件 start 被旧组件 stop」误停，引擎常驻后台（符合盯盘软件本质）。
import { onMounted, onUnmounted, ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  startRadar, startSpider, fetchSectors,
  type RadarData, type SpiderEvent,
} from "../api/market";
import type { Sector } from "../api/types";
import { useWatchlistStore } from "../stores/watchlist";

interface Opts { radar?: boolean; spider?: boolean; sectors?: boolean }

export function useMarketFeeds(opts: Opts = {}) {
  const radar = ref<RadarData | null>(null);
  const events = ref<SpiderEvent[]>([]);
  const sectors = ref<Sector[]>([]);
  const wl = useWatchlistStore();
  const un: UnlistenFn[] = [];
  let timer = 0;

  async function loadSectors() {
    try {
      const [ind, con] = await Promise.all([
        fetchSectors("industry"),
        fetchSectors("concept"),
      ]);
      const map = new Map<string, Sector>();
      [...ind, ...con].forEach((s) => {
        const ex = map.get(s.code);
        if (!ex || Math.abs(s.changePct) > Math.abs(ex.changePct)) map.set(s.code, s);
      });
      sectors.value = [...map.values()];
    } catch (e) {
      console.error("loadSectors", e);
    }
  }

  onMounted(async () => {
    if (opts.radar !== false) {
      un.push(await listen<RadarData>("radar:data", (e) => { radar.value = e.payload; }));
      try { await startRadar(); } catch { /* ignore */ }
    }
    if (opts.spider !== false) {
      un.push(await listen<SpiderEvent[]>("spider:events", (e) => {
        if (e.payload?.length) events.value = e.payload.concat(events.value).slice(0, 200);
      }));
      try { if (!wl.loaded) await wl.load(); await startSpider(wl.codes); } catch { /* ignore */ }
    }
    if (opts.sectors !== false) {
      await loadSectors();
      timer = window.setInterval(loadSectors, 15000);
    }
  });

  onUnmounted(() => {
    un.forEach((f) => f());
    if (timer) clearInterval(timer);
  });

  return { radar, events, sectors, loadSectors };
}
