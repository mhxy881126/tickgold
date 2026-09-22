import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { db, ensureDb } from "../db/database";
import { fetchQuotes } from "../api/market";
import type { Quote } from "../api/types";

export interface PaperAccount { initCash: number; cash: number }
export interface PaperPosition {
  code: string; name: string; vol: number; availVol: number; costAmount: number;
}
export interface PaperOrder {
  id: string; code: string; name: string; side: "buy" | "sell";
  price: number; vol: number; amount: number; fee: number;
  status: string; createdAt: number; tradeDate: string;
}

// 交易费用
const COMMISSION_RATE = 0.00025; // 佣金 万2.5（双向，最低 5 元）
const STAMP_RATE = 0.0005;       // 印花税 卖出 千0.5
const TRANSFER_RATE = 0.00001;   // 过户费 十万分之一（双向）
const INIT_CASH = 1_000_000;

function calcFee(side: "buy" | "sell", amount: number): number {
  const commission = Math.max(amount * COMMISSION_RATE, 5);
  const stamp = side === "sell" ? amount * STAMP_RATE : 0;
  const transfer = amount * TRANSFER_RATE;
  return commission + stamp + transfer;
}
function today(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function uid(): string {
  return "PO" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export const usePaperStore = defineStore("paper", () => {
  const account = ref<PaperAccount>({ initCash: INIT_CASH, cash: INIT_CASH });
  const positions = ref<PaperPosition[]>([]);
  const orders = ref<PaperOrder[]>([]);
  const priceMap = ref<Record<string, Quote>>({});
  const loaded = ref(false);
  let timer: number | null = null;

  // 首次初始化账户
  async function ensureAccount() {
    const d = db();
    await d.execute(
      "INSERT INTO paper_account(id, init_cash, cash, created_at) VALUES(1, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
      [INIT_CASH, INIT_CASH, Date.now()]
    );
  }

  // T+1 清算：跨自然日后把持仓股数同步为可卖（当日买入不增加 avail）
  async function settle() {
    const d = db();
    const r = await d.select<{ value: string | null }[]>(
      "SELECT value FROM meta WHERE key = 'paper_settle_date'"
    );
    const t = today();
    if ((r[0]?.value ?? "") !== t) {
      await d.execute("UPDATE paper_position SET avail_vol = vol");
      await d.execute(
        "INSERT INTO meta(key,value) VALUES('paper_settle_date',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [t]
      );
    }
  }

  async function reloadAll() {
    const d = db();
    const acc = await d.select<{ init_cash: number; cash: number }[]>(
      "SELECT init_cash, cash FROM paper_account WHERE id=1"
    );
    if (acc[0]) account.value = { initCash: acc[0].init_cash, cash: acc[0].cash };
    positions.value = (
      await d.select<PaperPositionRow[]>(
        "SELECT code, name, vol, avail_vol AS availVol, cost_amount AS costAmount FROM paper_position ORDER BY code"
      )
    ).map((p) => ({ ...p }));
    orders.value = (
      await d.select<PaperOrderRow[]>(
        "SELECT id, code, name, side, price, vol, amount, fee, status, created_at AS createdAt, trade_date AS tradeDate FROM paper_order ORDER BY created_at DESC LIMIT 200"
      )
    ).map((o) => ({ ...o }));
  }
  interface PaperPositionRow { code: string; name: string; vol: number; availVol: number; costAmount: number }
  interface PaperOrderRow {
    id: string; code: string; name: string; side: "buy" | "sell"; price: number; vol: number;
    amount: number; fee: number; status: string; createdAt: number; tradeDate: string;
  }

  async function refreshQuotes() {
    const codes = positions.value.map((p) => p.code);
    if (codes.length === 0) { priceMap.value = {}; return; }
    const qs = await fetchQuotes(codes);
    const m: Record<string, Quote> = {};
    for (const q of qs) m[q.code] = q;
    priceMap.value = m;
  }

  // 买入：{price} 由组件取实时价
  async function buy(code: string, name: string, price: number, vol: number): Promise<void> {
    if (!(price > 0)) throw new Error("行情无效，无法买入");
    if (vol <= 0 || vol % 100 !== 0) throw new Error("买入数量须为 100 股整数倍");
    const amount = price * vol;
    const fee = calcFee("buy", amount);
    const total = amount + fee;
    if (account.value.cash < total - 1e-6) throw new Error("可用资金不足");
    const d = db();
    await d.execute("UPDATE paper_account SET cash = cash - ? WHERE id=1", [total]);
    await d.execute(
      `INSERT INTO paper_position(code,name,vol,avail_vol,cost_amount,updated_at)
       VALUES(?,?,?,0,?,?)
       ON CONFLICT(code) DO UPDATE SET
         name=excluded.name, vol=vol+excluded.vol,
         cost_amount=cost_amount+excluded.cost_amount, updated_at=excluded.updated_at`,
      [code, name, vol, total, Date.now()]
    );
    await d.execute(
      `INSERT INTO paper_order(id,code,name,side,price,vol,amount,fee,status,created_at,trade_date)
       VALUES(?,?,?, 'buy', ?,?,?,?, 'filled',?,?)`,
      [uid(), code, name, price, vol, amount, fee, Date.now(), today()]
    );
    await reloadAll();
  }

  // 卖出
  async function sell(code: string, price: number, vol: number): Promise<void> {
    if (!(price > 0)) throw new Error("行情无效，无法卖出");
    const pos = positions.value.find((p) => p.code === code);
    if (!pos) throw new Error("无该股票持仓");
    if (vol <= 0 || vol > pos.availVol) throw new Error("卖出数量超过可卖（T+1）");
    const amount = price * vol;
    const fee = calcFee("sell", amount);
    const proceeds = amount - fee;
    const d = db();
    const newVol = pos.vol - vol;
    const costReduce = pos.costAmount * (vol / pos.vol);
    if (newVol <= 0) {
      await d.execute("DELETE FROM paper_position WHERE code=?", [code]);
    } else {
      await d.execute(
        "UPDATE paper_position SET vol=?, cost_amount=cost_amount-?, updated_at=? WHERE code=?",
        [newVol, costReduce, Date.now(), code]
      );
    }
    await d.execute("UPDATE paper_account SET cash = cash + ? WHERE id=1", [proceeds]);
    await d.execute(
      `INSERT INTO paper_order(id,code,name,side,price,vol,amount,fee,status,created_at,trade_date)
       VALUES(?,?,?, 'sell', ?,?,?,?, 'filled',?,?)`,
      [uid(), code, pos.name, price, vol, amount, fee, Date.now(), today()]
    );
    await reloadAll();
  }

  // 重置账户
  async function reset() {
    const d = db();
    await d.execute("DELETE FROM paper_position");
    await d.execute("DELETE FROM paper_order");
    await d.execute("UPDATE paper_account SET cash=init_cash WHERE id=1");
    priceMap.value = {};
    await reloadAll();
  }

  async function load() {
    await ensureDb();
    await ensureAccount();
    await settle();
    await reloadAll();
    await refreshQuotes();
    loaded.value = true;
    if (timer == null) timer = window.setInterval(refreshQuotes, 3000);
  }
  function stop() {
    if (timer != null) { clearInterval(timer); timer = null; }
  }

  // —— 汇总指标 ——
  const costOf = (p: PaperPosition) => p.costAmount;
  const marketValue = computed(() =>
    positions.value.reduce((s, p) => s + p.vol * (priceMap.value[p.code]?.price ?? p.costAmount / p.vol), 0)
  );
  const totalAssets = computed(() => account.value.cash + marketValue.value);
  const totalPnl = computed(() => totalAssets.value - account.value.initCash);
  const pnlPct = computed(() => (totalPnl.value / account.value.initCash) * 100);
  const floatPnl = computed(() =>
    positions.value.reduce((s, p) => s + (p.vol * (priceMap.value[p.code]?.price ?? 0) - costOf(p)), 0)
  );

  return {
    account, positions, orders, priceMap, loaded,
    load, stop, buy, sell, reset,
    marketValue, totalAssets, totalPnl, pnlPct, floatPnl,
  };
});
