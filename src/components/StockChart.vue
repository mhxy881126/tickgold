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
        <button v-if="!tabs[active].minute" class="sc-tab ghost" @click="openMaDlg">均线设置</button>
      </div>
    </div>

    <!-- ===== 主体 ===== -->
    <div class="sc-body">
      <div class="sc-chart">
        <div ref="host" class="chart-host" @contextmenu.prevent="onContextMenu"></div>

        <!-- 画线工具条（竖排，可收起） -->
        <div v-if="drawBar" class="draw-bar" @contextmenu.stop.prevent>
          <button class="db-btn" :class="{ on: activeDraw === '' }" title="光标 / 选择" @click="pickCursor">
            <svg viewBox="0 0 24 24"><path fill="currentColor" d="M5 3l14 8-6 1.5L9 20l-2-8-2-1z" /></svg>
          </button>
          <div class="db-sep"></div>
          <button
            v-for="t in drawTools"
            :key="t.name"
            class="db-btn txt"
            :class="{ on: activeDraw === t.name }"
            :title="t.label"
            @click="startDraw(t.name)"
          >{{ t.label }}</button>
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

    <!-- ===== 双击蜡烛：历史分时弹窗（可拖拽 / 最大化 / 关闭） ===== -->
    <Teleport to="body">
      <div
        v-if="popup.visible"
        class="mp-box"
        :class="{ max: popup.max }"
        :style="!popup.max ? { left: popup.box.left + 'px', top: popup.box.top + 'px', width: popup.box.width + 'px', height: popup.box.height + 'px' } : {}"
      >
        <div class="mp-title" @mousedown="popTitleDown">
          <span class="mp-tname">{{ popup.name }} · {{ popup.date }} 分时</span>
          <div class="mp-tbtns" @mousedown.stop>
            <button class="mp-btn" @click="popup.max = !popup.max" :title="popup.max ? '还原' : '最大化'">{{ popup.max ? "❐" : "▢" }}</button>
            <button class="mp-btn x" @click="closePopup">×</button>
          </div>
        </div>
        <div class="mp-hostwrap">
          <div ref="popupHost" class="mp-host"></div>
          <div v-if="popupErr" class="mp-err">{{ popupErr }}</div>
        </div>
      </div>
    </Teleport>

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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { init, dispose, registerIndicator, ActionType } from "klinecharts";
import type { Chart, KLineData } from "klinecharts";
import {
  fetchQuotes, fetchKLine, fetchMinute, fetchHistMinute, fetchOrderBook,
} from "../api/market";
import type { Quote, OrderBook, KBar } from "../api/types";
import { usePaperStore } from "../stores/paper";
import { useWatchlistStore } from "../stores/watchlist";

const props = defineProps<{ code: string }>();

const UP = "#FF3232";       // 涨：阳线 / 盘口上涨
const DOWN_K = "#54FCFC";   // K线阴线（青色）
const DOWN_G = "#1DBE7D";   // 盘口下跌（绿色）
const FLAT = "#9aa4b8";
const AVG_Y = "#f5d020";    // 分时均价黄

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

// ---- 格式化 ----
const fmtPx = (v?: number | null) => (v == null || isNaN(v) ? "--" : v.toFixed(2));
function fmtVol(v: number): string {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿手";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万手";
  return v.toFixed(0) + "手";
}
function fmtAmt(v: number): string {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万";
  return v.toFixed(0);
}
const maxVol = computed(() => {
  const lv = [...asks.value, ...(ob.value?.bids ?? [])].map((l) => l.vol);
  return Math.max(1, ...lv);
});
const barW = (v: number) => Math.round((v / maxVol.value) * 100);

const pad = (n: number) => String(n).padStart(2, "0");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const colOf = (v: number) => (v > 0 ? UP : v < 0 ? DOWN_K : FLAT);
const frow = (label: string, value: string, color?: string) => ({ label, value, color });
// 生成完整的 LineStyle（缺字段会导致库内部 mergeLines 读取 dashedValue 崩溃）
const line = (color: string, size = 1) => ({
  color,
  style: "solid" as const,
  smooth: false,
  size,
  dashedValue: [2, 2] as [number, number],
});

// ===== 自定义指标①：分时均价 =====
registerIndicator({
  name: "AVG",
  shortName: "均价",
  series: "price" as any,
  precision: 2,
  figures: [{ key: "avg", title: "均价", type: "line" }],
  calc: (dataList: KLineData[]) => {
    let tv = 0, v = 0;
    return dataList.map((d) => {
      tv += (d.close || 0) * (d.volume || 0);
      v += d.volume || 0;
      return { avg: v > 0 ? tv / v : d.close };
    });
  },
});

