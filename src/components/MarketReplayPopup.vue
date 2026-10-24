<!--
  MarketReplayPopup.vue —— 历史盘面回放（v2.29）
  指定交易日的全市场回放：指数分时 / 情绪（涨停数）/ 板块快照 / 涨停池，
  时间轴按本地时序库 ts_index / ts_market / ts_sector 的分钟快照播放，
  涨停池走东财历史接口。由涨停池明细卡头部"盘面回放"按钮打开。
-->
<template>
  <Teleport to="body">
    <div v-if="visible" class="mr-box" :class="{ max }" :style="!max ? boxStyle : {}">
      <div class="mr-title" @mousedown="titleDown">
        <span class="mr-tname">历史盘面回放</span>
        <div class="mr-tbtns" @mousedown.stop>
          <button class="mr-btn" @click="max = !max">{{ max ? "❐" : "▢" }}</button>
          <button class="mr-btn x" @click="close">×</button>
        </div>
      </div>

      <!-- 工具行 -->
      <div class="mr-toolbar" @mousedown.stop>
        <input type="date" v-model="day" class="mr-date" @change="onDayChange" />
        <button class="mr-tbtn" @click="shiftDay(-1)">◀</button>
        <button class="mr-tbtn" @click="shiftDay(1)">▶</button>
        <span class="mr-sep"></span>
        <div class="mr-seg">
          <button :class="{ on: kind === 'industry' }" @click="kind = 'industry'">行业</button>
          <button :class="{ on: kind === 'concept' }" @click="kind = 'concept'">概念</button>
        </div>
        <span v-if="msg" class="mr-msg">{{ msg }}</span>
      </div>

      <div class="mr-content">
        <!-- 左：图表 -->
        <div class="mr-left">
          <div ref="chartEl" class="mr-chart"></div>
          <div class="mr-readouts">
            <div class="mr-ro"><span class="k">涨停</span><b class="up">{{ curMarket?.limitUp ?? "--" }}</b></div>
            <div class="mr-ro"><span class="k">跌停</span><b class="dn">{{ curMarket?.limitDown ?? "--" }}</b></div>
            <div class="mr-ro"><span class="k">炸板率</span><b>{{ curMarket ? (curMarket.brokenRate ?? 0).toFixed(1) + "%" : "--" }}</b></div>
            <div class="mr-ro"><span class="k">最高板</span><b>{{ curMarket?.maxBoards ?? "--" }}</b></div>
            <div class="mr-ro"><span class="k">上涨</span><b class="up">{{ curMarket?.upCount ?? "--" }}</b></div>
            <div class="mr-ro"><span class="k">下跌</span><b class="dn">{{ curMarket?.downCount ?? "--" }}</b></div>
          </div>
        </div>

        <!-- 右上：板块快照（截至光标时刻）-->
        <div class="mr-panel">
          <div class="mr-panel-title">板块快照 · {{ fmtClock(curTs) }}</div>
          <div v-if="!curSectors.length" class="mr-empty">该时刻无板块分时数据（盘中每 5 分钟采集）</div>
          <div
            v-for="s in curSectors"
            :key="s.kind + s.code"
            class="mr-sec-row"
          >
            <span class="mr-sec-name">{{ s.name }}</span>
            <span :class="pctClass(s.changePct)">{{ fmtPct(s.changePct) }}</span>
            <span class="mr-sec-lead">{{ s.leadName }}</span>
          </div>
        </div>

        <!-- 右下：涨停 / 炸板池 -->
        <div class="mr-panel">
          <div class="mr-panel-title mr-pool-head">
            <div class="mr-seg small">
              <button :class="{ on: poolKind === 'zt' }" @click="poolKind = 'zt'">涨停池（{{ ztList.length }}）</button>
              <button :class="{ on: poolKind === 'zb' }" @click="poolKind = 'zb'">炸板池（{{ zbList.length }}）</button>
            </div>
          </div>
          <div v-if="poolKind === 'zt'">
            <div v-if="!ztList.length" class="mr-empty">{{ ztMsg || "加载中…" }}</div>
            <div v-for="z in ztList" :key="z.code" class="mr-zt-row">
              <span class="mr-zt-name">{{ z.name }}</span>
              <span class="up">{{ fmtPct(z.pct) }}</span>
              <span class="mr-zt-ind">{{ z.industry }}</span>
              <span v-if="z.fund" class="mr-zt-amt">{{ fmtAmt(z.fund) }}</span>
            </div>
          </div>
          <div v-else>
            <div v-if="!zbList.length" class="mr-empty">{{ zbMsg || "加载中…" }}</div>
            <div v-for="z in zbList" :key="z.code" class="mr-zt-row">
              <span class="mr-zt-name">{{ z.name }}</span>
              <span :class="pctClass(z.pct)">{{ fmtPct(z.pct) }}</span>
              <span class="mr-zt-ind">{{ z.industry }}</span>
              <span v-if="z.broken" class="mr-zt-amt">炸 {{ z.broken }} 次</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 播放条 -->
      <div class="mr-replay" @mousedown.stop>
        <button class="mr-rbtn" @click="toStart">⏮</button>
        <button class="mr-rbtn play" @click="togglePlay">{{ playing ? "❚❚" : "▶" }}</button>
        <input
          class="mr-range"
          type="range"
          min="0"
          :max="Math.max(0, timeline.length - 1)"
          v-model.number="cursor"
          @input="onSeek"
        />
        <span class="mr-clock">{{ fmtClock(curTs) }}</span>
        <div class="mr-speeds">
          <button v-for="s in [1, 4, 16, 60]" :key="s" :class="{ on: speed === s }" @click="speed = s">
            {{ s }}x
          </button>
        </div>
        <button class="mr-rbtn" @click="toEnd">⏭</button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { db } from "../db/database";
