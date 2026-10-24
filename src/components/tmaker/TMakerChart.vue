<template>
  <div class="tm-chart">
    <!-- 周期 tab：分时默认，做T优先看分时 -->
    <div class="tm-chart-tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="ctab"
        :class="{ on: tab === t.key }"
        @click="switchTab(t.key)"
      >{{ t.label }}</button>
    </div>
    <div class="tm-chart-wrap">
      <div ref="host" class="tm-chart-host"></div>
      <!-- 分时右侧涨跌幅百分比轴（同花顺式，随可视价格范围自动刻度；仅分时显示）。
           绝对定位在图表容器内（坐标 = 主图 pane 像素），不依赖全局 stock-chart.css -->
      <div v-if="tab === 'minute'" class="pct-axis">
        <span
          v-for="(it, i) in rightAxisItems"
          :key="i"
          class="pct-tick"
          :class="axTone(it.pct)"
          :style="{ top: it.coord + 'px' }"
        >{{ it.pct > 0 ? "+" : "" }}{{ it.pct.toFixed(2) }}%</span>
      </div>
    </div>
    <!-- 做T图例 -->
    <div class="tm-legend">
      <span v-if="supportLow > 0"><i class="dot d-sup"></i>支撑 {{ supportLow.toFixed(2) }}</span>
      <span v-if="resistHigh > 0"><i class="dot d-res"></i>压力 {{ resistHigh.toFixed(2) }}</span>
      <span v-if="cost > 0"><i class="dot d-cost"></i>成本 {{ cost.toFixed(2) }}</span>
      <span v-if="gridLevels.length"><i class="dot d-grid"></i>网格 ×{{ gridLevels.length }}</span>
      <span v-if="legs.length"><i class="dot d-leg"></i>在途 {{ legs.length }} 腿</span>
      <span v-if="signals.length"><i class="dot d-sig"></i>信号 {{ signals.length }}</span>
      <span v-if="tab !== 'minute'" class="hint">点击蜡烛查看当日分时</span>
    </div>
    <!-- 当日做T信号记录：指示灯 + 信号列表（实时观测盘中信号，最新在前） -->
    <div class="tm-signals">
      <span class="tm-sig-title">当日做T信号</span>
      <span class="tm-sig-lamp" :class="lamp.cls">{{ lamp.txt }}</span>
      <div class="tm-sig-list">
        <span v-for="(s, i) in signalList" :key="i" class="tm-sig-item" :class="s.dir">
          {{ fmtHHMM(s.time) }} {{ s.dir === "long" ? "T买" : "T卖" }} {{ s.score }}分 {{ s.price.toFixed(2) }}
        </span>
        <span v-if="!signalList.length" class="tm-sig-empty">今日暂无信号，等待盘中触发</span>
      </div>
    </div>
    <div v-if="!bars.length" class="tm-chart-empty">
      <template v-if="!code">请选择一只持仓股票</template>
      <template v-else-if="loadFailed">
        <span class="tm-empty-retry" @click="emit('retry')">行情加载失败，点击重试 ↻</span>
      </template>
      <template v-else>行情加载中...</template>
    </div>
    <MinuteReplayPopup ref="popupRef" :code="code" :name="name" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed } from "vue";
import { init, dispose, ActionType, DomPosition } from "klinecharts";
import type { KLineData } from "klinecharts";
import { fetchKLine, fetchArchivedMinuteDays } from "../../api/market";
import type { KBar } from "../../api/types";
import { toKData } from "../../lib/chart";
import { AVG_Y, UP, DOWN_K, line, buildStyles } from "../../lib/chart-styles";
import { registerCustomIndicators } from "../../composables/chart/useChartIndicators";
import { buildLevelExtendData, registerTmakerLevels, minuteSessionOnly, ensureCloseBar, registerTmakerVol } from "./tmakerChartLevels";
import type { ChartLegLike, ChartSignalLike } from "./tmakerChartLevels";
import MinuteReplayPopup from "../MinuteReplayPopup.vue";

interface TabDef { key: string; label: string; period?: number }
const TABS: TabDef[] = [
  { key: "minute", label: "分时" },
  { key: "1", label: "1分", period: 1 },
  { key: "5", label: "5分", period: 5 },
  { key: "15", label: "15分", period: 15 },
  { key: "30", label: "30分", period: 30 },
  { key: "60", label: "60分", period: 60 },
  { key: "day", label: "日K", period: 101 },
];

