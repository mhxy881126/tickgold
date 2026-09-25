<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { useMarketFeeds } from "../composables/useMarketFeeds";
import type { SpiderEvent } from "../api/market";

const emit = defineEmits<{ select: [code: string] }>();
const { radar, events, sectors } = useMarketFeeds();

interface Node { e: SpiderEvent; t: string; cls: string }
// 时间线：异动按时间正序
const nodes = computed<Node[]>(() =>
  [...events.value].reverse().map((e) => ({
    e,
    t: hhmm(e.time),
    cls: e.tone === "up" ? "red" : e.tone === "down" ? "green" : "gold",
  }))
);

function hhmm(t: number) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 板块主力净流入（亿）
const mainYi = computed(() =>
  (sectors.value.reduce((a, s) => a + s.netAmount, 0) / 1e8).toFixed(1)
);
const topName = computed(() => radar.value?.ladder?.[0]?.items?.[0]?.name ?? "—");

const verdict = computed(() => {
  const r = radar.value;
  if (!r) return "等待行情数据…";
  const dir =
    r.sentiment >= 60 ? "情绪活跃、赚钱效应较强"
    : r.sentiment >= 40 ? "情绪中性、多空分歧"
    : "情绪低迷、赚钱效应较弱";
  const lead = r.maxBoards > 1 ? `，最高 ${r.maxBoards} 板（${topName.value}）` : "";
  return `${dir}${lead}；结合主线板块与资金流向，关注次日接力机会。`;
});

// 情绪曲线
const curveEl = ref<HTMLElement | null>(null);
let chart: echarts.ECharts | null = null;
function renderCurve(hist: number[]) {
  if (!chart || !hist.length) return;
  chart.setOption({
    animation: false,
    grid: { left: 30, right: 10, top: 12, bottom: 20 },
    tooltip: { trigger: "axis", formatter: (p: any) => `温度 ${p[0].value}` },
    xAxis: { type: "category", show: false, data: hist.map((_, i) => i), boundaryGap: false },
    yAxis: {
      type: "value", min: 0, max: 100,
      splitLine: { lineStyle: { color: "rgba(255,255,255,.05)" } },
      axisLabel: { color: "#8a7f68", fontSize: 9 },
    },
    series: [{
      type: "line", data: hist, smooth: true, showSymbol: false,
      lineStyle: { color: "#c9a24a", width: 1.6 },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: "rgba(201,162,74,.30)" }, { offset: 1, color: "rgba(201,162,74,0)" }]) },
      markLine: { symbol: "none", silent: true, data: [{ yAxis: 50 }],
        lineStyle: { color: "#5a6478", type: "dashed", width: 1 }, label: { show: false } },
    }],
  });
}

onMounted(async () => {
  await nextTick();
  if (curveEl.value) chart = echarts.init(curveEl.value);
  renderCurve(radar.value?.hist ?? []);
});
watch(() => radar.value?.hist, (h) => renderCurve(h ?? []));

