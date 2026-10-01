<template>
  <div class="sc-root">
    <!-- ===== 股票头 ===== -->
    <div class="sc-head">
      <div class="sc-id">
        <span class="sc-name">{{ headName }}</span>
        <span class="sc-code">{{ code }}</span>
      </div>
      <div class="sc-px" :class="pxTone">
        <span class="sc-price">{{ fmtPx(price) }}</span>
        <div class="sc-chg">
          <span>{{ change >= 0 ? "+" : "" }}{{ fmtPx(change) }}</span>
          <span>{{ pct >= 0 ? "+" : "" }}{{ pct.toFixed(2) }}%</span>
        </div>
      </div>
      <div class="sc-grid">
        <div class="gi"><label>今开</label><span :class="toneOf(open)">{{ fmtPx(open) }}</span></div>
        <div class="gi"><label>最高</label><span class="up">{{ fmtPx(high) }}</span></div>
        <div class="gi"><label>最低</label><span class="down-k">{{ fmtPx(low) }}</span></div>
        <div class="gi"><label>昨收</label><span>{{ fmtPx(prevClose) }}</span></div>
        <div class="gi"><label>成交量</label><span>{{ fmtVol(volume) }}</span></div>
        <div class="gi"><label>成交额</label><span>{{ fmtAmt(amount) }}</span></div>
        <div class="gi"><label>换手</label><span>{{ q ? q.turnover.toFixed(2) + "%" : "-" }}</span></div>
        <div class="gi"><label>振幅</label><span>{{ q ? q.amplitude.toFixed(2) + "%" : "-" }}</span></div>
        <div class="gi"><label>量比</label><span>{{ q ? q.volumeRatio.toFixed(2) : "-" }}</span></div>
        <div class="gi"><label>市盈(动)</label><span>{{ q && q.pe ? q.pe.toFixed(1) : "-" }}</span></div>
        <div class="gi"><label>流通市值</label><span>{{ q ? q.circMv.toFixed(1) + "亿" : "-" }}</span></div>
        <div class="gi"><label>总市值</label><span>{{ q ? q.totalMv.toFixed(1) + "亿" : "-" }}</span></div>
        <div class="gi"><label>涨停价</label><span class="up">{{ fmtPx(limitUpPrice) }}</span></div>
        <div class="gi"><label>跌停价</label><span class="down-k">{{ fmtPx(limitDownPrice) }}</span></div>
        <div class="gi"><label>持仓</label><span>{{ myPos ? myPos.vol + "股" : "--" }}</span></div>
        <div class="gi"><label>成本价</label><span>{{ myPos ? fmtPx(costPrice) : "--" }}</span></div>
      </div>
    </div>

    <!-- ===== 周期条 ===== -->
    <div class="sc-tabs">
      <button
        v-for="(t, i) in tabs"
        :key="t.label"
        class="sc-tab"
        :class="{ active: i === active }"
        @click="switchTab(i)"
      >{{ t.label }}</button>
      <div class="sc-tabs-right">
        <button class="sc-tab ghost" :class="{ on: drawBar }" @click="toggleDraw">画线工具</button>
        <template v-if="!tabs[active].minute">
          <button class="sc-tab ghost" @click="openMaDlg">均线设置</button>
          <button class="sc-tab ghost" :class="{ on: showBoll }" @click="toggleMainOverlay('BOLL')">BOLL</button>
          <button class="sc-tab ghost" :class="{ on: showSar }" @click="toggleMainOverlay('SAR')">SAR</button>
          <button class="sc-tab ghost" :class="{ on: showEne }" @click="toggleMainOverlay('ENE')">ENE</button>
          <span class="sc-sep"></span>
          <div ref="subPickerEl" class="sub-picker">
            <button class="sc-tab ghost" :class="{ on: subMenu }" @click.stop="subMenu=!subMenu">副图 {{ subInd }} ▾</button>
            <div v-if="subMenu" class="sub-menu" @click.stop>
              <div v-for="g in subGroups" :key="g.group" class="sm-group">
                <div class="sm-gtitle">{{ g.group }}</div>
                <div
                  v-for="it in g.items"
                  :key="it.name"
                  class="sm-item"
                  :class="{ on: subInd===it.name }"
                  @click="switchSub(it.name)"
                >
                  <span class="sm-label">{{ it.label }}</span>
                  <i v-if="subInd===it.name" class="sm-check">✓</i>
                </div>
              </div>
            </div>
          </div>
          <button class="sc-tab ghost" @click="openIndSettings">指标设置</button>
        </template>
      </div>
    </div>

    <!-- ===== 主体 ===== -->
    <div class="sc-body">
      <div class="sc-chart">
        <div ref="host" class="chart-host" @contextmenu.prevent="onContextMenu"></div>
        <div v-if="tabs[active].minute" class="pct-axis">
          <span
            v-for="(it, i) in rightAxisItems"
            :key="i"
            class="pct-tick"
            :class="axTone(it.pct)"
            :style="{ top: it.coord + 'px' }"
          >{{ it.pct > 0 ? "+" : "" }}{{ it.pct.toFixed(2) }}%</span>
        </div>

        <!-- 画线工具条（竖排，可收起） -->
        <div v-if="drawBar" class="draw-bar" @contextmenu.stop.prevent>
          <button class="db-btn" :class="{ on: activeDraw === '' }" title="光标 / 选择 (Esc)" @click="pickCursor">
            <svg viewBox="0 0 24 24"><path fill="currentColor" d="M5 3l14 8-6 1.5L9 20l-2-8-2-1z" /></svg>
          </button>
          <button class="db-btn txt" :class="{ on: magnet !== 'normal' }" :title="magnetTitle" @click="cycleMagnet">{{ magnetLabel }}</button>
          <button class="db-btn txt" :class="{ on: continuous }" title="连续绘制（画完一条继续下一条）" @click="continuous = !continuous">连画</button>
          <div class="db-sep"></div>
          <template v-for="(grp, gi) in drawGroups" :key="gi">
            <button
              v-for="t in grp"
              :key="t.name"
              class="db-btn txt"
              :class="{ on: activeDraw === t.name }"
              :title="t.label"
              @click="startDraw(t.name)"
            >{{ t.short }}</button>
            <div class="db-sep"></div>
          </template>
          <label class="db-color" :title="'画线颜色：' + drawColor">
            <input type="color" v-model="drawColor" />
          </label>
          <button class="db-btn txt" title="画线粗细（点击切换）" @click="cycleSize">{{ drawSize }}</button>
          <div class="db-sep"></div>
          <button class="db-btn txt danger" title="清除全部画线" @click="clearDrawings">清除</button>
        </div>

        <!-- 持仓信息角标 -->
        <div v-if="showPosInfo && posInfo" class="sc-posinfo" :class="posInfo.pct >= 0 ? 'up' : 'down-k'">
          <div class="pi-row"><label>持仓</label><span>{{ posInfo.vol }} 股</span></div>
          <div class="pi-row"><label>成本</label><span>{{ posInfo.cost.toFixed(2) }}</span></div>
          <div class="pi-row"><label>盈亏</label><span>{{ (posInfo.pnl >= 0 ? "+" : "") + posInfo.pnl.toFixed(0) }}</span></div>
          <div class="pi-row"><label>收益率</label><span>{{ (posInfo.pct >= 0 ? "+" : "") + posInfo.pct.toFixed(2) }}%</span></div>
        </div>

        <!-- 首次加载 / 错误遮罩（仅在从未成功渲染时出现，不覆盖已有图表） -->
        <div v-if="loading" class="sc-mask">加载中…</div>
        <div v-else-if="err" class="sc-mask err">
          <div class="err-text">图表加载失败：{{ err }}</div>
          <button class="err-btn" @click="retry">重试</button>
        </div>

        <!-- 跟随鼠标的同花顺式浮窗 -->
        <div v-if="float.visible" class="sc-float" :style="{ left: float.x + 'px', top: float.y + 'px' }">
          <template v-for="(r, i) in float.rows" :key="i">
            <div v-if="r.head" class="fl-head">{{ r.text }}</div>
            <div v-else class="fl-row">
              <span class="fl-label">{{ r.label }}</span>
              <span class="fl-value" :style="r.color ? { color: r.color } : {}">{{ r.value }}</span>
            </div>
          </template>
        </div>
      </div>

      <!-- 五档盘口 -->
      <div class="sc-book">
        <div class="ask">
          <div v-for="i in [4,3,2,1,0]" :key="'a'+i" class="lvl ask-lvl">
            <span class="lvl-tag">卖{{ i + 1 }}</span>
            <span class="lvl-px up">{{ fmtPx(asks[i]?.price) }}</span>
            <span class="lvl-vol">{{ fmtVol(asks[i]?.vol ?? 0) }}</span>
            <span class="lvl-bar" :style="{ width: barW(asks[i]?.vol ?? 0) + '%' }"></span>
          </div>
        </div>
        <div class="book-mid" :class="pxTone">
          <span class="bm-px">{{ fmtPx(price) }}</span>
          <span class="bm-chg">{{ pct >= 0 ? "+" : "" }}{{ pct.toFixed(2) }}%</span>
        </div>
        <div class="bid">
          <div v-for="i in [0,1,2,3,4]" :key="'b'+i" class="lvl bid-lvl">
            <span class="lvl-tag">买{{ i + 1 }}</span>
            <span class="lvl-px down-g">{{ fmtPx(ob?.bids[i]?.price) }}</span>
            <span class="lvl-vol">{{ fmtVol(ob?.bids[i]?.vol ?? 0) }}</span>
            <span class="lvl-bar" :style="{ width: barW(ob?.bids[i]?.vol ?? 0) + '%' }"></span>
          </div>
        </div>
        <div class="book-foot">
          <div><label>成交量</label><span>{{ fmtVol(volume) }}</span></div>
          <div><label>成交额</label><span>{{ fmtAmt(amount) }}</span></div>
        </div>
      </div>
    </div>

    <!-- ===== 右键菜单（Teleport 到 body，避免被卡片裁剪） ===== -->
    <Teleport to="body">
      <div v-if="menu.visible" class="cm-mask" @click="closeMenu" @contextmenu.prevent="closeMenu"></div>
      <div v-if="menu.visible" class="cm" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop>
        <div class="cm-item" :class="{ on: showPosInfo }" @click="togglePosInfo">
          <span>显示持仓成本</span><i v-if="showPosInfo" class="cm-check">✓</i>
        </div>
        <div class="cm-item" :class="{ on: showCostLine }" @click="toggleCostLine">
          <span>显示持仓成本线</span><i v-if="showCostLine" class="cm-check">✓</i>
        </div>
        <div class="cm-item" :class="{ on: showTradePts }" @click="toggleTradePts">
          <span>显示K线买卖点</span><i v-if="showTradePts" class="cm-check">✓</i>
        </div>
        <div class="cm-item" :class="{ on: showTd }" @click="toggleTd">
          <span>神奇九转</span><i v-if="showTd" class="cm-check">✓</i>
        </div>
        <div class="cm-sep"></div>
        <div class="cm-item cm-parent">
          <span>加入自选股分组</span><span class="cm-arrow">▸</span>
          <div class="cm-sub">
            <div v-for="g in wl.groups" :key="g.id" class="cm-item" @click.stop="addToGroup(g.id)">{{ g.name }}</div>
            <div class="cm-item cm-new" @click.stop="newGroupThenAdd">＋ 新建分组</div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ===== 双击蜡烛：历史分时复盘弹窗（独立组件，自包含图表实例） ===== -->
    <MinuteReplayPopup ref="replayPopupRef" :code="code" :name="headName" />

    <!-- ===== 均线设置弹窗 ===== -->
    <Teleport to="body">
      <div v-if="maDlg" class="ma-overlay" @click="maDlg = false">
        <div class="ma-box" @click.stop>
          <div class="ma-title">均线参数设置</div>
          <div class="ma-head"><span>周期</span><span>颜色</span><span></span></div>
          <div v-for="(d, i) in maDraft" :key="i" class="ma-line">
            <input v-model.number="d.period" type="number" min="1" class="ma-input" />
            <input v-model="d.color" type="color" class="ma-color" />
            <button class="ma-del" @click="maRemove(i)">×</button>
          </div>
          <button class="ma-add" @click="maAdd">＋ 添加均线</button>
          <div class="ma-foot">
            <button class="ma-cancel" @click="maDlg = false">取消</button>
            <button class="ma-apply" @click="applyMa">应用</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ===== 指标设置 / 模板管理弹窗 ===== -->
    <IndicatorSettings
      v-model:open="indDlg"
      :chart="chart"
      :targets="indTargets"
      :snapshot-fn="buildTemplatePayload"
      @apply-template="applyTemplatePayload"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { init, dispose, ActionType } from "klinecharts";
