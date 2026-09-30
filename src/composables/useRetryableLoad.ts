// 可重试的数据加载：自动指数退避重试 + 显式错误态 + 手动重试。
// 解决行情接口瞬时网络抖动时，卡片「静默全 0」或「永久 loading」、且失败/空数据无法区分的问题。
import { computed, ref } from "vue";

export interface RetryOptions {
  /** 首次失败后的自动重试次数（默认 2，即最多请求 3 次） */
  retries?: number;
  /** 退避基准延迟 ms，第 n 次重试等待 base * 2^(n-1)（默认 600） */
  baseDelay?: number;
}

export function useRetryableLoad<T>(
  loader: () => Promise<T>,
  options: RetryOptions = {},
) {
  const retries = options.retries ?? 2;
  const baseDelay = options.baseDelay ?? 600;

  const data = ref<T | null>(null) as ReturnType<typeof ref<T | null>>;
  const loading = ref(false);
  const error = ref("");
  /** 当前已尝试次数（从 1 开始），用于 UI 提示 */
  const attempt = ref(0);

  const hasData = computed(() => data.value !== null);

  function wait(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 执行加载：失败时按指数退避自动重试，重试耗尽才置错误态 */
  async function load(): Promise<void> {
    loading.value = true;
    error.value = "";
    let lastErr = "加载失败";
    for (let a = 0; a <= retries; a++) {
      attempt.value = a + 1;
      try {
        data.value = await loader();
        error.value = "";
        loading.value = false;
        return;
      } catch (e: any) {
        lastErr = e?.message || String(e);
        if (a < retries) await wait(baseDelay * Math.pow(2, a));
      }
    }
    error.value = lastErr;
    loading.value = false;
  }

  /** 手动重试（与自动重试同入口） */
  function retry() {
    return load();
  }

  return { data, loading, error, attempt, hasData, load, retry };
}
