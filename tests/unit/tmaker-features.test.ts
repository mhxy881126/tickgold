import { describe, it, expect } from "vitest";
import {
  mean, stddev, zscore, linreg, clamp,
  biasSeriesOf, biasZOf, atr, atrPctOf,
  vwapSlopeBpMin, sideStreakOf, minuteR2,
  bookImbalance, bidAskSpreadPct, activeNetVol,
  priceClusters, relativeStrength,
  regimeOf, regimeAllows, scoreLong, scoreShort, summarize, gradeOf,
} from "../../src/composables/tmaker/features";
import type { KBar, OrderBook, TradeTick, PriceBucket } from "../../src/api/types";

function bar(close: number, avg?: number): KBar {
  return { timestamp: avg ?? 1, open: close, high: close, low: close, close, volume: 100 };
}

describe("基础统计", () => {
  it("mean / stddev / zscore", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(stddev([1, 1, 1])).toBe(0);
    expect(zscore(2, 0, 1)).toBe(2);
    expect(zscore(1, 0, 0)).toBe(0); // σ=0 降级
  });
  it("linreg 斜率为正 / 负 / 平坦", () => {
    expect(linreg([0, 1, 2], [1, 2, 3]).slope).toBeCloseTo(1, 5);
    expect(linreg([0, 1, 2], [3, 2, 1]).slope).toBeCloseTo(-1, 5);
    expect(linreg([0, 1, 2], [5, 5, 5]).slope).toBeCloseTo(0, 5);
    expect(linreg([0, 1], [1, 2]).r2).toBe(0); // 样本不足
  });
  it("clamp", () => {
    expect(clamp(5, 1, 3)).toBe(3);
    expect(clamp(-1, 1, 3)).toBe(1);
    expect(clamp(2, 1, 3)).toBe(2);
  });
});

describe("乖离 z-score", () => {
  it("biasSeriesOf 按每根 VWAP 计算偏离", () => {
    const avgOf = (ts: number) => ts === 1 ? 10 : ts === 2 ? 11 : ts === 3 ? 12 : 0;
    const bars = [bar(9.9, 1), bar(11.1, 2), bar(12.2, 3)];
    const s = biasSeriesOf(bars, avgOf);
    expect(s.length).toBe(3);
    expect(s[0]).toBeCloseTo(-1, 5); // (9.9-10)/10
  });
  it("biasZOf 当前偏离相对当日分布", () => {
    const avgOf = (ts: number) => 10;
    const bars = [bar(9, 1), bar(9.2, 2), bar(9.4, 3), bar(9.6, 4), bar(9.8, 5), bar(10, 6), bar(10.2, 7)];
    const r = biasZOf(-10, bars, avgOf); // 当前偏离 -10%（极端回踩）
    expect(r.z).toBeLessThan(-1);
    expect(r.biasMean).toBeCloseTo(-4, 2); // (-10-8-6-4-2+0+2)/7 = -4
  });
});

describe("ATR 波动率", () => {
  it("atr 取 True Range 均值", () => {
    const bars: KBar[] = [
      { timestamp: 1, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { timestamp: 2, open: 10, high: 12, low: 9, close: 11, volume: 0 }, // TR=3
      { timestamp: 3, open: 11, high: 11, low: 8, close: 8, volume: 0 },  // TR=3 (11-8)
      { timestamp: 4, open: 8, high: 9, low: 7, close: 9, volume: 0 },   // TR=2 (9-7)
    ];
    expect(atr(bars, 3)).toBeCloseTo((3 + 3 + 2) / 3, 5);
  });
  it("atrPctOf 相对最新收盘", () => {
    const bars: KBar[] = [
      { timestamp: 1, open: 10, high: 10, low: 10, close: 10, volume: 0 },
      { timestamp: 2, open: 10, high: 10.5, low: 9.5, close: 10, volume: 0 }, // TR=1
    ];
    expect(atrPctOf(bars, 1)).toBeCloseTo(10, 3); // ATR=1 / 10 = 10%
  });
});

describe("VWAP 斜率 / 单边度", () => {
  it("vwapSlopeBpMin 上升序列为正 bp", () => {
    const series = [10, 10.01, 10.02, 10.03, 10.04]; // 每根 +0.1%
    const slope = vwapSlopeBpMin(series, 5);
    expect(slope).toBeGreaterThan(0);
    expect(slope).toBeCloseTo(10, 0); // 每根 10bp
  });
  it("vwapSlopeBpMin 样本不足返回 0", () => {
    expect(vwapSlopeBpMin([10, 10.01], 5)).toBe(0);
  });
  it("sideStreakOf 计数单侧连续根数", () => {
    const avgOf = () => 10;
    const bars = [bar(10.1), bar(10.2), bar(10.3), bar(9.9)];
    expect(sideStreakOf(bars, avgOf)).toBe(-1); // 最后一根在下方，中断
    expect(sideStreakOf([bar(10.1), bar(10.2), bar(10.3)], avgOf)).toBe(3);
  });
  it("minuteR2 直线序列 R²≈1", () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(10 + i * 0.1));
    expect(minuteR2(bars, 10)).toBeGreaterThan(0.99);
  });
});

