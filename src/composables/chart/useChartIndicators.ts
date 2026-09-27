// 自定义指标注册（同花顺风格分时/主图指标）
// 从 StockChart.vue 抽出（行为不变）；纯注册，不持有响应式状态。
// 依赖：注册时注入当前组件的 code / headName / prevClose 与右轴调度。
import { registerIndicator } from "klinecharts";
import type { KLineData } from "klinecharts";
import type { Ref } from "vue";
import { hhmmUTC, limitRateOf, round2 } from "../../lib/chart";
import { UP, DOWN_K, DOWN_G } from "../../lib/chart-styles";
import type { OverlayLine } from "../../lib/chart-styles";

export interface ChartIndicatorDeps {
  code: Ref<string>;
  headName: Ref<string>;
  prevClose: Ref<number>;
  scheduleRightAxis: (items: { coord: number; pct: number }[]) => void;
}

export function registerCustomIndicators(deps: ChartIndicatorDeps) {
  const { code, headName, prevClose, scheduleRightAxis } = deps;

  // ===== 分时水平参考线 + 右侧百分比刻度（指标 draw 每帧执行，convertToPixel 精确映射）=====
  // 昨收由各 chart 实例通过 extendData.prevClose 传入（主图 / 复盘弹窗互不干扰）
  registerIndicator({
    name: "thsLevels",
    shortName: "",
    series: "price" as any,
    calcParams: [],
    figures: [],
    calc: (dl: KLineData[]) => dl.map(() => ({})),
    draw: (params: any) => {
      const { ctx, yAxis, bounding, indicator } = params;
      const pc = indicator?.extendData?.prevClose || prevClose.value;
      if (!ctx || !(pc > 0)) return;
      const r = limitRateOf(code.value, headName.value);
      const lu = round2(pc * (1 + r)), ld = round2(pc * (1 - r));
      const W = bounding.width, H = bounding.height;
      const hline = (price: number, color: string, dash: boolean) => {
        const y = yAxis.convertToPixel(price);
        if (y == null) return;
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.setLineDash(dash ? [4, 3] : []);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        ctx.setLineDash([]);
      };
      hline(pc, "rgba(225,230,245,.55)", false);
      hline(lu, "rgba(255,50,50,.5)", true);
      hline(ld, "rgba(29,190,125,.5)", true);

      // 右侧百分比刻度：按可视价格范围选一个均匀 step，只显示其整数倍（含 0）
      const items: { coord: number; pct: number }[] = [];
      const pTop = yAxis.convertFromPixel(2), pBot = yAxis.convertFromPixel(H - 2);
      if (pTop != null && pBot != null) {
        const upPct = (pTop - pc) / pc * 100, dnPct = (pc - pBot) / pc * 100;
        const span = Math.max(Math.abs(upPct), Math.abs(dnPct));
        const cands = [0.1,0.2,0.25,0.3,0.4,0.5,0.6,0.8,1,1.5,2,3,4,5,6,8,10];
        let step = cands[cands.length - 1];
        for (const x of cands) { if (span / x <= 6) { step = x; break; } }
        const nHi = Math.ceil(upPct / step), nLo = Math.floor(-dnPct / step);
        for (let n = nLo; n <= nHi; n++) {
          const pct = Math.round(n * step * 100) / 100;
          const y = yAxis.convertToPixel(pc * (1 + pct / 100));
          if (y == null || y < 2 || y > H - 2) continue;
          items.push({ coord: y, pct });
        }
      }
      scheduleRightAxis(items);
    },
  } as any);

  // 仅用于把"昨收"纳入 Y 轴可见范围（线透明不显示）；extendData={prevClose}
  registerIndicator({
    name: "yAnchor",
    shortName: "",
    series: "price" as any,
    calcParams: [],
    figures: [{ key: "lo", type: "line" }, { key: "hi", type: "line" }],
    styles: { lines: [{ color: "transparent", size: 1 }, { color: "transparent", size: 1 }] } as any,
    calc: (dl: KLineData[], indicator: any) => {
      const ed = indicator?.extendData ?? {};
      const lo = ed.lo ?? ed.prevClose ?? 0;
      const hi = ed.hi ?? ed.prevClose ?? lo;
      return dl.map(() => ({ lo, hi }));
    },
  } as any);

  // ===== 交易时段背景：集合竞价窄区 + 上午/下午分段着色 + 午休分隔 =====
  registerIndicator({
    name: "sessionBg",
    shortName: "",
    series: "price" as any,
    calcParams: [],
    figures: [],
    calc: (dl: KLineData[]) => dl.map(() => ({})),
    draw: (params: any) => {
      const { ctx, kLineDataList, xAxis, yAxis, bounding, indicator } = params;
      if (!ctx || !xAxis || kLineDataList.length < 2) return;
      const H = bounding.height;
      let iAm = -1, iPm = -1;
      for (let i = 0; i < kLineDataList.length; i++) {
        const hm = hhmmUTC(kLineDataList[i].timestamp);
        if (hm === "11:30") iAm = i;
        else if (hm === "13:00") iPm = i;
      }
      const last = kLineDataList.length - 1;
      const x0 = xAxis.convertToPixel(0);
      const xLast = xAxis.convertToPixel(last);
      const xAm = iAm >= 0 ? xAxis.convertToPixel(iAm) : x0;
      const xPm = iPm >= 0 ? xAxis.convertToPixel(iPm) : xLast;

      // 上午 / 下午分段底色
      ctx.fillStyle = "rgba(255,72,72,.045)";
      ctx.fillRect(x0, 0, xAm - x0, H);
      ctx.fillStyle = "rgba(70,140,255,.05)";
      ctx.fillRect(xPm, 0, xLast - xPm, H);

      // 集合竞价窄区（第一根左侧）
      if (x0 > 22) {
        ctx.fillStyle = "rgba(245,208,32,.16)";
        ctx.fillRect(x0 - 16, 0, 16, H);
        ctx.save();
        ctx.translate(x0 - 8, H / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.font = "10px sans-serif";
        ctx.fillStyle = "rgba(245,208,32,.85)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("集合竞价", 0, 0);
        ctx.restore();
      }

      // 午休分隔虚线（11:30 与 13:00 相邻 bar 之间）
      if (iAm >= 0 && iPm >= 0) {
        const xb = (xAm + xPm) / 2;
        ctx.strokeStyle = "rgba(200,208,228,.35)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(xb, 0); ctx.lineTo(xb, H); ctx.stroke();
        ctx.setLineDash([]);
      }

      // 时段文字
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = "rgba(255,120,120,.5)";
      ctx.fillText("上午 连续竞价", (x0 + xAm) / 2, 4);
      ctx.fillStyle = "rgba(120,170,255,.55)";
      ctx.fillText("下午 连续竞价", (xPm + xLast) / 2, 4);

      // 多日叠加线（renderPopup 通过 extendData.lines 注入）
      const oLines = indicator?.extendData?.lines as OverlayLine[] | undefined;
      if (oLines?.length) {
        for (const ln of oLines) {
          ctx.strokeStyle = ln.color; ctx.lineWidth = ln.bold ? 1.7 : 1.1;
          ctx.beginPath(); let pen = false;
          kLineDataList.forEach((d: KLineData, i: number) => {
            const p = ln.map[hhmmUTC(d.timestamp)];
            if (p == null || !(p > 0)) { pen = false; return; }
            const x = xAxis.convertToPixel(i);
            const y = yAxis.convertToPixel(p);
            if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
          });
          ctx.stroke();
          if (ln.prevClose > 0) {
            const y = yAxis.convertToPixel(ln.prevClose);
            if (y != null && y >= 0 && y <= bounding.height) {
              ctx.strokeStyle = ln.color; ctx.globalAlpha = .45; ctx.setLineDash([3, 3]);
              ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(bounding.width, y); ctx.stroke();
              ctx.setLineDash([]); ctx.globalAlpha = 1;
            }
          }
        }
      }
    },
  } as any);

  // ===== 分时量比（副图）：当分钟量 / 多日同时段均量；extendData = { "HH:MM": baseVol } =====
  registerIndicator({
    name: "minuteVR",
    shortName: "量比",
    calcParams: [],
    figures: [{ key: "vr", title: "量比: ", type: "line" }],
    calc: (dataList: KLineData[], ind: any) => {
      const base = (ind?.extendData ?? {}) as Record<string, number>;
      return dataList.map((d) => {
        const b = base[hhmmUTC(d.timestamp)];
        return { vr: b && b > 0 ? (d.volume || 0) / b : 0 };
      });
    },
    draw: (params: any) => {
      const { ctx, yAxis, bounding } = params;
      const y = yAxis.convertToPixel(1);
      if (y != null && y >= 0 && y <= bounding.height) {
        ctx.strokeStyle = "rgba(245,208,32,.5)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(bounding.width, y); ctx.stroke();
        ctx.setLineDash([]);
      }
    },
  } as any);

  // ===== 多日分时叠加（主图）：extendData = OverlayLine[] =====
  registerIndicator({
    name: "multiMinute",
    shortName: "",
    series: "price" as any,
    calcParams: [],
    figures: [],
    calc: (dl: KLineData[]) => dl.map(() => ({})),
    draw: (params: any) => {
      const lines = params.indicator?.extendData as OverlayLine[] | undefined;
      if (!lines?.length) return;
      const { ctx, kLineDataList, xAxis, yAxis, bounding } = params;
      for (const ln of lines) {
        ctx.strokeStyle = ln.color;
        ctx.lineWidth = ln.bold ? 1.7 : 1.1;
        ctx.beginPath();
        let pen = false;
        kLineDataList.forEach((d: KLineData, i: number) => {
          const p = ln.map[hhmmUTC(d.timestamp)];
          if (p == null || !(p > 0)) { pen = false; return; }
          const x = xAxis.convertToPixel(i);
          const y = yAxis.convertToPixel(p);
          if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
        });
        ctx.stroke();
        // 该日昨收参考线
        if (ln.prevClose > 0) {
          const y = yAxis.convertToPixel(ln.prevClose);
          if (y != null && y >= 0 && y <= bounding.height) {
            ctx.strokeStyle = ln.color;
            ctx.globalAlpha = .45;
            ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(bounding.width, y); ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
          }
        }
      }
    },
  } as any);

  // ===== 自定义指标①：分时均价 =====
  registerIndicator({
    name: "AVG",
    shortName: "均价",
    series: "price" as any,
    precision: 2,
    figures: [{ key: "avg", title: "均价", type: "line" }],
    calc: (dataList: KLineData[]) => {
      let tv = 0, v = 0;
      return dataList.map((d) => {
        tv += (d.close || 0) * (d.volume || 0);
        v += d.volume || 0;
        return { avg: v > 0 ? tv / v : d.close };
      });
    },
  });

  // ===== 自定义指标②：神奇九转（TD Sequential 简化版）=====
  registerIndicator({
    name: "td9",
    shortName: "九转",
    series: "price" as any,
    calcParams: [],
    figures: [],
    calc: (dataList: KLineData[]) => {
      const result: any[] = [];
      let buySetup = 0, sellSetup = 0; // buy=c<c4（底部，标下方），sell=c>c4（顶部，标上方）
      for (let i = 0; i < dataList.length; i++) {
        const c = dataList[i].close;
        const c4 = i >= 4 ? dataList[i - 4].close : undefined;
        let td = 0, isBuy = false;
        if (c4 !== undefined) {
          if (c < c4) {
            buySetup += 1; sellSetup = 0;
            if (buySetup <= 9) { td = buySetup; isBuy = true; }
            if (buySetup === 9) buySetup = 0;
          } else if (c > c4) {
            sellSetup += 1; buySetup = 0;
            if (sellSetup <= 9) { td = sellSetup; isBuy = false; }
            if (sellSetup === 9) sellSetup = 0;
          } else { buySetup = 0; sellSetup = 0; }
        } else { buySetup = 0; sellSetup = 0; }
        result.push({ td, isBuy });
      }
      return result;
    },
    draw: (params: any) => {
      const { ctx, kLineDataList, indicator, visibleRange, xAxis, yAxis, barSpace } = params;
      if (!ctx || !xAxis || !yAxis || !visibleRange) return;
      const size = Math.max(9, Math.min(13, barSpace?.bar || 6));
      ctx.font = `${size}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let i = visibleRange.from; i <= visibleRange.to; i++) {
        const r = indicator.result?.[i];
        const d = kLineDataList[i];
        if (!r?.td || !d) continue;
        const x = xAxis.convertToPixel(i);
        const y = yAxis.convertToPixel(r.isBuy ? d.low : d.high) + (r.isBuy ? size + 5 : -(size + 5));
        ctx.fillStyle = r.isBuy ? DOWN_K : UP;
        ctx.fillText(String(r.td), x, y);
      }
    },
  } as any);

  // ===== 自定义指标③：K线买卖点（extendData = marks[{index,side}]）=====
  registerIndicator({
    name: "tradePoints",
    shortName: "买卖点",
    series: "price" as any,
    calcParams: [],
    figures: [],
    calc: (dataList: KLineData[]) => dataList.map(() => ({})),
    draw: (params: any) => {
      const marks = params.indicator?.extendData as { index: number; side: string }[] | undefined;
      if (!marks?.length) return;
      const { ctx, kLineDataList, xAxis, yAxis, barSpace } = params;
      const size = Math.max(11, Math.min(16, barSpace?.bar || 8));
      ctx.font = `bold ${size}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const m of marks) {
        const d = kLineDataList[m.index];
        if (!d) continue;
        const x = xAxis.convertToPixel(m.index);
        if (m.side === "buy") {
          ctx.fillStyle = UP;
          ctx.fillText("B", x, yAxis.convertToPixel(d.low) + size + 7);
        } else {
          ctx.fillStyle = DOWN_G;
          ctx.fillText("S", x, yAxis.convertToPixel(d.high) - size - 7);
        }
      }
    },
  } as any);

  // ===== 自定义指标④：ENE 轨道线（同花顺口径：中轨 MA(N)，上/下轨 ±M%，默认 10,11,11）=====
  registerIndicator({
    name: "ENE",
    shortName: "ENE",
    series: "price" as any,
    precision: 2,
    calcParams: [10, 11, 11],
    figures: [
      { key: "upper", title: "UP: ", type: "line" },
      { key: "ene", title: "ENE: ", type: "line" },
      { key: "lower", title: "LOW: ", type: "line" },
    ],
    calc: (dataList: KLineData[], ind: any) => {
      const [n, m1, m2] = (ind.calcParams as number[]).map((x) => Number(x) || 1);
      const out: any[] = [];
      let sum = 0;
      for (let i = 0; i < dataList.length; i++) {
        sum += dataList[i].close;
        if (i >= n) sum -= dataList[i - n].close;
        if (i < n - 1) { out.push({}); continue; }
        const mid = sum / n;
        out.push({
          upper: mid * (1 + m1 / 100),
          ene: mid,
          lower: mid * (1 - m2 / 100),
        });
      }
      return out;
    },
  } as any);
}
