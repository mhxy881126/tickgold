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
  dbMock.select.mockResolvedValue([]);
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

describe("catalyst freshness on read (M1)", () => {
  function catalystRow(over: Record<string, unknown> = {}) {
    return {
      id: 1, kind: "policy", title: "t", summary: "", source: "cninfo",
      source_url: "", published_at: Date.now(), direction: "中性",
      theme_id: null, code: null, fresh_score: 1, content_hash: "h",
      collected_at: Date.now(), ...over,
    };
  }

  it("recomputes fresh_score from published_at age, ignoring the stored value", async () => {
    // policy 半衰期 7 天：恰好一个半衰期 → 0.5；库里存的 1 必须被覆盖
    dbMock.select.mockResolvedValueOnce([
      catalystRow({ kind: "policy", fresh_score: 1, published_at: Date.now() - 7 * 86_400_000 }),
    ]);
    const [c] = await repo.listCatalysts(d, { limit: 10 });
    expect(c.freshScore).toBeCloseTo(0.5, 10);
  });

  it("falls back to collected_at when published_at is NULL", async () => {
    dbMock.select.mockResolvedValueOnce([
      catalystRow({ published_at: null, collected_at: Date.now(), fresh_score: 0.2 }),
    ]);
    const [c] = await repo.listCatalysts(d);
    expect(c.freshScore).toBeCloseTo(1, 10);
  });
});

describe("upsertTheme logic_version (M9)", () => {
  const existing = { ...themeDbRow, logic: "降本增效", logic_version: 3 };

  function updateBind() {
    return dbMock.execute.mock.calls[0][1] as unknown[];
  }

  it("keeps logic_version unchanged when draft logic is identical", async () => {
    dbMock.select.mockResolvedValueOnce([existing]);
    await repo.upsertTheme(d, { name: "机器人", logic: "降本增效", stage: "发酵" }, 100);
    const bind = updateBind();
    expect(bind[4]).toBe("降本增效");
    expect(bind[5]).toBe(3);
  });

  it("keeps logic_version (and logic) when draft logic is empty", async () => {
    dbMock.select.mockResolvedValueOnce([existing]);
    await repo.upsertTheme(d, { name: "机器人", logic: "", stage: "高潮" }, 100);
    const bind = updateBind();
    expect(bind[4]).toBe("降本增效");
    expect(bind[5]).toBe(3);
  });

  it("increments logic_version only when a new non-empty logic differs", async () => {
    dbMock.select.mockResolvedValueOnce([existing]);
    await repo.upsertTheme(d, { name: "机器人", logic: "新逻辑：国产替代", stage: "发酵" }, 100);
    const bind = updateBind();
    expect(bind[4]).toBe("新逻辑：国产替代");
    expect(bind[5]).toBe(4);
  });
});

describe("markStocksLeft (M6)", () => {
  it("stamps left_date for absent members with NOT IN and ordered binds", async () => {
    await repo.markStocksLeft(d, 7, ["300001", "300002"], "2026-09-30");
    const [sql, bind] = dbMock.execute.mock.calls[0];
    expect(sql).toContain("UPDATE theme_stock SET left_date=");
    expect(sql).toContain("left_date IS NULL");
    expect(sql).toContain("NOT IN (?,?)");
    expect(bind).toEqual(["2026-09-30", 7, "300001", "300002"]);
  });

  it("is a no-op when no stock is present today", async () => {
    await repo.markStocksLeft(d, 7, [], "2026-09-30");
    expect(dbMock.execute).not.toHaveBeenCalled();
  });
});

describe("catalyst / limit-up", () => {
  it("insertCatalystIgnore returns true for a fresh hash", async () => {
    expect(await repo.insertCatalystIgnore(d, {
      kind: "policy", title: "t", summary: "", source: "cninfo", sourceUrl: "",
      publishedAt: 1, direction: "利好", themeId: null, code: null,
      freshScore: 1, hash: "h1", collectedAt: 1,
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
