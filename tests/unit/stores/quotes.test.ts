// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { installBrowserGlobals } from "../helpers/browser-globals";
import type { Group, Quote, WatchStock } from "../../../src/api/types";

const { dbMock, marketMocks } = vi.hoisted(() => ({
  dbMock: { select: vi.fn(), execute: vi.fn() },
  marketMocks: { fetchQuotes: vi.fn() },
}));

vi.mock("../../../src/db/database", () => ({
  db: () => dbMock,
  ensureDb: vi.fn(async () => dbMock),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => undefined) }));
vi.mock("../../../src/api/market", () => ({
  fetchQuotes: (...a: unknown[]) => marketMocks.fetchQuotes(...a),
}));

import { useQuotesStore } from "../../../src/stores/quotes";
import { useWatchlistStore } from "../../../src/stores/watchlist";

function quote(code: string, p: Partial<Quote> = {}): Quote {
  return {
    code,
    name: code,
    price: 10,
    change: 0,
    pct: 1,
    open: 10,
    high: 10,
    low: 10,
    prevClose: 9.9,
    volume: 100,
    amount: 1000,
    time: 1,
    source: "eastmoney",
    turnover: 0,
    pe: 0,
    pb: 0,
    amplitude: 0,
    volumeRatio: 1,
    circMv: 0,
    totalMv: 0,
    ...p,
  };
}

let env: ReturnType<typeof installBrowserGlobals>;

// Load a real watchlist store (its db/event deps are mocked too).
async function loadWatchlist(
  groups: Group[] = [{ id: 1, name: "默认", sortOrder: 0 }],
  stocks: WatchStock[] = []
) {
  dbMock.select.mockReset();
  dbMock.select.mockResolvedValueOnce(groups).mockResolvedValueOnce(stocks);
  const wl = useWatchlistStore();
  await wl.load();
  return wl;
}

