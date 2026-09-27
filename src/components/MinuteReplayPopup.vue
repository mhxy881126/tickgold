<!--
  MinuteReplayPopup.vue —— 历史分时复盘弹窗（在主图双击日K蜡烛触发）
  能力：可拖拽 / 最大化 / 关闭；单日分时回放（播放、倍速、定位）；多日叠加对比；副图量能 / 量比。
  自包含独立的 klinecharts 实例与数据获取，不影响主图。
  依赖全局已注册指标（StockChart 模块初始化时注册）：sessionBg / AVG / yAnchor / thsLevels / minuteVR / multiMinute。
-->
<template>
  <Teleport to="body">
    <div
      v-if="popup.visible"
      class="mp-box"
      :class="{ max: popup.max }"
      :style="!popup.max ? { left: popup.box.left + 'px', top: popup.box.top + 'px', width: popup.box.width + 'px', height: popup.box.height + 'px' } : {}"
    >
      <div class="mp-title" @mousedown="popTitleDown">
        <span class="mp-tname">{{ popup.name }} · 历史分时复盘</span>
        <div class="mp-tbtns" @mousedown.stop>
          <button class="mp-btn" @click="popup.max = !popup.max" :title="popup.max ? '还原' : '最大化'">{{ popup.max ? "❐" : "▢" }}</button>
          <button class="mp-btn x" @click="closePopup">×</button>
        </div>
      </div>

      <!-- 工具行 -->
      <div class="mp-toolbar" @mousedown.stop>
        <button class="tb-btn" @click="shiftDay(-1)" title="上一交易日">◀</button>
        <span class="tb-date">{{ popup.date }}</span>
        <button class="tb-btn" @click="shiftDay(1)" title="下一交易日">▶</button>
        <span class="tb-sep"></span>
        <span class="tb-glabel">多日</span>
        <button
          v-for="n in [1,2,3,5]"
          :key="n"
          class="tb-btn chip"
          :class="{ on: overlayN === n }"
          @click="setOverlay(n)"
        >{{ n }}日</button>
        <span class="tb-sep"></span>
        <span class="tb-glabel">副图</span>
        <button class="tb-btn chip" :class="{ on: popSub === 'vol' }" @click="setPopSub('vol')">量能</button>
        <button class="tb-btn chip" :class="{ on: popSub === 'vr' }" @click="setPopSub('vr')">量比</button>
      </div>

      <div class="mp-hostwrap">
        <div ref="popupHost" class="mp-host"></div>
        <div v-if="overlayN > 1" class="mp-legend">
          <div v-for="it in legendItems" :key="it.date" class="lg-item">
            <i class="lg-dot" :style="{ background: it.color }"></i>
            <span>{{ it.date }}</span>
            <span :style="{ color: it.color }">{{ it.pct >= 0 ? "+" : "" }}{{ it.pct.toFixed(2) }}%</span>
          </div>
        </div>
        <div v-if="popupErr" class="mp-err">{{ popupErr }}</div>
      </div>

      <!-- 回放控制条（仅单日模式） -->
      <div v-if="overlayN === 1" class="mp-replay" @mousedown.stop>
        <button class="rp-btn" title="回到开盘" @click="replayTo(0)">⏮</button>
        <button class="rp-btn rp-play" @click="togglePlay">{{ playing ? "❚❚" : "▶" }}</button>
        <input
          class="rp-range"
          type="range"
          min="0"
          :max="rpMax"
          step="1"
          v-model.number="rpIndex"
          @input="onSeek"
        />
        <div class="rp-stats">
          <span class="rp-time">{{ rpTime }}</span>
          <span class="rp-px" :style="{ color: rpTone }">{{ rpPxText }}</span>
          <span class="rp-pct" :style="{ color: rpTone }">{{ rpPctText }}</span>
        </div>
        <div class="rp-speeds">
          <button
            v-for="s in [1,2,4,8]"
            :key="s"
            class="rp-btn chip"
            :class="{ on: playSpeed === s }"
            @click="playSpeed = s"
          >{{ s }}x</button>
        </div>
        <button class="rp-btn" title="跳到收盘" @click="replayTo(rpMax)">⏭</button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from "vue";
