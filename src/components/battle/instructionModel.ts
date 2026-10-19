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