import { fetchZtPool, fetchZbPool, type ZtStock } from "../api/market";

interface MarketRow {
  ts: number; total: number; upCount: number; downCount: number; flatCount: number;
  limitUp: number; limitDown: number; broken: number; brokenRate: number;
  maxBoards: number; sentiment: number;
}
interface IndexRow { ts: number; code: string; name: string; price: number; pct: number; amount: number }
interface SectorRow {
  ts: number; kind: string; code: string; name: string;
  changePct: number; netAmount: number; leadName: string;
}

const visible = ref(false);
const max = ref(false);
const box = ref({ left: 120, top: 70, width: 1080, height: 660 });
const boxStyle = computed(() => ({
  left: box.value.left + "px", top: box.value.top + "px",
  width: box.value.width + "px", height: box.value.height + "px",
}));

const day = ref("");
const kind = ref<"industry" | "concept">("industry");
const msg = ref("");

const marketRows = ref<MarketRow[]>([]);
const indexRows = ref<IndexRow[]>([]);
const sectorRows = ref<SectorRow[]>([]);
const ztList = ref<ZtStock[]>([]);
const ztMsg = ref("");
const zbList = ref<ZtStock[]>([]);
const zbMsg = ref("");
const poolKind = ref<"zt" | "zb">("zt");

const chartEl = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;

// 时间轴：指数分时分钟点（若无则用情绪点）
const timeline = computed(() => {
  const src = indexRows.value.length ? indexRows.value : marketRows.value as unknown as { ts: number }[];
  return [...new Set(src.map((r) => r.ts))].sort((a, b) => a - b);
});
const cursor = ref(0);
const curTs = computed(() => timeline.value[cursor.value] ?? 0);

const curMarket = computed(() => {
  let best: MarketRow | undefined;
  for (const r of marketRows.value) {
    if (r.ts <= curTs.value) best = r; else break;
  }
  return best;
});

const curSectors = computed(() => {
  const latest = new Map<string, SectorRow>();
  for (const r of sectorRows.value) {
    if (r.ts > curTs.value) break;
    latest.set(r.kind + r.code, r);
  }
  return [...latest.values()]
    .filter((s) => s.kind === kind.value)
    .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
    .slice(0, 20);
});

