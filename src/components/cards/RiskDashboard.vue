<template>
  <div class="risk">
    <!-- 顶部权益条 -->
    <div class="risk-hero">
      <div class="risk-hero-main">
        <div class="risk-hero-label">总权益</div>
        <div class="risk-hero-num">{{ money(snap?.equity) }}</div>
        <div class="risk-hero-sub">
          现金 {{ money(snap?.cash) }} · 持仓 {{ money(snap?.marketValue) }}
        </div>
      </div>
      <button class="risk-refresh" :disabled="loading" @click="load">
        {{ loading ? "…" : "刷新" }}
      </button>
    </div>

    <!-- 四宫格读数 -->
    <div class="risk-grid">
      <div class="risk-tile">
        <div class="risk-tile-num" :class="pnlClass(snap?.totalPnl)">
          {{ signed(snap?.totalPnl) }}
        </div>
        <div class="risk-tile-label">累计盈亏</div>
        <div class="risk-tile-sub">{{ pct(snap?.totalPnlPct) }}</div>
      </div>
      <div class="risk-tile">
        <div class="risk-tile-num" :class="pnlClass(snap?.dayPnl)">
          {{ signed(snap?.dayPnl) }}
        </div>
        <div class="risk-tile-label">当日盈亏</div>
        <div class="risk-tile-sub">{{ pct(snap?.dayPnlPct) }}</div>
      </div>
      <div class="risk-tile">
        <div class="risk-tile-num" :class="(snap?.positionPct ?? 0) > 80 ? 'down' : ''">
          {{ pct(snap?.positionPct) }}
        </div>
        <div class="risk-tile-label">总仓位</div>
        <div class="risk-tile-bar">
          <span :style="{ width: Math.min(snap?.positionPct ?? 0, 100) + '%' }" />
        </div>
      </div>
      <div class="risk-tile">
        <div class="risk-tile-num" :class="(snap?.drawdownPct ?? 0) > 10 ? 'down' : ''">
          {{ pct(snap?.drawdownPct) }}
        </div>
        <div class="risk-tile-label">当前回撤</div>
        <div class="risk-tile-sub">峰值 {{ money(snap?.peakEquity) }}</div>
      </div>
    </div>

    <!-- 集中度 -->
    <div class="risk-conc">
      <div class="risk-conc-head">
        <span>单票最大集中度</span>
        <span v-if="snap?.maxSingleCode" class="risk-conc-code">
          {{ snap.maxSingleCode }} · {{ pct(snap?.maxSinglePct) }}
        </span>
      </div>
      <div class="risk-conc-bar">
        <span
          :class="{ warn: (snap?.maxSinglePct ?? 0) > 30 }"
          :style="{ width: Math.min(snap?.maxSinglePct ?? 0, 100) + '%' }"
        />
      </div>
    </div>

    <!-- 持仓明细 -->
    <div class="risk-positions">
      <div class="risk-positions-title">持仓风险分布（{{ snap?.positions.length ?? 0 }}）</div>
      <div v-if="!snap || snap.positions.length === 0" class="risk-empty">
        当前空仓，无持仓风险
      </div>
      <table v-else class="risk-table">
        <thead>
          <tr>
            <th>股票</th>
            <th class="r">市值</th>
            <th class="r">占比</th>
            <th class="r">浮动盈亏</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in snap.positions" :key="p.code">
            <td class="ellipsis">{{ p.code }} {{ p.name }}</td>
            <td class="r">{{ money(p.marketValue) }}</td>
            <td class="r">{{ pct(p.pct) }}</td>
            <td class="r" :class="pnlClass(p.floatPnl)">
              {{ signed(p.floatPnl) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="risk-footer">
      数据口径：统一账本（模拟盘 / 条件单 / 自动机器人同源），非投资建议
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { riskSnapshot, type RiskSnapshot } from "../../broker/api";

const snap = ref<RiskSnapshot | null>(null);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    snap.value = await riskSnapshot();
  } catch (e) {
    console.error("risk_snapshot failed", e);
  } finally {
    loading.value = false;
  }
}

function money(v?: number): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "--";
  return v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}
function signed(v?: number): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "--";
  return (v >= 0 ? "+" : "") + v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}
function pct(v?: number): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "--";
  return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
}
function pnlClass(v?: number): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "";
  return v > 0 ? "up" : v < 0 ? "down" : "";
}

onMounted(load);
</script>

<style scoped>
.risk {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  overflow-y: auto;
  font-size: 12px;
}

/* 顶部 */
.risk-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-radius: 10px;
  background: linear-gradient(135deg, rgba(255, 95, 87, 0.08), rgba(255, 160, 60, 0.05));
  border: 1px solid rgba(255, 95, 87, 0.22);
}
.risk-hero-label { color: var(--text-dim, #8892a8); margin-bottom: 2px; }
.risk-hero-num { font-size: 26px; font-weight: 800; letter-spacing: 0.5px; }
.risk-hero-sub { margin-top: 4px; color: var(--text-dim, #667088); font-size: 11px; }
.risk-refresh {
  padding: 6px 14px; border-radius: 8px; cursor: pointer;
  background: rgba(255, 255, 255, 0.06); color: var(--text, #e6ecf5);
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.risk-refresh:disabled { opacity: 0.5; cursor: default; }

/* 四宫格 */
.risk-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.risk-tile {
  padding: 12px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 10px;
  text-align: center;
}
.risk-tile-num { font-size: 17px; font-weight: 700; }
.risk-tile-num.up { color: #ff5f57; }
.risk-tile-num.down { color: #2fcf7d; }
.risk-tile-label { margin: 4px 0; color: var(--text-dim, #8892a8); }
.risk-tile-sub { color: var(--text-dim, #667088); font-size: 11px; }
.risk-tile-bar {
  height: 5px; margin-top: 6px; border-radius: 3px; overflow: hidden;
  background: rgba(255, 255, 255, 0.08);
}
.risk-tile-bar span {
  display: block; height: 100%;
  background: linear-gradient(90deg, #ff9f43, #ff5f57);
}

/* 集中度 */
.risk-conc { padding: 12px; background: rgba(255,255,255,0.02); border-radius: 10px; }
.risk-conc-head {
  display: flex; justify-content: space-between;
  margin-bottom: 8px; color: var(--text-dim, #8892a8);
}
.risk-conc-code { color: var(--text, #e6ecf5); font-weight: 600; }
.risk-conc-bar {
  height: 8px; border-radius: 4px; overflow: hidden;
  background: rgba(255, 255, 255, 0.07);
}
.risk-conc-bar span {
  display: block; height: 100%; background: #ffb13d;
}
.risk-conc-bar span.warn { background: #ff5f57; }

/* 持仓表 */
.risk-positions { padding: 12px; background: rgba(255,255,255,0.02); border-radius: 10px; }
.risk-positions-title {
  font-weight: 600; margin-bottom: 8px; color: var(--text, #e6ecf5);
}
.risk-table { width: 100%; border-collapse: collapse; }
.risk-table th, .risk-table td {
  padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.05);
}
.risk-table th { color: var(--text-dim, #8892a8); font-weight: 500; font-size: 11px; }
.risk-table .r { text-align: right; font-variant-numeric: tabular-nums; }
.risk-table .ellipsis {
  max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.risk-table .up { color: #ff5f57; }
.risk-table .down { color: #2fcf7d; }
.risk-empty { padding: 16px; text-align: center; color: var(--text-dim, #667088); }

.risk-footer {
  padding: 6px; text-align: center; font-size: 11px; color: var(--text-dim, #556078);
}
</style>
