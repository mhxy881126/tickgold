<template>
  <div class="rot">
    <!-- 顶部工具条 -->
    <div class="rot-head">
      <div class="rot-head-title">
        题材轮动矩阵
        <span class="rot-head-sub">概念板块近 {{ days }} 个交易日 · 收盘快照</span>
      </div>
      <div class="rot-tools">
        <div class="rot-seg">
          <button
            v-for="d in [10, 15, 30]"
            :key="d"
            :class="{ on: days === d }"
            @click="changeDays(d)"
          >{{ d }}日</button>
        </div>
        <button class="rot-btn" :disabled="loading" @click="load">
          {{ loading ? "…" : "刷新" }}
        </button>
      </div>
    </div>

    <!-- 阶段总览 -->
    <div class="rot-stages">
      <div v-for="s in STAGE_DEFS" :key="s.key" class="rot-stage">
        <div class="rot-stage-dot" :style="{ background: s.color }" />
        <div class="rot-stage-name">{{ s.label }}</div>
        <div class="rot-stage-cnt">{{ grouped[s.key]?.length ?? 0 }}</div>
      </div>
    </div>

    <!-- 矩阵主体 -->
    <div v-if="loading && !matrix.rows.length" class="rot-empty">加载中…</div>
    <div v-else-if="!matrix.rows.length" class="rot-empty">
      暂无板块日级数据，收盘归档后自动积累
    </div>
    <div v-else class="rot-body">
      <div
        class="rot-grid"
        :style="{ gridTemplateColumns: `150px repeat(${matrix.days.length}, minmax(42px, 1fr))` }"
      >
        <div class="rot-corner">#</div>
        <div
          v-for="day in matrix.days"
          :key="day"
          class="rot-colhead"
          :title="day"
        >{{ shortDay(day) }}</div>

        <template v-for="(row, ri) in matrix.rows" :key="row.code">
          <div class="rot-rowhead" @click="openSector(row)">
            <span class="rot-stage-badge" :style="{ background: stageColor(row.stage) }" />
            <span class="rot-name">{{ row.name }}</span>
          </div>
          <div
            v-for="day in matrix.days"
            :key="day"
            class="rot-cell"
            :style="cellStyle(row.map[day])"
            :title="cellTip(row, day)"
            @click="openSector(row)"
          >{{ cellText(row.map[day]) }}</div>
        </template>
      </div>
    </div>

    <!-- 今日主线切换提示 -->
    <div v-if="matrix.rows.length" class="rot-switch">
      <template v-if="switchList.length">
        <span class="rot-switch-label">今日主线信号：</span>
        <span
          v-for="r in switchList"
          :key="r.code"
          class="rot-switch-chip hot"
          @click="openSector(r)"
        >{{ r.name }} 进入{{ stageLabel(r.stage) }}</span>
      </template>
      <template v-else-if="coolList.length">
        <span class="rot-switch-label">退潮观察：</span>
        <span
          v-for="r in coolList"
          :key="r.code"
          class="rot-switch-chip cool"
          @click="openSector(r)"
        >{{ r.name }}</span>
      </template>
      <span v-else class="rot-switch-label">今日无明显主线切换</span>
    </div>

    <div class="rot-foot">
      阶段由涨跌幅与主力净流入序列判定：萌芽 → 发酵 → 高潮 → 退潮；点击行查看板块成分
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { fetchSectorDay, type SectorDayRow } from "../../api/market";

type Stage = "sprout" | "ferment" | "climax" | "ebb";

const STAGE_DEFS: { key: Stage; label: string; color: string }[] = [
  { key: "sprout", label: "萌芽", color: "#4ea1ff" },
  { key: "ferment", label: "发酵", color: "#ffb13d" },
  { key: "climax", label: "高潮", color: "#ff4d5e" },
  { key: "ebb", label: "退潮", color: "#6b7386" },
];

const emit = defineEmits<{ sector: [name: string, kind: string] }>();

const loading = ref(false);
const days = ref(15);
const rowsAll = ref<SectorDayRow[]>([]);

interface MatrixRow {
  code: string;
  name: string;
  map: Record<string, SectorDayRow>;
  stage: Stage;
  latestPct: number;
  score: number;
}
interface Matrix {
  days: string[];
  rows: MatrixRow[];
}