import type { Chart, KLineData } from "klinecharts";
import {
  fetchQuotes, fetchKLine, fetchMinute, fetchOrderBook,
} from "../api/market";
import type { Quote, OrderBook, KBar } from "../api/types";
import { db } from "../db/database";
import { useChartDrawings } from "../composables/useChartDrawings";
import { registerCustomIndicators } from "../composables/chart/useChartIndicators";
import { useChartFloat } from "../composables/chart/useChartFloat";
import { usePaperStore } from "../stores/paper";
import { useWatchlistStore } from "../stores/watchlist";
import {
  fmtVol, fmtAmt, limitRateOf, round2, toKData, buildAvgMap, findBarIndex,
} from "../lib/chart";
import { UP, DOWN_K, FLAT, AVG_Y, line, buildStyles } from "../lib/chart-styles";
import { SUB_GROUPS as subGroups } from "../lib/indicator-groups";
import IndicatorSettings from "./IndicatorSettings.vue";
import MinuteReplayPopup from "./MinuteReplayPopup.vue";

const props = defineProps<{ code: string }>();

const paper = usePaperStore();
const wl = useWatchlistStore();

const tabs = [
  { label: "分时", minute: true },
  { label: "1分", period: 1 },
  { label: "5分", period: 5 },
  { label: "15分", period: 15 },
  { label: "30分", period: 30 },
  { label: "60分", period: 60 },
  { label: "日K", period: 101 },
  { label: "周K", period: 102 },
  { label: "月K", period: 103 },
];
const active = ref(6); // 默认日K

