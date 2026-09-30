import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

import * as market from "../../../src/api/market";

// 无参封装只调用 invoke(command) 一个参数
const NO_ARGS = Symbol("no-args") as unknown as Record<string, unknown>;

beforeEach(() => {
  vi.resetAllMocks();
  invokeMock.mockResolvedValue("ok");
});

describe("graceful market wrappers (failure → [])", () => {
  it("fetchQuotes returns [] and skips invoke for empty codes", async () => {
    await expect(market.fetchQuotes([])).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("fetchQuotes passes codes through and returns the invoke result", async () => {
    invokeMock.mockResolvedValue([{ code: "600519" }]);
    const r = await market.fetchQuotes(["600519"]);
    expect(r).toEqual([{ code: "600519" }]);
    expect(invokeMock).toHaveBeenCalledWith("get_quotes", { codes: ["600519"] });
  });

  it("fetchQuotes swallows errors and returns []", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    await expect(market.fetchQuotes(["600519"])).resolves.toEqual([]);
  });

  it("fetchKLine uses default period/count and swallows errors", async () => {
    await market.fetchKLine("600519");
    expect(invokeMock).toHaveBeenCalledWith("get_kline", {
      code: "600519", period: 101, count: 500,
    });

    invokeMock.mockRejectedValue(new Error("x"));
    await expect(market.fetchKLine("600519", 5, 10)).resolves.toEqual([]);
  });

  it("searchStocks rejects blank keywords, passes through, and swallows errors", async () => {
    await expect(market.searchStocks("   ")).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();

    invokeMock.mockResolvedValue([{ code: "600519" }]);
    await expect(market.searchStocks("maotai")).resolves.toEqual([{ code: "600519" }]);
    expect(invokeMock).toHaveBeenCalledWith("search_stocks", { keyword: "maotai" });

    invokeMock.mockRejectedValue(new Error("x"));
    await expect(market.searchStocks("maotai")).resolves.toEqual([]);
  });

  it("fetchIndexQuotes passes through and swallows errors", async () => {
    invokeMock.mockResolvedValue([{ code: "000001" }]);
    await expect(market.fetchIndexQuotes()).resolves.toEqual([{ code: "000001" }]);
    expect(invokeMock).toHaveBeenCalledWith("get_index_quotes");

    invokeMock.mockRejectedValue(new Error("x"));
    await expect(market.fetchIndexQuotes()).resolves.toEqual([]);
  });
});

// 透传型封装：成功返回 invoke 结果，失败直接抛出（供上层展示）
const passThroughCases: {
  name: string;
  fn: () => Promise<unknown>;
  command: string;
  args: Record<string, unknown>;
}[] = [
  { name: "fetchMinute", fn: () => market.fetchMinute("600519"), command: "get_minute", args: { code: "600519" } },
  { name: "fetchHistMinute", fn: () => market.fetchHistMinute("600519", "20260101"), command: "get_hist_minute", args: { code: "600519", date: "20260101" } },
  { name: "fetchHistMinuteDays", fn: () => market.fetchHistMinuteDays("600519", 5), command: "get_hist_minute_days", args: { code: "600519", days: 5 } },
  { name: "fetchOrderBook", fn: () => market.fetchOrderBook("600519"), command: "get_orderbook", args: { code: "600519" } },
  { name: "fetchRankPage defaults", fn: () => market.fetchRankPage("gainers", 1), command: "get_rank_page", args: { sort: "gainers", page: 1, num: 50 } },
  { name: "fetchSectors", fn: () => market.fetchSectors("concept"), command: "get_sectors", args: { kind: "concept" } },
  { name: "fetchNewsFlash defaults", fn: () => market.fetchNewsFlash(1), command: "get_news_flash", args: { page: 1, size: 30 } },
  { name: "fetchScreener", fn: () => market.fetchScreener({ maBull: true, macdGolden: false, volumeUp: false, breakout: false, aboveMa20: false, kdjGolden: false, rsiOversold: false, bollBreak: false, limit: 50 }), command: "get_screener", args: { filter: expect.objectContaining({ maBull: true }) } },
  { name: "startSpider", fn: () => market.startSpider(["600519"]), command: "start_spider", args: { watch: ["600519"] } },
  { name: "stopSpider", fn: () => market.stopSpider(), command: "stop_spider", args: NO_ARGS },
  { name: "fetchLatest", fn: () => market.fetchLatest(), command: "check_latest", args: NO_ARGS },
  { name: "startRadar", fn: () => market.startRadar(), command: "start_radar", args: NO_ARGS },
  { name: "stopRadar", fn: () => market.stopRadar(), command: "stop_radar", args: NO_ARGS },
  { name: "startAlertEngine", fn: () => market.startAlertEngine([]), command: "start_alert_engine", args: { rules: [] } },
  { name: "stopAlertEngine", fn: () => market.stopAlertEngine(), command: "stop_alert_engine", args: NO_ARGS },
  { name: "fetchF10Profile", fn: () => market.fetchF10Profile("600519"), command: "get_f10_profile", args: { code: "600519" } },
  { name: "fetchF10Finance", fn: () => market.fetchF10Finance("600519"), command: "get_f10_finance", args: { code: "600519" } },
  { name: "fetchF10Chips", fn: () => market.fetchF10Chips("600519"), command: "get_f10_chips", args: { code: "600519" } },
  { name: "fetchIpoList", fn: () => market.fetchIpoList(), command: "get_ipo_list", args: NO_ARGS },
  { name: "fetchRestrictedQueue", fn: () => market.fetchRestrictedQueue("600519"), command: "get_restricted_queue", args: { code: "600519" } },
  { name: "fetchMarketRestricted defaults", fn: () => market.fetchMarketRestricted("2026-01-01", "2026-02-01", 1), command: "get_market_restricted", args: { start: "2026-01-01", end: "2026-02-01", page: 1, size: 50 } },
  { name: "fetchAuction", fn: () => market.fetchAuction(), command: "get_auction", args: NO_ARGS },
  { name: "fetchZtPool default", fn: () => market.fetchZtPool(), command: "get_zt_pool", args: { date: "" } },
  { name: "fetchZbPool default", fn: () => market.fetchZbPool(), command: "get_zb_pool", args: { date: "" } },
  { name: "fetchLhbList default", fn: () => market.fetchLhbList(), command: "get_lhb_list", args: { date: "" } },
  { name: "fetchLhbDetail default", fn: () => market.fetchLhbDetail("600519"), command: "get_lhb_detail", args: { code: "600519", date: "" } },
  { name: "fetchSeatBack", fn: () => market.fetchSeatBack("600519"), command: "get_seat_back", args: { code: "600519" } },
  { name: "fetchSeatTrades defaults", fn: () => market.fetchSeatTrades("600519"), command: "get_seat_trades", args: { code: "600519", size: 50, page: 1 } },
];

describe("pass-through market wrappers", () => {
  for (const c of passThroughCases) {
    it(c.name, async () => {
      await expect(c.fn()).resolves.toBe("ok");
      if (c.args === NO_ARGS) {
        expect(invokeMock).toHaveBeenCalledWith(c.command);
      } else {
        expect(invokeMock).toHaveBeenCalledWith(c.command, c.args);
      }
    });
  }

  it("propagates invoke errors (no swallowing)", async () => {
    const err = new Error("tauri down");
    invokeMock.mockRejectedValue(err);
    await expect(market.fetchMinute("600519")).rejects.toBe(err);
  });
});
