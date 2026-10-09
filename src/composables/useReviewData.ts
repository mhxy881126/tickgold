// 复盘数据组合式 API：统一封装历史模式和实时模式
import { computed, onMounted, ref, watch } from "vue";
import {
  fetchZtPool,
  fetchZbPool,
  fetchLhbList,
  fetchSectors,
  type ZtPool,
  type LhbList,
} from "../api/market";
import type { Sector } from "../api/types";
import {
  buildReviewData,
  type ReviewData,
} from "../utils/reviewBuilder";
import { useMarketFeeds } from "./useMarketFeeds";
import { isTrading } from "../utils/sessions";

export function useReviewData() {
  const dateStr = ref(""); // YYYYMMDD
  const mode = ref<"history" | "realtime">("history");
  const data = ref<ReviewData | null>(null);
  const loading = ref(false);
  const error = ref("");

  // 实时模式的数据来源
  const { radar, events: realtimeEvents, sectors: realtimeSectors } =
    useMarketFeeds();

  // 自动判断默认模式
  function autoMode() {
    mode.value = isTrading() ? "realtime" : "history";
  }

  // 找最近一个有数据的交易日（往前扫最多12天）
  async function findNearestTradingDay(): Promise<string> {
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
      try {
        const zt = await fetchZtPool(ymd);
        if ((zt as any).list && (zt as any).list.length > 0) return ymd;
      } catch {
        /* 跳过 */
      }
    }
    // fallback：今天
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  }

  // 历史模式：拉取数据并构建
  async function loadHistory(date: string) {
    loading.value = true;
    error.value = "";
    try {
      const dateWithDash = date.replace(
        /(\d{4})(\d{2})(\d{2})/,
        "$1-$2-$3"
      );

      const [zt, zb, lhb, indSec, conSec] = await Promise.all([
        fetchZtPool(date).catch(
          () => ({ date, total: 0, list: [] } as ZtPool)
        ),
        fetchZbPool(date).catch(
          () => ({ date, total: 0, list: [] } as ZtPool)
        ),
        fetchLhbList(dateWithDash).catch(() => null),
        fetchSectors("industry").catch(() => [] as Sector[]),
        fetchSectors("concept").catch(() => [] as Sector[]),
      ]);

      // 合并行业+概念板块（去重，取涨跌幅绝对值大的）
      const map = new Map<string, any>();
      for (const s of [...indSec, ...conSec] as any[]) {
        const ex = map.get(s.code);
        if (!ex || Math.abs(s.changePct) > Math.abs(ex.changePct)) {
          map.set(s.code, s);
        }
      }
      const sectors = [...map.values()];

      data.value = buildReviewData(
        zt as any,
        zb as any,
        lhb as LhbList,
        sectors as any
      );
    } catch (e: any) {
      error.value = e?.message || String(e);
    } finally {
      loading.value = false;
    }
  }

  // 加载数据
  async function load(date?: string) {
    if (mode.value === "history") {
      const targetDate =
        date || dateStr.value || (await findNearestTradingDay());
      dateStr.value = targetDate;
      await loadHistory(targetDate);
    }
  }

  // 实时数据转换
  const realtimeData = computed((): ReviewData | null => {
    if (mode.value !== "realtime" || !radar.value) return null;
    const r = radar.value;
    return {
      date: dateStr.value,
      mode: "realtime",
      emotion: {
        sentiment: r.sentiment,
        mood: r.mood,
        hist: r.hist.map((h: any) => (typeof h === "number" ? h : 50)),
        change: 0,
      },
      structure: {
        limitUp: r.limitUp,
        limitDown: r.limitDown,
        broken: r.broken,
        sealRate: 100 - r.brokenRate,
        upCount: r.upCount,
        downCount: r.downCount,
        mainFund:
          realtimeSectors.value.reduce(
            (a: number, s: any) => a + (s.netAmount || 0),
            0
          ) / 1e8,
        maxBoards: r.maxBoards,
        topStock: r.ladder?.[0]?.items?.[0]?.name || "—",
        distribution: [],
      },
      timeline: realtimeEvents.value.map((e: any) => ({
        time: e.time,
        type: mapSpiderType(e.kind),
        code: e.code,
        name: e.name,
        title: e.label,
        desc: e.desc,
        pct: e.pct,
        tone: e.tone as "up" | "down" | "neutral",
        extra: {},
      })),
      sectors: realtimeSectors.value as any,
      ladder: (r.ladder || []) as any,
      lhb: [],
    };
  });

  function mapSpiderType(
    kind: string
  ): "limit_up" | "broken" | "lhb" | "sector" | "promote" | "reseal" {
    switch (kind) {
      case "limit_up":
        return "limit_up";
      case "limit_up_open":
        return "broken";
      case "limit_down":
        return "broken";
      default:
        return "sector";
    }
  }

  // 切换模式
  function setMode(m: "history" | "realtime") {
    if (m === "realtime" && !isTrading()) {
      error.value = "当前非交易时间，无法使用实时模式";
      return;
    }
    mode.value = m;
    error.value = "";
    if (m === "history" && !dateStr.value) {
      load();
    }
  }

  onMounted(() => {
    autoMode();
    load();
  });

  watch(dateStr, (d) => {
    if (mode.value === "history" && d) loadHistory(d);
  });

  return {
    dateStr,
    mode,
    data: computed(() =>
      mode.value === "realtime" ? realtimeData.value : data.value
    ),
    loading,
    error,
    load,
    setMode,
  };
}