const host = ref<HTMLElement | null>(null);
let chart: Chart | null = null;
let ro: ResizeObserver | null = null;
let headTimer = 0;
let chartTimer = 0;

const q = ref<Quote | null>(null);
const ob = ref<OrderBook | null>(null);
const loading = ref(true);
const err = ref("");
const hasRendered = ref(false);
const currentBars = ref<KBar[]>([]);
let avgMapCur = new Map<number, number>();

// 右键菜单开关
const showPosInfo = ref(false);
const showCostLine = ref(false);
const showTradePts = ref(false);
const showTd = ref(true); // 神奇九转默认开启（K线 / 分时均显示）
const showBoll = ref(false); // BOLL 主图叠加
const showSar = ref(false);  // SAR 主图叠加
const showEne = ref(false);  // ENE 主图叠加

const subInd = ref("MACD"); // 当前副图指标
let subPaneId: string | null = null;
let volPaneId: string | null = null;
const subMenu = ref(false);
const subPickerEl = ref<HTMLElement | null>(null);
// 点击选择器外部时收起菜单
function onDocMousedown(e: MouseEvent) {
  if (subMenu.value && subPickerEl.value && !subPickerEl.value.contains(e.target as Node)) {
    subMenu.value = false;
  }
}

// ---- 头部合并字段（Quote 为主，OrderBook 兜底）----
const headName = computed(() => q.value?.name ?? ob.value?.name ?? "-");
const price = computed(() => q.value?.price ?? ob.value?.price ?? 0);
const prevClose = computed(() => q.value?.prevClose ?? ob.value?.prevClose ?? 0);
const open = computed(() => q.value?.open ?? ob.value?.open ?? 0);
const high = computed(() => q.value?.high ?? ob.value?.high ?? 0);
const low = computed(() => q.value?.low ?? ob.value?.low ?? 0);
const volume = computed(() => q.value?.volume ?? ob.value?.volume ?? 0);
const amount = computed(() => q.value?.amount ?? ob.value?.amount ?? 0);
const change = computed(() => q.value?.change ?? price.value - prevClose.value);
const pct = computed(() => q.value?.pct ?? (prevClose.value ? (change.value / prevClose.value) * 100 : 0));
const asks = computed(() => ob.value?.asks ?? []);