// ===== 自定义指标②：神奇九转（TD Sequential 简化版）=====
registerIndicator({
  name: "td9",
  shortName: "九转",
  series: "price" as any,
  calcParams: [],
  figures: [],
  calc: (dataList: KLineData[]) => {
    const result: any[] = [];
    let buySetup = 0, sellSetup = 0; // buy=c<c4（底部，标下方），sell=c>c4（顶部，标上方）
    for (let i = 0; i < dataList.length; i++) {
      const c = dataList[i].close;
      const c4 = i >= 4 ? dataList[i - 4].close : undefined;
      let td = 0, isBuy = false;
      if (c4 !== undefined) {
        if (c < c4) {
          buySetup += 1; sellSetup = 0;
          if (buySetup <= 9) { td = buySetup; isBuy = true; }
          if (buySetup === 9) buySetup = 0;
        } else if (c > c4) {
          sellSetup += 1; buySetup = 0;
          if (sellSetup <= 9) { td = sellSetup; isBuy = false; }
          if (sellSetup === 9) sellSetup = 0;
        } else { buySetup = 0; sellSetup = 0; }
      } else { buySetup = 0; sellSetup = 0; }
      result.push({ td, isBuy });
    }
    return result;
  },
  draw: (params: any) => {
    const { ctx, kLineDataList, indicator, visibleRange, xAxis, yAxis, barSpace } = params;
    if (!ctx || !xAxis || !yAxis || !visibleRange) return;
    const size = Math.max(9, Math.min(13, barSpace?.bar || 6));
    ctx.font = `${size}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = visibleRange.from; i <= visibleRange.to; i++) {
      const r = indicator.result?.[i];
      const d = kLineDataList[i];
      if (!r?.td || !d) continue;
      const x = xAxis.convertToPixel(i);
      const y = yAxis.convertToPixel(r.isBuy ? d.low : d.high) + (r.isBuy ? size + 5 : -(size + 5));
      ctx.fillStyle = r.isBuy ? DOWN_K : UP;
      ctx.fillText(String(r.td), x, y);
    }
  },
} as any);

// ===== 自定义指标③：K线买卖点（extendData = marks[{index,side}]）=====
registerIndicator({
  name: "tradePoints",
  shortName: "买卖点",
  series: "price" as any,
  calcParams: [],
  figures: [],
  calc: (dataList: KLineData[]) => dataList.map(() => ({})),
  draw: (params: any) => {
    const marks = params.indicator?.extendData as { index: number; side: string }[] | undefined;
    if (!marks?.length) return;
    const { ctx, kLineDataList, xAxis, yAxis, barSpace } = params;
    const size = Math.max(11, Math.min(16, barSpace?.bar || 8));
    ctx.font = `bold ${size}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const m of marks) {
      const d = kLineDataList[m.index];
      if (!d) continue;
      const x = xAxis.convertToPixel(m.index);
      if (m.side === "buy") {
        ctx.fillStyle = UP;
        ctx.fillText("B", x, yAxis.convertToPixel(d.low) + size + 7);
      } else {
        ctx.fillStyle = DOWN_G;
        ctx.fillText("S", x, yAxis.convertToPixel(d.high) - size - 7);
      }
    }
  },
} as any);

// ---- KBar -> KLineData ----
function toKData(bars: KBar[]): KLineData[] {
  return bars.map((b) => ({
    timestamp: b.timestamp,
    open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
  }));
}

// ---- 分时均价映射 ----
function buildAvgMap(bars: KBar[]): Map<number, number> {
  const m = new Map<number, number>();
  let tv = 0, v = 0;
  for (const b of bars) {
    tv += b.close * b.volume; v += b.volume;
    m.set(b.timestamp, v > 0 ? tv / v : b.close);
  }
  return m;
}

