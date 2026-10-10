// 本地条件单前端 API：封装 co_* 命令，类型与 Rust 侧 ConditionalOrder / CoTrigger 一一对应。
import { invoke } from "@tauri-apps/api/core";

export interface CoTriggerLeaf {
  field: string;
  op: string;
  value: number;
  params?: Record<string, unknown> | null;
}

export interface ConditionalOrder {
  id: number;
  coId: string;
  tradeDate: string;
  code: string;
  name: string;
  side: string;
  trigger: CoTriggerLeaf[];
  priceMode: string;
  limitPrice: number;
  vol: number;
  ttl: string;
  expireAt: number;
  autoConfirm: boolean;
  status: string;
  ticketId: string;
  note: string;
  createdAt: number;
  updatedAt: number;
  triggeredAt: number;
}

export interface CoCreatePayload {
  code: string;
  name?: string;
  side: string;
  trigger: CoTriggerLeaf[];
  vol: number;
  priceMode?: string;
  limitPrice?: number;
  ttl?: string;
  expireAt?: number;
  autoConfirm?: boolean;
  note?: string;
}

export function coList(status?: string | null, limit = 200) {
  return invoke<ConditionalOrder[]>("co_list", {
    status: status ?? null,
    limit,
  });
}

export function coCreate(p: CoCreatePayload) {
  return invoke<string>("co_create", {
    code: p.code,
    name: p.name ?? "",
    side: p.side,
    trigger: p.trigger,
    vol: p.vol,
    priceMode: p.priceMode ?? "trigger",
    limitPrice: p.limitPrice ?? 0,
    ttl: p.ttl ?? "day",
    expireAt: p.expireAt ?? 0,
    autoConfirm: p.autoConfirm ?? false,
    note: p.note ?? "",
  });
}

export interface CoUpdatePayload {
  id: number;
  vol?: number;
  limitPrice?: number;
  ttl?: string;
  expireAt?: number;
  autoConfirm?: boolean;
  note?: string;
}

export function coUpdate(p: CoUpdatePayload) {
  return invoke<void>("co_update", {
    id: p.id,
    vol: p.vol ?? null,
    limitPrice: p.limitPrice ?? null,
    ttl: p.ttl ?? null,
    expireAt: p.expireAt ?? null,
    autoConfirm: p.autoConfirm ?? null,
    note: p.note ?? null,
  });
}

export function coCancel(id: number) {
  return invoke<void>("co_cancel", { id });
}

export function coCancelAll() {
  return invoke<number>("co_cancel_all");
}

// 条件单触发事件（co:triggered 载荷，与 Rust 侧 CoTriggerEvent 对齐）
export interface CoTriggerEvent {
  time: number;
  coId: string;
  code: string;
  name: string;
  side: string;
  triggerPrice: number;
  vol: number;
  priceMode: string;
  limitPrice: number;
  autoConfirm: boolean;
  matched: boolean;
}

// ===== field / op 词汇表（与后端 eval_leaf 对齐，供下拉与模板）=====
export interface CoFieldDef {
  value: string;
  label: string;
  ops: string[];
  needsValue: boolean;
}

export const CO_FIELDS: CoFieldDef[] = [
  { value: "price", label: "现价", ops: ["crossAbove", "crossBelow", "gte", "lte"], needsValue: true },
  { value: "pct", label: "涨跌幅 %", ops: ["gte", "lte"], needsValue: true },
  { value: "volumeRatio", label: "量比", ops: ["gte"], needsValue: true },
  { value: "turnover", label: "换手率 %", ops: ["gte"], needsValue: true },
  { value: "amount", label: "成交额(亿)", ops: ["gte", "lte"], needsValue: true },
  { value: "riseSpeed", label: "快速拉升", ops: ["gte"], needsValue: true },
  { value: "downSpeed", label: "快速跳水", ops: ["gte"], needsValue: true },
  { value: "sealUp", label: "涨停封板", ops: ["happened"], needsValue: false },
  { value: "sealDown", label: "跌停封板", ops: ["happened"], needsValue: false },
  { value: "broken", label: "涨停炸板", ops: ["happened"], needsValue: false },
];

export const CO_OP_LABEL: Record<string, string> = {
  crossAbove: "上穿",
  crossBelow: "下穿",
  gte: "≥",
  lte: "≤",
  happened: "发生",
};

export const CO_FIELD_LABEL: Record<string, string> = CO_FIELDS.reduce(
  (acc, f) => {
    acc[f.value] = f.label;
    return acc;
  },
  {} as Record<string, string>,
);

export const CO_STATUS_LABEL: Record<string, string> = {
  active: "进行中",
  triggered: "已触发",
  expired: "已过期",
  cancelled: "已撤销",
  done: "已完成",
  error: "异常",
};