const pxTone = computed(() => (change.value > 0 ? "up" : change.value < 0 ? "down-k" : "flat"));
const toneOf = (v: number) => (v > prevClose.value ? "up" : v < prevClose.value ? "down-k" : "");

const maxVol = computed(() => {
  const lv = [...asks.value, ...(ob.value?.bids ?? [])].map((l) => l.vol);
  return Math.max(1, ...lv);
});
const barW = (v: number) => Math.round((v / maxVol.value) * 100);

// 价格格式化（空 / NaN → --，两位小数）
const fmtPx = (v?: number | null) => (v == null || isNaN(v) ? "--" : v.toFixed(2));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ===== 分时右侧涨跌幅百分比轴（左侧价格走 KLineChart 默认轴；右侧 HTML 由 thsLevels 每帧 draw 驱动）=====
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

  registerCustomIndicators({ code: computed(() => props.code), headName, prevClose, scheduleRightAxis });

// ===== 画线工具：状态 / overlay / SQLite 持久化（已抽到 composable，行为不变）=====
const {
  // 模板状态
  drawBar, activeDraw, continuous, magnet, drawColor, drawSize, drawGroups,
  magnetLabel, magnetTitle,
  // 模板动作
  toggleDraw, cycleMagnet, cycleSize, startDraw, pickCursor, clearDrawings,
  // 内部集成
  drawInstances, restoreDrawings, saveDrawings, isRecentOverlayRightClick,
} = useChartDrawings({
  getChart: () => chart,
  getCode: () => props.code,
  activePeriod: () => active.value,
});

