// 作战台指令列表的纯展示模型：执行状态 → 文案/色调、trigger_json → 可读提示。
// 状态本身由 Rust 在读取时推导（derive_state），前端只做映射，不参与判定（node 可测）。
export type ExecState =
  | "watch"
  | "pending"
  | "triggered"
  | "submitted"
  | "filled"
  | "cancelled"
  | "expired";

export interface StateMeta {
  label: string;
  tone: "muted" | "info" | "gold" | "up" | "down";
}

/** 作战台指令行（workflow_instructions 返回项，与 Rust list_instructions 对齐）。 */
export interface InstructionRow {
  id: number;
  tier: string;
  code: string;
  name: string;
  condition: string;
  action: string;
  positionHint: string;
  coId: string;
  triggerJson: string;
  state: string;
  triggeredAt: number;
  filledVol: number;
  filledAvgPrice: number;
  /** P1-b：信号票主键（无票 0）；「确认下单」按它提交，不新建第二张票。 */
  ticketId: number;
  /** P1-b：信号票状态（pending / confirmed / done / rejected / 空串）。 */
  ticketStatus: string;
  /** P1-b：方向 BUY / SELL。 */
  side: string;
  /** P1-b：数量（CO 未建立时回退 alert_rule，缺省 100）。 */
  vol: number;
  /** P1-b：确认下单弹窗用的价格（票面价优先，未触发退回 CO 限价）。 */
  price: number;
  /** P1-b：模拟盘自动执行开关（alert_rule.autoConfirm，缺省 true）。 */
  autoConfirm: boolean;
  /** P1-b：券商委托状态（无委托空串），与 hasOrder 一起决定「已下单/已成交/已拒绝」。 */
  orderStatus: string;
  /** P1-b：是否已有券商委托。 */
  hasOrder: boolean;
  /** P1-b：原始 alert_rule 文本。行列本身不返回，由 store 从 plan.instructions 关联填充。 */
  alertRule?: string;
  /** P3-c：指令标签（logic/emotion/follow），空串或缺失 = 未标。 */
  tag?: string;
}

/** P3-c 指令标签：空串 = 未标；未知值按未标展示，不抛错。 */
export type InstructionTag = "" | "logic" | "emotion" | "follow";

/** 打标下拉选项（顺序固定：清除 / 逻辑 / 情绪 / 跟风）。 */
export const INSTRUCTION_TAG_OPTIONS: ReadonlyArray<{ value: InstructionTag; label: string }> = [
  { value: "", label: "清除" },
  { value: "logic", label: "逻辑" },
  { value: "emotion", label: "情绪" },
  { value: "follow", label: "跟风" },
];

const TAG_LABEL: Record<string, string> = {
  logic: "逻辑",
  emotion: "情绪",
  follow: "跟风",
};

/** 标签中文名；空串 / null / 未知值统一返回空串（UI 不渲染 chip）。 */
export function tagLabel(tag: string | null | undefined): string {
  return TAG_LABEL[(tag ?? "").trim().toLowerCase()] ?? "";
}

const META: Record<ExecState, StateMeta> = {
  watch: { label: "仅观察", tone: "muted" },
  pending: { label: "待触发", tone: "info" },
  triggered: { label: "已触发", tone: "gold" },
  submitted: { label: "已下单", tone: "info" },
  filled: { label: "已成交", tone: "up" },
  cancelled: { label: "已取消", tone: "muted" },
  expired: { label: "已过期", tone: "muted" },
};

/** 未知状态（旧后端/新增状态）一律按「仅观察」展示，避免列表出现空白徽标。 */
export function stateMeta(state: string): StateMeta {
  return META[state as ExecState] ?? META.watch;
}

interface Leaf {
  field: string;
  op: string;
  value: number;
}

const FIELD_LABEL: Record<string, string> = {
  price: "价格",
  pct: "涨幅",
  volumeRatio: "量比",
  turnover: "换手",
  amount: "成交额",
  riseSpeed: "涨速",
  downSpeed: "跌速",
};

