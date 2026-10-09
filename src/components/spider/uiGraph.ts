// UI 元素识别：蜘蛛像 CV / UI-Agent 一样识别卡片内的可交互元素
// （按钮 / tab / 链接 / 列表行 / 输入 / 滚动容器）并读取文字、矩形、状态与真实 DOM。
// 依赖 document，可用 jsdom 做单测。
import type { CardId } from "../../lib/cards";
import { CARD_ANCHOR_CONFIGS } from "./anchors";
import { getCapability, isStockCode, type RowKind } from "./cardRegistry";

export type UiKind = "button" | "tab" | "link" | "row" | "input" | "scroll";

export type UiSemantic =
  | "buy" | "sell" | "confirm" | "cancel" | "refresh" | "query"
  | "export" | "add-watch" | "ai-toggle" | "stop" | "tab-switch" | "unknown";

export interface ScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  atTop: boolean;
  atBottom: boolean;
  canDown: boolean;
  canUp: boolean;
}

export interface UiElement {
  id: string;
  cardId: string;
  kind: UiKind;
  /** 真实 DOM 引用（动作执行器据此派发事件） */
  el: HTMLElement;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 操作点：元素中心 */
  cx: number;
  cy: number;
  /** 识别到的文字（清理空白、截断） */
  text: string;
  disabled: boolean;
  /** tab / 开关是否处于激活态 */
  active: boolean;
  // 行数据
  code?: string;
  name?: string;
  price?: number;
  pct?: number;
  /** 行主体类型（仅 row） */
  rowKind?: RowKind;
  // 滚动容器状态
  scroll?: ScrollState;
  semantic: UiSemantic;
}

export interface CollectUiOptions {
  /** 是否识别滚动容器（默认 true） */
  scroll?: boolean;
  /** 是否识别输入框（默认 true） */
  input?: boolean;
}

const TEXT_MAX = 24;

function classNameOf(el: Element): string {
  const c = (el as HTMLElement).className;
  return typeof c === "string" ? c : "";
}