onBeforeUnmount(() => {
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div class="rt">
    <!-- 左：关键节点时间线 -->
    <div class="rt-card tl">
      <div class="rt-h"><span class="bar"></span>全天关键节点<div class="more">点击节点回看个股</div></div>
      <div class="rt-b scroll">
        <div v-if="nodes.length === 0" class="empty">当日暂无异动记录，开盘后自动记录关键节点</div>
        <div class="tl-list">
          <div
            v-for="(n, i) in nodes" :key="n.e.time + n.e.code + i"
            class="tl-i" :class="{ last: i === nodes.length - 1 }"
            @click="emit('select', n.e.code)"
          >
            <span class="tl-t">{{ n.t }}</span>
            <span class="tl-dc"><span class="tl-dot" :class="n.cls"></span></span>
            <div class="tl-box">
              <span class="tl-tag" :class="'tg-' + n.cls">{{ n.e.label }}</span>
              <b>{{ n.e.name }}</b>
              <p>{{ n.e.desc }} · 现价 {{ n.e.price.toFixed(2) }}（{{ (n.e.pct >= 0 ? '+' : '') + n.e.pct.toFixed(1) }}%）</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 右：情绪曲线 + 当日总结 -->
    <div class="rt-side">
      <div class="rt-card">
        <div class="rt-h"><span class="bar"></span>情绪曲线<div class="more">全天温度</div></div>
        <div class="rt-b" style="flex:none;height:140px"><div ref="curveEl" class="full"></div></div>
      </div>
      <div class="rt-card" style="flex:1;min-height:0">
        <div class="rt-h"><span class="bar"></span>当日总结</div>
        <div class="rt-b sum">
          <div><b class="up">{{ radar?.limitUp ?? 0 }}</b><span>涨停</span></div>
          <div><b class="down">{{ radar?.limitDown ?? 0 }}</b><span>跌停</span></div>
          <div><b class="flat">{{ radar?.broken ?? 0 }}</b><span>炸板</span></div>
          <div><b class="up">{{ Math.round((100 - (radar?.brokenRate ?? 0))) }}%</b><span>封板率</span></div>
          <div class="wide"><span>上涨 / 下跌</span><b>{{ radar?.upCount ?? 0 }} / {{ radar?.downCount ?? 0 }}</b></div>
          <div class="wide"><span>主力资金</span><b class="up">{{ mainYi }} 亿</b></div>
          <div class="wide"><span>最高连板</span><b class="up">{{ radar?.maxBoards ?? 0 }}板 · {{ topName }}</b></div>
          <div class="verdict"><span>复盘结论</span><p>{{ verdict }}</p></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rt { display: grid; grid-template-columns: 1fr 280px; gap: 10px; height: 100%; min-height: 0; }
.rt-side { display: flex; flex-direction: column; gap: 10px; min-height: 0; min-width: 0; }
.rt-card { display: flex; flex-direction: column; min-height: 0;
  background: var(--bg-card, #14110d); border: 1px solid var(--border, #2c2619); border-radius: 11px; overflow: hidden; }
.rt-h { display: flex; align-items: center; gap: 7px; height: 32px; flex-shrink: 0; padding: 0 10px;
  font-size: 12px; font-weight: 700; border-bottom: 1px solid var(--border, #211c13); }
.rt-h .bar { width: 3px; height: 12px; border-radius: 2px; background: #c9a24a; }
.rt-h .more { margin-left: auto; font-size: 10px; font-weight: 400; color: var(--text-dim); }
.rt-b { flex: 1; min-height: 0; padding: 9px; }
.scroll { overflow-y: auto; scrollbar-width: thin; }
.scroll::-webkit-scrollbar { width: 5px; } .scroll::-webkit-scrollbar-thumb { background: #3a3320; border-radius: 3px; }
.empty { color: var(--text-dim); font-size: 11px; text-align: center; padding: 30px 10px; }
.full { width: 100%; height: 100%; }

/* 时间线 */
.tl-list { position: relative; padding: 2px; }
.tl-i { display: grid; grid-template-columns:44px 24px 1fr; gap: 8px; cursor: pointer; }
.tl-t { text-align: right; font-variant-numeric: tabular-nums; font-size: 11px; color: var(--text-dim); padding-top: 8px; }
.tl-dc { position: relative; display: flex; justify-content: center; }
.tl-dc::before { content:''; position:absolute; top:0;bottom:0; left:50%; width:2px; transform:translateX(-50%);
  background: linear-gradient(180deg,#2c2619,#211c13); }
.tl-i.last .tl-dc::before { bottom:50%; }
.tl-i:first-child .tl-dc::before { top:50%; }
.tl-dot { width:11px;height:11px;border-radius:50%;margin-top:8px;z-index:1;border:2px solid #0c0a08; }
.tl-dot.red { background:#f23645;box-shadow:0 0 9px rgba(242,54,69,.7); }
.tl-dot.green { background:#08db94;box-shadow:0 0 9px rgba(8,219,148,.7); }
.tl-dot.gold { background:#c9a24a;box-shadow:0 0 9px rgba(201,162,74,.7); }
.tl-box { padding:6px 10px 12px; }
.tl-tag { font-size:9px;font-weight:700;padding:1px 7px;border-radius:5px;margin-right:7px; }
.tg-red { background:rgba(242,54,69,.16);color:#ff8a93; }
.tg-green { background:rgba(8,219,148,.14);color:#2fe6ac; }
.tg-gold { background:rgba(201,162,74,.16);color:#e6c878; }
.tl-box b { font-size:12.5px; }
.tl-box p { font-size:10.5px;color:var(--text-dim);line-height:1.5;margin-top:4px; }

/* 总结 */
.sum { display:grid;grid-template-columns:repeat(4,1fr);gap:8px 4px;align-content:start; }
.sum>div { display:flex;flex-direction:column;align-items:center;gap:1px; }
.sum b { font-size:16px;font-variant-numeric:tabular-nums; } .sum span { font-size:9.5px;color:var(--text-dim); }
.wide { grid-column:1/-1 !important;flex-direction:row !important;align-items:center !important;justify-content:space-between !important;
  padding:4px 2px;border-top:1px solid #211c13; }
.wide span { font-size:11px; } .wide b { font-size:11.5px; }
.verdict { grid-column:1/-1;border-top:1px solid #211c13;padding-top:8px;margin-top:2px; }
.verdict span { font-size:10.5px;font-weight:700;color:#e6c878;display:block;margin-bottom:4px; }
.verdict p { font-size:11px;line-height:1.55; }
.up { color:#f25266; } .down { color:#22b573; } .flat { color:#f0a23a; }
</style>
