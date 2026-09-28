// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { installBrowserGlobals } from "./helpers/browser-globals";

installBrowserGlobals();
import { useActions, dispatchKey, effectiveKeys } from "../../src/composables/useActions";

const { register, unregister, setBinding, resetAll } = useActions();

function ev(
  key: string,
  mod: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {},
  target: unknown = null
): KeyboardEvent {
  return {
    key,
    ctrlKey: !!mod.ctrl,
    altKey: !!mod.alt,
    shiftKey: !!mod.shift,
    metaKey: !!mod.meta,
    target,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe("动作注册中心", () => {
  it("默认快捷键触发动作", () => {
    const run = vi.fn();
    register({ id: "t.a", title: "A", category: "测试", defaultKeys: "Ctrl+K", run });
    dispatchKey(ev("k", { ctrl: true }));
    expect(run).toHaveBeenCalledTimes(1);
    unregister("t.a");
  });

  it("编辑态：非 editingSafe 拦截，editingSafe 放行", () => {
    const undo = vi.fn();
    register({ id: "t.undo", title: "撤销", category: "测试", defaultKeys: "Ctrl+Z", run: undo });
    dispatchKey(ev("z", { ctrl: true }, { tagName: "INPUT" }));
    expect(undo).not.toHaveBeenCalled();

    const pal = vi.fn();
    register({ id: "t.pal", title: "面板", category: "测试", defaultKeys: "Ctrl+K", editingSafe: true, run: pal });
    dispatchKey(ev("k", { ctrl: true }, { tagName: "INPUT" }));
    expect(pal).toHaveBeenCalledTimes(1);

    unregister("t.undo");
    unregister("t.pal");
  });

  it("when 条件不满足不触发", () => {
    let active = false;
    const run = vi.fn();
    register({ id: "t.when", title: "退出", category: "测试", defaultKeys: "Escape", editingSafe: true, when: () => active, run });
    dispatchKey(ev("Escape"));
    expect(run).not.toHaveBeenCalled();
    active = true;
    dispatchKey(ev("Escape"));
    expect(run).toHaveBeenCalledTimes(1);
    unregister("t.when");
  });

  it("自定义绑定覆盖默认，null 清除", () => {
    const run = vi.fn();
    register({ id: "t.cust", title: "自定义", category: "测试", defaultKeys: "Ctrl+K", run });
    setBinding("t.cust", "Ctrl+J");
    expect(effectiveKeys("t.cust")).toBe("Ctrl+J");
    dispatchKey(ev("j", { ctrl: true }));
    expect(run).toHaveBeenCalledTimes(1);
    dispatchKey(ev("k", { ctrl: true }));
    expect(run).toHaveBeenCalledTimes(1);

    setBinding("t.cust", null);
    expect(effectiveKeys("t.cust")).toBe(null);
    dispatchKey(ev("k", { ctrl: true }));
    expect(run).toHaveBeenCalledTimes(1);
    unregister("t.cust");
    resetAll();
  });
});
