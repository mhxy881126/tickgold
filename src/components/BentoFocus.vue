<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { useMarketFeeds } from "../composables/useMarketFeeds";

const emit = defineEmits<{ select: [code: string] }>();
const { radar, events, sectors } = useMarketFeeds();

const netYi = computed(() => (sectors.value.reduce((a, s) => a + s.netAmount, 0) / 1e8).toFixed(1));
const topIn = computed(() => [...sectors.value].sort((a, b) => b.netAmount - a.netAmount)[0]);
const topOut = computed(() => [...sectors.value].sort((a, b) => a.netAmount - b.netAmount)[0]);
const redSec = computed(() => sectors.value.filter((s) => s.changePct > 0).length);
const greenSec = computed(() => sectors.value.filter((s) => s.changePct < 0).length);

function hc(v: number) {
  return v >= 3 ? "#f23645" : v >= 1.5 ? "#ff7a45" : v >= 0.5 ? "#c9a24a"
    : v >= -0.5 ? "#5a6478" : v >= -1.5 ? "#12a876" : "#08db94";
}
function hhmm(t: number) {
  const d = new Date(t); const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

const gaugeEl = ref<HTMLElement | null>(null);
const heatEl = ref<HTMLElement | null>(null);
const distEl = ref<HTMLElement | null>(null);
let gauge: echarts.ECharts | null = null;
let heat: echarts.ECharts | null = null;
let dist: echarts.ECharts | null = null;

function renderGauge() {
  gauge?.setOption({
    series: [{
      type: "gauge", startAngle: 210, endAngle: -30, min: 0, max: 100, radius: "86%", center: ["50%", "58%"],
      progress: { show: true, width: 11, borderRadius: 6, itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
        { offset: 0, color: "#08db94" }, { offset: 0.55, color: "#e8c66a" }, { offset: 1, color: "#f23645" }]) } },
      axisLine: { lineStyle: { width: 11, color: [[1, "rgba(255,255,255,.07)"]] } },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      pointer: { show: false }, anchor: { show: false },
      detail: { formatter: (v: number) => String(Math.round(v)), valueAnimation: false, fontSize: 28, color: "#f0d68a", offsetCenter: ["0", "-4%"], fontWeight: 800 },
      title: { offsetCenter: ["0", "36%"], color: "#8b94a6", fontSize: 10.5 },
      data: [{ value: Math.round(radar.value?.sentiment ?? 0), name: radar.value?.mood ?? "情绪温度" }],
    }],
  });
}
function renderHeat() {
  heat?.setOption({
    series: [{
      type: "treemap", roam: false, nodeClick: false, breadcrumb: { show: false },
      itemStyle: { borderColor: "#0b0d11", borderWidth: 2, gapWidth: 2, borderRadius: 4 },
      label: { show: true, color: "#fff", fontSize: 10 },
      data: sectors.value.slice(0, 42).map((s) => ({
        name: s.name, value: Math.max(s.inAmount + s.outAmount, 1),
        label: { formatter: `${s.name} ${s.changePct >= 0 ? "+" : ""}${s.changePct.toFixed(1)}%` },
        itemStyle: { color: hc(s.changePct) },
      })),
    }],
  });
}
function renderDist() {
  const r = radar.value;
  const dl = ["涨停", "上涨", "平盘", "下跌", "跌停"];
  const dv = [
    r?.limitUp ?? 0,
    Math.max((r?.upCount ?? 0) - (r?.limitUp ?? 0), 0),
    r?.flatCount ?? 0,
    Math.max((r?.downCount ?? 0) - (r?.limitDown ?? 0), 0),
    r?.limitDown ?? 0,
  ];
  const cs = ["#f23645", "#e8828c", "#5a6478", "#12a876", "#08db94"];
  dist?.setOption({
    grid: { left: 36, right: 14, top: 12, bottom: 22 },
    tooltip: { trigger: "axis", formatter: (p: any) => `${dl[p[0].dataIndex]} : ${p[0].value} 家` },
    xAxis: { type: "category", data: dl, axisTick: { show: false },
      axisLine: { lineStyle: { color: "#262b38" } }, axisLabel: { color: "#8b94a6", fontSize: 10 } },
    yAxis: { type: "value", splitLine: { lineStyle: { color: "rgba(255,255,255,.05)" } }, axisLabel: { color: "#6b7589", fontSize: 9 } },
    series: [{ type: "bar", barWidth: "56%",
      data: dv.map((v, i) => ({ value: v, itemStyle: { color: cs[i], borderRadius: [3, 3, 0, 0] } })) }],
  });
}