/** 把条件单叶子数组渲染成一行提示（如「≥1680.00 · 涨幅≥3%」）。 */
export function triggerHint(json: string): string {
  if (!json) return "";
  let leaves: Leaf[];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return "";
    leaves = parsed as Leaf[];
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const l of leaves) {
    const label = FIELD_LABEL[l?.field];
    const value = Number(l?.value);
    if (!label || !Number.isFinite(value)) continue;
    if (l.field === "price") {
      parts.push(`${l.op === "lte" ? "≤" : "≥"}${value.toFixed(2)}`);
    } else {
      const v = Number.isInteger(value) ? String(value) : value.toFixed(1);
      const pct = l.field === "pct" || l.field === "turnover" ? "%" : "";
      parts.push(`${label}${l.op === "lte" ? "≤" : "≥"}${v}${pct}`);
    }
  }
  return parts.join(" · ");
}

// ============================ P1-b 行内编辑表单模型 ============================
// alert_rule（后端 plan_instruction.alert_rule JSON）与编辑面板的双向映射。
// 表单数值统一按字符串存：input 清空得到空串，映射时「空 = 未设置」，避免 0 与空值混淆。

export type RuleValue = string | number | boolean | null;

/** alert_rule 对象：后端只接受 P1-b spec §三 的 16 个键，其余忽略。 */
export interface AlertRule {
  [key: string]: RuleValue;
}

/** 表单数值：字符串（纯函数调用/空串）或数字（Vue 对 input[type=number] 的 v-model 会自动转数字）。 */
export type FormNum = string | number;

/** 编辑面板表单：13 个数值键 + 方向 + 数量 + 模拟自动开关（与后端可编辑键一一对应）。 */
export interface TriggerForm {
  upPrice: FormNum;
  downPrice: FormNum;
  upPct: FormNum;
  downPct: FormNum;
  minVolumeRatio: FormNum;
  minTurnover: FormNum;
  minAmount: FormNum;
  riseSpeed: FormNum;
  speedWindowSec: FormNum;
  downSpeed: FormNum;
  sealLimitUp: FormNum;
  sealLimitDown: FormNum;
  brokenLimit: FormNum;
  side: string;
  vol: FormNum;
  autoConfirm: boolean;
}

/** 数值型表单键（数量单独处理）：空值省略，旧值需要清除时由 formToRule 显式给 null。 */
type RuleNumKey = Exclude<keyof TriggerForm, "side" | "vol" | "autoConfirm">;

const RULE_NUM_FIELDS: { key: RuleNumKey; label: string }[] = [
  { key: "upPrice", label: "价格" },
  { key: "downPrice", label: "回踩价" },
  { key: "upPct", label: "涨幅" },
  { key: "downPct", label: "跌幅" },
  { key: "minVolumeRatio", label: "量比" },
  { key: "minTurnover", label: "换手" },
  { key: "minAmount", label: "成交额" },
  { key: "riseSpeed", label: "涨速" },
  { key: "speedWindowSec", label: "涨速窗口" },
  { key: "downSpeed", label: "跌速" },
  { key: "sealLimitUp", label: "封涨停" },
  { key: "sealLimitDown", label: "封跌停" },
  { key: "brokenLimit", label: "炸板" },
];

/** 空表单：数量默认 100、方向默认 BUY、模拟自动默认开启（与后端缺省一致）。 */
export function emptyTriggerForm(): TriggerForm {
  return {
    upPrice: "",
    downPrice: "",
    upPct: "",
    downPct: "",
    minVolumeRatio: "",
    minTurnover: "",
    minAmount: "",
    riseSpeed: "",
    speedWindowSec: "",
    downSpeed: "",
    sealLimitUp: "",
    sealLimitDown: "",
    brokenLimit: "",
    side: "BUY",
    vol: "100",
    autoConfirm: true,
  };
}

