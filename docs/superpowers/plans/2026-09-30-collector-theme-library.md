# v1.7.0 采集增强 + 题材库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收盘后自动产出题材三表（theme / theme_stock / catalyst）与涨停定格表，盘后归因可审计，并提供题材库浏览卡。

**Architecture:** 采集调度沿用 `useTimeSeries.ts` 既有模式——前端 composable 定时触发、Rust command 负责外网抓取、tsx 纯函数负责解析/聚类/归因、tauri-plugin-sql 写入 SQLite。客观数据全部落库后再做计算；外部源（公告/互动易）各自独立降级，单源失败不阻断当日归因作业。

**Tech Stack:** Tauri 2（Rust：reqwest + scraper + serde_json）、Vue 3/TS、tauri-plugin-sql（SQLite，迁移当前最后版本 v31）、Vitest、Playwright。

## Global Constraints

- 数据库迁移只能追加，新版本号从 **v32** 起（当前最后 v31）；禁止修改已有迁移。
- 所有 DDL 用 `CREATE TABLE IF NOT EXISTS`；新列只能 `ALTER TABLE ... ADD COLUMN`。
- 时间戳：SQLite 内统一存 **毫秒级整数**；交易日字符串统一 `YYYY-MM-DD`；传给东财 push2ex 的日期用紧凑串 `YYYYMMDD`。
- 事实口径必须与现有卡片一致：涨停判定、连板数、首封时间、封单金额复用现有 `eastmoney.rs` / `limitup.rs` 逻辑，不另造口径。
- 外部数据只存**标题/摘要 + 原文链接**，不存网页/PDF 全文；每条记录必须有 `source` 与 `content_hash`。
- 网络抓取层必须设置超时与 Referer/UA；解析器对字段缺失宽容（默认空值，不 panic）。
- 单测中禁止真实联网；网络层用 fixture JSON/HTML 驱动，真实联调仅作为手动验证步骤。
- 每个任务结束必须运行对应测试并提交（frequent commits）。
- 界面文案保留「数据来自公开接口，仅供参考，不构成投资建议」口径。

---

## File Structure

**Rust（`src-tauri/src/`）**

- Create `market/announce.rs` — 巨潮公告查询（www.cninfo.com.cn JSON 接口），输出 `AnnounceItem`。
- Create `market/irminteract.rs` — 互动易（深）+ 上证 e 互动增量抓取，永不抛错、空表降级。
- Modify `market/mod.rs` — 注册两个子模块（`pub mod announce; pub mod irminteract;`）。
- Modify `market/eastmoney.rs` — 新增 `sector_stocks(board_code)`：clist 按概念板块代码拉成分股代码。
- Modify `lib.rs` — 追加迁移 v32–v36；新增三个 Tauri command 及注册。

**前端领域层（新建目录 `src/kb/`）**

- Create `src/kb/types.ts` — 题材库领域类型（与表结构一一对应）。
- Create `src/kb/repo.ts` — 五张表的读写函数（repo 风格，db 句柄由参数传入）。
- Create `src/kb/hash.ts` — FNV-1a 稳定哈希（content_hash 用）。
- Create `src/kb/freshness.ts` — 催化剂半衰期与新鲜度衰减纯函数。
- Create `src/kb/cluster.ts` — 三路交叉聚类纯函数（概念路径 + 行业路径）。
- Create `src/kb/roles.ts` — 题材内角色评分（龙一/龙二/助攻/跟风）纯函数。
- Create `src/kb/catalystPipe.ts` — 外部条目 → catalyst 草稿 → 去重入库 → 题材匹配。
- Create `src/kb/dailyJob.ts` — 盘后归因作业编排（涨停定格 + 聚类 + 角色 + 退潮标记）。

**前端 API / UI**

- Create `src/api/kb.ts` — `fetchAnnouncements / fetchIrmLatest / fetchSectorStocks` 封装。
- Create `src/composables/useCollector.ts` — 采集调度器（盘中催化 + 盘后归因，防重入）。
- Create `src/components/ThemeLibrary.vue` — 题材库浏览卡。
- Modify `src/lib/cards.ts` — 新增 CardId `themelib` 与元信息。
- Modify `src/lib/dock.ts` — 「板块题材」域加入口。
- Modify `src/lib/layout.ts` — WIDE_ORDER 与尺寸表加入 `themelib`。
- Modify `src/lib/scenes.ts` — 盘后复盘场景加入 `themelib`。
- Modify `src/components/CardContent.vue` — 渲染分支。
- Modify `src/components/SettingsDialog.vue` — 数据中心显示三个采集作业状态。
- Modify `src/App.vue` — 启动采集调度器。

**测试（`tests/unit/kb/`）**

- `repo.test.ts / hash.test.ts / freshness.test.ts / cluster.test.ts / roles.test.ts / catalystPipe.test.ts / dailyJob.test.ts`
- Rust 内联测试：`announce.rs`、`irminteract.rs`、`eastmoney.rs`（fixture 解析）。

---

## Task 1: 数据库迁移 v32–v36 + 领域类型

**Files:**

- Modify: `src-tauri/src/lib.rs`（在 v31 skin 迁移之后追加五个 Migration）
- Create: `src/kb/types.ts`

**Interfaces:**

- Produces: 五张表 `collector_run / theme / theme_stock / catalyst / limit_up_record`；领域类型见 `src/kb/types.ts`（后续所有任务引用这些名称）。

- [ ] **Step 1: 追加迁移（在 lib.rs 中最后一个 Migration（version 31）的右括号与 `.build()` 之间插入）**

打开 `src-tauri/src/lib.rs`，定位到约 958 行（version: 31 的 Migration 结束、随后是 `)` 和 `.build(),`）。在该 Migration 的 `},` 之后插入：

```rust
                        Migration {
                            version: 32,
                            description: "collector run status",
                            sql: "CREATE TABLE IF NOT EXISTS collector_run (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                trade_date TEXT NOT NULL,
                                job TEXT NOT NULL,
                                status TEXT NOT NULL,
                                rows_affected INTEGER DEFAULT 0,
                                error TEXT,
                                started_at INTEGER NOT NULL,
                                finished_at INTEGER,
                                UNIQUE(trade_date, job)
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 33,
                            description: "theme profile",
                            sql: "CREATE TABLE IF NOT EXISTS theme (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                name TEXT NOT NULL UNIQUE,
                                aliases TEXT DEFAULT '',
                                level TEXT DEFAULT '分支',
                                stage TEXT DEFAULT '萌芽',
                                intro TEXT DEFAULT '',
                                logic TEXT DEFAULT '',
                                logic_version INTEGER DEFAULT 1,
                                first_seen_date TEXT,
                                last_active_date TEXT,
                                created_at INTEGER NOT NULL,
                                updated_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 34,
                            description: "theme stock membership",
                            sql: "CREATE TABLE IF NOT EXISTS theme_stock (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                theme_id INTEGER NOT NULL REFERENCES theme(id),
                                code TEXT NOT NULL,
                                name TEXT DEFAULT '',
                                role TEXT NOT NULL DEFAULT '跟风',
                                role_score REAL DEFAULT 0,
                                joined_date TEXT NOT NULL,
                                left_date TEXT,
                                UNIQUE(theme_id, code)
                            );
                            CREATE INDEX IF NOT EXISTS idx_theme_stock_code ON theme_stock(code);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 35,
                            description: "catalyst events",
                            sql: "CREATE TABLE IF NOT EXISTS catalyst (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                kind TEXT NOT NULL,
                                title TEXT NOT NULL,
                                summary TEXT DEFAULT '',
                                source TEXT NOT NULL,
                                source_url TEXT DEFAULT '',
                                published_at INTEGER,
                                direction TEXT DEFAULT '中性',
                                theme_id INTEGER REFERENCES theme(id),
                                code TEXT,
                                fresh_score REAL DEFAULT 1,
                                content_hash TEXT NOT NULL UNIQUE,
                                collected_at INTEGER NOT NULL
                            );
                            CREATE INDEX IF NOT EXISTS idx_catalyst_code ON catalyst(code);
                            CREATE INDEX IF NOT EXISTS idx_catalyst_theme ON catalyst(theme_id);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 36,
                            description: "daily limit-up snapshot",
                            sql: "CREATE TABLE IF NOT EXISTS limit_up_record (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                trade_date TEXT NOT NULL,
                                code TEXT NOT NULL,
                                name TEXT DEFAULT '',
                                boards INTEGER DEFAULT 1,
                                first_seal INTEGER,
                                last_seal INTEGER,
                                seal_fund REAL DEFAULT 0,
                                broken INTEGER DEFAULT 0,
                                turnover REAL DEFAULT 0,
                                industry TEXT DEFAULT '',
                                concepts TEXT DEFAULT '',
                                UNIQUE(trade_date, code)
                            );",
                            kind: MigrationKind::Up,
                        },
```

- [ ] **Step 2: 创建领域类型 `src/kb/types.ts`**

