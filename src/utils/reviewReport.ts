// v2.32 盯盘复盘报告渲染器（纯函数）：把后端 ai_build_review_report 的数据包
// 渲染成单文件内联 CSS 的 HTML 与 Markdown。只如实呈现本地记录与数据，
// 不生成任何荐股 / 买卖建议措辞；固定附免责声明。
// 无 DOM / Tauri 依赖，可在 vitest 中直接测试。

// ===== 数据包类型（与 src-tauri/src/ai/report.rs 对齐，camelCase）=====

export interface SectorDayRow {
  code: string;
  name: string;
  changePct: number | null;
  netAmount: number | null;
  leadName?: string | null;
  leadPct?: number | null;
}

export interface IndexRow {
  code: string;
  name: string;
  price: number | null;
  pct: number | null;
  amount: number | null;
}

export interface TrendRow {
  day: string;
  limitUp: number | null;
  broken: number | null;
  sentiment: number | null;
}

export interface ThemeLeader {
  code: string;
  name: string;
  role: string;
}

export interface ThemeRow {
  id: number;
  name: string;
  level: string;
  stage: string;
  members: number;
  leaders: ThemeLeader[];
  recentCatalyst?: string | null;
}

export interface CatalystRow {
  kind: string;
  title: string;
  direction: string | null;
  code: string | null;
  theme: string | null;
  ts: number | null;
}

export interface MultiBoardRow {
  code: string;
  name: string;
  boards: number;
  firstSeal: number | null;
  sealFund: number | null;
  broken: number;
  industry: string | null;
}

export interface PositionRow {
  code: string;
  name: string;
  vol: number;
  availVol: number;
  costAmount: number;
}

export interface OrderRow {
  code: string;
  name: string;
  side: string;
  price: number;
  vol: number;
  amount: number;
  fee: number;
  status: string;
  sigId: string;
  realizedPnl: number;
  createdAt: number;
}

export interface AlertEventRow {
  ruleId: string;
  code: string;
  name: string;
  kind: string;
  label: string;
  message: string;
  price: number;
  pct: number;
  tone: string;
  triggeredAt: number;
}

export interface AiReviewRow {
  id: number;
  scope: string;
  subject: string;
  title: string;
  summary: string;
  content: string;
  model: string;
  createdAt: number;
}

export interface PerfSnapshot {
  initCash: number;
  cash: number;
  holdingCost: number;
  costBasisEquity: number;
  dayRealizedPnl: number;
  daySells: number;
  dayWins: number;
  dayWinRate: number;
  positions: PositionRow[];
  valuationNote: string;
}

export interface PlanInstruction {
  tier: string;
  code: string;
  name: string;
  condition: string;
  action: string;
}

export interface PlanPack {
  exists: boolean;
  title?: string;
  marketView?: string;
  instructions: PlanInstruction[];
}

export interface DecisionLogRow {
  code: string;
  name: string;
  label: string;
  confidence: number;
  mode: string;
  action: string;
  features: string;
}

export interface ReviewReportData {
  date: string;
  generatedAt: number;
  market: Record<string, number | null>;
  marketTrend: TrendRow[];
  indices: IndexRow[];
  topIndustryUp: SectorDayRow[];
  topConceptUp: SectorDayRow[];
  topSectorFund: SectorDayRow[];
  activeThemes: ThemeRow[];
  recentCatalysts: CatalystRow[];
  multiBoardStocks: MultiBoardRow[];
  positions: PositionRow[];
  watchCount: number;
  todayPlan: PlanPack;
  todayDecisionLogs: DecisionLogRow[];
  todayOrders: OrderRow[];
  todayAlertEvents: AlertEventRow[];
  aiReviews: AiReviewRow[];
  performance: PerfSnapshot;
  disclaimer: string;
}

// ===== 格式化工具 =====

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 兼容 YYYYMMDD / YYYY-MM-DD，输出 YYYY-MM-DD。 */
export function prettyDate(d: string): string {
  if (!d) return "";
  const m = d.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) return d;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function int(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return Math.round(v).toLocaleString("zh-CN");
}

