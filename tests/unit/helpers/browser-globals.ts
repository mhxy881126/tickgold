// Minimal browser-like globals for stores tested in the default "node" env.
// jsdom is not installed and package.json cannot be edited, so we wire only the
// tiny surface the stores touch: window timers, document events/hidden,
// navigator.onLine, and a Map-backed localStorage.
import { vi } from "vitest";

export function installBrowserGlobals() {
  const listeners: Record<string, EventListener[]> = {};
  const winListeners: Record<string, EventListener[]> = {};

  const documentStub = {
    hidden: false,
    addEventListener: vi.fn((type: string, cb: EventListener) => {
      (listeners[type] ??= []).push(cb);
    }),
    removeEventListener: vi.fn((type: string, cb: EventListener) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb);
    }),
    dispatch(type: string) {
      for (const cb of listeners[type] ?? []) cb({ type } as unknown as Event);
    },
  };

  const windowStub = {
    setInterval: vi.fn(globalThis.setInterval),
    clearInterval: vi.fn(globalThis.clearInterval),
    addEventListener: vi.fn((type: string, cb: EventListener) => {
      (winListeners[type] ??= []).push(cb);
    }),
    removeEventListener: vi.fn((type: string, cb: EventListener) => {
      winListeners[type] = (winListeners[type] ?? []).filter((f) => f !== cb);
    }),
    dispatch(type: string) {
      for (const cb of winListeners[type] ?? []) cb({ type } as unknown as Event);
    },
  };

  const navStub = { onLine: true };

  const store = new Map<string, string>();
  const localStorageStub = {
    getItem: vi.fn((k: string) => (store.has(k) ? store.get(k)! : null)),
    setItem: vi.fn((k: string, v: string) => {
      store.set(k, String(v));
    }),
    removeItem: vi.fn((k: string) => {
      store.delete(k);
    }),
    clear: vi.fn(() => store.clear()),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  g.window = windowStub;
  // Node >=21 defines navigator/document as accessor-only globals, so assign
  // via defineProperty rather than simple assignment.
  Object.defineProperty(g, "navigator", {
    configurable: true,
    writable: true,
    value: navStub,
  });
  Object.defineProperty(g, "document", {
    configurable: true,
    writable: true,
    value: documentStub,
  });
  Object.defineProperty(g, "localStorage", {
    configurable: true,
    writable: true,
    value: localStorageStub,
  });

  return { document: documentStub, window: windowStub, navigator: navStub, localStorage: localStorageStub };
}
