import { describe, expect, it, beforeEach } from "vitest";
import { computed, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import {
  createMarketContext,
  createRootMarketContext,
  useMarketContext,
  type MarketContext,
} from "../../src/composables/useMarketContext";
import { useQuotesStore } from "../../src/stores/quotes";
import { useWatchlistStore } from "../../src/stores/watchlist";

function parentLike(over: Partial<MarketContext> = {}): MarketContext {
  return {
    primaryCode: ref("600000"),
    quoteOf: () => undefined,
    nameOf: () => "",
    select: () => {},
    bindings: ref([]),
    ...over,
  };
}

describe("createMarketContext 父层回落", () => {
  it("未覆盖的解析能力回落父层，select 沿层向上", () => {
    const selected: string[] = [];
    const parent = parentLike({
      quoteOf: (c) => ({ code: c ?? "" }) as never,
      nameOf: (c) => `名称${c}`,
      select: (c) => selected.push(c),
      bindings: ref(["600000", "000001"]),
    });
    const child = createMarketContext({
      primaryCode: ref(null),
      parent,
    });
    expect(child.quoteOf("600000")?.code).toBe("600000");
    expect(child.nameOf("600000")).toBe("名称600000");
    expect(child.bindings.value).toEqual(["600000", "000001"]);
    child.select("000001");
    expect(selected).toEqual(["000001"]);
  });

  it("子层显式能力优先于父层", () => {
    const parentPicks: string[] = [];
    const childPicks: string[] = [];
    const parent = parentLike({
      quoteOf: () => ({ code: "P" }) as never,
      nameOf: () => "父名",
      select: (c) => parentPicks.push(c),
      bindings: ref(["P"]),
    });
    const child = createMarketContext({
      primaryCode: ref("C"),
      parent,
      resolveQuote: () => ({ code: "Q" }) as never,
      resolveName: () => "子名",
      onSelect: (c) => childPicks.push(c),
      bindings: ref(["C1", "C2"]),
    });
    expect(child.primaryCode.value).toBe("C");
    expect(child.quoteOf("x")?.code).toBe("Q");
    expect(child.nameOf("x")).toBe("子名");
    expect(child.bindings.value).toEqual(["C1", "C2"]);
    child.select("go");
    expect(childPicks).toEqual(["go"]);
    expect(parentPicks).toEqual([]);
  });

  it("无父层且未给 resolver 时给出安全缺省", () => {
    const ctx = createMarketContext({ primaryCode: ref(null) });
    expect(ctx.quoteOf("x")).toBeUndefined();
    expect(ctx.nameOf("x")).toBe("");
    expect(ctx.bindings.value).toEqual([]);
    expect(() => ctx.select("x")).not.toThrow();
  });
});

// 复刻 useCardMarketLayer 的主标的解析（primary ?? parent.primaryCode），
// provide/inject 行为由组件/E2E 覆盖
describe("两层主标的覆盖优先级", () => {
  it("卡绑定为空时跟随全局；有卡绑定则覆盖", () => {
    const rootPrimary = ref<string | null>("600000");
    const root = parentLike({ primaryCode: rootPrimary });
    const cardPrimary = ref<string | null | undefined>(null);
    const resolved = computed(
      () => cardPrimary.value ?? root.primaryCode.value ?? null
    );
    createMarketContext({ primaryCode: resolved, parent: root });

    expect(resolved.value).toBe("600000");
    cardPrimary.value = "300750";
    expect(resolved.value).toBe("300750");
    cardPrimary.value = null;
    expect(resolved.value).toBe("600000");
    rootPrimary.value = "000001";
    expect(resolved.value).toBe("000001");
    rootPrimary.value = null;
    expect(resolved.value).toBeNull();
  });
});

describe("createRootMarketContext", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("从 quotes/watchlist store 解析行情与名称，bindings 跟随自选", () => {
    const wl = useWatchlistStore();
    wl.stocks = [
      { code: "600519", name: "贵州茅台" },
      { code: "000001", name: "平安银行" },
    ] as never;
    const quotes = useQuotesStore();
    quotes.map["600519"] = { code: "600519", name: "贵州茅台", price: 1500 } as never;

    const root = createRootMarketContext({
      primaryCode: ref("600519"),
    });
    expect(root.primaryCode.value).toBe("600519");
    expect(root.quoteOf("600519")?.price).toBe(1500);
    expect(root.quoteOf("nope")).toBeUndefined();
    expect(root.nameOf("600519")).toBe("贵州茅台");
    expect(root.bindings.value).toEqual(["600519", "000001"]);
  });

  it("onSelect 在全局层生效", () => {
    const picks: string[] = [];
    const root = createRootMarketContext({
      primaryCode: ref(null),
      onSelect: (c) => picks.push(c),
    });
    root.select("600519");
    expect(picks).toEqual(["600519"]);
  });
});

describe("useMarketContext 守卫", () => {
  it("缺少祖先层时抛错", () => {
    // inject 在无组件上下文时返回缺省值 null
    expect(() => useMarketContext()).toThrow("缺少 MarketContext 祖先层");
  });
});
