import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { dbMock } = vi.hoisted(() => ({
  dbMock: { select: vi.fn(), execute: vi.fn() },
}));
vi.mock("../../../src/db/database", () => ({
  db: () => dbMock,
  ensureDb: vi.fn(async () => dbMock),
}));

import { useJournalStore, type JournalEntry } from "../../../src/stores/journal";

const base: JournalEntry = {
  id: 1, date: "2025-03-01", title: "t", content: "c", mood: null,
  tags: "", code: null, createdAt: 1, updatedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  dbMock.execute.mockResolvedValue({ lastInsertId: 1, rowsAffected: 1 });
});

describe("journal store", () => {
  it("starts empty and unloaded", () => {
    const s = useJournalStore();
    expect(s.entries).toEqual([]);
    expect(s.loaded).toBe(false);
    expect(s.dateCount).toEqual({});
  });

  it("loads rows mapping snake_case columns", async () => {
    dbMock.select.mockResolvedValueOnce([
      { id: 1, date: "2025-03-01", title: "t", content: "c", mood: "happy",
        tags: "a,b", code: null, created_at: 10, updated_at: 20 },
    ]);
    const s = useJournalStore();
    await s.load();
    expect(s.loaded).toBe(true);
    expect(s.entries[0]).toMatchObject({ createdAt: 10, updatedAt: 20, mood: "happy" });
  });

  it("creates an entry and prepends it", async () => {
    dbMock.execute.mockResolvedValueOnce({ lastInsertId: 5 });
    dbMock.select.mockResolvedValueOnce([
      { ...base, id: 5, date: "2025-04-01", created_at: 9, updated_at: 9 },
    ]);
    const s = useJournalStore();
    const e = await s.create("2025-04-01");
    expect(e.id).toBe(5);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].id).toBe(5);
  });

  it("updates whitelisted fields and bumps updatedAt", async () => {
    const s = useJournalStore();
    s.entries.push({ ...base });
    await s.update(1, { title: "new title", tags: "x", bogus: 1 } as any);
    expect(dbMock.execute).toHaveBeenCalledWith(
      expect.stringContaining("updated_at = ?"),
      expect.any(Array)
    );
    expect(s.entries[0].title).toBe("new title");
    expect(s.entries[0].tags).toBe("x");
    expect(s.entries[0].updatedAt).toEqual(expect.any(Number));
  });

  it("does nothing when update patch has no whitelisted keys", async () => {
    const s = useJournalStore();
    await s.update(1, { id: 9 } as any);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it("removes an entry", async () => {
    const s = useJournalStore();
    s.entries.push({ ...base }, { ...base, id: 2 });
    await s.remove(1);
    expect(s.entries.map((e) => e.id)).toEqual([2]);
  });

  it("filters by date ascending by id and counts per date", () => {
    const s = useJournalStore();
    s.entries.push(
      { ...base, id: 2, date: "2025-03-01" },
      { ...base, id: 1, date: "2025-03-01" },
      { ...base, id: 3, date: "2025-03-02" }
    );
    expect(s.byDate("2025-03-01").map((e) => e.id)).toEqual([1, 2]);
    expect(s.dateCount).toEqual({ "2025-03-01": 2, "2025-03-02": 1 });
  });
});
