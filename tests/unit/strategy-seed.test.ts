import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { select: vi.fn(), execute: vi.fn() },
}));
vi.mock("../../src/db/database", () => ({ db: () => mocks.db }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.db.execute.mockResolvedValue({ lastInsertId: 1, rowsAffected: 1 });
});

describe("strategy seed", () => {
  it("inserts three builtins when empty", async () => {
    mocks.db.select.mockResolvedValue([]);
    const s = await import("../../src/lib/strategySeed");
    await s.seedStrategyProfiles();
    const inserts = mocks.db.execute.mock.calls.filter((c) =>
      (c[0] as string).includes("INSERT INTO strategy_profile")
    );
    expect(inserts).toHaveLength(3);
  });

  it("is idempotent when builtins already exist", async () => {
    mocks.db.select.mockResolvedValue([{ id: 1 }]);
    const s = await import("../../src/lib/strategySeed");
    await s.seedStrategyProfiles();
    const inserts = mocks.db.execute.mock.calls.filter((c) =>
      (c[0] as string).includes("INSERT INTO strategy_profile")
    );
    expect(inserts).toHaveLength(0);
  });
});

describe("saveProfileVersion", () => {
  it("retires the old current and inserts the next version", async () => {
    mocks.db.select.mockImplementation((sql: string) =>
      sql.includes("MAX(version)")
        ? Promise.resolve([{ version: 2 }])
        : Promise.resolve([{ id: 9 }])
    );
    const s = await import("../../src/lib/strategySeed");
    const id = await s.saveProfileVersion({
      key: "leader",
      name: "龙头",
      spec: {} as never,
    });
    expect(id).toBe(9);
    const sqls = mocks.db.execute.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((x) => x.includes("is_current=0"))).toBe(true);
    expect(
      sqls.filter((x) => x.includes("INSERT INTO strategy_profile"))
    ).toHaveLength(1);
  });
});

describe("cloneProfile", () => {
  it("creates a non-conflicting custom key", async () => {
    mocks.db.select.mockImplementation((sql: string) => {
      if (sql.includes("DISTINCT key")) return Promise.resolve([{ key: "leader-copy1" }]);
      if (sql.includes("MAX(version)")) return Promise.resolve([{ version: 1 }]);
      return Promise.resolve([{ id: 3 }]);
    });
    const s = await import("../../src/lib/strategySeed");
    const source = {
      id: 1, key: "leader", name: "龙头战法", version: 1, builtin: 1, is_current: 1,
      spec: JSON.stringify({
        marketRegime: "", entry: {},
        position: { initial: 1, add: 1, max: 1 },
        takeProfit: { rule: "" }, stopLoss: { rule: "" },
        holdingPeriod: "", exclude: [],
      }),
      note: "", parent_id: null, created_at: 0, updated_at: 0,
    };
    const key = await s.cloneProfile(source as never, "龙头 副本");
    expect(key).toBe("leader-copy2");
  });
});

describe("setCurrentProfile", () => {
  it("clears the same key then sets the target id", async () => {
    mocks.db.select.mockResolvedValue([]);
    const s = await import("../../src/lib/strategySeed");
    await s.setCurrentProfile(5, "leader");
    const sqls = mocks.db.execute.mock.calls.map((c) => c[0] as string);
    expect(sqls).toHaveLength(2);
    expect((mocks.db.execute.mock.calls[1] as unknown[])[1]).toEqual([5]);
  });
});
