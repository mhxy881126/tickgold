import { describe, expect, it } from "vitest";
import type { SnapshotCard } from "../../src/lib/cards";
import { buildItems } from "../../src/lib/widget-presets";
import {
  migrateCard,
  migrateSnapshot,
} from "../../src/lib/widget-migrate";

function legacy(id: SnapshotCard["id"], extra: Partial<SnapshotCard> = {}): SnapshotCard {
  return { id, zone: "main", ...extra };
}

describe("legacy → v1 自动迁移", () => {
  it("v1 快照往返保留 cu/rect", () => {
    // 无内置出厂模板（watch/rank/news 已全部移除），直接构造 v1 快照验证自定义字段保留
    const cu = { color: "#123456", tag: "测", locked: true };
    const rect = { x: 100, y: 50, w: 320, h: 240 };
    const r = migrateCard(
      legacy("watch", { v: 1, widgets: { items: buildItems(["text-note"]) }, cu, rect })
    );
    expect(r.changed).toBe(false);
    expect(r.card.cu).toBe(cu);
    expect(r.card.rect).toBe(rect);
  });

  it("老版出厂微件化的 K线卡（报价头+盘口+分时缩略图）还原为经典组件", () => {
    // orderbook-mini 已移出注册表，直接构造原始快照实例以模拟历史出厂布局
    const legacyItems = ["quote-head", "orderbook-mini", "minute-chart"].map((def) => ({
      id: `${def}_x`, def, w: 4, h: 3, x: 0, y: 0,
    }));
    const cards: SnapshotCard[] = [
      {
        ...legacy("chart"),
        v: 1,
        widgets: { primary: null, items: legacyItems },
      },
    ];
    const r = migrateSnapshot(cards);
    expect(r.changed).toBe(true);
    expect(r.cards[0]!.v).toBeUndefined();
    expect(r.cards[0]!.widgets).toBeUndefined();
    // 还原后再次迁移幂等（保持经典）
    expect(migrateSnapshot(r.cards).changed).toBe(false);
  });

  it("用户自行编排过的 K线卡（非出厂三件套）不被还原", () => {
    const items = buildItems(["quote-head", "kline-mini"]);
    const cards: SnapshotCard[] = [
      { ...legacy("chart"), v: 1, widgets: { primary: null, items } },
    ];
    const r = migrateSnapshot(cards);
    expect(r.cards[0]!.widgets!.items.map((i) => i.def)).toEqual(["quote-head", "kline-mini"]);
  });

  it("无模板的老卡保持 legacy，不加 v", () => {
    const r = migrateCard(legacy("auction"));
    expect(r.changed).toBe(false);
    expect(r.card.v).toBeUndefined();
    expect(r.card.widgets).toBeUndefined();
  });

  it("整份快照迁移后再次迁移幂等", () => {
    // 无内置出厂模板（watch/rank/news 曾微件化，已全部移除并还原），legacy 卡全部保持经典
    const cards = [
      legacy("watch"),
      legacy("rank"),
      legacy("news"),
      legacy("heatmatrix"),
    ];
    const once = migrateSnapshot(cards);
    expect(once.changed).toBe(false);
    expect(once.cards.filter((c) => c.v === 1)).toHaveLength(0);
    expect(once.cards).toEqual(cards);

    const twice = migrateSnapshot(once.cards);
    expect(twice.changed).toBe(false);
    expect(twice.cards).toEqual(once.cards);
  });

  it("老版出厂微件化的榜单卡（quote-list 自选列表）还原为经典 RankBoard", () => {
    const cards: SnapshotCard[] = [
      {
        ...legacy("rank"),
        v: 1,
        widgets: {
          primary: null,
          items: [{ id: "ql_x", def: "quote-list", w: 12, h: 7, x: 0, y: 0 }],
        },
      },
    ];
    const r = migrateSnapshot(cards);
    expect(r.changed).toBe(true);
    expect(r.cards[0]!.v).toBeUndefined();
    expect(r.cards[0]!.widgets).toBeUndefined();
    // 还原后再次迁移幂等（保持经典）
    expect(migrateSnapshot(r.cards).changed).toBe(false);
  });

  it("老版出厂微件化的自选卡（quote-list 自选列表）还原为经典 WatchList（分组管理）", () => {
    const cards: SnapshotCard[] = [
      {
        ...legacy("watch"),
        v: 1,
        widgets: {
          primary: null,
          items: [{ id: "ql_x", def: "quote-list", w: 12, h: 7, x: 0, y: 0 }],
        },
      },
    ];
    const r = migrateSnapshot(cards);
    expect(r.changed).toBe(true);
    expect(r.cards[0]!.v).toBeUndefined();
    expect(r.cards[0]!.widgets).toBeUndefined();
    expect(migrateSnapshot(r.cards).changed).toBe(false);
  });

  it("老版出厂微件化的快讯卡（news-tape 滚动快讯）还原为经典 NewsFlash（分页/开窗）", () => {
    const cards: SnapshotCard[] = [
      {
        ...legacy("news"),
        v: 1,
        widgets: {
          primary: null,
          items: [{ id: "nt_x", def: "news-tape", w: 12, h: 6, x: 0, y: 0 }],
        },
      },
    ];
    const r = migrateSnapshot(cards);
    expect(r.changed).toBe(true);
    expect(r.cards[0]!.v).toBeUndefined();
    expect(r.cards[0]!.widgets).toBeUndefined();
    expect(migrateSnapshot(r.cards).changed).toBe(false);
  });

  it("用户自行编排过的榜单卡（改过绑定）不被还原", () => {
    const cards: SnapshotCard[] = [
      {
        ...legacy("rank"),
        v: 1,
        widgets: {
          primary: null,
          items: [{ id: "ql_x", def: "quote-list", w: 12, h: 7, x: 0, y: 0, bind: "600519" }],
        },
      },
    ];
    const r = migrateSnapshot(cards);
    expect(r.cards[0]!.widgets!.items.map((i) => i.def)).toEqual(["quote-list"]);
  });

  it("用户自行编排过的榜单卡（多个微件）不被还原", () => {
    const items = buildItems(["quote-list", "kline-mini"]);
    const cards: SnapshotCard[] = [
      { ...legacy("rank"), v: 1, widgets: { primary: null, items } },
    ];
    const r = migrateSnapshot(cards);
    expect(r.cards[0]!.widgets!.items.map((i) => i.def)).toEqual(["quote-list", "kline-mini"]);
  });

  it("用户自行编排过的自选卡（改过尺寸）不被还原", () => {
    const cards: SnapshotCard[] = [
      {
        ...legacy("watch"),
        v: 1,
        widgets: {
          primary: null,
          items: [{ id: "ql_x", def: "quote-list", w: 6, h: 6, x: 0, y: 0 }],
        },
      },
    ];
    const r = migrateSnapshot(cards);
    expect(r.cards[0]!.widgets!.items.map((i) => i.def)).toEqual(["quote-list"]);
  });

  it("用户自行编排过的快讯卡（多个微件）不被还原", () => {
    const items = buildItems(["news-tape", "text-note"]);
    const cards: SnapshotCard[] = [
      { ...legacy("news"), v: 1, widgets: { primary: null, items } },
    ];
    const r = migrateSnapshot(cards);
    expect(r.cards[0]!.widgets!.items.map((i) => i.def)).toEqual(["news-tape", "text-note"]);
  });
});

