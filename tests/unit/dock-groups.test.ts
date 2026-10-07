import { describe, expect, it } from "vitest";
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
      v: 1,
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
      v: 1,
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
      v: 1,
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
      v: 1,
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

  it("序列化往返幂等", () => {
    const groups = mergeDockGroups(null);
    const store = JSON.parse(serializeDockGroups(groups)) as DockGroupsStore;
    const again = mergeDockGroups(store);
    expect(again.map((g) => g.name)).toEqual(groups.map((g) => g.name));
    for (const g of again) {
      const orig = groups.find((x) => x.name === g.name)!;
      expect(g.items.map((i) => i.id)).toEqual(orig.items.map((i) => i.id));
    }
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
