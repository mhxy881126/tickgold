// 做T决策台图表专用叠加层：支撑/压力/成本/网格档位/在途腿/信号点。
// 拆成纯函数 + 全局指标注册：数据装配可单测，draw 由 klinecharts 每帧调用。
import { registerIndicator } from "klinecharts";
import type { KLineData } from "klinecharts";
import type { KBar } from "../../api/types";
import { UP, DOWN_K, AVG_Y } from "../../lib/chart-styles";

export interface ChartLegLike {
  type: "long" | "short";
  openPrice: number;
  stopPct: number;
  targetPct: number;
}
export interface ChartSignalLike {
  time: number;      // ms，落在某根 bar
  price: number;
  dir: "long" | "short";
  score: number;
}
export interface LevelExtendData {
  prevClose: number;
  levels: { price: number; color: string; dash: number[]; text: string }[];
  signals: { index: number; price: number; dir: "long" | "short"; score: number }[];
}

export function legStopPrice(l: ChartLegLike): number {
  return l.type === "long"
    ? l.openPrice * (1 - (l.stopPct ?? 1.5) / 100)
    : l.openPrice * (1 + (l.stopPct ?? 1.5) / 100);
}
export function legTargetPrice(l: ChartLegLike): number {
  return l.type === "long"
    ? l.openPrice * (1 + (l.targetPct ?? 0.8) / 100)
    : l.openPrice * (1 - (l.targetPct ?? 0.8) / 100);
}

/** 分时数据仅保留 9:30 后的交易时段（剔除集合竞价 bar，保证图起点与时间轴对齐） */
export function minuteSessionOnly(raw: KBar[]): KBar[] {
  return raw.filter((b) => {
    const d = new Date(b.timestamp);
    return d.getUTCHours() * 60 + d.getUTCMinutes() >= 570; // 9:30
  });
}

/** 量柱涨跌色（同花顺口径：该分钟收盘 ≥ 前一分钟收盘 = 红/涨，否则绿/跌） */
export function volBarColor(prevClose: number, close: number): string {
  return close >= prevClose ? "#FF3232" : "#1DBE7D";
}

/**
 * 补一根 15:00 收盘 bar：腾讯分时最后到 14:59，不补则时间轴缺 15:00 收盘刻度（右边界不完整）。
 * 若数据最后一根已是 15:00 或不存在，原样返回。
 */
export function ensureCloseBar(raw: KBar[]): KBar[] {
  if (!raw.length) return raw;
  const last = raw[raw.length - 1];
  const d = new Date(last.timestamp);
  if (d.getUTCHours() * 60 + d.getUTCMinutes() >= 900) return raw; // 已含 15:00
  const closeTs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15, 0);
  // 同分钟幂等：避免多日回放/轮询重复补
  if (raw.some((b) => b.timestamp === closeTs)) return raw;
  return [...raw, { timestamp: closeTs, open: last.close, high: last.close, low: last.close, close: last.close, volume: 0 }];
}

/** 装配做T叠加层数据（纯函数） */
export function buildLevelExtendData(opts: {
  bars: KBar[];
  prevClose: number;
  supportLow: number;
  resistHigh: number;
  cost: number;
  gridLevels: { price: number; label?: string }[];
  legs: ChartLegLike[];
  signals: ChartSignalLike[];
}): LevelExtendData {
  const { bars, prevClose } = opts;
  const levels: LevelExtendData["levels"] = [];
  if (opts.supportLow > 0) {
    levels.push({ price: opts.supportLow, color: "#3ecf8e", dash: [5, 4], text: `支撑 ${opts.supportLow.toFixed(2)}` });
  }
  if (opts.resistHigh > 0) {
    levels.push({ price: opts.resistHigh, color: UP, dash: [5, 4], text: `压力 ${opts.resistHigh.toFixed(2)}` });
  }
  if (opts.cost > 0) {
    levels.push({ price: opts.cost, color: AVG_Y, dash: [], text: `成本 ${opts.cost.toFixed(2)}` });
  }
  for (const g of opts.gridLevels) {
    if (g.price > 0) {
      levels.push({ price: g.price, color: "#3aa0ff", dash: [3, 5], text: g.label ?? `网格 ${g.price.toFixed(2)}` });
    }
  }
  for (const l of opts.legs) {
    if (l.openPrice > 0) {
      levels.push({ price: l.openPrice, color: "#b47cff", dash: [], text: `${l.type === "long" ? "正T" : "倒T"}开 ${l.openPrice.toFixed(2)}` });
      levels.push({ price: legStopPrice(l), color: "#ff5f8f", dash: [4, 4], text: `止损 ${legStopPrice(l).toFixed(2)}` });
      levels.push({ price: legTargetPrice(l), color: "#ffd24d", dash: [4, 4], text: `目标 ${legTargetPrice(l).toFixed(2)}` });
    }
  }
  // 信号点：定位到最近不晚于信号时刻的 bar 索引（防未来函数：只用信号时点之前的数据）
  const signals: LevelExtendData["signals"] = [];
  for (const s of opts.signals) {
    let idx = -1;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].timestamp <= s.time) idx = i;
      else break;
    }
    if (idx >= 0) signals.push({ index: idx, price: s.price, dir: s.dir, score: s.score });
  }
  return { prevClose, levels, signals };
}