const matrix = computed<Matrix>(() => {
  const daySet = new Set(rowsAll.value.map((r) => r.day));
  const dayList = [...daySet].sort();
  const bySector = new Map<string, MatrixRow>();
  for (const r of rowsAll.value) {
    let m = bySector.get(r.code);
    if (!m) {
      m = { code: r.code, name: r.name, map: {}, stage: "sprout", latestPct: 0, score: 0 };
      bySector.set(r.code, m);
    }
    m.map[r.day] = r;
    if (!m.name && r.name) m.name = r.name;
  }
  const list = [...bySector.values()];
  for (const m of list) {
    m.stage = classify(m.map, dayList);
    const last = dayList.length ? m.map[dayList[dayList.length - 1]] : undefined;
    m.latestPct = last?.changePct ?? -99;
    m.score = heatScore(m.map, dayList);
  }
  // 只保留窗口内有一定热度的板块，按活跃度排序，限 30 行
  const rows = list
    .filter((m) => m.score > 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
  return { days: dayList, rows };
});

const grouped = computed<Record<Stage, MatrixRow[]>>(() => {
  const g: Record<Stage, MatrixRow[]> = { sprout: [], ferment: [], climax: [], ebb: [] };
  const lastDay = matrix.value.days[matrix.value.days.length - 1];
  for (const r of matrix.value.rows) {
    if (r.map[lastDay]) g[r.stage].push(r);
  }
  return g;
});

const switchList = computed(() => {
  const ds = matrix.value.days;
  if (ds.length < 2) return [];
  const last = ds[ds.length - 1];
  const prev = ds[ds.length - 2];
  return matrix.value.rows.filter((r) => {
    if (r.stage !== "ferment" && r.stage !== "climax") return false;
    const a = r.map[last]?.changePct ?? 0;
    const b = r.map[prev]?.changePct ?? 0;
    return a > b && a >= 3;
  }).slice(0, 6);
});

const coolList = computed(() => {
  const ds = matrix.value.days;
  if (ds.length < 2) return [];
  const last = ds[ds.length - 1];
  return matrix.value.rows.filter((r) => {
    const a = r.map[last]?.changePct;
    return r.stage === "ebb" && a !== undefined && a < 0;
  }).slice(0, 6);
});

/** 阶段判定：依据涨跌幅峰值位置与主力净流入方向 */
function classify(map: Record<string, SectorDayRow>, ds: string[]): Stage {
  const pcts = ds.map((d) => map[d]?.changePct).filter((v): v is number => v !== undefined);
  if (!pcts.length) return "sprout";
  const latest = pcts[pcts.length - 1];
  const peak = Math.max(...pcts);
  const peakIdx = pcts.lastIndexOf(peak);
  const sincePeak = pcts.length - 1 - peakIdx;
  const recent = pcts.slice(-3);
  const rising = recent.length >= 2 && recent[recent.length - 1] > recent[0];
  const nets = ds.map((d) => map[d]?.netAmount).filter((v): v is number => v !== undefined);
  const netSum = nets.slice(-3).reduce((a, b) => a + b, 0);

  if (sincePeak >= 2 && (latest < peak - 2 || latest < 0)) return "ebb";
  if (latest >= 6 || (peak >= 6 && sincePeak === 0)) return "climax";
  if ((rising && latest >= 2) || (latest >= 2 && netSum > 0)) return "ferment";
  if (latest > 0 || netSum > 0) return "sprout";
  return "ebb";
}

/** 热度排序分：近期涨跌幅绝对值 + 峰值 */
function heatScore(map: Record<string, SectorDayRow>, ds: string[]): number {
  const recent = ds.slice(-5);
  let s = 0;
  for (const d of recent) {
    const p = map[d]?.changePct;
    if (p !== undefined) s += Math.abs(p);
  }
  return s;
}

function stageColor(s: Stage): string {
  return STAGE_DEFS.find((d) => d.key === s)?.color ?? "#666";
}
function stageLabel(s: Stage): string {
  return STAGE_DEFS.find((d) => d.key === s)?.label ?? "";
}
function shortDay(day: string): string {
  return day.slice(5);
}
function cellStyle(r?: SectorDayRow): Record<string, string> {
  if (!r || r.changePct === undefined || r.changePct === null) return { background: "transparent" };
  const p = Math.max(-8, Math.min(8, r.changePct));
  const alpha = Math.min(0.85, 0.08 + Math.abs(p) / 10);
  const bg = p >= 0 ? `rgba(255,77,94,${alpha})` : `rgba(47,191,149,${alpha})`;
  return { background: bg };
}
function cellText(r?: SectorDayRow): string {
  if (!r || r.changePct === undefined || r.changePct === null) return "";
  return r.changePct.toFixed(1);
}
function cellTip(row: MatrixRow, day: string): string {
  const r = row.map[day];
  if (!r) return `${row.name} ${day} 无数据`;
  const net = r.netAmount ? ` 主力${(r.netAmount / 1e8).toFixed(2)}亿` : "";
  return `${row.name} ${day} 涨跌${r.changePct?.toFixed(2)}%${net}`;
}
function openSector(row: MatrixRow) {
  emit("sector", row.name, "concept");
}

async function load() {
  loading.value = true;
  try {
    rowsAll.value = await fetchSectorDay("concept", days.value);
  } catch (e) {
    console.error("sector_day_query failed", e);
  } finally {
    loading.value = false;
  }
}
function changeDays(d: number) {
  days.value = d;
  load();
}

onMounted(load);
</script>

<style scoped>
.rot {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  font-size: 12px;
}

/* 顶部 */
.rot-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.rot-head-title { font-weight: 700; font-size: 13px; }
.rot-head-sub { margin-left: 8px; font-weight: 400; color: var(--text-dim, #8892a8); font-size: 11px; }
.rot-tools { display: flex; gap: 8px; align-items: center; }
.rot-seg { display: flex; border: 1px solid var(--border, #2a3344); border-radius: 7px; overflow: hidden; }
.rot-seg button {
  padding: 3px 10px; background: transparent; color: var(--text-dim, #8892a8);
  border: none; cursor: pointer; font-size: 11px;
}
.rot-seg button.on { background: rgba(232, 156, 61, 0.18); color: #e89c3d; }
.rot-btn {
  padding: 4px 12px; border-radius: 7px; cursor: pointer;
  background: rgba(255, 255, 255, 0.06); color: var(--text, #e6ecf5);
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.rot-btn:disabled { opacity: 0.5; cursor: default; }

/* 阶段总览 */
.rot-stages {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.rot-stage {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
}
.rot-stage-dot { width: 8px; height: 8px; border-radius: 50%; }
.rot-stage-name { color: var(--text-dim, #8892a8); }
.rot-stage-cnt { margin-left: auto; font-size: 14px; font-weight: 700; }

/* 矩阵 */
.rot-body { flex: 1; min-height: 0; overflow: auto; }
.rot-grid {
  display: grid;
  grid-template-columns: 150px repeat(var(--cols, 15), minmax(42px, 1fr));
  gap: 2px;
  min-width: 100%;
}
.rot-corner,
.rot-colhead {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 4px 2px;
  text-align: center;
  font-size: 10px;
  color: var(--text-dim, #8892a8);
  background: var(--bg-card, #15181f);
}
.rot-corner { left: 0; text-align: left; z-index: 3; }
.rot-rowhead {
  position: sticky;
  left: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  background: var(--bg-card, #15181f);
  cursor: pointer;
  white-space: nowrap;
}
.rot-rowhead:hover .rot-name { color: #e89c3d; }
.rot-stage-badge { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.rot-name { overflow: hidden; text-overflow: ellipsis; }
.rot-cell {
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.rot-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim, #667088);
}

/* 主线切换 */
.rot-switch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 2px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.rot-switch-label { color: var(--text-dim, #8892a8); }
.rot-switch-chip {
  padding: 2px 10px;
  border-radius: 20px;
  font-size: 11px;
  cursor: pointer;
}
.rot-switch-chip.hot { background: rgba(255, 77, 94, 0.15); color: #ff6b78; border: 1px solid rgba(255,77,94,0.3); }
.rot-switch-chip.cool { background: rgba(107, 115, 134, 0.18); color: #9aa3b6; border: 1px solid rgba(107,115,134,0.3); }

.rot-foot { font-size: 10px; color: var(--text-dim, #556078); text-align: center; }
</style>
