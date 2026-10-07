// 浏览器 E2E 的假后端：invoke 命令注册表 + 内存版 SQLite。
// 让 Vite 构建的前端在没有 Tauri 运行时时也能跑通启动与关键交互。
import type { Quote, KBar } from "../../../src/api/types";

type Row = Record<string, unknown>;

function quote(code: string, price: number, pct: number, name?: string): Quote {
  const n =
    name ??
    { "600519": "贵州茅台", "000001": "平安银行", "300750": "宁德时代", "601318": "中国平安" }[code] ??
    code;
  return {
    code, name: n, price, change: +(price * (pct / 100)).toFixed(2), pct,
    open: price, high: price * 1.01, low: price * 0.99, prevClose: +(price / (1 + pct / 100)).toFixed(2),
    volume: 12000, amount: price * 1.2e6, time: Date.now(), source: "eastmoney",
    turnover: 1.2, pe: 25, pb: 4, amplitude: 2, volumeRatio: 1.1, circMv: 2e4, totalMv: 3e4,
  };
}
function bar(i: number): KBar {
  const c = 10 + i * 0.02;
  return { timestamp: Date.now() - (100 - i) * 60000, open: c, close: c + 0.01, high: c + 0.05, low: c - 0.05, volume: 1000 };
}

// —— 内存数据库（物理列名为 snake_case）——
class FakeDb {
  groups: Row[] = [];
  stocks: Row[] = [];
  meta: Row[] = [];
  alertRules: Row[] = [];
  alertEvents: Row[] = [];
  constructor() { this.reset(); }
  reset() {
    this.alertRules = [];
    this.alertEvents = [];
    this.groups = [{ id: 1, name: "我的自选", sort_order: 0, created_at: Date.now() }];
    this.stocks = [
      { code: "600519", name: "贵州茅台", group_id: 1, sort_order: 0, created_at: Date.now() },
      { code: "000001", name: "平安银行", group_id: 1, sort_order: 1, created_at: Date.now() },
      { code: "300750", name: "宁德时代", group_id: 1, sort_order: 2, created_at: Date.now() },
      { code: "601318", name: "中国平安", group_id: 1, sort_order: 3, created_at: Date.now() },
    ];
    // 默认标记引导已完成，避免首启弹 Onboarding 遮挡主界面
    this.meta = [{ key: "onboarding_done", value: "1" }];
    // 模拟历史缺陷数据：watch/rank/news 三卡曾被出厂微件化为简化微件
    // （自选列表/滚动快讯），启动恢复时应被 migrateSnapshot 一次性还原为
    // 经典完整组件（WatchList 分组管理 / RankBoard 8 Tab / NewsFlash 分页开窗）
    this.meta.push({
      key: "workbench_current",
      value: JSON.stringify([
        { id: "watch", zone: "main", v: 1, widgets: { primary: null, items: [{ id: "ql_w", def: "quote-list", w: 12, h: 7, x: 0, y: 0 }] } },
        { id: "rank", zone: "main", v: 1, widgets: { primary: null, items: [{ id: "ql_r", def: "quote-list", w: 12, h: 7, x: 0, y: 0 }] } },
        { id: "news", zone: "main", v: 1, widgets: { primary: null, items: [{ id: "nt_n", def: "news-tape", w: 12, h: 6, x: 0, y: 0 }] } },
      ]),
    });
  }

