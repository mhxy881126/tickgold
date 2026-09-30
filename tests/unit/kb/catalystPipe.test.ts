import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock = vi.hoisted(() => ({ select: vi.fn(), execute: vi.fn() }));
vi.mock("../../../src/db/database", () => ({
  db: () => dbMock,
  ensureDb: vi.fn(async () => dbMock),
}));

import {
  announceToDraft,
  classifyAnnounce,
  irmToDraft,
  ingestCatalysts,
} from "../../../src/kb/catalystPipe";
import type { Db } from "../../../src/kb/repo";
import type { AnnounceItem, IrmItem } from "../../../src/api/kb";

const d = dbMock as unknown as Db;

beforeEach(() => {
  vi.resetAllMocks();
  dbMock.execute.mockResolvedValue({ rowsAffected: 1 });
});

describe("classifyAnnounce", () => {
  it("maps keywords to kind and direction", () => {
    expect(classifyAnnounce("关于签订重大合同的公告")).toMatchObject({ kind: "order", direction: "利好" });
    expect(classifyAnnounce("2026年第三季度业绩预告大增")).toMatchObject({ kind: "earnings", direction: "利好" });
    expect(classifyAnnounce("关于持股5%以上股东减持计划")).toMatchObject({ kind: "company", direction: "利空" });
    expect(classifyAnnounce("召开2026年第二次临时股东会")).toMatchObject({ kind: "company", direction: "中性" });
  });
});

describe("mappers", () => {
  it("converts announcement to draft", () => {
    const a: AnnounceItem = { id: "1", code: "300001", name: "X", title: "签订重大合同", time: 178e11, url: "u", category: "合同" };
    const draft = announceToDraft(a);
    expect(draft).toMatchObject({ kind: "order", code: "300001", source: "cninfo", sourceUrl: "u" });
  });

  it("converts irm item to a company-event draft", () => {
    const i: IrmItem = { platform: "sse", code: "600001", name: "X", question: "订单？", answer: "有", time: 1, url: "u2" };
    const draft = irmToDraft(i);
    expect(draft).toMatchObject({ kind: "company", code: "600001", source: "sse", summary: "Q:订单？ A:有" });
  });
});

describe("ingestCatalysts", () => {
  it("inserts unique drafts and reports counts", async () => {
    const drafts = [
      { kind: "order" as const, title: "t1", summary: "", source: "cninfo", sourceUrl: "u1", publishedAt: 1, direction: "利好" as const, code: "300001" },
      { kind: "event" as const, title: "t2", summary: "", source: "sse", sourceUrl: "u2", publishedAt: 1, direction: "中性" as const, code: "600001" },
    ];
    const r = await ingestCatalysts(d, drafts, 100);
    expect(r.inserted).toBe(2);
    // 每次插入一条
    expect(dbMock.execute).toHaveBeenCalledTimes(2);
  });

  it("skips duplicates (hash conflict → rowsAffected 0)", async () => {
    dbMock.execute.mockResolvedValueOnce({ rowsAffected: 0 });
    const draft = { kind: "event" as const, title: "t", summary: "", source: "x", sourceUrl: "u", publishedAt: 1, direction: "中性" as const, code: null };
    expect((await ingestCatalysts(d, [draft], 100)).inserted).toBe(0);
  });
});
