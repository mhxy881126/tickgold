<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { invoke } from "@tauri-apps/api/core";
import { fetchMinute, fetchKLine, fetchDepthEnhance } from "../api/market";
import { pluginL2Providers, pluginL2Book, type L2ProviderInfo } from "../plugin/api";
import { useQuotesStore } from "../stores/quotes";
import { useWatchlistStore } from "../stores/watchlist";
import type { KBar, OrderBook, DepthEnhance } from "../api/types";
import AnimatedNumber from "./common/AnimatedNumber.vue";

const props = defineProps<{
  code: string;
  view: "m" | "k" | "o";
  link?: boolean;
}>();
const emit = defineEmits<{ select: [code: string] }>();

const quotes = useQuotesStore();
const wl = useWatchlistStore();
const quote = computed(() => quotes.map[props.code]);
const name = computed(() => quote.value?.name ?? wl.nameOf(props.code) ?? props.code);

const minute = ref<KBar[]>([]);
const kline = ref<KBar[]>([]);
const ob = ref<OrderBook | null>(null);
const got = new Set<string>();

// ===== v2.32 Level-2 插件盘口：有数据源则升级免费五档为十档，失败安全降级 =====
const l2Sources = ref<L2ProviderInfo[]>([]);
const l2Using = ref<L2ProviderInfo | null>(null); // 当前成功出数的源（null=免费五档）
let l2Discovered = false;
async function discoverL2() {
  if (l2Discovered) return;
  l2Discovered = true;
  try {
    l2Sources.value = await pluginL2Providers();
  } catch {
    l2Sources.value = [];
  }
}
async function tryL2Upgrade() {
  await discoverL2();
  // 只自动选用已配置 Key 的第一个源；其余留给后续手动切换。
  const src = l2Sources.value.find((s) => s.keySet && s.providers.length);
  if (!src) return;
  try {
    const book = await pluginL2Book(src.pluginId, props.code, src.providers[0]);
    ob.value = book;
    l2Using.value = src;
  } catch {
    // 保留免费五档，不打扰用户
    l2Using.value = null;
  }
}

// ===== 分时数据同 code 共享：10s 内复用同一 promise，避免多格/刷新并发风暴 =====
const minuteCache = new Map<string, { at: number; p: Promise<KBar[]> }>();
function fetchMinuteShared(code: string): Promise<KBar[]> {
  const hit = minuteCache.get(code);
  if (hit && Date.now() - hit.at < 10000) return hit.p;
  const p = fetchMinute(code)
    .then((d) => {
      minuteCache.set(code, { at: Date.now(), p: Promise.resolve(d) });
      return d;
    })
    .catch((e) => {
      minuteCache.delete(code);
      throw e;
    });
  minuteCache.set(code, { at: Date.now(), p });
  return p;
}

async function ensure(kind: string) {
  if (got.has(kind)) return;
  got.add(kind);
  try {
    if (kind === "m") minute.value = await fetchMinuteShared(props.code);
    else if (kind === "k") kline.value = await fetchKLine(props.code, 101, 180);
    else {
      ob.value = await invoke<OrderBook>("get_orderbook", { code: props.code });
      void tryL2Upgrade(); // 有 Level-2 插件则后台升级为十档，失败保留五档
    }
  } catch {
    got.delete(kind);
  }
}

// ETF 折溢价率 = (价格-IOPV)/IOPV*100
function etfPremium(o: OrderBook): number {
  return o.iopv ? ((o.price - o.iopv) / o.iopv) * 100 : 0;
}
function etfPremiumCls(o: OrderBook): string {
  const v = etfPremium(o);
  return v > 0.005 ? "up" : v < -0.005 ? "down" : "flat";
}

// ===== v2.32 盘口增强子页 =====
type ObTab = "depth" | "dist" | "auction" | "seal";
const obTab = ref<ObTab>("depth");
const enh = ref<DepthEnhance | null>(null);
const enhLoading = ref(false);
let enhLoaded = false;
const enhEl = ref<HTMLElement | null>(null);
let enhChart: echarts.ECharts | null = null;

async function loadEnhance(force = false) {
  if ((enhLoaded && !force) || enhLoading.value) return;
  enhLoading.value = true;
  try {
    enh.value = await fetchDepthEnhance(props.code);
    enhLoaded = true;
  } finally {
    enhLoading.value = false;
  }
  await nextTick();
  renderEnhance();
}