/** 金额 → 亿 / 万 简写（输入单位：元）。 */
export function money(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${num(v / 1e8)} 亿`;
  if (abs >= 1e4) return `${num(v / 1e4)} 万`;
  return num(v);
}

export function pct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${num(v, digits)}%`;
}

/** 毫秒时间戳 → HH:MM:SS（本地时区）。 */
export function clock(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function signedPnl(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const s = money(v);
  return v > 0 ? `+${s}` : s;
}

// ===== HTML =====

export function escapeHtml(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Cell = string | number | null | undefined;

function htmlTable(headers: string[], rows: Cell[][]): string {
  const head = headers
    .map((h) => `<th>${escapeHtml(h)}</th>`)
    .join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${r
          .map((c) => `<td>${c === null || c === undefined || c === "" ? "—" : escapeHtml(String(c))}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function section(title: string, body: string): string {
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function emptyNote(text: string): string {
  return `<p class="empty">${escapeHtml(text)}</p>`;
}

function marketSection(d: ReviewReportData): string {
  const m = d.market;
  const kv: Array<[string, string]> = [
    ["全市场总数", int(m.total)],
    ["上涨 / 下跌", `${int(m.upCount)} / ${int(m.downCount)}`],
    ["平盘", int(m.flatCount)],
    ["涨停 / 跌停", `${int(m.limitUp)} / ${int(m.limitDown)}`],
    ["炸板数", int(m.broken)],
    ["炸板率", pct(m.brokenRate)],
    ["最高板", int(m.maxBoards)],
    ["平均连板", num(m.avgBoards)],
    ["首板 / 连板", `${int(m.firstBoardCount)} / ${int(m.multiBoardCount)}`],
    ["封板资金合计", money(m.sealFundTotal)],
    ["情绪指标", num(m.sentiment)],
  ];
  const cards = kv
    .map(
      ([k, v]) =>
        `<div class="kv"><span class="kv-k">${escapeHtml(k)}</span><span class="kv-v">${escapeHtml(v)}</span></div>`,
    )
    .join("");
  let trend = "";
  if (d.marketTrend.length) {
    trend = htmlTable(
      ["交易日", "涨停", "炸板", "情绪"],
      d.marketTrend.map((r) => [
        prettyDate(r.day),
        int(r.limitUp),
        int(r.broken),
        num(r.sentiment),
      ]),
    );
  }
  return section("一、市场情绪总览", `<div class="kv-grid">${cards}</div>${trend}`);
}

function indicesSection(d: ReviewReportData): string {
  if (!d.indices.length) return section("二、指数表现", emptyNote("当日无指数快照"));
  return section(
    "二、指数表现",
    htmlTable(
      ["指数", "点位", "涨跌幅", "成交额"],
      d.indices.map((r) => [r.name, num(r.price), pct(r.pct), money(r.amount)]),
    ),
  );
}

function sectorTable(rows: SectorDayRow[], withFund: boolean): string {
  return htmlTable(
    ["板块", "涨跌幅", "主力净额", "领涨股"],
    rows.map((r) => [
      r.name,
      pct(r.changePct),
      withFund ? money(r.netAmount) : "—",
      r.leadName ? `${r.leadName}${r.leadPct !== null && r.leadPct !== undefined ? ` ${pct(r.leadPct)}` : ""}` : "",
    ]),
  );
}

function sectorsSection(d: ReviewReportData): string {
  let body = "";
  body += `<h3>行业涨幅 TOP</h3>${d.topIndustryUp.length ? sectorTable(d.topIndustryUp, false) : emptyNote("暂无数据")}`;
  body += `<h3>概念涨幅 TOP</h3>${d.topConceptUp.length ? sectorTable(d.topConceptUp, false) : emptyNote("暂无数据")}`;
  body += `<h3>主力资金净流入 TOP</h3>${d.topSectorFund.length ? sectorTable(d.topSectorFund, true) : emptyNote("暂无数据")}`;
  if (d.activeThemes.length) {
    body +=
      "<h3>活跃题材</h3>" +
      htmlTable(
        ["题材", "阶段", "级别", "成分数", "龙头", "近期催化"],
        d.activeThemes.map((t) => [
          t.name,
          t.stage,
          t.level,
          int(t.members),
          t.leaders.map((l) => `${l.name}(${l.role})`).join("、"),
          t.recentCatalyst ?? "",
        ]),
      );
  }
  return section("三、板块与题材", body);
}

function catalystsSection(d: ReviewReportData): string {
  if (!d.recentCatalysts.length)
    return section("四、近期催化剂", emptyNote("当日无催化剂记录"));
  return section(
    "四、近期催化剂",
    htmlTable(
      ["类型", "标题", "方向", "关联", "题材", "时间"],
      d.recentCatalysts.map((r) => [
        r.kind,
        r.title,
        r.direction,
        r.code ?? "",
        r.theme ?? "",
        clock(r.ts),
      ]),
    ),
  );
}

function multiboardSection(d: ReviewReportData): string {
  if (!d.multiBoardStocks.length)
    return section("五、连板股定格", emptyNote("当日无连板（≥2板）个股"));
  return section(
    "五、连板股定格",
    htmlTable(
      ["代码", "名称", "连板", "首封时间", "封单额", "炸板", "行业"],
      d.multiBoardStocks.map((r) => [
        r.code,
        r.name,
        `${int(r.boards)}板`,
        clock(r.firstSeal),
        money(r.sealFund),
        r.broken > 0 ? "是" : "否",
        r.industry,
      ]),
    ),
  );
}

function tradingSection(d: ReviewReportData): string {
  const p = d.performance;
  const kv: Array<[string, string]> = [
    ["初始资金", money(p.initCash)],
    ["可用现金", money(p.cash)],
    ["持仓成本", money(p.holdingCost)],
    ["成本口径权益", money(p.costBasisEquity)],
    ["当日已实现盈亏", signedPnl(p.dayRealizedPnl)],
    ["当日卖出笔数", int(p.daySells)],
    ["盈利笔数", int(p.dayWins)],
    ["当日胜率", pct(p.dayWinRate)],
  ];
  const cards = kv
    .map(
      ([k, v]) =>
        `<div class="kv"><span class="kv-k">${escapeHtml(k)}</span><span class="kv-v">${escapeHtml(v)}</span></div>`,
    )
    .join("");
  let orders = "";
  if (d.todayOrders.length) {
    orders = htmlTable(
      ["代码", "名称", "方向", "价格", "数量", "金额", "费用", "状态", "已实现盈亏", "信号", "时间"],
      d.todayOrders.map((r) => [
        r.code,
        r.name,
        r.side === "buy" ? "买入" : r.side === "sell" ? "卖出" : r.side,
        num(r.price),
        int(r.vol),
        money(r.amount),
        num(r.fee),
        r.status,
        signedPnl(r.realizedPnl),
        r.sigId,
        clock(r.createdAt),
      ]),
    );
  } else {
    orders = emptyNote("当日无成交流水");
  }
  return section(
    "六、我的交易与绩效",
    `<div class="kv-grid">${cards}</div>
     <p class="note">${escapeHtml(p.valuationNote)}</p>
     <h3>当日成交流水</h3>${orders}`,
  );
}

function alertsSection(d: ReviewReportData): string {
  if (!d.todayAlertEvents.length)
    return section("七、预警触发记录", emptyNote("当日无预警触发"));
  return section(
    "七、预警触发记录",
    htmlTable(
      ["时间", "代码", "名称", "类型", "标签", "价格", "涨跌幅", "内容"],
      d.todayAlertEvents.map((r) => [
        clock(r.triggeredAt),
        r.code,
        r.name,
        r.kind,
        r.label,
        num(r.price),
        pct(r.pct),
        r.message,
      ]),
    ),
  );
}

function reviewsSection(d: ReviewReportData): string {
  if (!d.aiReviews.length)
    return section("八、AI 复盘记录", emptyNote("当日无 AI 复盘全文"));
  const body = d.aiReviews
    .map(
      (r) =>
        `<article class="review">
          <h3>[${escapeHtml(r.scope)}] ${escapeHtml(r.subject)}${r.title ? ` · ${escapeHtml(r.title)}` : ""}</h3>
          <div class="meta">模型：${escapeHtml(r.model || "—")} ｜ ${clock(r.createdAt)}</div>
          ${r.summary ? `<p class="summary">${escapeHtml(r.summary)}</p>` : ""}
          <pre class="content">${escapeHtml(r.content)}</pre>
        </article>`,
    )
    .join("");
  return section("八、AI 复盘记录", body);
}

function planSection(d: ReviewReportData): string {
  const p = d.todayPlan;
  if (!p.exists) return section("九、当日作战计划", emptyNote("当日未建立作战计划"));
  const body =
    (p.marketView ? `<p class="summary">${escapeHtml(p.marketView)}</p>` : "") +
    htmlTable(
      ["层级", "代码", "名称", "触发条件", "动作"],
      p.instructions.map((i) => [i.tier, i.code, i.name, i.condition, i.action]),
    );
  return section("九、当日作战计划", body);
}

function decisionLogsSection(d: ReviewReportData): string {
  if (!d.todayDecisionLogs.length)
    return section("十、决策日志", emptyNote("当日无快脑决策记录"));
  return section(
    "十、决策日志",
    htmlTable(
      ["代码", "名称", "标签", "置信度", "模式", "动作"],
      d.todayDecisionLogs.map((r) => [
        r.code,
        r.name,
        r.label,
        pct(r.confidence * 100),
        r.mode,
        r.action,
      ]),
    ),
  );
}

const HTML_STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px; background:#f4f1e8; color:#23201a;
    font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif; font-size:14px; line-height:1.6; }
  .wrap { max-width:980px; margin:0 auto; }
  header.report { border-bottom:3px solid #c9a24a; padding-bottom:16px; margin-bottom:8px; }
  header.report h1 { margin:0 0 6px; font-size:26px; color:#1a1508; }
  header.report .sub { color:#6b6355; font-size:13px; }
  .disclaimer { background:#fdf6e3; border:1px solid #e0c674; border-radius:10px;
    padding:14px 18px; margin:18px 0; color:#7a5b14; font-weight:600; }
  section { background:#fffdf7; border:1px solid #e7e0cf; border-radius:12px;
    padding:20px 24px; margin:16px 0; }
  h2 { font-size:18px; margin:0 0 14px; color:#1a1508; }
  h3 { font-size:14px; margin:18px 0 8px; color:#4a4436; }
  .kv-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:10px; }
  .kv { display:flex; flex-direction:column; gap:2px; background:#f7f3e8;
    border:1px solid #ece5d2; border-radius:8px; padding:9px 12px; }
  .kv-k { font-size:11px; color:#8a8170; }
  .kv-v { font-size:16px; font-weight:700; color:#1a1508; }
  table { width:100%; border-collapse:collapse; margin:6px 0; font-size:12.5px; }
  th,td { text-align:left; padding:7px 10px; border-bottom:1px solid #efe9d9; vertical-align:top; }
  th { background:#f7f3e8; color:#5a5344; font-weight:600; white-space:nowrap; }
  tr:hover td { background:#fbf8ef; }
  .note,.meta { color:#8a8170; font-size:12px; }
  .empty { color:#a39b88; font-style:italic; }
  .summary { background:#f7f3e8; border-radius:8px; padding:10px 14px; }
  pre.content { white-space:pre-wrap; word-break:break-word; font-family:inherit;
    background:#faf7ee; border:1px solid #efe9d9; border-radius:8px; padding:12px 14px; margin:8px 0; }
  footer { text-align:center; color:#a39b88; font-size:12px; margin:24px 0 8px; }
`;

export function renderHtml(d: ReviewReportData): string {
  const generated = new Date(d.generatedAt);
  const head = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TickGold 盯盘复盘报告 ${escapeHtml(prettyDate(d.date))}</title>
<style>${HTML_STYLE}</style></head><body><div class="wrap">
<header class="report">
  <h1>TickGold 盯盘复盘报告</h1>
  <div class="sub">交易日：${escapeHtml(prettyDate(d.date))} ｜ 生成时间：${escapeHtml(generated.toLocaleString("zh-CN"))} ｜ 自选股：${int(d.watchCount)}</div>
</header>
<div class="disclaimer">${escapeHtml(d.disclaimer)}</div>`;
  const foot = `<footer>本报告由 TickGold 依据本地数据自动生成，仅用于个人盯盘记录与复盘。</footer>
</div></body></html>`;
  return (
    head +
    marketSection(d) +
    indicesSection(d) +
    sectorsSection(d) +
    catalystsSection(d) +
    multiboardSection(d) +
    tradingSection(d) +
    alertsSection(d) +
    reviewsSection(d) +
    planSection(d) +
    decisionLogsSection(d) +
    foot
  );
}

// ===== Markdown =====

function mdCell(s: Cell): string {
  return String(s ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
}

function mdTable(headers: string[], rows: Cell[][]): string {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`).join("\n");
  return [head, sep, body].filter(Boolean).join("\n");
}

export function renderMarkdown(d: ReviewReportData): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push(`# TickGold 盯盘复盘报告`);
  push();
  push(`- 交易日：**${prettyDate(d.date)}**`);
  push(`- 生成时间：${new Date(d.generatedAt).toLocaleString("zh-CN")}`);
  push(`- 自选股数量：${int(d.watchCount)}`);
  push();
  push(`> ${d.disclaimer}`);
  push();

  push(`## 一、市场情绪总览`);
  push();
  const m = d.market;
  push(`- 全市场：${int(m.total)}；上涨 ${int(m.upCount)} / 下跌 ${int(m.downCount)}；平盘 ${int(m.flatCount)}`);
  push(`- 涨停 ${int(m.limitUp)} / 跌停 ${int(m.limitDown)}；炸板 ${int(m.broken)}（炸板率 ${pct(m.brokenRate)}）`);
  push(`- 最高板 ${int(m.maxBoards)}；平均连板 ${num(m.avgBoards)}；首板 ${int(m.firstBoardCount)} / 连板 ${int(m.multiBoardCount)}`);
  push(`- 封板资金合计 ${money(m.sealFundTotal)}；情绪指标 ${num(m.sentiment)}`);
  push();
  if (d.marketTrend.length) {
    push(mdTable(["交易日", "涨停", "炸板", "情绪"], d.marketTrend.map((r) => [
      prettyDate(r.day), int(r.limitUp), int(r.broken), num(r.sentiment),
    ])));
    push();
  }

  push(`## 二、指数表现`);
  push();
  if (d.indices.length) {
    push(mdTable(["指数", "点位", "涨跌幅", "成交额"], d.indices.map((r) => [
      r.name, num(r.price), pct(r.pct), money(r.amount),
    ])));
  } else {
    push("_当日无指数快照_");
  }
  push();

  push(`## 三、板块与题材`);
  push();
  const mdSector = (title: string, rows: SectorDayRow[], withFund: boolean) => {
    push(`### ${title}`);
    push();
    if (rows.length) {
      push(mdTable(["板块", "涨跌幅", "主力净额", "领涨股"], rows.map((r) => [
        r.name,
        pct(r.changePct),
        withFund ? money(r.netAmount) : "—",
        r.leadName ? `${r.leadName}${r.leadPct !== null && r.leadPct !== undefined ? ` ${pct(r.leadPct)}` : ""}` : "",
      ])));
    } else {
      push("_暂无数据_");
    }
    push();
  };
  mdSector("行业涨幅 TOP", d.topIndustryUp, false);
  mdSector("概念涨幅 TOP", d.topConceptUp, false);
  mdSector("主力资金净流入 TOP", d.topSectorFund, true);
  if (d.activeThemes.length) {
    push(`### 活跃题材`);
    push();
    push(mdTable(["题材", "阶段", "级别", "成分数", "龙头", "近期催化"], d.activeThemes.map((t) => [
      t.name, t.stage, t.level, int(t.members),
      t.leaders.map((l) => `${l.name}(${l.role})`).join("、"),
      t.recentCatalyst ?? "",
    ])));
    push();
  }

  push(`## 四、近期催化剂`);
  push();
  if (d.recentCatalysts.length) {
    push(mdTable(["类型", "标题", "方向", "关联", "题材", "时间"], d.recentCatalysts.map((r) => [
      r.kind, r.title, r.direction ?? "", r.code ?? "", r.theme ?? "", clock(r.ts),
    ])));
  } else {
    push("_当日无催化剂记录_");
  }
  push();

  push(`## 五、连板股定格`);
  push();
  if (d.multiBoardStocks.length) {
    push(mdTable(["代码", "名称", "连板", "首封时间", "封单额", "炸板", "行业"], d.multiBoardStocks.map((r) => [
      r.code, r.name, `${int(r.boards)}板`, clock(r.firstSeal),
      money(r.sealFund), r.broken > 0 ? "是" : "否", r.industry ?? "",
    ])));
  } else {
    push("_当日无连板（≥2板）个股_");
  }
  push();

  push(`## 六、我的交易与绩效`);
  push();
  const p = d.performance;
  push(`- 初始资金 ${money(p.initCash)}；可用现金 ${money(p.cash)}`);
  push(`- 持仓成本 ${money(p.holdingCost)}；成本口径权益 ${money(p.costBasisEquity)}`);
  push(`- 当日已实现盈亏 ${signedPnl(p.dayRealizedPnl)}；卖出 ${int(p.daySells)} 笔，盈利 ${int(p.dayWins)} 笔，胜率 ${pct(p.dayWinRate)}`);
  push(`- ${p.valuationNote}`);
  push();
  if (d.todayOrders.length) {
    push(mdTable(["代码", "名称", "方向", "价格", "数量", "金额", "状态", "已实现盈亏", "时间"], d.todayOrders.map((r) => [
      r.code, r.name, r.side === "buy" ? "买入" : r.side === "sell" ? "卖出" : r.side,
      num(r.price), int(r.vol), money(r.amount), r.status,
      signedPnl(r.realizedPnl), clock(r.createdAt),
    ])));
  } else {
    push("_当日无成交流水_");
  }
  push();

  push(`## 七、预警触发记录`);
  push();
  if (d.todayAlertEvents.length) {
    push(mdTable(["时间", "代码", "名称", "类型", "标签", "价格", "涨跌幅", "内容"], d.todayAlertEvents.map((r) => [
      clock(r.triggeredAt), r.code, r.name, r.kind, r.label,
      num(r.price), pct(r.pct), r.message,
    ])));
  } else {
    push("_当日无预警触发_");
  }
  push();

  push(`## 八、AI 复盘记录`);
  push();
  if (d.aiReviews.length) {
    for (const r of d.aiReviews) {
      push(`### [${r.scope}] ${r.subject}${r.title ? ` · ${r.title}` : ""}`);
      push();
      push(`- 模型：${r.model || "—"} ｜ ${clock(r.createdAt)}`);
      push();
      if (r.summary) {
        push(r.summary);
        push();
      }
      push("```");
      push(r.content);
      push("```");
      push();
    }
  } else {
    push("_当日无 AI 复盘全文_");
    push();
  }

  push(`## 九、当日作战计划`);
  push();
  if (d.todayPlan.exists) {
    if (d.todayPlan.marketView) {
      push(d.todayPlan.marketView);
      push();
    }
    push(mdTable(["层级", "代码", "名称", "触发条件", "动作"], d.todayPlan.instructions.map((i) => [
      i.tier, i.code, i.name, i.condition, i.action,
    ])));
  } else {
    push("_当日未建立作战计划_");
  }
  push();

  push(`## 十、决策日志`);
  push();
  if (d.todayDecisionLogs.length) {
    push(mdTable(["代码", "名称", "标签", "置信度", "模式", "动作"], d.todayDecisionLogs.map((r) => [
      r.code, r.name, r.label, pct(r.confidence * 100), r.mode, r.action,
    ])));
  } else {
    push("_当日无快脑决策记录_");
  }
  push();

  return lines.join("\n");
}
