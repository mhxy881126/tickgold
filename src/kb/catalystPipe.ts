import type { AnnounceItem, IrmItem } from "../api/kb";
import { fnv1a } from "./hash";
import { freshness } from "./freshness";
import type { Db } from "./repo";
import { insertCatalystIgnore } from "./repo";
import type {
  CatalystDirection,
  CatalystKind,
  ThemeRow,
} from "./types";

export interface CatalystDraft {
  kind: CatalystKind;
  title: string;
  summary: string;
  source: string;
  sourceUrl: string;
  publishedAt: number;
  direction: CatalystDirection;
  code: string | null;
}

/** 公告标题 → 类型与方向（规则表，确定性）。 */
export function classifyAnnounce(title: string): { kind: CatalystKind; direction: CatalystDirection } {
  const t = title;
  if (/减持|质押|冻结|立案|警示|违规|亏损|下降|风险/.test(t)) {
    const kind: CatalystKind = /减持|质押|冻结|立案|警示|违规/.test(t) ? "company" : "earnings";
    return { kind, direction: "利空" };
  }
  if (/合同|中标|订单|中标通知书/.test(t)) return { kind: "order", direction: "利好" };
  if (/业绩|利润|营收|季报|年报|半年报|预告|快报/.test(t)) return { kind: "earnings", direction: "利好" };
  if (/涨价|提价|价格调整/.test(t)) return { kind: "price", direction: "利好" };
  if (/回购|增持|分红|股权激励/.test(t)) return { kind: "company", direction: "利好" };
  return { kind: "company", direction: "中性" };
}

export function announceToDraft(a: AnnounceItem): CatalystDraft {
  const { kind, direction } = classifyAnnounce(a.title);
  return {
    kind,
    title: a.title,
    summary: a.category,
    source: "cninfo",
    sourceUrl: a.url,
    publishedAt: a.time,
    direction,
    code: a.code || null,
  };
}

export function irmToDraft(i: IrmItem): CatalystDraft {
  return {
    kind: "company",
    title: i.question || `${i.name}投资者问答`,
    summary: `Q:${i.question} A:${i.answer}`,
    source: i.platform,
    sourceUrl: i.url,
    publishedAt: i.time,
    direction: "中性",
    code: i.code || null,
  };
}

/** 标题或股票名命中题材名/别名时关联。 */
export function matchTheme(
  title: string,
  code: string,
  themes: ThemeRow[]
): { themeId: number | null } {
  void code;
  for (const t of themes) {
    const names = [t.name, ...t.aliases.split(/[,，、]/).filter(Boolean)];
    if (names.some((n) => n.length >= 2 && title.includes(n))) {
      return { themeId: t.id };
    }
  }
  return { themeId: null };
}

/** 去重入库：hash 覆盖来源/标题/链接/股票，保证同源同文不重复。 */
export async function ingestCatalysts(
  d: Db,
  drafts: CatalystDraft[],
  now = Date.now()
): Promise<{ inserted: number; linked: number }> {
  let inserted = 0;
  for (const draft of drafts) {
    const ageDays = draft.publishedAt ? (now - draft.publishedAt) / 86_400_000 : 0;
    const hashInput = `${draft.source}|${draft.title}|${draft.sourceUrl}|${draft.code ?? ""}`;
    const ok = await insertCatalystIgnore(d, {
      kind: draft.kind,
      title: draft.title,
      summary: draft.summary,
      source: draft.source,
      sourceUrl: draft.sourceUrl,
      publishedAt: draft.publishedAt,
      direction: draft.direction,
      themeId: null,
      code: draft.code,
      freshScore: freshness(draft.kind, ageDays),
      hash: fnv1a(hashInput),
      collectedAt: now,
    });
    if (ok) inserted += 1;
  }
  return { inserted, linked: 0 };
}
