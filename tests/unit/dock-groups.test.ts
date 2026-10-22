import { describe, expect, it } from "vitest";
import { CARD_META, type CardId } from "../../src/lib/cards";
import { DOCK_GROUPS } from "../../src/lib/dock";
import {
  mergeDockGroups,
  serializeDockGroups,
  genGroupIcon,
  factoryItemOf,
  homeGroupNameOf,
  type DockGroupsStore,
} from "../../src/lib/dock-groups";

/** 全部出厂功能 id（去重） */
function allFactoryIds(): string[] {
  const set = new Set<string>();
  for (const g of DOCK_GROUPS) for (const it of g.items) set.add(it.id);
  return [...set];
}

// ===== P2-b2：菜单重组为 5 个场景组（含 Pro 会员）=====
describe("DOCK_GROUPS 5 场景组", () => {
  const META_IDS = Object.keys(CARD_META) as CardId[];

  it("恰好 5 组，组名与顺序固定", () => {
    expect(DOCK_GROUPS).toHaveLength(5);
    expect(DOCK_GROUPS.map((g) => g.name)).toEqual([
      "行情·选股",
      "盯盘·复盘",
      "交易·执行",
      "工具·系统",
      "Pro 会员",
    ]);
  });

  it("每张 CardId 恰好出现一次（无丢失、无重复）", () => {
    const ids = DOCK_GROUPS.flatMap((g) => g.items.map((it) => it.id));
    // 与 CARD_META 的键集合完全一致：不多不少
    expect([...ids].sort()).toEqual([...META_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of META_IDS) {
      expect(ids.filter((x) => x === id)).toHaveLength(1);
    }
  });

  it("每个功能项 label / icon / desc 均非空", () => {
    for (const g of DOCK_GROUPS) {
      expect(g.name.trim()).not.toBe("");
      expect(g.icon.trim()).not.toBe("");
      expect(g.items.length).toBeGreaterThan(0);
      for (const it of g.items) {
        expect(it.label.trim(), `${it.id} label`).not.toBe("");
        expect(it.icon.trim(), `${it.id} icon`).not.toBe("");
        expect(it.desc.trim(), `${it.id} desc`).not.toBe("");
      }
    }
  });
});

describe("mergeDockGroups", () => {
  it("无用户配置时返回完整出厂分组", () => {
    const groups = mergeDockGroups(null);
    expect(groups.map((g) => g.name)).toEqual(DOCK_GROUPS.map((g) => g.name));
    // 每个出厂分组项都在
    for (const fg of DOCK_GROUPS) {
      const g = groups.find((x) => x.name === fg.name)!;
      expect(g.items.map((i) => i.id)).toEqual(fg.items.map((i) => i.id));
    }
  });

  it("每个出厂功能恰好出现在一个分组（完整性）", () => {
    const groups = mergeDockGroups(null);
    const ids = new Set<string>();
    for (const g of groups) for (const it of g.items) ids.add(it.id);
    expect([...ids].sort()).toEqual(allFactoryIds().sort());
  });

  it("用户新增分组：保留出厂 + 追加新组，功能完整", () => {
    const store: DockGroupsStore = {
      v: 2,
      groups: [...DOCK_GROUPS.map((g) => ({ name: g.name, items: g.items.map((i) => i.id) }))],
    };
    store.groups.push({ name: "自用", items: [] });
    const groups = mergeDockGroups(store);
    expect(groups.map((g) => g.name)).toContain("自用");
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    expect(total).toBe(allFactoryIds().length);
  });

  it("用户移动功能到另一分组：原组移除、目标组新增", () => {
    const watch = DOCK_GROUPS.find((g) => g.items.some((i) => i.id === "watch"))!;
    const trade = DOCK_GROUPS.find((g) => g.name !== watch.name)!;
    const store: DockGroupsStore = {
      v: 2,
      groups: DOCK_GROUPS.map((g) => ({ name: g.name, items: g.items.map((i) => i.id) })),
    };
    // 把 watch 从出厂组移到 trade 组
    const src = store.groups.find((g) => g.items.includes("watch"))!;
    src.items = src.items.filter((i) => i !== "watch");
    store.groups.find((g) => g.name === trade.name)!.items.push("watch");

    const groups = mergeDockGroups(store);
    expect(groups.find((g) => g.name === trade.name)!.items.map((i) => i.id)).toContain("watch");
    const inSrc = groups.find((g) => g.name === src.name)!;
    expect(inSrc.items.map((i) => i.id)).not.toContain("watch");
  });

  it("用户删除出厂分组：其功能回到出厂分组，否则进第一个分组", () => {
    const removed = DOCK_GROUPS[0]!;
    const store: DockGroupsStore = {
      v: 2,
      groups: DOCK_GROUPS.filter((g) => g.name !== removed.name)
        .map((g) => ({ name: g.name, items: g.items.map((i) => i.id) })),
    };
    const groups = mergeDockGroups(store);
    expect(groups.map((g) => g.name)).not.toContain(removed.name);
    // 完整性不丢失
    const ids = new Set<string>();
    for (const g of groups) for (const it of g.items) ids.add(it.id);
    expect([...ids].sort()).toEqual(allFactoryIds().sort());
  });

  it("新版本新增的出厂功能自动补入出厂分组", () => {
    // 模拟旧配置缺少某新功能（如不存在于任何用户组）
    const store: DockGroupsStore = {
      v: 2,
      groups: DOCK_GROUPS.map((g) => ({
        name: g.name,
        items: g.items.filter((i) => i.id !== "chart").map((i) => i.id),
      })),
    };
    const groups = mergeDockGroups(store);
    const ids = new Set<string>();
    for (const g of groups) for (const it of g.items) ids.add(it.id);
    expect(ids.has("chart")).toBe(true);
  });

  it("序列化往返幂等（v2）", () => {
    const groups = mergeDockGroups(null);
    const store = JSON.parse(serializeDockGroups(groups)) as DockGroupsStore;
    expect(store.v).toBe(2);
    const again = mergeDockGroups(store);
    expect(again.map((g) => g.name)).toEqual(groups.map((g) => g.name));
    for (const g of again) {
      const orig = groups.find((x) => x.name === g.name)!;
      expect(g.items.map((i) => i.id)).toEqual(orig.items.map((i) => i.id));
    }
  });
});

// ===== P2-b2：旧 6 组配置迁移到 4 场景组 =====
describe("P2-b2 v1 配置迁移", () => {
  const META_IDS = Object.keys(CARD_META) as CardId[];
  const LEGACY_GROUPS = ["大盘总览", "盯盘模式", "情绪异动", "板块题材", "个股行情", "交易工具"];

  it("v1 旧 6 组 + 自定义组：旧组丢弃、自定义保留，4 新组重新归位", () => {
    // 46 张卡分散在旧 6 组，watch 放在自定义组「我的」里。
    const pool = META_IDS.filter((id) => id !== "watch");
    const per = Math.ceil(pool.length / LEGACY_GROUPS.length);
    const groups: { name: string; items: string[] }[] = LEGACY_GROUPS.map((name, i) => ({
      name,
      items: pool.slice(i * per, (i + 1) * per),
    }));
    groups.push({ name: "我的", items: ["watch"] });
    const store: DockGroupsStore = { v: 1, groups };

    const merged = mergeDockGroups(store);
    expect(merged.map((g) => g.name)).toEqual([
      "行情·选股",
      "盯盘·复盘",
      "交易·执行",
      "工具·系统",
      "Pro 会员",
      "我的",
    ]);
    // 每张卡恰好一次
    const ids = merged.flatMap((g) => g.items.map((i) => i.id));
    expect([...ids].sort()).toEqual([...META_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
    // 自定义组归属保持不变
    expect(merged.find((g) => g.name === "我的")!.items.map((i) => i.id)).toEqual(["watch"]);
  });

  it("v2 配置：自定义组保持原顺序/归属，不做迁移", () => {
    const base = mergeDockGroups(null);
    const customItems = ["watch", "rank"];
    const groups = [
      { name: "我的", items: customItems },
      ...base.map((g) => ({
        name: g.name,
        items: g.items.map((i) => i.id).filter((id) => !customItems.includes(id)),
      })),
    ];
    const store: DockGroupsStore = { v: 2, groups };

    const merged = mergeDockGroups(store);
    // 顺序完全按 store：自定义组仍在最前，不被迁移逻辑前置/重排
    expect(merged.map((g) => g.name)).toEqual(["我的", ...base.map((g) => g.name)]);
    expect(merged[0]!.items.map((i) => i.id)).toEqual(customItems);
    const ids = merged.flatMap((g) => g.items.map((i) => i.id));
    expect([...ids].sort()).toEqual([...META_IDS].sort());
  });
});

describe("dock-groups 辅助函数", () => {
  it("factoryItemOf 返回出厂定义", () => {
    const it = factoryItemOf("rank");
    expect(it?.id).toBe("rank");
    expect(it?.label).toBeTruthy();
    expect(factoryItemOf("no-such-id")).toBeUndefined();
  });

  it("homeGroupNameOf 返回出厂分组", () => {
    const g = DOCK_GROUPS.find((x) => x.items.some((i) => i.id === "rank"))!;
    expect(homeGroupNameOf("rank")).toBe(g.name);
    expect(homeGroupNameOf("no-such-id")).toBeUndefined();
  });

  it("genGroupIcon 按序号稳定轮换", () => {
    expect(genGroupIcon(0)).toBe(genGroupIcon(0));
    expect(genGroupIcon(0)).not.toBe(genGroupIcon(1));
  });
});