function cleanText(el: Element): string {
  const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)}…` : t;
}

function isVisible(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return false;
  if (parseFloat(cs.opacity || "1") < 0.05) return false;
  return true;
}

function isActive(el: HTMLElement, cls: string): boolean {
  if (el.getAttribute("aria-pressed") === "true") return true;
  return /(^|\s)(active|on|selected|is-active)(\s|$)/.test(cls);
}

function readScroll(el: HTMLElement): ScrollState {
  const scrollTop = el.scrollTop;
  const clientHeight = el.clientHeight;
  const scrollHeight = el.scrollHeight;
  const atTop = scrollTop <= 2;
  const atBottom = scrollTop + clientHeight >= scrollHeight - 24;
  return {
    scrollTop,
    clientHeight,
    scrollHeight,
    atTop,
    atBottom,
    canDown: !atBottom && scrollHeight - clientHeight > 24,
    canUp: !atTop,
  };
}

/** 依据文字 + class 判断元素语义（按钮 / tab 用） */
export function semanticOf(text: string, cls: string, kind: UiKind): UiSemantic {
  const t = text.toLowerCase();
  const c = cls.toLowerCase();
  if (/(买入|申购|^买$|^买|buy|加仓)/.test(t) || /(^|\s)buy(\s|$)/.test(c)) return "buy";
  if (/(卖出|赎回|^卖$|^卖|sell|减仓|清仓)/.test(t) || /(^|\s)sell(\s|$)/.test(c)) return "sell";
  if (/(确认|提交|下单|确定|立即|confirm|submit|ok$)/.test(t) || /(^|\s)go(\s|$)/.test(c)) return "confirm";
  if (/(取消|撤单|cancel)/.test(t)) return "cancel";
  if (/(急停|停止|stop)/.test(t) || /ai-stop/.test(c)) return "stop";
  if (/(刷新|refresh|reload)/.test(t) || /(^|\s)reset(\s|$)/.test(c)) return "refresh";
  if (/(查询|筛选|搜索|查找|query|search|filter)/.test(t)) return "query";
  if (/(导出|export)/.test(t)) return "export";
  if (/(加入自选|加自选|自选|\+关注|add)/.test(t)) return "add-watch";
  if (/(ai|智能|自动|auto)/.test(t) || /ai-toggle/.test(c)) return "ai-toggle";
  if (kind === "tab") return "tab-switch";
  return "unknown";
}

function isScrollable(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  const oy = cs.overflowY;
  if (oy !== "auto" && oy !== "scroll") return false;
  return el.scrollHeight - el.clientHeight > 24;
}

/**
 * 采集一张卡片内的全部可交互元素。
 * 顺序：行 → 按钮/链接 → 输入 → 滚动容器；用 seen 去重，
 * 保证行容器即使可点击也归类为 row，行内具体按钮仍独立识别。
 */
export function collectUi(cardId: CardId, opts: CollectUiOptions = {}): UiElement[] {
  const detectScroll = opts.scroll !== false;
  const detectInput = opts.input !== false;

  const root = document.querySelector(
    `.card-shell[data-card-id="${cardId}"]`,
  ) as HTMLElement | null;
  if (!root) return [];

  const out: UiElement[] = [];
  const seen = new Set<HTMLElement>();
  const counters: Record<UiKind, number> = {
    button: 0, tab: 0, link: 0, row: 0, input: 0, scroll: 0,
  };

  const push = (
    el: HTMLElement,
    kind: UiKind,
    extra: Partial<UiElement> = {},
  ): UiElement | null => {
    if (!el || seen.has(el)) return null;
    const rc = el.getBoundingClientRect();
    if (rc.width <= 2 || rc.height <= 2) return null;
    if (!isVisible(el)) return null;
    seen.add(el);

    const cls = classNameOf(el);
    const text = cleanText(el);
    const idx = counters[kind]++;
    const code = extra.code;
    const id = code ? `${cardId}:${kind}:${code}` : `${cardId}:${kind}:${idx}`;

    const u: UiElement = {
      id,
      cardId,
      kind,
      el,
      x: rc.left,
      y: rc.top,
      width: rc.width,
      height: rc.height,
      cx: rc.left + rc.width / 2,
      cy: rc.top + rc.height / 2,
      text,
      disabled:
        (el as HTMLButtonElement).disabled === true ||
        el.getAttribute("aria-disabled") === "true",
      active: isActive(el, cls),
      semantic: semanticOf(text, cls, kind),
      ...extra,
    };
    out.push(u);
    return u;
  };

  // ① 列表行：按卡片能力注册表的 rowKind 做硬校验（rowSel 为文档级选择器，已含卡片限定）
  const cfg = CARD_ANCHOR_CONFIGS[cardId as string];
  const rowKind = getCapability(cardId)?.rowKind ?? "none";
  if (cfg && rowKind !== "none") {
    let rowEls = Array.from(document.querySelectorAll<HTMLElement>(cfg.rowSel));
    if (cfg.maxRows && rowEls.length > cfg.maxRows) rowEls = rowEls.slice(0, cfg.maxRows);
    rowEls.forEach((el) => {
      const data = cfg.extract(el);
      if (rowKind === "stock") {
        // 个股行：必须解析出 6 位股票代码；否则是假行（逐笔/板块/碎片），不采集为 row
        if (!isStockCode(data.code)) return;
      } else if (rowKind === "order") {
        // 逐笔成交：只观察，不采集为可点 row（蜘蛛光束仍会扫过该卡）
        return;
      }
      // sector / index / info 行正常采集（点击触发板块/指数/资讯查看，不进个股交易）
      push(el, "row", {
        code: data.code,
        name: data.name,
        price: data.price,
        pct: data.pct,
        rowKind,
      });
    });
  }

  // ② 按钮 / tab / 链接
  const clickSel = 'button, [role="button"], a[href], input[type="button"], input[type="submit"]';
  Array.from(root.querySelectorAll<HTMLElement>(clickSel)).forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const cls = classNameOf(el);
    let kind: UiKind = "button";
    if (tag === "a") kind = "link";
    else if (/(^|\s)(tab|seg)(\s|$)/.test(cls) || el.closest(".tabs, .seg, .ltab")) kind = "tab";
    push(el, kind);
  });

  // ③ 输入
  if (detectInput) {
    const inSel = 'input:not([type="button"]):not([type="submit"]):not([type="hidden"]), textarea, select';
    Array.from(root.querySelectorAll<HTMLElement>(inSel)).forEach((el) => push(el, "input"));
  }

  // ④ 滚动容器（按 computed overflow 真实可滚判定，不依赖 class）
  if (detectScroll) {
    Array.from(root.querySelectorAll<HTMLElement>("*")).forEach((el) => {
      if (seen.has(el)) return;
      if (isScrollable(el)) push(el, "scroll", { scroll: readScroll(el) });
    });
  }

  return out;
}

/** 便捷：只取某类元素 */
export function elementsOfKind(cardId: CardId, kind: UiKind): UiElement[] {
  return collectUi(cardId).filter((u) => u.kind === kind);
}