function switchObTab(t: ObTab) {
  obTab.value = t;
  if (t !== "depth") void loadEnhance();
  nextTick(renderEnhance);
}

function distOption() {
  const rows = [...(enh.value?.priceDist ?? [])].sort((a, b) => a.price - b.price);
  return {
    animation: false,
    grid: { left: 56, right: 18, top: 26, bottom: 28 },
    title: { text: "分价成交分布（当日累计·手）", left: 8, top: 4,
      textStyle: { color: "#8a93a5", fontSize: 11, fontWeight: 400 } },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { data: ["主动买", "主动卖"], top: 4, right: 8,
      textStyle: { color: "#8a93a5", fontSize: 10 } },
    xAxis: { type: "value", axisLabel: { color: "#8a93a5", fontSize: 10 },
      splitLine: { lineStyle: { color: "rgba(255,255,255,.05)" } } },
    yAxis: { type: "category", data: rows.map((r) => r.price.toFixed(2)),
      axisLabel: { color: "#8a93a5", fontSize: 9, interval: Math.max(0, Math.floor(rows.length / 18)) },
      axisTick: { show: false } },
    series: [
      { name: "主动买", type: "bar", stack: "v", data: rows.map((r) => r.buyVol), itemStyle: { color: "#f23645" } },
      { name: "主动卖", type: "bar", stack: "v", data: rows.map((r) => -r.sellVol), itemStyle: { color: "#08db94" } },
    ],
  };
}

function auctionOption() {
  const rows = enh.value?.auction ?? [];
  const base = ob.value?.prevClose ?? 0;
  return {
    animation: false,
    grid: { left: 52, right: 52, top: 30, bottom: 30 },
    title: { text: "集合竞价虚拟量（09:15–09:25，量单位手）", left: 8, top: 4,
      textStyle: { color: "#8a93a5", fontSize: 11, fontWeight: 400 } },
    tooltip: { trigger: "axis" },
    legend: { data: ["虚拟参考价", "累计虚拟匹配量"], top: 4, right: 8,
      textStyle: { color: "#8a93a5", fontSize: 10 } },
    xAxis: { type: "category", boundaryGap: false, data: rows.map((r) => r.time.slice(0, 5)),
      axisLabel: { color: "#8a93a5", fontSize: 10 } },
    yAxis: [
      { type: "value", scale: true, name: "价", nameTextStyle: { color: "#8a93a5", fontSize: 9 },
        axisLabel: { color: "#8a93a5", fontSize: 10 }, splitLine: { lineStyle: { color: "rgba(255,255,255,.05)" } } },
      { type: "value", name: "量", nameTextStyle: { color: "#8a93a5", fontSize: 9 },
        axisLabel: { color: "#8a93a5", fontSize: 10 }, splitLine: { show: false } },
    ],
    series: [
      { name: "虚拟参考价", type: "line", data: rows.map((r) => r.price), showSymbol: false,
        lineStyle: { width: 1.5, color: "#ffd24d" },
        markLine: base ? { symbol: "none", silent: true, data: [{ yAxis: base }],
          lineStyle: { color: "#8a93a5", type: "dashed" }, label: { show: false } } : undefined },
      { name: "累计虚拟匹配量", type: "bar", yAxisIndex: 1, data: rows.map((r) => r.matchVol),
        itemStyle: { color: "rgba(93,184,255,.55)" } },
    ],
  };
}

function sealOption() {
  const rows = enh.value?.sealTrend ?? [];
  return {
    animation: false,
    grid: { left: 60, right: 18, top: 30, bottom: 30 },
    title: { text: "涨停封单额趋势（元）", left: 8, top: 4,
      textStyle: { color: "#8a93a5", fontSize: 11, fontWeight: 400 } },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => (v >= 1e8 ? (v / 1e8).toFixed(2) + "亿" : (v / 1e4).toFixed(0) + "万") },
    xAxis: { type: "category", boundaryGap: false, data: rows.map((r) => r.time),
      axisLabel: { color: "#8a93a5", fontSize: 10 } },
    yAxis: { type: "value", axisLabel: { color: "#8a93a5", fontSize: 10,
        formatter: (v: number) => (v >= 1e8 ? (v / 1e8).toFixed(1) + "亿" : (v / 1e4).toFixed(0) + "万") },
      splitLine: { lineStyle: { color: "rgba(255,255,255,.05)" } } },
    series: [{ type: "line", data: rows.map((r) => r.fund), showSymbol: true, symbolSize: 4,
      lineStyle: { width: 1.6, color: "#f23645" }, itemStyle: { color: "#f23645" },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: "#f2364544" }, { offset: 1, color: "#f2364500" }]) } }],
  };
}