import { init, dispose, type Chart, type KLineData } from "klinecharts";
import { fetchHistMinuteDays, fetchKLine } from "../api/market";
import type { KBar } from "../api/types";
import { pad, hhmmUTC, toKData } from "../lib/chart";
import { UP, DOWN_K, FLAT, AVG_Y, line, buildStyles, type OverlayLine } from "../lib/chart-styles";

const props = defineProps<{ code: string; name: string }>();

interface HistDay { date: string; bars: KBar[]; prevClose: number }

const popup = ref({
  visible: false, name: "", date: "", max: false,
  box: { left: 150, top: 80, width: 880, height: 580 },
});
const popupHost = ref<HTMLElement | null>(null);
let popupChart: Chart | null = null;
const popupErr = ref("");
const histDays = ref<HistDay[]>([]);
const dayIndex = ref(0);
const overlayN = ref(1);
const popSub = ref<"vol" | "vr">("vol");
const OVERLAY_COLORS = ["#ff7a3d", "#c060ff", "#19c3ff", "#ffd028"];

const dayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};

async function openPopup(kd: KLineData) {
  popupErr.value = "";
  popup.value.visible = true;
  popup.value.name = props.name;
  histDays.value = []; dayIndex.value = 0; overlayN.value = 1; popSub.value = "vol";
  await nextTick();
  try {
    const [days, kbars] = await Promise.all([
      fetchHistMinuteDays(props.code, 5),
      fetchKLine(props.code, 101, 10),
    ]);
    // 日 K 升序；每日昨收 = 前一交易日收盘
    const ks = [...kbars].sort((a, b) => a.timestamp - b.timestamp);
    const prevMap = new Map<string, number>();
    ks.forEach((b, i) => prevMap.set(dayKey(b.timestamp), i > 0 ? ks[i - 1].close : b.open));
    histDays.value = days.map((d) => ({
      date: d.date,
      bars: d.bars,
      prevClose: prevMap.get(d.date) ?? d.bars[0]?.close ?? 0,
    }));
    const di = histDays.value.findIndex((d) => d.date === dayKey(kd.timestamp));
    dayIndex.value = di >= 0 ? di : 0;
  } catch (e: any) {
    popupErr.value = e?.message || String(e);
  }
  popup.value.date = histDays.value[dayIndex.value]?.date ?? "";
  renderPopup();
}

const curDay = computed(() => histDays.value[dayIndex.value]);

const barsMap = (bars: KBar[]) => {
  const m: Record<string, number> = {};
  bars.forEach((b) => { m[hhmmUTC(b.timestamp)] = b.close; });
  return m;
};

// 弹窗副图：量能 VOL / 分时量比 minuteVR
function addPopupSub(pc: Chart, day: HistDay) {
  if (popSub.value === "vol") {
    pc.createIndicator("VOL", false, { height: 80 });
    return;
  }
  // 量比基准：除当日外其他交易日（最多 4 个）同时段均量
  const refs = histDays.value.filter((_, i) => i !== dayIndex.value).slice(0, 4);
  if (!refs.length) { pc.createIndicator("VOL", false, { height: 80 }); return; }
  const sums: Record<string, { s: number; n: number }> = {};
  refs.forEach((d) => d.bars.forEach((b) => {
    const k = hhmmUTC(b.timestamp);
    sums[k] = sums[k] || { s: 0, n: 0 };
    sums[k].s += b.volume; sums[k].n += 1;
  }));
  const base: Record<string, number> = {};
  Object.keys(sums).forEach((k) => { base[k] = sums[k].s / sums[k].n; });
  pc.createIndicator({ name: "minuteVR", extendData: base } as any, false, { height: 80 });
}