  async select(sql: string, params: unknown[] = []): Promise<Row[]> {
    const s = " " + sql.replace(/\s+/g, " ").trim();
    const metaKey = matchMetaKey(s, params);
    if (metaKey !== undefined) {
      const v = this.meta.find((m) => m.key === metaKey)?.value;
      return v === undefined ? [] : [{ value: v }];
    }
    if (/COUNT\(\*\)/i.test(s) && /FROM groups/i.test(s)) return [{ c: this.groups.length }];
    if (/COUNT\(\*\)/i.test(s) && /FROM stocks/i.test(s)) return [{ c: this.stocks.length }];
    if (/COUNT\(\*\)/i.test(s) && /FROM alerts/i.test(s)) return [{ c: 0 }];
    if (/FROM groups/i.test(s)) {
      return [...this.groups]
        .sort((a, b) => (a.sort_order as number) - (b.sort_order as number))
        .map((g) => ({ id: g.id, name: g.name, sortOrder: g.sort_order }));
    }
    if (/FROM stocks/i.test(s)) {
      return [...this.stocks]
        .sort((a, b) => (a.group_id as number) - (b.group_id as number) || (a.sort_order as number) - (b.sort_order as number))
        .map((x) => ({ code: x.code, name: x.name, groupId: x.group_id, sortOrder: x.sort_order }));
    }
    if (/COUNT\(\*\)/i.test(s) && /FROM alert_rule_v2/i.test(s))
      return [{ c: this.alertRules.length }];
    if (/FROM alert_rule_v2/i.test(s))
      return [...this.alertRules].sort(
        (a, b) => (b.created_at as number) - (a.created_at as number)
      );
    if (/FROM alert_event/i.test(s))
      return [...this.alertEvents].sort(
        (a, b) => (b.triggered_at as number) - (a.triggered_at as number)
      );
    return [];
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ lastInsertId?: number; rowsAffected: number }> {
    const s = sql.replace(/\s+/g, " ").trim();

    // UPDATE <table> SET a=?, b=? WHERE col=?
    const upd = /^UPDATE (\w+) SET (.+?) WHERE (\w+)=(\??|'[^']*')\s*$/i.exec(s);
    if (upd) {
      const table = this.table(upd[1]);
      // 参数按 token 顺序消费：先 SET 列表、后 WHERE
      let pi = 0;
      const take = (tok: string): unknown => {
        const t = tok.trim();
        if (t === "?") return params[pi++];
        if (/^'.*'$/.test(t)) return t.slice(1, -1);
        return t;
      };
      const target = take(upd[4]);
      const sets = splitCsv(upd[2]);
      for (const row of table) {
        if (row[upd[3]] !== target) continue;
        for (const assign of sets) {
          const m = /^(\w+)\s*=\s*(\?|'[^']*'|[\w.]+)$/.exec(assign.trim());
          if (!m) continue;
          row[m[1]] = take(m[2]);
        }
      }
      return { rowsAffected: 1 };
    }

    // DELETE FROM <table> WHERE col=?
    const del = /^DELETE FROM (\w+) WHERE (\w+)=\?\s*$/i.exec(s);
    if (del) {
      const table = this.table(del[1]);
      const before = table.length;
      const idx = table.findIndex((r) => r[del[2]] === params[0]);
      if (idx >= 0) table.splice(idx, 1);
      return { rowsAffected: before - table.length };
    }
    // DELETE FROM <table>（清空）
    const delAll = /^DELETE FROM (\w+)\s*$/i.exec(s);
    if (delAll) { const t = this.table(delAll[1]); const n = t.length; t.length = 0; return { rowsAffected: n }; }

    // INSERT [OR IGNORE] INTO <table>(cols) VALUES(vals)
    const ins = /^INSERT(?: OR IGNORE| INTO)? INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(s);
    if (ins) {
      const table = this.table(ins[1]);
      const cols = splitCsv(ins[2]);
      const vals = splitCsv(ins[3]);
      const row: Row = {};
      cols.forEach((c, i) => { row[c.trim()] = literalOrParam(vals[i].trim(), params); });
      table.push(row);
      return { lastInsertId: table.length, rowsAffected: 1 };
    }

    // 其它（含 "INSERT ... SELECT ... WHERE NOT EXISTS" 的幂等 seed）：表已预置，安全忽略
    return { rowsAffected: 0 };
  }

  private table(name: string): Row[] {
    if (name === "groups") return this.groups;
    if (name === "stocks") return this.stocks;
    if (name === "meta") return this.meta;
    if (name === "alert_rule_v2") return this.alertRules;
    if (name === "alert_event") return this.alertEvents;
    return [];
  }
}

