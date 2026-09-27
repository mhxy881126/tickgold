import { describe, it, expect } from "vitest";
import {
  pad, round2, fmtVol, fmtAmt, limitRateOf,
  toKData, buildAvgMap, hhmmUTC, dateLabel,
  sameDay, barContains, findBarIndex,
} from "../../src/lib/chart";
import type { KBar } from "../../src/api/types";

// 构造只含所需字段的 KBar
function bar(p: Partial<KBar>): KBar {
  return { timestamp: 0, open: 0, high: 0, low: 0, close: 0, volume: 0, ...p } as KBar;
}

describe("pad / round2", () => {
  it("pad 补零到两位", () => {
    expect(pad(3)).toBe("03");
    expect(pad(12)).toBe("12");
  });
  it("round2 保留两位小数", () => {
    expect(round2(1.236)).toBe(1.24);
    expect(round2(10)).toBe(10);
  });
});

describe("fmtVol / fmtAmt", () => {
  it("fmtVol 手/万手/亿手", () => {
    expect(fmtVol(500)).toBe("500手");
    expect(fmtVol(1e4)).toBe("1.00万手");
    expect(fmtVol(2.5e8)).toBe("2.50亿手");
  });
  it("fmtAmt /万/亿", () => {
    expect(fmtAmt(500)).toBe("500");
    expect(fmtAmt(1e4)).toBe("1.00万");
    expect(fmtAmt(1e8)).toBe("1.00亿");
  });
});

describe("limitRateOf 涨跌停幅度", () => {
  it("ST 为 5%", () => {
    expect(limitRateOf("600001", "ST某某")).toBe(0.05);
  });
  it("创业板 300/301 为 20%", () => {
    expect(limitRateOf("300001")).toBe(0.2);
    expect(limitRateOf("301999")).toBe(0.2);
  });
  it("科创板 688/689 为 20%", () => {
    expect(limitRateOf("688001")).toBe(0.2);
    expect(limitRateOf("689001")).toBe(0.2);
  });
  it("北交所 8/4/920 开头为 30%", () => {
    expect(limitRateOf("830001")).toBe(0.3);
    expect(limitRateOf("430001")).toBe(0.3);
    expect(limitRateOf("920001")).toBe(0.3);
  });
  it("主板 600/000/002 为 10%", () => {
    expect(limitRateOf("600000")).toBe(0.1);
    expect(limitRateOf("000001")).toBe(0.1);
    expect(limitRateOf("002001")).toBe(0.1);
  });
});

describe("toKData / buildAvgMap", () => {
  it("toKData 映射字段，空数组返回空", () => {
    expect(toKData([])).toEqual([]);
    const b = bar({ timestamp: 1, open: 10, high: 11, low: 9, close: 10.5, volume: 100 });
    expect(toKData([b])).toEqual([
      { timestamp: 1, open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
    ]);
  });
  it("buildAvgMap 计算累计成交额/量均价", () => {
    const m = buildAvgMap([
      bar({ timestamp: 1, close: 10, volume: 100 }),
      bar({ timestamp: 2, close: 20, volume: 100 }),
    ]);
    expect(m.get(1)).toBe(10);
    expect(m.get(2)).toBe(15);
  });
  it("buildAvgMap 量为 0 时取当根收盘价", () => {
    const m = buildAvgMap([bar({ timestamp: 1, close: 10, volume: 0 })]);
    expect(m.get(1)).toBe(10);
  });
});

describe("hhmmUTC / dateLabel", () => {
  it("hhmmUTC 输出 HH:MM", () => {
    expect(hhmmUTC(Date.UTC(2026, 8, 27, 9, 30))).toBe("09:30");
    expect(hhmmUTC(Date.UTC(2026, 8, 27, 14, 5))).toBe("14:05");
  });
  it("dateLabel 输出 年-月-日 星期", () => {
    // 2026-09-27 为周日
    expect(dateLabel(Date.UTC(2026, 8, 27))).toBe("2026-09-27 周日");
  });
});

describe("sameDay / barContains", () => {
  it("sameDay 同日为 true、跨日为 false", () => {
    const ts = Date.UTC(2026, 8, 27, 10);
    expect(sameDay(ts, new Date(Date.UTC(2026, 8, 27)))).toBe(true);
    expect(sameDay(ts, new Date(Date.UTC(2026, 8, 28)))).toBe(false);
  });

  it("日 K(101) 按日期归属", () => {
    const b = bar({ timestamp: Date.UTC(2026, 8, 27, 10) });
    expect(barContains(b, new Date(Date.UTC(2026, 8, 27)), 101)).toBe(true);
    expect(barContains(b, new Date(Date.UTC(2026, 8, 28)), 101)).toBe(false);
  });

  it("月 K(103) 按年月归属", () => {
    const b = bar({ timestamp: Date.UTC(2026, 8, 15) });
    expect(barContains(b, new Date(Date.UTC(2026, 8, 1)), 103)).toBe(true);
    expect(barContains(b, new Date(Date.UTC(2026, 9, 1)), 103)).toBe(false);
  });

  it("周 K(102) 按周一为起点的周区间归属", () => {
    // bar 为 2026-09-27（周日），其周区间为 09-21(周一) ~ 09-28
    const b = bar({ timestamp: Date.UTC(2026, 8, 27) });
    expect(barContains(b, new Date(Date.UTC(2026, 8, 23)), 102)).toBe(true);
    expect(barContains(b, new Date(Date.UTC(2026, 8, 28)), 102)).toBe(false);
  });

  it("其他 period 返回 false", () => {
    const b = bar({ timestamp: Date.UTC(2026, 8, 27) });
    expect(barContains(b, new Date(Date.UTC(2026, 8, 27)), 999)).toBe(false);
  });
});

describe("findBarIndex", () => {
  const bars = [
    bar({ timestamp: Date.UTC(2026, 8, 27, 9, 30) }),
    bar({ timestamp: Date.UTC(2026, 8, 27, 9, 35) }),
  ];
  it("分钟周期：取时间最近且在容差内的 K 线", () => {
    expect(findBarIndex(Date.UTC(2026, 8, 27, 9, 31), { period: 5 }, bars)).toBe(0);
    expect(findBarIndex(Date.UTC(2026, 8, 27, 9, 34), { period: 5 }, bars)).toBe(1);
  });
  it("超出容差返回 -1", () => {
    expect(findBarIndex(Date.UTC(2026, 8, 27, 15, 0), { period: 5 }, bars)).toBe(-1);
  });
  it("日 K：按日期归属定位", () => {
    expect(findBarIndex(Date.UTC(2026, 8, 27, 10), { period: 101 }, bars)).toBe(0);
    expect(findBarIndex(Date.UTC(2026, 8, 28, 10), { period: 101 }, bars)).toBe(-1);
  });
});