function enhEmpty(): boolean {
  if (!enh.value) return false;
  if (obTab.value === "dist") return enh.value.priceDist.length === 0;
  if (obTab.value === "auction") return enh.value.auction.length === 0;
  if (obTab.value === "seal") return enh.value.sealTrend.length === 0;
  return false;
}

function renderEnhance() {
  if (obTab.value === "depth" || !enhEl.value) return;
  if (!enhChart) enhChart = echarts.init(enhEl.value);
  if (obTab.value === "dist") enhChart.setOption(distOption(), true);
  else if (obTab.value === "auction") enhChart.setOption(auctionOption(), true);
  else enhChart.setOption(sealOption(), true);
}

const focus = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const miniEl = ref<HTMLElement | null>(null);
const bigEl = ref<HTMLElement | null>(null);
let mini: echarts.ECharts | null = null;
let big: echarts.ECharts | null = null;

function minuteColor(d: KBar[]) {
  if (d.length < 2) return "#f23645";
  return d[d.length - 1].close >= d[0].open ? "#f23645" : "#08db94";
}
function ma(data: KBar[], n: number) {
  return data.map((_, i) =>
    i < n - 1 ? null
    : +(data.slice(i - n + 1, i + 1).reduce((a, b) => a + b.close, 0) / n).toFixed(2));
}

