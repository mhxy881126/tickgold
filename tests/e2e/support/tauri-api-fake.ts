// E2E 假实现：@tauri-apps/api 的 core/event/window/app/dpi/webviewWindow。
// 通过 Vite alias 把这些裸模块路径都指向本文件（本文件同时导出它们的命名导出）。
import { fakeInvoke } from "./backend";

// ---- core ----
export const invoke = fakeInvoke;
export const convertFileSrc = (p: string | number) => String(p);
export const isTauri = () => false;

// ---- event：进程内事件总线 ----
type Listener = (event: { event: string; payload?: unknown }) => void;
const bus = new Map<string, Set<Listener>>();
export function listen(event: string, handler: Listener): Promise<() => void> {
  let set = bus.get(event);
  if (!set) { set = new Set(); bus.set(event, set); }
  set.add(handler);
  return Promise.resolve(() => { set!.delete(handler); });
}
export async function emit(event: string, payload?: unknown): Promise<void> {
  bus.get(event)?.forEach((h) => h({ event, payload }));
}
export async function once(event: string, handler: Listener): Promise<() => void> {
  const un = await listen(event, (e) => { handler(e); un(); });
  return un;
}

// ---- window ----
function windowMethods(label: string) {
  return {
    label,
    listen: () => Promise.resolve(() => {}),
    onResized: () => Promise.resolve(() => {}),
    onMoved: () => Promise.resolve(() => {}),
    isMaximized: async () => false,
    isMinimized: async () => false,
    isVisible: async () => true,
    minimize: async () => {},
    maximize: async () => {},
    unMaximize: async () => {},
    toggleMaximize: async () => false,
    close: async () => {},
    setSize: async () => {},
    setPosition: async () => {},
    setTitle: async () => {},
    startDragging: async () => {},
    innerSize: async () => ({ width: 1280, height: 800 }),
    outerSize: async () => ({ width: 1280, height: 800 }),
    scaleFactor: async () => 1,
  };
}
export function getCurrentWindow() { return windowMethods("main"); }

// ---- app ----
export const getVersion = async () => "0.69.0";
export const getName = async () => "TickGold";

// ---- dpi ----
export class LogicalSize {
  width: number; height: number; type = "Logical";
  constructor(width: number, height: number) { this.width = width; this.height = height; }
}
export class PhysicalSize {
  width: number; height: number; type = "Physical";
  constructor(width: number, height: number) { this.width = width; this.height = height; }
}

// ---- webviewWindow ----
export class WebviewWindow {
  label: string;
  constructor(label: string, _options?: unknown) { this.label = label; Object.assign(this, windowMethods(label)); }
  static getByLabel(_label: string) { return null; }
  static getAllWindows() { return []; }
}
