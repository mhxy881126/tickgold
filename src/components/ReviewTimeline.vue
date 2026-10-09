<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as echarts from "echarts";
import { useReviewData } from "../composables/useReviewData";
import { isTrading } from "../utils/sessions";

const emit = defineEmits<{ select: [code: string] }>();
const { dateStr, mode, data, loading, error: loadError, load, setMode } = useReviewData();

function formatDate(ymd: string): string {
  if (!ymd) return "";
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function onDateChange(e: Event) {
  const val = (e.target as HTMLInputElement).value;
  if (val) {
    const ymd = val.replaceAll("-", "");
    dateStr.value = ymd;
  }
}

// ========== 情绪仪表盘 ==========
const sentiment = computed(() => data.value?.emotion.sentiment ?? 0);
const mood = computed(() => data.value?.emotion.mood ?? "—");
const gaugeColor = computed(() => {
  const s = sentiment.value;
  if (s < 40) return "#3ba776";
  if (s < 60) return "#e3b341";
  return "#e0455a";
});
const arcLen = Math.PI * 45;
const gaugeDash = computed(() => `${(arcLen * sentiment.value / 100).toFixed(1)} ${arcLen.toFixed(1)}`);

// ========== 核心数据 ==========
const structure = computed(() => data.value?.structure);

// ========== 迷你时间线 ==========
const miniTimeline = computed(() => {
  const tl = data.value?.timeline;
  if (!tl || tl.length === 0) return [];

  const selected: typeof tl = [];

  // 1. 第一个涨停
  const firstLimit = tl.find(n => n.type === "limit_up" || n.type === "reseal");
  if (firstLimit) selected.push(firstLimit);

  // 2. 最高连板股
  const topBoard = data.value?.ladder?.[0]?.items?.[0];
  if (topBoard) {
    const node = tl.find(n => n.code === (topBoard as any).code);
    if (node && !selected.includes(node)) selected.push(node);
  }

  // 3. 一个炸板
  const broken = tl.filter(n => n.type === "broken");
  if (broken.length > 0) {
    selected.push(broken[Math.floor(broken.length / 2)]);
  }

  // 4. 最强板块（上涨的）
  const topSector = tl.find(n => n.type === "sector" && n.tone === "up");
  if (topSector) selected.push(topSector);

  // 5. 最后一个涨停
  const lastLimit = [...tl].reverse().find(n => n.type === "limit_up" || n.type === "reseal");
  if (lastLimit && !selected.includes(lastLimit)) selected.push(lastLimit);

  // 不够5个补其他节点
  if (selected.length < 5) {
    for (const n of tl) {
      if (selected.length >= 5) break;
      if (!selected.includes(n)) selected.push(n);
    }
  }

  return selected.sort((a, b) => a.time - b.time).slice(0, 5);
});

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function nodeClass(type: string): string {
  switch (type) {
    case "limit_up": case "reseal": return "red";
    case "broken": return "orange";
    case "lhb": return "blue";
    case "sector": return "green";
    case "promote": return "purple";
    default: return "gold";
  }
}

// ========== 时间线过滤（展开视图） ==========
const filterTypes = ref<string[]>(["limit_up", "reseal", "broken", "lhb", "sector", "promote"]);

const filteredTimeline = computed(() => {
  const tl = data.value?.timeline || [];
  return tl.filter(n => filterTypes.value.includes(n.type));
});

// 按时间段分组
const timelineGroups = computed(() => {
  const tl = filteredTimeline.value;
  const groups = [
    { label: "早盘 09:25-10:30", items: [] as any[] },
    { label: "午前 10:30-11:30", items: [] as any[] },
    { label: "午后 13:00-14:00", items: [] as any[] },
    { label: "尾盘 14:00-15:00", items: [] as any[] },
    { label: "收盘后", items: [] as any[] },
  ];

  for (const n of tl) {
    const d = new Date(n.time);
    const mins = d.getHours() * 60 + d.getMinutes();
    if (mins >= 565 && mins < 630) groups[0].items.push(n);
    else if (mins >= 630 && mins < 690) groups[1].items.push(n);
    else if (mins >= 780 && mins < 840) groups[2].items.push(n);
    else if (mins >= 840 && mins <= 900) groups[3].items.push(n);
    else groups[4].items.push(n);
  }

  return groups.filter(g => g.items.length > 0);
});

// ========== 情绪曲线图表（展开视图） ==========
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
        { offset: 0, color: "rgba(201,162,74,.30)" },
        { offset: 1, color: "rgba(201,162,74,0)" },
      ]) },
      markLine: { symbol: "none", silent: true, data: [{ yAxis: 50 }],
        lineStyle: { color: "#5a6478", type: "dashed", width: 1 }, label: { show: false } },
    }],
  });
}

