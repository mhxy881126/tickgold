// 题材库 repo：所有函数接收 db 句柄，便于测试与复用；不持有全局状态。
import type {
  CatalystRow,
  CollectorJob,
  CollectorRunRow,
  LimitUpRecordRow,
  StockRole,
  ThemeDraft,
  ThemeRow,
  ThemeStage,
  ThemeStockRow,
} from "./types";

/** tauri-plugin-sql 句柄的最小结构 */
export interface Db {
  select: <T = unknown>(sql: string, bind?: unknown[]) => Promise<T>;
  execute: (sql: string, bind?: unknown[]) => Promise<{ lastInsertId?: number; rowsAffected: number }>;
}

// ===== snake_case 行映射 =====
function mapRun(r: Record<string, unknown>): CollectorRunRow {
  return {
    id: r.id as number,
    tradeDate: r.trade_date as string,
    job: r.job as CollectorRunRow["job"],
    status: r.status as CollectorRunRow["status"],
    rowsAffected: (r.rows_affected as number) ?? 0,
    error: (r.error as string | null) ?? null,
    startedAt: r.started_at as number,
    finishedAt: (r.finished_at as number | null) ?? null,
  };
}

function mapTheme(r: Record<string, unknown>): ThemeRow {
  return {
    id: r.id as number,
    name: r.name as string,
    aliases: (r.aliases as string) ?? "",
    level: r.level as ThemeRow["level"],
    stage: r.stage as ThemeRow["stage"],
    intro: (r.intro as string) ?? "",
    logic: (r.logic as string) ?? "",
    logicVersion: (r.logic_version as number) ?? 1,
    firstSeenDate: (r.first_seen_date as string | null) ?? null,
    lastActiveDate: (r.last_active_date as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function mapThemeStock(r: Record<string, unknown>): ThemeStockRow {
  return {
    id: r.id as number,
    themeId: r.theme_id as number,
    code: r.code as string,
    name: (r.name as string) ?? "",
    role: r.role as StockRole,
    roleScore: (r.role_score as number) ?? 0,
    joinedDate: r.joined_date as string,
    leftDate: (r.left_date as string | null) ?? null,
  };
}

function mapCatalyst(r: Record<string, unknown>): CatalystRow {
  return {
    id: r.id as number,
    kind: r.kind as CatalystRow["kind"],
    title: r.title as string,
    summary: (r.summary as string) ?? "",
    source: r.source as string,
    sourceUrl: (r.source_url as string) ?? "",
    publishedAt: (r.published_at as number | null) ?? null,
    direction: r.direction as CatalystRow["direction"],
    themeId: (r.theme_id as number | null) ?? null,
    code: (r.code as string | null) ?? null,
    freshScore: (r.fresh_score as number) ?? 1,
    contentHash: r.content_hash as string,
    collectedAt: r.collected_at as number,
  };
}

function mapLimitUp(r: Record<string, unknown>): LimitUpRecordRow {
  return {
    id: r.id as number,
    tradeDate: r.trade_date as string,
    code: r.code as string,
    name: (r.name as string) ?? "",
    boards: (r.boards as number) ?? 1,
    firstSeal: (r.first_seal as number) ?? 0,
    lastSeal: (r.last_seal as number) ?? 0,
    sealFund: (r.seal_fund as number) ?? 0,
    broken: (r.broken as number) ?? 0,
    turnover: (r.turnover as number) ?? 0,
    industry: (r.industry as string) ?? "",
    concepts: (r.concepts as string) ?? "",
  };
}

// ===== collector_run =====
export async function startRun(d: Db, tradeDate: string, job: CollectorJob): Promise<number> {
  const now = Date.now();
  const r = await d.execute(
    `INSERT INTO collector_run(trade_date, job, status, started_at)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(trade_date, job) DO UPDATE SET
       status=excluded.status, error=NULL, started_at=excluded.started_at, finished_at=NULL`,
    [tradeDate, job, "running", now]
  );
  const row = await d.select<Record<string, unknown>[]>(
    "SELECT id FROM collector_run WHERE trade_date=? AND job=?",
    [tradeDate, job]
  );
  return (row[0]?.id as number) ?? r.lastInsertId ?? 0;
}

export async function finishRun(
  d: Db,
  id: number,
  status: "success" | "failed",
  rowsAffected: number,
  error = ""
): Promise<void> {
  await d.execute(
    `UPDATE collector_run SET status=?, rows_affected=?, finished_at=?, error=? WHERE id=?`,
    [status, rowsAffected, Date.now(), error, id]
  );
}

export async function getRun(d: Db, tradeDate: string, job: CollectorJob): Promise<CollectorRunRow | null> {
  const rows = await d.select<Record<string, unknown>[]>(
    "SELECT * FROM collector_run WHERE trade_date=? AND job=?",
    [tradeDate, job]
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

// ===== theme =====
export async function upsertTheme(d: Db, draft: ThemeDraft, now = Date.now()): Promise<number> {
  const existing = await getThemeByName(d, draft.name);
  if (existing) {
    await d.execute(
      `UPDATE theme SET aliases=?, level=?, stage=?, intro=?, logic=?,
                       logic_version=logic_version+1, last_active_date=?, updated_at=?
       WHERE id=?`,
      [
        draft.aliases ?? existing.aliases,
        draft.level ?? existing.level,
        draft.stage ?? existing.stage,
        draft.intro ?? existing.intro,
        draft.logic ?? existing.logic,
        draft.lastActiveDate ?? existing.lastActiveDate,
        now,
        existing.id,
      ]
    );
    return existing.id;
  }
  const r = await d.execute(
    `INSERT INTO theme(name, aliases, level, stage, intro, logic,
                      first_seen_date, last_active_date, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      draft.name,
      draft.aliases ?? "",
      draft.level ?? "分支",
      draft.stage ?? "萌芽",
      draft.intro ?? "",
      draft.logic ?? "",
      draft.firstSeenDate ?? null,
      draft.lastActiveDate ?? draft.firstSeenDate ?? null,
      now,
      now,
    ]
  );
  return r.lastInsertId ?? 0;
}

export async function setThemeStage(d: Db, id: number, stage: ThemeStage, now = Date.now()): Promise<void> {
  await d.execute("UPDATE theme SET stage=?, updated_at=? WHERE id=?", [stage, now, id]);
}

export async function getThemeByName(d: Db, name: string): Promise<ThemeRow | null> {
  const rows = await d.select<Record<string, unknown>[]>("SELECT * FROM theme WHERE name=?", [name]);
  return rows[0] ? mapTheme(rows[0]) : null;
}

export async function listThemes(d: Db, opts: { activeOn?: string } = {}): Promise<ThemeRow[]> {
  if (opts.activeOn) {
    const rows = await d.select<Record<string, unknown>[]>(
      "SELECT * FROM theme WHERE last_active_date >= ? ORDER BY last_active_date DESC",
      [opts.activeOn]
    );
    return rows.map(mapTheme);
  }
  const rows = await d.select<Record<string, unknown>[]>("SELECT * FROM theme ORDER BY last_active_date DESC, id DESC");
  return rows.map(mapTheme);
}

// ===== theme_stock =====
export async function upsertThemeStock(
  d: Db,
  themeId: number,
  r: { code: string; name: string; role: StockRole; roleScore: number; joinedDate: string }
): Promise<void> {
  await d.execute(
    `INSERT INTO theme_stock(theme_id, code, name, role, role_score, joined_date)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(theme_id, code) DO UPDATE SET
       name=excluded.name, role=excluded.role, role_score=excluded.role_score, left_date=NULL`,
    [themeId, r.code, r.name, r.role, r.roleScore, r.joinedDate]
  );
}

export async function listThemeStocks(d: Db, themeId: number): Promise<ThemeStockRow[]> {
  const rows = await d.select<Record<string, unknown>[]>(
    "SELECT * FROM theme_stock WHERE theme_id=? ORDER BY role_score DESC",
    [themeId]
  );
  return rows.map(mapThemeStock);
}

// ===== catalyst =====
type NewCatalyst = { hash: string } & Omit<CatalystRow, "id">;

export async function insertCatalystIgnore(d: Db, c: NewCatalyst): Promise<boolean> {
  const r = await d.execute(
    `INSERT OR IGNORE INTO catalyst(kind, title, summary, source, source_url, published_at,
                                    direction, theme_id, code, fresh_score, content_hash, collected_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.kind, c.title, c.summary, c.source, c.sourceUrl, c.publishedAt,
      c.direction, c.themeId, c.code, c.freshScore, c.hash, c.collectedAt,
    ]
  );
  return r.rowsAffected > 0;
}

export async function linkCatalyst(d: Db, id: number, themeId: number | null, code: string | null): Promise<void> {
  await d.execute("UPDATE catalyst SET theme_id=?, code=? WHERE id=?", [themeId, code, id]);
}

export async function listCatalysts(
  d: Db,
  filter: { code?: string; themeId?: number; limit?: number } = {}
): Promise<CatalystRow[]> {
  const conds: string[] = [];
  const bind: unknown[] = [];
  if (filter.code) { conds.push("code=?"); bind.push(filter.code); }
  if (filter.themeId !== undefined) { conds.push("theme_id=?"); bind.push(filter.themeId); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const lim = filter.limit ? `LIMIT ${filter.limit}` : "";
  const rows = await d.select<Record<string, unknown>[]>(
    `SELECT * FROM catalyst ${where} ORDER BY published_at DESC ${lim}`,
    bind
  );
  return rows.map(mapCatalyst);
}

// ===== limit_up_record =====
export async function upsertLimitUpRecord(d: Db, r: Omit<LimitUpRecordRow, "id">): Promise<void> {
  await d.execute(
    `INSERT INTO limit_up_record(trade_date, code, name, boards, first_seal, last_seal,
                                seal_fund, broken, turnover, industry, concepts)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(trade_date, code) DO UPDATE SET
       name=excluded.name, boards=excluded.boards, first_seal=excluded.first_seal,
       last_seal=excluded.last_seal, seal_fund=excluded.seal_fund, broken=excluded.broken,
       turnover=excluded.turnover, industry=excluded.industry, concepts=excluded.concepts`,
    [
      r.tradeDate, r.code, r.name, r.boards, r.firstSeal, r.lastSeal,
      r.sealFund, r.broken, r.turnover, r.industry, r.concepts,
    ]
  );
}

export async function listLimitUpByDate(d: Db, tradeDate: string): Promise<LimitUpRecordRow[]> {
  const rows = await d.select<Record<string, unknown>[]>(
    "SELECT * FROM limit_up_record WHERE trade_date=? ORDER BY boards DESC, first_seal ASC",
    [tradeDate]
  );
  return rows.map(mapLimitUp);
}

export async function countLimitUpSince(d: Db, code: string, sinceDate: string): Promise<number> {
  const rows = await d.select<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM limit_up_record WHERE code=? AND trade_date >= ?",
    [code, sinceDate]
  );
  return rows[0]?.c ?? 0;
}