describe("盘口微观", () => {
  const ob = {
    name: "x", code: "600001", price: 10, prevClose: 10, open: 10, high: 10, low: 10,
    volume: 0, amount: 0,
    asks: [{ price: 10.02, vol: 100 }],
    bids: [{ price: 9.98, vol: 300 }],
    bidTotal: 300, askTotal: 100,
    outsideVol: 0, insideVol: 0,
  } as unknown as OrderBook;

  it("bookImbalance 买盘强为正", () => {
    expect(bookImbalance(ob)).toBeCloseTo(0.5, 5);
    expect(bookImbalance(null)).toBe(0);
  });
  it("bidAskSpreadPct 价差率", () => {
    expect(bidAskSpreadPct(ob)).toBeCloseTo((0.04 / 10) * 100, 4);
    expect(bidAskSpreadPct(null)).toBe(Infinity);
  });
});

describe("逐笔主动净量", () => {
  const trades: TradeTick[] = [
    { time: "a", price: 10, vol: 100, side: "buy" },
    { time: "b", price: 10, vol: 300, side: "buy" },
    { time: "c", price: 10, vol: 600, side: "sell" },
    { time: "d", price: 10, vol: 100, side: "neutral" },
  ];
  it("net/bigNet 分别统计", () => {
    const r = activeNetVol(trades, 500);
    expect(r.net).toBe(-200); // 400 - 600
    expect(r.bigNet).toBe(-600);
    expect(r.buy).toBe(400);
    expect(r.sell).toBe(600);
  });
});

describe("分价筹码峰", () => {
  const dist: PriceBucket[] = [
    { price: 9.9, vol: 100, buyVol: 60, sellVol: 40 },
    { price: 10.1, vol: 500, buyVol: 300, sellVol: 200 },
    { price: 10.3, vol: 200, buyVol: 100, sellVol: 100 },
    { price: 10.5, vol: 800, buyVol: 500, sellVol: 300 },
  ];
  it("取成交量最大档位的上下支撑/压力", () => {
    const r = priceClusters(dist, 10.2, 3);
    expect(r.top.length).toBe(3);
    expect(r.support).toBe(10.1); // 下方最近大额档
    expect(r.resist).toBe(10.3);
    expect(r.top[0].price).toBe(10.5); // 成交量最大
  });
});

describe("相对强弱", () => {
  it("个股强于大盘为正", () => {
    expect(relativeStrength(2.0, -1.0)).toBe(3.0);
  });
});

describe("市况识别 Regime", () => {
  const base = { bias: 0, maxBias: 3, vwapSlope5: 0, sideStreak: 0, r2: 0.5, marketPct: 0, marketCrash: -1.5 };
  it("极端：乖离超限 或 大盘急跌", () => {
    expect(regimeOf({ ...base, bias: 3.5 })).toBe("extreme");
    expect(regimeOf({ ...base, marketPct: -2 })).toBe("extreme");
  });
  it("单边上行：斜率正 + 单侧", () => {
    expect(regimeOf({ ...base, vwapSlope5: 1.2, sideStreak: 5 })).toBe("up");
  });
  it("单边下行：斜率负 + 单侧", () => {
    expect(regimeOf({ ...base, vwapSlope5: -1.2, sideStreak: -5 })).toBe("down");
  });
  it("震荡默认", () => {
    expect(regimeOf(base)).toBe("range");
  });
  it("regimeAllows 单边只做顺方向、极端禁开仓", () => {
    expect(regimeAllows("up", "long")).toBe(true);
    expect(regimeAllows("up", "short")).toBe(false);
    expect(regimeAllows("down", "short")).toBe(true);
    expect(regimeAllows("down", "long")).toBe(false);
    expect(regimeAllows("range", "long")).toBe(true);
    expect(regimeAllows("range", "short")).toBe(true);
    expect(regimeAllows("extreme", "long")).toBe(false);
    expect(regimeAllows("extreme", "short")).toBe(false);
  });
});

describe("打分卡与分级", () => {
  const ideal = {
    biasZ: -1.0, bookImb: 0.2, actNet: 200, turnUp: true, turnDown: false,
    nearSupportPct: 0.3, nearVwapPct: -0.4, nearResistPct: -0.3,
    relStrength: 0.1, atrPct: 2.0,
  };
  it("理想正T输入高分（≥75）", () => {
    const r = summarize(scoreLong(ideal).parts);
    expect(r.total).toBeGreaterThanOrEqual(75);
    expect(gradeOf(r.total)).toBe("strong");
  });
  it("理想倒T输入高分（≥75）", () => {
    const r = summarize(scoreShort({
      ...ideal, biasZ: 1.0, bookImb: -0.2, actNet: -200, turnUp: false, turnDown: true,
    }).parts);
    expect(r.total).toBeGreaterThanOrEqual(75);
    expect(gradeOf(r.total)).toBe("strong");
  });
  it("对抗因子降分 → 观望", () => {
    // 逆风乖离 + 反向盘口 + 主动净量流出 + 远离支撑
    const r = summarize(scoreLong({
      ...ideal, biasZ: 0.5, bookImb: -0.3, actNet: -300, nearSupportPct: 4, nearVwapPct: 1.5, relStrength: 2.5,
    }).parts);
    expect(r.total).toBeLessThan(60);
    expect(gradeOf(r.total)).toBe("wait");
  });
  it("部分失分 → 预备", () => {
    const r = summarize(scoreLong({
      ...ideal, actNet: -150, turnUp: false, nearSupportPct: 2.5, nearVwapPct: 0.5, relStrength: 1.2,
    }).parts);
    expect(gradeOf(r.total)).toBe("prep");
  });
  it("gradeOf 阈值边界", () => {
    expect(gradeOf(75)).toBe("strong");
    expect(gradeOf(74)).toBe("prep");
    expect(gradeOf(60)).toBe("prep");
    expect(gradeOf(59)).toBe("wait");
  });
});
