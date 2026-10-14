<template>
  <div class="risk">
    <!-- 急停状态横条（不可关闭：恢复需手动解除→重连→重启自动执行） -->
    <div v-if="halted" class="risk-halt">
      <span class="risk-halt-dot" />
      交易已锁定：自动执行已停止、全部条件单与在途委托已撤销，恢复需手动操作
    </div>

    <!-- 顶部权益条 -->
    <div class="risk-hero">
      <div class="risk-hero-main">
        <div class="risk-hero-label">总权益</div>
        <div class="risk-hero-num">{{ money(snap?.equity) }}</div>
        <div class="risk-hero-sub">
          现金 {{ money(snap?.cash) }} · 持仓 {{ money(snap?.marketValue) }}
        </div>
      </div>
      <div class="risk-hero-actions">
        <button
          class="risk-halt-btn"
          :class="{ on: halted }"
          :disabled="halting"
          @click="emergencyHalt"
        >
          {{ halting ? "执行中…" : halted ? "已急停" : "一键急停" }}
        </button>
        <button class="risk-refresh" :disabled="loading" @click="load">
          {{ loading ? "…" : "刷新" }}
        </button>
      </div>
    </div>

    <!-- 阈值告警（danger 红 / warn 黄）置顶 -->
    <div v-if="warnings.length" class="risk-warnings">
      <div
        v-for="w in warnings"
        :key="w.code"
        class="risk-warning"
        :class="w.level"
      >
        {{ w.text }}
      </div>
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
          {{ pctRaw(snap?.positionPct) }}
        </div>
        <div class="risk-tile-label">总仓位</div>
        <div class="risk-tile-bar">
          <span :style="{ width: Math.min(snap?.positionPct ?? 0, 100) + '%' }" />
        </div>
      </div>
      <div class="risk-tile">
        <div class="risk-tile-num" :class="(snap?.drawdownPct ?? 0) > 10 ? 'down' : ''">
          {{ pctRaw(snap?.drawdownPct) }}
        </div>
        <div class="risk-tile-label">当前回撤</div>
        <div class="risk-tile-sub">峰值 {{ money(snap?.peakEquity) }}</div>
      </div>
    </div>

    <!-- 第二行：账户级风控指标 -->
    <div class="risk-grid risk-grid-5">
      <div class="risk-tile">
        <div class="risk-tile-num sm" :class="(snap?.dayDrawdownPct ?? 0) > 5 ? 'down' : ''">
          {{ pctRaw(snap?.dayDrawdownPct) }}
        </div>
        <div class="risk-tile-label">当日回撤</div>
      </div>
      <div class="risk-tile">
        <div class="risk-tile-num sm" :class="(snap?.dailyLossPct ?? 0) < 0 ? 'down' : ''">
          {{ pctRaw(snap?.dailyLossPct) }}
        </div>
        <div class="risk-tile-label">日亏（已实现）</div>
      </div>
      <div class="risk-tile">
        <div class="risk-tile-num sm" :class="(snap?.consecutiveLosses ?? 0) >= 3 ? 'down' : ''">
          {{ snap?.consecutiveLosses ?? "--" }}
        </div>
        <div class="risk-tile-label">连续亏损笔数</div>
      </div>
      <div class="risk-tile">
        <div class="risk-tile-num sm">{{ snap?.stopTriggerCount ?? "--" }}</div>
        <div class="risk-tile-label">今日止损触发</div>
      </div>
      <div class="risk-tile">
        <div class="risk-tile-num sm" :class="sysClass">
          {{ sysText }}
        </div>
        <div class="risk-tile-label">系统性风险</div>
        <div class="risk-tile-sub">{{ signed(snap?.indexChg) }}% 上证</div>
      </div>
    </div>

    <!-- 集中度 -->
    <div class="risk-conc">
      <div class="risk-conc-head">
        <span>单票最大集中度</span>
        <span v-if="snap?.maxSingleCode" class="risk-conc-code">
          {{ snap.maxSingleCode }} · {{ pctRaw(snap?.maxSinglePct) }}
        </span>
      </div>
      <div class="risk-conc-bar">
        <span
          :class="{ warn: (snap?.maxSinglePct ?? 0) > 30 }"
          :style="{ width: Math.min(snap?.maxSinglePct ?? 0, 100) + '%' }"
        />
      </div>
    </div>

    <!-- 市场情绪温度条 -->
    <div class="risk-emotion">
      <div class="risk-conc-head">
        <span>市场情绪</span>
        <span class="risk-conc-code">{{ Math.round(snap?.marketEmotion ?? 50) }} / 100</span>
      </div>
      <div class="risk-emotion-bar">
        <span class="risk-emotion-fill" :style="{ width: (snap?.marketEmotion ?? 50) + '%' }" />
      </div>
    </div>

    <!-- 板块暴露 -->
    <div v-if="sectors.length" class="risk-sectors">
      <div class="risk-positions-title">
        板块暴露（{{ sectors.length }}）
        <span class="risk-sectors-note">一票多题材全额计入，合计可能重复</span>
      </div>
      <div v-for="s in sectors" :key="s.theme" class="risk-sector-row">
        <span class="risk-sector-name ellipsis">{{ s.theme }}<em>×{{ s.count }}</em></span>
        <div class="risk-sector-bar">
          <span :style="{ width: Math.min(s.pct, 100) + '%' }" />
        </div>
        <span class="risk-sector-pct">{{ pctRaw(s.pct) }}</span>
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
            <td class="r">{{ pctRaw(p.pct) }}</td>
            <td class="r" :class="pnlClass(p.floatPnl)">
              {{ signed(p.floatPnl) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="risk-footer">
      数据口径：统一账本（模拟盘 / 条件单 / 自动机器人同源）；账户级阈值超限仅停开新仓，卖出永不锁死。非投资建议
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  brokerEmergencyHalt,
  riskSnapshot,
  type RiskSnapshot,
} from "../../broker/api";
import { confirmDialog } from "../../composables/useDialog";

const snap = ref<RiskSnapshot | null>(null);
const loading = ref(false);
const halting = ref(false);
// 急停状态：risk:halted 事件置位，同时以快照 killSwitch 兜底（如在已急停状态下打开卡片）
const halted = ref(false);

const warnings = computed(() => snap.value?.warnings ?? []);
const sectors = computed(() => snap.value?.sectorExposure ?? []);
const sysText = computed(() => {
  switch (snap.value?.systemicRiskLevel) {
    case "high": return "高";
    case "mid": return "中";
    default: return "低";
  }
});
const sysClass = computed(() => {
  const lv = snap.value?.systemicRiskLevel;
  return lv === "high" ? "down" : lv === "mid" ? "warn-text" : "";
});

async function load() {
  loading.value = true;
  try {
    snap.value = await riskSnapshot();
    if (snap.value.killSwitch) halted.value = true;
  } catch (e) {
    console.error("risk_snapshot failed", e);
  } finally {
    loading.value = false;
  }
}

async function emergencyHalt() {
  const ok = await confirmDialog({
    title: "一键急停",
    danger: true,
    confirmText: "立即急停",
    message:
      "将立即执行：① 封死全部新委托 ② 停止自动执行 ③ 撤销全部条件单 ④ 撤销全部在途委托并断开券商通道。\n\n该操作不可撤销，恢复需手动解除、重连并重启自动执行。确认继续？",
  });
  if (!ok) return;
  halting.value = true;
  try {
    await brokerEmergencyHalt();
    halted.value = true;
    await load();
  } catch (e) {
    console.error("emergency halt failed", e);
  } finally {
    halting.value = false;
  }
}

// 自动刷新：交易时段 10s，非交易时段 60s；页面隐藏时暂停。
function inTradingSession(): boolean {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return (mins >= 555 && mins <= 695) || (mins >= 775 && mins <= 905); // 9:15–11:35 / 12:55–15:05
}

let timer: number | null = null;
function armTimer() {
  if (timer !== null) window.clearInterval(timer);
  timer = window.setInterval(() => {
    if (document.hidden) return;
    void load();
  }, inTradingSession() ? 10_000 : 60_000);
}
function onVisibility() {
  if (!document.hidden) {
    void load();
    armTimer();
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
// 仓位 / 回撤类指标：0 不应带正号
function pctRaw(v?: number): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "--";
  return v.toFixed(2) + "%";
}
function pnlClass(v?: number): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "";
  return v > 0 ? "up" : v < 0 ? "down" : "";
}

let unlisten: UnlistenFn | null = null;
onMounted(async () => {
  await load();
  armTimer();
  document.addEventListener("visibilitychange", onVisibility);
  unlisten = await listen<{ coCount?: number; orderCount?: number }>(
    "risk:halted",
    () => {
      halted.value = true;
      void load();
    },
  );
});
onBeforeUnmount(() => {
  if (timer !== null) window.clearInterval(timer);
  document.removeEventListener("visibilitychange", onVisibility);
  unlisten?.();
});
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

/* 急停横条 */
.risk-halt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(255, 59, 48, 0.14);
  border: 1px solid rgba(255, 59, 48, 0.55);
  color: #ff6b62;
  font-weight: 600;
}
.risk-halt-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #ff3b30; flex: none;
  animation: risk-pulse 1.2s infinite;
}
@keyframes risk-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
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
.risk-hero-actions { display: flex; gap: 8px; }
.risk-refresh {
  padding: 6px 14px; border-radius: 8px; cursor: pointer;
  background: rgba(255, 255, 255, 0.06); color: var(--text, #e6ecf5);
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.risk-refresh:disabled { opacity: 0.5; cursor: default; }
.risk-halt-btn {
  padding: 6px 14px; border-radius: 8px; cursor: pointer;
  font-weight: 700; color: #fff;
  background: linear-gradient(135deg, #ff453a, #d70015);
  border: 1px solid rgba(255, 69, 58, 0.6);
}
.risk-halt-btn.on {
  background: rgba(255, 59, 48, 0.25);
  border-color: rgba(255, 59, 48, 0.7);
  cursor: default;
}
.risk-halt-btn:disabled { opacity: 0.85; cursor: default; }

/* 告警 */
.risk-warnings { display: flex; flex-direction: column; gap: 6px; }
.risk-warning {
  padding: 8px 12px; border-radius: 8px; font-size: 12px;
}
.risk-warning.danger {
  background: rgba(255, 59, 48, 0.12);
  border: 1px solid rgba(255, 59, 48, 0.5);
  color: #ff6b62;
}
.risk-warning.warn {
  background: rgba(255, 159, 10, 0.1);
  border: 1px solid rgba(255, 159, 10, 0.45);
  color: #ffc043;
}

/* 四宫格 */
.risk-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.risk-grid-5 { grid-template-columns: repeat(5, 1fr); }
.risk-tile {
  padding: 12px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 10px;
  text-align: center;
}
.risk-tile-num { font-size: 17px; font-weight: 700; }
.risk-tile-num.sm { font-size: 15px; }
.risk-tile-num.up { color: #ff5f57; }
.risk-tile-num.down { color: #2fcf7d; }
.risk-tile-num.warn-text { color: #ffb13d; }
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

/* 集中度 / 情绪 */
.risk-conc, .risk-emotion { padding: 12px; background: rgba(255,255,255,0.02); border-radius: 10px; }
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
.risk-emotion-bar {
  height: 8px; border-radius: 4px; overflow: hidden;
  background: rgba(255, 255, 255, 0.07);
}
.risk-emotion-fill {
  display: block; height: 100%;
  background: linear-gradient(90deg, #2fcf7d, #ffb13d 55%, #ff5f57);
}

/* 板块暴露 */
.risk-sectors { padding: 12px; background: rgba(255,255,255,0.02); border-radius: 10px; }
.risk-sectors-note {
  margin-left: 8px; font-weight: 400; font-size: 11px; color: var(--text-dim, #667088);
}
.risk-sector-row {
  display: grid;
  grid-template-columns: 150px 1fr 56px;
  align-items: center; gap: 10px;
  padding: 4px 0;
}
.risk-sector-name { color: var(--text, #c9d2e2); }
.risk-sector-name em {
  margin-left: 6px; font-style: normal; font-size: 11px; color: var(--text-dim, #78839b);
}
.risk-sector-bar {
  height: 6px; border-radius: 3px; overflow: hidden;
  background: rgba(255, 255, 255, 0.06);
}
.risk-sector-bar span {
  display: block; height: 100%; background: #6ea8fe;
}
.risk-sector-pct {
  text-align: right; font-variant-numeric: tabular-nums; color: var(--text-dim, #aab4c8);
}

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

.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.risk-footer {
  padding: 6px; text-align: center; font-size: 11px; color: var(--text-dim, #556078);
}
</style>
