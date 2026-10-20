// 浏览器 E2E 的假后端：invoke 命令注册表 + 内存版 SQLite。
// 让 Vite 构建的前端在没有 Tauri 运行时时也能跑通启动与关键交互。
import type { Quote, KBar } from "../../../src/api/types";
import type { BrokerOrderInfo } from "../../../src/broker/api";

type Row = Record<string, unknown>;

// —— 券商状态（作战台下单条 / 风控徽标用）——
// 本文件会被 Vite 的 e2e alias 打进浏览器 bundle，与 Node 侧的 Playwright 测试进程是两份模块实例，
// 因此 spec 里 import 任何 setter 都改不到页面状态。统一由 page.addInitScript 预置
// window.__FAKE_BROKER_STATUS（页面级全局），模块初始化时合并该 patch（熔断 / 连接态切换）。
const injectedBrokerStatus: Record<string, unknown> =
  typeof window !== "undefined"
    ? ((window as unknown as { __FAKE_BROKER_STATUS?: Record<string, unknown> })
        .__FAKE_BROKER_STATUS ?? {})
    : {};
let fakeBrokerStatus: Record<string, unknown> = {
  kind: "mock",
  liveEnabled: false,
  connected: true,
  killSwitch: false,
  accountId: "SIM",
  clientSim: true,
  windowSim: true,
  ...injectedBrokerStatus,
};

// —— P2-a 对账状态（常驻 chip / 冲突横幅用）——
// 与 `__FAKE_BROKER_STATUS` 同理：本模块被 Vite 的 e2e alias 打进浏览器 bundle，
// spec 里调用任何 setter 都改不到页面状态，统一由 page.addInitScript 预置页面级全局
// `window.__FAKE_RECON_CONFLICT`（true = 后端处于「账实不符」冲突态）。
const injectedReconConflict: boolean =
  typeof window !== "undefined" &&
  Boolean((window as unknown as { __FAKE_RECON_CONFLICT?: unknown }).__FAKE_RECON_CONFLICT);
let fakeReconConflict = injectedReconConflict;

/** 缺省「刚跑过一次即时对账且账实一致」；冲突态给未匹配报告，chip / 横幅据此变红。 */
function fakeReconReport() {
  const matched = !fakeReconConflict;
  return {
    kind: "intraday",
    matched,
    baseline: false,
    checked: 3,
    at: Date.now(),
    diffs: matched
      ? []
      : [{ code: "600519", localVol: 1000, brokerVol: 900 }],
  };
}

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
// 分时/历史分时与头部盘口同价位（1680 附近），避免 P3-b 分时点击预填被涨跌停夹住。
function minuteBar(i: number): KBar {
  const c = 1680 + i * 0.02;
  return { timestamp: Date.now() - (100 - i) * 60000, open: c, close: c + 0.01, high: c + 0.05, low: c - 0.05, volume: 1000 };
}

