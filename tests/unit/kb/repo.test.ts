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
