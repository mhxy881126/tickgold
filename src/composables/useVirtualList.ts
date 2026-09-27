// 固定行高虚拟列表：只渲染可视区 + overscan 的行，长列表（榜单/自选/快讯）性能基线。
// 与框架解耦：调用方把 onScroll 绑到滚动容器、用 visibleItems 渲染、totalHeight 撑开滚动条。
import { computed, onBeforeUnmount, ref, shallowRef } from "vue";
import type { Ref } from "vue";

export interface VirtualListOptions {
  itemCount: Ref<number> | number;
  itemHeight: number;
  overscan?: number;
  // 初始可视高度（ResizeObserver 就绪前兜底）
  initialHeight?: number;
}

export interface VirtualListItem {
  index: number;
  offset: number;
}

export function useVirtualList(options: VirtualListOptions) {
  const { itemHeight, overscan = 5, initialHeight = 400 } = options;
  const countOf = () =>
    typeof options.itemCount === "number" ? options.itemCount : options.itemCount.value;

  const scrollTop = ref(0);
  const viewportHeight = ref(initialHeight);
  const containerRef = shallowRef<HTMLElement | null>(null);

  let ro: ResizeObserver | null = null;

  const totalHeight = computed(() => Math.max(0, countOf() * itemHeight));

  const range = computed(() => {
    const n = countOf();
    if (!n || itemHeight <= 0) return { start: 0, end: -1 };
    const first = Math.floor(scrollTop.value / itemHeight);
    const visible = Math.ceil(viewportHeight.value / itemHeight);
    const start = Math.max(0, first - overscan);
    const end = Math.min(n - 1, first + visible + overscan);
    return { start, end };
  });

  const visibleItems = computed<VirtualListItem[]>(() => {
    const { start, end } = range.value;
    const out: VirtualListItem[] = [];
    for (let i = start; i <= end; i++) {
      out.push({ index: i, offset: i * itemHeight });
    }
    return out;
  });

  // 空白填充：容器用 totalHeight，内容 translateY 到起始偏移（两种二选一，这里给偏移）
  const startOffset = computed(() => range.value.start * itemHeight);

  function onScroll(this: HTMLElement) {
    scrollTop.value = this.scrollTop;
  }

  function measure(el: HTMLElement | null) {
    containerRef.value = el;
    ro?.disconnect();
    if (!el) return;
    viewportHeight.value = el.clientHeight || initialHeight;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        viewportHeight.value = el.clientHeight || viewportHeight.value;
      });
      ro.observe(el);
    }
  }

  // 数据变化后，若滚动位置超出内容，收敛到末尾
  function scrollToIndex(index: number) {
    const el = containerRef.value;
    if (!el) return;
    const n = countOf();
    const at = Math.max(0, Math.min(index, n - 1));
    el.scrollTop = at * itemHeight;
    scrollTop.value = el.scrollTop;
  }

  onBeforeUnmount(() => {
    ro?.disconnect();
    ro = null;
  });

  return {
    totalHeight,
    visibleItems,
    startOffset,
    viewportHeight,
    onScroll,
    measure,
    scrollToIndex,
  };
}
