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

import { decideStage, dropCoveredIndustryClusters, runAttributionJob, todayCompact } from "../../../src/kb/dailyJob";
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

describe("dropCoveredIndustryClusters", () => {
  const ind = (codes: string[]) => ({ name: "设备", path: "industry" as const, codes, sealCount: 3, totalBoards: 3, leaderBoards: 1, score: 33 });
  const con = (name: string, codes: string[]) => ({ name, path: "concept" as const, codes, sealCount: 3, totalBoards: 6, leaderBoards: 3, score: 63 });

  it("keeps an industry cluster when no concepts exist", () => {
    const out = dropCoveredIndustryClusters([ind(["a", "b", "c"])]);
    expect(out.map((c) => c.name)).toEqual(["设备"]);
  });

  it("keeps an industry cluster only partially covered", () => {
    const out = dropCoveredIndustryClusters([con("机器人", ["a"]), ind(["a", "b", "c"])]);
    expect(out.map((c) => c.name)).toEqual(["机器人", "设备"]);
  });

  it("drops an industry cluster fully covered by concept clusters", () => {
    const out = dropCoveredIndustryClusters([con("机器人", ["a", "b"]), con("工业母机", ["c"]), ind(["a", "b", "c"])]);
    expect(out.map((c) => c.name)).toEqual(["机器人", "工业母机"]);
  });
});
