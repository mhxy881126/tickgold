import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { ensureDb, db } from "../db/database";
import { emit } from "@tauri-apps/api/event";

/** 自选变更后通知所有窗口（灵动岛等）实时刷新 */
function watchChanged() {
  try {
    emit("watch:changed");
  } catch {
    /* 非 Tauri 环境忽略 */
  }
}
import type { Group, WatchStock } from "../api/types";

const GROUP_PREF_KEY = "sd_current_group";

/** 自选股 + 分组：SQLite 持久化 */
export const useWatchlistStore = defineStore("watchlist", () => {
  const groups = ref<Group[]>([]);
  const stocks = ref<WatchStock[]>([]);
  const loaded = ref(false);
  const currentGroupId = ref<number>(1);

  /** 全部股票代码（跨分组，供行情轮询/灵动岛使用） */
  const codes = computed(() =>
    [...stocks.value]
      .sort((a, b) => a.groupId - b.groupId || a.sortOrder - b.sortOrder)
      .map((s) => s.code)
  );

  /** 当前分组下的股票（按排序） */
  const currentStocks = computed(() =>
    stocks.value
      .filter((s) => s.groupId === currentGroupId.value)
      .sort((a, b) => a.sortOrder - b.sortOrder)
  );

  const currentGroup = computed(
    () => groups.value.find((g) => g.id === currentGroupId.value) ?? groups.value[0]
  );

  function stocksOf(groupId: number) {
    return stocks.value
      .filter((s) => s.groupId === groupId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  function nameOf(code: string): string {
    return stocks.value.find((s) => s.code === code)?.name ?? "";
  }

  /** 启动时加载全部分组与股票 */
  async function load() {
    await ensureDb();
    const gs = await db().select<{ id: number; name: string; sortOrder: number }[]>(
      "SELECT id, name, sort_order AS sortOrder FROM groups ORDER BY sort_order, id"
    );
    groups.value = gs;
    const ss = await db().select<
      { code: string; name: string; groupId: number; sortOrder: number }[]
    >(
      "SELECT code, name, group_id AS groupId, sort_order AS sortOrder FROM stocks ORDER BY group_id, sort_order, id"
    );
    stocks.value = ss;
    // 恢复上次选中的分组
    const saved = Number(localStorage.getItem(GROUP_PREF_KEY));
    if (saved && groups.value.some((g) => g.id === saved)) currentGroupId.value = saved;
    else currentGroupId.value = groups.value[0]?.id ?? 1;
    loaded.value = true;
  }

  function selectGroup(id: number) {
    currentGroupId.value = id;
    localStorage.setItem(GROUP_PREF_KEY, String(id));
  }

  /** 添加股票到指定分组（默认当前分组），已存在则不重复 */
  async function add(code: string, name = "", groupId?: number) {
    const c = code.trim();
    if (!c) return;
    const gid = groupId ?? currentGroupId.value;
    const existing = stocks.value.find((s) => s.code === c);
    if (existing) {
      // 已在自选：移动到目标分组
      await moveToGroup(c, gid);
      if (name && !existing.name) await ensureName(c, name);
      return;
    }
    const order = stocksOf(gid).length;
    await db().execute(
      "INSERT INTO stocks(code, name, group_id, sort_order, created_at) VALUES(?,?,?,?,?)",
      [c, name, gid, order, Date.now()]
    );
    stocks.value.push({ code: c, name, groupId: gid, sortOrder: order });
    watchChanged();
  }

  async function remove(code: string) {
    await db().execute("DELETE FROM stocks WHERE code=?", [code]);
    stocks.value = stocks.value.filter((s) => s.code !== code);
    watchChanged();
  }

  /** 行情返回后补全名称 */
  async function ensureName(code: string, name: string) {
    const s = stocks.value.find((x) => x.code === code);
    if (!s || s.name || !name) return;
    s.name = name;
    await db().execute("UPDATE stocks SET name=? WHERE code=?", [name, code]);
  }

  async function moveToGroup(code: string, groupId: number) {
    const order = stocksOf(groupId).filter((s) => s.code !== code).length;
    await db().execute("UPDATE stocks SET group_id=?, sort_order=? WHERE code=?", [
      groupId,
      order,
      code,
    ]);
    const s = stocks.value.find((x) => x.code === code);
    if (s) {
      s.groupId = groupId;
      s.sortOrder = order;
    }
    watchChanged();
  }

  /** 当前分组内拖拽重排 */
  async function reorder(code: string, toIndex: number) {
    const gid = currentGroupId.value;
    const list = stocksOf(gid);
    const from = list.findIndex((s) => s.code === code);
    if (from < 0 || from === toIndex) return;
    const [item] = list.splice(from, 1);
    list.splice(toIndex, 0, item);
    // 乐观更新
    list.forEach((s, i) => {
      const target = stocks.value.find((x) => x.code === s.code);
      if (target) target.sortOrder = i;
    });
    for (let i = 0; i < list.length; i++) {
      await db().execute("UPDATE stocks SET sort_order=? WHERE code=?", [i, list[i].code]);
    }
    watchChanged();
  }

  /** 新建分组，返回 id 并切换过去 */
  async function addGroup(name: string): Promise<number> {
    const n = name.trim();
    if (!n) return currentGroupId.value;
    const order = groups.value.length;
    const r = await db().execute(
      "INSERT INTO groups(name, sort_order, created_at) VALUES(?,?,?)",
      [n, order, Date.now()]
    );
    const id = (r.lastInsertId as number) ?? groups.value[groups.value.length - 1].id + 1;
    groups.value.push({ id, name: n, sortOrder: order });
    selectGroup(id);
    watchChanged();
    return id;
  }

  async function renameGroup(id: number, name: string) {
    const n = name.trim();
    if (!n) return;
    await db().execute("UPDATE groups SET name=? WHERE id=?", [n, id]);
    const g = groups.value.find((x) => x.id === id);
    if (g) g.name = n;
    watchChanged();
  }

  /** 删除分组：其下股票移回默认分组(id=1)；默认分组不可删 */
  async function removeGroup(id: number) {
    if (id === 1) return;
    const members = stocksOf(id);
    let base = stocksOf(1).length;
    for (const s of members) {
      await db().execute("UPDATE stocks SET group_id=1, sort_order=? WHERE code=?", [
        base,
        s.code,
      ]);
      s.groupId = 1;
      s.sortOrder = base;
      base++;
    }
    await db().execute("DELETE FROM groups WHERE id=?", [id]);
    groups.value = groups.value.filter((g) => g.id !== id);
    if (currentGroupId.value === id) selectGroup(1);
    watchChanged();
  }

  return {
    groups,
    stocks,
    loaded,
    currentGroupId,
    currentGroup,
    currentStocks,
    codes,
    load,
    selectGroup,
    add,
    remove,
    ensureName,
    moveToGroup,
    reorder,
    addGroup,
    renameGroup,
    removeGroup,
    stocksOf,
    nameOf,
  };
});