/** 解析 alert_rule：接受对象或 workflow 返回的 JSON 文本；非法输入按空规则处理。 */
export function parseAlertRule(rule?: AlertRule | string | null): AlertRule {
  if (!rule) return {};
  if (typeof rule === "string") {
    try {
      const parsed = JSON.parse(rule) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as AlertRule;
      }
    } catch {
      /* 非法 JSON 按空规则处理：编辑面板仍可用，保存时按用户填写重建 */
    }
    return {};
  }
  return rule;
}

function numText(rule: AlertRule, key: string): string {
  const v = rule[key];
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  // 兼容历史脏值（如 "1710"）：能转数字就回填，避免编辑时把条件弄丢。
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return String(Number(v));
  return "";
}

function isSet(v: RuleValue | undefined): boolean {
  return v !== undefined && v !== null && v !== "" && v !== 0 && v !== false;
}

/** `alertRule` → 表单。接受对象或 workflow 返回的 JSON 文本；非法输入回落到空表单。 */
export function ruleToForm(rule?: AlertRule | string | null): TriggerForm {
  const r = parseAlertRule(rule);
  const form = emptyTriggerForm();
  for (const { key } of RULE_NUM_FIELDS) form[key] = numText(r, key);
  const side = typeof r.side === "string" ? r.side.trim().toUpperCase() : "";
  form.side = side === "SELL" ? "SELL" : "BUY";
  const vol = numText(r, "vol");
  form.vol = vol && Number(vol) > 0 ? vol : "100";
  form.autoConfirm = typeof r.autoConfirm === "boolean" ? r.autoConfirm : true;
  return form;
}

/** 条件单叶子 JSON → alertRule：列表行没有原始 alert_rule 时的回填兜底。 */
export function triggerJsonToRule(json: string): AlertRule {
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!Array.isArray(parsed)) return {};
  const rule: AlertRule = {};
  for (const raw of parsed as {
    field?: unknown;
    op?: unknown;
    value?: unknown;
    params?: unknown;
  }[]) {
    const value = Number(raw?.value);
    if (!raw || !Number.isFinite(value)) continue;
    const gte = raw.op !== "lte";
    switch (raw.field) {
      case "price":
        rule[gte ? "upPrice" : "downPrice"] = value;
        break;
      case "pct":
        rule[gte ? "upPct" : "downPct"] = value;
        break;
      case "volumeRatio":
        rule.minVolumeRatio = value;
        break;
      case "turnover":
        rule.minTurnover = value;
        break;
      case "amount":
        rule.minAmount = value;
        break;
      case "riseSpeed": {
        rule.riseSpeed = value;
        const win = Number((raw.params as { windowSec?: unknown } | undefined)?.windowSec);
        if (Number.isFinite(win) && win > 0) rule.speedWindowSec = win;
        break;
      }
      case "downSpeed":
        rule.downSpeed = value;
        break;
      case "sealUp":
        rule.sealLimitUp = 1;
        break;
      case "sealDown":
        rule.sealLimitDown = 1;
        break;
      case "broken":
        rule.brokenLimit = 1;
        break;
      default:
        break;
    }
  }
  return rule;
}

function normalizeSide(side: string): "BUY" | "SELL" | "" {
  const s = side.trim().toUpperCase();
  return s === "BUY" || s === "SELL" ? s : "";
}