// —— 工具 ——
function splitCsv(s: string): string[] {
  const out: string[] = [];
  let cur = "", inStr = false;
  for (const ch of s) {
    if (ch === "'") inStr = !inStr;
    if (ch === "," && !inStr) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
function literalOrParam(token: string, params: unknown[]): unknown {
  if (token === "?") return params.shift();
  if (/^'.*'$/.test(token)) return token.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  return token;
}
// 简化：参数按出现顺序消费（仅用于上面的轻量 UPDATE）
function setP(_s: string): number { return 0; }
function readValue(token: string, params: unknown[]): unknown {
  return token === "?" ? params[0] : token.startsWith("'") ? token.slice(1, -1) : token;
}
function matchMetaKey(s: string, params: unknown[]): string | undefined {
  if (!/FROM meta/i.test(s) || !/key\s*=/i.test(s)) return undefined;
  const m = /key\s*=\s*\?/.exec(s);
  if (m) return params[0] as string;
  const lit = /key\s*=\s*'([^']+)'/.exec(s);
  return lit ? lit[1] : undefined;
}

export const fakeDb = new FakeDb();

// e2e 模式下把注入工具挂到 window，供 Playwright page.evaluate 调用
if (import.meta.env.MODE === "e2e") {
  (globalThis as unknown as {
    __e2e: {
      setQuoteOverride: typeof setQuoteOverride;
      clearQuoteOverrides: typeof clearQuoteOverrides;
    };
  }).__e2e = { setQuoteOverride, clearQuoteOverrides };
}

// —— 测试可注入的行情覆盖（触发预警用）——
const quoteOverrides = new Map<string, Quote>();
export function setQuoteOverride(code: string, q: Partial<Quote>): void {
  const base = quote(code, 20, 0.5);
  quoteOverrides.set(code, { ...base, ...q, code });
}
export function clearQuoteOverrides(): void {
  quoteOverrides.clear();
}

