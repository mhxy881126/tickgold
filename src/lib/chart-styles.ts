// 图表样式共享：颜色常量、LineStyle 辅助、OverlayLine 类型与 buildStyles 样式构建。
// 主图 StockChart 与历史复盘弹窗 MinuteReplayPopup 共用，保证两边视觉一致。

export const UP = "#FF3232";       // 涨：阳线 / 盘口上涨
export const DOWN_K = "#54FCFC";   // K线阴线（青色）
export const DOWN_G = "#1DBE7D";   // 盘口下跌（绿色）
export const FLAT = "#9aa4b8";
export const AVG_Y = "#f5d020";    // 分时均价黄

// 生成完整的 LineStyle（缺字段会导致库内部 mergeLines 读取 dashedValue 崩溃）
export const line = (color: string, size = 1) => ({
  color,
  style: "solid" as const,
  smooth: false,
  size,
  dashedValue: [2, 2] as [number, number],
});

// ===== 多日分时叠加：extendData = OverlayLine[] =====
export interface OverlayLine {
  color: string;
  bold: boolean;
  prevClose: number;
  map: Record<string, number>;
}

// 同花顺风格样式（关闭库自带 tooltip，改用自建浮窗）
// overlay=true（多日叠加）时隐藏主 area 白线，由 multiMinute 统一绘制
export function buildStyles(minute: boolean, overlay = false) {
  const axisText = "#8b93a7";
  const gridLine = "rgba(255,70,70,.16)";
  const base: any = {
    grid: {
      show: true,
      horizontal: { show: true, ...line(gridLine) },
      vertical: { show: true, ...line(gridLine) },
    },
    candle: {
      type: minute ? "area" : "candle_solid",
      bar: {
        upColor: UP, downColor: DOWN_K, noChangeColor: FLAT,
        upBorderColor: UP, downBorderColor: DOWN_K, noChangeBorderColor: FLAT,
        upWickColor: UP, downWickColor: DOWN_K, noChangeWickColor: FLAT,
      },
      area: {
        lineSize: 1, lineColor: overlay ? "rgba(0,0,0,0)" : "#ffffff", value: "close", smooth: false,
        backgroundColor: [
          { offset: 0, color: "rgba(0,0,0,0)" },
          { offset: 1, color: "rgba(0,0,0,0)" },
        ],
        point: { show: false },
      },
      priceMark: {
        show: true,
        high: { show: true, color: axisText },
        low: { show: true, color: axisText },
        last: {
          show: true, upColor: UP, downColor: DOWN_K, noChangeColor: FLAT,
          line: { show: true, color: "rgba(255,255,255,.25)" },
        },
      },
      tooltip: { showRule: "none", showType: "rect" },
    },
    indicator: { ohlc: { upColor: UP, downColor: DOWN_K, noChangeColor: FLAT } },
    xAxis: {
      axisLine: { show: true, color: gridLine },
      tickLine: { show: true, color: gridLine },
      tickText: { show: true, color: axisText },
    },
    yAxis: {
      type: "normal",
      position: minute ? "left" : "right",
      axisLine: { show: true, color: gridLine },
      tickLine: { show: true, color: gridLine },
      tickText: { show: true, color: axisText },
    },
    crosshair: {
      show: true,
      horizontal: {
        show: true, line: { color: "rgba(220,225,240,.45)" },
        text: { backgroundColor: "#363c4e" },
      },
      vertical: {
        show: true, line: { color: "rgba(220,225,240,.45)" },
        text: { backgroundColor: "#363c4e" },
      },
    },
    separator: { color: gridLine },
  };
  return base;
}