```ts
// 题材库领域类型：字段与 SQLite 表一一对应（snake_case 行记录，repo 层负责映射）。

export type ThemeLevel = "主线" | "分支" | "一日游";
export type ThemeStage = "萌芽" | "发酵" | "高潮" | "退潮";
export type StockRole = "龙一" | "龙二" | "助攻" | "跟风";
export type CatalystKind =
  | "policy"
  | "industry"
  | "company"
  | "order"
  | "earnings"
  | "price"
  | "event";
export type CatalystDirection = "利好" | "利空" | "中性";
export type CollectorJob = "announcement" | "irm" | "attribution";
export type RunStatus = "running" | "success" | "failed";

export interface CollectorRunRow {
  id: number;
  tradeDate: string;
  job: CollectorJob;
  status: RunStatus;
  rowsAffected: number;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface ThemeRow {
  id: number;
  name: string;
  aliases: string;
  level: ThemeLevel;
  stage: ThemeStage;
  intro: string;
  logic: string;
  logicVersion: number;
  firstSeenDate: string | null;
  lastActiveDate: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ThemeStockRow {
  id: number;
  themeId: number;
  code: string;
  name: string;
  role: StockRole;
  roleScore: number;
  joinedDate: string;
  leftDate: string | null;
}

export interface CatalystRow {
  id: number;
  kind: CatalystKind;
  title: string;
  summary: string;
  source: string;
  sourceUrl: string;
  publishedAt: number | null;
  direction: CatalystDirection;
  themeId: number | null;
  code: string | null;
  freshScore: number;
  contentHash: string;
  collectedAt: number;
}

export interface LimitUpRecordRow {
  id: number;
  tradeDate: string;
  code: string;
  name: string;
  boards: number;
  firstSeal: number;
  lastSeal: number;
  sealFund: number;
  broken: number;
  turnover: number;
  industry: string;
  concepts: string;
}

/** 新建题材时的输入（id/时间戳由 repo 补） */
export interface ThemeDraft {
  name: string;
  aliases?: string;
  level?: ThemeLevel;
  stage?: ThemeStage;
  intro?: string;
  logic?: string;
  firstSeenDate?: string;
  lastActiveDate?: string;
}
```

- [ ] **Step 3: 验证 Rust 编译**

Run: `pnpm tauri build --no-bundle`
Expected: 编译成功（迁移仅为静态字符串；若报错检查逗号/括号是否正确插入在 v31 与 `.build()` 之间）。

- [ ] **Step 4: 验证前端类型**

Run: `pnpm build`
Expected: vue-tsc 通过、vite 构建成功。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src/kb/types.ts
git commit -m "feat(kb): 迁移 v32-v36（题材/成分/催化/涨停定格/采集状态）与领域类型"
```

---

## Task 2: Repo 层（五表读写）

**Files:**

- Create: `src/kb/repo.ts`
- Test: `tests/unit/kb/repo.test.ts`

**Interfaces:**

- Consumes: `src/kb/types.ts` 的全部行类型与 `ThemeDraft`；db 句柄遵循 tauri-plugin-sql 接口（`select<T>(sql, bind?): Promise<T>`、`execute(sql, bind?): Promise<{lastInsertId?, rowsAffected}`）。
- Produces（后续任务依赖的精确签名）：

```ts
startRun(d: Db, tradeDate: string, job: CollectorJob): Promise<number>
finishRun(d: Db, id: number, status: "success"|"failed", rowsAffected: number, error?: string): Promise<void>
getRun(d: Db, tradeDate: string, job: CollectorJob): Promise<CollectorRunRow | null>
upsertTheme(d: Db, draft: ThemeDraft, now?: number): Promise<number>
setThemeStage(d: Db, id: number, stage: ThemeStage, now?: number): Promise<void>
getThemeByName(d: Db, name: string): Promise<ThemeRow | null>
listThemes(d: Db, opts?: { activeOn?: string }): Promise<ThemeRow[]>
upsertThemeStock(d: Db, themeId: number, r: { code: string; name: string; role: StockRole; roleScore: number; joinedDate: string }): Promise<void>
listThemeStocks(d: Db, themeId: number): Promise<ThemeStockRow[]>
insertCatalystIgnore(d: Db, c: { hash: string } & Omit<CatalystRow, "id">): Promise<boolean>
linkCatalyst(d: Db, id: number, themeId: number | null, code: string | null): Promise<void>
listCatalysts(d: Db, filter?: { code?: string; themeId?: number; limit?: number }): Promise<CatalystRow[]>
upsertLimitUpRecord(d: Db, r: Omit<LimitUpRecordRow, "id">): Promise<void>
listLimitUpByDate(d: Db, tradeDate: string): Promise<LimitUpRecordRow[]>
countLimitUpSince(d: Db, code: string, sinceDate: string): Promise<number>
```

- [ ] **Step 1: 写失败测试 `tests/unit/kb/repo.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock = vi.hoisted(() => ({ select: vi.fn(), execute: vi.fn() }));
vi.mock("../../../src/db/database", () => ({
  db: () => dbMock,
  ensureDb: vi.fn(async () => dbMock),
}));

import * as repo from "../../../src/kb/repo";
import type { Db } from "../../../src/kb/repo";

const d = dbMock as unknown as Db;

// tauri-plugin-sql 行记录是 snake_case；repo 映射为 camelCase
const themeDbRow = {
  id: 1, name: "机器人", aliases: "", level: "主线", stage: "发酵",
  intro: "", logic: "降本增效", logic_version: 1,
  first_seen_date: "2026-09-30", last_active_date: "2026-09-30",
  created_at: 1, updated_at: 2,
};

beforeEach(() => {
  vi.resetAllMocks();
  dbMock.execute.mockResolvedValue({ lastInsertId: 7, rowsAffected: 1 });
});

describe("run status", () => {
  it("startRun upserts a running row and returns its id", async () => {
    const id = await repo.startRun(d, "2026-09-30", "attribution");
    expect(id).toBe(7);
    const [sql, bind] = dbMock.execute.mock.calls[0];
    expect(sql).toContain("INSERT INTO collector_run");
    expect(bind.slice(0, 3)).toEqual(["2026-09-30", "attribution", "running"]);
  });

  it("finishRun writes status/error/finished timestamp", async () => {
    await repo.finishRun(d, 3, "failed", 0, "boom");
    const [sql, bind] = dbMock.execute.mock.calls[0];
    expect(sql).toContain("UPDATE collector_run");
    expect(bind).toEqual(["failed", 0, expect.any(Number), "boom", 3]);
  });

  it("getRun maps snake_case rows to the domain type", async () => {
    dbMock.select.mockResolvedValueOnce([
      {
        id: 1, trade_date: "2026-09-30", job: "irm", status: "success",
        rows_affected: 4, error: null, started_at: 1, finished_at: 2,
      },
    ]);
    const r = await repo.getRun(d, "2026-09-30", "irm");
    expect(r).toMatchObject({ tradeDate: "2026-09-30", rowsAffected: 4 });
  });

  it("getRun returns null when no row exists", async () => {
    dbMock.select.mockResolvedValueOnce([]);
    expect(await repo.getRun(d, "2026-09-30", "irm")).toBeNull();
  });
});

describe("themes", () => {
  it("upsertTheme inserts with defaults and returns id", async () => {
    const id = await repo.upsertTheme(d, { name: "机器人", firstSeenDate: "2026-09-30" }, 100);
    expect(id).toBe(7);
    const bind = dbMock.execute.mock.calls[0][1];
    expect(bind[0]).toBe("机器人");
    expect(bind).toContain("分支"); // level 默认
  });

  it("getThemeByName maps rows", async () => {
    dbMock.select.mockResolvedValueOnce([themeDbRow]);
    const t = await repo.getThemeByName(d, "机器人");
    expect(t).toMatchObject({ name: "机器人", logicVersion: 1, firstSeenDate: "2026-09-30" });
  });

  it("setThemeStage updates stage and updated_at", async () => {
    await repo.setThemeStage(d, 2, "退潮", 99);
    const bind = dbMock.execute.mock.calls[0][1];
    expect(bind).toEqual(["退潮", 99, 2]);
  });
});

