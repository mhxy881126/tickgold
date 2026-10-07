// 菜单分组管理的纯函数层（无副作用，便于单元测试）。
// 数据模型：左侧 Dock 分组（DockGroup）可被用户自定义——
//   - 新增分组 / 重命名 / 删除分组
//   - 把功能项（DockItem）移动到任意分组
// 持久化只存最小结构：分组名（含顺序）+ 每组功能 id 列表，其余字段从出厂
// DOCK_GROUPS 解析，避免重复存储与漂移。
import { DOCK_GROUPS, type DockGroup, type DockItem } from "./dock";
import type { CardId } from "./cards";

/** 用户分组配置的持久化结构 */
export interface DockGroupConfig {
  name: string;
  items: string[]; // DockItem.id
}
export interface DockGroupsStore {
  v: 1;
  groups: DockGroupConfig[];
}

export const DOCK_STORE_KEY = "dock_groups_v1";

/** 新分组的预置图标池（几何图形 path，按分组序轮换） */
const ICON_POOL = [
  "M12 2l2.4 7.2H22l-6 4.6 2.3 7.2-6.3-4.5-6.3 4.5L8 13.8 2 9.2h7.6z",
  "M3 5h18v3H3zm0 6h18v3H3zm0 6h12v3H3z",
  "M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z",
  "M12 3l10 18H2z",
  "M4 4h16v16H4z",
  "M5 4h14l-9 8 9 8H5z",
  "M12 3a9 9 0 100 18 9 9 0 000-18zm1 4v5l4 2-1 1.7-5-2.6V7z",
  "M3 12h4l2-7 4 14 2-7h6",
];

/** 出厂分组名集合（供删除/重命名校验） */
const FACTORY_NAMES: string[] = DOCK_GROUPS.map((g) => g.name);

/** 出厂分组名集合（导出） */
export function factoryGroupNames(): string[] {
  return [...FACTORY_NAMES];
}

/** 出厂数据中某个功能的完整定义（label/icon/desc），未找到返回 undefined */
export function factoryItemOf(id: string): DockItem | undefined {
  for (const g of DOCK_GROUPS) {
    const it = g.items.find((i) => i.id === id);
    if (it) return { ...it };
  }
  return undefined;
}

/** 功能在出厂数据中所属的分组名（删除分组时功能回退目标） */
export function homeGroupNameOf(id: string): string | undefined {
  for (const g of DOCK_GROUPS) {
    if (g.items.some((i) => i.id === id)) return g.name;
  }
  return undefined;
}

/** 为新增分组生成一个稳定图标（按当前分组数轮换，避免与出厂重复偏好） */
export function genGroupIcon(groupCount: number): string {
  return ICON_POOL[groupCount % ICON_POOL.length]!;
}

interface FactoryMeta {
  label: string;
  icon: string;
  desc: string;
  groupName: string;
}

/**
 * 合并出厂分组与用户配置：
 * - 以出厂 DOCK_GROUPS 为底（图标/文案来自出厂），用户配置覆盖分组名顺序与功能归属；
 * - 用户删除的出厂分组，其功能回到该功能出厂分组（若该组还存在），否则进第一个分组；
 * - 新版本新增的出厂功能/分组自动补入，不因旧配置丢失。
 * 返回值保证：每个出厂功能恰好出现在一个分组中。
 */
export function mergeDockGroups(store: DockGroupsStore | null): DockGroup[] {
  // 出厂索引
  const factoryById = new Map<string, FactoryMeta>();
  const factoryIcon = new Map<string, string>(DOCK_GROUPS.map((g) => [g.name, g.icon]));
  for (const g of DOCK_GROUPS) {
    for (const it of g.items) {
      factoryById.set(it.id, { label: it.label, icon: it.icon, desc: it.desc, groupName: g.name });
    }
  }

  const out: DockGroup[] = [];
  const placed = new Set<string>();

  const pushItem = (target: DockGroup, id: string) => {
    const src = factoryById.get(id);
    if (!src || placed.has(id)) return;
    target.items.push({ id: id as CardId, label: src.label, icon: src.icon, desc: src.desc });
    placed.add(id);
  };

  // 1) 用户配置：按 store 顺序重建分组
  if (store && Array.isArray(store.groups) && store.groups.length > 0) {
    for (const cfg of store.groups) {
      const name = typeof cfg.name === "string" && cfg.name.trim() ? cfg.name.trim() : "";
      if (!name) continue;
      const seen = out.some((g) => g.name === name);
      if (seen) continue;
      const g: DockGroup = { name, icon: factoryIcon.get(name) ?? genGroupIcon(out.length), items: [] };
      for (const id of cfg.items ?? []) pushItem(g, id);
      out.push(g);
    }
  }

  // 2) 出厂兜底：未分配功能 → 回其出厂分组（分组存在时）
  for (const g of DOCK_GROUPS) {
    for (const it of g.items) {
      if (placed.has(it.id)) continue;
      const target = out.find((o) => o.name === g.name);
      if (target) pushItem(target, it.id);
    }
  }

  // 3) 出厂分组被删除：剩余未分配功能进第一个分组
  for (const g of DOCK_GROUPS) {
    for (const it of g.items) {
      if (placed.has(it.id)) continue;
      if (out.length) pushItem(out[0]!, it.id);
    }
  }

  // 4) 兜底：出厂分组全部被删（空 store 异常）时重建出厂
  if (out.length === 0) {
    return DOCK_GROUPS.map((g) => ({ ...g, items: [...g.items] }));
  }

  // 5) 空分组保留（用户自建的空分组应可见，用于后续移入功能）
  return out;
}

/** 序列化为持久化 JSON */
export function serializeDockGroups(groups: DockGroup[]): string {
  const store: DockGroupsStore = {
    v: 1,
    groups: groups.map((g) => ({ name: g.name, items: g.items.map((i) => i.id) })),
  };
  return JSON.stringify(store);
}
