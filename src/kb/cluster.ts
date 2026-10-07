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

// 市场通用/准指数类标签：不是可炒作题材，不参与概念归因。
const UNIVERSAL_TAG_DENY: ReadonlySet<string> = new Set([
  "融资融券", "转融券标的", "沪股通", "深股通", "沪港通", "深港通",
  "MSCI中国", "MSCI概念", "标普道琼A股", "富时罗素概念股", "富时罗素概念",
  "机构重仓", "基金重仓", "社保重仓", "QFII重仓", "券商重仓", "保险重仓",
  "证金持股", "汇金概念",
]);
const UNIVERSAL_TAG_PATTERNS: RegExp[] = [/股通/, /重仓$/, /^MSCI/];

export function isTradeableConcept(name: string): boolean {
  const t = name.trim();
  if (!t || UNIVERSAL_TAG_DENY.has(t)) return false;
  return !UNIVERSAL_TAG_PATTERNS.some((re) => re.test(t));
}

export function clusterThemes(stocks: SealStock[], concepts: ConceptMembership[]): ThemeCluster[] {
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const sealedCodes = new Set(stocks.map((s) => s.code));
  const clusters: ThemeCluster[] = [];
  const conceptNames = new Set(concepts.map((c) => c.concept));
  // f127 缺失时 industry 为空串：空名行业不能参与同名去重，更不能聚出 "" 题材
  const industryNames = new Set(stocks.map((s) => s.industry).filter(Boolean));

  // ① 概念路径：成分股中当日涨停 ≥ 1（宽松阈值，单只涨停也建题材便于跟踪）
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
    if (members.length >= 1) clusters.push(summarize(c.concept, "concept", members));
  }

  // ② 行业路径：同行业涨停 ≥ 2，且该行业没有被同名概念覆盖
  const byIndustry = new Map<string, SealStock[]>();
  for (const stk of stocks) {
    if (!stk.industry) continue; // 空行业标签（hybk 缺失）不建行业聚类
    if (!byIndustry.has(stk.industry)) byIndustry.set(stk.industry, []);
    byIndustry.get(stk.industry)!.push(stk);
  }
  for (const [industry, members] of byIndustry) {
    if (members.length >= 2 && !conceptNames.has(industry)) {
      clusters.push(summarize(industry, "industry", members));
    }
  }

  clusters.sort((a, b) => b.score - a.score);
  return clusters;
}
