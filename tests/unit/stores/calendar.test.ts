import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { dbMock } = vi.hoisted(() => ({
  dbMock: { select: vi.fn(), execute: vi.fn() },
}));
vi.mock("../../../src/db/database", () => ({
  db: () => dbMock,
  ensureDb: vi.fn(async () => dbMock),
}));

import { useCalendarStore, type CalEvent } from "../../../src/stores/calendar";

const baseEvent: CalEvent = {
  id: 1, date: "2025-01-15", time: "09:30", title: "GDP",
  type: "macro", note: "", code: null, remind: 0, done: 0, createdAt: 1000,
};

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  dbMock.execute.mockResolvedValue({ lastInsertId: 1, rowsAffected: 1 });
});

describe("calendar store", () => {
  it("starts empty and unloaded", () => {
    const s = useCalendarStore();
    expect(s.events).toEqual([]);
    expect(s.loaded).toBe(false);
  });

  it("loads rows and maps snake_case fields", async () => {
    dbMock.select.mockResolvedValueOnce([
      { ...baseEvent, created_at: 1000 },
    ]);
    const s = useCalendarStore();
    await s.load();
    expect(s.loaded).toBe(true);
    expect(s.events[0].createdAt).toBe(1000);
    expect(s.events[0].title).toBe("GDP");
  });

  it("creates an event, inserts and appends to the sorted list", async () => {
    dbMock.execute.mockResolvedValueOnce({ lastInsertId: 2 });
    dbMock.select.mockResolvedValueOnce([
      { ...baseEvent, id: 2, date: "2025-02-01", created_at: 2000 },
    ]);
    const s = useCalendarStore();
    const e = await s.create("2025-02-01");
    expect(e.id).toBe(2);
    expect(e.date).toBe("2025-02-01");
    expect(s.events).toHaveLength(1);
    expect(dbMock.execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO cal_event"),
      ["2025-02-01", expect.any(Number)]
    );
  });

  it("updates whitelisted fields only", async () => {
    const s = useCalendarStore();
    s.events.push({ ...baseEvent });
    await s.update(1, { title: "CPI", note: "new", bogus: 1 } as any);
    expect(dbMock.execute).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE cal_event SET"),
      expect.arrayContaining(["CPI", "new", 1])
    );
    expect(s.events[0].title).toBe("CPI");
    expect(s.events[0].note).toBe("new");
    // only whitelisted fields are written to SQL
    expect(dbMock.execute.mock.calls[0][0]).not.toContain("bogus");
  });

  it("skips update when patch has no whitelisted keys", async () => {
    const s = useCalendarStore();
    await s.update(1, { id: 5 } as any);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it("removes an event from db and state", async () => {
    const s = useCalendarStore();
    s.events.push({ ...baseEvent }, { ...baseEvent, id: 2 });
    await s.remove(1);
    expect(s.events.map((e) => e.id)).toEqual([2]);
  });

  it("returns events for a date sorted by time (null first)", () => {
    const s = useCalendarStore();
    s.events.push(
      { ...baseEvent, id: 1, date: "2025-01-15", time: "10:00" },
      { ...baseEvent, id: 2, date: "2025-01-15", time: null },
      { ...baseEvent, id: 3, date: "2025-01-16", time: "08:00" }
    );
    const day = s.byDate("2025-01-15");
    expect(day.map((e) => e.id)).toEqual([2, 1]);
  });
});
