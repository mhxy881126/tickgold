<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { useMarketFeeds } from "../composables/useMarketFeeds";
import { fetchNewsFlash } from "../api/market";

const emit = defineEmits<{ select: [code: string] }>();
const { radar, events, sectors } = useMarketFeeds();

function hhmm(t: number) {
  const d = new Date(t); const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 三列电报（按序轮播分栏）
const cols = computed(() => [0, 1, 2].map((c) => events.value.filter((_, i) => i % 3 === c)));
const durations = [34, 44, 54];

// 快讯
const newsText = ref("");
async function loadNews() {
  try {
    const l = await fetchNewsFlash(1, 20);
    newsText.value = l.map((n) => n.text).join("　　｜　　");
  } catch { /* ignore */ }
}

// 荧光情绪环
const gaugeEl = ref<HTMLElement | null>(null);
let gauge: echarts.ECharts | null = null;
function renderGauge() {
  gauge?.setOption({
    series: [{
      type: "gauge", startAngle: 210, endAngle: -30, min: 0, max: 100, radius: "92%", center: ["50%", "58%"],
      progress: { show: true, width: 10, borderRadius: 5, itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
        { offset: 0, color: "#0bbf86" }, { offset: 0.55, color: "#ffd24d" }, { offset: 1, color: "#ff4d5e" }]) } },
      axisLine: { lineStyle: { width: 10, color: [[1, "rgba(255,255,255,.07)"]] } },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      pointer: { show: false }, anchor: { show: false },
      detail: { formatter: (v: number) => String(Math.round(v)), valueAnimation: false, fontSize: 26, color: "#1dffa0", offsetCenter: ["0", "-2%"], fontWeight: 800 },
      title: { offsetCenter: ["0", "36%"], color: "#7e889c", fontSize: 9.5 },
      data: [{ value: Math.round(radar.value?.sentiment ?? 0), name: "情绪温度" }],
    }],
  });
}
watch(radar, renderGauge);

let newsTimer = 0;
onMounted(async () => {
  await nextTick();
  if (gaugeEl.value) gauge = echarts.init(gaugeEl.value);
  renderGauge();
  loadNews();
  newsTimer = window.setInterval(loadNews, 60000);
});

onBeforeUnmount(() => {
  window.clearInterval(newsTimer);
  gauge?.dispose();
  gauge = null;
});
</script>

