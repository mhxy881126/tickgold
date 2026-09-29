// v-flash：绑定数值变化时，给元素加瞬时涨跌底色辉光。
// 用法：<tr v-flash="q.pct"> ；值上升 → row-flash-up，下降 → row-flash-down。
import type { Directive } from "vue";

type El = HTMLElement & { _flashCls?: string };

function setClass(el: El, cls: string) {
  if (el._flashCls) el.classList.remove(el._flashCls);
  // 强制重排以重启动画（连续同向 tick）
  void el.offsetWidth;
  el.classList.add(cls);
  el._flashCls = cls;
  el.addEventListener(
    "animationend",
    () => {
      el.classList.remove(cls);
      if (el._flashCls === cls) el._flashCls = undefined;
    },
    { once: true }
  );
}

export const vFlash: Directive<El, number | null | undefined> = {
  mounted(el, binding) {
    el._flashCls = undefined;
    (el as any)._flashPrev = binding.value;
  },
  updated(el, binding) {
    const prev = (el as any)._flashPrev as number | null | undefined;
    const next = binding.value;
    (el as any)._flashPrev = next;
    if (typeof next !== "number" || typeof prev !== "number") return;
    if (next === prev) return;
    setClass(el, next > prev ? "row-flash-up" : "row-flash-down");
  },
};
