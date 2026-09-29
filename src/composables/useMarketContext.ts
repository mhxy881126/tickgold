// 行情上下文总线：两层 provide/inject。
// 全局层（App，primaryCode = 当前选中）→ 卡级层（WidgetCanvas，可被卡绑定覆盖）。
// 微件零 props 透传：只拿 bind?，标的代码 = bind ?? ctx.primaryCode。
// 另含 useWidgetData：同卡同标的的分时/K/盘口/资金只请求一次（下沉 MultiCell 的 got 缓存）。
import {
  computed,
  inject,
  provide,
  ref,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from "vue";
import { storeToRefs } from "pinia";
import type { FundFlow, KBar, OrderBook, Quote } from "../api/types";
import {
  fetchFundFlow,
  fetchKLine,
  fetchMinute,
  fetchOrderBook,
} from "../api/market";
import { useQuotesStore } from "../stores/quotes";
import { useWatchlistStore } from "../stores/watchlist";

export interface MarketContext {
  /** 当前层解析出的主标的（卡级层 = 卡绑定 ?? 全局选中） */
  primaryCode: Ref<string | null>;
  quoteOf(code: string | null | undefined): Quote | undefined;
  nameOf(code: string | null | undefined): string;
  /** 切换主标的（沿层向上到全局层生效） */
  select(code: string): void;
  /** 可绑定标的集合（全局=全部自选代码） */
  bindings: Ref<string[]>;
}

const KEY: InjectionKey<MarketContext> = Symbol("market-context");

interface MarketSpec {
  primaryCode: Ref<string | null>;
  parent?: MarketContext | null;
  onSelect?: (code: string) => void;
  resolveQuote?: (code: string | null | undefined) => Quote | undefined;
  resolveName?: (code: string | null | undefined) => string;
  bindings?: Ref<string[]>;
}

// 构造一层上下文：未显式给出的解析能力全部回落父层
export function createMarketContext(spec: MarketSpec): MarketContext {
  const parent = spec.parent ?? null;
  const quoteOf =
    spec.resolveQuote ??
    (parent
      ? (c: string | null | undefined) => parent.quoteOf(c)
      : () => undefined);
  const nameOf =
    spec.resolveName ??
    (parent
      ? (c: string | null | undefined) => parent.nameOf(c)
      : () => "");
  return {
    primaryCode: spec.primaryCode,
    quoteOf,
    nameOf,
    select: (code: string) => {
      if (spec.onSelect) spec.onSelect(code);
      else parent?.select(code);
    },
    bindings: spec.bindings ?? parent?.bindings ?? ref([]),
  };
}

// 全局层：标的解析走 Pinia 行情/自选 store
export function createRootMarketContext(opts: {
  primaryCode: Ref<string | null>;
  onSelect?: (code: string) => void;
}): MarketContext {
  const quotes = useQuotesStore();
  const wl = useWatchlistStore();
  const { codes } = storeToRefs(wl);
  return createMarketContext({
    primaryCode: opts.primaryCode,
    onSelect: opts.onSelect,
    resolveQuote: (c) => (c ? quotes.map[c] : undefined),
    resolveName: (c) => (c ? wl.nameOf(c) : ""),
    bindings: codes,
  });
}

export function provideMarketContext(ctx: MarketContext): void {
  provide(KEY, ctx);
}

export function useMarketContext(): MarketContext {
  const ctx = inject(KEY, null);
  if (!ctx) throw new Error("缺少 MarketContext 祖先层");
  return ctx;
}

// 卡级层：primary=卡主绑定（null 表示跟随全局），其余能力回落父层
export function useCardMarketLayer(
  primary: Ref<string | null | undefined>
): MarketContext {
  const parent = useMarketContext();
  const primaryCode = computed(
    () => primary.value ?? parent.primaryCode.value ?? null
  );
  const ctx = createMarketContext({
    primaryCode,
    parent,
    onSelect: (code) => parent.select(code),
  });
  provideMarketContext(ctx);
  return ctx;
}

// ===== useWidgetData：按代码会话级缓存，同标的多微件共享一次请求 =====
export type WidgetDataKind = "minute" | "kline" | "ob" | "fund";

interface CodeEntry {
  got: Set<WidgetDataKind>;
  minute: Ref<KBar[]>;
  kline: Ref<KBar[]>;
  ob: Ref<OrderBook | null>;
  fund: Ref<FundFlow | null>;
  ensure(kind: WidgetDataKind): Promise<void>;
}

const cache = new Map<string, CodeEntry>();

function entryFor(code: string): CodeEntry {
  let e = cache.get(code);
  if (e) return e;
  const got = new Set<WidgetDataKind>();
  const minute = ref<KBar[]>([]);
  const kline = ref<KBar[]>([]);
  const ob = ref<OrderBook | null>(null);
  const fund = ref<FundFlow | null>(null);
  // 失败时删掉 kind 标记，下次 ensure 可重试（与 MultiCell 行为一致）
  async function ensure(kind: WidgetDataKind) {
    if (got.has(kind)) return;
    got.add(kind);
    try {
      if (kind === "minute") minute.value = await fetchMinute(code);
      else if (kind === "kline") kline.value = await fetchKLine(code, 101, 180);
      else if (kind === "ob") ob.value = await fetchOrderBook(code);
      else fund.value = await fetchFundFlow(code);
    } catch {
      got.delete(kind);
    }
  }
  e = { got, minute, kline, ob, fund, ensure };
  cache.set(code, e);
  return e;
}

export interface WidgetData {
  /** 最终生效代码：微件 bind 优先，否则当前层主标的 */
  code: ComputedRef<string | null>;
  quote: ComputedRef<Quote | undefined>;
  name: ComputedRef<string>;
  minute: ComputedRef<KBar[]>;
  kline: ComputedRef<KBar[]>;
  ob: ComputedRef<OrderBook | null>;
  fund: ComputedRef<FundFlow | null>;
  ensure(kind: WidgetDataKind): Promise<void>;
}

// bind 可以是 props.bind（null/undefined=跟随卡主标的）
export function useWidgetData(
  bind?: Ref<string | null | undefined> | ComputedRef<string | null | undefined>
): WidgetData {
  const ctx = useMarketContext();
  const code = computed(
    () => bind?.value ?? ctx.primaryCode.value ?? null
  );
  const entry = computed(() => (code.value ? entryFor(code.value) : null));
  return {
    code,
    quote: computed(() => ctx.quoteOf(code.value ?? undefined)),
    name: computed(
      () =>
        ctx.nameOf(code.value ?? undefined) || code.value || ""
    ),
    minute: computed(() => entry.value?.minute.value ?? []),
    kline: computed(() => entry.value?.kline.value ?? []),
    ob: computed(() => entry.value?.ob.value ?? null),
    fund: computed(() => entry.value?.fund.value ?? null),
    ensure: async (kind) => {
      await entry.value?.ensure(kind);
    },
  };
}
