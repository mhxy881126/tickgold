// 卡片按需挂载：IntersectionObserver 监听每个 card-slot，进入可视区（含 rootMargin 预加载）
// 后才挂载内部 CardContent；挂载一次后保持，避免滚动反复创建/销毁。
// 未进入可视区的卡片仍占位（slot 本身尺寸不变），只是内部组件不初始化（图表/轮询不启动）。
import { onBeforeUnmount, ref } from "vue";
import type { CardId } from "../lib/cards";

export interface CardMountOptions {
  // 预加载边距（CSS 格式），默认上下各 300px
  rootMargin?: string;
}

export function useCardMount(options: CardMountOptions = {}) {
  const mounted = ref<Partial<Record<string, boolean>>>({});
  const observed = new Set<string>();
  let io: IntersectionObserver | null = null;

  function ensureObserver() {
    if (io || typeof IntersectionObserver === "undefined") return io;
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = (e.target as HTMLElement).dataset.mountId;
          if (!id) continue;
          mounted.value = { ...mounted.value, [id]: true };
          io?.unobserve(e.target);
        }
      },
      { rootMargin: options.rootMargin ?? "300px 0px" }
    );
    return io;
  }

  // 绑定到 slot 的函数 ref：<div :ref="(el) => observeSlot(el, id)">
  function observeSlot(el: Element | null, id: CardId) {
    if (!el) return;
    const target = el as HTMLElement;
    target.dataset.mountId = id;
    if (mounted.value[id] || observed.has(id)) return;
    const obs = ensureObserver();
    if (!obs) {
      // 无 IntersectionObserver 环境：直接挂载（兜底）
      mounted.value = { ...mounted.value, [id]: true };
      return;
    }
    observed.add(id);
    obs.observe(target);
  }

  function isMounted(id: CardId): boolean {
    return !!mounted.value[id];
  }

  onBeforeUnmount(() => {
    io?.disconnect();
    io = null;
  });

  return { observeSlot, isMounted };
}
