// 快捷键匹配与格式化纯函数（可单测）。
// 绑定 spec 语法：修饰键与主键用 "+" 连接，如 "Ctrl+K"、"Alt+`"、"Ctrl+Shift+Enter"、"?"、"Ctrl+,"。
// 跨平台：spec 中的 "Ctrl" 在 macOS 上映射为 Command（⌘）；"Alt" 映射 Option（⌥）；主键大小写不敏感。

export type OS = "win" | "mac" | "other";

interface ParsedCombo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean; // spec 显式 Meta / ⌘
  key: string; // 规范化主键（大写字母 / 数字 / 命名键 / 符号）
}

const NAMED: Record<string, string> = {
  ESC: "Escape",
  ESCAPE: "Escape",
  ENTER: "Enter",
  RETURN: "Enter",
  SPACE: "Space",
  SPACEBAR: "Space",
  ARROWUP: "ArrowUp",
  ARROWDOWN: "ArrowDown",
  ARROWLEFT: "ArrowLeft",
  ARROWRIGHT: "ArrowRight",
  TAB: "Tab",
  BACKSPACE: "Backspace",
  DELETE: "Delete",
  HOME: "Home",
  END: "End",
  PAGEUP: "PageUp",
  PAGEDOWN: "PageDown",
};

function normKey(k: string): string {
  const t = k.trim();
  if (t === " ") return "Space";
  const upper = t.toUpperCase();
  return NAMED[upper] ?? upper;
}

export function parseCombo(spec: string): ParsedCombo {
  const parts = spec.split("+").map((s) => s.trim()).filter(Boolean);
  const c: ParsedCombo = { ctrl: false, alt: false, shift: false, meta: false, key: "" };
  for (const t of parts.slice(0, -1)) {
    const u = t.toUpperCase();
    if (u === "CTRL" || u === "CONTROL" || u === "CTL") c.ctrl = true;
    else if (u === "ALT" || u === "OPTION" || u === "OPT") c.alt = true;
    else if (u === "SHIFT") c.shift = true;
    else if (u === "META" || u === "CMD" || u === "COMMAND" || u === "WIN" || u === "⌘") c.meta = true;
  }
  c.key = normKey(parts[parts.length - 1] ?? "");
  return c;
}

function eventKey(e: KeyboardEvent): string {
  const k = e.key;
  if (k === " ") return "Space";
  if (k.length === 1) return k.toUpperCase();
  return NAMED[k.toUpperCase()] ?? k;
}

export function detectOS(platform: string): OS {
  const p = platform.toLowerCase();
  if (p.includes("mac") || p.includes("iphone") || p.includes("ipad")) return "mac";
  if (p.includes("win")) return "win";
  return "other";
}

/** 判断 KeyboardEvent 是否匹配绑定（精确匹配修饰键，避免误触发） */
export function eventMatches(e: KeyboardEvent, spec: string, os: OS): boolean {
  const c = parseCombo(spec);
  if (eventKey(e) !== c.key) return false;

  // 平台映射：跨平台 Ctrl 在 mac 上转 Meta
  const wantMeta = os === "mac" ? c.ctrl || c.meta : c.meta;
  const wantCtrl = os === "mac" ? false : c.ctrl;
  if (!!e.metaKey !== wantMeta) return false;
  if (!!e.ctrlKey !== wantCtrl) return false;
  if (!!e.altKey !== c.alt) return false;

  // 单字符符号（如 ? / , `）由键盘布局 + Shift 组合产生，shift 状态不做精确要求；
  // 字母 / 数字 / 命名键精确比较 Shift，避免 Ctrl+Shift+K 误触发 Ctrl+K。
  const isSymbol = c.key.length === 1 && !/^[0-9A-Z]$/.test(c.key);
  if (!isSymbol && !!e.shiftKey !== c.shift) return false;
  return true;
}

/** 两个 spec 是否等价（忽略写法差异，用于冲突检测） */
export function sameCombo(a: string, b: string): boolean {
  const x = parseCombo(a);
  const y = parseCombo(b);
  return (
    x.ctrl === y.ctrl &&
    x.alt === y.alt &&
    x.shift === y.shift &&
    x.meta === y.meta &&
    x.key === y.key
  );
}

/** 转成平台显示文本（mac 用符号，win/other 用单词） */
export function renderKeys(spec: string, os: OS): string {
  const c = parseCombo(spec);
  const key = c.key === "SPACE" ? "Space" : c.key;
  if (os === "mac") {
    const sym: string[] = [];
    if (c.ctrl || c.meta) sym.push("⌘");
    if (c.alt) sym.push("⌥");
    if (c.shift) sym.push("⇧");
    return sym.join("") + key;
  }
  const toks: string[] = [];
  if (c.ctrl) toks.push("Ctrl");
  if (c.meta) toks.push("Win");
  if (c.alt) toks.push("Alt");
  if (c.shift) toks.push("Shift");
  return toks.concat(key).join("+");
}
