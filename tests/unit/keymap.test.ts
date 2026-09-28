import { describe, it, expect } from "vitest";
import { parseCombo, eventMatches, renderKeys, detectOS, sameCombo, type OS } from "../../src/lib/keymap";

function ev(
  key: string,
  mod: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}
): KeyboardEvent {
  return {
    key,
    ctrlKey: !!mod.ctrl,
    altKey: !!mod.alt,
    shiftKey: !!mod.shift,
    metaKey: !!mod.meta,
  } as unknown as KeyboardEvent;
}

describe("parseCombo", () => {
  it("解析修饰键与主键", () => {
    const c = parseCombo("Ctrl+Shift+Enter");
    expect(c.ctrl).toBe(true);
    expect(c.shift).toBe(true);
    expect(c.alt).toBe(false);
    expect(c.key).toBe("Enter");
  });
  it("解析字母/符号/单键", () => {
    expect(parseCombo("Ctrl+K").key).toBe("K");
    expect(parseCombo("Alt+`").key).toBe("`");
    expect(parseCombo("?").key).toBe("?");
    expect(parseCombo("Ctrl+,").key).toBe(",");
  });
});

describe("eventMatches (win)", () => {
  it("Ctrl+K 精确匹配", () => {
    expect(eventMatches(ev("k", { ctrl: true }), "Ctrl+K", "win")).toBe(true);
    expect(eventMatches(ev("k", { ctrl: true, shift: true }), "Ctrl+K", "win")).toBe(false);
    expect(eventMatches(ev("k", { alt: true }), "Ctrl+K", "win")).toBe(false);
    expect(eventMatches(ev("l", { ctrl: true }), "Ctrl+K", "win")).toBe(false);
    expect(eventMatches(ev("k", { meta: true }), "Ctrl+K", "win")).toBe(false);
  });
  it("符号键忽略 shift 精确性", () => {
    expect(eventMatches(ev("?", { shift: true }), "?", "win")).toBe(true);
    expect(eventMatches(ev("/"), "?", "win")).toBe(false);
    expect(eventMatches(ev(",", { ctrl: true }), "Ctrl+,", "win")).toBe(true);
  });
  it("Alt+` 与显式 Shift", () => {
    expect(eventMatches(ev("`", { alt: true }), "Alt+`", "win")).toBe(true);
    expect(eventMatches(ev("Enter", { ctrl: true, shift: true }), "Ctrl+Shift+Enter", "win")).toBe(true);
    expect(eventMatches(ev("Enter", { ctrl: true }), "Ctrl+Shift+Enter", "win")).toBe(false);
  });
});

describe("eventMatches (mac)", () => {
  it("Ctrl 在 mac 上转 Meta", () => {
    expect(eventMatches(ev("k", { meta: true }), "Ctrl+K", "mac")).toBe(true);
    expect(eventMatches(ev("k", { ctrl: true }), "Ctrl+K", "mac")).toBe(false);
    expect(eventMatches(ev("k", { meta: true, shift: true }), "Ctrl+K", "mac")).toBe(false);
  });
  it("Alt(Option) 正常匹配", () => {
    expect(eventMatches(ev("`", { alt: true }), "Alt+`", "mac")).toBe(true);
  });
});

describe("renderKeys", () => {
  it("win 用单词", () => {
    expect(renderKeys("Ctrl+K", "win")).toBe("Ctrl+K");
    expect(renderKeys("Ctrl+Shift+Enter", "win")).toBe("Ctrl+Shift+Enter");
    expect(renderKeys("Alt+`", "win")).toBe("Alt+`");
  });
  it("mac 用符号", () => {
    expect(renderKeys("Ctrl+K", "mac")).toBe("⌘K");
    expect(renderKeys("Ctrl+Shift+Enter", "mac")).toBe("⌘⇧Enter");
    expect(renderKeys("Alt+`", "mac")).toBe("⌥`");
  });
});

describe("sameCombo", () => {
  it("忽略写法差异，比较修饰与主键", () => {
    expect(sameCombo("Ctrl+K", "Control+k")).toBe(true);
    expect(sameCombo("Ctrl+K", "Ctrl+Shift+K")).toBe(false);
    expect(sameCombo("Ctrl+,", "Alt+,")).toBe(false);
  });
});

describe("detectOS", () => {
  it("按平台字符串识别", () => {
    expect(detectOS("Win32")).toBe<OS>("win");
    expect(detectOS("MacIntel")).toBe<OS>("mac");
    expect(detectOS("Linux x86_64")).toBe<OS>("other");
  });
});
