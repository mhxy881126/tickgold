<template>
  <div class="perf">
    <div class="perf-intro">
      <div class="perf-intro-title">绩效分析</div>
      <div class="perf-intro-desc">
        按 <b>FIFO 闭环交易</b>统计胜率、盈亏比与已实现回撤；总盈亏为<b>现价口径（含浮动）</b>。历史成交统计，不代表未来收益。
      </div>
    </div>

    <!-- 核心指标 -->
    <div class="perf-cards">
      <div class="perf-card">
        <div class="perf-card-num" :class="{ up: stats.winRate >= 50, down: stats.trades>0 && stats.winRate < 50 }">
          {{ stats.trades ? stats.winRate.toFixed(0) + "%" : "--" }}
        </div>
        <div class="perf-card-label">胜率</div>
        <div class="perf-card-sub">盈利 {{ stats.wins }} / 闭环 {{ stats.trades }} 笔</div>
      </div>
      <div class="perf-card">
        <div class="perf-card-num" :class="{ up: stats.profitFactor != null && stats.profitFactor >= 1 }">
          {{ stats.profitFactor != null ? stats.profitFactor.toFixed(2) : "--" }}
        </div>
        <div class="perf-card-label">盈亏比</div>
        <div class="perf-card-sub">总盈利 / 总亏损</div>
      </div>
      <div class="perf-card">
        <div class="perf-card-num" :class="{ up: paper.totalPnl >= 0, down: paper.totalPnl < 0 }">
          {{ signed(paper.totalPnl) }}
        </div>
        <div class="perf-card-label">总盈亏（含浮动）</div>
        <div class="perf-card-sub">{{ paper.pnlPct.toFixed(2) }}% · 初始 {{ Math.round(paper.account.initCash) }}</div>
      </div>
      <div class="perf-card">
        <div class="perf-card-num down">{{ stats.maxDrawdown.toFixed(0) }}</div>
        <div class="perf-card-label">已实现最大回撤</div>
        <div class="perf-card-sub">{{ stats.maxDrawdownPct.toFixed(2) }}% · 成本口径</div>
      </div>
    </div>

    <!-- 次级指标 -->
    <div class="perf-sub">
      <div class="ps-item"><span class="ps-k">平均盈利</span><span class="ps-v up">{{ money(stats.avgWin) }}</span></div>
      <div class="ps-item"><span class="ps-k">平均亏损</span><span class="ps-v down">{{ money(stats.avgLoss) }}</span></div>
      <div class="ps-item"><span class="ps-k">单笔期望</span><span class="ps-v" :class="stats.expectancy>=0?'up':'down'">{{ money(stats.expectancy) }}</span></div>
      <div class="ps-item"><span class="ps-k">平均持仓</span><span class="ps-v">{{ stats.avgHoldDays.toFixed(1) }} 天</span></div>
      <div class="ps-item"><span class="ps-k">累计费用</span><span class="ps-v">{{ money(stats.totalFees) }}</span></div>
      <div class="ps-item"><span class="ps-k">最大单笔盈</span><span class="ps-v up">{{ money(stats.largestWin) }}</span></div>
      <div class="ps-item"><span class="ps-k">最大单笔亏</span><span class="ps-v down">{{ money(stats.largestLoss) }}</span></div>
      <div class="ps-item"><span class="ps-k">持平</span><span class="ps-v">{{ stats.scratch }} 笔</span></div>
    </div>

    <div class="perf-cols">
      <!-- 月度归因 -->
      <div class="perf-section">
        <div class="perf-section-title">月度归因</div>
        <div v-if="stats.monthly.length === 0" class="perf-empty">暂无已闭环交易</div>
        <div v-else class="perf-table-wrap">
          <table class="perf-table">
            <thead><tr><th>月份</th><th class="r">已实现</th><th class="r">胜/负</th><th class="r">胜率</th></tr></thead>
            <tbody>
              <tr v-for="m in [...stats.monthly].reverse()" :key="m.month">
                <td>{{ m.month }}</td>
                <td class="r" :class="m.pnl>=0?'up':'down'">{{ signed(m.pnl) }}</td>
                <td class="r">{{ m.wins }} / {{ m.losses }}</td>
                <td class="r">{{ m.trades ? Math.round(m.wins/m.trades*100) : 0 }}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 闭环交易明细 -->
      <div class="perf-section">
        <div class="perf-section-title">闭环交易明细（最近 30 笔）</div>
        <div v-if="recentTrips.length === 0" class="perf-empty">
          暂无闭环。买入后于另一交易日卖出，即形成一笔闭环交易。
        </div>
        <div v-else class="perf-table-wrap">
          <table class="perf-table">
            <thead><tr><th>代码</th><th>买→卖</th><th class="r">持仓</th><th class="r">收益</th><th class="r">盈亏</th></tr></thead>
            <tbody>
              <tr v-for="(rt,i) in recentTrips" :key="i">
                <td>{{ rt.code }}</td>
                <td class="dates">{{ rt.entryDate.slice(5) }} → {{ rt.exitDate.slice(5) }}</td>
                <td class="r">{{ rt.holdingDays }}天</td>
                <td class="r" :class="rt.retPct>=0?'up':'down'">{{ rt.retPct>=0?"+":"" }}{{ rt.retPct.toFixed(1) }}%</td>
                <td class="r" :class="rt.pnl>=0?'up':'down'">{{ signed(rt.pnl) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="perf-footer">
      数据来自本地账本（含模拟与实盘已确认成交）。FIFO 闭环含买卖费用；含浮动的真实最大回撤需日终净值快照积累。仅供复盘，不构成投资建议。
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { usePaperStore } from "../stores/paper";
import { analyzePerformance, type RoundTrip } from "../lib/performance";

const paper = usePaperStore();

const stats = computed(() =>
  analyzePerformance(paper.orders, paper.account.initCash || 100000)
);

const recentTrips = computed<RoundTrip[]>(() =>
  [...stats.value.roundTrips].reverse().slice(0, 30)
);

function signed(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(0);
}
function money(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(0);
}

onMounted(async () => {
  await paper.load();
});
</script>

<style scoped>
.perf {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  overflow-y: auto;
  font-size: 12px;
}

.perf-intro {
  padding: 11px 12px;
  background: var(--bg-card2);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.perf-intro-title { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
.perf-intro-desc { font-size: 11px; color: var(--text-dim); line-height: 1.6; }
.perf-intro-desc b { color: var(--text); }

.perf-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.perf-card {
  padding: 12px 10px;
  background: var(--bg-card2);
  border: 1px solid var(--border);
  border-radius: 10px;
  text-align: center;
}
.perf-card-num { font-size: 22px; font-weight: 700; margin-bottom: 3px; line-height: 1.1; }
.perf-card-num.up { color: var(--down); }
.perf-card-num.down { color: var(--up); }
.perf-card-label { font-size: 12px; margin-bottom: 3px; }
.perf-card-sub { font-size: 10px; color: var(--text-dim); }

.perf-sub {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px 10px;
  padding: 10px;
  background: var(--bg-card2);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.ps-item { display: flex; justify-content: space-between; align-items: center; }
.ps-k { color: var(--text-dim); font-size: 11px; }
.ps-v { font-size: 11px; font-weight: 600; }
.ps-v.up { color: var(--down); }
.ps-v.down { color: var(--up); }

.perf-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  min-height: 0;
}
.perf-section {
  padding: 11px;
  background: var(--bg-card2);
  border: 1px solid var(--border);
  border-radius: 10px;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.perf-section-title { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
.perf-table-wrap { overflow-y: auto; max-height: 260px; }
.perf-table { width: 100%; border-collapse: collapse; }
.perf-table th, .perf-table td {
  padding: 5px 6px;
  text-align: left;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.perf-table th { color: var(--text-dim); font-weight: 500; font-size: 10px; position: sticky; top: 0; background: var(--bg-card2); }
.perf-table .r { text-align: right; }
.perf-table .up { color: var(--down); }
.perf-table .down { color: var(--up); }
.perf-table .dates { color: var(--text-dim); font-size: 11px; }

.perf-empty { padding: 20px; text-align: center; color: var(--text-dim); font-size: 11px; }

.perf-footer { font-size: 10px; color: var(--text-dim); line-height: 1.6; text-align: center; }

@media (max-width: 900px) {
  .perf-cards { grid-template-columns: repeat(2, 1fr); }
  .perf-sub { grid-template-columns: repeat(2, 1fr); }
  .perf-cols { grid-template-columns: 1fr; }
}
</style>