// 聚焦放大
const focused = ref<string | null>(null);
function open(id: string) { if (!focused.value) focused.value = id; }
function close() { focused.value = null; }
watch(focused, async () => {
  await nextTick();
  [gauge, heat, dist].forEach((c) => c?.resize());
});

watch(radar, () => { renderGauge(); renderDist(); });
watch(sectors, renderHeat);

onMounted(async () => {
  await nextTick();
  if (gaugeEl.value) gauge = echarts.init(gaugeEl.value);
  if (heatEl.value) heat = echarts.init(heatEl.value);
  if (distEl.value) dist = echarts.init(distEl.value);
  renderGauge(); renderHeat(); renderDist();
});

onBeforeUnmount(() => {
  gauge?.dispose();
  heat?.dispose();
  dist?.dispose();
  gauge = heat = dist = null;
});
</script>

<template>
  <div class="bf">
    <div class="bento">
      <!-- 情绪环 -->
      <div class="bcard b-gauge" :class="{ focus: focused === 'gauge' }" @click="open('gauge')">
        <span class="xclose" @click.stop="close">×</span>
        <div class="card-h"><span class="bar"></span>情绪环</div>
        <div class="card-b"><div ref="gaugeEl" class="full"></div></div>
      </div>
      <!-- 涨停统计 -->
      <div class="bcard b-lim" :class="{ focus: focused === 'lim' }" @click="open('lim')">
        <span class="xclose" @click.stop="close">×</span>
        <div class="card-h"><span class="bar"></span>涨停统计</div>
        <div class="card-b lim-stat">
          <div><b class="up">{{ radar?.limitUp ?? 0 }}</b><span>涨停</span></div>
          <div><b class="down">{{ radar?.limitDown ?? 0 }}</b><span>跌停</span></div>
          <div><b class="flat">{{ radar?.broken ?? 0 }}</b><span>炸板</span></div>
          <div><b class="up">{{ Math.round(100 - (radar?.brokenRate ?? 0)) }}%</b><span>封板率</span></div>
        </div>
      </div>
      <!-- 主力资金 -->
      <div class="bcard b-fund" :class="{ focus: focused === 'fund' }" @click="open('fund')">
        <span class="xclose" @click.stop="close">×</span>
        <div class="card-h"><span class="bar"></span>主力资金</div>
        <div class="card-b fund-mini">
          <div class="big up">{{ netYi }}<span>亿</span></div>
          <div class="row"><span>领涨</span><b class="up">{{ topIn?.name ?? '—' }}</b></div>
          <div class="row"><span>领跌</span><b class="down">{{ topOut?.name ?? '—' }}</b></div>
          <div class="row"><span>红/绿板块</span><b>{{ redSec }} / {{ greenSec }}</b></div>
        </div>
      </div>
      <!-- 异动流 -->
      <div class="bcard b-feed" :class="{ focus: focused === 'feed' }" @click="open('feed')">
        <span class="xclose" @click.stop="close">×</span>
        <div class="card-h"><span class="bar"></span>异动流</div>
        <div class="card-b scroll feed">
          <div v-for="(e,i) in events.slice(0,40)" :key="e.time+e.code+i" class="fi" @click.stop="emit('select', e.code)">
            <span class="t">{{ hhmm(e.time) }}</span>
            <span class="lb" :class="e.tone">{{ e.label }}</span>
            <span class="nm">{{ e.name }}</span>
            <span class="pc" :class="e.tone">{{ (e.pct>=0?'+':'')+e.pct.toFixed(1) }}%</span>
          </div>
          <div v-if="events.length===0" class="loading">暂无异动</div>
        </div>
      </div>
      <!-- 板块热力 -->
      <div class="bcard b-heat" :class="{ focus: focused === 'heat' }" @click="open('heat')">
        <span class="xclose" @click.stop="close">×</span>
        <div class="card-h"><span class="bar"></span>板块热力图</div>
        <div class="card-b"><div ref="heatEl" class="full"></div></div>
      </div>
      <!-- 涨跌分布 -->
      <div class="bcard b-dist" :class="{ focus: focused === 'dist' }" @click="open('dist')">
        <span class="xclose" @click.stop="close">×</span>
        <div class="card-h"><span class="bar"></span>涨跌分布</div>
        <div class="card-b"><div ref="distEl" class="full"></div></div>
      </div>
    </div>
    <div v-if="focused" class="mask" @click="close"></div>
  </div>
