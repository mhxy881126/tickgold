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

  it("不足两档/单边数据 → 不互换（无法判定方向）", () => {
    const ob = book([lv(18.55)], [lv(18.56)]);
    const n = normalizeBook(ob);
    expect(n.asks).toBe(ob.asks);
    expect(n.bids).toBe(ob.bids);
    const oneSide = book([lv(18.55), lv(18.54)], []);
    expect(normalizeBook(oneSide).asks).toBe(oneSide.asks);
  });
});
