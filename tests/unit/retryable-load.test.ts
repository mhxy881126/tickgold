import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRetryableLoad } from "../../src/composables/useRetryableLoad";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// 跑完整 load()（自动推进退避定时器），避免逐个 await setTimeout
async function settle(p: Promise<void>) {
  await vi.runAllTimersAsync();
  await p;
}

describe("useRetryableLoad", () => {
  it("succeeds on first attempt without retrying", async () => {
    const loader = vi.fn().mockResolvedValue("data");
    const { data, loading, error, load } = useRetryableLoad(loader, {
      retries: 2,
      baseDelay: 600,
    });
    await settle(load());
    expect(loader).toHaveBeenCalledTimes(1);
    expect(data.value).toBe("data");
    expect(loading.value).toBe(false);
    expect(error.value).toBe("");
  });

  it("retries with backoff after failures and then succeeds", async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error("net"))
      .mockRejectedValueOnce(new Error("net"))
      .mockResolvedValue("ok");
    const { data, error, attempt, load } = useRetryableLoad(loader, {
      retries: 2,
      baseDelay: 600,
    });
    await settle(load());
    expect(loader).toHaveBeenCalledTimes(3);
    expect(attempt.value).toBe(3);
    expect(data.value).toBe("ok");
    expect(error.value).toBe("");
  });

  it("sets an explicit error state after exhausting retries", async () => {
    const loader = vi.fn().mockRejectedValue(new Error("down"));
    const { data, error, loading, load } = useRetryableLoad(loader, {
      retries: 2,
      baseDelay: 600,
    });
    await settle(load());
    expect(loader).toHaveBeenCalledTimes(3);
    expect(error.value).toBe("down");
    expect(loading.value).toBe(false);
    expect(data.value).toBeNull();
  });

  it("retry() re-enters the load cycle", async () => {
    let fail = true;
    const loader = vi.fn(async () => {
      if (fail) throw new Error("x");
      return "recovered";
    });
    const { data, error, load, retry } = useRetryableLoad(loader, {
      retries: 1,
      baseDelay: 100,
    });
    await settle(load());
    expect(error.value).toBe("x");

    fail = false;
    await settle(retry());
    expect(data.value).toBe("recovered");
    expect(error.value).toBe("");
  });
});