// 涨跌停价 / 模拟持仓
const limitRate = computed(() => limitRateOf(props.code, headName.value));
const limitUpPrice = computed(() => (prevClose.value > 0 ? round2(prevClose.value * (1 + limitRate.value)) : null));
const limitDownPrice = computed(() => (prevClose.value > 0 ? round2(prevClose.value * (1 - limitRate.value)) : null));
const myPos = computed(() => paper.positions.find((p) => p.code === props.code));
const costPrice = computed(() => (myPos.value ? myPos.value.costAmount / myPos.value.vol : 0));
const axTone = (p: number) => (p > 0.05 ? "up" : p < -0.05 ? "dn" : "zero");

const PANE_MINH = 12;
// 副图窗格高度按容器自适应：矮卡片里压缩成交量/副图，保证主图窗格不被挤成 0
function paneHeights(minute: boolean) {
  const H = host.value?.clientHeight ?? 0;
  if (H > 0 && H < 260) {
    if (minute) return { vol: Math.max(PANE_MINH, Math.round(H * 0.28)) };
    // 成交量+副图合计不超过容器 42%，余下（扣时间轴）留给主图
    return {
      vol: Math.max(PANE_MINH, Math.round(H * 0.16)),
      sub: Math.max(PANE_MINH, Math.round(H * 0.26)),
    };
  }
  return minute ? { vol: 84 } : { vol: 76, sub: 84 };
}

// ---- 渲染图表（每次切换整体重建，避免指标残留）----
function renderChart(bars: KBar[], minute: boolean) {
  if (!host.value) return;
  currentBars.value = bars;
  avgMapCur = minute ? buildAvgMap(bars) : new Map();
  if (chart) {
    dispose(chart); chart = null;
    drawInstances.clear(); // 旧 chart 的 overlay 实例已失效
  }
  volPaneId = null; subPaneId = null;
  chart = init(host.value);
  if (!chart) return;
  chart.setTimezone("UTC");
  chart.setPriceVolumePrecision(2, 0);
  chart.setStyles(buildStyles(minute));
  chart.applyNewData(toKData(bars));

  const ph = paneHeights(minute);
  if (minute) {
    chart.createIndicator("sessionBg", true, { id: "candle_pane" });
    chart.createIndicator({ name: "AVG", styles: { lines: [line(AVG_Y)] } } as any, false, { id: "candle_pane" });
    volPaneId = chart.createIndicator(
      { name: "VOL", styles: { tooltip: { showName: false, showParams: false }, lines: [{ color: "rgba(0,0,0,0)" }, { color: "rgba(0,0,0,0)" }, { color: "rgba(0,0,0,0)" }] } } as any,
      false, { height: ph.vol, minHeight: PANE_MINH }
    ) as string | null;
    chart.createIndicator({ name: "thsLevels", extendData: { prevClose: prevClose.value } } as any, true, { id: "candle_pane" });
  } else {
    chart.createIndicator({
      name: "MA",
      calcParams: maCfg.value.periods.slice(),
      styles: { lines: maCfg.value.colors.map((c) => line(c)) },
    } as any, false, { id: "candle_pane" });
    volPaneId = chart.createIndicator("VOL", false, { height: ph.vol, minHeight: PANE_MINH }) as string | null;
    subPaneId = chart.createIndicator(subInd.value, false, { height: ph.sub, minHeight: PANE_MINH }) as string | null;
  }

  // 叠加层恢复（同 pane 叠加必须 isStack=true，否则会清空 MA/AVG）
  if (showBoll.value) chart.createIndicator("BOLL", true, { id: "candle_pane" });
  if (showSar.value) chart.createIndicator("SAR", true, { id: "candle_pane" });
  if (showEne.value) chart.createIndicator("ENE", true, { id: "candle_pane" });
  if (showTd.value) chart.createIndicator("td9", true, { id: "candle_pane" });
  if (showTradePts.value) addTradePointsToChart();
  if (showCostLine.value) addCostLineToChart();

  chart.subscribeAction(ActionType.OnCrosshairChange, onCrosshair);
  chart.subscribeAction(ActionType.OnCandleBarClick, onBarClick);

  restoreDrawings(); // 数据与指标就绪后恢复该股票+周期的画线
  chart.resize();
  if (minute) fitMinute();
}

function fitMinute() {
  if (!chart || !host.value) return;
  const w = host.value.clientWidth;
  chart.setBarSpace(Math.max(1.5, w / 242));
  chart.scrollToRealTime();
}

