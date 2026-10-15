// ===== 智能分组 v2：选股问句解析 + 条件求值（同花顺式动态选股） =====

/** 筛选条件：字段 + 运算符 + 数值 */
export interface QueryCondition {
  field: string;
  op: ">=" | "<=" | "==";
  value: number;
}

/** v2 规则：候选范围取榜单位（涨幅/成交额/换手三榜并集），本地按条件过滤 */
export interface SmartQueryRule {
  version: 2;
  logic: "AND" | "OR";
  conditions: QueryCondition[];
}

/** 指标字段元信息（条件编辑器用） */
export interface FieldMeta {
  key: string;
  label: string;
  unit: string;
  hint?: string;
}
export interface FieldGroup {
  label: string;
  fields: FieldMeta[];
}

export const FIELD_GROUPS: FieldGroup[] = [
  {
    label: "估值",
    fields: [
      { key: "pe", label: "市盈率", unit: "倍", hint: "亏损股为负，可筛 >0" },
      { key: "pb", label: "市净率", unit: "倍" },
      { key: "total_mv", label: "总市值", unit: "亿" },
      { key: "circ_mv", label: "流通市值", unit: "亿" },
    ],
  },
  {
    label: "行情",
    fields: [
      { key: "pct", label: "涨跌幅", unit: "%" },
      { key: "price", label: "现价", unit: "元" },
      { key: "amount", label: "成交额", unit: "亿" },
      { key: "volume", label: "成交量", unit: "万手" },
    ],
  },
  {
    label: "资金",
    fields: [
      { key: "turnover", label: "换手率", unit: "%" },
      { key: "volume_ratio", label: "量比", unit: "" },
    ],
  },
  {
    label: "特色",
    fields: [
      { key: "boards", label: "连板数", unit: "板", hint: "来自近 5 日涨停记录，非涨停股为 0" },
    ],
  },
];

export const FIELD_META: Record<string, FieldMeta> = Object.fromEntries(
  FIELD_GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f]))
);

/** 问句 → 条件 的关键词表（按序匹配，先长词后短词避免误吞） */
const FIELD_SYNONYMS: { re: RegExp; key: string }[] = [
  { re: /流通市值/, key: "circ_mv" },
  { re: /总市值/, key: "total_mv" },
  { re: /市盈率|PE/i, key: "pe" },
  { re: /市净率|PB/i, key: "pb" },
  { re: /换手率/, key: "turnover" },
  { re: /量比/, key: "volume_ratio" },
  { re: /涨跌幅|涨幅|跌幅/, key: "pct" },
  { re: /成交额/, key: "amount" },
  { re: /成交量/, key: "volume" },
  { re: /连板/, key: "boards" },
  { re: /现价|股价|价格/, key: "price" },
];

const OP_LE: RegExp[] = [/不高于/, /不超过/, /不大于/, /低于/, /小于/, /以下/, /≤/, /<(?!\d)/];
const OP_GE: RegExp[] = [/不低于/, /不小于/, /高于/, /大于/, /超过/, /以上/, /≥/, />(?!\d)/];
const OP_EQ: RegExp[] = [/等于/, /≈/];

const LOGIC_AND = /且|并且|同时|、|，|,|；/;
const LOGIC_OR = /或|或者/;

export interface ParseResult {
  conditions: QueryCondition[];
  logic: "AND" | "OR";
  /** 未能识别的片段（提示用户用条件编辑器补） */
  unparsed: string[];
}

/** 问句 → 条件组：按逻辑词切段，逐段提取 指标 + 运算符 + 数值 */
export function parseQuery(text: string): ParseResult {
  const t = text.trim();
  const out: ParseResult = { conditions: [], logic: "AND", unparsed: [] };
  if (!t) return out;

  // 检测逻辑词：出现「或/或者」则整句为 OR
  if (LOGIC_OR.test(t) && !/且|并且/.test(t)) out.logic = "OR";

  // 按逻辑词切段（AND 词优先切）
  const segments = t
    .split(LOGIC_AND)
    .map((s) => s.trim())
    .filter(Boolean);

  const numRe = /(\d+(?:\.\d+)?)/;

  for (const seg of segments) {
    let field: string | null = null;
    for (const { re, key } of FIELD_SYNONYMS) {
      if (re.test(seg)) {
        field = key;
        break;
      }
    }
    const m = seg.match(numRe);
    if (!field || !m) {
      out.unparsed.push(seg);
      continue;
    }
    const value = parseFloat(m[1]);
    let op: QueryCondition["op"] = ">=";
    for (const re of OP_LE) if (re.test(seg)) op = "<=";
    for (const re of OP_EQ) if (re.test(seg)) op = "==";
    for (const re of OP_GE) if (re.test(seg)) op = ">=";
    // 无运算符：按常见语义兜底——估值类默认 <=（低估值），其余默认 >=
    if (!OP_LE.some((r) => r.test(seg)) && !OP_GE.some((r) => r.test(seg)) && !OP_EQ.some((r) => r.test(seg))) {
      op = ["pe", "pb", "total_mv", "circ_mv"].includes(field) ? "<=" : ">=";
    }
    // 去重：同一字段已存在则替换
    const idx = out.conditions.findIndex((c) => c.field === field);
    const cond: QueryCondition = { field, op, value };
    if (idx >= 0) out.conditions[idx] = cond;
    else out.conditions.push(cond);
  }
  return out;
}

/** 从行情 + 涨停信息取字段值（q 为新浪榜单位 Quote，boards 来自涨停记录） */
export function fieldValue(field: string, q: { [k: string]: unknown }, boards: number): number | null {
  switch (field) {
    case "boards":
      return boards;
    case "pe":
      return typeof q.pe === "number" ? (q.pe as number) : null;
    case "pb":
      return typeof q.pb === "number" ? (q.pb as number) : null;
    case "total_mv":
      return typeof q.totalMv === "number" ? (q.totalMv as number) : null;
    case "circ_mv":
      return typeof q.circMv === "number" ? (q.circMv as number) : null;
    case "pct":
      return typeof q.pct === "number" ? (q.pct as number) : null;
    case "price":
      return typeof q.price === "number" ? (q.price as number) : null;
    case "amount":
      return typeof q.amount === "number" ? (q.amount as number) / 100_000_000 : null; // 元 -> 亿
    case "volume":
      return typeof q.volume === "number" ? (q.volume as number) / 10_000 : null; // 手 -> 万手
    case "turnover":
      return typeof q.turnover === "number" ? (q.turnover as number) : null;
    case "volume_ratio":
      return typeof q.volumeRatio === "number" ? (q.volumeRatio as number) : null;
    default:
      return null;
  }
}

/** 单条件求值：值缺失（null）时不命中 */
export function evalCondition(c: QueryCondition, v: number | null): boolean {
  if (v === null) return false;
  switch (c.op) {
    case ">=":
      return v >= c.value;
    case "<=":
      return v <= c.value;
    case "==":
      return Math.abs(v - c.value) < 1e-6;
  }
}

export function evalRule(
  rule: SmartQueryRule,
  q: { [k: string]: unknown },
  boards: number
): boolean {
  if (!rule.conditions.length) return true;
  const hits = rule.conditions.map((c) => evalCondition(c, fieldValue(c.field, q, boards)));
  return rule.logic === "OR" ? hits.some(Boolean) : hits.every(Boolean);
}

/** 规则是否有有效条件（用于禁用创建按钮） */
export function hasCondition(rule: SmartQueryRule): boolean {
  return rule.conditions.length > 0;
}