const props = defineProps<{
  code: string;
  name: string;
  prevClose: number;
  supportLow: number;
  resistHigh: number;
  cost: number;
  gridLevels: { price: number; label?: string }[];
  legs: ChartLegLike[];
  signals: ChartSignalLike[];
  minuteBars: KBar[];
  loadFailed?: boolean;
}>();

const emit = defineEmits<{ (e: "retry"): void }>();

const host = ref<HTMLDivElement | null>(null);
const popupRef = ref<InstanceType<typeof MinuteReplayPopup> | null>(null);
const tab = ref<string>("minute");
const bars = ref<KBar[]>([]);
let chart: ReturnType<typeof init> | null = null;
let disposed = false;

// ===== 分时右侧涨跌幅百分比轴（thsLevels 每帧 draw 驱动，同 StockChart）=====
const rightAxisItems = ref<{ coord: number; pct: number }[]>([]);
let rafId = 0;
let pendingItems: { coord: number; pct: number }[] = [];
function scheduleRightAxis(items: { coord: number; pct: number }[]) {
  pendingItems = items;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    rightAxisItems.value = pendingItems;
  });
}
const axTone = (p: number) => (p > 0.05 ? "up" : p < -0.05 ? "dn" : "zero");

// ===== 当日做T信号记录条：实时观测盘中信号，指示灯取最新信号方向 =====
const signalList = computed(() => [...props.signals].sort((a, b) => b.time - a.time));
const lamp = computed(() => {
  const s = signalList.value[0];
  if (!s) return { cls: "idle", txt: "观望等待" };
  return { cls: s.dir, txt: `${s.dir === "long" ? "T买" : "T卖"} ${s.score}分` };
});
const fmtHHMM = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

registerCustomIndicators({
  code: computed(() => props.code),
  headName: computed(() => props.name),
  prevClose: computed(() => props.prevClose),
  scheduleRightAxis,
});
registerTmakerLevels();
registerTmakerVol();

// 分时用实时分钟数据（竞价过滤 + 补 15:00 收盘 bar，保证左右边界完整）；K线按周期拉取
function loadBars(t: string): KBar[] | Promise<KBar[]> {
  if (t === "minute") return ensureCloseBar(minuteSessionOnly(props.minuteBars));
  const p = TABS.find((x) => x.key === t)?.period ?? 101;
  return fetchKLine(props.code, p, 300);
}

function render(barsArr: KBar[], minute: boolean) {
  const el = host.value;
  if (!el) return;
  if (chart) {
    dispose(chart);
    chart = null;
  }
  chart = init(el);
  if (!chart) return;
  if (minute) chart.setPaneOptions({ id: "x_axis_pane", axisOptions: { name: "tradingTime" } } as any);
  chart.setTimezone("UTC");
  chart.setPriceVolumePrecision(2, 0);
  chart.setStyles(buildStyles(minute));
  chart.setOffsetRightDistance(minute ? 56 : 0);
  chart.applyNewData(toKData(barsArr));
  const ph = minute ? { vol: 84 } : { vol: 76, sub: 84 };
  if (minute) {
    // 同花顺式分时：涨跌背景 + 均价 + 量（复用 StockChart 同一套自定义指标）
    chart.createIndicator("sessionBg", true, { id: "candle_pane" });
    chart.createIndicator({ name: "AVG", styles: { lines: [line(AVG_Y)] } } as any, false, { id: "candle_pane" });
    // 分时量柱：涨跌双色自定义指标（内置 VOL 在分时下不分色）；缩放/滚动随主图联动
    chart.createIndicator("tmakerVol", false, { id: "tmaker_vol_pane", height: ph.vol, minHeight: 12 });
    // createIndicator 的 height 仅初始建议值，首次布局可能被均分压缩；显式 setPaneOptions 锁定量区高度
    chart.setPaneOptions({ id: "tmaker_vol_pane", height: ph.vol, minHeight: 12 });
    chart.createIndicator({ name: "thsLevels", extendData: { prevClose: props.prevClose } } as any, true, { id: "candle_pane" });
  } else {
    chart.createIndicator(
      { name: "MA", calcParams: [5, 10, 20], styles: { lines: [line(UP), line(AVG_Y), line(DOWN_K)] } } as any,
      false,
      { id: "candle_pane" }
    );
    chart.createIndicator("VOL", false, { id: "tmaker_vol_pane", height: ph.vol, minHeight: 12 });
    chart.setPaneOptions({ id: "tmaker_vol_pane", height: ph.vol, minHeight: 12 });
    chart.createIndicator({ name: "thsLevels", extendData: { prevClose: props.prevClose } } as any, true, { id: "candle_pane" });
  }
  chart.createIndicator(
    { name: "tmakerLevels", extendData: buildLevelExtendData({
        bars: barsArr,
        prevClose: props.prevClose,
        supportLow: props.supportLow,
        resistHigh: props.resistHigh,
        cost: props.cost,
        gridLevels: props.gridLevels,
        legs: props.legs,
        signals: props.signals,
      }) } as any,
    true,
    { id: "candle_pane" }
  );
  chart.subscribeAction(ActionType.OnCandleBarClick, onBarClick);
  chart.resize();
  // 容器尺寸稳定后二次重排 + 分时全景对齐（getSize 需布局完成，故双 rAF）
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!chart || disposed) return;
      chart.resize();
      if (minute) fitMinute();
    });
  });
}