let registered = false;
/** 注册做T叠加指标（模块级只注册一次；与 StockChart 的自定义指标互不影响） */
export function registerTmakerLevels() {
  if (registered) return;
  registered = true;
  registerIndicator({
    name: "tmakerLevels",
    shortName: "",
    series: "price" as any,
    calcParams: [],
    figures: [],
    calc: (dl: KLineData[]) => dl.map(() => ({})),
    draw: (params: any) => {
      const { ctx, xAxis, yAxis, bounding, indicator } = params;
      const ext: LevelExtendData | undefined = indicator?.extendData;
      if (!ctx || !ext) return;
      const W = bounding.width;
      const H = bounding.height;
      for (const lv of ext.levels ?? []) {
        const yRaw = yAxis.convertToPixel(lv.price);
        if (!Number.isFinite(yRaw)) continue;
        // 关键价位超出当前可视范围时 clamp 到边缘显示（线+标签始终可见，同花顺式）
        const y = Math.min(Math.max(yRaw, 1), H - 1);
        const clipped = yRaw < 1 || yRaw > H - 1;
        ctx.strokeStyle = lv.color;
        ctx.lineWidth = 1;
        ctx.setLineDash(lv.dash.length ? lv.dash : []);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = lv.color;
        ctx.font = "11px 'Microsoft YaHei', sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(clipped ? `${lv.text} (界外)` : lv.text, 4, y - 2);
      }
      for (const s of ext.signals ?? []) {
        const x = xAxis.convertToPixel(s.index);
        const y = yAxis.convertToPixel(s.price);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        // 做T信号：正T买点（红上箭头 + T买标签 + 分数 + 价格）、倒T卖点（青下箭头 + T卖标签）
        const isLong = s.dir === "long";
        const color = isLong ? UP : DOWN_K;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        if (isLong) {
          ctx.moveTo(x - 7, y - 2);
          ctx.lineTo(x, y - 11);
          ctx.lineTo(x + 7, y - 2);
        } else {
          ctx.moveTo(x - 7, y + 2);
          ctx.lineTo(x, y + 11);
          ctx.lineTo(x + 7, y + 2);
        }
        ctx.stroke();
        const tag = `${isLong ? "T买" : "T卖"} ${s.score}分`;
        ctx.font = "bold 10px 'Microsoft YaHei', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = isLong ? "bottom" : "top";
        ctx.fillText(tag, x, isLong ? y - 12 : y + 12);
        ctx.font = "9px 'Microsoft YaHei', sans-serif";
        ctx.fillStyle = "rgba(255,255,255,.55)";
        ctx.fillText(s.price.toFixed(2), x, isLong ? y - 23 : y + 23);
      }
    },
  } as any);
}

/**
 * 分时成交量柱（涨跌双色，同花顺口径）：
 * 内置 VOL 按 close vs open 分色，而分时 bar 的 open 无方向语义 → 柱子不分色；
 * 此指标按「当前分钟收盘 ≥ 前一根收盘 = 红涨，否则青跌」上色，缩放/滚动时随可视范围自动重绘（与主图联动）。
 */
export function registerTmakerVol() {
  registerIndicator({
    name: "tmakerVol",
    shortName: "量",
    series: "volume" as any,
    precision: 0,
    calcParams: [],
    figures: [],
    calc: (dl: KLineData[]) => dl.map(() => ({})),
    draw: (params: any) => {
      const { ctx, kLineDataList, visibleRange, xAxis, yAxis, barSpace, bounding } = params;
      if (!ctx || !xAxis || !yAxis || !kLineDataList?.length) return;
      const bw = Math.max(3, (barSpace?.bar ?? 6) * 0.72); // 全景 barSpace=1 时保证柱宽可辨
      const yZero = yAxis.convertToPixel(0);
      if (!Number.isFinite(yZero)) return;
      const from = Math.max(0, visibleRange.from);
      const to = Math.min(visibleRange.to, kLineDataList.length - 1);
      // 手动按「可视范围最大成交量」缩放：自定义指标 calc 返回空对象，klinecharts 量轴无数值范围，
      // 直接 convertToPixel(vol) 会全部顶满；改为自行归一化（缩放/滚动随可见 bar 重算，同同花顺）
      let maxVol = 0;
      for (let i = from; i <= to; i++) {
        const v = kLineDataList[i].volume || 0;
        if (v > maxVol) maxVol = v;
      }
      if (maxVol <= 0) return;
      const maxH = bounding.height - 6; // 顶部留 6px
      for (let i = from; i <= to; i++) {
        const d = kLineDataList[i];
        const vol = d.volume || 0;
        if (vol <= 0) continue;
        const prev = i > 0 ? kLineDataList[i - 1].close : d.close;
        const x = xAxis.convertToPixel(i);
        if (!Number.isFinite(x)) continue;
        const h = Math.max(1, (vol / maxVol) * maxH);
        const top = yZero - h; // 量柱从 0 轴向上
        if (top + h < 0 || top > bounding.height) continue;
        ctx.fillStyle = volBarColor(prev, d.close);
        ctx.fillRect(x - bw / 2, top, bw, h);
      }
      // 9:30 首根（i=0）含 9:25 集合竞价撮合量，柱顶标"竞"（免费源仅提供这一笔竞价量，
      // 9:15-9:25 虚拟竞价序列需券商 Level-2，故只在首根标注，不伪造竞价段）
      if (from === 0 && kLineDataList[0].volume > 0) {
        const d0 = kLineDataList[0];
        const x0 = xAxis.convertToPixel(0);
        const h0 = Math.max(1, ((d0.volume || 0) / maxVol) * maxH);
        const t0 = yZero - h0;
        if (Number.isFinite(x0) && t0 > 10) {
          ctx.fillStyle = "#f49045";
          ctx.font = "10px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText("竞", x0, t0 - 1);
        }
      }
    },
  } as any);
}
