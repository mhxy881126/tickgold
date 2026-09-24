<script setup lang="ts">
import { ref, computed } from "vue";

const tab = ref(0);
const tabs = ["盈亏计算", "仓位管理", "风报比", "补仓成本", "涨跌幅", "复利", "黄金分割"];

// ===== 1. 盈亏计算 =====
const p = ref({ bp: 10, sp: 11, vol: 1000, fee: 0.025, stamp: 0.05, trans: 0.001 });
const buy = computed(() => {
  const amt = p.value.bp * p.value.vol;
  const comm = Math.max((amt * p.value.fee) / 100, 5);
  const tr = (amt * p.value.trans) / 100;
  return { amt, comm, tr, total: amt + comm + tr };
});
const sell = computed(() => {
  const amt = p.value.sp * p.value.vol;
  const comm = Math.max((amt * p.value.fee) / 100, 5);
  const st = (amt * p.value.stamp) / 100;
  const tr = (amt * p.value.trans) / 100;
  return { amt, comm, st, tr, net: amt - comm - st - tr };
});
const pnl = computed(() => sell.value.net - buy.value.total);
const pnlPct = computed(() => (pnl.value / buy.value.total) * 100);
const breakeven = computed(() => {
  const rate = (p.value.stamp + p.value.trans + p.value.fee) / 100;
  return buy.value.total / (p.value.vol * (1 - rate));
});

// ===== 2. 仓位管理 =====
const pos = ref({ fund: 100000, bp: 10, sl: 9.5, risk: 1 });
const perShareRisk = computed(() => Math.max(pos.value.bp - pos.value.sl, 0.0001));
const sugVol = computed(() => Math.max(0, Math.floor((pos.value.fund * pos.value.risk / 100) / perShareRisk.value / 100) * 100));
const posAmount = computed(() => sugVol.value * pos.value.bp);
const posPct = computed(() => (posAmount.value / pos.value.fund) * 100);
const maxLoss = computed(() => sugVol.value * perShareRisk.value);

// ===== 3. 止盈止损 / 风险回报比 =====
const rr = ref({ entry: 10, sl: 9.5, target: 11.5 });
const riskAmt = computed(() => rr.value.entry - rr.value.sl);
const rewardAmt = computed(() => rr.value.target - rr.value.entry);
const ratio = computed(() => (riskAmt.value > 0 ? rewardAmt.value / riskAmt.value : 0));

// ===== 4. 补仓成本 =====
const ad = ref({ v1: 1000, p1: 10, v2: 1000, p2: 9 });
const newAvg = computed(() => {
  const tv = ad.value.v1 + ad.value.v2;
  return tv > 0 ? (ad.value.v1 * ad.value.p1 + ad.value.v2 * ad.value.p2) / tv : 0;
});

// ===== 5. 涨跌幅 =====
const ch = ref({ from: 10, to: 11 });
const chg = computed(() => ch.value.to - ch.value.from);
const chgPct = computed(() => (ch.value.from ? (chg.value / ch.value.from) * 100 : 0));

// ===== 6. 复利 =====
const cp = ref({ principal: 10000, rate: 5, periods: 12 });
const fv = computed(() => cp.value.principal * Math.pow(1 + cp.value.rate / 100, cp.value.periods));
const cpGain = computed(() => fv.value - cp.value.principal);

// ===== 7. 黄金分割 =====
const fb = ref({ high: 12, low: 8 });
const fibLevels = computed(() => {
  const d = fb.value.high - fb.value.low;
  return [
    { r: "0% 高点", v: fb.value.high },
    { r: "23.6%", v: fb.value.high - d * 0.236 },
    { r: "38.2%", v: fb.value.high - d * 0.382 },
    { r: "50% 中轴", v: fb.value.high - d * 0.5 },
    { r: "61.8%", v: fb.value.high - d * 0.618 },
    { r: "78.6%", v: fb.value.high - d * 0.786 },
    { r: "100% 低点", v: fb.value.low },
  ];
});

const n2 = (v: number) => (isFinite(v) ? v.toFixed(2) : "--");
const n0 = (v: number) => (isFinite(v) ? v.toFixed(0) : "--");
</script>

