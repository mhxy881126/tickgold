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

  it("records failure without throwing when getRun itself rejects (M3)", async () => {
    // db()/getRun 移入 try：select 拒绝也要能走失败落库，拒绝不能逃逸
    mocks.db.select.mockRejectedValueOnce(new Error("select boom"));
    await expect(runCollectionNow("attribution")).resolves.toBeUndefined();
    expect(collectorStatus.lastError).toContain("select boom");
    const sqls = mocks.db.execute.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes("UPDATE collector_run"))).toBe(true);
  });

  it("intraday window runs announcements and IRM but not attribution", async () => {
    vi.setSystemTime(new Date(2026, 8, 30, 10, 30, 0)); // 周三 10:30
    startCollector();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(mocks.announcements).toHaveBeenCalledTimes(1);
    expect(mocks.irmLatest).toHaveBeenCalledTimes(1);
    expect(mocks.attribution).not.toHaveBeenCalled();
  });

  it("post-close window runs attribution plus announcement re-sweep, not IRM", async () => {
    vi.setSystemTime(new Date(2026, 8, 30, 16, 0, 0)); // 周三 16:00
    startCollector();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(mocks.attribution).toHaveBeenCalledTimes(1);
    expect(mocks.announcements).toHaveBeenCalledTimes(1);
    expect(mocks.irmLatest).not.toHaveBeenCalled();
  });

  it("start/stop toggles running", () => {
    startCollector();
    expect(collectorStatus.running).toBe(true);
    stopCollector();
    expect(collectorStatus.running).toBe(false);
  });
});