// ===== 数据装载 =====
async function loadDay() {
  msg.value = "";
  marketRows.value = [];
  indexRows.value = [];
  sectorRows.value = [];
  ztList.value = [];
  zbList.value = [];
  try {
    const [m, ix, se] = await Promise.all([
      db().select<MarketRow[]>(
        `SELECT ts,total,up_count AS upCount,down_count AS downCount,flat_count AS flatCount,
                limit_up AS limitUp,limit_down AS limitDown,broken,broken_rate AS brokenRate,
                max_boards AS maxBoards,sentiment
         FROM ts_market WHERE day=? ORDER BY ts`,
        [day.value]
      ),
      db().select<IndexRow[]>(
        `SELECT ts,code,name,price,pct,amount FROM ts_index WHERE day=? ORDER BY ts`,
        [day.value]
      ),
      db().select<SectorRow[]>(
        `SELECT ts,kind,code,name,change_pct AS changePct,net_amount AS netAmount,
                lead_name AS leadName
         FROM ts_sector WHERE day=? ORDER BY ts`,
        [day.value]
      ),
    ]);
    marketRows.value = m;
    indexRows.value = ix;
    sectorRows.value = se;
    if (!timeline.value.length) msg.value = "本地无该日分时快照（v2.29 起盘中自动积累）";
    cursor.value = Math.max(0, timeline.value.length - 1);
  } catch (e) {
    msg.value = `读取失败：${e}`;
  }

  // 涨停 / 炸板池：东财历史
  ztMsg.value = "";
  zbMsg.value = "";
  const ymd = day.value.replace(/-/g, "");
  const [ztRes, zbRes] = await Promise.allSettled([
    fetchZtPool(ymd),
    fetchZbPool(ymd),
  ]);
  if (ztRes.status === "fulfilled") {
    ztList.value = ztRes.value.list ?? [];
    if (!ztList.value.length) ztMsg.value = "该日无涨停池数据或非交易日";
  } else {
    ztMsg.value = `涨停池读取失败：${ztRes.reason}`;
  }
  if (zbRes.status === "fulfilled") {
    zbList.value = zbRes.value.list ?? [];
    if (!zbList.value.length) zbMsg.value = "该日无炸板记录或非交易日";
  } else {
    zbMsg.value = `炸板池读取失败：${zbRes.reason}`;
  }

  await nextTick();
  renderChart();
}

function availableIndexNames(): { code: string; name: string }[] {
  const map = new Map<string, string>();
  for (const r of indexRows.value) map.set(r.code, r.name);
  return [...map.entries()].map(([code, name]) => ({ code, name })).slice(0, 6);
}

function renderChart() {
  if (!chartEl.value) return;
  if (!chart) chart = echarts.init(chartEl.value);
  const tsList = timeline.value;
  const labels = tsList.map((t) => fmtClock(t));
  const indices = availableIndexNames();
  const series: echarts.SeriesOption[] = indices.map(({ code, name }) => {
    const byTs = new Map<number, number>();
    for (const r of indexRows.value) if (r.code === code) byTs.set(r.ts, r.pct);
    return {
      name, type: "line", smooth: true, showSymbol: false,
      data: tsList.map((t) => byTs.get(t) ?? null as unknown as number),
      lineStyle: { width: code === indices[0]?.code ? 2 : 1.2 },
    };
  });
  const mByTs = new Map<number, number>();
  for (const r of marketRows.value) mByTs.set(r.ts, r.limitUp);
  series.push({
    name: "涨停数", type: "line", smooth: true, showSymbol: false,
    yAxisIndex: 1,
    data: tsList.map((t) => mByTs.get(t) ?? null as unknown as number),
    areaStyle: { opacity: 0.12 },
    lineStyle: { color: "#ff8a3d", width: 1.4 },
    itemStyle: { color: "#ff8a3d" },
  });
  chart.setOption({
    backgroundColor: "transparent",
    animation: false,
    grid: { left: 46, right: 42, top: 34, bottom: 24 },
    legend: {
      top: 4, right: 8, textStyle: { color: "#9aa3b6", fontSize: 10 },
      itemWidth: 14, itemHeight: 8,
    },
    tooltip: { trigger: "axis", backgroundColor: "#151a24", borderColor: "#2a3344", textStyle: { color: "#d6dae3", fontSize: 11 } },
    xAxis: {
      type: "category", data: labels, boundaryGap: false,
      axisLine: { lineStyle: { color: "#2a3344" } },
      axisLabel: { color: "#667088", fontSize: 9, interval: 29 },
    },
    yAxis: [
      {
        type: "value", scale: true,
        axisLabel: { color: "#667088", fontSize: 9, formatter: "{value}%" },
        splitLine: { lineStyle: { color: "var(--ov-05)" } },
      },
      {
        type: "value", scale: true, position: "right",
        axisLabel: { color: "#667088", fontSize: 9 },
        splitLine: { show: false },
      },
    ],
    series,
  }, true);
}

