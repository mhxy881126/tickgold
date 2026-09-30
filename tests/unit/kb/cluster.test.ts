import { describe, it, expect } from "vitest";
import { clusterThemes, isTradeableConcept } from "../../../src/kb/cluster";
import type { SealStock } from "../../../src/kb/cluster";

function s(code: string, boards: number, industry: string, name = code): SealStock {
  return { code, name, boards, industry };
}

const stocks: SealStock[] = [
  s("300001", 3, "设备"),
  s("300002", 2, "设备"),
  s("300003", 1, "设备"),
  s("600001", 1, "白酒"),
];

const concepts = [
  { concept: "机器人", codes: ["300001", "300002", "300003", "900000"] },
  { concept: "设备", codes: ["300001", "300002", "300003"] }, // 与行业同名，应并入概念不重复
  { concept: "孤独概念", codes: ["600001"] },                  // 仅 1 只涨停，concept 路径不入选
];

describe("isTradeableConcept (N1 通用准指数标签过滤)", () => {
  it("rejects market-wide membership tags", () => {
    expect(isTradeableConcept("融资融券")).toBe(false);
    expect(isTradeableConcept("沪股通")).toBe(false);
  });

  it("accepts real tradeable themes", () => {
    expect(isTradeableConcept("机器人")).toBe(true);
    expect(isTradeableConcept("CXO概念")).toBe(true);
  });

  it("rejects blank names", () => {
    expect(isTradeableConcept("")).toBe(false);
    expect(isTradeableConcept("   ")).toBe(false);
  });

  it("trims surrounding whitespace before judging", () => {
    expect(isTradeableConcept("  机器人 ")).toBe(true);
  });

  it("keeps 央企改革/国企改革 as occasionally traded themes", () => {
    // 复核：央企改革/国企改革在 A 股偶有炒作行情，不属于纯结构性成员标签，不进黑名单。
    expect(isTradeableConcept("央企改革")).toBe(true);
    expect(isTradeableConcept("国企改革")).toBe(true);
  });

  it("rejects pattern-based quasi-index tags", () => {
    expect(isTradeableConcept("沪港通")).toBe(false); // /股通/
    expect(isTradeableConcept("机构重仓")).toBe(false); // /重仓$/
    expect(isTradeableConcept("MSCI概念")).toBe(false); // /^MSCI/
  });
});

describe("clusterThemes", () => {
  it("forms a concept cluster from >=2 sealed members", () => {
    const out = clusterThemes(stocks, concepts);
    const robot = out.find((c) => c.name === "机器人");
    expect(robot).toMatchObject({ path: "concept", sealCount: 3 });
    expect(robot!.codes.sort()).toEqual(["300001", "300002", "300003"]);
  });

  it("scores by total boards and seal count", () => {
    const out = clusterThemes(stocks, concepts);
    const robot = out.find((c) => c.name === "机器人")!;
    expect(robot.totalBoards).toBe(6);
    expect(robot.leaderBoards).toBe(3);
    expect(robot.score).toBe(6 * 10 + 3);
  });

  it("forms an industry cluster for >=3 same-industry seals when no concept covers them", () => {
    const onlyIndustry: SealStock[] = [
      s("100001", 1, "煤炭"), s("100002", 1, "煤炭"), s("100003", 1, "煤炭"),
    ];
    const out = clusterThemes(onlyIndustry, []);
    expect(out.find((c) => c.name === "煤炭")).toMatchObject({ path: "industry", sealCount: 3 });
  });

  it("does not duplicate a concept whose name equals the industry", () => {
    const out = clusterThemes(stocks, concepts);
    expect(out.filter((c) => c.name === "设备")).toHaveLength(0);
  });

  it("rejects concept clusters with fewer than 2 sealed stocks", () => {
    expect(clusterThemes(stocks, concepts).find((c) => c.name === "孤独概念")).toBeUndefined();
  });

  it("does not form an empty-named industry cluster when industry tags are blank", () => {
    // f127 缺失时 hybk 为空串：不能聚出一个 name==="" 的行业题材
    const blankIndustry: SealStock[] = [
      s("300001", 1, ""),
      s("300002", 2, ""),
      s("300003", 3, ""),
    ];
    const out = clusterThemes(blankIndustry, []);
    expect(out.some((c) => c.path === "industry")).toBe(false);
    expect(out.find((c) => c.name === "")).toBeUndefined();
  });

  it("returns clusters sorted by score desc", () => {
    const two: SealStock[] = [
      s("300001", 3, "设备"), s("300002", 2, "设备"), s("300003", 1, "设备"),
      s("100001", 1, "煤炭"), s("100002", 1, "煤炭"), s("100003", 1, "煤炭"),
    ];
    const twoConcepts = [
      { concept: "机器人", codes: ["300001", "300002", "300003"] },
      { concept: "设备", codes: ["300001", "300002", "300003"] },
    ];
    const out = clusterThemes(two, twoConcepts);
    // 机器人 score=63；煤炭是行业路径 score=33；且两者都应存在
    expect(out.map((c) => c.name)).toEqual(["机器人", "煤炭"]);
    for (let i = 1; i < out.length; i++) expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
  });
});