function renderPopup() {
  if (!popupHost.value) return;
  stopPlay();
  if (popupChart) { dispose(popupChart); popupChart = null; }
  const day = histDays.value[dayIndex.value];
  if (!day) return;
  popupChart = init(popupHost.value);
  if (!popupChart) return;
  const pc: Chart = popupChart;
  pc.setTimezone("UTC");
  pc.setPriceVolumePrecision(2, 0);
  pc.setStyles(buildStyles(true, overlayN.value > 1));
  pc.createIndicator("sessionBg", true, { id: "candle_pane" });
  pc.applyNewData(toKData(day.bars));
  // 全天分时铺满：每根 bar 空间按容器宽/根数自适应（回放截断时数据从左向右增长）
  const popW = popupHost.value.clientWidth;
  pc.setBarSpace(Math.max(1.2, popW / (day.bars.length + 2)));
  pc.scrollToRealTime();

  if (overlayN.value === 1) {
    pc.createIndicator({ name: "AVG", styles: { lines: [line(AVG_Y)] } } as any, false, { id: "candle_pane" });
    pc.createIndicator({ name: "yAnchor", extendData: { prevClose: day.prevClose } } as any, true, { id: "candle_pane" });
    pc.createIndicator({ name: "thsLevels", extendData: { prevClose: day.prevClose } } as any, true, { id: "candle_pane" });
    addPopupSub(pc, day);
    rpMax.value = day.bars.length - 1;
    rpIndex.value = rpMax.value;
  } else {
    let start = dayIndex.value;
    if (start + overlayN.value > histDays.value.length) start = Math.max(0, histDays.value.length - overlayN.value);
    const part: HistDay[] = histDays.value.slice(start, start + overlayN.value);
    const lines: OverlayLine[] = part.map((d, i) => ({
      color: i === 0 ? "#ffffff" : OVERLAY_COLORS[i - 1],
      bold: i === 0,
      prevClose: d.prevClose,
      map: barsMap(d.bars),
    }));
    let lo = Infinity, hi = -Infinity;
    part.forEach((d) => d.bars.forEach((b) => {
      lo = Math.min(lo, b.low, d.prevClose);
      hi = Math.max(hi, b.high, d.prevClose);
    }));
    pc.createIndicator({ name: "yAnchor", extendData: { lo, hi } } as any, true, { id: "candle_pane" });
    pc.overrideIndicator({ name: "sessionBg", extendData: { lines } } as any, "candle_pane");
    pc.createIndicator({ name: "thsLevels", extendData: { prevClose: day.prevClose } } as any, true, { id: "candle_pane" });
    addPopupSub(pc, day);
  }
  pc.resize();
}

// 工具行动作
function shiftDay(delta: number) {
  const ni = dayIndex.value + delta;
  if (ni < 0 || ni >= histDays.value.length) return;
  dayIndex.value = ni;
  popup.value.date = histDays.value[ni].date;
  renderPopup();
}
function setOverlay(n: number) {
  if (overlayN.value === n) return;
  overlayN.value = n;
  renderPopup();
}
function setPopSub(m: "vol" | "vr") {
  if (popSub.value === m) return;
  popSub.value = m;
  renderPopup();
}

// 图例（叠加模式）
const legendItems = computed(() => {
  const day = curDay.value;
  if (!day) return [];
  const endPct = (d: HistDay) =>
    d.prevClose > 0 ? (d.bars[d.bars.length - 1].close - d.prevClose) / d.prevClose * 100 : 0;
  const items: { date: string; color: string; pct: number }[] = [
    { date: day.date, color: "#ffffff", pct: endPct(day) },
  ];
  for (let k = 0; k < overlayN.value - 1; k++) {
    const d2 = histDays.value[dayIndex.value + 1 + k];
    if (d2) items.push({ date: d2.date, color: OVERLAY_COLORS[k], pct: endPct(d2) });
  }
  return items;
});

// ===== 回放控制 =====
const playing = ref(false);
const rpIndex = ref(0);
const rpMax = ref(0);
const playSpeed = ref(1);
let playTimer = 0;

const rpTime = computed(() => {
  const b = curDay.value?.bars[rpIndex.value];
  return b ? hhmmUTC(b.timestamp) : "--:--";
});
const rpPxText = computed(() => curDay.value?.bars[rpIndex.value]?.close.toFixed(2) ?? "--");
const rpPctText = computed(() => {
  const day = curDay.value, b = day?.bars[rpIndex.value];
  if (!day || !b || !(day.prevClose > 0)) return "--";
  const p = (b.close - day.prevClose) / day.prevClose * 100;
  return (p >= 0 ? "+" : "") + p.toFixed(2) + "%";
});
const rpTone = computed(() => {
  const day = curDay.value, b = day?.bars[rpIndex.value];
  if (!day || !b) return FLAT;
  const c = b.close - day.prevClose;
  return c > 0 ? UP : c < 0 ? DOWN_K : FLAT;
});

