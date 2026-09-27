import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { installBrowserGlobals } from "../helpers/browser-globals";
import type { Group, WatchStock } from "../../../src/api/types";

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    select: vi.fn(),
    execute: vi.fn(),
  },
}));
vi.mock("../../../src/db/database", () => ({
  db: () => dbMock,
  ensureDb: vi.fn(async () => dbMock),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => undefined) }));

import { useWatchlistStore } from "../../../src/stores/watchlist";

function groupRow(id: number, name: string, sortOrder: number): Group {
  return { id, name, sortOrder };
}
function stockRow(code: string, name: string, groupId: number, sortOrder: number): WatchStock {
  return { code, name, groupId, sortOrder };
}

let env: ReturnType<typeof installBrowserGlobals>;

beforeEach(() => {
  vi.clearAllMocks();
  env = installBrowserGlobals();
  setActivePinia(createPinia());
  dbMock.execute.mockResolvedValue({ lastInsertId: undefined, rowsAffected: 1 });
});

describe("watchlist: initial state", () => {
  it("starts empty and unloaded", () => {
    const wl = useWatchlistStore();
    expect(wl.groups).toEqual([]);
    expect(wl.stocks).toEqual([]);
    expect(wl.loaded).toBe(false);
    expect(wl.currentGroupId).toBe(1);
    expect(wl.codes).toEqual([]);
    expect(wl.currentStocks).toEqual([]);
  });
});

describe("watchlist: load", () => {
  it("maps groups/stocks rows and selects first group when no preference", async () => {
    dbMock.select
      .mockResolvedValueOnce([groupRow(1, "默认", 0), groupRow(2, "科技", 1)])
      .mockResolvedValueOnce([
        stockRow("600519", "贵州茅台", 1, 0),
        stockRow("300750", "宁德时代", 2, 0),
      ]);
    const wl = useWatchlistStore();
    await wl.load();

    expect(wl.loaded).toBe(true);
    expect(wl.groups).toHaveLength(2);
    expect(wl.stocks).toHaveLength(2);
    // no saved preference -> first group
    expect(wl.currentGroupId).toBe(1);
    expect(wl.currentGroup?.name).toBe("默认");
    // codes sorted across groups: group 1 first
    expect(wl.codes).toEqual(["600519", "300750"]);
    expect(wl.currentStocks.map((s) => s.code)).toEqual(["600519"]);
  });

  it("restores the saved current group when it exists", async () => {
    env.localStorage.setItem("sd_current_group", "2");
    dbMock.select
      .mockResolvedValueOnce([groupRow(1, "默认", 0), groupRow(2, "科技", 1)])
      .mockResolvedValueOnce([stockRow("300750", "宁德时代", 2, 0)]);
    const wl = useWatchlistStore();
    await wl.load();
    expect(wl.currentGroupId).toBe(2);
  });

  it("ignores saved preference for a missing group and falls back to first", async () => {
    env.localStorage.setItem("sd_current_group", "99");
    dbMock.select
      .mockResolvedValueOnce([groupRow(1, "默认", 0)])
      .mockResolvedValueOnce([]);
    const wl = useWatchlistStore();
    await wl.load();
    expect(wl.currentGroupId).toBe(1);
  });

  it("falls back to id 1 when there are no groups at all", async () => {
    dbMock.select.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const wl = useWatchlistStore();
    await wl.load();
    expect(wl.currentGroupId).toBe(1);
    expect(wl.currentGroup).toBeUndefined();
  });
});

describe("watchlist: add / remove", () => {
  beforeEach(async () => {
    dbMock.select
      .mockResolvedValueOnce([groupRow(1, "默认", 0)])
      .mockResolvedValueOnce([stockRow("600519", "贵州茅台", 1, 0)]);
  });

  it("add inserts a new stock with correct sort order", async () => {
    const wl = useWatchlistStore();
    await wl.load();
    dbMock.execute.mockClear();
    await wl.add(" 000001 ", "平安银行");
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
    expect(dbMock.execute.mock.calls[0][1]).toEqual([
      "000001",
      "平安银行",
      1,
      1,
      expect.any(Number),
    ]);
    expect(wl.stocks.some((s) => s.code === "000001")).toBe(true);
  });

  it("add ignores blank code", async () => {
    const wl = useWatchlistStore();
    await wl.load();
    dbMock.execute.mockClear();
    await wl.add("   ");
    expect(dbMock.execute).not.toHaveBeenCalled();
    expect(wl.stocks).toHaveLength(1);
  });

  it("add existing code moves it to the target group instead of duplicating", async () => {
    const wl = useWatchlistStore();
    await wl.load();
    // add group 2 to memory
    wl.groups.push(groupRow(2, "科技", 1));
    dbMock.execute.mockClear();
    await wl.add("600519", "贵州茅台", 2);
    const moved = wl.stocks.find((s) => s.code === "600519")!;
    expect(moved.groupId).toBe(2);
    expect(wl.stocks.filter((s) => s.code === "600519")).toHaveLength(1);
    expect(dbMock.execute).toHaveBeenCalledWith(
      "UPDATE stocks SET group_id=?, sort_order=? WHERE code=?",
      [2, 0, "600519"]
    );
  });

  it("remove deletes the row from db and state", async () => {
    const wl = useWatchlistStore();
    await wl.load();
    await wl.remove("600519");
    expect(dbMock.execute).toHaveBeenCalledWith("DELETE FROM stocks WHERE code=?", ["600519"]);
    expect(wl.stocks.some((s) => s.code === "600519")).toBe(false);
  });

  it("ensureName backfills an empty name and persists", async () => {
    const wl = useWatchlistStore();
    await wl.load();
    wl.stocks.find((s) => s.code === "600519")!.name = "";
    await wl.ensureName("600519", "贵州茅台");
    expect(wl.stocks.find((s) => s.code === "600519")?.name).toBe("贵州茅台");
    expect(dbMock.execute).toHaveBeenCalledWith(
      "UPDATE stocks SET name=? WHERE code=?",
      ["贵州茅台", "600519"]
    );
  });

  it("ensureName no-ops for unknown code, existing name, or blank name", async () => {
    const wl = useWatchlistStore();
    await wl.load();
    dbMock.execute.mockClear();
    await wl.ensureName("999999", "幽灵");
    await wl.ensureName("600519", "");
    await wl.ensureName("600519", "不应覆盖");
    expect(dbMock.execute).not.toHaveBeenCalled();
  });
});

