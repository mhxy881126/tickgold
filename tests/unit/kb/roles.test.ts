import { describe, it, expect } from "vitest";
import { assignRoles, roleScore, sealMinutes } from "../../../src/kb/roles";

describe("sealMinutes", () => {
  it("decodes HHMMSS", () => {
    expect(sealMinutes(93005)).toBe(9 * 60 + 30);
    expect(sealMinutes(100000)).toBe(600);
    expect(sealMinutes(145959)).toBe(14 * 60 + 59);
  });
});

describe("roleScore", () => {
  it("rewards board height most heavily", () => {
    const high = roleScore({ code: "a", name: "a", boards: 4, firstSeal: 100000, sealFund: 0 });
    const low = roleScore({ code: "b", name: "b", boards: 1, firstSeal: 93000, sealFund: 5e8 });
    expect(high).toBeGreaterThan(low);
  });
  it("rewards earlier seals and bigger funds at equal boards", () => {
    const early = roleScore({ code: "a", name: "a", boards: 2, firstSeal: 93005, sealFund: 0 });
    const late = roleScore({ code: "b", name: "b", boards: 2, firstSeal: 103000, sealFund: 0 });
    expect(early).toBeGreaterThan(late);
    const rich = roleScore({ code: "c", name: "c", boards: 2, firstSeal: 93005, sealFund: 3e8 });
    expect(rich).toBeGreaterThan(early);
  });
});

describe("assignRoles", () => {
  const stocks = [
    { code: "4", name: "四", boards: 1, firstSeal: 110000, sealFund: 0 },
    { code: "1", name: "一", boards: 3, firstSeal: 93500, sealFund: 2e8 },
    { code: "2", name: "二", boards: 2, firstSeal: 94500, sealFund: 1e8 },
    { code: "3", name: "三", boards: 2, firstSeal: 100000, sealFund: 0 },
  ];

  it("ranks by score and assigns 龙一/龙二/助攻/跟风", () => {
    const out = assignRoles(stocks);
    expect(out.map((r) => r.code)).toEqual(["1", "2", "3", "4"]);
    expect(out.map((r) => r.role)).toEqual(["龙一", "龙二", "助攻", "跟风"]);
  });

  it("flags unique leader on strict board high", () => {
    const out = assignRoles(stocks);
    expect(out[0].uniqueLeader).toBe(true);
  });

  it("does not flag a unique leader on a top tie", () => {
    const tied = [
      { code: "1", name: "一", boards: 2, firstSeal: 93500, sealFund: 2e8 },
      { code: "2", name: "二", boards: 2, firstSeal: 94500, sealFund: 0 },
    ];
    const out = assignRoles(tied);
    expect(out[0].uniqueLeader).toBe(false);
  });
});