// —— 内存数据库（物理列名为 snake_case）——
class FakeDb {
  groups: Row[] = [];
  stocks: Row[] = [];
  meta: Row[] = [];
  alertRules: Row[] = [];
  alertEvents: Row[] = [];
  sectorDays: string[] = [];
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
    // 近 12 个自然日的工作日都视为已有板块日快照，避免补采循环
    this.sectorDays = [];
    const __today = new Date();
    for (let back = 0; back < 12; back++) {
      const d = new Date(__today);
      d.setDate(__today.getDate() - back);
      const wd = d.getDay();
      if (wd === 0 || wd === 6) continue;
      const p = (n: number) => String(n).padStart(2, "0");
      this.sectorDays.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
    }
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
    // meta 批量读取：key IN (?,?,...) —— 只返回已存在的键
    if (/FROM meta/i.test(s) && /\bkey\s+IN\s*\(/i.test(s)) {
      return this.meta
        .filter((m) => (params as string[]).includes(m.key as string))
        .map((m) => ({ key: m.key, value: m.value }));
    }
    // 板块日历史：避免生产代码误判缺数据而触发 1.2s × N 的补采循环
    if (/FROM ts_sector_day/i.test(s)) {
      return this.sectorDays.map((day) => ({ day }));
    }
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

// —— P1-a 作战卡 / 指令列表共用同一份假计划 ——
// 作战台以 scope="today" 调 workflow_p1_products，后端与 workflow_instructions 同源；
// 若两处各写一份，e2e 会出现「卡片有计划、列表无指令」的 split-brain。
const fakePlan = {
  id: 1,
  planDate: "2026-10-20",
  title: "明日作战卡",
  marketView: "",
  status: "confirmed",
  instructions: [] as Record<string, unknown>[],
};
// —— P1-b：三行分别覆盖「待触发可编辑 / 已触发待确认下单 / 已成交已有委托」——
// ticketId/ticketStatus/side/vol/price/autoConfirm/orderStatus/hasOrder 与 Rust list_instructions 对齐：
// 行 2 是触发后自动执行关闭、票仍 pending 的状态，供「确认下单」用例提交；
// 行 3 已有委托（hasOrder），用来锁定「不显示动作按钮、只显示委托状态」。
const fakeInstructions: Record<string, unknown>[] = [
  { id: 1, tier: "candidate", code: "600519", name: "贵州茅台", condition: "", action: "", positionHint: "", coId: "CO1", triggerJson: '[{"field":"price","op":"gte","value":1680}]', state: "pending", triggeredAt: 0, filledVol: 0, filledAvgPrice: 0, ticketId: 0, ticketStatus: "", side: "BUY", vol: 100, price: 1680, autoConfirm: true, orderStatus: "", hasOrder: false, tag: "" },
  { id: 2, tier: "trigger", code: "300750", name: "宁德时代", condition: "", action: "", positionHint: "", coId: "CO2", triggerJson: '[{"field":"pct","op":"gte","value":3}]', state: "triggered", triggeredAt: 1, filledVol: 0, filledAvgPrice: 0, ticketId: 2, ticketStatus: "pending", side: "BUY", vol: 100, price: 189, autoConfirm: false, orderStatus: "", hasOrder: false, tag: "" },
  { id: 3, tier: "candidate", code: "000001", name: "平安银行", condition: "", action: "", positionHint: "", coId: "CO3", triggerJson: "", state: "filled", triggeredAt: 1, filledVol: 100, filledAvgPrice: 12.3, ticketId: 3, ticketStatus: "done", side: "SELL", vol: 100, price: 12.3, autoConfirm: true, orderStatus: "filled", hasOrder: true, tag: "" },
];

// —— P1-c 早盘：缺省 scope（无 scope）返回「今日 draft」计划 ——
// 新版作战台以缺省 scope 拉取可确认计划：今日未确认 → 今日 draft（早盘提醒链路）。
// scope="today"/"next" 的既有分支保持不变（见 workflow_p1_products）。
function todayDashed(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const fakeTodayPlan = {
  id: 2,
  planDate: todayDashed(),
  title: "今日作战卡",
  marketView: "",
  status: "draft",
  instructions: fakeInstructions.map(({ tier, code, name }) => ({
    tier, code, name, theme: "", condition: "", action: "", positionHint: "",
  })) as Record<string, unknown>[],
};

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
  get_minute: () => Array.from({ length: 30 }, (_, i) => minuteBar(i)),
  get_hist_minute: () => Array.from({ length: 30 }, (_, i) => minuteBar(i)),
  get_hist_minute_days: () => Array.from({ length: 3 }, (_, d) => ({ date: `2026010${d + 1}`, bars: Array.from({ length: 30 }, (_, i) => minuteBar(i)) })),
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
  get_orderbook: () => ({
    code: "600519", name: "贵州茅台", price: 1680, prevClose: 1660, open: 1665, high: 1690, low: 1660,
    volume: 12000, amount: 2e9,
    // 盘口五档（P3-b 盘口点击预填 e2e 需要真实档位与价格）
    asks: [1681, 1682, 1683, 1684, 1685].map((price, i) => ({ price, vol: 100 * (i + 1) })),
    bids: [1679, 1678, 1677, 1676, 1675].map((price, i) => ({ price, vol: 100 * (i + 1) })),
    bidTotal: 1500, askTotal: 1500, weiBi: 0, weiCha: 0, insideVol: 600, outsideVol: 640,
  }),
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
  // —— 作战台 P0：券商状态 / 下单条直下 / 风控快照 / 作战流产物 ——
  broker_get_status: () => fakeBrokerStatus,
  // P2-a 对账状态：默认「即时对账通过」；`__FAKE_RECON_CONFLICT` 切冲突态（matched=false + 一条差异）。
  broker_recon_status: () => ({
    conflict: fakeReconConflict,
    connected: true,
    kind: "mock",
    report: fakeReconReport(),
  }),
  broker_quick_order: (a) => {
    const code = String(a?.code ?? "");
    const side = String(a?.side ?? "BUY");
    const price = Number(a?.price ?? 0);
    const vol = Number(a?.vol ?? 0);
    // 记录页面侧最近一次下单参数：e2e 用来断言「只提交一次、参数正确」。
    (window as unknown as { __FAKE_LAST_ORDER?: unknown }).__FAKE_LAST_ORDER = { code, side, price, vol };
    return {
      id: 1,
      sigId: "QK1",
      brokerKind: "mock",
      brokerAccount: "SIM",
      brokerOrderId: "QK1",
      code,
      side,
      price,
      vol,
      status: "submitted",
      filledVol: 0,
      filledAvgPrice: 0,
      errorMsg: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  },
  risk_snapshot: () => ({
    equity: 1_000_000,
    cash: 1_000_000,
    marketValue: 0,
    positionPct: 0,
    maxSinglePct: 0,
    maxSingleCode: "",
    totalPnl: 0,
    totalPnlPct: 0,
    floatPnl: 0,
    dayPnl: 0,
    dayPnlPct: 0,
    drawdownPct: 0,
    peakEquity: 0,
    dayDrawdownPct: 0,
    sectorExposure: [],
    marketEmotion: 0,
    indexChg: 0,
    systemicRiskLevel: "low",
    stopTriggerCount: 0,
    dailyLossPct: 0,
    consecutiveLosses: 0,
    warnings: [],
    killSwitch: Boolean(fakeBrokerStatus.killSwitch),
    positions: [],
  }),
  broker_query_position: () => ({
    positions: [{ code: "600519", name: "贵州茅台", vol: 1000, avail: 1000 }],
  }),
  // P3-a Copilot：记录最近一次条件单草稿（e2e 断言方向/触发/数量），返回 ConditionalOrder 形状。
  co_create: (a) => {
    const now = Date.now();
    const payload = {
      code: String(a?.code ?? ""),
      name: String(a?.name ?? ""),
      side: String(a?.side ?? "BUY"),
      trigger: (a?.trigger ?? []) as unknown[],
      vol: Number(a?.vol ?? 0),
      priceMode: String(a?.priceMode ?? "trigger"),
      limitPrice: Number(a?.limitPrice ?? 0),
      ttl: String(a?.ttl ?? "day"),
      expireAt: Number(a?.expireAt ?? 0),
      autoConfirm: Boolean(a?.autoConfirm),
      note: String(a?.note ?? ""),
    };
    (window as unknown as { __FAKE_LAST_CO?: unknown }).__FAKE_LAST_CO = payload;
    return {
      id: 9,
      coId: "CO9",
      tradeDate: todayDashed(),
      ...payload,
      status: "active",
      ticketId: "",
      createdAt: now,
      updatedAt: now,
      triggeredAt: 0,
    };
  },
  workflow_get_today: () => null,
  // scope="today"：与 workflow_instructions 返回同一份 fakePlan（既有分支不变）；
  // scope="next"：返回 null（既有分支不变）；
  // 缺省（无 scope）：早盘启发式 → 今日 draft 计划，作战台据此显示「确认今日作战卡」。
  // `window.__FAKE_PLAN_CONFIRMED`（addInitScript 注入）可模拟「计划已确认」以验收盯盘入口。
  workflow_p1_products: (a) => {
    if (a?.scope === "today") {
      return { briefing: null, candidates: [], plan: fakePlan, planConfirmed: true };
    }
    if (a?.scope === "next") {
      return { briefing: null, candidates: [], plan: null, planConfirmed: false };
    }
    const confirmed = Boolean(
      (window as unknown as { __FAKE_PLAN_CONFIRMED?: boolean }).__FAKE_PLAN_CONFIRMED,
    );
    return {
      briefing: null,
      candidates: [],
      plan: confirmed ? { ...fakeTodayPlan, status: "confirmed" } : fakeTodayPlan,
      planConfirmed: confirmed,
    };
  },
  // P1-c 早盘确认：记录参数（e2e 断言 planDate），返回 confirmed 计划 + 计数。
  workflow_plan_confirm: (a) => {
    (window as unknown as { __FAKE_LAST_PLAN_CONFIRM?: unknown }).__FAKE_LAST_PLAN_CONFIRM = a;
    const planDate = String(a?.planDate ?? fakeTodayPlan.planDate);
    return {
      mission: null,
      plan: { ...fakeTodayPlan, planDate, status: "confirmed" },
      alertsCreated: 3,
    };
  },
  // P1-c 确认后启动盯盘：记录参数，返回 running 状态（前端置 watchStarted）。
  workflow_watch_start: (a) => {
    (window as unknown as { __FAKE_LAST_WATCH_START?: unknown }).__FAKE_LAST_WATCH_START = a;
    return { mission: null, watchCount: 3, running: true };
  },
  workflow_p2_products: () => ({ feedback: null, running: false, killSwitch: false }),
  // P1-c 命中率：固定有价样本（12 笔 ≥ 3）→ 作战台头部必须显示三个百分比。
  workflow_hit_rate: () => ({
    days: 20,
    plans: 12,
    instructions: 40,
    triggered: 25,
    triggeredPct: 62,
    executed: 18,
    executedPct: 45,
    wins: 7,
    winPct: 58,
    samples: 12,
    pricedSamples: 12,
  }),
  // P1-a 指令列表：3 条覆盖待触发 / 已触发 / 已成交三种徽标与触发提示解析。
  workflow_instructions: () => ({ plan: fakePlan, instructions: fakeInstructions }),
  // P1-b 行内编辑：记录保存参数，返回「旧条件单作废、按新规则重建」后的指令列表。
  // 只改被编辑的那一行（state 回到待触发，触发价换成新值），其余行原样返回。
  workflow_instruction_trigger_set: (a) => {
    (window as unknown as { __FAKE_LAST_TRIGGER?: unknown }).__FAKE_LAST_TRIGGER = a;
    const instrId = Number(a?.instrId ?? 0);
    const rule = (a?.rule ?? {}) as Record<string, unknown>;
    return {
      plan: fakePlan,
      instructions: fakeInstructions.map((r) => {
        if (Number(r.id) !== instrId) return r;
        const next: Record<string, unknown> = { ...r, state: "pending" };
        if (typeof rule.autoConfirm === "boolean") next.autoConfirm = rule.autoConfirm;
        const upPrice = Number(rule.upPrice);
        if (Number.isFinite(upPrice) && upPrice > 0) {
          next.price = upPrice;
          next.triggerJson = JSON.stringify([{ field: "price", op: "gte", value: upPrice }]);
        }
        return next;
      }),
    };
  },
  // P3-c 指令打标：记录 { instrId, tag }，返回更新了该行 tag 的同一份列表。
  workflow_instruction_tag_set: (a) => {
    (window as unknown as { __FAKE_LAST_TAG?: unknown }).__FAKE_LAST_TAG = a;
    const instrId = Number(a?.instrId ?? 0);
    const tag = String(a?.tag ?? "");
    return {
      plan: fakePlan,
      instructions: fakeInstructions.map((r) =>
        Number(r.id) === instrId ? { ...r, tag } : r,
      ),
    };
  },
  // P1-b 触发后一键下单：记录提交参数（沿用触发时生成的票，不新建第二张），返回 mock 委托。
  broker_confirm_submit: (a) => {
    (window as unknown as { __FAKE_LAST_SUBMIT?: unknown }).__FAKE_LAST_SUBMIT = a;
    const order: BrokerOrderInfo = {
      id: 2,
      sigId: "QK2",
      brokerKind: "mock",
      brokerAccount: "SIM",
      brokerOrderId: "QK2",
      code: "300750",
      side: "BUY",
      price: 189,
      vol: 100,
      status: "submitted",
      filledVol: 0,
      filledAvgPrice: 0,
      errorMsg: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return order;
  },
  // 旧版六步驾驶舱（PilotPanel）挂载即读 pilot_status.today。缺该命令时假后端会回 []，
  // 模板 st?.today.scanCount 会因 st=[] 抛错并触发卡片错误边界（新旧切换用例点不到按钮）。
  pilot_status: () => ({
    mode: "off",
    accountType: "paper",
    virtualCash: 100_000,
    tacticProfileId: 0,
    riskProfile: "steady",
    scheduleEnabled: true,
    todayScanTarget: 15,
    todayScanCount: 0,
    lastScanAt: 0,
    running: false,
    nextScanMinute: 570,
    tradeDate: new Date().toISOString().slice(0, 10),
    updatedAt: Date.now(),
    today: {
      scanCount: 0,
      buyCount: 0,
      sellCount: 0,
      pnlCents: 0,
      assetCents: 10_000_000,
      summary: "",
    },
  }),
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