/** 分时全景对齐：242 根铺满主图绘图区（左侧贴齐 9:30、右侧留 56px 百分比轴），滚动到最新 */
function fitMinute() {
  if (!chart || !host.value) return;
  const axisW = 56;
  const mainSize = chart.getSize("candle_pane", DomPosition.Main) as { width: number } | null;
  const P = mainSize?.width ?? host.value.clientWidth;
  chart.setBarSpace(Math.max(1, (P - axisW) / 242));
  chart.setOffsetRightDistance(axisW);
  // resize 后副图高度可能被均分重排，再次锁定量区高度（同同花顺量区占比）
  chart.setPaneOptions({ id: "tmaker_vol_pane", height: 84, minHeight: 12 });
  chart.scrollToRealTime();
}

function switchTab(t: string) {
  if (tab.value === t) return;
  tab.value = t;
  refresh();
}

async function refresh() {
  const t = tab.value;
  const data = await loadBars(t);
  if (t !== tab.value) return; // 快速切换时丢弃过期结果
  bars.value = data;
  render(data, t === "minute");
}

// ===== 点击蜡烛 → 回放该日历史分时（本地归档库补充 >5 交易日样本）=====
function onBarClick(data: any) {
  // klinecharts 版本差异：OnCandleBarClick 回调参数兼容 {data: KLineData} 与直接 KLineData
  const kd: KLineData | undefined = data?.data ?? data;
  if (!kd || typeof kd.timestamp !== "number") return;
  if (tab.value === "minute") return;
  void openReplay(kd);
}
const ymdUTC = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
};
async function openReplay(kd: KLineData) {
  // 近 5 交易日由弹窗内部拉取；更早的从本地归档库（P3-3 落库）补充
  let extra: { date: string; bars: KBar[] }[] | undefined;
  try {
    const days = await fetchArchivedMinuteDays(props.code, 60).catch(() => []);
    const dateKey = ymdUTC(kd.timestamp);
    const hit = days.find((d) => d.date === dateKey);
    if (hit && hit.bars.length) extra = [{ date: hit.date, bars: hit.bars }];
  } catch { /* 无归档库不影响弹窗（回退近5日） */ }
  popupRef.value?.open(kd, extra);
}

/** 轻量刷新做T叠加层（图表数据不动，只重算指标线） */
function refreshTmakerLevels() {
  if (!chart) return;
  chart.createIndicator(
    { name: "thsLevels", extendData: { prevClose: props.prevClose } } as any,
    true,
    { id: "candle_pane" }
  );
  chart.createIndicator(
    { name: "tmakerLevels", extendData: buildLevelExtendData({
        bars: bars.value, prevClose: props.prevClose, supportLow: props.supportLow,
        resistHigh: props.resistHigh, cost: props.cost, gridLevels: props.gridLevels,
        legs: props.legs, signals: props.signals,
      }) } as any,
    true,
    { id: "candle_pane" }
  );
}

// 切票：无论当前 tab 都重新拉数据渲染（分时走 minuteBars watch，K线走 fetchKLine）
watch(() => props.code, () => {
  refresh();
});

// 分时数据：引用变化（轮询/切票更新）→ 重建分时图
watch(() => props.minuteBars, () => {
  if (tab.value !== "minute") return;
  bars.value = ensureCloseBar(minuteSessionOnly(props.minuteBars));
  render(bars.value, true);
});

