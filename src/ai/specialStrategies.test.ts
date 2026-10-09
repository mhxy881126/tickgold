import { describe, it, expect } from "vitest";
import {
  boardReseal,
  boardWeak2Strong,
  auctionGrab,
  elfSurge,
  themeLeader,
  type BoardStock,
  type AuctionStockLike,
  type ElfEventLike,
} from "./specialStrategies";

function board(over: Partial<BoardStock> = {}): BoardStock {
  return {
    code: "600001", name: "测试股", price: 10, pct: 10, amount: 5e8,
    fund: 1e8, boards: 1, firstSeal: 935, lastSeal: 1000, broken: 0,
    turnover: 8, industry: "测试", limitPrice: 10, ...over,
  };
}

describe("打板-炸板回封", () => {
  it("炸板后回封、封单足 → 买入", () => {
    const s = boardReseal(board({ broken: 1, fund: 1e8 }));
    expect(s).not.toBeNull();
    expect(s!.strategy).toBe("board-reseal");
    expect(s!.confidence).toBeGreaterThan(0.4);
  });
  it("未炸板 → null", () => expect(boardReseal(board({ broken: 0 }))).toBeNull());
  it("封单过小 → null", () => expect(boardReseal(board({ broken: 1, fund: 1e7 }))).toBeNull());
  it("高位连板 → null", () => expect(boardReseal(board({ broken: 1, boards: 6 }))).toBeNull());
  it("换手过高 → null", () => expect(boardReseal(board({ broken: 1, turnover: 30 }))).toBeNull());
});

describe("打板-弱转强", () => {
  it("首板早盘封、封单大 → 买入", () => {
    const s = boardWeak2Strong(board({ boards: 1, firstSeal: 940, fund: 1e8 }));
    expect(s).not.toBeNull();
    expect(s!.strategy).toBe("board-weak2strong");
  });
  it("3板以上 → null", () => expect(boardWeak2Strong(board({ boards: 3 }))).toBeNull());
  it("尾盘板 → null", () => expect(boardWeak2Strong(board({ firstSeal: 1400 }))).toBeNull());
  it("封单不足 → null", () => expect(boardWeak2Strong(board({ fund: 1e7 }))).toBeNull());
});

describe("集合竞价抢筹", () => {
  function auction(over: Partial<AuctionStockLike> = {}): AuctionStockLike {
    return {
      code: "600002", name: "竞价股", open: 10.4, prevClose: 10,
      gap: 4, amount: 1e8, price: 10.4, pct: 4, ...over,
    };
  }
  it("高开4%且竞价放量 → 买入", () => {
    const s = auctionGrab(auction(), "flat");
    expect(s).not.toBeNull();
    expect(s!.strategy).toBe("auction-grab");
  });
  it("大盘走弱 → null", () => expect(auctionGrab(auction(), "down")).toBeNull());
  it("高开9%（接近一字）→ null", () => expect(auctionGrab(auction({ gap: 9 }), "flat")).toBeNull());
  it("竞价额过小 → null", () =>
    expect(auctionGrab(auction({ amount: 1e7 }), "flat")).toBeNull());
});

describe("短线精灵异动", () => {
  function elf(over: Partial<ElfEventLike> = {}): ElfEventLike {
    return {
      time: 1, code: "600003", name: "精灵股", price: 10.5, pct: 5,
      kind: "火箭发射", label: "", tone: "up", ...over,
    };
  }
  it("火箭发射 tone=up → 买入", () => {
    const s = elfSurge(elf());
    expect(s).not.toBeNull();
    expect(s!.strategy).toBe("elf-surge");
  });
  it("tone=down → null", () => expect(elfSurge(elf({ tone: "down" }))).toBeNull());
  it("无关异动（大笔卖出）→ null", () =>
    expect(elfSurge(elf({ kind: "大笔卖出" }))).toBeNull());
  it("已涨停 → 交给打板，null", () => expect(elfSurge(elf({ pct: 9.8 }))).toBeNull());
});

describe("题材领涨", () => {
  it("+5% 未涨停 → 买入", () => {
    const s = themeLeader({ code: "1", name: "题材股", price: 10, pct: 5 });
    expect(s).not.toBeNull();
    expect(s!.strategy).toBe("theme-leader");
  });
  it("涨幅过小 → null", () =>
    expect(themeLeader({ code: "1", name: "x", price: 10, pct: 1 })).toBeNull());
  it("已涨停 → null", () =>
    expect(themeLeader({ code: "1", name: "x", price: 10, pct: 9.8 })).toBeNull());
});
