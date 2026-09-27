// 评估上下文数据供应：指标 / 盘口 / 竞价缓存，涨速价格历史，封板边沿，prev 快照
import { fetchKLine, fetchOrderBook, fetchAuction } from "../api/market";
import type { Quote, OrderBook } from "../api/types";
import type { AlertRuleV2, Leaf, Scope } from "./types";
import { isNode } from "./types";
import { fieldSpec, type FieldCategory } from "./fields";
import { ma, ema, macd, kdj, rsi } from "../utils/indicators";
import { limitPrices } from "../utils/limit";
import { isAuction } from "../utils/sessions";
import type { Resolve } from "./evaluate";

type QuotesMap = Record<string, Quote>;

const IND_TTL = 60_000;
const BOOK_TTL = 5_000;
const AUC_TTL = 10_000;

/** 规则作用域 → 代码列表 */
export function expandScope(
  scope: Scope,
  wlCodes: string[],
  groupCodes: (gid: number) => string[]
): string[] {
  if (scope.kind === "code") return [scope.code];
  if (scope.kind === "group") return groupCodes(scope.groupId);
  return wlCodes;
}

/** 收集规则树内全部叶子 */
export function collectLeaves(rule: AlertRuleV2): Leaf[] {
  const out: Leaf[] = [];
  const walk = (item: unknown): void => {
    if (isNode(item as never)) {
      for (const c of (item as { children: unknown[] }).children) walk(c);
    } else out.push(item as Leaf);
  };
  walk(rule.tree);
  return out;
}

function hasCategory(leaves: Leaf[], cat: FieldCategory): boolean {
  return leaves.some((l) => fieldSpec(l.field)?.category === cat);
}