// ===== 播放 =====
const playing = ref(false);
const speed = ref(16);
let playTimer = 0;

function togglePlay() {
  if (playing.value) { stop(); return; }
  if (cursor.value >= timeline.value.length - 1) cursor.value = 0;
  playing.value = true;
  playTimer = window.setInterval(() => {
    if (cursor.value >= timeline.value.length - 1) { stop(); return; }
    cursor.value += 1;
    onSeek();
  }, Math.max(12, Math.round(400 / speed.value)));
}
function stop() {
  playing.value = false;
  if (playTimer) { clearInterval(playTimer); playTimer = 0; }
}
function onSeek() {
  if (chart && timeline.value.length) {
    const label = fmtClock(timeline.value[cursor.value]);
    chart.dispatchAction({ type: "showTip", seriesIndex: 0, name: label });
  }
}
function toStart() { stop(); cursor.value = 0; onSeek(); }
function toEnd() { stop(); cursor.value = Math.max(0, timeline.value.length - 1); onSeek(); }

function localDayISO(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

async function shiftDay(delta: number) {
  const d = new Date(day.value + "T00:00:00");
  for (let i = 0; i < 5; i++) {
    d.setDate(d.getDate() + delta);
    const wd = d.getDay();
    if (wd >= 1 && wd <= 5) break;
  }
  day.value = localDayISO(d);
  await loadDay();
}
function onDayChange() { void loadDay(); }

// ===== 格式化 =====
function pad2(n: number) { return String(n).padStart(2, "0"); }
function fmtClock(ts: number): string {
  if (!ts) return "--:--";
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtPct(v?: number | null): string {
  if (v === undefined || v === null) return "--";
  return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
}
function fmtAmt(v?: number | null): string {
  if (!v) return "";
  return v >= 1e8 ? (v / 1e8).toFixed(2) + "亿" : (v / 1e4).toFixed(0) + "万";
}
function pctClass(v?: number | null): string {
  if (v === undefined || v === null) return "";
  return v > 0 ? "up" : v < 0 ? "dn" : "";
}

// ===== 拖拽 =====
let drag: { dx: number; dy: number } | null = null;
function titleDown(e: MouseEvent) {
  if (max.value) return;
  drag = { dx: e.clientX - box.value.left, dy: e.clientY - box.value.top };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}
function move(e: MouseEvent) {
  if (!drag) return;
  box.value.left = e.clientX - drag.dx;
  box.value.top = e.clientY - drag.dy;
}
function up() {
  drag = null;
  window.removeEventListener("mousemove", move);
  window.removeEventListener("mouseup", up);
}

function onResize() { chart?.resize(); }
window.addEventListener("resize", onResize);

function close() {
  stop();
  visible.value = false;
  chart?.dispose();
  chart = null;
}
onUnmounted(() => {
  stop();
  window.removeEventListener("resize", onResize);
  window.removeEventListener("mousemove", move);
  window.removeEventListener("mouseup", up);
  chart?.dispose();
});

function open(d?: string) {
  day.value = d ?? localDayISO(new Date());
  max.value = false;
  visible.value = true;
  void nextTick().then(loadDay);
}

defineExpose({ open });
</script>

<style scoped>
.mr-box {
  position: fixed; z-index: 8500;
  background: #0d0f14; border: 1px solid var(--ov-12);
  border-radius: 10px; overflow: hidden;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.7);
  display: flex; flex-direction: column;
}
.mr-box.max {
  left: 10px !important; top: 10px !important;
  width: calc(100vw - 20px) !important; height: calc(100vh - 20px) !important;
}
.mr-title {
  display: flex; align-items: center; justify-content: space-between;
  height: 36px; padding: 0 8px 0 14px; cursor: move;
  background: linear-gradient(180deg, var(--ov-05), var(--ov-01));
  border-bottom: 1px solid var(--ov-08);
}
.mr-tname { font-size: 12px; color: var(--text-dim); font-weight: 600; }
.mr-tbtns { display: flex; gap: 4px; }
.mr-btn {
  border: none; background: transparent; color: var(--text-dim);
  width: 30px; height: 26px; border-radius: 6px; cursor: pointer; font-size: 13px;
}
.mr-btn:hover { background: var(--ov-10); color: #fff; }
.mr-btn.x:hover { background: rgba(255, 60, 60, 0.3); color: var(--up); }

.mr-toolbar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 12px; border-bottom: 1px solid var(--ov-08);
  background: var(--ov-02);
}
.mr-date {
  background: #141823; border: 1px solid #2a3344; border-radius: 6px;
  color: var(--text-dim); font-size: 11px; padding: 3px 6px;
}
.mr-tbtn {
  border: none; background: transparent; color: var(--text-dim);
  height: 24px; min-width: 26px; border-radius: 5px; cursor: pointer; font-size: 11px;
}
.mr-tbtn:hover { background: var(--ov-08); color: #fff; }
.mr-sep { width: 1px; height: 14px; background: var(--ov-12); margin: 0 4px; }
.mr-seg { display: flex; border: 1px solid #2a3344; border-radius: 6px; overflow: hidden; }
.mr-seg button {
  padding: 3px 12px; background: transparent; color: #8892a8;
  border: none; cursor: pointer; font-size: 11px;
}
.mr-seg button.on { background: rgba(232, 156, 61, 0.18); color: var(--accent); }
.mr-msg { margin-left: 8px; font-size: 11px; color: var(--accent); }

.mr-content {
  flex: 1; min-height: 0;
  display: grid;
  grid-template-columns: 1fr 280px;
  grid-template-rows: 1fr 1fr;
  gap: 1px;
  background: var(--ov-05);
}
.mr-left {
  grid-row: 1 / 3;
  display: flex; flex-direction: column; min-height: 0;
  background: #0d0f14;
}
.mr-chart { flex: 1; min-height: 0; }
.mr-readouts {
  display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px;
  padding: 6px 10px 8px;
}
.mr-ro {
  display: flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 5px; border-radius: 7px; background: var(--ov-03);
}
.mr-ro .k { font-size: 10px; color: var(--text-dim); }
.mr-ro b { font-size: 14px; }
.mr-ro .up, .up { color: #ff5f5f; }
.mr-ro .dn, .dn { color: #3cdc96; }

.mr-panel {
  min-height: 0; display: flex; flex-direction: column;
  background: #0d0f14; padding: 8px 10px;
}
.mr-panel-title { font-size: 11px; color: #9aa3b6; margin-bottom: 5px; font-weight: 600; }
.mr-pool-head { margin-bottom: 4px; }
.mr-seg.small { border-color: #2a3344; }
.mr-seg.small button {
  padding: 2px 8px; font-size: 10px; color: #8892a8;
  background: transparent; border: none; cursor: pointer; border-radius: 5px;
}
.mr-seg.small button.on { background: rgba(232, 156, 61, 0.18); color: var(--accent); }
.mr-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: #556078; font-size: 11px; text-align: center; }
.mr-sec-row, .mr-zt-row {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 2px; border-bottom: 1px solid var(--ov-04);
  font-size: 11px;
}
.mr-sec-name, .mr-zt-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
.mr-sec-lead, .mr-zt-ind { color: var(--text-dim); font-size: 10px; max-width: 74px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mr-zt-amt { font-size: 10px; color: var(--accent); min-width: 52px; text-align: right; }

.mr-replay {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; border-top: 1px solid var(--ov-08);
  background: var(--ov-02);
}
.mr-rbtn {
  border: none; background: transparent; color: var(--text-dim);
  height: 26px; min-width: 30px; border-radius: 5px; cursor: pointer; font-size: 12px;
}
.mr-rbtn:hover { background: var(--ov-08); color: #fff; }
.mr-rbtn.play { font-size: 13px; }
.mr-range { flex: 1; accent-color: var(--accent); cursor: pointer; }
.mr-clock { font-size: 11px; color: var(--text-dim); min-width: 46px; text-align: center; font-variant-numeric: tabular-nums; }
.mr-speeds { display: flex; gap: 2px; }
.mr-speeds button {
  border: none; background: transparent; color: #8892a8;
  height: 22px; min-width: 34px; border-radius: 5px; cursor: pointer; font-size: 10px;
}
.mr-speeds button:hover { background: var(--ov-08); }
.mr-speeds button.on { background: rgba(232, 156, 61, 0.2); color: var(--accent); }
</style>
