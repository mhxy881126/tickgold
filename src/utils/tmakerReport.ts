/**
 * P3-6 做T盘后日报渲染器（纯函数，复用 reviewReport 的 HTML 风格）。
 * 输入当日做T台账 + 信号质量 + 寻优建议 → 可直接下载/打开的 HTML 日报。
 * 不做任何 I/O，方便单测。
 */
import type { TmakerRecordRow } from "../broker/api";
import type { SignalLogStats } from "../composables/tmaker/signalLog";

/** 日报可消费的一笔做T成交（兼容前端 TRecord 与 SQL 台账行） */
export interface TReportRecord {
  tradeDate?: string;  // YYYY-MM-DD（可选：前端内存记录无此字段）
  code: string;
  name: string;
  type: "long" | "short";
  vol: number;
  openPrice: number;
  closePrice: number;
  pnl: number;         // 元（毛利-开仓费-平仓费）
  fee: number;         // 元（往返费用）
  openTime: number;    // ms 或当日分钟数
  closeTime: number;   // ms 或当日分钟数
}

export interface ReportBtHint {
  count: number;
  winRate: number;       // %
  breakEven: number;     // % 保本胜率
  avgPnl: number;        // 元
  profitFactor: number;
  maxDrawdown: number;   // 元
}

export interface TmakerReportInput {
  date: string;                    // YYYYMMDD
  records: TReportRecord[];        // 当日做T台账
  signalStats: SignalLogStats | null;
  bt: ReportBtHint | null;
  optHint: string | null;          // 寻优建议摘要（如 "开75 止1.0% 倍1.5 日2"）
  forcedThresholdMin?: number;     // 平仓时间 >= 该分钟数视为强平，默认 14:45 → 885
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtMoney(cents: number): string {
  const y = cents / 100;
  return `${y >= 0 ? "+" : ""}${y.toFixed(2)} 元`;
}

/** 把时间戳（ms 或当日分钟数）统一换算为当日分钟数（9:30=570 基准的绝对分钟） */
function toMin(msOrMin: number): number {
  if (msOrMin >= 100_000_000_000) {
    const d = new Date(msOrMin);
    return d.getHours() * 60 + d.getMinutes();
  }
  return msOrMin;
}

function fmtTime(msOrMin: number): string {
  const total = toMin(msOrMin) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const HTML_STYLE = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0b0e14; color: #dfe4ef; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 13px; }
.wrap { max-width: 860px; margin: 0 auto; padding: 18px 22px 30px; }
header.report h1 { font-size: 20px; color: #ffd166; letter-spacing: 1px; }
.sub { color: #8b94a8; margin: 6px 0 12px; font-size: 12px; }
h2 { font-size: 14px; color: #7aa2f7; margin: 18px 0 8px; border-left: 3px solid #7aa2f7; padding-left: 8px; }
.overview { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 10px 0; }
.ov { background: #141926; border: 1px solid #232a3b; border-radius: 8px; padding: 10px 12px; }
.ov b { display: block; font-size: 18px; font-family: Consolas, monospace; margin-top: 2px; }
.ov span { color: #8b94a8; font-size: 11px; }
.up { color: #ff5f56; } .down { color: #2ec27e; }
table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; }
th { text-align: left; color: #8b94a8; font-weight: 500; padding: 5px 6px; border-bottom: 1px solid #2a3245; }
td { padding: 4px 6px; border-bottom: 1px solid #1b2232; font-family: Consolas, monospace; }
.rule li { margin: 4px 0; list-style: none; padding: 4px 8px; background: #141926; border-radius: 5px; font-size: 12px; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11px; }
.badge-red { background: rgba(255,95,86,.15); color: #ff5f56; }
.badge-green { background: rgba(46,194,126,.15); color: #2ec27e; }
.badge-gray { background: rgba(139,148,168,.15); color: #8b94a8; }
footer { text-align: center; color: #4a5265; font-size: 11px; margin: 22px 0 8px; }
`;

export function buildTmakerReportHtml(d: TmakerReportInput): string {
  const forcedTh = d.forcedThresholdMin ?? 885; // 14:45
  const forced = d.records.filter((r) => toMin(r.closeTime) >= forcedTh);
  const pnlSum = d.records.reduce((s, r) => s + r.pnl, 0);
  const feeSum = d.records.reduce((s, r) => s + r.fee, 0);
  const wins = d.records.filter((r) => r.pnl > 0).length;
  const winRate = d.records.length ? (wins / d.records.length) * 100 : 0;
  const longCount = d.records.filter((r) => r.type === "long").length;
  const shortCount = d.records.length - longCount;

  // 信号质量（若当日有可评估信号）
  let sigHtml = `<div class="rule"><li class="badge badge-gray">暂无当日信号评估样本（需累计留痕 + 收盘归档）</li></div>`;
  if (d.signalStats && d.signalStats.evaluated > 0) {
    const s = d.signalStats;
    sigHtml = `<div class="rule">
      <li>可评估信号 <b>${s.evaluated}</b> 次 ｜ 30min 命中率 <b class="${s.hitRate >= 50 ? "up" : "down"}">${s.hitRate.toFixed(0)}%</b> ｜ 止损触发率 ${s.stoppedRate.toFixed(0)}%</li>
      <li>平均 15min MFE <b class="up">${s.avgMfe15.toFixed(2)}%</b> / MAE <b class="down">${s.avgMae15.toFixed(2)}%</b></li>
      <li>正T ${s.long.count} 次（${s.long.hitRate.toFixed(0)}% 命中） ｜ 倒T ${s.short.count} 次（${s.short.hitRate.toFixed(0)}% 命中）</li>
    </div>`;
  }

  // 回测对照（保本胜率红线）
  let btHtml = `<div class="rule"><li class="badge badge-gray">暂无回测对照（样本不足或未跑）</li></div>`;
  if (d.bt) {
    const b = d.bt;
    const ok = b.winRate >= b.breakEven;
    btHtml = `<div class="rule">
      <li>回测 ${b.count} 笔 ｜ 胜率 <b class="${ok ? "up" : "down"}">${b.winRate.toFixed(0)}%</b> vs 保本需 <b>${b.breakEven.toFixed(0)}%</b> ${ok ? "✅" : "⚠️ 未过成本线"}</li>
      <li>单笔期望 ${b.avgPnl.toFixed(1)} 元 ｜ 盈亏比 ${b.profitFactor.toFixed(2)} ｜ 最大回撤 ${b.maxDrawdown.toFixed(0)} 元</li>
      ${d.optHint ? `<li>次日参数建议：<b>${esc(d.optHint)}</b></li>` : ""}
    </div>`;
  }

  const rows = d.records.map((r) => {
    const pnl = r.pnl;
    return `<tr>
      <td>${esc(r.tradeDate ?? d.date)}</td>
      <td>${esc(r.code)} ${esc(r.name)}</td>
      <td><span class="badge ${r.type === "long" ? "badge-green" : "badge-red"}">${r.type === "long" ? "正T" : "倒T"}</span></td>
      <td>${fmtTime(r.openTime)}</td>
      <td>${fmtTime(r.closeTime)}</td>
      <td>${r.openPrice.toFixed(2)} → ${r.closePrice.toFixed(2)}</td>
      <td>${r.vol}</td>
      <td>${r.fee.toFixed(2)}</td>
      <td class="${pnl >= 0 ? "up" : "down"}">${fmtMoney(pnl * 100)}</td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>做T日报 ${esc(d.date)}</title><style>${HTML_STYLE}</style></head>
<body><div class="wrap">
<header class="report">
  <h1>做T日报</h1>
  <div class="sub">交易日：${esc(d.date)} ｜ 生成时间：${new Date().toLocaleString("zh-CN")} ｜ 模拟盘口径</div>
</header>
<div class="overview">
  <div class="ov"><span>当日笔数</span><b>${d.records.length}</b></div>
  <div class="ov"><span>胜率</span><b class="${winRate >= 50 ? "up" : "down"}">${winRate.toFixed(0)}%</b></div>
  <div class="ov"><span>净盈亏（费后）</span><b class="${pnlSum >= 0 ? "up" : "down"}">${(pnlSum / 100).toFixed(0)}</b></div>
  <div class="ov"><span>费用合计</span><b>${(feeSum / 100).toFixed(1)}</b></div>
</div>
<div class="rule"><li>正T ${longCount} 笔 / 倒T ${shortCount} 笔 ｜ 尾盘强平 <b class="${forced.length ? "badge badge-red" : ""}">${forced.length}</b> 笔（≥14:45 平仓视为计划外）</li></div>

<h2>一、逐笔回放</h2>
${d.records.length ? `<table>
  <tr><th>日期</th><th>标的</th><th>方向</th><th>开仓</th><th>平仓</th><th>价格</th><th>数量</th><th>费用(元)</th><th>盈亏</th></tr>
  ${rows}
</table>` : `<div class="rule"><li class="badge badge-gray">当日无做T成交</li></div>`}

<h2>二、纪律检查</h2>
<div class="rule">
  <li>尾盘强平 ${forced.length} 笔 —— ${forced.length > 2 ? "⚠️ 超过 2 笔需复盘：是否开仓过晚 / 目标过高 / 未盯盘？" : "在容忍范围"}</li>
  <li>费用合计 ${(feeSum / 100).toFixed(2)} 元 —— 每笔往返成本参考：${feeSum && d.records.length ? ((feeSum / d.records.length) / 100).toFixed(2) : "—"} 元/笔</li>
</div>

<h2>三、信号质量</h2>
${sigHtml}

<h2>四、回测对照与次日参数建议</h2>
${btHtml}

<footer>本报告由 TickGold 依据本地数据自动生成，模拟盘口径；A股 T+1 实盘正T需隔日闭环，结果仅供参数参考。</footer>
</div></body></html>`;
}

/** Markdown 版（给需要贴文本的场景） */
export function buildTmakerReportMarkdown(d: TmakerReportInput): string {
  const forcedTh = d.forcedThresholdMin ?? 885;
  const forced = d.records.filter((r) => toMin(r.closeTime) >= forcedTh);
  const pnlSum = d.records.reduce((s, r) => s + r.pnl, 0);
  const wins = d.records.filter((r) => r.pnl > 0).length;
  const lines: string[] = [];
  lines.push(`# 做T日报 ${d.date}`);
  lines.push(`- 笔数：${d.records.length}｜胜率：${d.records.length ? ((wins / d.records.length) * 100).toFixed(0) : 0}%｜净盈亏（费后）：${pnlSum.toFixed(2)} 元｜强平：${forced.length} 笔`);
  if (d.signalStats && d.signalStats.evaluated > 0) {
    lines.push(`- 信号质量：${d.signalStats.evaluated} 次可评估｜30min 命中 ${d.signalStats.hitRate.toFixed(0)}%｜MFE ${d.signalStats.avgMfe15.toFixed(2)}% / MAE ${d.signalStats.avgMae15.toFixed(2)}%`);
  }
  if (d.bt) {
    lines.push(`- 回测 ${d.bt.count} 笔：胜率 ${d.bt.winRate.toFixed(0)}% vs 保本需 ${d.bt.breakEven.toFixed(0)}%｜单笔期望 ${d.bt.avgPnl.toFixed(1)} 元｜盈亏比 ${d.bt.profitFactor.toFixed(2)}`);
  }
  return lines.join("\n");
}
