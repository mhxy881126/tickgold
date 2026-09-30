import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { select: vi.fn(), execute: vi.fn() },
  ztPool: vi.fn(),
  themeTags: vi.fn(),
}));
vi.mock("../../../src/db/database", () => ({
  db: () => mocks.db,
  ensureDb: vi.fn(async () => mocks.db),
}));
vi.mock("../../../src/api/market", () => ({
  fetchZtPool: (d: string) => mocks.ztPool(d),
}));
vi.mock("../../../src/api/kb", () => ({
  // 仅提供 f127/f128 个股标签链路（旧 get_sector_stocks 已删除）
  fetchStockThemeTags: (codes: string[]) => mocks.themeTags(codes),
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

/** 默认标签：行业「设备」；600001 无概念，其余带「机器人」。 */
function defaultTags(codes: string[]) {
  return Promise.resolve(
    codes.map((code) => ({
      code,
      industry: "设备",
      concepts: code === "600001" ? [] : ["机器人"],
    }))
  );
}

function limitBinds() {
  return mocks.db.execute.mock.calls
    .filter((c) => c[0].includes("INSERT INTO limit_up_record"))
    .map((c) => c[1] as unknown[]);
}

function containsLink(rows: unknown[], target: unknown[]): boolean {
  return rows.some((b) => JSON.stringify(b) === JSON.stringify(target));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.execute.mockResolvedValue({ lastInsertId: 1, rowsAffected: 1 });
  mocks.db.select.mockResolvedValue([]);
  mocks.themeTags.mockImplementation(defaultTags);
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
  it("persists limit-up records with per-stock tags, one 机器人 theme, roles and left_date sweep", async () => {
    mocks.ztPool.mockResolvedValue({
      date: "20260930", total: 3,
      list: [
        ztStock({ code: "300001", boards: 3, name: "一" }),
        ztStock({ code: "300002", boards: 2, name: "二" }),
        ztStock({ code: "300003", boards: 1, name: "三" }),
      ],
    });

    const r = await runAttributionJob(d, "2026-09-30", "20260930");
    // 标签给出的「机器人」全覆盖 3 只；行业「设备」被镜像剔除 → 只剩 1 个题材
    expect(r).toMatchObject({ limitUp: 3, themes: 1, stocks: 3, linked: 0 });

    // 标签按全部涨停股一次性请求
    expect(mocks.themeTags).toHaveBeenCalledWith(["300001", "300002", "300003"]);

    // 涨停定格：概念串来自 f128，行业优先取 f127
    const binds = limitBinds();
    expect(binds).toHaveLength(3);
    const byCode = Object.fromEntries(binds.map((b) => [b[1], b]));
    expect(byCode["300001"][9]).toBe("设备");
    expect(byCode["300001"][10]).toBe("机器人");

    // 龙一归属最高分股
    const roleBinds = mocks.db.execute.mock.calls
      .filter((c) => c[0].includes("INSERT INTO theme_stock"))
      .map((c) => c[1] as unknown[]);
    expect(roleBinds).toHaveLength(3);
    const leader = roleBinds.find((b) => b[1] === "300001")!;
    expect(leader[3]).toBe("龙一");

    // M6：每个聚类角色写入后按今日成分扫 left_date
    const leftCall = mocks.db.execute.mock.calls.find((c) => c[0].includes("SET left_date="));
    expect(leftCall).toBeTruthy();
    expect(leftCall![1]).toEqual(["2026-09-30", 1, "300001", "300002", "300003"]);
  });

  it("persists an empty concepts string when the stock has no f128 tags", async () => {
    mocks.ztPool.mockResolvedValue({
      date: "20260930", total: 1,
      list: [ztStock({ code: "600001", boards: 1, name: "无概念" })],
    });

    const r = await runAttributionJob(d, "2026-09-30", "20260930");
    expect(mocks.themeTags).toHaveBeenCalledWith(["600001"]);
    expect(r.themes).toBe(0); // 单只涨停既不够概念 2 只，也不够行业 3 只
    const binds = limitBinds();
    expect(binds).toHaveLength(1);
    expect(binds[0][10]).toBe("");
  });

  it("degrades to industry-only clustering when tag fetch fails", async () => {
    mocks.ztPool.mockResolvedValue({
      date: "20260930", total: 3,
      list: [
        ztStock({ code: "300001", boards: 3 }),
        ztStock({ code: "300002", boards: 2 }),
        ztStock({ code: "300003", boards: 1 }),
      ],
    });
    mocks.themeTags.mockRejectedValueOnce(new Error("net down"));

    const r = await runAttributionJob(d, "2026-09-30", "20260930");
    expect(r).toMatchObject({ themes: 1, limitUp: 3 });
    // 标签全缺：概念列空，行业路径用涨停池自带行业兜底聚类
    for (const b of limitBinds()) expect(b[10]).toBe("");
  });

  it("links unlinked catalysts by theme membership or by title match (I3)", async () => {
    mocks.ztPool.mockResolvedValue({
      date: "20260930", total: 3,
      list: [
        ztStock({ code: "300001", boards: 3 }),
        ztStock({ code: "300002", boards: 2 }),
        ztStock({ code: "300003", boards: 1 }),
      ],
    });
    const now = Date.now();
    const cat = (id: number, code: string | null, title: string) => ({
      id, kind: "company", title, summary: "", source: "cninfo", source_url: "",
      published_at: now - 1000, direction: "中性", theme_id: null, code,
      fresh_score: 1, content_hash: `h${id}`, collected_at: now,
    });
    mocks.db.select.mockImplementation((sql: string) => {
      if (sql.includes("FROM theme WHERE name")) return Promise.resolve([]);
      if (sql.includes("FROM theme_stock")) {
        return Promise.resolve([
          { id: 11, theme_id: 1, code: "300001", name: "一", role: "龙一", role_score: 9, joined_date: "2026-09-30", left_date: null },
        ]);
      }
      if (sql.includes("FROM catalyst")) {
        return Promise.resolve([
          cat(9, "300001", "某公司中标日常订单"),   // (a) 成分股命中
          cat(10, "600999", "机器人产业政策出台"),  // (b) 标题命中题材名
          cat(11, "600888", "一条无关公告"),        // 均不命中
        ]);
      }
      if (sql.includes("FROM theme ORDER BY")) {
        return Promise.resolve([
          { id: 1, name: "机器人", aliases: "", level: "主线", stage: "发酵", intro: "", logic: "", logic_version: 1, first_seen_date: "2026-09-30", last_active_date: "2026-09-30", created_at: 1, updated_at: 2 },
        ]);
      }
      return Promise.resolve([]);
    });

    const r = await runAttributionJob(d, "2026-09-30", "20260930");
    expect(r.linked).toBe(2);

    const linkBinds = mocks.db.execute.mock.calls
      .filter((c) => c[0].startsWith("UPDATE catalyst SET theme_id="))
      .map((c) => c[1]);
    expect(containsLink(linkBinds, [1, "300001", 9])).toBe(true);
    expect(containsLink(linkBinds, [1, "600999", 10])).toBe(true);
    expect(containsLink(linkBinds, [1, "600888", 11])).toBe(false);
  });

  it("throws when the limit pool is empty (no data yet) and never fetches tags", async () => {
    mocks.ztPool.mockResolvedValue({ date: "20260930", total: 0, list: [] });
    await expect(runAttributionJob(d, "2026-09-30", "20260930")).rejects.toThrow("涨停池为空");
    expect(mocks.themeTags).not.toHaveBeenCalled();
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
