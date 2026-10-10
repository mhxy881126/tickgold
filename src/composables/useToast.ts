// 全局操作反馈 Toast（v2.24）
// 模块级单例：任意组件 import { toast } 即可调用，无需 provide。
import { ref } from "vue";

export type ToastType = "success" | "info" | "warn" | "error";

export interface ToastItem {
  id: number;
  type: ToastType;
  msg: string;
  duration: number; // ms，0 = 不自动关闭
  timer?: ReturnType<typeof setTimeout>;
}

const toasts = ref<ToastItem[]>([]);
let seq = 0;
const MAX = 4;

const ICONS: Record<ToastType, string> = {
  success: "✓",
  info: "ℹ",
  warn: "⚠",
  error: "✕",
};

function push(type: ToastType, msg: string, duration?: number) {
  const id = ++seq;
  const dur = duration ?? (type === "error" ? 4000 : type === "warn" ? 3200 : 2500);
  const item: ToastItem = { id, type, msg, duration: dur };
  toasts.value = [...toasts.value, item].slice(-MAX);
  if (dur > 0) {
    item.timer = setTimeout(() => dismiss(id), dur);
  }
  return id;
}

function dismiss(id: number) {
  const t = toasts.value.find((x) => x.id === id);
  if (t?.timer) clearTimeout(t.timer);
  toasts.value = toasts.value.filter((x) => x.id !== id);
}

function clear() {
  toasts.value.forEach((t) => t.timer && clearTimeout(t.timer));
  toasts.value = [];
}

export const toast = {
  success: (msg: string, dur?: number) => push("success", msg, dur),
  info: (msg: string, dur?: number) => push("info", msg, dur),
  warn: (msg: string, dur?: number) => push("warn", msg, dur),
  error: (msg: string, dur?: number) => push("error", msg, dur),
  dismiss,
  clear,
};

export function useToast() {
  return { toasts, dismiss, clear, ICONS };
}
