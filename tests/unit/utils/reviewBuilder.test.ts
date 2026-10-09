import { describe, expect, it } from "vitest";
import * as RB from "../../../src/utils/reviewBuilder";

describe("reviewBuilder types", () => {
  it("exports buildReviewData function", () => {
    expect(typeof RB.buildReviewData).toBe("function");
  });
});

describe("buildStructure", () => {
  const mockZt: any = {
    date: "20260115",
    total: 50,
    list: [
      { code: "000001", name: "平安银行", pct: 10.0, boards: 3, firstSeal: 93000, broken: 0, amount: 1e9 },
      { code: "000002", name: "万科A", pct: 10.0, boards: 2, firstSeal: 100000, broken: 1, amount: 5e8 },
      { code: "000003", name: "中集集团", pct: 10.0, boards: 1, firstSeal: 143000, broken: 0, amount: 2e8 },
    ],
  };
  const mockZb: any = {
    date: "20260115",
    total: 10,
    list: [
      { code: "000010", name: "炸板股1", pct: 5.0, boards: 1, firstSeal: 0, broken: 1, amount: 3e8 },
    ],
  };
  const mockSectors: any[] = [
    { code: "BK0001", name: "银行", changePct: 2.5, netAmount: 5e9 },
    { code: "BK0002", name: "地产", changePct: -1.2, netAmount: -2e9 },
  ];

  it("calculates limitUp count correctly", () => {
    const result = RB.buildReviewData(mockZt, mockZb, null, mockSectors);
    expect(result.structure.limitUp).toBe(3);
  });

  it("calculates broken count correctly (zt broken count + zb total)", () => {
    const result = RB.buildReviewData(mockZt, mockZb, null, mockSectors);
    // zt中炸过的1只(broken>0) + 炸板池10只
    expect(result.structure.broken).toBe(11);
  });

  it("calculates sealRate correctly", () => {
    const result = RB.buildReviewData(mockZt, mockZb, null, mockSectors);
    // 封板率 = 涨停 / (涨停 + 炸板) * 100 = 3 / 14 * 100 ≈ 21.4
    const expected = 3 / (3 + 11) * 100;
    expect(result.structure.sealRate).toBeCloseTo(expected, 1);
  });

  it("calculates mainFund correctly (sum of sector netAmount in 亿)", () => {
    const result = RB.buildReviewData(mockZt, mockZb, null, mockSectors);
    // (5e9 - 2e9) / 1e8 = 30亿
    expect(result.structure.mainFund).toBeCloseTo(30, 0);
  });

  it("finds maxBoards and topStock", () => {
    const result = RB.buildReviewData(mockZt, mockZb, null, mockSectors);
    expect(result.structure.maxBoards).toBe(3);
    expect(result.structure.topStock).toBe("平安银行");
  });
});

describe("buildEmotion", () => {
  it("calculates sentiment based on limit up/down and seal rate", () => {
    const zt: any = {
      total: 60,
      list: Array.from({ length: 60 }, (_, i) => ({
        boards: 1, firstSeal: 100000, broken: 0,
        code: String(i), name: String(i), pct: 10,
      })),
    };
    const zb: any = {
      total: 15,
      list: Array.from({ length: 15 }, (_, i) => ({ code: String(i), name: String(i) })),
    };

    const result = RB.buildReviewData(zt, zb, null, []);
    expect(result.emotion.sentiment).toBeGreaterThan(50);
    expect(result.emotion.sentiment).toBeLessThan(95);
  });

  it("returns valid mood string", () => {
    const zt: any = {
      total: 30,
      list: Array.from({ length: 30 }, (_, i) => ({
        boards: 1, firstSeal: 100000, broken: 0,
        code: String(i), name: String(i), pct: 10,
      })),
    };
    const zb: any = {
      total: 20,
      list: Array.from({ length: 20 }, (_, i) => ({ code: String(i), name: String(i) })),
    };

    const result = RB.buildReviewData(zt, zb, null, []);
    expect(["冰点", "低迷", "中性", "活跃", "亢奋"]).toContain(result.emotion.mood);
  });

  it("generates hist array with data points between 0-100", () => {
    const zt: any = {
      total: 40,
      list: Array.from({ length: 40 }, (_, i) => ({
        boards: 1, firstSeal: 93000 + i * 1000, broken: 0,
        code: String(i), name: String(i), pct: 10,
      })),
    };
    const zb: any = { total: 10, list: [] };

    const result = RB.buildReviewData(zt, zb, null, []);
    expect(result.emotion.hist.length).toBeGreaterThan(5);
    for (const h of result.emotion.hist) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(100);
    }
  });
});

