// 卡片聚焦：主从分屏 + FLIP 共享元素入场
// 从 App.vue 抽出（行为不变），通过 bench 读写工作台状态。
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { useWorkbench } from "./useWorkbench";
import type { CardId } from "../lib/cards";
import { EASE, FOCUS_MS } from "./useMotion";

type Bench = ReturnType<typeof useWorkbench>;

export function useCardFocus(bench: Bench) {
  const focusTargetEl = ref<HTMLElement | null>(null);
  const focusClosing = ref(false);
  const overlayShow = computed(() => bench.isFocused.value || focusClosing.value);
  const railCards = computed(() => bench.openCards.value);
  let originRects: Record<string, DOMRect> = {};

  function slotEls(): HTMLElement[] {
    const sel = bench.freeMode.value ? ".free-cell" : ".card-slot";
    return [...document.querySelectorAll(sel)] as HTMLElement[];
  }
  // 把所有卡片固定(fixed)在当前视觉位置，脱离网格、避免重排
  function freezeSlots() {
    originRects = {};
    slotEls().forEach((el) => {
      const cid = el.getAttribute("data-card-id") as string;
      const r = el.getBoundingClientRect();
      originRects[cid] = r;
      el.style.transition = "none";
      el.style.position = "fixed";
      el.style.margin = "0";
      el.style.left = r.left + "px";
      el.style.top = r.top + "px";
      el.style.width = r.width + "px";
      el.style.height = r.height + "px";
      el.style.zIndex = "40";
    });
  }
  const FTRANS =
    `left ${FOCUS_MS}ms ${EASE.focus},top ${FOCUS_MS}ms ${EASE.focus},width ${FOCUS_MS}ms ${EASE.focus},height ${FOCUS_MS}ms ${EASE.focus}`;
  function placeAt(el: HTMLElement, r: { left: number; top: number; width: number; height: number }) {
    el.style.transition = FTRANS;
    el.style.left = r.left + "px";
    el.style.top = r.top + "px";
    el.style.width = r.width + "px";
    el.style.height = r.height + "px";
  }
  function enterFocus(id: CardId) {
    if (bench.isFocused.value) {
      switchFocus(id);
      return;
    }
    freezeSlots();
    focusClosing.value = false;
    bench.focus(id);
    nextTick(() => {
      const t = focusTargetEl.value!.getBoundingClientRect();
      void document.body.offsetWidth;
      slotEls().forEach((el) => {
        if (el.getAttribute("data-card-id") === id) {
          placeAt(el, t);
          el.style.zIndex = "70";
        }
      });
    });
  }
  function switchFocus(id: CardId) {
    if (id === bench.focusId.value) return;
    const t = focusTargetEl.value!.getBoundingClientRect();
    const old = bench.focusId.value;
    slotEls().forEach((el) => {
      const cid = el.getAttribute("data-card-id") as string;
      if (cid === id) {
        placeAt(el, t);
        el.style.zIndex = "70";
      } else if (cid === old) {
        placeAt(el, originRects[cid]);
        el.style.zIndex = "40";
      }
    });
    bench.focus(id);
  }
  function exitFocus() {
    if (!bench.isFocused.value) return;
    const fid = bench.focusId.value as CardId;
    focusClosing.value = true;
    slotEls().forEach((el) => {
      if (el.getAttribute("data-card-id") !== fid) return;
      if (originRects[fid]) placeAt(el, originRects[fid]);
      else {
        // 聚焦中新增、无原位记录的卡：淡出，避免 placeAt(undefined)
        el.style.transition = "opacity .3s ease";
        el.style.opacity = "0";
      }
    });
    setTimeout(() => {
      bench.clearSlotInline();
      bench.restoreFocus();
      focusClosing.value = false;
    }, FOCUS_MS);
  }
  // 聚焦态新增卡片：新卡直接 fixed 到主区，旧主卡缩回原位
  function addAndFocus(id: CardId) {
    const old = bench.focusId.value;
    bench.open(id);
    bench.focus(id);
    nextTick(() => {
      const t = focusTargetEl.value!.getBoundingClientRect();
      const ne = slotEls().find((e) => e.getAttribute("data-card-id") === id);
      if (ne) {
        ne.style.transition = FTRANS;
        ne.style.position = "fixed";
        ne.style.margin = "0";
        ne.style.left = t.left + "px";
        ne.style.top = t.top + "px";
        ne.style.width = t.width + "px";
        ne.style.height = t.height + "px";
        ne.style.zIndex = "70";
      }
      if (old) {
        const oe = slotEls().find((e) => e.getAttribute("data-card-id") === old);
        if (oe) {
          placeAt(oe, originRects[old]);
          oe.style.zIndex = "40";
        }
      }
    });
  }
  // 聚焦中窗口尺寸变化：主卡跟随新目标
  function refitFocus() {
    if (!bench.isFocused.value || !focusTargetEl.value) return;
    const t = focusTargetEl.value.getBoundingClientRect();
    slotEls().forEach((el) => {
      if (el.getAttribute("data-card-id") === bench.focusId.value) {
        el.style.transition = "left .2s,top .2s,width .2s,height .2s";
        el.style.left = t.left + "px";
        el.style.top = t.top + "px";
        el.style.width = t.width + "px";
        el.style.height = t.height + "px";
      }
    });
  }

  onMounted(() => {
    window.addEventListener("resize", refitFocus);
  });
  onBeforeUnmount(() => {
    window.removeEventListener("resize", refitFocus);
  });

  return {
    focusTargetEl,
    focusClosing,
    overlayShow,
    railCards,
    enterFocus,
    switchFocus,
    exitFocus,
    addAndFocus,
    refitFocus,
  };
}
