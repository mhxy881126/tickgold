// 智能轮询：只在「真正需要」时刷新，从源头杜绝不可见卡片空转、断网雪崩与慢请求叠加。
// 综合四个信号：
//   1) IntersectionObserver —— 元素是否真实可见（display:none / 滚动出视口 / 尺寸 0 都算不可见）
//   2) document.visibilityState —— 窗口最小化 / 切到其他应用
//   3) navigator.onLine —— 断网暂停，online 后立即续上
//   4) 卡片聚焦（可选，传 cardId）—— 聚焦主从分屏时，非主卡暂停轮询
// 任一信号从「不可运行 → 可运行」时立即拉取一次（恢复即刷新），再按 interval 轮询；
// 内置防重入：上一次还没返回则跳过本轮，慢网络下不会堆叠请求。
import {
  getCurrentInstance,
  inject,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type Ref,
} from "vue";

interface SmartPollOpts {
  /** 轮询间隔 ms */
  interval: number;
  /** 挂载（或恢复）时是否立即执行一次，默认 true */
  immediate?: boolean;
  /** 显式指定要观测可见性的元素；默认取组件根元素 */
  target?: Ref<HTMLElement | null | undefined>;
  /** 断网是否暂停，默认 true */
  requireOnline?: boolean;
  /** 传入卡片 id：聚焦主从分屏时，非主卡自动暂停 */
  cardId?: string;
  /** 外部手动暂停信号（如卡片自带的暂停按钮） */
  paused?: Ref<boolean>;
}

export function useSmartPolling(
  fn: () => unknown | Promise<unknown>,
  opts: SmartPollOpts
) {
  const domVisible = ref(true);
  const pageVisible = ref(typeof document === "undefined" ? true : !document.hidden);
  const online = ref(typeof navigator === "undefined" ? true : navigator.onLine);
  /** 定时器当前是否在跑（便于界面展示状态） */
  const polling = ref(false);

  // 工作台（聚焦状态），由 App.vue provide；非卡片场景可能为 null
  const bench = inject<{ focusId?: Ref<string | null> } | null>("workbench", null);

  let timer: number | null = null;
  let el: HTMLElement | null = null;
  let io: IntersectionObserver | null = null;
  let inflight = false;

  function shouldRun(): boolean {
    if (opts.paused?.value) return false;
    if (!domVisible.value || !pageVisible.value) return false;
    if (opts.requireOnline !== false && !online.value) return false;
    // 聚焦主从分屏：仅主卡继续轮询
    if (bench && opts.cardId && bench.focusId?.value && bench.focusId.value !== opts.cardId) {
      return false;
    }
    return true;
  }

  async function run() {
    if (inflight) return; // 防重入：慢任务未结束不叠加
    inflight = true;
    try {
      await fn();
    } catch (e) {
      console.error("[smart-poll]", e);
    } finally {
      inflight = false;
    }
  }

  function reevaluate() {
    if (shouldRun()) {
      if (timer == null) {
        polling.value = true;
        timer = window.setInterval(run, opts.interval);
        void run(); // 进入「可运行」时立即刷新一次
      }
    } else if (timer != null) {
      polling.value = false;
      clearInterval(timer);
      timer = null;
    }
  }

  function onVisibility() {
    pageVisible.value = !document.hidden;
    reevaluate();
  }
  function onOnline() {
    online.value = true;
    reevaluate();
  }
  function onOffline() {
    online.value = false;
    reevaluate();
  }

  onMounted(() => {
    if (opts.target) el = opts.target.value ?? null;
    if (!el) {
      const inst = getCurrentInstance();
      const cand = inst?.proxy?.$el as unknown;
      el = cand instanceof HTMLElement ? cand : null;
    }
    if (el && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (entries) => {
          const e = entries[0];
          domVisible.value = e.isIntersecting && e.intersectionRatio > 0;
          reevaluate();
        },
        { threshold: [0, 0.02, 0.1] }
      );
      io.observe(el);
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    if (bench && opts.cardId) {
      watch(() => bench.focusId?.value, reevaluate);
    }
    if (opts.paused) watch(opts.paused, reevaluate);
    if (opts.immediate === false) {
      if (shouldRun()) {
        polling.value = true;
        timer = window.setInterval(run, opts.interval);
      }
    } else {
      reevaluate();
    }
  });

  onBeforeUnmount(() => {
    if (timer != null) clearInterval(timer);
    timer = null;
    io?.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  });

  return { polling, online, domVisible, pageVisible, refresh: run };
}