// ===== 加载（带 3 次重试；失败时若已有图表则保留旧图，不弹遮罩）=====
async function fetchBars(tab: any): Promise<KBar[]> {
  let last = "暂无数据";
  for (let a = 0; a < 3; a++) {
    try {
      let v: KBar[];
      if (tab.minute) v = await fetchMinute(props.code);
      else v = await fetchKLine(props.code, tab.period, tab.period >= 100 ? 450 : 260);
      if (v && v.length) return v;
      last = "暂无数据";
    } catch (e: any) { last = e?.message || String(e); }
    await sleep(450 * (a + 1));
  }
  throw new Error(last);
}

async function load() {
  const first = !hasRendered.value;
  if (first) loading.value = true;
  err.value = "";
  const tab = tabs[active.value];
  try {
    const data = await fetchBars(tab);
    renderChart(data, !!tab.minute);
    hasRendered.value = true;
  } catch (e: any) {
    if (first) err.value = e?.message || String(e);
    else console.warn("[chart] 保留旧图，刷新失败", e);
  } finally {
    if (first) loading.value = false;
  }
}

function retry() { load(); }

async function switchTab(i: number) {
  if (i === active.value) return;
  await saveDrawings(true); // 先用旧周期 key 强制保存画线
  active.value = i;
  await load();
}

// 主图叠加开关（BOLL / SAR / ENE）
function toggleMainOverlay(key: "BOLL" | "SAR" | "ENE") {
  const st = key === "BOLL" ? showBoll : key === "SAR" ? showSar : showEne;
  st.value = !st.value;
  if (!chart) return;
  if (st.value) chart.createIndicator(key, true, { id: "candle_pane" });
  else chart.removeIndicator("candle_pane", key);
}
// 副图指标切换（移除旧副图 pane，新建新指标 pane）
function switchSub(name: string) {
  if (subInd.value === name) { subMenu.value = false; return; }
  subInd.value = name;
  subMenu.value = false;
  if (!chart) return;
  if (subPaneId) chart.removeIndicator(subPaneId);
  const h = paneHeights(false);
  subPaneId = chart.createIndicator(name, false, { height: h.sub, minHeight: PANE_MINH }) as string | null;
}

// ===== 指标设置弹窗 =====
const indDlg = ref(false);
interface IndTarget { name: string; paneId: string; label: string }
const indTargets = computed<IndTarget[]>(() => {
  const t: IndTarget[] = [];
  if (tabs[active.value].minute) return t; // 分时不提供参数设置
  t.push({ name: "MA", paneId: "candle_pane", label: "MA 均线" });
  if (showBoll.value) t.push({ name: "BOLL", paneId: "candle_pane", label: "BOLL 布林" });
  if (showSar.value) t.push({ name: "SAR", paneId: "candle_pane", label: "SAR 抛物线" });
  if (showEne.value) t.push({ name: "ENE", paneId: "candle_pane", label: "ENE 轨道" });
  if (subPaneId) t.push({ name: subInd.value, paneId: subPaneId, label: "副图 · " + subInd.value });
  return t;
});
function openIndSettings() { indDlg.value = true; }

// 读取某指标的 calcParams 与每条输出线颜色
function readIndicatorSnapshot(name: string, paneId: string) {
  if (!chart) return null;
  const ind = chart.getIndicatorByPaneId(paneId, name) as any;
  if (!ind) return null;
  const lines: string[] = [];
  for (const f of ind.figures ?? []) {
    if (f.type === "line") lines.push(ind.styles?.lines?.[lines.length]?.color ?? "#ffffff");
  }
  return { calcParams: ((ind.calcParams as any[]) ?? []).slice(), lines };
}

// 生成当前完整指标配置快照（用于保存模板 / 导出）
function buildTemplatePayload() {
  const params: Record<string, any[]> = {};
  const lines: Record<string, string[]> = {};
  const grab = (name: string, paneId: string) => {
    const s = readIndicatorSnapshot(name, paneId);
    if (s) { params[name] = s.calcParams; lines[name] = s.lines; }
  };
  if (!tabs[active.value].minute) {
    grab("MA", "candle_pane");
    if (showBoll.value) grab("BOLL", "candle_pane");
    if (showSar.value) grab("SAR", "candle_pane");
    if (showEne.value) grab("ENE", "candle_pane");
    if (subPaneId) grab(subInd.value, subPaneId);
  }
  return {
    v: 1,
    minute: tabs[active.value].minute,
    ma: { periods: maCfg.value.periods.slice(), colors: maCfg.value.colors.slice() },
    main: { BOLL: showBoll.value, SAR: showSar.value, ENE: showEne.value },
    sub: subInd.value,
    params,
    lines,
  };
}

