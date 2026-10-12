import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { db, ensureDb } from "../db/database";
import { fetchQuotes } from "../api/market";
import type { Quote } from "../api/types";
import { portfolioBuy, portfolioSell } from "../broker/api";

export interface PaperAccount { initCash: number; cash: number }
export interface PaperPosition {
  code: string; name: string; vol: number; availVol: number; costAmount: number;
}
export interface PaperOrder {
  id: string; code: string; name: string; side: "buy" | "sell";
  price: number; vol: number; amount: number; fee: number;
  status: string; createdAt: number; tradeDate: string;
}

export const usePaperStore = defineStore("paper", () => {
  const account = ref<PaperAccount>({ initCash: 0, cash: 0 });
  const positions = ref<PaperPosition[]>([]);
  const orders = ref<PaperOrder[]>([]);
  const priceMap = ref<Record<string, Quote>>({});
  const loaded = ref(false);
  let timer: number | null = null;

  async function reloadAll() {
    const d = db();
    const acc = await d.select<{ init_cash: number; cash: number }[]>(
      "SELECT init_cash, cash FROM paper_account WHERE id=1"
    );
    if (acc[0]) account.value = { initCash: acc[0].init_cash, cash: acc[0].cash };
    positions.value = await d.select<PaperPosition[]>(
      "SELECT code, name, vol, avail_vol AS availVol, cost_amount AS costAmount FROM paper_position ORDER BY code"
    );
    orders.value = await d.select<PaperOrder[]>(
      "SELECT id, code, name, side, price, vol, amount, fee, status, created_at AS createdAt, trade_date AS tradeDate FROM paper_order ORDER BY created_at DESC LIMIT 200"
    );
  }

  async function refreshQuotes() {
    const codes = positions.value.map((p) => p.code);
    if (codes.length === 0) { priceMap.value = {}; return; }
    const qs = await fetchQuotes(codes);
    const m: Record<string, Quote> = {};
    for (const q of qs) m[q.code] = q;
    priceMap.value = m;
  }

  // 买入：{price} 由组件取实时价；落账统一走后端 portfolio（费用/T+1/settle 唯一口径）
  async function buy(code: string, name: string, price: number, vol: number): Promise<void> {
    if (!(price > 0)) throw new Error("行情无效，无法买入");
    if (vol <= 0 || vol % 100 !== 0) throw new Error("买入数量须为 100 股整数倍");
    await portfolioBuy(code, name, price, vol);
    await reloadAll();
  }

  // 卖出
  async function sell(code: string, price: number, vol: number): Promise<void> {
    if (!(price > 0)) throw new Error("行情无效，无法卖出");
    const pos = positions.value.find((p) => p.code === code);
    if (!pos) throw new Error("无该股票持仓");
    if (vol <= 0 || vol > pos.availVol) throw new Error("卖出数量超过可卖（T+1）");
    await portfolioSell(code, price, vol);
    await reloadAll();
  }

  // 重置账户（恢复原初始资金）
  async function reset() {
    const d = db();
    await d.execute("DELETE FROM paper_position");
    await d.execute("DELETE FROM paper_order");
    await d.execute("UPDATE paper_account SET cash=init_cash WHERE id=1");
    priceMap.value = {};
    await reloadAll();
  }

  // 按自定义初始总资金重置：清空持仓/委托，init_cash 与 cash 均设为 initCash
  async function resetWith(initCash: number) {
    if (!(initCash > 0)) throw new Error("初始资金须大于 0");
    const d = db();
    await d.execute("DELETE FROM paper_position");
    await d.execute("DELETE FROM paper_order");
    await d.execute("UPDATE paper_account SET init_cash=?, cash=? WHERE id=1", [initCash, initCash]);
    priceMap.value = {};
    await reloadAll();
  }

  async function load() {
    await ensureDb();
    await reloadAll();
    await refreshQuotes();
    loaded.value = true;
    if (timer == null) timer = window.setInterval(refreshQuotes, 3000);
  }
  function stop() {
    if (timer != null) { clearInterval(timer); timer = null; }
  }

  // —— 汇总指标 ——
  const marketValue = computed(() =>
    positions.value.reduce((s, p) => s + p.vol * (priceMap.value[p.code]?.price ?? p.costAmount / p.vol), 0)
  );
  const totalAssets = computed(() => account.value.cash + marketValue.value);
  const totalPnl = computed(() => totalAssets.value - account.value.initCash);
  const pnlPct = computed(() =>
    account.value.initCash > 0 ? (totalPnl.value / account.value.initCash) * 100 : 0
  );
  const floatPnl = computed(() =>
    positions.value.reduce(
      (s, p) => s + (p.vol * (priceMap.value[p.code]?.price ?? 0) - p.costAmount),
      0
    )
  );
  // 当日参考盈亏：持仓股数 ×（现价 − 昨收），无昨收数据的持仓不计
  const dayPnl = computed(() =>
    positions.value.reduce((s, p) => {
      const q = priceMap.value[p.code];
      return q ? s + p.vol * (q.price - q.prevClose) : s;
    }, 0)
  );

  return {
    account, positions, orders, priceMap, loaded,
    load, stop, buy, sell, reset, resetWith, reloadAll, refreshQuotes,
    marketValue, totalAssets, totalPnl, pnlPct, floatPnl, dayPnl,
  };
});
