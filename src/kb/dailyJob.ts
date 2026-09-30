// 盘后归因作业：f127/f128 个股标签 → 涨停定格 → 概念映射 → 聚类 →
// 题材 upsert → 角色写入 → 退股 left_date → 退潮标记 → 催化剂关联。
// 编排层只管顺序与落库；所有判断都在已测纯函数中（cluster/roles/freshness）。
import { fetchStockThemeTags, type StockThemeTags } from "../api/kb";
import { fetchZtPool } from "../api/market";
import {
  listCatalysts,
  listThemes,
  listThemeStocks,
  linkCatalyst,
  markStocksLeft,
  setThemeStage,
  getThemeByName,
  upsertTheme,
  upsertThemeStock,
  upsertLimitUpRecord,
  type Db,
} from "./repo";
import { clusterThemes, isTradeableConcept, type ConceptMembership, type ThemeCluster } from "./cluster";
import { assignRoles, type RoleInput } from "./roles";
import { matchTheme } from "./catalystPipe";
import type { ThemeStage } from "./types";

export interface DailyResult {
  tradeDate: string;
  themes: number;
  stocks: number;
  limitUp: number;
  linked: number;
}

export function todayCompact(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 生命周期判定（确定性规则；退潮统一由本作业第⑥步按近期活跃性标记）。 */
export function decideStage(
  sealCount: number,
  leaderBoards: number,
  isNew: boolean
): ThemeStage {
  if (leaderBoards >= 3 && sealCount >= 8) return "高潮";
  if (sealCount >= 4) return "发酵";
  if (isNew) return "萌芽";
  return "发酵";
}

export async function runAttributionJob(
  d: Db,
  tradeDateIso: string,
  tradeDateCompact: string
): Promise<DailyResult> {
  const pool = await fetchZtPool(tradeDateCompact);
  if (pool.list.length === 0) throw new Error("涨停池为空");

  // ① f127/f128 个股题材标签（定格前取回）；整链路失败降级为空标签，
  //    行业路径仍可用涨停池自带行业独立聚类。
  let tags: StockThemeTags[] = [];
  try {
    tags = await fetchStockThemeTags(pool.list.map((z) => z.code));
  } catch {
    tags = [];
  }
  const tagByCode = new Map(tags.map((t) => [t.code, t]));
  const industryOf = (code: string, fallback: string): string =>
    tagByCode.get(code)?.industry || fallback;

  // ② 涨停定格：concepts 取个股概念标签顿号拼接；industry 优先 f127
  for (const z of pool.list) {
    const tag = tagByCode.get(z.code);
    await upsertLimitUpRecord(d, {
      tradeDate: tradeDateIso,
      code: z.code,
      name: z.name,
      boards: z.boards,
      firstSeal: z.firstSeal,
      lastSeal: z.lastSeal,
      sealFund: z.fund,
      broken: z.broken,
      turnover: z.turnover,
      industry: industryOf(z.code, z.industry),
      concepts: tag?.concepts.join("，") ?? "",
    });
  }

  // ③ 概念成分映射：聚合所有标签股 concept → codes；
  //    与当日涨停池的交集在 clusterThemes 内部完成。
  const conceptMap = new Map<string, Set<string>>();
  for (const t of tags) {
    for (const concept of t.concepts) {
      // N1：融资融券/股通/MSCI/重仓等全市场通用准指数标签不参与概念归因
      if (!isTradeableConcept(concept)) continue;
      let set = conceptMap.get(concept);
      if (!set) {
        set = new Set();
        conceptMap.set(concept, set);
      }
      set.add(t.code);
    }
  }
  const concepts: ConceptMembership[] = [...conceptMap].map(([concept, codes]) => ({
    concept,
    codes: [...codes],
  }));

  // ④ 聚类
  const sealStocks = pool.list.map((z) => ({
    code: z.code,
    name: z.name,
    boards: z.boards,
    industry: industryOf(z.code, z.industry),
  }));
  // cluster 仅做「概念与行业同名」去重；异名概念已全覆盖某行业全部成员股时，
  // 行业聚类只是概念归因的镜像，编排层再兜底剔除，避免同一批股票重复建题材。
  const clusters = dropCoveredIndustryClusters(clusterThemes(sealStocks, concepts));

  // ⑤ 题材 upsert + 角色写入 + 退股标记
  let stocksWritten = 0;
  const nameByCode = new Map(pool.list.map((z) => [z.code, z.name]));
  for (const c of clusters) {
    const existing = await getThemeByName(d, c.name);
    const stage = decideStage(c.sealCount, c.leaderBoards, !existing);
    const themeId = await upsertTheme(
      d,
      {
        name: c.name,
        stage,
        lastActiveDate: tradeDateIso,
        firstSeenDate: existing?.firstSeenDate ?? tradeDateIso,
      },
      Date.now()
    );

    const roleInputs: RoleInput[] = c.codes.map((code) => {
      const z = pool.list.find((x) => x.code === code)!;
      return { code, name: nameByCode.get(code) ?? code, boards: z.boards, firstSeal: z.firstSeal, sealFund: z.fund };
    });
    const ranked = assignRoles(roleInputs);
    for (const r of ranked) {
      await upsertThemeStock(d, themeId, {
        code: r.code,
        name: r.name,
        role: r.role,
        roleScore: r.roleScore,
        joinedDate: tradeDateIso,
      });
      stocksWritten += 1;
    }

    // M6：今日聚类成分之外、此前未离场的老成员首次缺席 → left_date
    await markStocksLeft(d, themeId, c.codes, tradeDateIso);
  }

  // ⑥ 退潮标记：近期活跃但今日无涨停聚类的题材 → 退潮
  const activeNames = new Set(clusters.map((c) => c.name));
  const recent = await listThemes(d, { activeOn: dateNDaysAgoIso(7) });
  for (const t of recent) {
    if (!activeNames.has(t.name) && t.stage !== "退潮") {
      await setThemeStage(d, t.id, "退潮");
    }
  }

  // ⑦ I3：题材全部落库后补关未关联催化剂（成分股命中 / 标题别名命中）
  const linked = await linkUnlinkedCatalysts(d);

  return { tradeDate: tradeDateIso, themes: clusters.length, stocks: stocksWritten, limitUp: pool.list.length, linked };
}

/**
 * I3 催化剂-题材关联：对 theme_id 为空的催化剂，按 (a) 成分股代码 或
 * (b) 标题命中题材名/别名 关联到第一个命中的题材；每条催化剂只关联一次。
 */
async function linkUnlinkedCatalysts(d: Db): Promise<number> {
  const unlinked = (await listCatalysts(d, { limit: 500 })).filter((c) => c.themeId === null);
  if (unlinked.length === 0) return 0;
  const themes = await listThemes(d);
  if (themes.length === 0) return 0;

  const membersByTheme = new Map<number, Set<string>>();
  for (const t of themes) {
    const rows = await listThemeStocks(d, t.id);
    membersByTheme.set(t.id, new Set(rows.map((r) => r.code)));
  }

  let linked = 0;
  for (const c of unlinked) {
    for (const t of themes) {
      const byMember = c.code !== null && membersByTheme.get(t.id)!.has(c.code);
      const byTitle = matchTheme(c.title, c.code ?? "", themes).themeId === t.id;
      if (byMember || byTitle) {
        await linkCatalyst(d, c.id, t.id, c.code);
        linked += 1;
        break;
      }
    }
  }
  return linked;
}

function dateNDaysAgoIso(n: number): string {
  return isoDate(new Date(Date.now() - n * 86_400_000));
}

/**
 * 剔除被概念聚类完全覆盖的行业镜像聚类：
 * 行业路径成员的每只股票都已出现在（一个或多个）概念聚类中时，行业题材不新增任何
 * 成分股，保留它只会让同一批股票被双重归因。部分覆盖（行业内仍有未解释涨停）保留。
 */
export function dropCoveredIndustryClusters(clusters: ThemeCluster[]): ThemeCluster[] {
  const conceptCodes = new Set<string>();
  for (const c of clusters) {
    if (c.path === "concept") {
      for (const code of c.codes) conceptCodes.add(code);
    }
  }
  return clusters.filter(
    (c) => c.path !== "industry" || !c.codes.every((code) => conceptCodes.has(code))
  );
}