<template>
  <div class="tw">
    <!-- 板块跑马灯 -->
    <div class="marq">
      <div class="marq-track">
        <template v-for="rep in 2" :key="rep">
          <span v-for="s in sectors" :key="rep + s.code" class="mpill">
            <span class="mn">{{ s.name }}</span>
            <b :class="s.changePct >= 0 ? 'red' : 'green'">{{ s.changePct >= 0 ? '+' : '' }}{{ s.changePct.toFixed(1) }}%</b>
          </span>
        </template>
      </div>
    </div>

    <div class="main">
      <!-- 左侧情绪 -->
      <aside class="side">
        <div class="gauge-box"><div ref="gaugeEl" class="full"></div></div>
        <div class="nums">
          <div class="nr"><b class="red">{{ radar?.limitUp ?? 0 }}</b><span>涨停</span></div>
          <div class="nr"><b class="green">{{ radar?.limitDown ?? 0 }}</b><span>跌停</span></div>
          <div class="nr"><b class="yellow">{{ radar?.broken ?? 0 }}</b><span>炸板</span></div>
          <div class="nr"><b class="red">{{ Math.round(100 - (radar?.brokenRate ?? 0)) }}%</b><span>封板率</span></div>
          <div class="mini-line">
            <span class="red">上涨 {{ radar?.upCount ?? 0 }}</span>
            <span class="green">下跌 {{ radar?.downCount ?? 0 }}</span>
          </div>
        </div>
      </aside>

      <!-- 电报墙 -->
      <div class="wall">
        <div v-for="(col, c) in cols" :key="c" class="wall-col">
          <div class="wall-track" :style="{ animationDuration: durations[c] + 's', animationDirection: c === 1 ? 'reverse' : 'normal' }">
            <template v-for="rep in 2" :key="rep">
              <span v-for="(e, i) in col" :key="rep + e.time + e.code + i" class="wall-i" @click="emit('select', e.code)">
                <span class="wt">{{ hhmm(e.time) }}</span>
                <span class="wty" :class="e.tone">{{ e.label }}</span>
                <span class="wnm">{{ e.name }}</span>
                <span class="wds" :class="e.tone">{{ (e.pct >= 0 ? '+' : '') + e.pct.toFixed(1) }}%</span>
              </span>
            </template>
          </div>
        </div>
        <div v-if="events.length === 0" class="loading">等待异动电报…</div>
      </div>
    </div>

    <!-- 快讯跑马灯 -->
    <div class="news">
      <span class="news-tag">快讯</span>
      <div class="news-track">
        <span>{{ newsText }}</span><span>{{ newsText }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tw { display:flex;flex-direction:column;height:100%;min-height:0;
  background:#05070a;font-family:ui-monospace,'Cascadia Code',Consolas,monospace; }
.marq { height:34px;flex-shrink:0;overflow:hidden;border-bottom:1px solid #1d2430;background:#080b10;display:flex;align-items:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif; }
.marq-track { display:flex;align-items:center;white-space:nowrap;font-size:13px;animation:marq 360s linear infinite; }
@keyframes marq{from{transform:translateX(0);}to{transform:translateX(-50%);}}
.mpill { display:inline-flex;gap:8px;padding:0 20px;font-size:13px;border-right:1px solid #1d2430; }
.mpill .mn { color:#c2ccda;font-weight:500; }
.main { flex:1;min-height:0;display:grid;grid-template-columns:150px 1fr; }
.side { border-right:1px solid #1d2430;padding:9px;display:flex;flex-direction:column;gap:9px;background:#080b10; }
.gauge-box { height:128px;border:1px solid #1d2430;border-radius:9px;background:#0d1016;overflow:hidden; }
.full { width:100%;height:100%; }
.nums { flex:1;display:flex;flex-direction:column;padding:8px;gap:6px;border:1px solid #1d2430;border-radius:9px;background:#0d1016; }
.nr { display:flex;align-items:baseline;justify-content:space-between; }
.nr b { font-size:17px;font-weight:800; } .nr span { font-size:9.5px;color:#7e889c; }
.mini-line { display:flex;flex-direction:column;gap:2px;font-size:10px;margin-top:auto;border-top:1px solid #1d2430;padding-top:7px; }
.wall { position:relative;display:grid;grid-template-columns:repeat(3,1fr);overflow:hidden; }
.wall-col { overflow:hidden;position:relative;border-right:1px solid #1d2430; }
.wall-col:last-child{border-right:0;}
.wall-track { padding:8px;animation:scrollWall 26s linear infinite; }
@keyframes scrollWall{from{transform:translateY(0);}to{transform:translateY(-50%);}}
.wall-i { display:flex;gap:7px;padding:6px 7px;margin-bottom:3px;border-radius:7px;border:1px solid #1d2430;
  background:rgba(255,255,255,.015);font-size:10.5px;line-height:1.35;cursor:pointer; }
.wall-i:hover { background:rgba(29,255,160,.06); }
.wt { color:#5a6478;font-size:9.5px;flex-shrink:0; }
.wty { font-weight:700;flex-shrink:0; }
.wnm { color:#e6ecf5;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.wds { margin-left:auto;flex-shrink:0; }
.loading { position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#7e889c;font-size:11px; }
.news { height:34px;flex-shrink:0;display:flex;align-items:center;border-top:1px solid #1d2430;background:#0a0d12;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif; }
.news-tag { flex-shrink:0;font-size:10px;font-weight:800;color:#05070a;background:#ffd24d;padding:3px 9px;margin:0 10px;border-radius:5px; }
.news-track { display:flex;white-space:nowrap;font-size:13px;color:#eef2f8;animation:marq 420s linear infinite; }
.news-track span { padding-right:60px; }
.red { color:#ff5d6b; } .green { color:#1dffa0; } .yellow { color:#ffd24d; }
.tone.up { color:#ff5d6b; } .tone.down { color:#1dffa0; } .tone.neutral { color:#ffd24d; }
</style>