// —— invoke 命令注册表 ——
type Handler = (args: Record<string, unknown> | undefined) => unknown;
const handlers: Record<string, Handler> = {
  get_quotes: (a) =>
    (a?.codes as string[]).map((c, i) =>
      quoteOverrides.has(c)
        ? quoteOverrides.get(c)!
        : quote(c, [1680, 12.3, 189, 48][i] ?? 20, [1.2, -0.5, 2.1, 0.3][i] ?? 0.5)
    ),
  get_index_quotes: () => [quote("000001", 3200, 0.4, "上证指数"), quote("399001", 10200, -0.2, "深证成指"), quote("399006", 2010, 1.1, "创业板指")],
  get_kline: () => Array.from({ length: 60 }, (_, i) => bar(i)),
  get_minute: () => Array.from({ length: 30 }, (_, i) => bar(i)),
  get_hist_minute: () => Array.from({ length: 30 }, (_, i) => bar(i)),
  get_hist_minute_days: () => Array.from({ length: 3 }, (_, d) => ({ date: `2026010${d + 1}`, bars: Array.from({ length: 30 }, (_, i) => bar(i)) })),
  get_rank_page: () => [quote("600519", 1680, 5.2), quote("300750", 189, 4.1), quote("601318", 48, -2.3)],
  get_rank_board: (a) => {
    // 增强榜单（RankBoard.vue 使用）：按 sort 生成对应指标列的确定性 mock
    const pool: [string, string, number, number, number, number, number, number, number, number][] = [
      // code, name, price, pct, amount(亿), turnover, volumeRatio, speed5, mainNet(亿), bigNet(亿)
      ["600519", "贵州茅台", 1680, 5.2, 89.4, 1.2, 2.3, 1.5, 12.3, 8.1],
      ["300750", "宁德时代", 189, 4.1, 72.1, 3.4, 1.8, 0.9, 9.6, 6.2],
      ["601318", "中国平安", 48, -2.3, 45.6, 1.5, 0.7, -0.4, -3.2, -1.1],
      ["000001", "平安银行", 12.3, 1.8, 30.2, 2.1, 1.1, 0.6, 2.4, 1.8],
      ["600036", "招商银行", 36.5, 0.6, 28.9, 0.9, 0.8, 0.1, 0.5, 0.3],
      ["000858", "五粮液", 145, -1.2, 26.4, 1.1, 1.4, -0.2, -1.8, -0.9],
      ["002594", "比亚迪", 245, 3.3, 58.7, 4.2, 2.6, 2.1, 15.6, 9.8],
      ["300059", "东方财富", 21.5, 2.9, 42.3, 5.6, 3.1, 1.2, 7.8, 5.4],
    ];
    const pageNum = Math.max(1, (a?.page as number) || 1);
    const start = (pageNum - 1) * 50;
    // 第 1 页 50 条；第 2 页仅 8 条（模拟末页不足一页 → hasMore 收敛）
    if (pageNum >= 2) {
      return pool.slice(0, 8).map((r) => ({
        code: r[0], name: r[1], price: r[2], pct: r[3], amount: r[4] * 1e8,
        turnover: r[5], volumeRatio: r[6], speed5: r[7], mainNet: r[8] * 1e8, bigNet: r[9] * 1e8,
      }));
    }
    return pool.map((r, i) => ({
      code: r[0], name: r[1], price: r[2], pct: r[3], amount: r[4] * 1e8,
      turnover: r[5], volumeRatio: r[6], speed5: r[7], mainNet: r[8] * 1e8, bigNet: r[9] * 1e8,
    })).concat(
      // 补足分页第二页（PAGE_SIZE=50），验证滚动加载
      Array.from({ length: Math.max(0, 50 - pool.length) }, (_, i) => ({
        code: `60${(1000 + start + i).toString().padStart(4, "0")}`, name: `示例股${start + i + 1}`,
        price: 10 + i * 0.1, pct: (i % 7) - 3, amount: (i + 1) * 5e7, turnover: 2 + i * 0.1,
        volumeRatio: 1 + i * 0.05, speed5: ((i * 13) % 5) - 2, mainNet: (i % 9) * 1e7,
        bigNet: (i % 8) * 6e6,
      }))
    );
  },
  get_orderbook: () => ({ code: "600519", name: "贵州茅台", price: 1680, prevClose: 1660, open: 1665, high: 1690, low: 1660, volume: 12000, amount: 2e9, asks: [], bids: [] }),
  get_sectors: () => [{ code: "BK1", name: "半导体", changePct: 2.3, netAmount: 1e9, inAmount: 3e9, outAmount: 2e9, leadCode: "300750", leadName: "宁德时代", leadPct: 4.1 }],
  get_news_flash: () => [{ id: 1, time: "2026-01-01 09:45:00", text: "市场开盘活跃", tags: ["快讯"], url: "" }],
  get_screener: () => [quote("600519", 1680, 3.2)],
  get_auction: () => ({ updated: Date.now(), total: 1, highOpen: [quote("600519", 1680, 2)], lowOpen: [] }),
  get_zt_pool: () => ({ date: "20260101", total: 1, list: [] }),
  get_zb_pool: () => ({ date: "20260101", total: 0, list: [] }),
  get_lhb_list: () => ({ date: "2026-01-01", total: 0, stocks: [] }),
  get_lhb_detail: () => ({ code: "600519", name: "贵州茅台", date: "2026-01-01", price: 1680, pct: 1.2, groups: [] }),
  get_seat_back: () => ({ code: "600519", name: "贵州茅台", rows: [] }),
  get_seat_trades: () => ({ code: "600519", name: "贵州茅台", total: 0, trades: [] }),
  get_f10_profile: () => ({ code: "600519", name: "贵州茅台", fields: [] }),
  get_f10_finance: () => ({ periods: ["2025Q4"], groups: [] }),
  get_f10_chips: () => ({ currentPrice: 1680, avgCost: 1600, profitRatio: 0.8 }),
  get_ipo_list: () => [],
  get_restricted_queue: () => [],
  get_market_restricted: () => ({ total: 0, pages: 1, data: [] }),
  restore_latest_backup: () => false,
  win_is_maximized: () => false,
  win_minimize: () => "ok",
  win_toggle_maximize: () => false,
  win_close: () => "ok",
  check_latest: () => ({ version: "0.69.0", notes: "", pubDate: "" }),
};
const passthrough = ["start_spider", "stop_spider", "check_latest", "start_radar", "stop_radar", "start_alert_engine", "stop_alert_engine"];

export async function fakeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const h = handlers[cmd];
  if (h) return clone(h(args)) as T;
  if (passthrough.includes(cmd)) return "ok" as T;
  // 未知命令：返回空数组（多数 command 返回列表），保证 UI 不崩
  return [] as unknown as T;
}
function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

export function resetBackend() { fakeDb.reset(); }