<template>
  <div class="calc">
    <!-- Tab 条 -->
    <div class="ctabs">
      <button
        v-for="(t, i) in tabs"
        :key="t"
        class="ctab"
        :class="{ on: tab === i }"
        @click="tab = i"
      >{{ t }}</button>
    </div>

    <div class="cbody">
      <!-- 1 盈亏 -->
      <div v-if="tab === 0" class="panel">
        <div class="field"><label>买入价</label><input v-model.number="p.bp" type="number" step="0.01" /><em>元</em></div>
        <div class="field"><label>卖出价</label><input v-model.number="p.sp" type="number" step="0.01" /><em>元</em></div>
        <div class="field"><label>数量</label><input v-model.number="p.vol" type="number" step="100" /><em>股</em></div>
        <div class="field"><label>佣金费率</label><input v-model.number="p.fee" type="number" step="0.001" /><em>% 双向,最低5元</em></div>
        <div class="field"><label>印花税</label><input v-model.number="p.stamp" type="number" step="0.01" /><em>% 卖出</em></div>
        <div class="field"><label>过户费</label><input v-model.number="p.trans" type="number" step="0.001" /><em>% 双向</em></div>
        <div class="big" :class="pnl >= 0 ? 'up' : 'down'">
          <div class="big-label">净盈亏</div>
          <div class="big-val">{{ pnl >= 0 ? "+" : "" }}{{ n2(pnl) }} 元</div>
          <div class="big-sub">收益率 {{ pnlPct >= 0 ? "+" : "" }}{{ n2(pnlPct) }}%</div>
        </div>
        <div class="res-grid">
          <div class="rc"><span>买入总支出</span><b>{{ n2(buy.total) }}</b></div>
          <div class="rc"><span>卖出净收入</span><b>{{ n2(sell.net) }}</b></div>
          <div class="rc"><span>买入佣金</span><b>{{ n2(buy.comm) }}</b></div>
          <div class="rc"><span>卖出佣金</span><b>{{ n2(sell.comm) }}</b></div>
          <div class="rc"><span>印花税</span><b>{{ n2(sell.st) }}</b></div>
          <div class="rc accent"><span>保本价</span><b>{{ n2(breakeven) }}</b></div>
        </div>
      </div>

      <!-- 2 仓位 -->
      <div v-else-if="tab === 1" class="panel">
        <div class="field"><label>总资金</label><input v-model.number="pos.fund" type="number" /><em>元</em></div>
        <div class="field"><label>计划买入价</label><input v-model.number="pos.bp" type="number" step="0.01" /><em>元</em></div>
        <div class="field"><label>止损价</label><input v-model.number="pos.sl" type="number" step="0.01" /><em>元</em></div>
        <div class="field"><label>单笔风险</label><input v-model.number="pos.risk" type="number" step="0.1" /><em>% 总资金</em></div>
        <div class="big accent">
          <div class="big-label">建议买入数量</div>
          <div class="big-val">{{ n0(sugVol) }} 股</div>
          <div class="big-sub">约 {{ n0(sugVol / 100) }} 手</div>
        </div>
        <div class="res-grid">
          <div class="rc"><span>占用资金</span><b>{{ n2(posAmount) }}</b></div>
          <div class="rc"><span>仓位占比</span><b>{{ n2(posPct) }}%</b></div>
          <div class="rc down"><span>最大亏损</span><b>{{ n2(maxLoss) }}</b></div>
        </div>
      </div>

      <!-- 3 风报比 -->
      <div v-else-if="tab === 2" class="panel">
        <div class="field"><label>入场价</label><input v-model.number="rr.entry" type="number" step="0.01" /><em>元</em></div>
        <div class="field"><label>止损价</label><input v-model.number="rr.sl" type="number" step="0.01" /><em>元</em></div>
        <div class="field"><label>目标价</label><input v-model.number="rr.target" type="number" step="0.01" /><em>元</em></div>
        <div class="big" :class="ratio >= 2 ? 'up' : 'accent'">
          <div class="big-label">风险回报比 (盈亏比)</div>
          <div class="big-val">1 : {{ n2(ratio) }}</div>
          <div class="big-sub">{{ ratio >= 2 ? "比值理想(≥2)" : "建议≥2 更划算" }}</div>
        </div>
        <div class="res-grid">
          <div class="rc down"><span>每股风险</span><b>{{ n2(riskAmt) }}</b></div>
          <div class="rc up"><span>每股回报</span><b>{{ n2(rewardAmt) }}</b></div>
        </div>
      </div>

      <!-- 4 补仓 -->
      <div v-else-if="tab === 3" class="panel">
        <div class="field"><label>原持仓数量</label><input v-model.number="ad.v1" type="number" step="100" /><em>股</em></div>
        <div class="field"><label>原持仓均价</label><input v-model.number="ad.p1" type="number" step="0.01" /><em>元</em></div>
        <div class="field"><label>补仓数量</label><input v-model.number="ad.v2" type="number" step="100" /><em>股</em></div>
        <div class="field"><label>补仓价格</label><input v-model.number="ad.p2" type="number" step="0.01" /><em>元</em></div>
        <div class="big accent">
          <div class="big-label">补仓后新均价</div>
          <div class="big-val">{{ n2(newAvg) }} 元</div>
          <div class="big-sub">合计 {{ n0(ad.v1 + ad.v2) }} 股</div>
        </div>
      </div>

      <!-- 5 涨跌幅 -->
      <div v-else-if="tab === 4" class="panel">
        <div class="field"><label>原价</label><input v-model.number="ch.from" type="number" step="0.01" /><em>元</em></div>
        <div class="field"><label>现价</label><input v-model.number="ch.to" type="number" step="0.01" /><em>元</em></div>
        <div class="big" :class="chg >= 0 ? 'up' : 'down'">
          <div class="big-label">涨跌幅</div>
          <div class="big-val">{{ chg >= 0 ? "+" : "" }}{{ n2(chgPct) }}%</div>
          <div class="big-sub">涨跌额 {{ chg >= 0 ? "+" : "" }}{{ n2(chg) }} 元</div>
        </div>
      </div>

      <!-- 6 复利 -->
      <div v-else-if="tab === 5" class="panel">
        <div class="field"><label>初始本金</label><input v-model.number="cp.principal" type="number" /><em>元</em></div>
        <div class="field"><label>每期收益率</label><input v-model.number="cp.rate" type="number" step="0.1" /><em>%</em></div>
        <div class="field"><label>期数</label><input v-model.number="cp.periods" type="number" step="1" /><em>期</em></div>
        <div class="big up">
          <div class="big-label">到期终值</div>
          <div class="big-val">{{ n2(fv) }} 元</div>
          <div class="big-sub">累计收益 +{{ n2(cpGain) }} 元</div>
        </div>
      </div>

      <!-- 7 黄金分割 -->
      <div v-else class="panel">
        <div class="field"><label>波段高点</label><input v-model.number="fb.high" type="number" step="0.01" /><em>元</em></div>
        <div class="field"><label>波段低点</label><input v-model.number="fb.low" type="number" step="0.01" /><em>元</em></div>
        <div class="fib-list">
          <div v-for="f in fibLevels" :key="f.r" class="fib-row">
            <span class="fib-r">{{ f.r }}</span>
            <span class="fib-v">{{ n2(f.v) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.calc {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  color: var(--text);
  font-size: 12px;
}
.ctabs {
  display: flex;
  gap: 2px;
  padding: 6px 8px 0;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  flex-shrink: 0;
}
.ctab {
  border: none;
  background: transparent;
  color: var(--text-dim);
  padding: 6px 11px;
  font-size: 12px;
  border-radius: 7px 7px 0 0;
  cursor: pointer;
  white-space: nowrap;
}
.ctab:hover { color: var(--text); background: var(--bg-hover); }
.ctab.on { color: var(--accent); border-bottom: 2px solid var(--accent); }

.cbody { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; }
.panel { display: flex; flex-direction: column; gap: 9px; }

.field {
  display: grid;
  grid-template-columns: 86px 1fr auto;
  align-items: center;
  gap: 8px;
}
.field label { color: var(--text-dim); }
.field em {
  font-style: normal;
  color: var(--text-dim);
  font-size: 10px;
  white-space: nowrap;
}
.field input {
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-card2);
  color: var(--text);
  padding: 0 10px;
  font-size: 12px;
  width: 100%;
  box-sizing: border-box;
  font-variant-numeric: tabular-nums;
}
.field input:focus { outline: none; border-color: var(--accent); }

.big {
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 14px;
  text-align: center;
  background: var(--bg-card2);
  margin: 4px 0;
}
.big-label { font-size: 11px; color: var(--text-dim); }
.big-val {
  font-size: 26px;
  font-weight: 700;
  margin: 4px 0 2px;
  font-variant-numeric: tabular-nums;
}
.big-sub { font-size: 11px; color: var(--text-dim); }

.res-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}
.rc {
  display: flex;
  flex-direction: column;
  gap: 3px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--bg-card2);
}
.rc span { font-size: 10px; color: var(--text-dim); }
.rc b {
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.fib-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.fib-row {
  display: flex;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.fib-row:last-child { border-bottom: none; }
.fib-row:nth-child(odd) { background: var(--bg-card2); }
.fib-r { color: var(--text-dim); }
.fib-v { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--accent); }

.up { color: var(--up); }
.down { color: var(--down); }
.accent { color: var(--accent); }
.big.up { border-color: color-mix(in srgb, var(--up) 40%, transparent); }
.big.down { border-color: color-mix(in srgb, var(--down) 40%, transparent); }
.big.accent { border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.rc.up b { color: var(--up); }
.rc.down b { color: var(--down); }
.rc.accent b { color: var(--accent); }
</style>