const hhmmUTC = (ts: number) => {
  const d = new Date(ts);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
function dateLabel(ts: number) {
  const d = new Date(ts);
  const wk = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${wk[d.getUTCDay()]}`;
}

// ---- 同花顺风格样式（关闭库自带 tooltip，改用自建浮窗）----
function buildStyles(minute: boolean) {
  const axisText = "#8b93a7";
  const gridLine = "rgba(255,70,70,.16)";
  const base: any = {
    grid: {
      show: true,
      horizontal: { show: true, ...line(gridLine) },
      vertical: { show: true, ...line(gridLine) },
    },
    candle: {
      type: minute ? "area" : "candle_solid",
      bar: {
        upColor: UP, downColor: DOWN_K, noChangeColor: FLAT,
        upBorderColor: UP, downBorderColor: DOWN_K, noChangeBorderColor: FLAT,
        upWickColor: UP, downWickColor: DOWN_K, noChangeWickColor: FLAT,
      },
      area: {
        lineSize: 1, lineColor: "#ffffff", value: "close", smooth: false,
        backgroundColor: [
          { offset: 0, color: "rgba(0,0,0,0)" },
          { offset: 1, color: "rgba(0,0,0,0)" },
        ],
        point: { show: false },
      },
      priceMark: {
        show: true,
        high: { show: true, color: axisText },
        low: { show: true, color: axisText },
        last: {
          show: true, upColor: UP, downColor: DOWN_K, noChangeColor: FLAT,
          line: { show: true, color: "rgba(255,255,255,.25)" },
        },
      },
      tooltip: { showRule: "none", showType: "rect" },
    },
    indicator: { ohlc: { upColor: UP, downColor: DOWN_K, noChangeColor: FLAT } },
    xAxis: {
      axisLine: { show: true, color: gridLine },
      tickLine: { show: true, color: gridLine },
      tickText: { show: true, color: axisText },
    },
    yAxis: {
      axisLine: { show: true, color: gridLine },
      tickLine: { show: true, color: gridLine },
      tickText: { show: true, color: axisText },
    },
    crosshair: {
      show: true,
      horizontal: {
        show: true, line: { color: "rgba(220,225,240,.45)" },
        text: { backgroundColor: "#363c4e" },
      },
      vertical: {
        show: true, line: { color: "rgba(220,225,240,.45)" },
        text: { backgroundColor: "#363c4e" },
      },
    },
    separator: { color: gridLine },
  };
  return base;
}

// ===== 画线工具（KLineChart 内置 overlay）=====
const drawBar = ref(false);
const activeDraw = ref("");
const drawTools = [
  { name: "segment", label: "线段" },
  { name: "rayLine", label: "射线" },
  { name: "straightLine", label: "直线" },
  { name: "horizontalSegment", label: "水平段" },
  { name: "horizontalRayLine", label: "水平射" },
  { name: "horizontalStraightLine", label: "水平线" },
  { name: "verticalSegment", label: "垂直线" },
  { name: "parallelStraightLine", label: "平行线" },
  { name: "priceChannelLine", label: "通道线" },
  { name: "fibonacciLine", label: "黄金分割" },
  { name: "simpleTag", label: "标签" },
];
const drawInstances = new Map<string, any>();
const drawKey = computed(() => `tg_draw_${props.code}_${active.value}`);
let drawTimer = 0;

function toggleDraw() {
  drawBar.value = !drawBar.value;
}
// 移除尚未画完的 overlay（切换工具 / 回到光标时清理）
function removeUnfinished() {
  for (const [id, ins] of drawInstances) {
    if ((ins.points?.length ?? 0) < (ins.totalStep ?? 2) - 1) {
      chart?.removeOverlay({ id } as any);
      drawInstances.delete(id);
    }
  }
}
function startDraw(name: string) {
  if (!chart) return;
  removeUnfinished();
  activeDraw.value = name;
  const id = chart.createOverlay(name) as unknown as string;
  const ins = chart.getOverlayById(id);
  if (ins) drawInstances.set(id, ins);
}
function pickCursor() {
  removeUnfinished();
  activeDraw.value = "";
}
// 只收集已画完的线（点数达到 totalStep-1），points 原样深拷贝（不假设内部坐标格式）
function collectFinished(): any[] {
  const out: any[] = [];
  for (const [, ins] of drawInstances) {
    const pts = ins.points ?? [];
    if (pts.length >= (ins.totalStep ?? 2) - 1) {
      out.push({ name: ins.name, points: pts.map((p: any) => ({ ...p })) });
    }
  }
  return out;
}
function saveDrawings() {
  try {
    localStorage.setItem(drawKey.value, JSON.stringify(collectFinished()));
  } catch {
    /* ignore */
  }
}
function restoreDrawings() {
  if (!chart) return;
  let arr: any[] = [];
  try {
    arr = JSON.parse(localStorage.getItem(drawKey.value) || "[]");
  } catch {
    arr = [];
  }
  for (const d of arr) {
    const id = chart.createOverlay({ name: d.name, points: d.points } as any) as unknown as string;
    const ins = chart.getOverlayById(id);
    if (ins) drawInstances.set(id, ins);
  }
}
function clearDrawings() {
  for (const [id] of drawInstances) chart?.removeOverlay({ id } as any);
  drawInstances.clear();
  try {
    localStorage.removeItem(drawKey.value);
  } catch {
    /* ignore */
  }
  activeDraw.value = "";
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
  chart = init(host.value);
  if (!chart) return;
  chart.setTimezone("UTC");
  chart.setPriceVolumePrecision(2, 0);
  chart.setStyles(buildStyles(minute));
  chart.applyNewData(toKData(bars));

  if (minute) {
    chart.createIndicator({ name: "AVG", styles: { lines: [line(AVG_Y)] } } as any, false, { id: "candle_pane" });
    chart.createIndicator("VOL", false, { height: 84 });
  } else {
    chart.createIndicator({
      name: "MA",
      calcParams: maCfg.value.periods.slice(),
      styles: { lines: maCfg.value.colors.map((c) => line(c)) },
    } as any, false, { id: "candle_pane" });
    chart.createIndicator("VOL", false, { height: 76 });
    chart.createIndicator("MACD", false, { height: 84 });
  }

  // 叠加层恢复（同 pane 叠加必须 isStack=true，否则会清空 MA/AVG）
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
  saveDrawings(); // 先用旧周期 key 保存画线
  active.value = i;
  await load();
}

// ===== 跟随鼠标浮窗 =====
interface FloatState { visible: boolean; x: number; y: number; rows: any[] }
const float = ref<FloatState>({ visible: false, x: 0, y: 0, rows: [] });

function onCrosshair(data: any) {
  if (!data || !data.kLineData) { float.value.visible = false; return; }
  const tab = tabs[active.value];
  const rows = tab.minute ? minuteFloatRows(data) : klineFloatRows(data);
  const pos = placeFloat(data.x, data.y, rows.length);
  float.value = { visible: true, x: pos.x, y: pos.y, rows };
}

function placeFloat(mx: number, my: number, count: number) {
  const W = host.value?.clientWidth || 800;
  const H = host.value?.clientHeight || 400;
  const fw = 180;
  const fh = count * 21 + 10;
  let fx = mx + 15;
  if (mx > W - fw - 12) fx = mx - fw - 15;
  let fy = my + 15;
  if (my > H - fh - 12) fy = my - fh - 15;
  fx = Math.max(2, Math.min(fx, W - fw - 2));
  fy = Math.max(2, Math.min(fy, H - fh - 2));
  return { x: fx, y: fy };
}

function klineFloatRows(data: any) {
  const k: KLineData = data.kLineData;
  const idx: number = data.dataIndex;
  const prevBar = idx > 0 ? currentBars.value[idx - 1] : null;
  const ref = prevBar ? prevBar.close : k.open;
  const chg = k.close - ref;
  const pp = ref ? (chg / ref) * 100 : 0;
  const amp = ref ? ((k.high - k.low) / ref) * 100 : 0;
  const openPct = ref ? ((k.open - ref) / ref) * 100 : 0;
  const isLast = idx === currentBars.value.length - 1;
  const amt = isLast ? fmtAmt(amount.value) : "--";
  const turn = isLast && q.value ? q.value.turnover.toFixed(2) + "%" : "--";
  return [
    { text: dateLabel(k.timestamp), head: true },
    frow("开盘", k.open.toFixed(2)),
    frow("最高", k.high.toFixed(2), UP),
    frow("最低", k.low.toFixed(2), DOWN_K),
    frow("收盘", k.close.toFixed(2)),
    frow("涨幅", (chg >= 0 ? "+" : "") + pp.toFixed(2) + "%", colOf(chg)),
    frow("振幅", amp.toFixed(2) + "%"),
    frow("成交量", fmtVol(k.volume || 0)),
    frow("成交额", amt),
    frow("换手", turn),
    frow("开盘涨幅", (openPct >= 0 ? "+" : "") + openPct.toFixed(2) + "%", colOf(openPct)),
  ];
}

function minuteFloatRows(data: any) {
  const k: KLineData = data.kLineData;
  const avg = avgMapCur.get(k.timestamp);
  const pc = prevClose.value;
  const ch = k.close - pc;
  const pp = pc ? (ch / pc) * 100 : 0;
  return [
    { text: hhmmUTC(k.timestamp), head: true },
    frow("价格", k.close.toFixed(2), colOf(ch)),
    frow("均价", avg != null ? avg.toFixed(2) : "--", AVG_Y),
    frow("涨跌", (ch >= 0 ? "+" : "") + ch.toFixed(2), colOf(ch)),
    frow("涨幅", (pp >= 0 ? "+" : "") + pp.toFixed(2) + "%", colOf(ch)),
    frow("成交量", fmtVol(k.volume || 0)),
  ];
}

// ===== 双击蜡烛 → 历史分时弹窗 =====
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

const popup = ref({
  visible: false, name: "", date: "", max: false,
  box: { left: 200, top: 110, width: 780, height: 480 },
});
const popupHost = ref<HTMLElement | null>(null);
let popupChart: Chart | null = null;
const popupErr = ref("");

async function openPopup(kd: KLineData) {
  const d = new Date(kd.timestamp);
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  popupErr.value = "";
  popup.value.visible = true;
  popup.value.name = headName.value;
  popup.value.date = date;
  await nextTick();
  if (!popupHost.value) return;
  if (popupChart) { dispose(popupChart); popupChart = null; }
  popupChart = init(popupHost.value);
  if (!popupChart) return;
  const pc: Chart = popupChart;
  pc.setTimezone("UTC");
  pc.setPriceVolumePrecision(2, 0);
  pc.setStyles(buildStyles(true));
  try {
    const hist = await fetchHistMinute(props.code, date);
    pc.applyNewData(toKData(hist));
    pc.createIndicator({ name: "AVG", styles: { lines: [line(AVG_Y)] } } as any, false, { id: "candle_pane" });
    pc.createIndicator("VOL", false, { height: 70 });
  } catch (e: any) {
    popupErr.value = e?.message || String(e);
  }
  pc.resize();
}

// 弹窗拖拽
let dragData: { dx: number; dy: number } | null = null;
function popTitleDown(e: MouseEvent) {
  if (popup.value.max) return;
  dragData = { dx: e.clientX - popup.value.box.left, dy: e.clientY - popup.value.box.top };
  window.addEventListener("mousemove", popMove);
  window.addEventListener("mouseup", popUp);
}
function popMove(e: MouseEvent) {
  if (!dragData) return;
  popup.value.box.left = e.clientX - dragData.dx;
  popup.value.box.top = e.clientY - dragData.dy;
}
function popUp() {
  dragData = null;
  window.removeEventListener("mousemove", popMove);
  window.removeEventListener("mouseup", popUp);
}
function closePopup() {
  popup.value.visible = false;
  if (popupChart) { dispose(popupChart); popupChart = null; }
}

// ===== 右键菜单 =====
const menu = ref({ visible: false, x: 0, y: 0 });
function onContextMenu(e: MouseEvent) {
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
function sameDay(ts: number, d: Date) {
  const x = new Date(ts);
  return x.getUTCFullYear() === d.getUTCFullYear() && x.getUTCMonth() === d.getUTCMonth() && x.getUTCDate() === d.getUTCDate();
}
function barContains(b: KBar, d: Date, period: number): boolean {
  const x = new Date(b.timestamp);
  if (period === 101) return sameDay(b.timestamp, d);
  if (period === 103) return x.getUTCFullYear() === d.getUTCFullYear() && x.getUTCMonth() === d.getUTCMonth();
  if (period === 102) {
    const monday = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
    const wd = (monday.getUTCDay() + 6) % 7;
    monday.setUTCDate(monday.getUTCDate() - wd);
    const next = new Date(monday); next.setUTCDate(next.getUTCDate() + 7);
    return d >= monday && d < next;
  }
  return false;
}
function findBarIndex(createdAt: number, tab: any): number {
  const od = new Date(createdAt);
  if (tab.period >= 101) {
    return currentBars.value.findIndex((b) => barContains(b, od, tab.period));
  }
  let best = -1, bd = Infinity;
  currentBars.value.forEach((b, i) => {
    const diff = Math.abs(b.timestamp - createdAt);
    if (diff < bd) { bd = diff; best = i; }
  });
  const tol = (tab.period || 5) * 60 * 1000 * 1.5;
  return bd <= tol ? best : -1;
}
function buildTradeMarks() {
  const marks: { index: number; side: string }[] = [];
  const tab = tabs[active.value];
  for (const o of paper.orders) {
    if (o.code !== props.code) continue;
    const idx = findBarIndex(o.createdAt, tab);
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
    else chart.removeIndicator("tradePoints");
  }
  closeMenu();
}
function toggleTd() {
  showTd.value = !showTd.value;
  if (chart) {
    if (showTd.value) chart.createIndicator("td9", true, { id: "candle_pane" });
    else chart.removeIndicator("td9");
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
  await loadHead();
  await load();
  ro = new ResizeObserver(() => {
    chart?.resize();
    if (popupChart) popupChart.resize();
    if (tabs[active.value].minute) fitMinute();
  });
  if (host.value) ro.observe(host.value);
  headTimer = window.setInterval(refreshHead, 5000);
  chartTimer = window.setInterval(refreshChart, 10000);
  drawTimer = window.setInterval(saveDrawings, 2500);
});

onUnmounted(() => {
  saveDrawings();
  window.clearInterval(headTimer);
  window.clearInterval(chartTimer);
  window.clearInterval(drawTimer);
  window.removeEventListener("mousemove", popMove);
  window.removeEventListener("mouseup", popUp);
  ro?.disconnect();
  if (chart) dispose(chart);
  if (popupChart) dispose(popupChart);
});

watch(() => props.code, async () => {
  hasRendered.value = false;
  loading.value = true;
  currentBars.value = [];
  await loadHead();
  load();
});
</script>

<style scoped>
.sc-root {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  background: #0a0a0a; color: #d6dae3; font-size: 12px;
}

/* 股票头 */
.sc-head {
  display: flex; align-items: center; gap: 16px;
  padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,.06); flex-wrap: wrap;
}
.sc-id { display: flex; flex-direction: column; gap: 2px; min-width: 92px; }
.sc-name { font-size: 16px; font-weight: 700; color: #eef1f6; }
.sc-code { font-size: 11px; color: #8b93a7; }
.sc-px { display: flex; align-items: baseline; gap: 10px; min-width: 150px; }
.sc-price { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
.sc-chg { display: flex; flex-direction: column; font-size: 11px; font-variant-numeric: tabular-nums; }
.sc-grid {
  display: grid; grid-template-columns: repeat(6, auto); gap: 4px 18px;
  margin-left: auto;
}
.gi { display: flex; gap: 6px; white-space: nowrap; }
.gi label { color: #7b8294; }
.gi span { color: #c7ccd8; font-variant-numeric: tabular-nums; }

/* 周期条 */
.sc-tabs {
  display: flex; align-items: center; gap: 2px;
  padding: 4px 10px; border-bottom: 1px solid rgba(255,255,255,.06);
}
.sc-tab {
  border: none; background: transparent; color: #9aa1b1;
  padding: 4px 10px; font-size: 12px; border-radius: 5px; cursor: pointer;
}
.sc-tab:hover { background: rgba(255,255,255,.06); color: #e6e9f0; }
.sc-tab.active { background: rgba(255,50,50,.18); color: #ff7070; }
.sc-tab.ghost { color: #b9c0cf; }
.sc-tabs-right { margin-left: auto; }

/* 主体 */
.sc-body { flex: 1; min-height: 0; display: flex; }
.sc-chart { flex: 1; min-width: 0; position: relative; }
.chart-host { position: absolute; inset: 0; }

/* 画线工具条 */
.draw-bar {
  position: absolute; left: 6px; top: 6px; z-index: 6;
  display: flex; flex-direction: column; gap: 2px;
  padding: 4px; border-radius: 9px;
  background: rgba(16, 18, 24, .9);
  border: 1px solid rgba(255, 255, 255, .12);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .5);
  max-height: calc(100% - 12px); overflow-y: auto;
}
.db-btn {
  width: 40px; height: 30px; border: none; border-radius: 6px;
  background: transparent; color: #aab1c0; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; flex-shrink: 0; padding: 0;
}
.db-btn svg { width: 17px; height: 17px; }
.db-btn:hover { background: rgba(255, 255, 255, .08); color: #fff; }
.db-btn.on { background: rgba(255, 50, 50, .2); color: #ff7a7a; }
.db-btn.danger { color: #ff8080; }
.db-btn.danger:hover { background: rgba(255, 60, 60, .22); }
.db-sep { height: 1px; background: rgba(255, 255, 255, .1); margin: 3px 2px; }
.sc-mask {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 12px;
  color: #8b93a7; background: #0a0a0a;
}
.sc-mask.err { color: #ff6b76; padding: 0 24px; text-align: center; }
.err-text { font-size: 12px; }
.err-btn {
  border: 1px solid rgba(255,90,90,.5); background: rgba(255,50,50,.12);
  color: #ff7070; padding: 5px 18px; border-radius: 6px; cursor: pointer; font-size: 12px;
}
.err-btn:hover { background: rgba(255,50,50,.22); }

/* 持仓信息角标 */
.sc-posinfo {
  position: absolute; left: 10px; top: 10px; z-index: 5;
  background: rgba(18,20,26,.92); border: 1px solid rgba(255,255,255,.1);
  border-radius: 8px; padding: 8px 10px; min-width: 132px;
  display: flex; flex-direction: column; gap: 3px; font-size: 11px;
}
.sc-posinfo.up { border-color: rgba(255,50,50,.4); }
.sc-posinfo.down-k { border-color: rgba(84,252,252,.4); }
.pi-row { display: flex; justify-content: space-between; gap: 12px; }
.pi-row label { color: #7b8294; }
.pi-row span { font-variant-numeric: tabular-nums; color: #d6dae3; }
.sc-posinfo.up .pi-row:last-child span { color: #ff6b6b; }
.sc-posinfo.down-k .pi-row:last-child span { color: #54fcfc; }

/* 跟随鼠标浮窗 */
.sc-float {
  position: absolute; z-index: 8; width: 180px;
  background: rgba(16,18,24,.96);
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 8px; padding: 6px 8px;
  box-shadow: 0 8px 28px rgba(0,0,0,.55);
  pointer-events: none;
}
.fl-head {
  font-size: 11px; color: #cfd5e2; font-weight: 600;
  padding: 2px 2px 5px; border-bottom: 1px solid rgba(255,255,255,.08); margin-bottom: 4px;
}
.fl-row { display: flex; justify-content: space-between; gap: 10px; height: 21px; align-items: center; }
.fl-label { color: #828a9c; font-size: 11px; }
.fl-value { color: #d6dae3; font-size: 11px; font-variant-numeric: tabular-nums; }

/* 五档盘口 */
.sc-book {
  width: 178px; flex-shrink: 0; border-left: 1px solid rgba(255,255,255,.06);
  display: flex; flex-direction: column; font-size: 11px;
}
.ask, .bid { display: flex; flex-direction: column; }
.lvl {
  position: relative; display: grid; grid-template-columns: 30px 1fr auto;
  gap: 4px; padding: 2.5px 8px; align-items: center; overflow: hidden;
}
.lvl-tag { color: #7b8294; z-index: 1; }
.lvl-px { z-index: 1; font-variant-numeric: tabular-nums; text-align: right; }
.lvl-vol { color: #9aa1b1; z-index: 1; font-variant-numeric: tabular-nums; }
.lvl-bar {
  position: absolute; right: 0; top: 2px; bottom: 2px; height: auto;
  opacity: .14; z-index: 0; border-radius: 3px 0 0 3px;
}
.ask-lvl .lvl-bar { background: #FF3232; }
.bid-lvl .lvl-bar { background: #1DBE7D; }
.book-mid {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: 6px 10px; border-top: 1px solid rgba(255,255,255,.06);
  border-bottom: 1px solid rgba(255,255,255,.06);
}
.bm-px { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
.bm-chg { font-size: 11px; font-variant-numeric: tabular-nums; }
.book-foot { margin-top: auto; padding: 8px 10px; border-top: 1px solid rgba(255,255,255,.06); }
.book-foot div { display: flex; justify-content: space-between; padding: 2px 0; }
.book-foot label { color: #7b8294; }
.book-foot span { color: #c7ccd8; }

.up { color: #FF3232 !important; }
.down-g { color: #1DBE7D !important; }
.down-k { color: #54FCFC !important; }
</style>

<style>
/* Teleport 到 body 的元素（非 scoped） */
.cm-mask { position: fixed; inset: 0; z-index: 9000; }
.cm {
  position: fixed; z-index: 9001; min-width: 188px;
  background: rgba(20,22,28,.98); border: 1px solid rgba(255,255,255,.12);
  border-radius: 9px; padding: 5px;
  box-shadow: 0 12px 40px rgba(0,0,0,.6);
  font-size: 12px; color: #d6dae3; user-select: none;
}
.cm-item {
  position: relative; display: flex; align-items: center; justify-content: space-between;
  padding: 7px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
}
.cm-item:hover { background: rgba(255,255,255,.08); }
.cm-item.on { color: #ff8080; }
.cm-check { color: #ff6b6b; font-style: normal; font-size: 12px; }
.cm-arrow { color: #7b8294; margin-left: 18px; }
.cm-sep { height: 1px; background: rgba(255,255,255,.1); margin: 4px 6px; }
.cm-sub {
  position: absolute; left: 100%; top: -6px; margin-left: 2px;
  min-width: 150px; display: none;
  background: rgba(20,22,28,.98); border: 1px solid rgba(255,255,255,.12);
  border-radius: 9px; padding: 5px;
  box-shadow: 0 12px 40px rgba(0,0,0,.6);
}
.cm-parent:hover .cm-sub { display: block; }
.cm-new { color: #9fd0ff; }

/* 双击弹窗 */
.mp-box {
  position: fixed; z-index: 8500;
  background: #0d0f14; border: 1px solid rgba(255,255,255,.12);
  border-radius: 10px; overflow: hidden;
  box-shadow: 0 18px 60px rgba(0,0,0,.7);
  display: flex; flex-direction: column;
}
.mp-box.max { left: 10px !important; top: 10px !important; width: calc(100vw - 20px) !important; height: calc(100vh - 20px) !important; }
.mp-title {
  display: flex; align-items: center; justify-content: space-between;
  height: 38px; padding: 0 8px 0 14px; cursor: move;
  background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.01));
  border-bottom: 1px solid rgba(255,255,255,.08);
}
.mp-tname { font-size: 12px; color: #d6dae3; font-weight: 600; }
.mp-tbtns { display: flex; gap: 4px; }
.mp-btn {
  border: none; background: transparent; color: #9aa1b1;
  width: 30px; height: 26px; border-radius: 6px; cursor: pointer; font-size: 13px;
}
.mp-btn:hover { background: rgba(255,255,255,.1); color: #fff; }
.mp-btn.x:hover { background: rgba(255,60,60,.3); color: #ff8080; }
.mp-hostwrap { flex: 1; min-height: 0; position: relative; }
.mp-host { position: absolute; inset: 0; }
.mp-err {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #ff8080; font-size: 12px; padding: 20px; text-align: center; background: #0d0f14;
}

/* 均线设置弹窗 */
.ma-overlay {
  position: fixed; inset: 0; z-index: 9200;
  background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center;
}
.ma-box {
  width: 320px; background: #14161d; border: 1px solid rgba(255,255,255,.12);
  border-radius: 12px; padding: 16px;
  box-shadow: 0 20px 60px rgba(0,0,0,.6);
}
.ma-title { font-size: 14px; font-weight: 700; color: #eef1f6; margin-bottom: 12px; }
.ma-head, .ma-line {
  display: grid; grid-template-columns: 1fr 60px 34px; gap: 8px; align-items: center;
}
.ma-head { padding: 0 2px 6px; color: #7b8294; font-size: 11px; }
.ma-line { margin-bottom: 8px; }
.ma-input {
  height: 30px; border: 1px solid rgba(255,255,255,.12); border-radius: 6px;
  background: #0d0f14; color: #e6e9f0; padding: 0 10px; font-size: 12px; width: 100%;
  box-sizing: border-box;
}
.ma-color { height: 30px; border: 1px solid rgba(255,255,255,.12); border-radius: 6px; background: #0d0f14; padding: 2px; cursor: pointer; }
.ma-del {
  height: 30px; border: none; border-radius: 6px; background: rgba(255,80,80,.15);
  color: #ff8080; cursor: pointer; font-size: 14px;
}
.ma-del:hover { background: rgba(255,80,80,.28); }
.ma-add {
  width: 100%; height: 32px; border: 1px dashed rgba(255,255,255,.2); border-radius: 7px;
  background: transparent; color: #9fd0ff; cursor: pointer; font-size: 12px; margin: 4px 0 14px;
}
.ma-add:hover { background: rgba(255,255,255,.05); }
.ma-foot { display: flex; justify-content: flex-end; gap: 8px; }
.ma-cancel, .ma-apply {
  height: 32px; padding: 0 18px; border-radius: 7px; cursor: pointer; font-size: 12px;
}
.ma-cancel { border: 1px solid rgba(255,255,255,.15); background: transparent; color: #c7ccd8; }
.ma-apply { border: none; background: #ff3232; color: #fff; font-weight: 600; }
.ma-apply:hover { background: #ff4d4d; }
</style>