// 应用模板：恢复开关 / 副图 / 参数 / 线色
async function applyTemplatePayload(p: any) {
  if (!chart || !p) return;
  if (p.ma?.periods?.length) {
    maCfg.value = { periods: p.ma.periods.slice(), colors: p.ma.colors.slice() };
  }
  const syncMain = (key: "BOLL" | "SAR" | "ENE", want: boolean, cur: { value: boolean }) => {
    if (cur.value === want) return;
    cur.value = want;
    if (want) chart!.createIndicator(key, true, { id: "candle_pane" });
    else chart!.removeIndicator("candle_pane", key);
  };
  syncMain("BOLL", !!p.main?.BOLL, showBoll);
  syncMain("SAR", !!p.main?.SAR, showSar);
  syncMain("ENE", !!p.main?.ENE, showEne);
  if (p.sub && p.sub !== subInd.value && subPaneId) {
    chart.removeIndicator(subPaneId);
    subInd.value = p.sub;
    subPaneId = chart.createIndicator(p.sub, false, { height: 84 }) as string | null;
  }
  await nextTick();
  for (const name of ["MA", "BOLL", "SAR", "ENE"]) {
    if (!p.params?.[name]) continue;
    const ln: string[] = p.lines?.[name] ?? [];
    chart.overrideIndicator(
      { name, calcParams: p.params[name], styles: { lines: ln.map((c) => line(c)) } } as any,
      "candle_pane"
    );
  }
  if (subPaneId && p.params?.[subInd.value]) {
    const ln: string[] = p.lines?.[subInd.value] ?? [];
    chart.overrideIndicator(
      { name: subInd.value, calcParams: p.params[subInd.value], styles: { lines: ln.map((c) => line(c)) } } as any,
      subPaneId
    );
  }
}

const { float, onCrosshair } = useChartFloat({
  host, active, tabs, currentBars, q, amount, prevClose,
  getAvgMap: () => avgMapCur,
});

// ===== 双击蜡烛 → 历史分时复盘弹窗 =====
interface HistDay { date: string; bars: KBar[]; prevClose: number }
let lastClick: { ts: number; t: number } | null = null;
function onBarClick(data: any) {
  const kd: KLineData | undefined = data?.data;
  if (!kd) return;
  const now = Date.now();
  if (lastClick && lastClick.ts === kd.timestamp && now - lastClick.t < 350) {
    openPopup(kd);
    lastClick = null;
  } else {
    lastClick = { ts: kd.timestamp, t: now };
  }
}
// 历史分时复盘弹窗（实现见 MinuteReplayPopup，独立图表实例）
const replayPopupRef = ref<InstanceType<typeof MinuteReplayPopup> | null>(null);
function openPopup(kd: KLineData) {
  replayPopupRef.value?.open(kd);
}


// ===== 右键菜单 =====
const menu = ref({ visible: false, x: 0, y: 0 });
function onContextMenu(e: MouseEvent) {
  // 若刚在某条画线上右键（已触发单条删除），则不再弹出菜单
  if (isRecentOverlayRightClick()) return;
  menu.value = { visible: true, x: e.clientX, y: e.clientY };
}
function closeMenu() { menu.value.visible = false; }

// 持仓信息角标
const posInfo = computed(() => {
  const p = paper.positions.find((x: any) => x.code === props.code);
  if (!p) return null;
  const cost = p.costAmount / p.vol;
  const pr = price.value || cost;
  return { vol: p.vol, cost, pnl: (pr - cost) * p.vol, pct: (pr - cost) / cost * 100 };
});

// 成本线
function addCostLineToChart() {
  if (!chart) return;
  const p = paper.positions.find((x: any) => x.code === props.code);
  const cost = p ? p.costAmount / p.vol : price.value;
  chart.createOverlay({
    name: "priceLine", id: "cost-line", points: [{ value: cost }],
    styles: { line: { color: AVG_Y, size: 1 }, text: { color: AVG_Y, size: 11 } },
  } as any);
}

// 买卖点：把成交单映射到当前周期 bar
function buildTradeMarks() {
  const marks: { index: number; side: string }[] = [];
  const tab = tabs[active.value];
  for (const o of paper.orders) {
    if (o.code !== props.code) continue;
    const idx = findBarIndex(o.createdAt, tab, currentBars.value);
    if (idx >= 0) marks.push({ index: idx, side: o.side });
  }
  return marks;
}
function addTradePointsToChart() {
  chart?.createIndicator(
    { name: "tradePoints", extendData: buildTradeMarks() } as any,
    true, { id: "candle_pane" }
  );
}