function paramKey(params?: Record<string, number>): string {
  if (!params) return "";
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

function windowsFor(leaves: Leaf[]): number[] {
  const ws = new Set<number>();
  for (const l of leaves)
    if (l.field === "speedPct") ws.add(l.params?.windowSec ?? 300);
  if (ws.size === 0) ws.add(300);
  return [...ws];
}

/** 展开后的规则评估目标 */
export interface RuleTarget {
  rule: AlertRuleV2;
  codes: string[];
}

export class ContextProvider {
  private values = new Map<string, number>();
  private prevMap = new Map<string, number>();
  private priceHist = new Map<string, [number, number][]>();
  private sealState = new Map<string, string>();

  private indAt = 0;
  private bookAt = 0;
  private aucAt = 0;

  async refresh(targets: RuleTarget[], quotes: QuotesMap, now: number): Promise<void> {
    this.values.clear();
    const active = targets.filter((t) => t.rule.enabled);

    const allLeaves = new Set<Leaf>();
    for (const t of active) for (const l of collectLeaves(t.rule)) allLeaves.add(l);
    const leaves = [...allLeaves];

    this.fillRealtime(active, leaves, quotes, now);

    const indCodes = codesFor(active, leaves, "indicator");
    const bookCodes = codesFor(active, leaves, "book");

    if (indCodes.size > 0 && now - this.indAt > IND_TTL) {
      await this.computeIndicators(indCodes, leaves);
      this.indAt = now;
    }
    if (bookCodes.size > 0 && now - this.bookAt > BOOK_TTL) {
      await this.computeBooks(bookCodes);
      this.bookAt = now;
    }
    if (hasCategory(leaves, "auction") && isAuction(new Date(now)) && now - this.aucAt > AUC_TTL) {
      await this.computeAuction();
      this.aucAt = now;
    }
  }

  /** 同步：行情标量 / 涨速 / 封板边沿 */
  private fillRealtime(targets: RuleTarget[], leaves: Leaf[], quotes: QuotesMap, now: number) {
    const codeSet = new Set<string>();
    for (const t of targets) for (const c of t.codes) codeSet.add(c);

    const maxWin = Math.max(0, ...windowsFor(leaves));
    const edges = new Map<string, { sealUp: boolean; sealDn: boolean; broken: boolean }>();

    for (const code of codeSet) {
      const q = quotes[code];
      if (!q) continue;

      const hist = this.priceHist.get(code) ?? [];
      hist.push([now, q.price]);
      if (maxWin > 0) {
        const cutoff = now - (maxWin + 60) * 1000;
        while (hist.length && hist[0][0] < cutoff) hist.shift();
      }
      this.priceHist.set(code, hist);

      const [lu, ld] = limitPrices(code, q.name, q.prevClose);
      const eps = 0.001;
      const cur =
        q.price >= lu - eps ? "seal_up"
        : q.price <= ld + eps ? "seal_dn"
        : q.high >= lu - eps ? "open_broken"
        : "";
      const prev = this.sealState.get(code) ?? "";
      edges.set(code, {
        sealUp: cur === "seal_up" && prev !== "seal_up",
        sealDn: cur === "seal_dn" && prev !== "seal_dn",
        broken: cur === "open_broken" && prev === "seal_up",
      });
      this.sealState.set(code, cur);

      const put = (field: string, val: number, pk = "") =>
        this.values.set(rkey(code, field, pk), val);
      put("price", q.price);
      put("pct", q.pct);
      put("volumeRatio", q.volumeRatio);
      put("turnover", q.turnover);
      put("amountYi", q.amount / 1e8);
      put("evt.sealUp", edges.get(code)!.sealUp ? 1 : 0);
      put("evt.sealDn", edges.get(code)!.sealDn ? 1 : 0);
      put("evt.broken", edges.get(code)!.broken ? 1 : 0);

      for (const w of windowsFor(leaves)) {
        const old = hist.find(([t]) => t <= now - w * 1000)?.[1];
        if (old && old > 0)
          put("speedPct", ((q.price - old) / old) * 100, `windowSec=${w}`);
      }
    }
  }

  private async computeIndicators(codes: Set<string>, leaves: Leaf[]) {
    const indLeaves = leaves.filter((l) => fieldSpec(l.field)?.category === "indicator");
    for (const code of codes) {
      const bars = await fetchKLine(code, 101, 300);
      if (bars.length === 0) continue;
      const closes = bars.map((b) => b.close);
      for (const l of indLeaves) {
        const p = l.params ?? {};
        let val: number | null = null;
        switch (l.field) {
          case "ind.ma": val = ma(closes, p.period ?? 20); break;
          case "ind.ema": val = ema(closes, p.period ?? 20); break;
          case "ind.macd": val = macd(closes, p.fast ?? 12, p.slow ?? 26, p.signal ?? 9)?.macd ?? null; break;
          case "ind.dif": val = macd(closes, p.fast ?? 12, p.slow ?? 26, 9)?.dif ?? null; break;
          case "ind.dea": val = macd(closes)?.dea ?? null; break;
          case "ind.k": val = kdj(bars, p.period ?? 9)?.k ?? null; break;
          case "ind.d": val = kdj(bars)?.d ?? null; break;
          case "ind.j": val = kdj(bars)?.j ?? null; break;
          case "ind.rsi": val = rsi(closes, p.period ?? 14); break;
        }
        if (val != null) this.values.set(rkey(code, l.field, paramKey(l.params)), val);
      }
    }
  }

  private async computeBooks(codes: Set<string>) {
    for (const code of codes) {
      const ob: OrderBook = await fetchOrderBook(code);
      const bid = ob.bids.reduce((a, x) => a + x.vol, 0);
      const ask = ob.asks.reduce((a, x) => a + x.vol, 0);
      if (ask > 0) this.values.set(rkey(code, "book.bidAskRatio"), bid / ask);
    }
  }

  private async computeAuction() {
    const data = await fetchAuction();
    for (const s of [...data.highOpen, ...data.lowOpen]) {
      this.values.set(rkey(s.code, "auction.gap"), s.gap);
      this.values.set(rkey(s.code, "auction.amountYi"), s.amount / 1e8);
    }
  }

  resolver(code: string): Resolve {
    return (leaf: Leaf) => {
      const k = rkey(code, leaf.field, paramKey(leaf.params));
      return {
        cur: this.values.has(k) ? this.values.get(k)! : null,
        prev: this.prevMap.has(k) ? this.prevMap.get(k)! : null,
      };
    };
  }

  commitPrev(): void {
    this.prevMap = new Map(this.values);
  }
}

/** 某类条件实际覆盖的代码（仅含规则树里确实用到该类的规则） */
function codesFor(targets: RuleTarget[], leaves: Leaf[], cat: FieldCategory): Set<string> {
  const out = new Set<string>();
  for (const t of targets) {
    if (collectLeaves(t.rule).some((l) => fieldSpec(l.field)?.category === cat)) {
      for (const c of t.codes) out.add(c);
    }
  }
  void leaves;
  return out;
}

function rkey(code: string, field: string, pk = ""): string {
  return `${code}|${field}|${pk}`;
}
