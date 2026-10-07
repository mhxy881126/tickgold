// 左侧菜单分组管理：groups 状态 + meta(dock_groups_v1) 持久化。
// 模块级单例（同 useSkins 模式）：所有消费方（SideDock / App 顶部导航 / 命令面板 / 欢迎页）
// 共享同一份用户分组配置。
import { ref } from "vue";
import { ensureDb, db } from "../db/database";
import {
  DOCK_STORE_KEY,
  mergeDockGroups,
  serializeDockGroups,
  genGroupIcon,
  factoryItemOf,
  homeGroupNameOf,
  type DockGroupsStore,
} from "../lib/dock-groups";
import type { DockGroup, DockItem } from "../lib/dock";

const groups = ref<DockGroup[]>([]);
let loaded = false;
let loadedPromise: Promise<void> | null = null;

async function getMeta(key: string): Promise<string | null> {
  const rows = await db().select<{ value: string }[]>("SELECT value FROM meta WHERE key=?", [key]);
  return rows[0]?.value ?? null;
}
function setMeta(key: string, value: string) {
  db()
    .execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [key, value])
    .catch(() => {});
}

/** 启动加载：读取用户配置并合并出厂分组（幂等） */
export function useDockGroups() {
  // 同步初始化为出厂分组，避免首帧空白；load 完成后无缝替换为用户配置
  if (groups.value.length === 0) groups.value = mergeDockGroups(null);
  if (!loaded) {
    loaded = true;
    loadedPromise = (async () => {
      await ensureDb();
      try {
        const raw = await getMeta(DOCK_STORE_KEY);
        let store: DockGroupsStore | null = null;
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as DockGroupsStore;
            if (parsed && Array.isArray(parsed.groups)) store = parsed;
          } catch {
            /* 损坏配置：回退出厂 */
          }
        }
        groups.value = mergeDockGroups(store);
      } catch {
        groups.value = mergeDockGroups(null);
      }
    })();
  }

  async function persist() {
    try {
      await loadedPromise;
    } catch {
      /* ignore */
    }
    setMeta(DOCK_STORE_KEY, serializeDockGroups(groups.value));
  }

  /** 新增分组（重名/空名忽略，返回是否成功） */
  async function addGroup(name: string): Promise<boolean> {
    const n = (name ?? "").trim();
    if (!n || groups.value.some((g) => g.name === n)) return false;
    groups.value = [...groups.value, { name: n, icon: genGroupIcon(groups.value.length), items: [] }];
    await persist();
    return true;
  }

  /** 重命名分组（空名/重名忽略） */
  async function renameGroup(oldName: string, newName: string): Promise<boolean> {
    const n = (newName ?? "").trim();
    if (!n || groups.value.some((g) => g.name === n)) return false;
    groups.value = groups.value.map((g) => (g.name === oldName ? { ...g, name: n } : g));
    await persist();
    return true;
  }

  /**
   * 删除分组：组内功能移回其出厂分组（若仍存在），否则进入第一个分组。
   * 最后一个分组不允许删除。
   */
  async function removeGroup(name: string): Promise<boolean> {
    if (groups.value.length <= 1) return false;
    const target = groups.value.find((g) => g.name === name);
    if (!target) return false;
    const rest = groups.value.filter((g) => g.name !== name);
    for (const it of target.items) {
      const home = rest.find((g) => g.name === homeGroupNameOf(it.id));
      if (home) home.items.push(it);
      else rest[0]?.items.push(it);
    }
    groups.value = rest;
    await persist();
    return true;
  }

  /** 把功能移动到指定分组（目标不存在则忽略；已在目标组则仅从原组移除兜底） */
  async function moveItem(itemId: string, toGroup: string): Promise<boolean> {
    const target = groups.value.find((g) => g.name === toGroup);
    if (!target) return false;
    let moved = false;
    groups.value = groups.value.map((g) => {
      if (g.name === toGroup) {
        if (g.items.some((i) => i.id === itemId)) return g; // 已在目标组，不动
        const src: DockItem | undefined = findItemInGroups(itemId);
        if (src) { moved = true; return { ...g, items: [...g.items, src] }; }
        return g;
      }
      if (g.items.some((i) => i.id === itemId)) {
        moved = true;
        return { ...g, items: g.items.filter((i) => i.id !== itemId) };
      }
      return g;
    });
    if (!moved) return false;
    await persist();
    return true;
  }

  /** 在当前分组状态中查找功能项（含出厂兜底） */
  function findItemInGroups(id: string): DockItem | undefined {
    for (const g of groups.value) {
      const it = g.items.find((i) => i.id === id);
      if (it) return it;
    }
    return factoryItemOf(id);
  }

  return { groups, addGroup, renameGroup, removeGroup, moveItem, persist };
}