// ===== 迷你图（link 开启时叠加静默 axisPointer，供多格时间轴联动）=====
function linkAxis() {
  return props.link
    ? {
        tooltip: {
          trigger: "axis", showContent: false,
          axisPointer: { type: "line", lineStyle: { color: "rgba(255,255,255,.4)", width: 1 } },
        },
        xAxisPointer: { label: { show: false } },
      }
    : { tooltip: undefined, xAxisPointer: undefined };
}
function miniMinute() {
  const d = minute.value, c = minuteColor(d), L = linkAxis();
  return {
    animation: false, grid: { left: 2, right: 2, top: 3, bottom: 2 },
    tooltip: L.tooltip,
    xAxis: { type: "category", show: false, boundaryGap: false, data: d.map((_, i) => i),
      axisPointer: L.xAxisPointer },
    yAxis: { type: "value", show: false, scale: true },
    series: [{ type: "line", data: d.map((b) => b.close), showSymbol: false,
      lineStyle: { width: 1.2, color: c },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: c + "55" }, { offset: 1, color: c + "00" }]) } }],
  };
}
function miniK() {
  const d = kline.value, L = linkAxis();
  return {
    animation: false, grid: { left: 2, right: 2, top: 3, bottom: 2 },
    tooltip: L.tooltip,
    xAxis: { type: "category", show: false, data: d.map((_, i) => i),
      axisPointer: L.xAxisPointer },
    yAxis: { type: "value", show: false, scale: true },
    series: [{ type: "candlestick", data: d.map((b) => [b.open, b.close, b.low, b.high]),
      itemStyle: { color: "#f23645", color0: "#08db94", borderColor: "#f23645", borderColor0: "#08db94" } }],
  };
}
function bigMinute() {
  const d = minute.value, c = minuteColor(d), base = ob.value?.prevClose ?? d[0]?.open;
  return {
    animation: false,
    grid: { left: 48, right: 16, top: 30, bottom: 30 },
    tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
    xAxis: { type: "category", boundaryGap: false, data: d.map((b) => fmtTs(b.timestamp)),
      axisLabel: { color: "#8a93a5", fontSize: 10, interval: Math.floor(d.length / 6) } },
    yAxis: { type: "value", scale: true,
      axisLabel: { color: "#8a93a5", fontSize: 10 }, splitLine: { lineStyle: { color: "rgba(255,255,255,.05)" } } },
    series: [{ type: "line", data: d.map((b) => b.close), showSymbol: false,
      lineStyle: { width: 1.5, color: c },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: c + "44" }, { offset: 1, color: c + "00" }]) },
      markLine: base ? { symbol: "none", silent: true, data: [{ yAxis: base }],
        lineStyle: { color: "#8a93a5", type: "dashed", width: 1 }, label: { show: false } } : undefined }],
  };
}
function bigK() {
  const d = kline.value;
  return {
    animation: false,
    legend: { data: ["MA5", "MA10", "MA20"], textStyle: { color: "#8a93a5", fontSize: 10 }, top: 4 },
    grid: [{ left: 48, right: 16, top: 30, height: "58%" }, { left: 48, right: 16, top: "76%", height: "16%" }],
    tooltip: { trigger: "axis", axisPointer: { type: "cross" } },
    xAxis: [
      { type: "category", data: d.map((b) => fmtDay(b.timestamp)), axisLabel: { color: "#8a93a5", fontSize: 10 },
        axisLine: { lineStyle: { color: "#2a3344" } } },
      { type: "category", gridIndex: 1, data: d.map((b) => ""), axisLabel: { show: false } },
    ],
    yAxis: [
      { scale: true, axisLabel: { color: "#8a93a5", fontSize: 10 }, splitLine: { lineStyle: { color: "rgba(255,255,255,.05)" } } },
      { gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
    ],
    series: [
      { name: "K", type: "candlestick", data: d.map((b) => [b.open, b.close, b.low, b.high]),
        itemStyle: { color: "#f23645", color0: "#08db94", borderColor: "#f23645", borderColor0: "#08db94" } },
      { name: "MA5", type: "line", data: ma(d, 5), showSymbol: false, lineStyle: { width: 1, color: "#ffd24d" } },
      { name: "MA10", type: "line", data: ma(d, 10), showSymbol: false, lineStyle: { width: 1, color: "#b07dff" } },
      { name: "MA20", type: "line", data: ma(d, 20), showSymbol: false, lineStyle: { width: 1, color: "#5db8ff" } },
      { name: "VOL", type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: d.map((b) => b.volume),
        itemStyle: { color: (p: any) => (d[p.dataIndex].close >= d[p.dataIndex].open ? "#f23645" : "#08db94") } },
    ],
  };
}

function fmtTs(t: number) {
  const d = new Date(t); const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDay(t: number) {
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function apply() {
  await ensure(props.view);
  if (props.view === "o") return;
  if (mini && miniEl.value) {
    mini.setOption(props.view === "m" ? miniMinute() : miniK(), true);
  }
  if (focus.value && big && bigEl.value) {
    big.setOption(props.view === "m" ? bigMinute() : bigK(), true);
  }
}

function openFocus() {
  focus.value = true;
}
async function closeFocus() {
  focus.value = false;
}

watch(() => props.view, () => nextTick(apply));
watch(() => props.link, () => nextTick(apply));
watch(focus, async (f) => {
  if (f) {
    await nextTick();
    if (bigEl.value && !big) big = echarts.init(bigEl.value);
    if (props.view === "m") await ensure("o"); // 取昨收
    apply();
  }
});

// ===== 迷你分时实时增量刷新：15s 节流，仅分时/普通态/页面可见/格子在屏 =====
const onScreen = ref(true);
let io: IntersectionObserver | null = null;
let liveTimer: number | null = null;
async function liveRefresh() {
  if (props.view !== "m" || focus.value) return;
  if (document.visibilityState !== "visible" || !onScreen.value) return;
  try {
    const d = await fetchMinuteShared(props.code);
    minute.value = d;
    if (mini && miniEl.value && props.view === "m" && !focus.value)
      mini.setOption(miniMinute(), true);
  } catch {
    /* ignore */
  }
}

onMounted(async () => {
  await nextTick();
  if (miniEl.value) {
    mini = echarts.init(miniEl.value);
    mini.group = "mg"; // 加入联动组
  }
  apply();
  echarts.connect("mg");

  // 格子是否真正在屏（卡片未展示 / 布局外不请求）
  io = new IntersectionObserver(
    (entries) => { onScreen.value = entries[0]?.isIntersecting ?? true; },
    { threshold: 0.05 },
  );
  if (rootEl.value) io.observe(rootEl.value);
  liveTimer = window.setInterval(liveRefresh, 15000);
});

onBeforeUnmount(() => {
  mini?.dispose();
  big?.dispose();
  enhChart?.dispose();
  mini = big = null;
  enhChart = null;
  io?.disconnect();
  if (liveTimer) clearInterval(liveTimer);
});
</script>

<template>
  <div ref="rootEl" class="mcell" :class="{ focus }">
    <!-- 普通态 -->
    <template v-if="!focus">
      <div class="mc-h" @click="emit('select', code)">
        <span class="nm">{{ name }}</span>
        <span class="cd">{{ code }}</span>
        <AnimatedNumber tag="span" class="q" :class="(quote?.pct ?? 0) >= 0 ? 'up' : 'down'" :value="quote?.price ?? 0" kind="price" />
        <AnimatedNumber tag="span" class="q" :class="(quote?.pct ?? 0) >= 0 ? 'up' : 'down'" :value="quote?.pct ?? 0" kind="pct" />
      </div>
      <div class="mc-body" title="点击放大">
        <!-- 指标角标：量比（真实）；涨速 / 封单待 v2.25 数据接入后在此扩展 -->
        <div v-if="quote?.volumeRatio" class="mc-ind">量比 {{ quote.volumeRatio.toFixed(2) }}</div>
        <div v-show="view !== 'o'" ref="miniEl" class="mini"></div>
        <div v-if="view === 'o'" class="mini-ob">
          <template v-if="ob">
            <div v-for="(a, i) in ob.asks.slice(0,5).reverse()" :key="'a'+i" class="ob2 s">
              <span class="lb">卖{{ ob.asks.slice(0,5).length - i }}</span>
              <span class="pr">{{ a.price.toFixed(2) }}</span><span class="vl">{{ a.vol }}</span>
            </div>
            <div v-for="(b, i) in ob.bids.slice(0,5)" :key="'b'+i" class="ob2 b">
              <span class="lb">买{{ i+1 }}</span>
              <span class="pr">{{ b.price.toFixed(2) }}</span><span class="vl">{{ b.vol }}</span>
            </div>
            <div class="ob2-foot">
              委比 <b :class="ob.weiBi >= 0 ? 'up' : 'down'">{{ ob.weiBi >= 0 ? "+" : "" }}{{ ob.weiBi.toFixed(1) }}%</b>
              · 外 <b class="up">{{ Math.round(ob.outsideVol) }}</b>
              / 内 <b class="down">{{ Math.round(ob.insideVol) }}</b>
            </div>
            <!-- v2.32 品种专项 -->
            <div v-if="ob.convertPremium" class="ob2-foot spec">
              转股价值 <b>{{ ob.convertValue!.toFixed(2) }}</b>
              · 溢价 <b :class="ob.convertPremium >= 0 ? 'up' : 'down'">{{ ob.convertPremium!.toFixed(2) }}%</b>
            </div>
            <div v-else-if="ob.iopv" class="ob2-foot spec">
              IOPV <b>{{ ob.iopv!.toFixed(3) }}</b>
              · 折溢价 <b :class="etfPremiumCls(ob)">{{ etfPremium(ob).toFixed(2) }}%</b>
            </div>
          </template>
          <div v-else class="loading">加载盘口…</div>
        </div>
      </div>
    </template>

    <!-- 全屏放大 -->
    <template v-else>
      <div class="focus-mask" @click="closeFocus"></div>
      <div class="focus-card">
        <div class="fc-h">
          <span class="nm">{{ name }}</span><span class="cd">{{ code }}</span>
          <AnimatedNumber tag="span" class="q" :class="(quote?.pct ?? 0) >= 0 ? 'up':'down'" :value="quote?.price ?? 0" kind="price" />
          <AnimatedNumber tag="span" class="q" :class="(quote?.pct ?? 0) >= 0 ? 'up':'down'" :value="quote?.pct ?? 0" kind="pct" />
          <button class="x" @click="closeFocus">×</button>
        </div>
        <div v-show="view !== 'o'" ref="bigEl" class="big"></div>
        <div v-if="view === 'o'" class="big-ob">
          <div class="ob-tabs">
            <button type="button" :class="{ on: obTab === 'depth' }" @click="switchObTab('depth')">盘口</button>
            <button type="button" :class="{ on: obTab === 'dist' }" @click="switchObTab('dist')">分价成交</button>
            <button type="button" :class="{ on: obTab === 'auction' }" @click="switchObTab('auction')">竞价量</button>
            <button type="button" :class="{ on: obTab === 'seal' }" @click="switchObTab('seal')">封单额</button>
          </div>
          <div v-show="obTab === 'depth'" class="ob-pane">
          <template v-if="ob">
            <div class="bo-grid">
              <div v-for="(a,i) in [...ob.asks].reverse()" :key="'A'+i" class="bo-row s">
                <span>卖{{ ob.asks.length - i }}</span><b>{{ a.price.toFixed(2) }}</b><em>{{ a.vol }}</em>
              </div>
              <div class="bo-mid">现价 {{ ob.price.toFixed(2) }}</div>
              <div v-for="(b,i) in ob.bids" :key="'B'+i" class="bo-row b">
                <span>买{{ i+1 }}</span><b>{{ b.price.toFixed(2) }}</b><em>{{ b.vol }}</em>
              </div>
            </div>
            <div class="bo-depth">
              <div class="bd-item">
                <span class="bd-l">委比</span>
                <b :class="ob.weiBi >= 0 ? 'up' : 'down'">{{ ob.weiBi >= 0 ? "+" : "" }}{{ ob.weiBi.toFixed(2) }}%</b>
              </div>
              <div class="bd-item">
                <span class="bd-l">委差</span>
                <b :class="ob.weiCha >= 0 ? 'up' : 'down'">{{ ob.weiCha >= 0 ? "+" : "" }}{{ Math.round(ob.weiCha) }}</b>
              </div>
              <div class="bd-item">
                <span class="bd-l">{{ ob.bids.length }}档买</span><b class="up">{{ Math.round(ob.bidTotal) }}</b>
              </div>
              <div class="bd-item">
                <span class="bd-l">{{ ob.asks.length }}档卖</span><b class="down">{{ Math.round(ob.askTotal) }}</b>
              </div>
              <div class="bd-item">
                <span class="bd-l">外盘</span><b class="up">{{ Math.round(ob.outsideVol) }}</b>
              </div>
              <div class="bd-item">
                <span class="bd-l">内盘</span><b class="down">{{ Math.round(ob.insideVol) }}</b>
              </div>
            </div>
            <!-- v2.32 品种专项指标 -->
            <div v-if="ob.convertPremium" class="bo-depth">
              <div class="bd-item">
                <span class="bd-l">转股价值</span><b>{{ ob.convertValue!.toFixed(3) }}</b>
              </div>
              <div class="bd-item">
                <span class="bd-l">转股溢价率</span>
                <b :class="ob.convertPremium >= 0 ? 'up' : 'down'">{{ ob.convertPremium!.toFixed(2) }}%</b>
              </div>
            </div>
            <div v-else-if="ob.iopv" class="bo-depth">
              <div class="bd-item">
                <span class="bd-l">IOPV</span><b>{{ ob.iopv!.toFixed(3) }}</b>
              </div>
              <div class="bd-item">
                <span class="bd-l">折溢价率</span>
                <b :class="etfPremiumCls(ob)">{{ etfPremium(ob).toFixed(2) }}%</b>
              </div>
            </div>
            <div class="bo-info">
              开 {{ ob.open.toFixed(2) }} · 高 {{ ob.high.toFixed(2) }} · 低 {{ ob.low.toFixed(2) }}
              · 量 {{ ob.volume }} · 额 {{ (ob.amount/1e8).toFixed(2) }}亿
            </div>
            <div v-if="l2Using" class="bo-note l2">
              Level-2 {{ ob.asks.length }}档盘口（{{ l2Using.name }}，用户自带 Key）；数据口径与合规责任由数据源协议约定
            </div>
            <div v-else class="bo-note">免费五档盘口，非 Level-2；内外盘为累计主动成交（手）；专项指标以公开源返回为准</div>
          </template>
          <div v-else class="loading">加载盘口…</div>
          </div>
          <!-- v2.32 盘口增强子页 -->
          <div v-show="obTab !== 'depth'" class="ob-pane enh-pane">
            <div ref="enhEl" class="enh-chart"></div>
            <div v-if="enhLoading" class="loading">加载专项数据…</div>
            <div v-else-if="enhEmpty()" class="loading">公开源暂无该数据（源不支持 / 非交易时段 / 盘后）</div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mcell { display:flex; flex-direction:column; background:var(--bg-card,#0f141d);
  border:1px solid var(--border,#1e2738); border-radius:11px; overflow:hidden; min-width:0; min-height:0; }
.mc-h { height:30px;flex-shrink:0;display:flex;align-items:center;gap:7px;padding:0 9px;
  border-bottom:1px solid #17202e; }
.nm { font-size:11.5px;font-weight:700;cursor:pointer; } .cd { font-variant-numeric:tabular-nums;font-size:9.5px;color:var(--text-dim); }
.q { margin-left:auto;font-variant-numeric:tabular-nums;font-size:10.5px;font-weight:700; }
.mc-body { flex:1;min-height:0;position:relative;cursor:zoom-in; }
.mini { position:absolute;inset:0; }
.mc-ind { position:absolute;top:3px;left:5px;z-index:3;font-size:8.5px;color:var(--text-dim);
  background:rgba(0,0,0,.32);padding:1px 4px;border-radius:5px;font-variant-numeric:tabular-nums; }
.mini-ob { position:absolute;inset:0;padding:3px 6px;display:flex;flex-direction:column;justify-content:center;gap:0; }
.ob2 { display:flex;align-items:center;gap:6px;height:13px;font-size:9px; }
.ob2 .lb { color:var(--text-dim);width:26px;font-size:8.5px; }
.ob2 .pr { font-variant-numeric:tabular-nums;font-weight:600; }
.ob2 .vl { margin-left:auto;font-variant-numeric:tabular-nums;font-size:8.5px; }
.ob2.s .pr { color:#ff6b78; } .ob2.b .pr { color:#2fe6ac; }
.ob2-foot { margin-top:2px;font-size:8px;color:var(--text-dim);text-align:center;white-space:nowrap; }
.ob2-foot b { font-weight:700; } .ob2-foot .up { color:#ff6b78; } .ob2-foot .down { color:#2fe6ac; }
.loading { color:var(--text-dim);font-size:10px;text-align:center; }

/* 全屏 */
.focus-mask { position:fixed;inset:0;z-index:80;background:rgba(5,7,10,.72);backdrop-filter:blur(2px); }
.focus-card { position:fixed;z-index:81;inset:34px;display:flex;flex-direction:column;
  background:var(--bg-card,#0f141d);border:1px solid var(--border);border-radius:14px;overflow:hidden; }
.fc-h { height:40px;flex-shrink:0;display:flex;align-items:center;gap:10px;padding:0 14px;border-bottom:1px solid var(--border); }
.fc-h .nm { font-size:15px; } .fc-h .cd { font-size:11px; } .fc-h .q { font-size:13px; }
.x { margin-left:auto;width:30px;height:30px;border:0;border-radius:9px;background:rgba(0,0,0,.4);color:#fff;font-size:18px;cursor:pointer; }
.x:hover { background:#e23b45; }
.big { flex:1;min-height:0; }
.big-ob { flex:1;min-height:0;display:flex;flex-direction:column;padding:14px;gap:10px; }
.ob-tabs { display:flex;gap:6px;flex-shrink:0; }
.ob-tabs button { flex:1;height:26px;border:1px solid var(--border);border-radius:7px;
  background:rgba(255,255,255,.03);color:var(--text-dim);font-size:11px;cursor:pointer; }
.ob-tabs button.on { color:#fff;background:#2a3344;border-color:#3a475f; }
.ob-pane { flex:1;min-height:0;display:flex;flex-direction:column;gap:10px; }
.enh-pane { position:relative; }
.enh-chart { flex:1;min-height:0;width:100%; }
.bo-grid { flex:1;display:flex;flex-direction:column;justify-content:center; }
.bo-row { display:grid;grid-template-columns:60px 1fr 90px;align-items:center;height:26px;font-size:12px; }
.bo-row b { font-variant-numeric:tabular-nums; } .bo-row em { font-style:normal;text-align:right;font-variant-numeric:tabular-nums;color:var(--text-dim); }
.bo-row.s b { color:#ff6b78; } .bo-row.b b { color:#2fe6ac; }
.bo-mid { text-align:center;height:28px;line-height:28px;font-size:12px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin:3px 0; }
.bo-info { font-size:11px;color:var(--text-dim);text-align:center; }
.bo-depth {
  display:grid; grid-template-columns:repeat(3,1fr); gap:6px 14px;
  padding:10px 18px; border-radius:9px; background:rgba(255,255,255,.03);
}
.bd-item { display:flex; align-items:center; justify-content:space-between; font-size:11px; }
.bd-l { color:var(--text-dim); }
.bd-item b { font-variant-numeric:tabular-nums; }
.bd-item .up { color:#ff6b78; } .bd-item .down { color:#2fe6ac; }
.bo-note { font-size:10px;color:var(--text-dim);text-align:center;opacity:.75; }
.bo-note.l2 { color:var(--accent);opacity:.95; }
</style>