describe("catalyst / limit-up", () => {
  it("insertCatalystIgnore returns true for a fresh hash", async () => {
    expect(await repo.insertCatalystIgnore(d, {
      kind: "policy", title: "t", summary: "", source: "cninfo", sourceUrl: "",
      publishedAt: 1, direction: "利好", themeId: null, code: null,
      freshScore: 1, contentHash: "h1", collectedAt: 1,
    })).toBe(true);
  });

  it("upsertLimitUpRecord uses ON CONFLICT replace", async () => {
    await repo.upsertLimitUpRecord(d, {
      tradeDate: "2026-09-30", code: "300xxx", name: "X", boards: 2,
      firstSeal: 93505, lastSeal: 93505, sealFund: 1e8, broken: 0,
      turnover: 8, industry: "设备", concepts: "机器人",
    });
    expect(dbMock.execute.mock.calls[0][0]).toContain("ON CONFLICT");
  });

  it("countLimitUpSince returns the counted value", async () => {
    dbMock.select.mockResolvedValueOnce([{ c: 5 }]);
    expect(await repo.countLimitUpSince(d, "300xxx", "2026-06-01")).toBe(5);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/unit/kb/repo.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/kb/repo.ts`**

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/unit/kb/repo.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: Commit**

```bash
git add src/kb/repo.ts tests/unit/kb/repo.test.ts
git commit -m "feat(kb): repo 层五表读写与 snake_case 行映射"
```

---

## Task 3: 哈希 + 新鲜度衰减纯函数

**Files:**

- Create: `src/kb/hash.ts`, `src/kb/freshness.ts`
- Test: `tests/unit/kb/hash.test.ts`, `tests/unit/kb/freshness.test.ts`

**Interfaces:**

- Produces:
  - `fnv1a(input: string): string`（输出 8 位十六进制，content_hash 用；确定性、零依赖）
  - `halfLifeDays(kind: CatalystKind): number`
  - `freshness(kind: CatalystKind, ageDays: number): number`（区间 0–1）

- [ ] **Step 1: 写失败测试**

`tests/unit/kb/hash.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fnv1a } from "../../../src/kb/hash";

describe("fnv1a", () => {
  it("is deterministic", () => {
    expect(fnv1a("abc")).toBe(fnv1a("abc"));
  });
  it("returns an 8-char hex string", () => {
    expect(fnv1a("abc")).toMatch(/^[0-9a-f]{8}$/);
  });
  it("has a known fixed vector", () => {
    expect(fnv1a("a")).toBe("e40c292c");
  });
  it("differs for different input", () => {
    expect(fnv1a("ab")).not.toBe(fnv1a("ac"));
  });
  it("handles empty input", () => {
    expect(fnv1a("")).toBe("811c9dc5");
  });
});
```

`tests/unit/kb/freshness.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { freshness, halfLifeDays } from "../../../src/kb/freshness";

describe("freshness", () => {
  it("exposes the half-life table", () => {
    expect(halfLifeDays("policy")).toBe(7);
    expect(halfLifeDays("event")).toBe(1);
  });
  it("is 1 at age 0 and 0.5 at one half-life", () => {
    expect(freshness("policy", 0)).toBe(1);
    expect(freshness("policy", 7)).toBeCloseTo(0.5, 10);
  });
  it("decays faster for short half-life kinds", () => {
    expect(freshness("event", 1)).toBeCloseTo(0.5, 10);
    expect(freshness("event", 3)).toBeLessThan(0.13);
  });
  it("clamps negative ages to 1", () => {
    expect(freshness("policy", -2)).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/unit/kb/hash.test.ts tests/unit/kb/freshness.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/kb/hash.ts`:

```ts
// FNV-1a 32 位：稳定、零依赖，用于 catalyst.content_hash 去重。
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h * 16777619，用无符号右移保证 32 位
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
```

`src/kb/freshness.ts`:

```ts
import type { CatalystKind } from "./types";

// 半衰期（天）：政策影响最久，盘中事件最短。
const HALF_LIFE: Record<CatalystKind, number> = {
  policy: 7,
  industry: 5,
  company: 3,
  order: 3,
  earnings: 3,
  price: 1,
  event: 1,
};

export function halfLifeDays(kind: CatalystKind): number {
  return HALF_LIFE[kind] ?? 3;
}

/** 新鲜度：age 0 → 1；每过一个半衰期减半；负年龄（时钟偏差）视为 1。 */
export function freshness(kind: CatalystKind, ageDays: number): number {
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays(kind));
}
```

- [ ] **Step 4: 验证已知向量**

Run: `pnpm test tests/unit/kb/hash.test.ts tests/unit/kb/freshness.test.ts`
Expected: PASS。固定向量已用 Node 核验：`fnv1a("")=811c9dc5`、`fnv1a("a")=e40c292c`。

- [ ] **Step 5: Commit**

```bash
git add src/kb/hash.ts src/kb/freshness.ts tests/unit/kb/hash.test.ts tests/unit/kb/freshness.test.ts
git commit -m "feat(kb): FNV-1a 哈希与催化剂新鲜度衰减"
```

---

## Task 4: 题材聚类纯函数（三路交叉）

**Files:**

- Create: `src/kb/cluster.ts`
- Test: `tests/unit/kb/cluster.test.ts`

**Interfaces:**

- Consumes: 当日涨停股简表与「概念 → 成分股代码」映射（Task 8 的 Rust 命令产出此映射）。
- Produces:

```ts
interface SealStock { code: string; name: string; boards: number; industry: string }
interface ConceptMembership { concept: string; codes: string[] }
interface ThemeCluster { name: string; path: "concept" | "industry"; codes: string[];
                        sealCount: number; totalBoards: number; leaderBoards: number; score: number }
function clusterThemes(stocks: SealStock[], concepts: ConceptMembership[]): ThemeCluster[]
```

- [ ] **Step 1: 写失败测试 `tests/unit/kb/cluster.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { clusterThemes } from "../../../src/kb/cluster";
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

  it("returns clusters sorted by score desc", () => {
    const out = clusterThemes(stocks, concepts);
    for (let i = 1; i < out.length; i++) expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/unit/kb/cluster.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/kb/cluster.ts`**

```ts
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

interface Agg {
  codes: Set<string>;
  totalBoards: number;
  leaderBoards: number;
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
  const claimedByConcept = new Set<string>();
  const conceptNames = new Set(concepts.map((c) => c.concept));

  // ① 概念路径：成分股中当日涨停 ≥ 2
  for (const c of concepts) {
    const members: SealStock[] = [];
    for (const code of c.codes) {
      if (sealedCodes.has(code)) {
        const stk = byCode.get(code)!;
        members.push(stk);
        claimedByConcept.add(`${code}@${stk.industry}`);
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
```

注意：`claimedByConcept` 在当前规则中只用于概念归集；保留它是为了让「行业同名去重」语义显式（去重实际由 `conceptNames.has(industry)` 完成）。如 lint 报未使用变量，删除该变量及其赋值行即可。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/unit/kb/cluster.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/kb/cluster.ts tests/unit/kb/cluster.test.ts
git commit -m "feat(kb): 概念/行业两路聚类纯函数（同名去重、按强度排序）"
```

---

## Task 5: 题材内角色评分（龙一/龙二/助攻/跟风）

**Files:**

- Create: `src/kb/roles.ts`
- Test: `tests/unit/kb/roles.test.ts`

**Interfaces:**

- Produces:

```ts
interface RoleInput { code: string; name: string; boards: number; firstSeal: number; sealFund: number }
interface RoleOutput extends RoleInput { roleScore: number; role: StockRole; uniqueLeader: boolean }
function sealMinutes(firstSeal: number): number   // HHMMSS → 当日分钟数（9:30 → 570）
function roleScore(s: RoleInput): number
function assignRoles(stocks: RoleInput[]): RoleOutput[]
```

- [ ] **Step 1: 写失败测试 `tests/unit/kb/roles.test.ts`**

```ts
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

  it("flags a unique leader when its boards exceed the runner-up by >=2", () => {
    const out = assignRoles(stocks);
    expect(out[0].uniqueLeader).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/unit/kb/roles.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/kb/roles.ts`**

```ts
import type { StockRole } from "./types";

export interface RoleInput {
  code: string;
  name: string;
  boards: number;
  firstSeal: number; // HHMMSS，如 93505
  sealFund: number;  // 封单金额（元）
}

export interface RoleOutput extends RoleInput {
  roleScore: number;
  role: StockRole;
  uniqueLeader: boolean;
}

/** HHMMSS → 当日分钟数；0 / 异常输入返回尾盘值 690（11:30），避免误得高分。 */
export function sealMinutes(firstSeal: number): number {
  if (firstSeal <= 0) return 690;
  const h = Math.floor(firstSeal / 10000);
  const m = Math.floor(firstSeal / 100) % 100;
  if (h < 9 || h > 15) return 690;
  return h * 60 + m;
}

/**
 * 确定性评分：
 *   板高主导（×1000）＋封单强度（每亿元 50 分，封顶 200）＋时间奖励（11:00 前越早越多）。
 */
export function roleScore(s: RoleInput): number {
  const boardPart = s.boards * 1000;
  const fundPart = Math.min((s.sealFund / 1e8) * 50, 200);
  const minutes = sealMinutes(s.firstSeal);
  const timePart = Math.max(0, (660 - minutes) * 3); // 660 = 11:00
  return boardPart + fundPart + timePart;
}

export function assignRoles(stocks: RoleInput[]): RoleOutput[] {
  const ranked = stocks
    .map((s) => ({ ...s, roleScore: roleScore(s) }))
    .sort((a, b) => b.roleScore - a.roleScore);

  const uniqueLeader = ranked.length >= 2 && ranked[0].boards - ranked[1].boards >= 2;

  return ranked.map((r, i): RoleOutput => {
    let role: StockRole;
    if (i === 0) role = "龙一";
    else if (i === 1) role = "龙二";
    else if (i <= 3) role = "助攻";
    else role = "跟风";
    return { ...r, role, uniqueLeader: i === 0 ? uniqueLeader : false };
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/unit/kb/roles.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/kb/roles.ts tests/unit/kb/roles.test.ts
git commit -m "feat(kb): 题材内角色评分（龙一唯一性/封单强度/封板时间）"
```

---

## Task 6: Rust 巨潮公告抓取

**Files:**

- Create: `src-tauri/src/market/announce.rs`
- Modify: `src-tauri/src/market/mod.rs`（注册模块）
- Modify: `src-tauri/src/lib.rs`（新增 command `get_announcements` 并注册）

**Interfaces:**

- Produces:

```rust
pub struct AnnounceItem { pub id: String, pub code: String, pub name: String,
                         pub title: String, pub time: i64, pub url: String, pub category: String }
pub async fn announcements(date: String, page_size: u32) -> Result<Vec<AnnounceItem>, String>
// Tauri command: get_announcements(date: String) -> Vec<AnnounceItem>
```

- [ ] **Step 1: 实现 `src-tauri/src/market/announce.rs`（含 fixture 测试）**

```rust
// 巨潮资讯公告查询：www.cninfo.com.cn/new/hisAnnouncement/query（公开 POST 表单，JSON 响应）。
// 只保留标题/时间/原文链接，不下载 PDF。
use crate::market::http;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnnounceItem {
    pub id: String,
    pub code: String,
    pub name: String,
    pub title: String,
    pub time: i64, // 毫秒
    pub url: String,
    pub category: String,
}

#[derive(Deserialize, Default, Debug)]
struct RawAnnouncement {
    #[serde(rename = "announcementId")] announcement_id: Option<String>,
    #[serde(rename = "secCode")] sec_code: Option<String>,
    #[serde(rename = "secName")] sec_name: Option<String>,
    #[serde(rename = "announcementTitle")] title: Option<String>,
    #[serde(rename = "announcementTime")] announcement_time: Option<i64>,
    #[serde(rename = "adjunctUrl")] adjunct_url: Option<String>,
    #[serde(rename = "announcementTypeName")] category: Option<String>,
}

#[derive(Deserialize, Default, Debug)]
struct AnnounceResp {
    announcements: Option<Vec<RawAnnouncement>>,
}

fn parse_announcements(json_str: &str) -> Vec<AnnounceItem> {
    let j: AnnounceResp = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    j.announcements
        .unwrap_or_default()
        .iter()
        .filter_map(|r| {
            let id = r.announcement_id.clone()?;
            let url = format!(
                "https://static.cninfo.com.cn/{}",
                r.adjunct_url.clone().unwrap_or_default()
            );
            Some(AnnounceItem {
                id,
                code: r.sec_code.clone().unwrap_or_default(),
                name: r.sec_name.clone().unwrap_or_default(),
                title: r.title.clone().unwrap_or_default(),
                time: r.announcement_time.unwrap_or(0),
                url,
                category: r.category.clone().unwrap_or_default(),
            })
        })
        .collect()
}

pub async fn announcements(date: String, page_size: u32) -> Result<Vec<AnnounceItem>, String> {
    // date 形如 2026-09-30；接口 seDate 支持单日区间 a~a
    let se_date = format!("{}~{}", date, date);
    let body = format!(
        "pageNum=1&pageSize={}&column=szse&tabName=fulltext&plate=&stock=&searchkey=&secid=&category=&trade=&seDate={}&sortName=&sortType=&isHLtitle=true",
        page_size, se_date
    );
    let resp = tokio::time::timeout(
        Duration::from_secs(20),
        http()
            .post("https://www.cninfo.com.cn/new/hisAnnouncement/query")
            .header("Accept", "application/json, text/javascript, */*; q=0.01")
            .header("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
            .header("Origin", "https://www.cninfo.com.cn")
            .header("Referer", "https://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search")
            .header("X-Requested-With", "XMLHttpRequest")
            .body(body)
            .send(),
    )
    .await
    .map_err(|_| "请求超时".to_string())?
    .map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(parse_announcements(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{
      "announcements": [{
        "announcementId": "123", "secCode": "300001", "secName": "示例公司",
        "announcementTitle": "关于签订重大合同的公告", "announcementTime": 1780000000000,
        "adjunctUrl": "finalpage/2026-09-30/123.PDF", "announcementTypeName": "重大合同"
      }, {
        "announcementId": "124", "secCode": null, "secName": null,
        "announcementTitle": null, "announcementTime": null,
        "adjunctUrl": null, "announcementTypeName": null
      }]
    }"#;

    #[test]
    fn parses_valid_rows_and_skips_incomplete() {
        let out = parse_announcements(FIXTURE);
        assert_eq!(out.len(), 1, "缺 id 的行应跳过");
        assert_eq!(out[0].code, "300001");
        assert_eq!(out[0].title, "关于签订重大合同的公告");
        assert!(out[0].url.starts_with("https://static.cninfo.com.cn/finalpage/"));
        assert_eq!(out[0].category, "重大合同");
    }

    #[test]
    fn returns_empty_for_bad_json() {
        assert!(parse_announcements("not json").is_empty());
        assert!(parse_announcements("{}").is_empty());
    }
}
```

- [ ] **Step 2: 注册模块（`src-tauri/src/market/mod.rs` 顶部模块声明区加一行）**

在 `mod.rs` 的 `pub mod ... / mod ...` 声明区域（与 `pub mod cninfo;` 同处）添加：

```rust
pub mod announce;
```

- [ ] **Step 3: 新增 Tauri command（`src-tauri/src/lib.rs`）**

在其他 `#[tauri::command]` 函数附近（如 `get_zt_pool` 附近）添加：

```rust
#[tauri::command]
async fn get_announcements(date: String) -> Result<Vec<market::announce::AnnounceItem>, String> {
    market::announce::announcements(date, 50).await
}
```

并在 `invoke_handler` 的列表中加入 `get_announcements,`（与其他命令同列）。

- [ ] **Step 4: 运行 Rust 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml announce`
Expected: 2 个测试 PASS（若 Tauri build script 拦截 cargo test，则运行 `pnpm tauri build --no-bundle` 确认编译，并将 Rust 单测结果在可执行 `cargo test` 的环境补跑；本任务以编译通过 + 解析测试通过为准）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/market/announce.rs src-tauri/src/market/mod.rs src-tauri/src/lib.rs
git commit -m "feat(collect): 巨潮公告查询 command 与 fixture 解析测试"
```

---

## Task 7: Rust 互动易 / 上证 e 互动（独立降级）

**Files:**

- Create: `src-tauri/src/market/irminteract.rs`
- Modify: `src-tauri/src/market/mod.rs`
- Modify: `src-tauri/src/lib.rs`（command `get_irm_latest` + 注册）

**Interfaces:**

- Produces:

```rust
pub struct IrmItem { pub platform: String, pub code: String, pub name: String,
                    pub question: String, pub answer: String, pub time: i64, pub url: String }
pub async fn irm_latest() -> Vec<IrmItem>   // 两源独立 try；永不返回 Err
// Tauri command: get_irm_latest() -> Vec<IrmItem>
```

- [ ] **Step 1: 实现 `src-tauri/src/market/irminteract.rs`（含 fixture 测试）**

```rust
// 互动易（深市 irm.cninfo.com.cn）与上证 e 互动（sns.sseinfo.com）增量。
// 两源均无稳定 SLA，故各自独立失败、整体降级为空/部分结果，绝不阻断盘后作业。
use crate::market::http;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct IrmItem {
    pub platform: String, // "sse" | "irm"
    pub code: String,
    pub name: String,
    pub question: String,
    pub answer: String,
    pub time: i64,
    pub url: String,
}

// ===== 上证 e 互动：feeds.do AJAX（JSON）=====
fn parse_sse(json_str: &str) -> Vec<IrmItem> {
    let v: Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let feeds = v.pointer("/data/feeds").and_then(|x| x.as_array());
    let mut out = Vec::new();
    if let Some(feeds) = feeds {
        for f in feeds {
            let code = f.pointer("/question/stockCode").and_then(|x| x.as_str()).unwrap_or("");
            if code.is_empty() {
                continue;
            }
            let id = f.get("id").and_then(|x| x.as_i64()).unwrap_or(0);
            out.push(IrmItem {
                platform: "sse".to_string(),
                code: code.to_string(),
                name: f.pointer("/question/stockName").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                question: f.pointer("/question/content").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                answer: f.get("replyContent").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                time: f.get("pubDate").and_then(|x| x.as_i64()).unwrap_or(0),
                url: format!("https://sns.sseinfo.com/detail-{}", id),
            });
        }
    }
    out
}

async fn fetch_sse() -> Vec<IrmItem> {
    let url = "https://sns.sseinfo.com/ajax/feeds.do?type=10&pageSize=20&lastid=-1&show=1&page=1";
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        http().get(url).header("Referer", "https://sns.sseinfo.com/").send(),
    )
    .await;
    match result {
        Ok(Ok(resp)) => match resp.text().await {
            Ok(text) => parse_sse(&text),
            Err(_) => Vec::new(),
        },
        _ => Vec::new(),
    }
}

// ===== 互动易（深市）：JSON 列表，字段宽容提取 =====
fn parse_irm(json_str: &str) -> Vec<IrmItem> {
    let v: Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    // 兼容两种包裹：{"data":{"rows":[...]}} 或 {"rows":[...]}
    let rows = v
        .pointer("/data/rows")
        .or_else(|| v.pointer("/rows"))
        .or_else(|| v.pointer("/data/list"))
        .and_then(|x| x.as_array());
    let mut out = Vec::new();
    if let Some(rows) = rows {
        for r in rows {
            let pick = |keys: &[&str]| -> String {
                for k in keys {
                    if let Some(s) = r.get(*k).and_then(|x| x.as_str()) {
                        return s.to_string();
                    }
                }
                String::new()
            };
            let code = pick(&["stockCode", "secCode", "code"]);
            if code.is_empty() {
                continue;
            }
            let id = pick(&["questionId", "id"]);
            out.push(IrmItem {
                platform: "irm".to_string(),
                code,
                name: pick(&["stockName", "secName", "shortName"]),
                question: pick(&["questionContent", "content", "question"]),
                answer: pick(&["replyContent", "answer", "reply"]),
                time: r
                    .get("pubTime")
                    .or_else(|| r.get("time"))
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0),
                url: format!("https://irm.cninfo.com.cn/detail/{}", id),
            });
        }
    }
    out
}

async fn fetch_irm() -> Vec<IrmItem> {
    let url = "https://irm.cninfo.com.cn/newircs/index/questionList?pageNo=1&pageSize=20";
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        http()
            .get(url)
            .header("Referer", "https://irm.cninfo.com.cn/")
            .header("X-Requested-With", "XMLHttpRequest")
            .send(),
    )
    .await;
    match result {
        Ok(Ok(resp)) => match resp.text().await {
            Ok(text) => parse_irm(&text),
            Err(_) => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// 合并两源：并发拉取；任一失败只丢自己的部分。
pub async fn irm_latest() -> Vec<IrmItem> {
    let (a, b) = tokio::join!(fetch_sse(), fetch_irm());
    let mut all = a;
    all.extend(b);
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sse_feeds() {
        let j = r#"{"data":{"feeds":[
          {"id":9, "pubDate": 1780000000000,
           "question":{"stockCode":"600001","stockName":"示例","content":"订单情况？"},
           "replyContent":"正常推进"}
        ]}}"#;
        let out = parse_sse(j);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].platform, "sse");
        assert_eq!(out[0].code, "600001");
        assert_eq!(out[0].answer, "正常推进");
        assert!(out[0].url.contains("detail-9"));
    }

    #[test]
    fn parses_irm_rows_and_skips_without_code() {
        let j = r#"{"data":{"rows":[
          {"questionId":"55","stockCode":"300001","stockName":"深示例",
           "questionContent":"产能？","replyContent":"扩产中","pubTime":1780000000000},
          {"questionId":"56"}
        ]}}"#;
        let out = parse_irm(j);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].platform, "irm");
        assert_eq!(out[0].code, "300001");
    }

    #[test]
    fn bad_input_yields_empty() {
        assert!(parse_sse("x").is_empty());
        assert!(parse_irm("x").is_empty());
    }
}
```

> 网络联调要求（手动步骤，非自动化）：真实端点/字段若变更，在不改函数签名的前提下更新 URL 或 `pointer/pick` 字段路径，并同步更新 fixture。这是该数据源唯一允许的维护方式。

- [ ] **Step 2: 注册模块与 command**

`src-tauri/src/market/mod.rs` 模块声明区添加：

```rust
pub mod irminteract;
```

`src-tauri/src/lib.rs` 添加 command：

```rust
#[tauri::command]
async fn get_irm_latest() -> Vec<market::irminteract::IrmItem> {
    market::irminteract::irm_latest().await
}
```

并在 `invoke_handler` 列表加入 `get_irm_latest,`。

- [ ] **Step 3: 编译并运行 Rust 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml irminteract`（受 build script 限制时以 `pnpm tauri build --no-bundle` 编译通过为准）。
Expected: 3 个测试 PASS。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/market/irminteract.rs src-tauri/src/market/mod.rs src-tauri/src/lib.rs
git commit -m "feat(collect): 互动易/上证e互动增量抓取（独立失败、空表降级）"
```

---

## Task 8: API 封装 + 催化剂入库管线

**Files:**

- Create: `src/api/kb.ts`
- Create: `src/kb/catalystPipe.ts`
- Test: `tests/unit/kb/catalystPipe.test.ts`

**Interfaces:**

- Consumes: Rust commands `get_announcements / get_irm_latest`；`AnnounceItem / IrmItem`（camelCase）。
- Produces:

```ts
// src/api/kb.ts
fetchAnnouncements(date: string): Promise<AnnounceItem>
fetchIrmLatest(): Promise<IrmItem>
// src/kb/catalystPipe.ts
interface CatalystDraft { kind: CatalystKind; title: string; summary: string; source: string;
                         sourceUrl: string; publishedAt: number; direction: CatalystDirection;
                         code: string | null }
function announceToDraft(a: AnnounceItem): CatalystDraft
function irmToDraft(i: IrmItem): CatalystDraft
function classifyAnnounce(title: string): { kind: CatalystKind; direction: CatalystDirection }
function matchTheme(title: string, code: string, themes: ThemeRow[]): { themeId: number | null }
async function ingestCatalysts(d: Db, drafts: CatalystDraft[], now?: number): Promise<{ inserted: number; linked: number }>
```

- [ ] **Step 1: 创建 API 封装 `src/api/kb.ts`**

```ts
// 采集类 command 封装（与行情 API 风格一致）。
import { invoke } from "@tauri-apps/api/core";

export interface AnnounceItem {
  id: string;
  code: string;
  name: string;
  title: string;
  time: number;
  url: string;
  category: string;
}

export interface IrmItem {
  platform: string;
  code: string;
  name: string;
  question: string;
  answer: string;
  time: number;
  url: string;
}

/** 指定交易日（YYYY-MM-DD）的公告；失败抛出由调度器捕获并降级。 */
export async function fetchAnnouncements(date: string): Promise<AnnounceItem[]> {
  return await invoke<AnnounceItem[]>("get_announcements", { date });
}

export async function fetchIrmLatest(): Promise<IrmItem[]> {
  return await invoke<IrmItem[]>("get_irm_latest");
}
```

- [ ] **Step 2: 写失败测试 `tests/unit/kb/catalystPipe.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock = vi.hoisted(() => ({ select: vi.fn(), execute: vi.fn() }));
vi.mock("../../../src/db/database", () => ({
  db: () => dbMock,
  ensureDb: vi.fn(async () => dbMock),
}));

import {
  announceToDraft,
  classifyAnnounce,
  irmToDraft,
  ingestCatalysts,
} from "../../../src/kb/catalystPipe";
import type { Db } from "../../../src/kb/repo";
import type { AnnounceItem, IrmItem } from "../../../src/api/kb";

const d = dbMock as unknown as Db;

beforeEach(() => {
  vi.resetAllMocks();
  dbMock.execute.mockResolvedValue({ rowsAffected: 1 });
});

describe("classifyAnnounce", () => {
  it("maps keywords to kind and direction", () => {
    expect(classifyAnnounce("关于签订重大合同的公告")).toMatchObject({ kind: "order", direction: "利好" });
    expect(classifyAnnounce("2026年第三季度业绩预告大增")).toMatchObject({ kind: "earnings", direction: "利好" });
    expect(classifyAnnounce("关于持股5%以上股东减持计划")).toMatchObject({ kind: "company", direction: "利空" });
    expect(classifyAnnounce("召开2026年第二次临时股东会")).toMatchObject({ kind: "company", direction: "中性" });
  });
});

describe("mappers", () => {
  it("converts announcement to draft", () => {
    const a: AnnounceItem = { id: "1", code: "300001", name: "X", title: "签订重大合同", time: 178e11, url: "u", category: "合同" };
    const draft = announceToDraft(a);
    expect(draft).toMatchObject({ kind: "order", code: "300001", source: "cninfo", sourceUrl: "u" });
  });

  it("converts irm item to a company-event draft", () => {
    const i: IrmItem = { platform: "sse", code: "600001", name: "X", question: "订单？", answer: "有", time: 1, url: "u2" };
    const draft = irmToDraft(i);
    expect(draft).toMatchObject({ kind: "company", code: "600001", source: "sse", summary: "Q:订单？ A:有" });
  });
});

describe("ingestCatalysts", () => {
  it("inserts unique drafts and reports counts", async () => {
    const drafts = [
      { kind: "order" as const, title: "t1", summary: "", source: "cninfo", sourceUrl: "u1", publishedAt: 1, direction: "利好" as const, code: "300001" },
      { kind: "event" as const, title: "t2", summary: "", source: "sse", sourceUrl: "u2", publishedAt: 1, direction: "中性" as const, code: "600001" },
    ];
    const r = await ingestCatalysts(d, drafts, 100);
    expect(r.inserted).toBe(2);
    // 每次插入一条
    expect(dbMock.execute).toHaveBeenCalledTimes(2);
  });

  it("skips duplicates (hash conflict → rowsAffected 0)", async () => {
    dbMock.execute.mockResolvedValueOnce({ rowsAffected: 0 });
    const draft = { kind: "event" as const, title: "t", summary: "", source: "x", sourceUrl: "u", publishedAt: 1, direction: "中性" as const, code: null };
    expect((await ingestCatalysts(d, [draft], 100)).inserted).toBe(0);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm test tests/unit/kb/catalystPipe.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 实现 `src/kb/catalystPipe.ts`**

```ts
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
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm test tests/unit/kb/catalystPipe.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/api/kb.ts src/kb/catalystPipe.ts tests/unit/kb/catalystPipe.test.ts
git commit -m "feat(kb): 公告/互动易催化草稿映射、分类与去重入库管线"
```

---

## Task 9: 板块成分 Rust 命令 + 盘后归因作业

**Files:**

- Modify: `src-tauri/src/market/eastmoney.rs`（新增 `sector_stocks`）
- Modify: `src-tauri/src/lib.rs`（command `get_sector_stocks` + 注册）
- Create: `src/kb/dailyJob.ts`
- Test: `tests/unit/kb/dailyJob.test.ts`

**Interfaces:**

- Consumes: `fetchZtPool(dateCompact)`（`src/api/market.ts`，返回 `ZtPool.list: ZtStock[]`，字段含 `code/name/boards/firstSeal/fund/broken/turnover/industry`）；`fetchSectors("concept")`（返回 `Sector[]`，含 `code/name`）；新命令 `fetchSectorStocks(boardCode)`；repo、cluster、roles、catalystPipe。
- Produces:

```ts
// Rust: sector_stocks(board_code: &str) -> Result<Vec<String>, String>
// api/kb.ts 增加：fetchSectorStocks(boardCode: string): Promise<string[]>
// dailyJob.ts
todayCompact(d: Date): string                 // YYYYMMDD
decideStage(sealCount: number, leaderBoards: number, isNew: boolean): ThemeStage
async function runAttributionJob(d: Db, tradeDateIso: string, tradeDateCompact: string): Promise<DailyResult>
interface DailyResult { tradeDate: string; themes: number; stocks: number; limitUp: number }
```

- [ ] **Step 1: Rust 新增板块成分函数（`eastmoney.rs`，追加在文件末尾区域）**

在 `eastmoney.rs` 中添加（复用其现有 `http()` 与 clist 多节点能力；若该文件已有 clist 通用函数，优先调用之）：

```rust
/// 概念板块成分股代码（clist，fs=b:BKxxxx；多节点串行故障转移）。
pub async fn sector_stocks(board_code: &str) -> Result<Vec<String>, String> {
    let nodes = ["82", "88", "29"];
    let ut = "bd1d9ddb04089700cf9c27f6f7426281";
    for node in nodes {
        let url = format!(
            "https://{}.push2.eastmoney.com/api/qt/clist/get?ut={}&pn=1&pz=500&po=1&np=1&fltt=2&invt=2&fs=b:{}&fields=f12&_={}",
            node, ut, board_code, now_millis()
        );
        let got = tokio::time::timeout(
            Duration::from_secs(15),
            http().get(&url).header("Referer", "https://quote.eastmoney.com/").send(),
        )
        .await;
        if let Ok(Ok(resp)) = got {
            if let Ok(text) = resp.text().await {
                if let Some(codes) = parse_clist_codes(&text) {
                    return Ok(codes);
                }
            }
        }
    }
    Err("板块成分拉取失败".to_string())
}

fn parse_clist_codes(text: &str) -> Option<Vec<String>> {
    let v: Value = serde_json::from_str(text).ok()?;
    let diff = v.pointer("/data/diff")?.as_array()?;
    let codes: Vec<String> = diff
        .iter()
        .filter_map(|row| row.get("f12").and_then(|x| x.as_str()).map(|s| s.to_string()))
        .collect();
    Some(codes)
}
```

确认 `eastmoney.rs` 顶部已导入 `Duration`（若没有，加 `use std::time::Duration;`）。

`lib.rs` 添加 command 并注册：

```rust
#[tauri::command]
async fn get_sector_stocks(board_code: String) -> Result<Vec<String>, String> {
    market::eastmoney::sector_stocks(&board_code).await
}
```

在 invoke_handler 列表加入 `get_sector_stocks,`。

- [ ] **Step 2: 在 `src/api/kb.ts` 末尾追加成分封装**

```ts
/** 概念板块（BKxxxx）成分股代码；单板块失败抛出由作业降级跳过。 */
export async function fetchSectorStocks(boardCode: string): Promise<string[]> {
  return await invoke<string[]>("get_sector_stocks", { boardCode });
}
```

- [ ] **Step 3: 写失败测试 `tests/unit/kb/dailyJob.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { select: vi.fn(), execute: vi.fn() },
  ztPool: vi.fn(),
  sectors: vi.fn(),
  sectorStocks: vi.fn(),
}));
vi.mock("../../../src/db/database", () => ({
  db: () => mocks.db,
  ensureDb: vi.fn(async () => mocks.db),
}));
vi.mock("../../../src/api/market", () => ({
  fetchZtPool: (d: string) => mocks.ztPool(d),
  fetchSectors: (k: string) => mocks.sectors(k),
}));
vi.mock("../../../src/api/kb", () => ({
  fetchSectorStocks: (b: string) => mocks.sectorStocks(b),
}));

import { decideStage, runAttributionJob, todayCompact } from "../../../src/kb/dailyJob";
import type { Db } from "../../../src/kb/repo";

const d = mocks.db as unknown as Db;

function ztStock(over: Record<string, unknown>) {
  return {
    code: "300001", name: "一", price: 10, pct: 20, amount: 1e8, fund: 1e8,
    boards: 1, firstSeal: 93500, lastSeal: 93500, broken: 0, turnover: 8,
    industry: "设备", statDays: 1, statCount: 1, limitPrice: 10, ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.execute.mockResolvedValue({ lastInsertId: 1, rowsAffected: 1 });
});

describe("date / stage helpers", () => {
  it("todayCompact formats YYYYMMDD", () => {
    expect(todayCompact(new Date(2026, 8, 30))).toBe("20260930");
  });
  it("decideStage follows the deterministic ladder", () => {
    expect(decideStage(2, 1, true)).toBe("萌芽");
    expect(decideStage(5, 2, false)).toBe("发酵");
    expect(decideStage(9, 3, false)).toBe("高潮");
  });
});

describe("runAttributionJob", () => {
  it("persists limit-up records, themes and roles", async () => {
    mocks.ztPool.mockResolvedValue({
      date: "20260930", total: 3,
      list: [
        ztStock({ code: "300001", boards: 3, name: "一" }),
        ztStock({ code: "300002", boards: 2, name: "二" }),
        ztStock({ code: "300003", boards: 1, name: "三" }),
      ],
    });
    mocks.sectors.mockResolvedValue([{ code: "BK001", name: "机器人" }]);
    mocks.sectorStocks.mockResolvedValue(["300001", "300002", "300003"]);
    // theme 查找：首次不存在（null），后续 upsert 返回 id=1
    mocks.db.select.mockImplementation((sql: string) => {
      if (sql.includes("FROM theme WHERE name")) return Promise.resolve([]);
      if (sql.includes("SELECT id FROM collector_run")) return Promise.resolve([{ id: 1 }]);
      return Promise.resolve([]);
    });

    const r = await runAttributionJob(d, "2026-09-30", "20260930");
    expect(r).toMatchObject({ limitUp: 3, themes: 1 });

    const sqls = mocks.db.execute.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => s.includes("INSERT INTO limit_up_record"))).toBe(true);
    expect(sqls.filter((s) => s.includes("INSERT INTO theme_stock"))).toHaveLength(3);
    // 龙一归属最高分股
    const roleBinds = mocks.db.execute.mock.calls
      .filter((c) => c[0].includes("theme_stock"))
      .map((c) => c[1]);
    const leader = roleBinds.find((b) => b[1] === "300001");
    expect(leader[3]).toBe("龙一");
  });

  it("throws when the limit pool is empty (no data yet)", async () => {
    mocks.ztPool.mockResolvedValue({ date: "20260930", total: 0, list: [] });
    await expect(runAttributionJob(d, "2026-09-30", "20260930")).rejects.toThrow("涨停池为空");
  });
});
```

- [ ] **Step 4: 运行确认失败**

Run: `pnpm test tests/unit/kb/dailyJob.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 5: 实现 `src/kb/dailyJob.ts`**

```ts
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
import { clusterThemes, type ConceptMembership } from "./cluster";
import { assignRoles, type RoleInput } from "./roles";
import type { DailyResult as _DR } from "./types";

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
): _DR extends never ? never : import("./types").ThemeStage {
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
  const clusters = clusterThemes(sealStocks, concepts);

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
```

- [ ] **Step 6: 修正 `decideStage` 的返回类型写法**

`_DR extends never ? never : import("./types").ThemeStage` 是规避未使用导入的取巧写法，可能令读者困惑。将 `src/kb/types.ts` 中已有类型直接导入：把 dailyJob.ts 顶部 import 改为

```ts
import type { ThemeStage } from "./types";
```

并将 decideStage 签名简化为：

```ts
export function decideStage(sealCount: number, leaderBoards: number, isNew: boolean): ThemeStage {
```

删除 `import type { DailyResult as _DR } from "./types";` 行。

- [ ] **Step 7: 运行确认通过**

Run: `pnpm test tests/unit/kb/dailyJob.test.ts`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/market/eastmoney.rs src-tauri/src/lib.rs src/api/kb.ts src/kb/dailyJob.ts tests/unit/kb/dailyJob.test.ts
git commit -m "feat(kb): 板块成分命令与盘后归因作业（定格/聚类/角色/退潮标记）"
```

---

## Task 10: 采集调度器 composable

**Files:**

- Create: `src/composables/useCollector.ts`
- Modify: `src/App.vue`
- Test: `tests/unit/kb/useCollector.test.ts`

**Interfaces:**

- Consumes: repo（`startRun/finishRun/getRun`）、`ingestCatalysts`、`announceToDraft/irmToDraft`、`fetchAnnouncements/fetchIrmLatest`、`runAttributionJob` 及其日期工具。
- Produces:

```ts
collectorStatus: { running: boolean; lastAnnouncement: number; lastIrm: number;
                   lastAttribution: string; announcementCount: number; irmCount: number;
                   attributionThemes: number; lastError: string }
startCollector(): void
stopCollector(): void
runCollectionNow(job: CollectorJob): Promise<void>
```

- [ ] **Step 1: 写失败测试 `tests/unit/kb/useCollector.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { select: vi.fn(), execute: vi.fn() },
  announcements: vi.fn(),
  irmLatest: vi.fn(),
  attribution: vi.fn(),
}));
vi.mock("../../../src/db/database", () => ({
  db: () => mocks.db,
  ensureDb: vi.fn(async () => mocks.db),
}));
vi.mock("../../../src/api/kb", () => ({
  fetchAnnouncements: (d: string) => mocks.announcements(d),
  fetchIrmLatest: () => mocks.irmLatest(),
}));
vi.mock("../../../src/kb/dailyJob", () => ({
  runAttributionJob: (...a: unknown[]) => mocks.attribution(...a),
  todayCompact: (d: Date) => "20260930",
  isoDate: (d: Date) => "2026-09-30",
}));

import { collectorStatus, runCollectionNow, startCollector, stopCollector } from "../../../src/composables/useCollector";

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.db.execute.mockResolvedValue({ lastInsertId: 1, rowsAffected: 1 });
  mocks.db.select.mockResolvedValue([]); // getRun 默认 null
  mocks.announcements.mockResolvedValue([]);
  mocks.irmLatest.mockResolvedValue([]);
  mocks.attribution.mockResolvedValue({ tradeDate: "2026-09-30", themes: 2, stocks: 5, limitUp: 10 });
});

afterEach(() => {
  stopCollector();
  vi.useRealTimers();
});

describe("scheduler lifecycle", () => {
  it("is idle before start", () => {
    expect(collectorStatus.running).toBe(false);
  });

  it("manual attribution job records success and status", async () => {
    await runCollectionNow("attribution");
    expect(mocks.attribution).toHaveBeenCalledTimes(1);
    expect(collectorStatus.lastAttribution).toBe("2026-09-30");
    expect(collectorStatus.attributionThemes).toBe(2);
    // startRun + finishRun 至少各一次 execute
    expect(mocks.db.execute).toHaveBeenCalled();
  });

  it("marks the job failed and records the error when it throws", async () => {
    mocks.attribution.mockRejectedValueOnce(new Error("boom"));
    await runCollectionNow("attribution");
    expect(collectorStatus.lastError).toContain("boom");
  });

  it("does not rerun attribution twice for the same day", async () => {
    mocks.db.select.mockImplementation((sql: string) =>
      sql.includes("collector_run")
        ? Promise.resolve([{ id: 1, status: "success", rows_affected: 2 }])
        : Promise.resolve([])
    );
    await runCollectionNow("attribution");
    expect(mocks.attribution).not.toHaveBeenCalled();
  });

  it("start/stop toggles running", () => {
    startCollector();
    expect(collectorStatus.running).toBe(true);
    stopCollector();
    expect(collectorStatus.running).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test tests/unit/kb/useCollector.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/composables/useCollector.ts`**

```ts
// 采集调度器：盘中每 20 分钟增量抓公告/互动易催化；15:30-17:00 跑当日归因。
// 与 useTimeSeries 相同的前端调度模式；防重入、同日幂等、失败落 collector_run。
import { reactive } from "vue";
import {
  fetchAnnouncements,
  fetchIrmLatest,
} from "../api/kb";
import { db } from "../db/database";
import type { Db } from "../kb/repo";
import {
  finishRun,
  getRun,
  startRun,
} from "../kb/repo";
import {
  ingestCatalysts,
  announceToDraft,
  irmToDraft,
} from "../kb/catalystPipe";
import {
  isoDate,
  runAttributionJob,
  todayCompact,
} from "../kb/dailyJob";
import type { CollectorJob } from "../kb/types";

export const collectorStatus = reactive({
  running: false,
  lastAnnouncement: 0,
  lastIrm: 0,
  lastAttribution: "",
  announcementCount: 0,
  irmCount: 0,
  attributionThemes: 0,
  lastError: "",
});

let timer: number | null = null;
const locked = new Set<string>(); // 防重入键：job:date

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function nowIso(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function runAnnouncement(d: Db, date: string): Promise<number> {
  const items = await fetchAnnouncements(date);
  const { inserted } = await ingestCatalysts(d, items.map(announceToDraft));
  collectorStatus.lastAnnouncement = Date.now();
  collectorStatus.announcementCount += inserted;
  return inserted;
}

async function runIrm(d: Db): Promise<number> {
  const items = await fetchIrmLatest();
  const { inserted } = await ingestCatalysts(d, items.map(irmToDraft));
  collectorStatus.lastIrm = 0; // 由下面赋真实时间
  collectorStatus.lastIrm = Date.now();
  collectorStatus.irmCount += inserted;
  return inserted;
}

async function runAttribution(d: Db, date: string): Promise<number> {
  const r = await runAttributionJob(d, date, todayCompact(new Date()));
  collectorStatus.lastAttribution = r.tradeDate;
  collectorStatus.attributionThemes = r.themes;
  return r.themes;
}

/** 立即执行一个作业（带 run 状态记录与幂等/防重入）。 */
export async function runCollectionNow(job: CollectorJob): Promise<void> {
  const date = nowIso();
  const key = `${job}:${date}`;
  const d: Db = db();

  // 归因作业同日成功则跳过；其余作业允许补抓
  if (job === "attribution") {
    const done = await getRun(d, date, job);
    if (done?.status === "success") return;
  }
  if (locked.has(key)) return;
  locked.add(key);

  const runId = await startRun(d, date, job);
  try {
    let rows = 0;
    if (job === "announcement") rows = await runAnnouncement(d, date);
    else if (job === "irm") rows = await runIrm(d);
    else rows = await runAttribution(d, date);
    await finishRun(d, runId, "success", rows);
    collectorStatus.lastError = "";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    collectorStatus.lastError = msg;
    await finishRun(d, runId, "failed", 0, msg);
  } finally {
    locked.delete(key);
  }
}

function tick(): void {
  const now = new Date();
  const hm = now.getHours() * 60 + now.getMinutes();
  const weekday = now.getDay() >= 1 && now.getDay() <= 5;
  if (!weekday) return;

  // 盘中催化增量（9:30-15:00）
  if (hm >= 570 && hm <= 900) {
    void runCollectionNow("announcement");
    void runCollectionNow("irm");
  }
  // 盘后归因窗口 15:30-17:00
  if (hm >= 930 && hm <= 1020) {
    void runCollectionNow("attribution");
  }
}

export function startCollector(): void {
  if (collectorStatus.running) return;
  collectorStatus.running = true;
  // 每 20 分钟检查一次；启动后立即检查
  void Promise.resolve().then(tick);
  timer = window.setInterval(tick, 20 * 60 * 1000);
}

export function stopCollector(): void {
  collectorStatus.running = false;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
```

db 单例来自 `../db/database`（测试已 mock 该模块的 `db: () => mocks.db`）；repo 模块只导出类型与函数，不导出 db。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test tests/unit/kb/useCollector.test.ts`
Expected: PASS。

- [ ] **Step 5: 在 App.vue 启动调度器**

`src/App.vue` 已有 `import { startTimeSeries } from "./composables/useTimeSeries";`。在同处添加：

```ts
import { startCollector } from "./composables/useCollector";
```

并在调用 `startTimeSeries()` 的同一初始化位置（onMounted 或启动函数中）添加：

```ts
startCollector();
```

- [ ] **Step 6: Commit**

```bash
git add src/composables/useCollector.ts tests/unit/kb/useCollector.test.ts src/App.vue
git commit -m "feat(collect): 采集调度器（盘中催化增量+盘后归因）并随应用启动"
```

---

## Task 11: 题材库浏览卡 + 注册全链路 + 数据中心状态

**Files:**

- Create: `src/components/ThemeLibrary.vue`
- Modify: `src/lib/cards.ts`, `src/lib/dock.ts`, `src/lib/layout.ts`, `src/lib/scenes.ts`
- Modify: `src/components/CardContent.vue`, `src/components/SettingsDialog.vue`

**Interfaces:**

- Consumes: repo 的 `listThemes / listThemeStocks / listCatalysts`；`collectorStatus` 与 `runCollectionNow`。
- Produces: 卡片 id `themelib`，在 Mega「板块题材」域可用，盘后复盘场景默认开启。

- [ ] **Step 1: 注册卡片 id 与元信息（`src/lib/cards.ts`）**

在 `CardId` 联合类型末尾（`| "trades";` 之前）加：

```ts
  | "themelib"
```

在 `CARD_META` 中（`trades:` 行附近）加：

```ts
  themelib: { title: "题材库", accent: "#d4af37", kind: "chart" },
```

- [ ] **Step 2: Mega 菜单与布局尺寸**

`src/lib/dock.ts`：「板块题材」组的 `items` 中（sectorevent 之后）加：

```ts
      { id: "themelib", label: "题材库", icon: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20", desc: "题材生命周期/成分角色/催化剂时间线", star: true },
```

`src/lib/layout.ts`：

- 在 `WIDE_ORDER` 数组中 `"dragon"` 之后加 `"themelib"`；
- 在默认尺寸表（含 `dragon: { w: 6, h: 3 }` 的对象）中加 `themelib: { w: 6, h: 3 },`；
- 在聚焦/自由尺寸表（含 `dragon: { w: 8, h: 5 }` 的对象）中加 `themelib: { w: 8, h: 5 },`。

`src/lib/scenes.ts`：在盘后复盘场景（cards 含 `"reviewtimeline", "dragon", ...`）的 cards 数组加入 `"themelib"`，size 对象加入 `themelib: { w: 6, h: 3 }`。

- [ ] **Step 3: 渲染分支（`src/components/CardContent.vue`）**

import 区（`import DragonTiger ...` 附近）加：

```ts
import ThemeLibrary from "./ThemeLibrary.vue";
```

模板中（`DragonTiger` 分支之后）加：

```html
    <ThemeLibrary v-else-if="id === 'themelib'" />
```

- [ ] **Step 4: 实现卡片 `src/components/ThemeLibrary.vue`**

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { db } from "../db/database";
import type { Db } from "../kb/repo";
import { listCatalysts, listThemes, listThemeStocks } from "../kb/repo";
import { collectorStatus, runCollectionNow } from "../composables/useCollector";
import type { CatalystRow, ThemeRow, ThemeStockRow } from "../kb/types";

const themes = ref<ThemeRow[]>([]);
const currentId = ref<number | null>(null);
const stocks = ref<ThemeStockRow[]>([]);
const catalysts = ref<CatalystRow[]>([]);
const loading = ref(false);

const current = computed(() => themes.value.find((t) => t.id === currentId.value) ?? null);

const stageColor: Record<string, string> = {
  萌芽: "#8ab4ff",
  发酵: "#d4af37",
  高潮: "#ff5a6a",
  退潮: "#7a8699",
};

async function reload() {
  const d: Db = db();
  themes.value = await listThemes(d);
  if (currentId.value === null && themes.value[0]) {
    await selectTheme(themes.value[0].id);
  } else if (currentId.value !== null) {
    await selectTheme(currentId.value);
  }
}

async function selectTheme(id: number) {
  currentId.value = id;
  const d: Db = db();
  stocks.value = await listThemeStocks(d, id);
  catalysts.value = await listCatalysts(d, { themeId: id, limit: 30 });
}

async function collectNow() {
  loading.value = true;
  try {
    await runCollectionNow("attribution");
    await reload();
  } finally {
    loading.value = false;
  }
}

onMounted(reload);
</script>

<template>
  <div class="tl">
    <div class="tl-head">
      <div class="tl-title">题材库</div>
      <button class="tl-btn" :disabled="loading" @click="collectNow">
        {{ loading ? "采集中…" : "立即归因" }}
      </button>
    </div>
    <div class="tl-sub" v-if="collectorStatus.lastAttribution">
      最近归因 {{ collectorStatus.lastAttribution }} · {{ collectorStatus.attributionThemes }} 个活跃题材
    </div>

    <div class="tl-body">
      <div class="tl-list">
        <div
          v-for="t in themes"
          :key="t.id"
          class="tl-row"
          :class="{ on: t.id === currentId }"
          @click="selectTheme(t.id)"
        >
          <span class="tl-stage" :style="{ color: stageColor[t.stage] }">●</span>
          <span class="tl-name">{{ t.name }}</span>
          <span class="tl-badge" :style="{ color: stageColor[t.stage] }">{{ t.stage }}</span>
        </div>
        <div v-if="themes.length === 0" class="tl-empty">
          尚无题材。收盘后自动归因，或点击「立即归因」。
        </div>
      </div>

      <div class="tl-detail" v-if="current">
        <div class="tl-d-title">
          {{ current.name }}
          <span :style="{ color: stageColor[current.stage] }">· {{ current.level }} / {{ current.stage }}</span>
        </div>
        <div v-if="current.logic" class="tl-logic">{{ current.logic }}</div>

        <div class="tl-sec">成分角色（{{ stocks.length }}）</div>
        <div class="tl-stocks">
          <span v-for="s in stocks" :key="s.id" class="tl-chip" :data-role="s.role">
            {{ s.name }}<i>{{ s.role }}</i>
          </span>
        </div>

        <div class="tl-sec">催化剂 / 事件</div>
        <div class="tl-cats">
          <div v-for="c in catalysts" :key="c.id" class="tl-cat">
            <span class="tl-cat-title">{{ c.title }}</span>
            <span class="tl-cat-meta">{{ c.source }} · 新鲜度 {{ c.freshScore.toFixed(2) }}</span>
          </div>
          <div v-if="catalysts.length === 0" class="tl-empty">暂无关联催化</div>
        </div>
      </div>
    </div>

    <div class="tl-foot">数据来自公开接口，仅供参考，不构成投资建议</div>
  </div>
</template>

<style scoped>
.tl { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.tl-head { display: flex; align-items: center; justify-content: space-between; }
.tl-title { font-weight: 700; color: var(--text, #e6ecf5); }
.tl-btn {
  padding: 3px 12px; border: 1px solid var(--border, #2a3344); border-radius: 7px;
  background: var(--bg-card, #15181f); color: var(--accent, #d4af37);
  font-size: 11px; cursor: pointer;
}
.tl-btn:disabled { opacity: .6; cursor: default; }
.tl-sub { color: var(--text-dim); font-size: 11px; }
.tl-body { flex: 1; min-height: 0; display: flex; gap: 8px; }
.tl-list { width: 38%; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.tl-row {
  display: flex; align-items: center; gap: 6px; padding: 5px 8px;
  border-radius: 7px; cursor: pointer; color: var(--text, #d8dee9);
}
.tl-row:hover { background: rgba(212, 175, 55, .08); }
.tl-row.on { background: rgba(212, 175, 55, .16); }
.tl-stage { font-size: 9px; }
.tl-name { flex: 1; }
.tl-badge { font-size: 10px; }
.tl-detail { flex: 1; min-width: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.tl-d-title { font-weight: 700; color: var(--text); }
.tl-logic { color: var(--text-dim); line-height: 1.5; }
.tl-sec { color: var(--accent, #d4af37); font-size: 11px; margin-top: 2px; }
.tl-stocks { display: flex; flex-wrap: wrap; gap: 5px; }
.tl-chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px;
  border: 1px solid var(--border, #2a3344); border-radius: 20px;
}
.tl-chip i { font-style: normal; font-size: 10px; color: var(--text-dim); }
.tl-chip[data-role="龙一"] { border-color: rgba(255, 90, 106, .6); }
.tl-chip[data-role="龙二"] { border-color: rgba(212, 175, 55, .6); }
.tl-cats { display: flex; flex-direction: column; gap: 4px; }
.tl-cat { display: flex; justify-content: space-between; gap: 8px; color: var(--text); }
.tl-cat-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl-cat-meta { color: var(--text-dim); font-size: 10px; white-space: nowrap; }
.tl-empty { color: var(--text-dim); padding: 8px 0; }
.tl-foot { color: var(--text-dim); font-size: 10px; text-align: right; }
</style>
```

- [ ] **Step 5: 数据中心显示三个作业状态（`src/components/SettingsDialog.vue`）**

该文件已 import `tsStatus`。添加：

```ts
import { collectorStatus } from "../composables/useCollector";
```

在数据中心面板（`dc-row` 列表区域，即「市场情绪/指数/板块」三行之后）追加三行：

```html
                <div class="dc-row"><span class="dr-k">公告催化</span><span class="dr-v">{{ fmtTime(collectorStatus.lastAnnouncement) }} · {{ collectorStatus.announcementCount }} 条</span></div>
                <div class="dc-row"><span class="dr-k">互动易/e互动</span><span class="dr-v">{{ fmtTime(collectorStatus.lastIrm) }} · {{ collectorStatus.irmCount }} 条</span></div>
                <div class="dc-row"><span class="dr-k">题材归因</span><span class="dr-v">{{ collectorStatus.lastAttribution || "未运行" }}</span></div>
```

- [ ] **Step 6: 全量前端验证**

Run: `pnpm build`
Expected: vue-tsc + vite 通过。

Run: `pnpm test`
Expected: 全部单测 PASS（含新增 kb 目录 7 个文件的用例）。

- [ ] **Step 7: Commit**

```bash
git add src/components/ThemeLibrary.vue src/lib/cards.ts src/lib/dock.ts src/lib/layout.ts src/lib/scenes.ts src/components/CardContent.vue src/components/SettingsDialog.vue
git commit -m "feat(kb): 题材库浏览卡与全链路注册（Mega/场景/数据中心状态）"
```

---

## Task 12: 版本号、文档与手动联调收口

**Files:**

- Modify: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`（cargo 自动）, `src-tauri/tauri.conf.json`, `package.json`
- Modify: `README.md`（Roadmap 勾选与特性说明）

- [ ] **Step 1: 手动网络联调（真实网络，非自动化）**

按顺序执行并记录结果（任一失败按对应任务的「网络联调要求」更新 URL/字段，不阻塞其余项）：

1. 启动应用 → 设置 → 数据中心：确认采集调度器运行、数据中心三行可见。
2. 盘后窗口（或在题材库卡点「立即归因」）：确认 `limit_up_record / theme / theme_stock` 当日有数据；题材库卡可浏览角色与催化。
3. 若在非交易日/非盘后验证：涨停池可能为空，作业应标记 failed 且错误信息为「涨停池为空」——这是预期降级，不是缺陷。
4. 巨潮公告：确认当日公告能入库（标题/链接/分类），重复触发不产生重复行。
5. 互动易/e互动：两源各自独立；某源不可用时数据中心计数为 0、应用无报错弹窗。

- [ ] **Step 2: 全量测试**

Run: `pnpm test`
Expected: 全部 PASS。

Run: `pnpm build`
Expected: 构建通过。

Run: `pnpm tauri build --no-bundle`
Expected: Rust release 编译通过。

- [ ] **Step 3: 版本号统一升级为 1.7.0**

四处修改（保持与现有发版 SOP 一致）：

- `src-tauri/Cargo.toml`：`version = "1.7.0"`
- `src-tauri/tauri.conf.json`：`"version": "1.7.0"`
- `package.json`：`"version": "1.7.0"`
- 运行一次 `pnpm tauri build --no-bundle` 让 `Cargo.lock` 自动更新。

- [ ] **Step 4: 更新 README**

在 README「特性一览」增加一条（建议放在「龙虎榜复盘」之后）：

```markdown
**题材库与采集增强（AI 闭环 · 第一步）**
- 收盘自动涨停归因：涨停定格（封板时间/封单/连板/换手）+ 概念/行业两路聚类，题材生命周期（萌芽/发酵/高潮/退潮）每日更新
- 题材成分角色：龙一/龙二/助攻/跟风按连板高度、封单强度、封板时间确定性评分，龙一唯一性自动标注
- 催化剂事件库：巨潮公告 + 互动易/上证 e 互动增量，新鲜度按半衰期衰减，同源自动去重；外部源独立降级
- 题材库卡片：浏览题材、成分角色与催化时间线，一键手动归因；采集状态在设置 → 数据中心可见
```

在 Roadmap 列表勾选：

```markdown
- [x] 题材库 + 采集增强（v1.7：涨停归因/题材三表/公告与互动易增量/题材库卡）
```

- [ ] **Step 5: 最终提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json package.json README.md
git commit -m "release: v1.7.0，采集增强与题材库（AI 闭环第一步）"
```

（如需发版：按 README 发版 SOP 打 tag 推送，CI 自动构建发布。）

---

## 验收对照（Definition of Done · v1.7.0）

- [ ] 收盘后（或手动触发）`theme / theme_stock / catalyst / limit_up_record` 当日有数据，归因可在题材库卡复查。
- [ ] 聚类/角色/新鲜度全部为确定性纯函数，单测覆盖且通过；结果可复算。
- [ ] 巨潮公告、互动易/e互动增量抓取；单源失败独立降级，不阻断归因作业。
- [ ] 采集调度随应用启动、防重入、同日幂等；数据中心展示三个作业状态。
- [ ] 全量 `pnpm test` / `pnpm build` / `pnpm tauri build --no-bundle` 通过。
- [ ] 版本号四处统一 1.7.0；README 更新；全程保留「不构成投资建议」口径。