// ========== 模块折叠 ==========
const collapsed = ref<Record<string, boolean>>({
  emotion: false, structure: false, sectors: false, ladder: false, lhb: false,
});
function toggleCollapse(key: string) {
  collapsed.value[key] = !collapsed.value[key];
}

// 首板展开
const firstBoardExpanded = ref(false);

// ========== 生命周期 ==========
onMounted(async () => {
  await nextTick();
  if (curveEl.value) chart = echarts.init(curveEl.value);
  if (data.value?.emotion.hist) renderCurve(data.value.emotion.hist);
});

watch(() => data.value?.emotion.hist, (h) => {
  if (h && h.length > 0) renderCurve(h);
});

onBeforeUnmount(() => {
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <div class="rt">
    <!-- 工具栏 -->
    <div class="rt-toolbar">
      <input type="date" :value="formatDate(dateStr)" @change="onDateChange" class="rt-date" />
        <div class="rt-mode">
          <button class="mode-btn" :class="{ active: mode === 'history' }" @click="setMode('history')">历史</button>
          <button
            class="mode-btn"
            :class="{ active: mode === 'realtime', disabled: !isTrading() }"
            @click="setMode('realtime')"
            :disabled="!isTrading()"
          >实时</button>
        </div>
        <div class="rt-tl-filter">
          <label><input type="checkbox" v-model="filterTypes" value="limit_up" /> 涨停</label>
          <label><input type="checkbox" v-model="filterTypes" value="broken" /> 炸板</label>
          <label><input type="checkbox" v-model="filterTypes" value="lhb" /> 龙虎榜</label>
          <label><input type="checkbox" v-model="filterTypes" value="sector" /> 板块</label>
        </div>
      </div>

      <!-- 主体：左右两栏 -->
      <div class="rt-body">
        <!-- 左栏：时间线 -->
        <div class="rt-left">
          <div class="rt-panel-header">
            <span class="bar"></span>全天关键节点
            <span class="panel-sub">点击节点回看个股</span>
          </div>
          <div v-if="loading" class="rt-loading">加载中…</div>
          <div v-else-if="filteredTimeline.length === 0" class="rt-empty">当日暂无关键节点</div>
          <div v-else class="tl-full scroll">
            <div v-for="(group, gi) in timelineGroups" :key="gi" class="tl-group">
              <div class="tl-group-label">{{ group.label }}</div>
              <div
                v-for="(n, ni) in group.items"
                :key="n.time + n.code + ni"
                class="tl-item"
                :class="{ last: ni === group.items.length - 1 && gi === timelineGroups.length - 1 }"
                @click="emit('select', n.code)"
              >
                <span class="tl-time">{{ hhmm(n.time) }}</span>
                <span class="tl-dot-col"><span class="tl-dot" :class="nodeClass(n.type)"></span></span>
                <div class="tl-content">
                  <div class="tl-head">
                    <span class="tl-tag" :class="'tg-' + nodeClass(n.type)">{{ n.title }}</span>
                    <b>{{ n.name }}</b>
                  </div>
                  <p class="tl-desc">
                    {{ n.desc }}
                    <span v-if="n.pct != null"> · {{ n.pct >= 0 ? '+' : '' }}{{ n.pct.toFixed(1) }}%</span>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 右栏：模块列表 -->
        <div class="rt-right scroll">
          <!-- 情绪曲线 -->
          <div class="rt-module">
            <div class="rt-module-head" @click="toggleCollapse('emotion')">
              <span class="bar"></span>情绪曲线
              <span class="collapse-icon">{{ collapsed.emotion ? '+' : '−' }}</span>
            </div>
            <div v-show="!collapsed.emotion" class="rt-module-body">
              <div ref="curveEl" class="curve-chart"></div>
            </div>
          </div>

          <!-- 涨跌结构 -->
          <div class="rt-module">
            <div class="rt-module-head" @click="toggleCollapse('structure')">
              <span class="bar"></span>涨跌结构
              <span class="collapse-icon">{{ collapsed.structure ? '+' : '−' }}</span>
            </div>
            <div v-show="!collapsed.structure" class="rt-module-body">
              <div v-if="structure" class="struct-grid">
                <div class="struct-item"><b class="up">{{ structure.limitUp }}</b><span>涨停</span></div>
                <div class="struct-item"><b class="down">{{ structure.limitDown }}</b><span>跌停</span></div>
                <div class="struct-item"><b class="flat">{{ structure.broken }}</b><span>炸板</span></div>
                <div class="struct-item"><b class="up">{{ structure.sealRate.toFixed(0) }}%</b><span>封板率</span></div>
                <div class="struct-wide"><span>上涨 / 下跌</span><b>{{ structure.upCount }} / {{ structure.downCount }}</b></div>
                <div class="struct-wide"><span>主力资金</span><b :class="structure.mainFund >= 0 ? 'up' : 'down'">{{ structure.mainFund >= 0 ? '+' : '' }}{{ structure.mainFund.toFixed(1) }} 亿</b></div>
                <div class="struct-wide"><span>最高连板</span><b class="up">{{ structure.maxBoards }}板 · {{ structure.topStock }}</b></div>
              </div>
            </div>
          </div>

          <!-- 热点板块 -->
          <div class="rt-module">
            <div class="rt-module-head" @click="toggleCollapse('sectors')">
              <span class="bar"></span>热点板块
              <span class="collapse-icon">{{ collapsed.sectors ? '+' : '−' }}</span>
            </div>
            <div v-show="!collapsed.sectors" class="rt-module-body">
              <div v-if="!data?.sectors?.length" class="rt-empty-small">暂无板块数据</div>
              <div v-else class="sector-list">
                <div v-for="(s, i) in data.sectors.slice(0, 10)" :key="s.code" class="sector-row">
                  <span class="sec-rank">{{ i + 1 }}</span>
                  <span class="sec-name">{{ s.name }}</span>
                  <span class="sec-pct" :class="s.changePct >= 0 ? 'up' : 'down'">{{ s.changePct >= 0 ? '+' : '' }}{{ s.changePct.toFixed(1) }}%</span>
                  <span class="sec-fund" :class="s.netAmount >= 0 ? 'up' : 'down'">{{ (s.netAmount / 1e8).toFixed(1) }}亿</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 连板梯队 -->
          <div class="rt-module">
            <div class="rt-module-head" @click="toggleCollapse('ladder')">
              <span class="bar"></span>连板梯队
              <span class="collapse-icon">{{ collapsed.ladder ? '+' : '−' }}</span>
            </div>
            <div v-show="!collapsed.ladder" class="rt-module-body">
              <div v-if="!data?.ladder?.length" class="rt-empty-small">暂无连板数据</div>
              <div v-else class="ladder-list">
                <div v-for="group in data.ladder" :key="group.boards" class="ladder-group">
                  <div class="ladder-boards" :class="'lv-' + Math.min(group.boards, 5)">
                    {{ group.boards }}板 <span class="ladder-count">{{ group.count }}只</span>
                  </div>
                  <div class="ladder-stocks">
                    <template v-if="group.boards > 1 || firstBoardExpanded">
                      <span
                        v-for="s in group.items"
                        :key="s.code"
                        class="ladder-stock"
                        :class="{
                          early: s.firstSeal && s.firstSeal <= 100000,
                          late: s.firstSeal && s.firstSeal >= 143000,
                          broken: s.broken > 0
                        }"
                        @click="emit('select', s.code)"
                      >{{ s.name }}</span>
                    </template>
                    <template v-else>
                      <span
                        v-for="s in group.items.slice(0, 10)"
                        :key="s.code"
                        class="ladder-stock"
                        :class="{
                          early: s.firstSeal && s.firstSeal <= 100000,
                          late: s.firstSeal && s.firstSeal >= 143000,
                          broken: s.broken > 0
                        }"
                        @click="emit('select', s.code)"
                      >{{ s.name }}</span>
                      <span v-if="group.items.length > 10" class="ladder-more" @click="firstBoardExpanded = true">
                        +{{ group.items.length - 10 }} 展开
                      </span>
                    </template>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 龙虎榜 -->
          <div class="rt-module">
            <div class="rt-module-head" @click="toggleCollapse('lhb')">
              <span class="bar"></span>龙虎榜
              <span class="collapse-icon">{{ collapsed.lhb ? '+' : '−' }}</span>
            </div>
            <div v-show="!collapsed.lhb" class="rt-module-body">
              <div v-if="!data?.lhb?.length" class="rt-empty-small">当日暂无龙虎榜数据</div>
              <div v-else class="lhb-list">
                <div
                  v-for="s in data.lhb.slice(0, 10)"
                  :key="s.code"
                  class="lhb-row"
                  @click="emit('select', s.code)"
                >
                  <span class="lhb-name">{{ s.name }}</span>
                  <span class="lhb-pct" :class="s.pct >= 0 ? 'up' : 'down'">{{ s.pct >= 0 ? '+' : '' }}{{ s.pct.toFixed(1) }}%</span>
                  <span class="lhb-amt" :class="s.netAmt >= 0 ? 'up' : 'down'">
                    {{ s.netAmt >= 0 ? '净买' : '净卖' }}{{ (Math.abs(s.netAmt) / 1e8).toFixed(2) }}亿
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
  </div>
