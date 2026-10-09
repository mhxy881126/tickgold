// 交互动作执行器：蜘蛛对识别到的 UI 元素执行真实操作。
// 通过派发完整的指针 / 鼠标 / 滚轮事件序列，保证 Vue @click、原生 click、
// 卡片 onScroll/loadMore 都能被触发（不依赖真实鼠标坐标，蜘蛛层 pointer-events 也能操作）。
import type { UiElement } from "./uiGraph";

export interface ActionResult {
  ok: boolean;
  reason?: string;
}

interface Pt {
  x: number;
  y: number;
}

function centerOf(el: HTMLElement): Pt {
  const rc = el.getBoundingClientRect();
  return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2 };
}

/** 点击 / 触碰：pointerdown → mousedown → pointerup → mouseup → click */
export function tap(el: HTMLElement): ActionResult {
  if (!el) return { ok: false, reason: "no-el" };
  if ((el as HTMLButtonElement).disabled === true) return { ok: false, reason: "disabled" };
  const p = centerOf(el);
  const base = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: p.x,
    clientY: p.y,
    button: 0,
  };
  try {
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", base));
    // el.click() 最可靠：内部派发 click，Vue @click 一定触发
    el.click();
    return { ok: true };
  } catch (e) {
    try {
      el.click();
      return { ok: true };
    } catch {
      return { ok: false, reason: String(e) };
    }
  }
}

/**
 * 滚动容器：先派发 wheel（部分卡片用 wheel 监听），再直接设置 scrollTop
 * 并派发 scroll（卡片普遍在 onScroll 里读 scrollTop 触发 loadMore）。
 */
export function scrollBy(el: HTMLElement, dir: 1 | -1, ratio = 0.8): ActionResult {
  if (!el) return { ok: false, reason: "no-el" };
  const rc = el.getBoundingClientRect();
  const amount = el.clientHeight * ratio * dir;
  const before = el.scrollTop;

  try {
    const wy =
      rc.top +
      Math.min(
        Math.max(rc.height - 8, 8),
        rc.height / 2 + (dir > 0 ? rc.height / 4 : -rc.height / 4),
      );
    el.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: rc.left + rc.width / 2,
        clientY: wy,
        deltaY: amount,
      }),
    );
  } catch {
    /* wheel 不可用则直接改 scrollTop */
  }

  el.scrollTop = before + amount;
  try {
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  } catch {
    /* noop */
  }
  const moved = Math.abs(el.scrollTop - before) > 1;
  return { ok: moved, reason: moved ? undefined : "no-move" };
}

/** 悬停（触发 hover 态 / 懒加载 tooltip） */
export function hover(el: HTMLElement): ActionResult {
  const p = centerOf(el);
  const base = { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y };
  try {
    el.dispatchEvent(new PointerEvent("pointermove", { ...base, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseover", base));
    el.dispatchEvent(new MouseEvent("mouseenter", base));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

/** 聚焦输入框 */
export function focusInput(el: HTMLElement): ActionResult {
  try {
    (el as HTMLInputElement).focus?.();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

/** 高层封装：对 UiElement 执行点击 */
export function actTap(u: UiElement): ActionResult {
  return tap(u.el);
}

/** 高层封装：对 UiElement（滚动容器）执行滚动 */
export function actScroll(u: UiElement, dir: 1 | -1): ActionResult {
  return scrollBy(u.el, dir);
}