// Flush promise microtasks (needed because start() fires `void tick()`).
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  // Fake timers must be installed before browser globals so that the
  // window.setInterval wrapper captures the faked globalThis.setInterval.
  vi.useFakeTimers();
  vi.clearAllMocks();
  env = installBrowserGlobals();
  setActivePinia(createPinia());
  dbMock.execute.mockResolvedValue({ rowsAffected: 1 });
  marketMocks.fetchQuotes.mockResolvedValue([quote("600519", { name: "贵州茅台" })]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("quotes: initial state", () => {
  it("starts empty/idle", () => {
    const q = useQuotesStore();
    expect(q.map).toEqual({});
    expect(q.lastUpdate).toBe(0);
    expect(q.polling).toBe(false);
    expect(q.error).toBe("");
    expect(q.sortedByPct()).toEqual([]);
  });
});

describe("quotes: tick branches", () => {
  it("clears map when watchlist not loaded", async () => {
    const q = useQuotesStore();
    await q.tick();
    expect(marketMocks.fetchQuotes).not.toHaveBeenCalled();
    expect(q.map).toEqual({});
  });

  it("clears map when watchlist has no codes", async () => {
    await loadWatchlist();
    const q = useQuotesStore();
    await q.tick();
    expect(marketMocks.fetchQuotes).not.toHaveBeenCalled();
    expect(q.map).toEqual({});
    expect(q.error).toBe("");
  });

  it("fetches and maps quotes, backfills names, stamps lastUpdate", async () => {
    await loadWatchlist(
      [{ id: 1, name: "默认", sortOrder: 0 }],
      [{ code: "600519", name: "", groupId: 1, sortOrder: 0 }]
    );
    const q = useQuotesStore();
    await q.tick();

    expect(q.map["600519"].price).toBe(10);
    expect(q.lastUpdate).toBeGreaterThan(0);
    expect(q.error).toBe("");
    // name backfilled into the watchlist record
    const wl = useWatchlistStore();
    expect(wl.nameOf("600519")).toBe("贵州茅台");
  });

  it("skips re-entrant tick while a previous one is in flight", async () => {
    await loadWatchlist(
      [{ id: 1, name: "默认", sortOrder: 0 }],
      [{ code: "600519", name: "贵州茅台", groupId: 1, sortOrder: 0 }]
    );
    // Never resolve the first fetch.
    marketMocks.fetchQuotes.mockReturnValue(new Promise(() => {}));
    const q = useQuotesStore();
    void q.tick();
    void q.tick();
    await flush();
    expect(marketMocks.fetchQuotes).toHaveBeenCalledTimes(1);
  });

  it("records error but keeps existing quotes on failure", async () => {
    await loadWatchlist(
      [{ id: 1, name: "默认", sortOrder: 0 }],
      [{ code: "600519", name: "贵州茅台", groupId: 1, sortOrder: 0 }]
    );
    const q = useQuotesStore();
    await q.tick();
    const before = q.map["600519"];

    marketMocks.fetchQuotes.mockRejectedValueOnce(new Error("network down"));
    await q.tick();

    expect(q.error).toContain("network down");
    expect(q.map["600519"]).toBe(before);
  });

  it("incrementally merges: updates in place, adds new, removes gone", async () => {
    await loadWatchlist(
      [{ id: 1, name: "默认", sortOrder: 0 }],
      [
        { code: "A", name: "A", groupId: 1, sortOrder: 0 },
        { code: "OLD", name: "OLD", groupId: 1, sortOrder: 1 },
      ]
    );
    const q = useQuotesStore();
    marketMocks.fetchQuotes.mockResolvedValue([
      quote("A", { price: 10, pct: 1 }),
      quote("OLD", { price: 20, pct: 2 }),
    ]);
    await q.tick();
    const aRef = q.map["A"];

    marketMocks.fetchQuotes.mockResolvedValue([
      quote("A", { price: 11, pct: 5 }),
      quote("NEW", { price: 30, pct: -1 }),
    ]);
    await q.tick();

    // same object reference, mutated fields
    expect(q.map["A"]).toBe(aRef);
    expect(q.map["A"].price).toBe(11);
    expect(q.map["NEW"].price).toBe(30);
    expect("OLD" in q.map).toBe(false);
  });
});

describe("quotes: start / stop polling", () => {
  beforeEach(async () => {
    await loadWatchlist(
      [{ id: 1, name: "默认", sortOrder: 0 }],
      [{ code: "600519", name: "贵州茅台", groupId: 1, sortOrder: 0 }]
    );
  });

  it("start arms interval and performs an immediate tick; stop disarms", async () => {
    const q = useQuotesStore();
    q.start(2000);
    expect(q.polling).toBe(true);
    await flush();
    expect(marketMocks.fetchQuotes).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(marketMocks.fetchQuotes).toHaveBeenCalledTimes(2);

    q.stop();
    expect(q.polling).toBe(false);
    await vi.advanceTimersByTimeAsync(6000);
    expect(marketMocks.fetchQuotes).toHaveBeenCalledTimes(2);
  });

  it("does not arm when document hidden or offline", async () => {
    env.document.hidden = true;
    let q = useQuotesStore();
    q.start();
    expect(q.polling).toBe(false);

    // fresh store, offline
    setActivePinia(createPinia());
    env.document.hidden = false;
    env.navigator.onLine = false;
    q = useQuotesStore();
    q.start();
    expect(q.polling).toBe(false);
  });
});

describe("quotes: visibility / connectivity events", () => {
  beforeEach(async () => {
    await loadWatchlist(
      [{ id: 1, name: "默认", sortOrder: 0 }],
      [{ code: "600519", name: "贵州茅台", groupId: 1, sortOrder: 0 }]
    );
  });

  it("disarms when hidden, re-arms and ticks when visible", async () => {
    const q = useQuotesStore();
    q.start();
    await flush();

    env.document.dispatch("visibilitychange"); // hidden=false => visible branch
    await flush();
    expect(q.polling).toBe(true);

    env.document.hidden = true;
    env.document.dispatch("visibilitychange");
    expect(q.polling).toBe(false);
  });

  it("re-arms on online and disarms on offline", async () => {
    const q = useQuotesStore();
    q.start();
    await flush();
    const callsAfterStart = marketMocks.fetchQuotes.mock.calls.length;

    env.window.dispatch("online");
    await flush();
    expect(q.polling).toBe(true);
    expect(marketMocks.fetchQuotes.mock.calls.length).toBeGreaterThan(callsAfterStart);

    env.window.dispatch("offline");
    expect(q.polling).toBe(false);
  });
});

describe("quotes: sortedByPct", () => {
  it("sorts descending by pct", async () => {
    await loadWatchlist(
      [{ id: 1, name: "默认", sortOrder: 0 }],
      [
        { code: "A", name: "A", groupId: 1, sortOrder: 0 },
        { code: "B", name: "B", groupId: 1, sortOrder: 1 },
      ]
    );
    const q = useQuotesStore();
    marketMocks.fetchQuotes.mockResolvedValue([
      quote("A", { pct: 1 }),
      quote("B", { pct: 8 }),
    ]);
    await q.tick();
    expect(q.sortedByPct().map((x) => x.code)).toEqual(["B", "A"]);
  });
});