</template><style scoped>
/* ===== 根容器 ===== */
.rt {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-card, #14110d);
  border: 1px solid var(--border, #2c2619);
  border-radius: 11px;
  overflow: hidden;
  font-size: 12px;
  color: var(--text, #e8dcc8);
}

.up { color: #f25266; }
.down { color: #22b573; }
.flat { color: #f0a23a; }

/* ===== 工具栏 ===== */
.rt-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  flex-shrink: 0;
  padding: 0 12px;
  border-bottom: 1px solid var(--border, #211c13);
}
.rt-date {
  background: #1a1610;
  border: 1px solid #2c2619;
  border-radius: 4px;
  color: #e8dcc8;
  font-size: 11px;
  padding: 2px 6px;
  color-scheme: dark;
}
.rt-mode {
  display: flex;
  gap: 1px;
  background: #1a1610;
  border-radius: 4px;
  padding: 1px;
}
.mode-btn {
  background: transparent;
  border: none;
  color: #8a7f68;
  font-size: 10.5px;
  padding: 2px 8px;
  border-radius: 3px;
  cursor: pointer;
}
.mode-btn.active { background: #2c2619; color: #e6c878; }
.mode-btn.disabled { opacity: 0.4; cursor: not-allowed; }

.rt-tl-filter {
  display: flex;
  gap: 8px;
  margin-left: 12px;
  font-size: 10.5px;
  color: var(--text-dim);
}
.rt-tl-filter label { display: flex; align-items: center; gap: 3px; cursor: pointer; }
.rt-tl-filter input { accent-color: #c9a24a; }

/* ===== 主体：左右两栏 ===== */
.rt-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: row;
  min-height: 0;
  height: calc(100% - 34px);
  overflow: hidden;
}

/* ===== 左栏：时间线 ===== */
.rt-left {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  border-right: 1px solid var(--border, #211c13);
}
.rt-panel-header {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  flex-shrink: 0;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 700;
  border-bottom: 1px solid var(--border, #211c13);
}
.rt-panel-header .bar { width: 3px; height: 12px; border-radius: 2px; background: #c9a24a; }
.rt-panel-header .panel-sub {
  margin-left: auto;
  font-size: 10px;
  font-weight: 400;
  color: var(--text-dim);
}

.tl-full {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 8px 12px;
  min-height: 0;
}
.tl-group { margin-bottom: 8px; }
.tl-group-label {
  font-size: 10.5px;
  color: #c9a24a;
  font-weight: 600;
  padding: 4px 0 6px;
  position: sticky;
  top: 0;
  background: var(--bg-card, #14110d);
  z-index: 1;
}
.tl-item {
  display: grid;
  grid-template-columns: 44px 24px 1fr;
  gap: 8px;
  cursor: pointer;
  padding: 2px 0;
}
.tl-item:hover .tl-content b { color: #e6c878; }
.tl-time {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--text-dim);
  padding-top: 6px;
}
.tl-dot-col { position: relative; display: flex; justify-content: center; }
.tl-dot-col::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  background: linear-gradient(180deg, #2c2619, #211c13);
}
.tl-item.last .tl-dot-col::before { bottom: 50%; }
.tl-dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  margin-top: 6px;
  z-index: 1;
  border: 2px solid #0c0a08;
}
.tl-dot.red { background: #f23645; box-shadow: 0 0 9px rgba(242,54,69,.7); }
.tl-dot.orange { background: #f0a23a; box-shadow: 0 0 9px rgba(240,162,58,.7); }
.tl-dot.blue { background: #4a9eff; box-shadow: 0 0 9px rgba(74,158,255,.7); }
.tl-dot.green { background: #08db94; box-shadow: 0 0 9px rgba(8,219,148,.7); }
.tl-dot.purple { background: #b388ff; box-shadow: 0 0 9px rgba(179,136,255,.7); }
.tl-dot.gold { background: #c9a24a; box-shadow: 0 0 9px rgba(201,162,74,.7); }

.tl-content { padding: 4px 0 10px; }
.tl-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tl-tag {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 5px;
}
.tg-red { background: rgba(242,54,69,.16); color: #ff8a93; }
.tg-orange { background: rgba(240,162,58,.16); color: #f0a23a; }
.tg-blue { background: rgba(74,158,255,.16); color: #6ab0ff; }
.tg-green { background: rgba(8,219,148,.14); color: #2fe6ac; }
.tg-purple { background: rgba(179,136,255,.16); color: #c9a8ff; }
.tg-gold { background: rgba(201,162,74,.16); color: #e6c878; }
.tl-content b { font-size: 12.5px; }
.tl-desc {
  font-size: 10.5px;
  color: var(--text-dim);
  line-height: 1.5;
  margin-top: 4px;
}

/* ===== 右栏 ===== */
.rt-right {
  flex: 0 0 320px;
  width: 320px;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

.rt-module { border-bottom: 1px solid var(--border, #211c13); }
.rt-module-head {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  background: #14110d;
  position: sticky;
  top: 0;
  z-index: 2;
}
.rt-module-head:hover { background: #1a1610; }
.rt-module-head .bar { width: 3px; height: 12px; border-radius: 2px; background: #c9a24a; }
.collapse-icon {
  margin-left: auto;
  font-size: 14px;
  color: var(--text-dim);
  width: 14px;
  text-align: center;
}
.rt-module-body { padding: 8px 12px; }

/* 情绪曲线 */
.curve-chart { width: 100%; height: 130px; }

/* 涨跌结构 */
.struct-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px 4px;
}
.struct-item { display: flex; flex-direction: column; align-items: center; gap: 1px; }
.struct-item b { font-size: 15px; font-variant-numeric: tabular-nums; }
.struct-item span { font-size: 9.5px; color: var(--text-dim); }
.struct-wide {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 2px;
  border-top: 1px solid #211c13;
  font-size: 11px;
}
.struct-wide span { color: var(--text-dim); }
.struct-wide b { font-size: 11.5px; font-variant-numeric: tabular-nums; }

/* 板块列表 */
.sector-list { display: flex; flex-direction: column; gap: 2px; }
.sector-row {
  display: grid;
  grid-template-columns: 18px 1fr 45px 55px;
  gap: 6px;
  align-items: center;
  font-size: 11px;
  padding: 3px 2px;
}
.sector-row:hover { background: #1a1610; }
.sec-rank { font-size: 10px; color: var(--text-dim); text-align: center; }
.sec-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sec-pct, .sec-fund {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
}

/* 连板梯队 */
.ladder-list { display: flex; flex-direction: column; gap: 6px; }
.ladder-group {
  display: grid;
  grid-template-columns: 55px 1fr;
  gap: 8px;
  align-items: start;
}
.ladder-boards {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 4px;
  border-radius: 3px;
  text-align: center;
  background: rgba(201,162,74,.12);
  color: #e6c878;
}
.ladder-boards.lv-2 { background: rgba(242,54,69,.12); color: #ff8a93; }
.ladder-boards.lv-3 { background: rgba(242,54,69,.2); color: #ff6b78; }
.ladder-boards.lv-4 { background: rgba(242,54,69,.28); color: #ff4d5e; }
.ladder-boards.lv-5 { background: rgba(242,54,69,.35); color: #ff3347; }
.ladder-count { font-size: 9px; opacity: 0.7; font-weight: 400; }
.ladder-stocks { display: flex; flex-wrap: wrap; gap: 4px; }
.ladder-stock {
  font-size: 10.5px;
  padding: 1px 5px;
  border-radius: 3px;
  background: #1a1610;
  cursor: pointer;
  border: 1px solid transparent;
}
.ladder-stock:hover { border-color: #c9a24a; }
.ladder-stock.early { border-color: rgba(201,162,74,.4); }
.ladder-stock.late { opacity: 0.6; }
.ladder-stock.broken { border-style: dashed; border-color: rgba(240,162,58,.5); }
.ladder-more {
  font-size: 10px;
  color: #c9a24a;
  cursor: pointer;
  padding: 1px 5px;
}

/* 龙虎榜 */
.lhb-list { display: flex; flex-direction: column; gap: 2px; }
.lhb-row {
  display: grid;
  grid-template-columns: 1fr 45px auto;
  gap: 6px;
  align-items: center;
  font-size: 11px;
  padding: 4px 2px;
  cursor: pointer;
}
.lhb-row:hover { background: #1a1610; }
.lhb-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lhb-pct { text-align: right; font-variant-numeric: tabular-nums; }
.lhb-amt { font-size: 10px; font-variant-numeric: tabular-nums; }

/* 状态 */
.rt-loading { padding: 30px; text-align: center; color: var(--text-dim); font-size: 11px; }
.rt-error { padding: 20px; text-align: center; color: #f0883e; font-size: 11px; }
.rt-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 11px;
}
.rt-empty-small {
  text-align: center;
  color: var(--text-dim);
  font-size: 10.5px;
  padding: 10px;
}
.retry-btn {
  margin-top: 8px;
  background: #2c2619;
  border: 1px solid #3a3320;
  color: #e6c878;
  font-size: 10.5px;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
}

/* 滚动条 */
.tl-full::-webkit-scrollbar,
.rt-right::-webkit-scrollbar { width: 5px; }
.tl-full::-webkit-scrollbar-thumb,
.rt-right::-webkit-scrollbar-thumb { background: #3a3320; border-radius: 3px; }
</style>
