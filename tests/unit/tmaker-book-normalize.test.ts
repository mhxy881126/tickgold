import { describe, expect, it } from "vitest";
import { normalizeBook } from "../../src/composables/tmaker/bookNormalize";
import type { OrderBook, OrderLevel } from "../../src/api/types";

function lv(price: number, vol = 100): OrderLevel {
  return { price, vol };
}
function book(asks: OrderLevel[], bids: OrderLevel[]): OrderBook {
  return { price: 0, prevClose: 0, open: 0, high: 0, low: 0, volume: 0, amount: 0, name: "", code: "", asks, bids };
}

describe("normalizeBook 五档方向自愈", () => {
  it("东财镜像：asks 降序(买盘) + bids 升序(卖盘) → 互换恢复标准语义", () => {
    const ob = book(
      [lv(18.55), lv(18.54), lv(18.53), lv(18.52), lv(18.51)], // 实为买盘（买1 最高）
      [lv(18.56), lv(18.57), lv(18.58), lv(18.59), lv(18.60)], // 实为卖盘（卖1 最低）
    );
    const n = normalizeBook(ob);
    expect(n.asks.map((x) => x.price)).toEqual([18.56, 18.57, 18.58, 18.59, 18.60]); // 卖1..卖5 升序
    expect(n.bids.map((x) => x.price)).toEqual([18.55, 18.54, 18.53, 18.52, 18.51]); // 买1..买5 降序
  });

  it("正常数据：asks 升序 + bids 降序 → 原样返回（不误伤）", () => {
    const ob = book(
      [lv(18.56), lv(18.57), lv(18.58), lv(18.59), lv(18.60)],
      [lv(18.55), lv(18.54), lv(18.53), lv(18.52), lv(18.51)],
    );
    const n = normalizeBook(ob);
    expect(n.asks).toBe(ob.asks);
    expect(n.bids).toBe(ob.bids);
  });

  it("单边反序 → 独立反转恢复标准方向；不足两档无法判定 → 原样", () => {
    const ob = book([lv(18.55)], [lv(18.56)]);
    const n = normalizeBook(ob);
    expect(n.asks).toBe(ob.asks);
    expect(n.bids).toBe(ob.bids);
    const oneSide = book([lv(18.55), lv(18.54), lv(18.53)], []); // asks 降序（卖1 应为最低）
    const n2 = normalizeBook(oneSide);
    expect(n2.asks.map((x) => x.price)).toEqual([18.53, 18.54, 18.55]);
    expect(n2.bids).toBe(oneSide.bids);
  });

  it("asks 降序 + bids 全空（如一字涨停无买盘）→ 仅反转 asks，bids 原样", () => {
    const ob = book(
      [lv(33.64), lv(33.63), lv(33.62), lv(33.60), lv(33.58)], // 卖1 被错放为最高价
      [],
    );
    const n = normalizeBook(ob);
    expect(n.asks.map((x) => x.price)).toEqual([33.58, 33.60, 33.62, 33.63, 33.64]); // 卖1..卖5 升序
    expect(n.bids).toEqual([]);
  });

  it("涨停单边（后端旧版未swap）：asks 中位低于现价 + bids 空 → 整体互换，买1=涨停价封单", () => {
    const ob = book([lv(29.18), lv(29.17), lv(29.16), lv(29.15), lv(29.14)], []);
    (ob as any).price = 29.18;
    const n = normalizeBook(ob);
    expect(n.asks).toEqual([]);
    expect(n.bids.map((x) => x.price)).toEqual([29.18, 29.17, 29.16, 29.15, 29.14]); // 买1 最高=涨停价
  });

  it("跌停单边（后端旧版未swap）：bids 中位高于现价 + asks 空 → 整体互换，卖1=跌停价", () => {
    const ob = book([], [lv(10.00), lv(10.01), lv(10.02), lv(10.03), lv(10.04)]);
    (ob as any).price = 10.00;
    const n = normalizeBook(ob);
    expect(n.bids).toEqual([]);
    expect(n.asks.map((x) => x.price)).toEqual([10.00, 10.01, 10.02, 10.03, 10.04]); // 卖1 最低=跌停价
  });

  it("正常盘口卖1=现价 → 不误判整体互换", () => {
    const ob = book([lv(29.18), lv(29.19), lv(29.20), lv(29.21), lv(29.22)], [lv(29.17), lv(29.16), lv(29.15), lv(29.14), lv(29.13)]);
    (ob as any).price = 29.18;
    const n = normalizeBook(ob);
    expect(n.asks).toBe(ob.asks);
    expect(n.bids).toBe(ob.bids);
  });

  it("bids 升序 + asks 全空（如一字跌停无卖盘）→ 仅反转 bids，asks 原样", () => {
    const ob = book(
      [],
      [lv(10.47), lv(10.48), lv(10.49), lv(10.51), lv(10.52)], // 买1 被错放为最低价
    );
    const n = normalizeBook(ob);
    expect(n.bids.map((x) => x.price)).toEqual([10.52, 10.51, 10.49, 10.48, 10.47]); // 买1..买5 降序
    expect(n.asks).toEqual([]);
  });
});
