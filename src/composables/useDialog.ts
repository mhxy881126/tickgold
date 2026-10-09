// 全局弹窗服务：替代原生 window.alert / window.confirm / window.prompt。
// 深色主题、屏幕居中；App.vue 挂载一个 AppDialog 宿主即可，任意位置调用。
import { reactive } from "vue";

export interface DialogOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export interface PromptOptions {
  title?: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
}

type DialogMode = "alert" | "confirm" | "prompt";

interface DialogState {
  open: boolean;
  mode: DialogMode;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
  inputValue: string;
  placeholder: string;
  resolve: ((v: boolean | string | null) => void) | null;
}

const state = reactive<DialogState>({
  open: false,
  mode: "confirm",
  title: "",
  message: "",
  confirmText: "确定",
  cancelText: "取消",
  danger: false,
  inputValue: "",
  placeholder: "",
  resolve: null,
});

function show(
  mode: DialogMode,
  opts: DialogOptions,
): Promise<boolean> {
  state.mode = mode;
  state.title = opts.title ?? "";
  state.message = opts.message;
  state.confirmText = opts.confirmText ?? "确定";
  state.cancelText = opts.cancelText ?? "取消";
  state.danger = opts.danger ?? false;
  state.inputValue = "";
  state.placeholder = "";
  state.open = true;
  return new Promise<boolean>((resolve) => {
    state.resolve = (v) => resolve(v as boolean);
  });
}

/** 确认弹窗，返回 true / false */
export function confirmDialog(opts: DialogOptions): Promise<boolean> {
  return show("confirm", opts);
}

/** 提示弹窗，仅一个按钮，返回 true */
export function alertDialog(opts: DialogOptions | string): Promise<boolean> {
  return show("alert", typeof opts === "string" ? { message: opts } : opts);
}

/** 输入弹窗，确定返回字符串，取消返回 null */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  state.mode = "prompt";
  state.title = opts.title ?? "";
  state.message = opts.message ?? "";
  state.confirmText = opts.confirmText ?? "确定";
  state.cancelText = opts.cancelText ?? "取消";
  state.danger = false;
  state.inputValue = opts.defaultValue ?? "";
  state.placeholder = opts.placeholder ?? "";
  state.open = true;
  return new Promise<string | null>((resolve) => {
    state.resolve = (v) => resolve(v as string | null);
  });
}

export function useDialogState(): DialogState {
  return state;
}