</template>

<style scoped>
.bf { height:100%;min-height:0; }
.bento { height:100%;display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(3,1fr);gap:10px; }
.bcard { position:relative;display:flex;flex-direction:column;min-height:0;min-width:0;
  background:var(--bg-card,#15181f);border:1px solid var(--border,#262b38);border-radius:12px;overflow:hidden;
  box-shadow:0 6px 20px rgba(0,0,0,.28);cursor:pointer;
  transition:transform .28s cubic-bezier(.2,.8,.2,1),box-shadow .28s,border-color .28s; }
.bcard:hover { transform:translateY(-3px);border-color:#e8c66a;box-shadow:0 14px 32px rgba(0,0,0,.55); }
.b-gauge{grid-column:1;grid-row:1/span 2;}
.b-lim{grid-column:2;grid-row:1;}
.b-fund{grid-column:3;grid-row:1;}
.b-feed{grid-column:4;grid-row:1/span 3;}
.b-heat{grid-column:2/span 2;grid-row:2;}
.b-dist{grid-column:1/span 3;grid-row:3;}
.bcard.focus{position:fixed;z-index:60;inset:26px;cursor:default;animation:pop .3s cubic-bezier(.2,.8,.2,1);}
.bcard.focus:hover{transform:none;}
@keyframes pop{from{transform:scale(.82);opacity:.3;}to{transform:scale(1);opacity:1;}}
.mask{position:fixed;inset:0;z-index:55;background:rgba(0,0,0,.62);backdrop-filter:blur(3px);animation:fadeIn .25s;}
@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}
.xclose{display:none;position:absolute;top:7px;right:9px;z-index:5;width:22px;height:22px;align-items:center;justify-content:center;
  border-radius:7px;background:rgba(0,0,0,.5);color:#fff;cursor:pointer;font-size:13px;}
.bcard.focus .xclose{display:flex;}
.card-h{display:flex;align-items:center;gap:7px;height:31px;flex-shrink:0;padding:0 10px;font-size:12px;font-weight:700;border-bottom:1px solid var(--border);}
.card-h .bar{width:3px;height:12px;border-radius:2px;background:#e8c66a;}
.card-b{flex:1;min-height:0;padding:8px;}
.full{width:100%;height:100%;}
.scroll{overflow-y:auto;scrollbar-width:thin;} .scroll::-webkit-scrollbar{width:5px;} .scroll::-webkit-scrollbar-thumb{background:#2a3344;border-radius:3px;}
.lim-stat{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;align-content:center;}
.lim-stat div{display:flex;flex-direction:column;align-items:center;gap:1px;}
.lim-stat b{font-size:18px;font-variant-numeric:tabular-nums;} .lim-stat span{font-size:9.5px;color:var(--text-dim);}
.fund-mini{display:flex;flex-direction:column;justify-content:center;}
.fund-mini .big{font-size:25px;font-variant-numeric:tabular-nums;font-weight:800;} .fund-mini .big span{font-size:12px;font-weight:600;margin-left:3px;}
.fund-mini .row{display:flex;justify-content:space-between;font-size:10.5px;color:var(--text-dim);margin-top:7px;}
.fund-mini .row b{font-size:10.5px;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.feed .fi{display:flex;align-items:center;gap:6px;padding:4px 5px;border-radius:6px;font-size:10px;cursor:pointer; }
.feed .fi:hover{background:rgba(255,255,255,.04);}
.fi .t{color:var(--text-dim);font-variant-numeric:tabular-nums;}
.fi .lb{font-size:9px;padding:1px 5px;border-radius:4px;flex-shrink:0;}
.fi .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fi .pc{margin-left:auto;font-variant-numeric:tabular-nums;flex-shrink:0;}
.lb.up,.pc.up{color:#ff8a93;} .lb.up{background:rgba(242,54,69,.15);}
.lb.down,.pc.down{color:#2fe6ac;} .lb.down{background:rgba(8,219,148,.13);}
.lb.neutral,.pc.neutral{color:#e6c878;} .lb.neutral{background:rgba(201,162,74,.15);}
.loading{color:var(--text-dim);font-size:10px;text-align:center;padding:20px;}
.up{color:#f25266;} .down{color:#22b573;} .flat{color:#f0a23a;}
</style>
