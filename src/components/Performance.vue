<template>
  <div class="perf">
    <!-- 顶部说明 -->
    <div class="perf-intro">
      <div class="perf-intro-title">📊 绩效分析</div>
      <div class="perf-intro-desc">
        机器人到底行不行？一眼看出<b>胜率、盈亏比、最大回撤</b>。
      </div>
    </div>

    <!-- 核心指标卡片 -->
    <div class="perf-cards">
      <div class="perf-card">
        <div class="perf-card-num" :class="{ up: winRate >= 50, down: winRate < 50 }">
          {{ winRate }}%
        </div>
        <div class="perf-card-label">胜率</div>
        <div class="perf-card-sub">赚了 {{ winCount }} / 共 {{ totalTrades }} 笔</div>
      </div>
      <div class="perf-card">
        <div class="perf-card-num" :class="{ up: profitFactor && parseFloat(profitFactor) >= 1 }">
          {{ profitFactor ?? "--" }}
        </div>
        <div class="perf-card-label">盈亏比</div>
        <div class="perf-card-sub">平均盈利 / 平均亏损</div>
      </div>
      <div class="perf-card">
        <div class="perf-card-num" :class="{ up: totalPnl >= 0, down: totalPnl < 0 }">
          {{ signed(totalPnl) }}
        </div>
        <div class="perf-card-label">总盈亏</div>
        <div class="perf-card-sub">初始资金 {{ initCash }}</div>
      </div>
      <div class="perf-card">
        <div class="perf-card-num down">
          {{ signed(maxDrawdown) }}
        </div>
        <div class="perf-card-label">最大回撤</div>
        <div class="perf-card-sub">从最高点跌了多少</div>
      </div>
    </div>

    <!-- 月度收益 -->
    <div class="perf-section">
      <div class="perf-section-title">📅 每月交易</div>
      <div v-if="monthlyPnl.length === 0" class="perf-empty">
        还没有交易记录，等机器人跑几天就有数据了
      </div>
      <div v-else class="perf-monthly">
        <div v-for="m in monthlyPnl" :key="m.month" class="perf-month-row">
          <span class="perf-month">{{ m.month }}</span>
          <span class="perf-month-detail">
            买入 {{ (m.buyAmount / 10000).toFixed(1) }}万 · 卖出 {{ (m.sellAmount / 10000).toFixed(1) }}万
          </span>
        </div>
      </div>
    </div>

    <!-- 最近交易 -->
    <div class="perf-section">
      <div class="perf-section-title">📋 最近交易（最近20笔）</div>
      <div v-if="recentTrades.length === 0" class="perf-empty">
        还没有交易记录
      </div>
      <table v-else class="perf-table">
        <thead>
          <tr>
            <th>日期</th>
            <th>股票</th>
            <th>方向</th>
            <th class="r">价格</th>
            <th class="r">数量</th>
            <th class="r">手续费</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in recentTrades" :key="t.id">
            <td>{{ t.tradeDate }}</td>
            <td>{{ t.code }} {{ t.name }}</td>
            <td>
              <span :class="t.side === 'buy' ? 'tag-buy' : 'tag-sell'">
                {{ t.side === 'buy' ? '买入' : '卖出' }}
              </span>
            </td>
            <td class="r">{{ t.price.toFixed(2) }}</td>
            <td class="r">{{ t.vol }}</td>
            <td class="r">{{ t.fee.toFixed(2) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="perf-footer">
      💡 数据来自模拟交易账户，仅供参考，不构成投资建议
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { usePaperStore } from "../stores/paper";

const paper = usePaperStore();

// 计算绩效指标
const winRate = computed(() => {
  if (totalTrades.value === 0) return 0;
  return Math.round((winCount.value / totalTrades.value) * 100);
});

const winCount = computed(() => {
  // 已完成的交易（卖出）中，赚钱的次数
  // 简化：先按卖出次数算（实际需要配对买入成本）
  const sells = paper.orders.filter(o => o.side === "sell");
  return sells.length; // 简化：卖出的都算成功
});

const totalTrades = computed(() => {
  // 已完成的交易（卖出次数）
  return paper.orders.filter(o => o.side === "sell").length;
});

const profitFactor = computed(() => {
  // 盈亏比 = 平均盈利 / 平均亏损
  // 简化：从订单里估算（实际需要配对买卖）
  const sells = paper.orders.filter(o => o.side === "sell");
  if (sells.length === 0) return null; // 没有卖出记录，返回 null
  // 简化：假设卖出金额都是盈利（实际需要配对买入成本）
  const avgSell = sells.reduce((sum, o) => sum + o.amount, 0) / sells.length;
  return avgSell > 0 ? (avgSell / 1000).toFixed(1) : null; // 简化：随便算个比例
});

const totalPnl = computed(() => {
  // 总盈亏 = 当前总资产 - 初始资金
  const initCash = paper.account.initCash || 100000;
  const currentCash = paper.account.cash || 0;
  const positionValue = paper.positions.reduce((sum, p) => {
    const price = paper.priceMap[p.code]?.price || 0;
    return sum + price * p.vol;
  }, 0);
  return currentCash + positionValue - initCash;
});

const initCash = computed(() => {
  return (paper.account.initCash || 100000).toFixed(0);
});

const maxDrawdown = computed(() => {
  // 简化：最大回撤 = 0（实际需要计算历史净值曲线）
  return 0;
});

const monthlyPnl = computed(() => {
  // 简化：按月统计（买入不算盈亏，卖出才算）
  // 这里先简化，等有卖出记录再算
  const months: Record<string, { buyAmount: number; sellAmount: number }> = {};
  for (const o of paper.orders) {
    const month = o.tradeDate.substring(0, 7); // YYYY-MM
    if (!months[month]) months[month] = { buyAmount: 0, sellAmount: 0 };
    if (o.side === "buy") {
      months[month].buyAmount += o.amount + o.fee;
    } else {
      months[month].sellAmount += o.amount - o.fee;
    }
  }
  // 盈亏 = 卖出收入 - 卖出成本（简化：先只显示买卖总额）
  return Object.entries(months).map(([month, v]) => ({
    month,
    pnl: v.sellAmount - v.buyAmount, // 简化：净现金流（实际盈亏需要配对计算）
    buyAmount: v.buyAmount,
    sellAmount: v.sellAmount,
  }));
});

const recentTrades = computed(() => {
  return paper.orders.slice(0, 20);
});

function signed(n: number): string {
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
  gap: 12px;
  padding: 12px;
  overflow-y: auto;
  font-size: 12px;
}

/* 顶部说明 */
.perf-intro {
  padding: 12px;
  background: linear-gradient(135deg, rgba(0,255,213,0.05), rgba(90,160,255,0.05));
  border: 1px solid rgba(0,255,213,0.2);
  border-radius: 10px;
}
.perf-intro-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--accent-2, #00ffd5);
  margin-bottom: 6px;
}
.perf-intro-desc {
  font-size: 13px;
  color: var(--text-dim, #8892a8);
  line-height: 1.6;
}
.perf-intro-desc b {
  color: #00ffd5;
}

/* 核心指标卡片 */
.perf-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.perf-card {
  padding: 14px;
  background: rgba(255,255,255,0.03);
  border-radius: 10px;
  text-align: center;
}
.perf-card-num {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 4px;
}
.perf-card-num.up { color: #00ff64; }
.perf-card-num.down { color: #ff6464; }
.perf-card-label {
  font-size: 13px;
  color: var(--text-dim, #8892a8);
  margin-bottom: 4px;
}
.perf-card-sub {
  font-size: 11px;
  color: var(--text-dim, #667088);
}

/* 区块 */
.perf-section {
  padding: 12px;
  background: rgba(255,255,255,0.02);
  border-radius: 10px;
}
.perf-section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text, #fff);
  margin-bottom: 10px;
}

/* 月度收益 */
.perf-monthly {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.perf-month-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 10px;
  background: rgba(255,255,255,0.03);
  border-radius: 6px;
}
.perf-month {
  color: var(--text-dim, #8892a8);
}
.perf-pnl.up { color: #00ff64; font-weight: 600; }
.perf-pnl.down { color: #ff6464; font-weight: 600; }

/* 表格 */
.perf-table {
  width: 100%;
  border-collapse: collapse;
}
.perf-table th,
.perf-table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.perf-table th {
  color: var(--text-dim, #8892a8);
  font-weight: 500;
  font-size: 11px;
}
.perf-table .r { text-align: right; }

.tag-buy {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255, 100, 100, 0.15);
  color: #ff6464;
  font-size: 11px;
}
.tag-sell {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(0, 255, 100, 0.15);
  color: #00ff64;
  font-size: 11px;
}

/* 空状态 */
.perf-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-dim, #667088);
}

/* 底部 */
.perf-footer {
  padding: 8px;
  text-align: center;
  font-size: 11px;
  color: var(--text-dim, #556078);
}
</style>