describe("watchlist: reorder", () => {
  it("reorders within the current group and persists new positions", async () => {
    dbMock.select
      .mockResolvedValueOnce([groupRow(1, "默认", 0)])
      .mockResolvedValueOnce([
        stockRow("a", "A", 1, 0),
        stockRow("b", "B", 1, 1),
        stockRow("c", "C", 1, 2),
      ]);
    const wl = useWatchlistStore();
    await wl.load();
    await wl.reorder("a", 2);
    expect(wl.currentStocks.map((s) => s.code)).toEqual(["b", "c", "a"]);
  });

  it("reorder no-ops when code absent or index unchanged", async () => {
    dbMock.select
      .mockResolvedValueOnce([groupRow(1, "默认", 0)])
      .mockResolvedValueOnce([stockRow("a", "A", 1, 0)]);
    const wl = useWatchlistStore();
    await wl.load();
    dbMock.execute.mockClear();
    await wl.reorder("zzz", 1);
    await wl.reorder("a", 0);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });
});

describe("watchlist: groups", () => {
  beforeEach(async () => {
    dbMock.select
      .mockResolvedValueOnce([groupRow(1, "默认", 0)])
      .mockResolvedValueOnce([stockRow("600519", "贵州茅台", 1, 0)]);
  });

  it("addGroup inserts, switches to it, and returns id", async () => {
    const wl = useWatchlistStore();
    await wl.load();
    dbMock.execute.mockResolvedValueOnce({ lastInsertId: 7 });
    const id = await wl.addGroup(" 科技 ");
    expect(id).toBe(7);
    expect(wl.groups.find((g) => g.id === 7)?.name).toBe("科技");
    expect(wl.currentGroupId).toBe(7);
    expect(env.localStorage.getItem("sd_current_group")).toBe("7");
  });

  it("addGroup with blank name returns current group without inserting", async () => {
    const wl = useWatchlistStore();
    await wl.load();
    dbMock.execute.mockClear();
    const id = await wl.addGroup("   ");
    expect(id).toBe(1);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it("renameGroup updates name", async () => {
    const wl = useWatchlistStore();
    await wl.load();
    await wl.renameGroup(1, "主力");
    expect(wl.groups.find((g) => g.id === 1)?.name).toBe("主力");
  });

  it("renameGroup ignores blank name", async () => {
    const wl = useWatchlistStore();
    await wl.load();
    dbMock.execute.mockClear();
    await wl.renameGroup(1, "  ");
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it("removeGroup moves members to default group, deletes group, resets selection", async () => {
    const wl = useWatchlistStore();
    await wl.load();
    wl.groups.push(groupRow(2, "科技", 1));
    wl.stocks.push(stockRow("300750", "宁德时代", 2, 0));
    await wl.selectGroup(2);
    await wl.removeGroup(2);

    expect(wl.groups.some((g) => g.id === 2)).toBe(false);
    const moved = wl.stocks.find((s) => s.code === "300750")!;
    expect(moved.groupId).toBe(1);
    expect(moved.sortOrder).toBe(1);
    expect(wl.currentGroupId).toBe(1);
  });

  it("removeGroup refuses to delete the default group id 1", async () => {
    const wl = useWatchlistStore();
    await wl.load();
    dbMock.execute.mockClear();
    await wl.removeGroup(1);
    expect(dbMock.execute).not.toHaveBeenCalled();
    expect(wl.groups).toHaveLength(1);
  });
});

describe("watchlist: selectors", () => {
  it("selectGroup persists preference; stocksOf/nameOf work", async () => {
    dbMock.select
      .mockResolvedValueOnce([groupRow(1, "默认", 0), groupRow(2, "科技", 1)])
      .mockResolvedValueOnce([
        stockRow("600519", "贵州茅台", 1, 0),
        stockRow("300750", "宁德时代", 2, 0),
      ]);
    const wl = useWatchlistStore();
    await wl.load();
    wl.selectGroup(2);
    expect(env.localStorage.getItem("sd_current_group")).toBe("2");
    expect(wl.stocksOf(2).map((s) => s.code)).toEqual(["300750"]);
    expect(wl.nameOf("600519")).toBe("贵州茅台");
    expect(wl.nameOf("nope")).toBe("");
  });

  it("codes are sorted by group then sortOrder", async () => {
    dbMock.select
      .mockResolvedValueOnce([groupRow(1, "默认", 0)])
      .mockResolvedValueOnce([
        stockRow("z", "Z", 2, 9),
        stockRow("a", "A", 1, 1),
        stockRow("b", "B", 1, 0),
      ]);
    const wl = useWatchlistStore();
    await wl.load();
    expect(wl.codes).toEqual(["b", "a", "z"]);
  });
});