// 菜单动作
function togglePosInfo() { showPosInfo.value = !showPosInfo.value; closeMenu(); }
function toggleCostLine() {
  showCostLine.value = !showCostLine.value;
  if (chart) {
    if (showCostLine.value) addCostLineToChart();
    else chart.removeOverlay({ id: "cost-line" } as any);
  }
  closeMenu();
}
function toggleTradePts() {
  showTradePts.value = !showTradePts.value;
  if (chart) {
    if (showTradePts.value) addTradePointsToChart();
    else chart.removeIndicator("candle_pane", "tradePoints");
  }
  closeMenu();
}
function toggleTd() {
  showTd.value = !showTd.value;
  if (chart) {
    if (showTd.value) chart.createIndicator("td9", true, { id: "candle_pane" });
    else chart.removeIndicator("candle_pane", "td9");
  }
  closeMenu();
}
function addToGroup(gid: number) {
  wl.add(props.code, headName.value, gid);
  closeMenu();
}
async function newGroupThenAdd() {
  const gid = await wl.addGroup("自定义分组");
  wl.add(props.code, headName.value, gid);
  closeMenu();
}

// ===== 均线设置 =====
const maDlg = ref(false);
const maDraft = ref<{ period: number; color: string }[]>([]);
const maCfg = ref({
  periods: [5, 10, 20, 30, 60],
  colors: ["#f5d020", "#ff8800", "#c060ff", "#19c3ff", "#3aa6ff"],
});
function openMaDlg() {
  maDraft.value = maCfg.value.periods.map((p, i) => ({ period: p, color: maCfg.value.colors[i] }));
  maDlg.value = true;
}
function maAdd() { maDraft.value.push({ period: 30, color: "#ffffff" }); }
function maRemove(i: number) { maDraft.value.splice(i, 1); }
function applyMa() {
  const v = maDraft.value.filter((x) => x.period > 0);
  maCfg.value = { periods: v.map((x) => x.period), colors: v.map((x) => x.color) };
  maDlg.value = false;
  applyMaToChart();
}
function applyMaToChart() {
  chart?.overrideIndicator({
    name: "MA", id: "MA",
    calcParams: maCfg.value.periods.slice(),
    styles: { lines: maCfg.value.colors.map((c) => line(c)) },
  } as any);
}

// ---- 头部 / 盘口 ----
async function loadHead() {
  const [qs, book] = await Promise.all([
    fetchQuotes([props.code]),
    fetchOrderBook(props.code).catch(() => null),
  ]);
  if (qs && qs.length) q.value = qs[0];
  if (book) ob.value = book;
}
async function refreshHead() { try { await loadHead(); } catch { /* ignore */ } }
async function refreshChart() {
  if (!chart) return;
  const tab = tabs[active.value];
  try {
    let bars: KBar[];
    if (tab.minute) bars = await fetchMinute(props.code);
    else bars = await fetchKLine(props.code, tab.period!, tab.period! >= 100 ? 450 : 260);
    if (bars && bars.length) chart.updateData(toKData([bars[bars.length - 1]])[0]);
  } catch { /* ignore */ }
}

onMounted(async () => {
  if (!paper.loaded) paper.load();
  await loadHead();
  await load();
  ro = new ResizeObserver(() => {
    const minute = !!tabs[active.value].minute;
    const ph = paneHeights(minute);
    if (chart && volPaneId) chart.setPaneOptions({ id: volPaneId, height: ph.vol, minHeight: PANE_MINH });
    if (chart && !minute && subPaneId) chart.setPaneOptions({ id: subPaneId, height: ph.sub, minHeight: PANE_MINH });
    chart?.resize();
    if (minute) fitMinute();
  });
  if (host.value) ro.observe(host.value);
  headTimer = window.setInterval(refreshHead, 5000);
  chartTimer = window.setInterval(refreshChart, 10000);
  window.addEventListener("mousedown", onDocMousedown);
});

onUnmounted(() => {
  window.clearInterval(headTimer);
  window.clearInterval(chartTimer);
  window.removeEventListener("mousedown", onDocMousedown);
  ro?.disconnect();
  if (chart) dispose(chart);
});

watch(() => props.code, async () => {
  hasRendered.value = false;
  loading.value = true;
  currentBars.value = [];
  await loadHead();
  load();
});
</script>

<style scoped src="../styles/stock-chart.css"></style>

<style src="../styles/stock-chart-global.css"></style>
