// 盘后归因作业：涨停定格 → 概念成分映射 → 聚类 → 题材 upsert → 角色写入 → 退潮标记。
// 编排层只管顺序与落库；所有判断都在已测纯函数中（cluster/roles/freshness）。
import { fetchSectorStocks } from "../api/kb";
import { fetchSectors, fetchZtPool } from "../api/market";
import {
  listThemes,
  setThemeStage,
  getThemeByName,
  upsertTheme,
  upsertThemeStock,
  upsertLimitUpRecord,
  type Db,
} from "./repo";
import { clusterThemes, type ConceptMembership, type ThemeCluster } from "./cluster";
import { assignRoles, type RoleInput } from "./roles";
import type { ThemeStage } from "./types";

export interface DailyResult {
  tradeDate: string;
  themes: number;
  stocks: number;
  limitUp: number;
}

export function todayCompact(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 生命周期判定（确定性规则；连续退潮由 markRetreating 单独处理）。 */
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

  // ① 涨停定格（concepts 先留空，聚类后本版不回填，次日自然带新数据）
  for (const z of pool.list) {
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
      industry: z.industry,
      concepts: "",
    });
  }

  // ② 概念成分映射：取当日概念板块前 40，逐个拉成分；单板块失败跳过
  const sectors = (await fetchSectors("concept")).slice(0, 40);
  const concepts: ConceptMembership[] = [];
  for (const sec of sectors) {
    try {
      const codes = await fetchSectorStocks(sec.code);
      concepts.push({ concept: sec.name, codes });
    } catch {
      /* 单板块降级 */
    }
  }

  // ③ 聚类
  const sealStocks = pool.list.map((z) => ({
    code: z.code,
    name: z.name,
    boards: z.boards,
    industry: z.industry,
  }));
  // cluster 仅做「概念与行业同名」去重；异名概念已全覆盖某行业全部成员股时，
  // 行业聚类只是概念归因的镜像，编排层再兜底剔除，避免同一批股票重复建题材。
  const clusters = dropCoveredIndustryClusters(clusterThemes(sealStocks, concepts));

  // ④ 题材 upsert + 角色写入
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
  }

  // ⑤ 退潮标记：近期活跃但今日无涨停聚类的题材 → 退潮
  const activeNames = new Set(clusters.map((c) => c.name));
  const recent = await listThemes(d, { activeOn: dateNDaysAgoIso(7) });
  for (const t of recent) {
    if (!activeNames.has(t.name) && t.stage !== "退潮") {
      await setThemeStage(d, t.id, "退潮");
    }
  }

  return { tradeDate: tradeDateIso, themes: clusters.length, stocks: stocksWritten, limitUp: pool.list.length };
}

function dateNDaysAgoIso(n: number): string {
  return isoDate(new Date(Date.now() - n * 86_400_000));
}

/**
 * 剔除被概念聚类完全覆盖的行业镜像聚类：
 * 行业路径成员的每只股票都已出现在（一个或多个）概念聚类中时，行业题材不新增任何
 * 成分股，保留它只会让同一批股票被双重归因。部分覆盖（行业内仍有未解释涨停）保留。
 */
function dropCoveredIndustryClusters(clusters: ThemeCluster[]): ThemeCluster[] {
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