// 定位：只渲染到第 i 根（指标自动重算）
function onSeek() {
  if (!popupChart || !curDay.value) return;
  const i = Math.max(0, Math.min(rpIndex.value, rpMax.value));
  popupChart.applyNewData(toKData(curDay.value.bars.slice(0, i + 1)));
}
function togglePlay() {
  if (playing.value) { stopPlay(); return; }
  playing.value = true;
  if (rpIndex.value >= rpMax.value) { rpIndex.value = -1; onSeek(); }
  playTimer = window.setInterval(() => {
    const i = rpIndex.value + 1;
    if (i >= rpMax.value) {
      rpIndex.value = rpMax.value; onSeek(); stopPlay(); return;
    }
    rpIndex.value = i; onSeek();
  }, Math.max(15, Math.round(120 / playSpeed.value)));
}
function stopPlay() {
  playing.value = false;
  if (playTimer) { window.clearInterval(playTimer); playTimer = 0; }
}
function replayTo(i: number) {
  stopPlay();
  rpIndex.value = Math.max(0, Math.min(i, rpMax.value));
  onSeek();
}
// 倍速在播放中切换时重启定时器
watch(playSpeed, () => {
  if (playing.value) { stopPlay(); togglePlay(); }
});

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
  stopPlay();
  popup.value.visible = false;
  if (popupChart) { dispose(popupChart); popupChart = null; }
}

// 组件卸载时兜底清理（弹窗仍打开而父组件销毁的场景）
onUnmounted(() => {
  stopPlay();
  window.removeEventListener("mousemove", popMove);
  window.removeEventListener("mouseup", popUp);
  if (popupChart) { dispose(popupChart); popupChart = null; }
});

defineExpose({ open: openPopup });
</script>

<style scoped>
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

/* 工具行 */
.mp-toolbar {
  display: flex; align-items: center; gap: 3px;
  padding: 5px 10px; border-bottom: 1px solid rgba(255,255,255,.08);
  background: rgba(255,255,255,.02);
}
.tb-btn {
  border: none; background: transparent; color: #aab1c0;
  height: 24px; min-width: 26px; padding: 0 8px; border-radius: 5px;
  cursor: pointer; font-size: 11px;
}
.tb-btn:hover { background: rgba(255,255,255,.08); color: #fff; }
.tb-btn.chip.on { background: rgba(255,50,50,.18); color: #ff8a8a; }
.tb-date {
  font-size: 11px; color: #d6dae3; min-width: 76px; text-align: center;
  font-variant-numeric: tabular-nums;
}
.tb-sep { width: 1px; height: 14px; background: rgba(255,255,255,.12); margin: 0 6px; }
.tb-glabel { font-size: 10px; color: #7b8294; margin-right: 2px; }

/* 叠加图例 */
.mp-legend {
  position: absolute; right: 8px; top: 8px; z-index: 5;
  display: flex; flex-direction: column; gap: 3px;
  background: rgba(12,14,20,.72); border: 1px solid rgba(255,255,255,.1);
  border-radius: 7px; padding: 6px 8px; font-size: 10px;
}
.lg-item { display: flex; align-items: center; gap: 6px; color: #c7ccd8; font-variant-numeric: tabular-nums; }
.lg-dot { width: 9px; height: 2px; display: inline-block; }

/* 回放控制条 */
.mp-replay {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 12px; border-top: 1px solid rgba(255,255,255,.08);
  background: rgba(255,255,255,.02);
}
.rp-btn {
  border: none; background: transparent; color: #aab1c0;
  height: 26px; min-width: 30px; padding: 0 8px; border-radius: 5px;
  cursor: pointer; font-size: 12px;
}
.rp-btn:hover { background: rgba(255,255,255,.08); color: #fff; }
.rp-btn.chip.on { background: rgba(255,50,50,.18); color: #ff8a8a; }
.rp-play { font-size: 14px; }
.rp-range { flex: 1; accent-color: #ff5050; cursor: pointer; }
.rp-stats {
  display: flex; gap: 10px; min-width: 200px; justify-content: flex-end;
  font-variant-numeric: tabular-nums; font-size: 11px;
}
.rp-time { color: #d6dae3; min-width: 44px; text-align: right; }
.rp-px { min-width: 56px; text-align: right; }
.rp-pct { min-width: 64px; text-align: right; }
.rp-speeds { display: flex; gap: 2px; }
</style>
