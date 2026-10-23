import { describe, expect, it } from "vitest";
import { buildLevelExtendData, legStopPrice, legTargetPrice, minuteSessionOnly, ensureCloseBar, volBarColor } from "../../src/components/tmaker/tmakerChartLevels";
import type { KBar } from "../../src/api/types";

const bar = (ts: number): KBar => ({ timestamp: ts, open: 10, close: 10, high: 10, low: 10, volume: 100 });
const bars = [bar(1000), bar(2000), bar(3000), bar(4000)];
// 项目分时时间戳语义：UTC 钟点 = 北京钟点（数据源按本地钟点存入 UTC 字段）
const dayUTC = (h: number, m: number) => Date.UTC(2026, 9, 23, h, m);

describe("tmakerChartLevels 做T叠加层", () => {
  it("支撑/压力/成本/网格/腿 全部装配为水平线", () => {
    const ext = buildLevelExtendData({
      bars, prevClose: 10,
      supportLow: 9.8, resistHigh: 10.3, cost: 10.0,
      gridLevels: [{ price: 9.85, label: "档1@9.85" }, { price: 9.9, label: "档2@9.90" }],
      legs: [{ type: "long", openPrice: 9.95, stopPct: 1.5, targetPct: 1.5 }],
      signals: [],
    });
    expect(ext.levels.length).toBe(8); // 支撑+压力+成本+2网格+正T腿(开/止/标)=8
    const texts = ext.levels.map((l) => l.text);
    expect(texts).toContain("支撑 9.80");
    expect(texts).toContain("压力 10.30");
    expect(texts).toContain("成本 10.00");
    expect(texts).toContain("档1@9.85");
    expect(texts).toContain("正T开 9.95");
    expect(texts).toContain("止损 9.80");
    expect(texts).toContain("目标 10.10");
    expect(ext.prevClose).toBe(10);
  });

  it("倒T 腿的止损/目标方向与正T相反", () => {
    expect(legStopPrice({ type: "short", openPrice: 10, stopPct: 1.5, targetPct: 1.5 })).toBeCloseTo(10.15);
    expect(legTargetPrice({ type: "short", openPrice: 10, stopPct: 1.5, targetPct: 1.5 })).toBeCloseTo(9.85);
  });

  it("信号点定位到最近不晚于信号时刻的 bar（防未来函数）", () => {
    const ext = buildLevelExtendData({
      bars, prevClose: 10, supportLow: 0, resistHigh: 0, cost: 0,
      gridLevels: [], legs: [],
      signals: [{ time: 2500, price: 10.05, dir: "long", score: 82 }],
    });
    expect(ext.signals.length).toBe(1);
    expect(ext.signals[0].index).toBe(1); // bars[1].timestamp=2000 ≤ 2500，bars[2]=3000 > 2500
    expect(ext.signals[0].dir).toBe("long");
    expect(ext.signals[0].score).toBe(82);
  });

  it("无任何叠加输入时 levels/signals 为空数组", () => {
    const ext = buildLevelExtendData({ bars, prevClose: 10, supportLow: 0, resistHigh: 0, cost: 0, gridLevels: [], legs: [], signals: [] });
    expect(ext.levels).toEqual([]);
    expect(ext.signals).toEqual([]);
  });
});

describe("minuteSessionOnly 分时竞价过滤", () => {
  it("剔除 9:30 之前的集合竞价 bar，保留交易时段", () => {
    const raw = [
      bar(dayUTC(9, 15)), bar(dayUTC(9, 20)), bar(dayUTC(9, 25)), // 竞价
      bar(dayUTC(9, 30)), bar(dayUTC(10, 0)), bar(dayUTC(14, 59)), // 交易
    ];
    const out = minuteSessionOnly(raw);
    expect(out.length).toBe(3);
    expect(out[0].timestamp).toBe(dayUTC(9, 30));
    expect(out[out.length - 1].timestamp).toBe(dayUTC(14, 59));
  });

  it("全竞价数据 → 空数组", () => {
    expect(minuteSessionOnly([bar(dayUTC(9, 20)), bar(dayUTC(9, 25))])).toEqual([]);
  });
});

describe("ensureCloseBar 补 15:00 收盘 bar", () => {
  it("最后一根 14:59 → 补一根 15:00（沿用收盘价，量 0）", () => {
    const last = { ...bar(dayUTC(14, 59)), close: 10.2 };
    const out = ensureCloseBar([bar(dayUTC(10, 0)), last]);
    expect(out.length).toBe(3);
    const close = out[out.length - 1];
    expect(close.timestamp).toBe(dayUTC(15, 0));
    expect(close.close).toBe(10.2);
    expect(close.volume).toBe(0);
  });

  it("已含 15:00 → 原样返回；空数组 → 原样", () => {
    const has15 = [bar(dayUTC(10, 0)), bar(dayUTC(15, 0))];
    expect(ensureCloseBar(has15)).toEqual(has15);
    expect(ensureCloseBar([])).toEqual([]);
  });

  it("幂等：重复调用不重复补", () => {
    const out1 = ensureCloseBar([bar(dayUTC(14, 59))]);
    const out2 = ensureCloseBar(out1);
    expect(out1.length).toBe(2);
    expect(out2.length).toBe(2);
  });
});

describe("volBarColor 量柱涨跌色", () => {
  it("收盘 ≥ 前收 → 红涨；低于 → 绿跌（同花顺口径）", () => {
    expect(volBarColor(10.0, 10.02)).toBe("#FF3232");
    expect(volBarColor(10.0, 10.0)).toBe("#FF3232");
    expect(volBarColor(10.0, 9.98)).toBe("#1DBE7D");
  });
});