function parseNum(value: FormNum, label: string): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label}须为数字`);
    return value;
  }
  const t = value.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`${label}须为数字`);
  return n;
}

/** 数量：正整数且 100 股整数倍（与后端 as_lot_vol 校验一致）；空串表示沿用旧值/缺省。 */
function parseVol(value: FormNum): number | null {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else {
    const t = value.trim();
    if (!t) return null;
    n = Number(t);
  }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n % 100 !== 0) {
    throw new Error("委托数量须为 100 股整数倍");
  }
  return n;
}

function formNum(form: TriggerForm, key: RuleNumKey): number | null {
  const value = form[key];
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const t = value.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 是否至少有一个可物化的触发条件（与后端 leaves_from_alert_rule 的取值有效性对齐）。 */
function hasTrigger(form: TriggerForm): boolean {
  const gt0 = (key: RuleNumKey) => (formNum(form, key) ?? 0) > 0;
  return (
    gt0("upPrice") ||
    gt0("upPct") ||
    gt0("downPrice") ||
    (formNum(form, "downPct") ?? 0) < 0 ||
    gt0("minVolumeRatio") ||
    gt0("minTurnover") ||
    gt0("minAmount") ||
    gt0("riseSpeed") ||
    gt0("downSpeed") ||
    gt0("sealLimitUp") ||
    gt0("sealLimitDown") ||
    gt0("brokenLimit")
  );
}

/** 面板校验：返回中文错误，空串表示通过（保存前调用，后端仍会二次校验）。 */
export function validateForm(form: TriggerForm): string {
  try {
    for (const { key, label } of RULE_NUM_FIELDS) parseNum(form[key], label);
    parseVol(form.vol);
  } catch (e) {
    return (e as Error).message;
  }
  if (!normalizeSide(form.side)) return "方向只能是 BUY 或 SELL";
  if (!hasTrigger(form)) return "至少设置一个触发条件";
  return "";
}

/**
 * 表单 → alertRule。
 *
 * - 空值默认省略（不写脏后端已有规则）；
 * - 传 `prev`（本次编辑前的 alertRule）时，之前有值、现在被清空的键显式写 `null`：
 *   后端是「合并」语义，省略等于保留旧条件，只有 null / 0 才真正清除；
 * - 数量非 100 整数倍、方向非法、数值非数字 → 中文错误。
 */
export function formToRule(form: TriggerForm, prev?: AlertRule | string | null): AlertRule {
  const prevRule = parseAlertRule(prev);
  const side = normalizeSide(form.side);
  if (!side) throw new Error("方向只能是 BUY 或 SELL");
  const out: AlertRule = { side, autoConfirm: form.autoConfirm === true };
  const vol = parseVol(form.vol);
  if (vol !== null) out.vol = vol;
  else if (isSet(prevRule.vol)) out.vol = null;
  for (const { key, label } of RULE_NUM_FIELDS) {
    const value = parseNum(form[key], label);
    if (value !== null) out[key] = value;
    else if (isSet(prevRule[key])) out[key] = null;
  }
  return out;
}

/** 方向互斥提示：突破（价格≥ / 涨幅≥）与回踩（价格≤ / 跌幅≤）同时有值时只物化突破侧。 */
export function directionHint(form: TriggerForm): string {
  const up = (formNum(form, "upPrice") ?? 0) > 0 || (formNum(form, "upPct") ?? 0) > 0;
  const down = (formNum(form, "downPrice") ?? 0) > 0 || (formNum(form, "downPct") ?? 0) < 0;
  return up && down ? "突破优先：回撤条件不会触发" : "";
}

const ORDER_STATUS_LABEL: Record<string, string> = {
  submitting: "提交中",
  submitted: "已下单",
  part_filled: "部分成交",
  filled: "已成交",
  cancelled: "已撤销",
  rejected: "已拒绝",
  error: "已失败",
};

/** 券商委托状态文案（无委托时由调用方决定不展示）。 */
export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABEL[status] ?? "已下单";
}

/** 下单条 / 指令行共用的券商状态最小字段集（BrokerStatus 结构上满足）。 */
export interface BrokerGateStatus {
  kind: string;
  liveEnabled: boolean;
  connected: boolean;
  killSwitch: boolean;
  clientSim?: boolean;
  windowSim?: boolean | null;
}

/**
 * 「确认下单」闸门：与下单条同口径（OrderDock 的 dead / liveDisabled）。
 * 返回中文原因，空串表示可以提交；状态未知时一律拦截，宁可不提交。
 */
export function submitBlockReason(status?: BrokerGateStatus | null): string {
  if (!status) return "券商状态未知，暂不能提交";
  if (status.killSwitch) return "已熔断：请先解除急停再提交";
  if (!status.connected) return "券商未连接，暂不能提交";
  const sim =
    status.kind === "mock" ||
    (status.kind === "client" && (status.clientSim === true || status.windowSim === true));
  if (!sim && status.liveEnabled !== true) {
    return "实盘未启用：请先到「设置 → 券商」开启实盘开关并配置白名单";
  }
  return "";
}

// ============================ P1-b 行状态文案 / 可操作性规则（下沉自组件） ============================
// 组件只负责渲染：状态徽标、能否编辑、能否确认下单、按钮文案、闸门原因全部由这里的纯函数决定。

/** 行状态判定入参（InstructionRow 结构上满足，单测可只给需要的字段）。 */
export interface InstructionGate {
  state: string;
  ticketStatus: string;
  hasOrder: boolean;
  orderStatus?: string;
  ticketId?: number;
}

/** 委托状态色调（与执行状态徽标同一套 tone）。 */
function orderTone(status: string): StateMeta["tone"] {
  if (status === "filled") return "up";
  if (status === "part_filled") return "gold";
  if (status === "rejected" || status === "error") return "up";
  if (status === "cancelled") return "muted";
  return "info";
}

/**
 * 行尾状态徽标（P1-b 文案一致性）：
 * - 已有委托：按 `orderStatus` 映射（已下单 / 部分成交 / 已成交 / 已拒绝 / 已失败 / 已撤销）；
 * - 票 `confirmed` 但还没提交（无委托）：显示「待提交」——后端 `derive_state` 会回 `submitted`（已下单），
 *   但此时并没有委托，配合行尾「重试提交」按钮才不矛盾；
 * - 票 `rejected`：显示「已拒绝」——不能沿用后端推导的 `cancelled`（已取消）；
 * - 票 `done`：显示「已成交」；
 * - 无票：回执行状态（仅观察 / 待触发 / 已触发 / 已取消 / 已过期）。
 */
export function instructionStatusMeta(row: InstructionGate): StateMeta {
  if (row.hasOrder) {
    const status = row.orderStatus ?? "";
    return { label: orderStatusLabel(status), tone: orderTone(status) };
  }
  switch (row.ticketStatus) {
    case "confirmed":
      return { label: "待提交", tone: "gold" };
    case "rejected":
      return { label: "已拒绝", tone: "up" };
    case "done":
      return { label: "已成交", tone: "up" };
    case "pending":
      return { label: "已触发", tone: "gold" };
    default:
      return stateMeta(row.state);
  }
}

/** 可编辑：条件单未触发（watch=尚未物化/open、alerted；pending=已物化待触发）；终态不给编辑。 */
export function canEditInstruction(row: InstructionGate): boolean {
  return row.state === "watch" || row.state === "pending";
}

/**
 * 可「确认下单」：票待确认，或票已确认但还没有委托（重试提交）。
 * 已有委托、无票据 id、已成交/已取消/已过期一律不给入口。
 */
export function canSubmitInstruction(row: InstructionGate): boolean {
  if (row.hasOrder) return false;
  if (row.ticketId !== undefined && !(row.ticketId > 0)) return false;
  if (row.state === "filled" || row.state === "cancelled" || row.state === "expired") return false;
  return row.ticketStatus === "pending" || (row.ticketStatus === "confirmed" && !row.hasOrder);
}

/** 提交按钮文案：票已确认（上次提交失败/未提交出去）→「重试提交」，否则「确认下单」。 */
export function submitActionLabel(row: InstructionGate): string {
  return row.ticketStatus === "confirmed" ? "重试提交" : "确认下单";
}

/** 行内动作汇总（组件唯一调用入口）。 */
export interface InstructionActions {
  canEdit: boolean;
  canSubmit: boolean;
  submitLabel: string;
  blockReason: string;
}

/** 行 + 券商状态 → 可操作性；`blockReason` 非空表示提交按钮置灰并提示。 */
export function instructionActions(
  row: InstructionGate,
  status?: BrokerGateStatus | null,
): InstructionActions {
  return {
    canEdit: canEditInstruction(row),
    canSubmit: canSubmitInstruction(row),
    submitLabel: submitActionLabel(row),
    blockReason: submitBlockReason(status),
  };
}