// 价位/腿/信号变化 → 仅轻量刷新叠加指标（不重建图表，避免轮询卡顿）
watch(
  () => [props.prevClose, props.supportLow, props.resistHigh, props.cost, props.gridLevels, props.legs, props.signals] as const,
  () => {
    refreshTmakerLevels();
  },
  { deep: true }
);

let ro: ResizeObserver | null = null;
onMounted(() => {
  disposed = false;
  ro = new ResizeObserver(() => {
    if (chart && !disposed) chart.resize();
  });
  if (host.value) ro.observe(host.value);
  refresh();
});
onBeforeUnmount(() => {
  disposed = true;
  ro?.disconnect();
  ro = null;
  if (chart) {
    dispose(chart);
    chart = null;
  }
});
</script>

<style scoped>
.tm-chart {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.tm-chart-tabs {
  display: flex;
  gap: 2px;
  padding: 2px 0 0;
  flex: none;
}
.ctab {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #8b93a7;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.ctab:hover { color: #d5dbe8; }
.ctab.on {
  background: rgba(244, 143, 66, 0.16);
  border-color: rgba(244, 143, 66, 0.5);
  color: #f49045;
}
.tm-chart-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  width: 100%;
}
.tm-chart-host {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
/* 分时右侧涨跌幅百分比轴（scoped 内自带，避免依赖 StockChart 的全局样式） */
.pct-axis {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 56px;
  z-index: 6;
  pointer-events: none;
}
.pct-tick {
  position: absolute;
  right: 6px;
  transform: translateY(-50%);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.pct-tick.up { color: #FF3232; }
.pct-tick.dn { color: #1DBE7D; }
.pct-tick.zero { color: #dfe5f2; }
.tm-chart-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6b7488;
  font-size: 12px;
  pointer-events: none;
}
.tm-empty-retry {
  color: #f49045;
  cursor: pointer;
  pointer-events: auto;
  font-size: 13px;
}
.tm-empty-retry:hover { text-decoration: underline; }
.tm-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 2px 0;
  font-size: 11px;
  color: #9aa4b8;
  flex: none;
}
.tm-legend .dot {
  display: inline-block;
  width: 8px;
  height: 3px;
  border-radius: 1px;
  margin-right: 4px;
  vertical-align: middle;
}
.tm-legend .hint { color: #6b7488; margin-left: auto; }
/* 当日做T信号记录条 */
.tm-signals {
  flex: none; display: flex; align-items: center; gap: 8px;
  margin-top: 4px; padding: 3px 6px; min-height: 26px;
  background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07); border-radius: 5px;
}
.tm-sig-title { font-size: 11px; color: #9aa4b8; flex: none; }
.tm-sig-lamp { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; flex: none; white-space: nowrap; }
.tm-sig-lamp::before { content: ""; width: 8px; height: 8px; border-radius: 50%; }
.tm-sig-lamp.long { color: #ff6478; }
.tm-sig-lamp.long::before { background: #ff6478; box-shadow: 0 0 6px rgba(255,100,120,.8); }
.tm-sig-lamp.short { color: #00e8a0; }
.tm-sig-lamp.short::before { background: #00e8a0; box-shadow: 0 0 6px rgba(0,232,160,.8); }
.tm-sig-lamp.idle { color: #6b7488; }
.tm-sig-lamp.idle::before { background: #6b7488; }
.tm-sig-list { display: flex; gap: 4px; overflow-x: auto; flex: 1; min-width: 0; scrollbar-width: none; }
.tm-sig-list::-webkit-scrollbar { display: none; }
.tm-sig-item {
  flex: none; font-size: 10px; font-family: Consolas, monospace;
  padding: 1px 6px; border-radius: 3px; white-space: nowrap;
}
.tm-sig-item.long { color: #ff6478; background: rgba(255,100,120,.1); }
.tm-sig-item.short { color: #00e8a0; background: rgba(0,232,160,.1); }
.tm-sig-empty { font-size: 10px; color: #6b7488; }
.d-sup { background: #3ecf8e; }
.d-res { background: #ff5a5a; }
.d-cost { background: #f5d020; }
.d-grid { background: #3aa0ff; }
.d-leg { background: #b47cff; }
.d-sig { background: #ff8f3d; height: 6px; width: 6px; border-radius: 3px; }
</style>