describe("buildTimeline", () => {
  const mockZt: any = {
    date: "20260115",
    total: 3,
    list: [
      { code: "000001", name: "平安银行", pct: 10.0, boards: 3, firstSeal: 93500, broken: 0, amount: 1e9 },
      { code: "000002", name: "万科A", pct: 10.0, boards: 2, firstSeal: 101500, broken: 2, amount: 5e8 },
      { code: "000003", name: "中集集团", pct: 10.0, boards: 1, firstSeal: 144500, broken: 0, amount: 2e8 },
    ],
  };
  const mockZb: any = { total: 1, list: [{ code: "000010", name: "炸板股", pct: 5.0 }] };
  const mockLhb: any = {
    date: "2026-01-15",
    total: 2,
    stocks: [
      { code: "000001", name: "平安银行", pct: 10.0, netAmt: 2e8, reasons: ["日涨幅偏离值达7%"] },
    ],
  };
  const mockSectors: any[] = [
    { code: "BK0001", name: "银行", changePct: 3.5, netAmount: 5e9 },
    { code: "BK0002", name: "地产", changePct: 2.1, netAmount: 2e9 },
    { code: "BK0003", name: "煤炭", changePct: -1.5, netAmount: -1e9 },
  ];

  it("builds limit_up nodes from ztPool firstSeal", () => {
    const result = RB.buildReviewData(mockZt, mockZb, mockLhb, mockSectors);
    const limitUps = result.timeline.filter(n => n.type === "limit_up");
    expect(limitUps.length).toBe(2); // 平安银行+中集集团（broken=0）
  });

  it("builds reseal nodes for stocks with broken > 0", () => {
    const result = RB.buildReviewData(mockZt, mockZb, mockLhb, mockSectors);
    const reseals = result.timeline.filter(n => n.type === "reseal");
    expect(reseals.length).toBe(1);
    expect(reseals[0].name).toBe("万科A");
  });

  it("sorts nodes by time ascending", () => {
    const result = RB.buildReviewData(mockZt, mockZb, mockLhb, mockSectors);
    for (let i = 1; i < result.timeline.length; i++) {
      expect(result.timeline[i].time).toBeGreaterThanOrEqual(result.timeline[i - 1].time);
    }
  });

  it("includes lhb nodes when lhbList provided", () => {
    const result = RB.buildReviewData(mockZt, mockZb, mockLhb, mockSectors);
    const lhbs = result.timeline.filter(n => n.type === "lhb");
    expect(lhbs.length).toBeGreaterThan(0);
  });

  it("includes top sector node", () => {
    const result = RB.buildReviewData(mockZt, mockZb, mockLhb, mockSectors);
    const sectors = result.timeline.filter(n => n.type === "sector");
    expect(sectors.length).toBeGreaterThan(0);
    expect(sectors[0].name).toBe("银行");
  });
});

describe("buildLadder", () => {
  it("groups stocks by board count descending", () => {
    const zt: any = {
      list: [
        { code: "1", name: "股1", pct: 10, boards: 3, firstSeal: 93000, broken: 0 },
        { code: "2", name: "股2", pct: 10, boards: 3, firstSeal: 100000, broken: 1 },
        { code: "3", name: "股3", pct: 10, boards: 2, firstSeal: 94500, broken: 0 },
        { code: "4", name: "股4", pct: 10, boards: 1, firstSeal: 140000, broken: 0 },
      ],
    };
    const result = RB.buildReviewData(zt, { list: [] }, null, []);
    expect(result.ladder.length).toBe(3);
    expect(result.ladder[0].boards).toBe(3);
    expect(result.ladder[0].count).toBe(2);
    expect(result.ladder[0].items.length).toBe(2);
  });
});

describe("buildSectors", () => {
  it("sorts sectors by netAmount descending", () => {
    const sectors: any[] = [
      { code: "BK1", name: "A", changePct: 1.0, netAmount: 1e9 },
      { code: "BK2", name: "B", changePct: 3.0, netAmount: 5e9 },
      { code: "BK3", name: "C", changePct: -2.0, netAmount: -3e9 },
    ];
    const result = RB.buildReviewData({ list: [] }, { list: [] }, null, sectors);
    expect(result.sectors.length).toBe(3);
    expect(result.sectors[0].name).toBe("B");
    expect(result.sectors[2].name).toBe("C");
  });
});

describe("buildLhb", () => {
  it("returns empty array for null input", () => {
    const result = RB.buildReviewData({ list: [] }, { list: [] }, null, []);
    expect(result.lhb).toEqual([]);
  });

  it("maps lhb stocks correctly", () => {
    const lhb: any = {
      date: "2026-01-15",
      total: 2,
      stocks: [
        { code: "000001", name: "平安银行", pct: 10.0, netAmt: 200000000, reasons: ["日涨幅偏离值达7%"] },
        { code: "000002", name: "万科A", pct: 8.5, netAmt: -50000000, reasons: ["日换手率达20%"] },
      ],
    };
    const result = RB.buildReviewData({ list: [] }, { list: [] }, lhb, []);
    expect(result.lhb.length).toBe(2);
    expect(result.lhb[0].code).toBe("000001");
    expect(result.lhb[0].netAmt).toBe(200000000);
  });
});
