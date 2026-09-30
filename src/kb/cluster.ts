// 三路交叉聚类的「概念 + 行业」两路（第三路「成分股涨停反推」即概念路径本身）。
// 纯函数：不读库、不联网；同输入必得同输出，盘后归因可复算、可审计。

export interface SealStock {
  code: string;
  name: string;
  boards: number;
  industry: string;
}

export interface ConceptMembership {
  concept: string;
  codes: string[];
}

export interface ThemeCluster {
  name: string;
  path: "concept" | "industry";
  codes: string[];
  sealCount: number;
  totalBoards: number;
  leaderBoards: number;
  score: number;
}

function summarize(name: string, path: "concept" | "industry", members: SealStock[]): ThemeCluster {
  let totalBoards = 0;
  let leaderBoards = 0;
  for (const m of members) {
    totalBoards += m.boards;
    if (m.boards > leaderBoards) leaderBoards = m.boards;
  }
  const sealCount = members.length;
  return {
    name,
    path,
    codes: members.map((m) => m.code),
    sealCount,
    totalBoards,
    leaderBoards,
    score: totalBoards * 10 + sealCount,
  };
}

export function clusterThemes(stocks: SealStock[], concepts: ConceptMembership[]): ThemeCluster[] {
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const sealedCodes = new Set(stocks.map((s) => s.code));
  const clusters: ThemeCluster[] = [];
  const conceptNames = new Set(concepts.map((c) => c.concept));
  const industryNames = new Set(stocks.map((s) => s.industry));

  // ① 概念路径：成分股中当日涨停 ≥ 2
  for (const c of concepts) {
    // 与当日行业同名的概念标签只是行业的镜像，两路都不重复计入（见同名去重用例）。
    if (industryNames.has(c.concept)) continue;
    const members: SealStock[] = [];
    for (const code of c.codes) {
      if (sealedCodes.has(code)) {
        const stk = byCode.get(code)!;
        members.push(stk);
      }
    }
    if (members.length >= 2) clusters.push(summarize(c.concept, "concept", members));
  }

  // ② 行业路径：同行业涨停 ≥ 3，且该行业没有被同名概念覆盖
  const byIndustry = new Map<string, SealStock[]>();
  for (const stk of stocks) {
    if (!byIndustry.has(stk.industry)) byIndustry.set(stk.industry, []);
    byIndustry.get(stk.industry)!.push(stk);
  }
  for (const [industry, members] of byIndustry) {
    if (members.length >= 3 && !conceptNames.has(industry)) {
      clusters.push(summarize(industry, "industry", members));
    }
  }

  clusters.sort((a, b) => b.score - a.score);
  return clusters;
}
