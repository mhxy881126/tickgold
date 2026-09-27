// 跟随鼠标的同花顺式浮窗：十字光标移动时定位并生成 K线/分时数据行
// 从 StockChart.vue 抽出（行为不变）；纯展示推导，不持有图表实例。
import { ref } from "vue";
import type { Ref } from "vue";
import type { KLineData } from "klinecharts";
import type { KBar } from "../../api/types";
import type { Quote } from "../../api/types";
import { dateLabel, fmtAmt, fmtVol, hhmmUTC } from "../../lib/chart";
import { UP, DOWN_K, FLAT, AVG_Y } from "../../lib/chart-styles";

export interface ChartTab {
  label: string;
  minute?: boolean;
  period?: number;
}

export interface ChartFloatContext {
  host: Ref<HTMLElement | null>;
  active: Ref<number>;
  tabs: ChartTab[];
  currentBars: Ref<KBar[]>;
  q: Ref<Quote | null>;
  amount: Ref<number>;
  prevClose: Ref<number>;
  getAvgMap: () => Map<number, number>;
}

export function useChartFloat(ctx: ChartFloatContext) {
  const { host, active, tabs, currentBars, q, amount, prevClose, getAvgMap } = ctx;

  interface FloatState { visible: boolean; x: number; y: number; rows: any[] }
  const float = ref<FloatState>({ visible: false, x: 0, y: 0, rows: [] });

  const colOf = (v: number) => (v > 0 ? UP : v < 0 ? DOWN_K : FLAT);
  const frow = (label: string, value: string, color?: string) => ({ label, value, color });

  function placeFloat(mx: number, my: number, count: number) {
    const W = host.value?.clientWidth || 800;
    const H = host.value?.clientHeight || 400;
    const fw = 180;
    const fh = count * 21 + 10;
    let fx = mx + 15;
    if (mx > W - fw - 12) fx = mx - fw - 15;
    let fy = my + 15;
    if (my > H - fh - 12) fy = my - fh - 15;
    fx = Math.max(2, Math.min(fx, W - fw - 2));
    fy = Math.max(2, Math.min(fy, H - fh - 2));
    return { x: fx, y: fy };
  }

  function klineFloatRows(data: any) {
    const k: KLineData = data.kLineData;
    const idx: number = data.dataIndex;
    const prevBar = idx > 0 ? currentBars.value[idx - 1] : null;
    const ref = prevBar ? prevBar.close : k.open;
    const chg = k.close - ref;
    const pp = ref ? (chg / ref) * 100 : 0;
    const amp = ref ? ((k.high - k.low) / ref) * 100 : 0;
    const openPct = ref ? ((k.open - ref) / ref) * 100 : 0;
    const isLast = idx === currentBars.value.length - 1;
    const amt = isLast ? fmtAmt(amount.value) : "--";
    const turn = isLast && q.value ? q.value.turnover.toFixed(2) + "%" : "--";
    return [
      { text: dateLabel(k.timestamp), head: true },
      frow("开盘", k.open.toFixed(2)),
      frow("最高", k.high.toFixed(2), UP),
      frow("最低", k.low.toFixed(2), DOWN_K),
      frow("收盘", k.close.toFixed(2)),
      frow("涨幅", (chg >= 0 ? "+" : "") + pp.toFixed(2) + "%", colOf(chg)),
      frow("振幅", amp.toFixed(2) + "%"),
      frow("成交量", fmtVol(k.volume || 0)),
      frow("成交额", amt),
      frow("换手", turn),
      frow("开盘涨幅", (openPct >= 0 ? "+" : "") + openPct.toFixed(2) + "%", colOf(openPct)),
    ];
  }

  function minuteFloatRows(data: any) {
    const k: KLineData = data.kLineData;
    const avg = getAvgMap().get(k.timestamp);
    const pc = prevClose.value;
    const ch = k.close - pc;
    const pp = pc ? (ch / pc) * 100 : 0;
    return [
      { text: hhmmUTC(k.timestamp), head: true },
      frow("价格", k.close.toFixed(2), colOf(ch)),
      frow("均价", avg != null ? avg.toFixed(2) : "--", AVG_Y),
      frow("涨跌", (ch >= 0 ? "+" : "") + ch.toFixed(2), colOf(ch)),
      frow("涨幅", (pp >= 0 ? "+" : "") + pp.toFixed(2) + "%", colOf(ch)),
      frow("成交量", fmtVol(k.volume || 0)),
    ];
  }

  function onCrosshair(data: any) {
    if (!data || !data.kLineData) { float.value.visible = false; return; }
    const tab = tabs[active.value];
    const rows = tab.minute ? minuteFloatRows(data) : klineFloatRows(data);
    const pos = placeFloat(data.x, data.y, rows.length);
    float.value = { visible: true, x: pos.x, y: pos.y, rows };
  }

  return { float, onCrosshair };
}
