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
import type { Group, SmartGroupRule, WatchStock } from "../api/types";
import { fetchRankPage, fetchQuotes } from "../api/market";
import { evalRule, fieldValue, type SmartQueryRule } from "../lib/smartQuery";

/** 近 N 日涨停记录（智能分组归类 / 信号命中高亮的数据源，v2.31） */
export interface SmartHit {
  tradeDate: string;
  code: string;
  name: string;
  boards: number;
  industry: string;
  concepts: string;
}

const GROUP_PREF_KEY = "sd_current_group";
const SMART_LOOKBACK_DAYS = 5;

/** 自选股 + 分组：SQLite 持久化 */
export const useWatchlistStore = defineStore("watchlist", () => {
  const groups = ref<Group[]>([]);
  const stocks = ref<WatchStock[]>([]);
  const loaded = ref(false);
  const currentGroupId = ref<number>(1);
  /** 近 N 日涨停记录（含已在自选与未在自选），智能分组与信号高亮共用 */
  const smartHits = ref<SmartHit[]>([]);

  function parseRule(g: Group): SmartGroupRule {
    try {
      return JSON.parse(g.ruleJson || "{}") as SmartGroupRule;
    } catch {
      return {};
    }
  }

  /** 智能分组的动态成员：v2 选股规则走榜单位缓存；v1 规则走近 N 日涨停匹配（无需手动维护） */
  function smartMembers(g: Group): WatchStock[] {
    const rule = parseRule(g);
    if ((rule as SmartQueryRule).version === 2) {
      return smartV2.value[g.id]?.members ?? [];
    }
    const days = Math.max(1, rule.days || SMART_LOOKBACK_DAYS);
    const seen = new Set<string>();
    const out: WatchStock[] = [];
    for (const h of smartHits.value) {
      if (seen.has(h.code)) continue;
      if (rule.tactic === "first_board" && h.boards !== 1) continue;
      if (rule.tactic === "multi_board" && h.boards < 2) continue;
      if (rule.theme) {
        const kw = rule.theme.trim();
        if (kw && !h.industry.includes(kw) && !h.concepts.includes(kw)) continue;
      }
      // days 截断：记录按日期倒序时按出现条数近似 N 日即可，这里按日期集合精确判断
      if (hitAgeDays(h.tradeDate) >= days) continue;
      seen.add(h.code);
      out.push({ code: h.code, name: h.name, groupId: g.id, sortOrder: out.length });
    }
    return out;
  }

  /** 涨停记录距今天数（自然日，0 = 今天） */
  function hitAgeDays(tradeDate: string): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(tradeDate.replace(/-/g, "/") + "T00:00:00");
    if (Number.isNaN(d.getTime())) return 0;
    return Math.floor((today.getTime() - d.getTime()) / 86_400_000);
  }

  /** 当前展示行：智能分组给动态成员，普通分组给表内成员 */
  function membersOf(groupId: number): WatchStock[] {
    const g = groups.value.find((x) => x.id === groupId);
    if (g?.kind === "smart") return smartMembers(g);
    return stocksOf(groupId);
  }

  /** 某只自选股近 N 日的战法信号（用于列表高亮） */
  function hitOf(code: string): SmartHit | undefined {
    return smartHits.value.find((h) => h.code === code);
  }

  /** 全部股票代码（跨分组，供行情轮询/灵动岛使用；含 v2 动态选股成员） */
  const codes = computed(() => {
    const list = [...stocks.value]
      .sort((a, b) => a.groupId - b.groupId || a.sortOrder - b.sortOrder)
      .map((s) => s.code);
    for (const v of Object.values(smartV2.value)) {
      for (const m of v.members) {
        if (!list.includes(m.code)) list.push(m.code);
      }
    }
    return list;
  });

  /** 当前分组下的股票（智能分组为动态命中成员） */
  const currentStocks = computed(() => membersOf(currentGroupId.value));

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

  /** v2 动态选股：各分组缓存成员 + 更新时间；榜单位候选缓存（60s TTL） */
  const smartV2 = ref<Record<number, { members: WatchStock[]; updatedAt: number }>>({});
  const smartV2Loading = ref<Record<number, boolean>>({});
  const smartV2Error = ref<Record<number, string>>({});
  const smartV2Refreshing = ref<Record<number, boolean>>({});
  let rankCache: import("../api/types").Quote[] | null = null;
  let rankCacheAt = 0;
  const RANK_CACHE_TTL = 60_000;

  /** 榜单位候选集：涨幅/成交额/换手三榜各前 3 页并集去重（约 700-900 只），60s 缓存 */
  async function fetchRankCandidates(): Promise<import("../api/types").Quote[]> {
    const now = Date.now();
    if (rankCache && now - rankCacheAt < RANK_CACHE_TTL) return rankCache;
    const sorts = ["gainers", "amount", "turnover"] as const;
    const tasks = sorts.flatMap((sort) =>
      [1, 2, 3].map((page) => fetchRankPage(sort, page, 100).catch(() => [] as import("../api/types").Quote[]))
    );
    const lists = await Promise.all(tasks);
    const map = new Map<string, import("../api/types").Quote>();
    for (const list of lists) {
      for (const q of list) {
        if (q.code && !map.has(q.code)) map.set(q.code, q);
      }
    }
    // 新浪榜单缺量比/振幅：候选集用腾讯批量行情补全（getQuotes 内部自动分批并发）。
    // 只做字段级补全，绝不整条覆盖——腾讯对 pe/pb/市值等字段可能返回 0，
    // 整条覆盖会破坏智能分组基本面条件的命中。
    const codes = [...map.keys()];
    if (codes.length) {
      const enriched = await fetchQuotes(codes).catch(() => [] as import("../api/types").Quote[]);
      for (const q of enriched) {
        const orig = q.code && map.get(q.code);
        if (!orig) continue;
        map.set(q.code, {
          ...orig,
          volumeRatio: orig.volumeRatio || q.volumeRatio,
          amplitude: orig.amplitude || q.amplitude,
        });
      }
    }
    rankCache = [...map.values()];
    rankCacheAt = Date.now();
    return rankCache;
  }

  /** 刷新单个 v2 智能分组：拉榜单位候选 → 本地条件过滤 → 写缓存 */
  async function refreshSmartGroup(id: number): Promise<void> {
    const g = groups.value.find((x) => x.id === id);
    if (!g || g.kind !== "smart") return;
    const rule = parseRule(g);
    if ((rule as SmartQueryRule).version !== 2) return;
    if (smartV2Loading.value[id]) return;
    smartV2Loading.value[id] = true;
    smartV2Refreshing.value[id] = true;
    delete smartV2Error.value[id];
    try {
      const rows = await fetchRankCandidates();
      if (rows.length === 0) {
        smartV2.value[id] = { members: [], updatedAt: Date.now() };
        smartV2Error.value[id] = "候选池为空：行情数据源暂不可达，请稍后重试";
        return;
      }
      const hitMap = new Map(smartHits.value.map((h) => [h.code, h]));
      const members: WatchStock[] = [];
      for (const q of rows) {
        const boards = hitMap.get(q.code)?.boards ?? 0;
        if (evalRule(rule as SmartQueryRule, q as unknown as Record<string, unknown>, boards)) {
          members.push({ code: q.code, name: q.name, groupId: id, sortOrder: members.length });
        }
      }
      smartV2.value[id] = { members, updatedAt: Date.now() };
      if (members.length === 0) {
        // 区分「条件未命中」与「候选数据缺字段」：引用了候选里全缺的字段时给出诊断
        const conds = (rule as SmartQueryRule).conditions;
        const hasVal = (f: string) =>
          rows.some((q) => {
            const v = fieldValue(f, q as unknown as Record<string, unknown>, 0);
            return v !== null && v > 0;
          });
        const fieldNames: Record<string, string> = {
          pe: "市盈率",
          pb: "市净率",
          total_mv: "总市值",
          circ_mv: "流通市值",
          pct: "涨跌幅",
          price: "现价",
          amount: "成交额",
          volume: "成交量",
          turnover: "换手率",
          volume_ratio: "量比",
          boards: "连板数",
        };
        const missing = conds
          .map((c) => c.field)
          .filter((f) => f !== "boards" && !hasVal(f))
          .map((f) => fieldNames[f] || f);
        const hint =
          missing.length > 0
            ? `（候选池 ${rows.length} 只；当前数据源缺少 ${missing.join("/")}，相关条件无法命中）`
            : `（候选池 ${rows.length} 只，条件均未匹配）`;
        smartV2Error.value[id] = "暂无命中股票" + hint;
      }
    } catch (e) {
      smartV2Error.value[id] = e instanceof Error ? e.message : String(e);
    } finally {
      smartV2Loading.value[id] = false;
      smartV2Refreshing.value[id] = false;
    }
  }

  /** 拉取近 N 个交易日涨停记录，供智能分组 / 信号高亮 */
  async function refreshSmartHits() {
    try {
      const dates = await db().select<{ d: string }[]>(
        "SELECT DISTINCT trade_date AS d FROM limit_up_record ORDER BY d DESC LIMIT ?",
        [SMART_LOOKBACK_DAYS]
      );
      if (!dates || !dates.length) {
        smartHits.value = [];
        return;
      }
      const ph = dates.map(() => "?").join(",");
      const rows = await db().select<
        { tradeDate: string; code: string; name: string; boards: number; industry: string; concepts: string }[]
      >(
        `SELECT trade_date AS tradeDate, code, name, boards, industry, concepts
         FROM limit_up_record WHERE trade_date IN (${ph})
         ORDER BY trade_date DESC, boards DESC`,
        dates.map((x) => x.d)
      );
      smartHits.value = rows ?? [];
    } catch (e) {
      // 表不存在（旧库未迁移）等情况静默
      console.warn("[watchlist] 智能命中加载失败", e);
    }
  }

  /** 启动时加载全部分组与股票 */
  async function load() {
    await ensureDb();
    const gs = await db().select<
      { id: number; name: string; sortOrder: number; kind: string; ruleJson: string }[]
    >(
      "SELECT id, name, sort_order AS sortOrder, kind, rule_json AS ruleJson FROM groups ORDER BY sort_order, id"
    );
    groups.value = gs.map((g) => ({
      ...g,
      kind: g.kind === "smart" ? "smart" : "manual",
    }));
    const ss = await db().select<
      { code: string; name: string; groupId: number; sortOrder: number }[]
    >(
      "SELECT code, name, group_id AS groupId, sort_order AS sortOrder FROM stocks ORDER BY group_id, sort_order, id"
    );
    stocks.value = ss;
    // 智能命中为增强数据：失败/旧库不阻塞自选主数据加载
    await refreshSmartHits();
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

  /** 新建智能分组（成员按规则从涨停记录动态计算），返回 id 并切换过去 */
  async function addSmartGroup(name: string, rule: SmartGroupRule): Promise<number> {
    const n = name.trim();
    if (!n) return currentGroupId.value;
    const order = groups.value.length;
    const ruleJson = JSON.stringify(rule);
    const r = await db().execute(
      "INSERT INTO groups(name, sort_order, created_at, kind, rule_json) VALUES(?,?,?, 'smart', ?)",
      [n, order, Date.now(), ruleJson]
    );
    const id = (r.lastInsertId as number) ?? groups.value[groups.value.length - 1].id + 1;
    groups.value.push({ id, name: n, sortOrder: order, kind: "smart", ruleJson });
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
    addSmartGroup,
    stocksOf,
    membersOf,
    smartHits,
    hitOf,
    refreshSmartHits,
    nameOf,
    smartV2,
    smartV2Loading,
    smartV2Error,
    smartV2Refreshing,
    refreshSmartGroup,
  };
});