describe("v1 快照清洗与往返稳定", () => {
  it("未知 def 被丢弃，其余实例保留原 id", () => {
    const good = buildItems(["text-note"])[0]!;
    const cards: SnapshotCard[] = [
      {
        ...legacy("news"),
        v: 1,
        widgets: {
          primary: null,
          items: [
            { id: "keep", def: "text-note", w: 4, h: 2, x: 9, y: 9 },
            { id: "gone", def: "no-such-def", w: 4, h: 2, x: 0, y: 0 },
          ],
        },
      },
    ];
    const r = migrateSnapshot(cards);
    expect(r.changed).toBe(true);
    const w = r.cards[0]!.widgets!;
    expect(w.items.map((i) => i.id)).toEqual(["keep"]);
    // 清洗后重新装箱：x/y 归零
    expect(w.items[0]!.x).toBe(0);
    expect(w.items[0]!.y).toBe(0);
  });

  it("尺寸小于 def 最小跨度时被抬升", () => {
    const cards: SnapshotCard[] = [
      {
        ...legacy("watch"),
        v: 1,
        widgets: {
          items: [{ id: "x", def: "quote-list", w: 1, h: 1, x: 0, y: 0 }],
        },
      },
    ];
    const w = migrateSnapshot(cards).cards[0]!.widgets!;
    expect(w.items[0]!.w).toBeGreaterThanOrEqual(4);
    expect(w.items[0]!.h).toBeGreaterThanOrEqual(4);
  });

  it("primary/bind/text 字段往返保留", () => {
    const items = buildItems(["quote-head"]);
    items[0]!.bind = "600519";
    const cards: SnapshotCard[] = [
      { ...legacy("chart"), v: 1, widgets: { primary: "000001", items } },
    ];
    const once = migrateSnapshot(cards);
    expect(once.cards[0]!.widgets!.primary).toBe("000001");
    expect(once.cards[0]!.widgets!.items[0]!.bind).toBe("600519");
    // 二次迁移不再变化
    expect(migrateSnapshot(once.cards).changed).toBe(false);
  });

  it("v1 widgets 全无效时：无内置 preset，一律剥除字段", () => {
    const bad: SnapshotCard[] = [
      {
        ...legacy("news"),
        v: 1,
        widgets: { items: [{ id: "g", def: "nope", w: 1, h: 1, x: 0, y: 0 }] },
      },
      {
        ...legacy("auction"),
        v: 1,
        widgets: { items: [{ id: "g2", def: "nope", w: 1, h: 1, x: 0, y: 0 }] },
      },
    ];
    const r = migrateSnapshot(bad);
    expect(r.changed).toBe(true);
    expect(r.cards[0]!.v).toBeUndefined();
    expect(r.cards[0]!.widgets).toBeUndefined();
    expect(r.cards[1]!.v).toBeUndefined();
    expect(r.cards[1]!.widgets).toBeUndefined();
  });
});
