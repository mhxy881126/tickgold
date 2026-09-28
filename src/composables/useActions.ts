// 统一动作注册中心：动作可带默认快捷键、全局派发；命令面板复用同一动作表；
// 快捷键绑定可自定义并持久化到 localStorage。模块级单例，跨组件共享。
import { detectOS, eventMatches, type OS } from "../lib/keymap";

export interface Action {
  id: string;
  title: string;
  category: string;
  keywords?: string;
  defaultKeys?: string;
  hidden?: boolean; // 不在命令面板显示（内部动作）
  editingSafe?: boolean; // 焦点在输入框时仍可触发（如 Ctrl+K、Escape）
  icon?: string; // 命令面板图标（SVG path）
  desc?: string; // 命令面板副标题
  when?: () => boolean; // 额外启用条件
  run: () => void;
}

const STORE_KEY = "tickgold.keymap.v1";
const actions = new Map<string, Action>();
const custom = new Map<string, string | null>();
let os: OS = "other";
let started = false;
let loaded = false;

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable)
  );
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, string | null>;
      for (const k of Object.keys(obj)) custom.set(k, obj[k]);
    }
  } catch {
    /* ignore */
  }
}
function persist() {
  try {
    const obj: Record<string, string | null> = {};
    custom.forEach((v, k) => {
      obj[k] = v;
    });
    localStorage.setItem(STORE_KEY, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

/** 生效绑定：自定义优先（显式 null = 已清除），否则默认 */
export function effectiveKeys(id: string): string | null {
  if (custom.has(id)) return custom.get(id) ?? null;
  return actions.get(id)?.defaultKeys ?? null;
}

/** 派发一次按键：匹配则执行并返回 true（导出以便单测） */
export function dispatchKey(e: KeyboardEvent): boolean {
  for (const a of actions.values()) {
    if (a.when && !a.when()) continue;
    if (isEditable(e.target) && !a.editingSafe) continue;
    const spec = effectiveKeys(a.id);
    if (spec && eventMatches(e, spec, os)) {
      e.preventDefault();
      a.run();
      return true;
    }
  }
  return false;
}

export function useActions() {
  if (!started) {
    started = true;
    try {
      os = detectOS(navigator.platform);
    } catch {
      os = "other";
    }
    load();
    window.addEventListener("keydown", dispatchKey);
  }
  function register(a: Action) {
    actions.set(a.id, a);
  }
  function unregister(id: string) {
    actions.delete(id);
  }
  function list(): Action[] {
    return [...actions.values()];
  }
  function setBinding(id: string, spec: string | null) {
    custom.set(id, spec);
    persist();
  }
  function resetBinding(id: string) {
    custom.delete(id);
    persist();
  }
  function resetAll() {
    custom.clear();
    persist();
  }
  return {
    os,
    register,
    unregister,
    list,
    setBinding,
    resetBinding,
    resetAll,
    effectiveKeys,
  };
}
