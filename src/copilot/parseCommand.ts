// P3-a Copilot：自然语言 → 条件单草稿的纯规则解析。
// 无 Vue / Tauri / DOM 依赖，可直接在 Node 单测；只产出草稿，创建条件单由 UI 确认后调 coCreate。
import type { CoTriggerLeaf } from "../broker/co";

export type CopilotSide = "BUY" | "SELL";

export interface CopilotDraft {
  /** 6 位代码（已去掉 sh/sz 前缀）。 */
  code: string;
  /** 名称由 UI 从行情缓存补全；解析层不猜名称。 */
  name?: string;
  side: CopilotSide;
  vol: number;
  trigger: CoTriggerLeaf[];
  summary: string;
}

export type CopilotParseResult =
  | { ok: true; draft: CopilotDraft }
  | { ok: false; error: string };

// 中文错误是 UI 契约的一部分（单测 / e2e 按文案断言），不要随手改。
export const COPILOT_ERRORS = {
  code: "请输入 6 位股票代码",
  side: "请说明买入还是卖出",
  trigger: "请给出触发价格或涨跌幅",
  vol: "数量必须为 100 股整数倍",
} as const;

// 6 位代码，可带 sh/sz 前缀（大小写不限）；前后不能紧邻其它数字，避免截断长数字串。
const CODE_RE = /(?<!\d)(?:sh|sz)?(\d{6})(?!\d)/i;

const BUY_RE = /买入|买|加仓/;
const SELL_RE = /卖出|卖|减仓|止盈|止损/;

interface TriggerPattern {
  op: "gte" | "lte";
  re: RegExp;
}

// 价格触发：跌破/低于/≤/<= → lte；涨到/突破/高于/≥/>= → gte。
const PRICE_PATTERNS: readonly TriggerPattern[] = [
  { op: "lte", re: /(?:跌破|低于|≤|<=)\s*(\d+(?:\.\d+)?)/ },
  { op: "gte", re: /(?:涨到|突破|高于|≥|>=)\s*(\d+(?:\.\d+)?)/ },
];

// 涨跌幅触发必须带 %（否则「跌破1680」会被误判成跌幅）；lte 落库为负数，与 pct 字段语义一致。
const PCT_PATTERNS: readonly TriggerPattern[] = [
  { op: "gte", re: /(?:涨幅|涨)\s*([+-]?\d+(?:\.\d+)?)\s*[%％]/ },
  { op: "lte", re: /(?:跌幅|跌)\s*([+-]?\d+(?:\.\d+)?)\s*[%％]/ },
];

const VOL_RE = /(\d+(?:\.\d+)?)\s*(手|股)/;

// 全角数字/符号归一化，避免「６００５１９」这类输入直接报错。
function normalize(input: string): string {
  return String(input ?? "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/＋/g, "+")
    .replace(/－/g, "-")
    .replace(/．/g, ".")
    .replace(/％/g, "%")
    .replace(/\u3000/g, " ");
}

function findCode(text: string): string {
  const m = CODE_RE.exec(text);
  return m ? m[1] : "";
}

/** 方向：同时出现买/卖时取先出现的那个（v1 不做冲突裁决）。 */
function findSide(text: string): CopilotSide | null {
  const buy = text.search(BUY_RE);
  const sell = text.search(SELL_RE);
  if (buy < 0 && sell < 0) return null;
  if (buy < 0) return "SELL";
  if (sell < 0) return "BUY";
  return buy <= sell ? "BUY" : "SELL";
}

/** 在同类写法里取最先出现的一个（避免一句话里多个同类触发被 AND 成不可能条件）。 */
function firstHit(
  patterns: readonly TriggerPattern[],
  text: string,
): { op: "gte" | "lte"; value: number } | null {
  let best: { op: "gte" | "lte"; value: number; index: number } | null = null;
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (!m) continue;
    const value = Number(m[1]);
    if (!Number.isFinite(value)) continue;
    if (!best || m.index < best.index) best = { op: p.op, value, index: m.index };
  }
  return best ? { op: best.op, value: best.value } : null;
}

function findPriceLeaf(text: string): CoTriggerLeaf | null {
  const hit = firstHit(PRICE_PATTERNS, text);
  if (!hit || !(hit.value > 0)) return null;
  return { field: "price", op: hit.op, value: hit.value };
}

function findPctLeaf(text: string): CoTriggerLeaf | null {
  const hit = firstHit(PCT_PATTERNS, text);
  if (!hit) return null;
  const pct = Math.abs(hit.value);
  if (!(pct > 0)) return null;
  // 「跌幅3%」= 涨跌幅 ≤ -3%，不能落成 ≤ 3（否则 +2% 也会触发）。
  return { field: "pct", op: hit.op, value: hit.op === "lte" ? -pct : pct };
}

function findVol(text: string): { vol: number } | { error: string } {
  const m = VOL_RE.exec(text);
  if (!m) return { vol: 100 };
  const n = Number(m[1]);
  const shares = m[2] === "手" ? n * 100 : n;
  if (!Number.isFinite(shares) || shares <= 0 || !Number.isInteger(shares) || shares % 100 !== 0) {
    return { error: COPILOT_ERRORS.vol };
  }
  return { vol: shares };
}

function buildSummary(code: string, side: CopilotSide, vol: number, leaf: CoTriggerLeaf): string {
  const sideText = side === "BUY" ? "买入" : "卖出";
  const opText = leaf.op === "gte" ? "≥" : "≤";
  const value = leaf.value.toFixed(2);
  const trig = leaf.field === "pct" ? `涨跌幅 ${opText}${value}%` : `价格 ${opText}${value}`;
  return `${code} · ${sideText} ${vol} 股 · ${trig}`;
}

/**
 * 解析一句话为条件单草稿。
 * 语法 v1：代码 + 方向 + 触发（价格或涨跌幅，价格优先）+ 数量（缺省 100 股）。
 * 失败返回中文错误，不产生草稿。
 */
export function parseCommand(input: string): CopilotParseResult {
  const text = normalize(input).trim();

  const code = findCode(text);
  if (!code) return { ok: false, error: COPILOT_ERRORS.code };

  const side = findSide(text);
  if (!side) return { ok: false, error: COPILOT_ERRORS.side };

  // 价格优先：同时给出价格与涨跌幅时只保留价格叶子（与物化方向互斥规则一致）。
  const leaf = findPriceLeaf(text) ?? findPctLeaf(text);
  if (!leaf) return { ok: false, error: COPILOT_ERRORS.trigger };

  const vol = findVol(text);
  if ("error" in vol) return { ok: false, error: vol.error };

  return {
    ok: true,
    draft: {
      code,
      side,
      vol: vol.vol,
      trigger: [leaf],
      summary: buildSummary(code, side, vol.vol, leaf),
    },
  };
}
