<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  startRadar, stopRadar, fetchZtPool, fetchQuotes,
  type LadderGroup, type RadarData, type RadarStatus, type ZtStock,
} from "../api/market";

const emit = defineEmits<{ select: [code: string] }>();

const data = ref<RadarData | null>(null);
const scanning = ref(false);
const trading = ref(true);
type LimitTab = "ladder" | "bridge" | "up" | "broken" | "down";
const tab = ref<LimitTab>("ladder");
let un: UnlistenFn[] = [];

// 涨停池明细 join（封单/首封/炸板/换手/题材），按 code 索引
const ztMap = ref<Map<string, ZtStock>>(new Map());

function money(v: number): string {
  if (!v) return "—";
  if (v >= 1e8) return (v / 1e8).toFixed(1) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(0) + "万";
  return String(v);
}
function sealTime(v: number): string {
  if (!v) return "";
  const s = String(v).padStart(6, "0");
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
}
/** chip 封板质量染色：早盘强板金、尾盘偷袭板灰、炸过的标 warn */
function chipClass(s: LimitStockLite): Record<string, boolean> {
  const z = ztMap.value.get(s.code);
  const c: Record<string, boolean> = {};
  if (z) {
    if (z.broken > 0) c.broken = true;            // 炸过板
    if (z.firstSeal && z.firstSeal >= 143000) c.late = true;   // 14:30后尾盘板
    else if (z.firstSeal && z.firstSeal <= 100000) c.early = true; // 10:00前早盘板
    if (z.turnover < 2) c.yizi = true;            // 一字/无量
    if (z.fund >= 5e8) c.strong = true;           // 封单≥5亿
  }
  return c;
}
type LimitStockLite = { code: string; name: string; price: number; pct?: number };
function ztOf(code: string): ZtStock | undefined { return ztMap.value.get(code); }

// 首板（1 板）数量多，默认只显示前 30
const firstBoardExpanded = ref(false);
const FIRST_SHOW = 30;
function shownItems(g: LadderGroup) {
  if (g.boards !== 1 || firstBoardExpanded.value) return g.items;
  return g.items.slice(0, FIRST_SHOW);
}
function boardClass(b: number) {
  if (b >= 5) return "lv5";
  if (b >= 3) return "lv3";
  if (b === 2) return "lv2";
  return "lv1";
}

function hhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 仪表盘颜色（冷→热）
const gaugeColor = computed(() => {
  const s = data.value?.sentiment ?? 50;
  if (s < 40) return "#3ba776";
  if (s < 60) return "#e3b341";
  return "#e0455a";
});
const arcLen = Math.PI * 56;
const dash = computed(() => {
  const f = (data.value?.sentiment ?? 0) / 100;
  return `${(arcLen * f).toFixed(1)} ${arcLen.toFixed(1)}`;
});

onMounted(async () => {
  un.push(await listen<RadarData>("radar:data", (e) => { data.value = e.payload; }));
  un.push(await listen<RadarStatus>("radar:status", (e) => {
    scanning.value = e.payload.scanning;
    trading.value = e.payload.trading;
  }));
  try { await startRadar(); } catch (e) { console.error("startRadar", e); }
  // 拉今日涨停池明细，join 封单/首封/换手/题材（失败不影响梯队主功能）
  try {
    const pool = await fetchZtPool();
    const m = new Map<string, ZtStock>();
    for (const s of pool.list) m.set(s.code, s);
    ztMap.value = m;
  } catch (e) { console.warn("zt pool join failed", e); }
});

onUnmounted(async () => {
  un.forEach((f) => f());
  try { await stopRadar(); } catch { /* ignore */ }
});

// ===== 天梯：昨日高标 ↔ 今日晋级 =====
interface BridgeRow {
  code: string; name: string;
  prevBoards: number;   // 昨日几板
  todayBoards: number;  // 今日几板（0 = 断板未涨停）
  pct: number;          // 今日涨幅
  industry: string;
}
interface BridgeStat { boards: number; total: number; promoted: number }
const bridgeRows = ref<BridgeRow[]>([]);
const bridgeStats = ref<BridgeStat[]>([]);
const bridgeLoaded = ref(false);
const bridgeError = ref("");

function ymdOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

async function loadBridge() {
  bridgeLoaded.value = false; bridgeError.value = "";
  try {
    // 往前扫最近 10 个自然日，找两个相邻且有涨停池的交易日：curr=最近, prev=前一交易日
    const days: string[] = [];
    const now = new Date();
    for (let i = 0; i < 12 && days.length < 2; i++) {
      const t = new Date(now); t.setDate(now.getDate() - i);
      try {
        const pool = await fetchZtPool(ymdOf(t));
        if (pool.list.length > 0) days.push(ymdOf(t));
      } catch { /* 该日无数据，跳过 */ }
    }
    if (days.length < 2) { bridgeError.value = "近12日无足够涨停池数据"; bridgeLoaded.value = true; return; }
    const [currYmd, prevYmd] = days;
    const [currPool, prevPool] = await Promise.all([fetchZtPool(currYmd), fetchZtPool(prevYmd)]);
    const currMap = new Map<string, ZtStock>(currPool.list.map((s) => [s.code, s]));

    const rows: BridgeRow[] = prevPool.list.map((s) => {
      const c = currMap.get(s.code);
      return {
        code: s.code, name: s.name,
        prevBoards: s.boards,
        todayBoards: c ? c.boards : 0,
        pct: c ? c.pct : 0,
        industry: s.industry,
      };
    });
    // 断板股（今日未涨停）批量补今日实时涨幅
    const broken = rows.filter((r) => r.todayBoards === 0);
    if (broken.length) {
      const qs = await fetchQuotes(broken.map((r) => r.code));
      const qmap = new Map(qs.map((q) => [q.code, q.pct]));
      for (const r of broken) r.pct = qmap.get(r.code) ?? 0;
    }
    bridgeRows.value = rows;

    const statMap = new Map<number, { total: number; promoted: number }>();
    for (const r of rows) {
      const e = statMap.get(r.prevBoards) ?? { total: 0, promoted: 0 };
      e.total++;
      if (r.todayBoards > r.prevBoards) e.promoted++;
      statMap.set(r.prevBoards, e);
    }
    bridgeStats.value = [...statMap.entries()]
      .map(([boards, v]) => ({ boards, ...v }))
      .sort((a, b) => b.boards - a.boards);
    bridgeLoaded.value = true;
  } catch (e) {
    bridgeError.value = String(e);
    bridgeLoaded.value = true;
  }
}
// 切到天梯 Tab 时懒加载一次
watch(tab, (v) => { if (v === "bridge" && !bridgeLoaded.value) loadBridge(); });
function rateCls(r: number): string {
  if (r >= 0.5) return "hi";      // 晋级率高=接力强
  if (r >= 0.25) return "mid";
  return "lo";                    // 晋级率低=接力差
}

// ===== 板块筛选：主板 / 创业板 / 科创板 / 北交所 =====
type BoardKey = "main" | "gem" | "star" | "bj";
const BOARD_OPTS: { k: BoardKey; label: string }[] = [
  { k: "main", label: "主板" },
  { k: "gem", label: "创业板" },
  { k: "star", label: "科创板" },
  { k: "bj", label: "北交所" },
];
const boardFilter = ref<Set<BoardKey>>(new Set());
function boardOf(code: string): BoardKey {
  if (code.startsWith("688")) return "star";
  if (code.startsWith("30")) return "gem";
  if (/^(43|83|87|88|92)/.test(code)) return "bj";
  return "main";
}
function passFilter(code: string): boolean {
  if (boardFilter.value.size === 0) return true;
  return boardFilter.value.has(boardOf(code));
}
function toggleBoard(k: BoardKey) {
  const s = new Set(boardFilter.value);
  if (s.has(k)) s.delete(k); else s.add(k);
  boardFilter.value = s;
}
</script>

<template>
  <div class="radar">
    <!-- 顶部：情绪仪表 + 统计 -->
    <div class="top">
      <div class="gauge">
        <svg viewBox="0 0 140 86" width="132" height="80">
          <path d="M14 78 A56 56 0 0 1 126 78" fill="none" stroke="var(--bg-card2)" stroke-width="9" stroke-linecap="round" />
          <path d="M14 78 A56 56 0 0 1 126 78" fill="none" :stroke="gaugeColor" stroke-width="9"
                stroke-linecap="round" :stroke-dasharray="dash" style="transition: stroke-dasharray .6s, stroke .4s" />
          <text x="70" y="62" text-anchor="middle" class="g-num">{{ Math.round(data?.sentiment ?? 0) }}</text>
          <text x="70" y="78" text-anchor="middle" class="g-mood">{{ data?.mood || "—" }}</text>
        </svg>
        <div class="g-label">市场情绪</div>
      </div>

      <div class="stats">
        <div class="stat up">
          <div class="sv">{{ data?.limitUp ?? 0 }}</div><div class="sl">涨停</div>
        </div>
        <div class="stat down">
          <div class="sv">{{ data?.limitDown ?? 0 }}</div><div class="sl">跌停</div>
        </div>
        <div class="stat warn">
          <div class="sv">{{ data?.broken ?? 0 }}</div><div class="sl">炸板</div>
        </div>
        <div class="stat">
          <div class="sv">{{ (data?.brokenRate ?? 0).toFixed(0) }}%</div><div class="sl">炸板率</div>
        </div>
        <div class="stat gold">
          <div class="sv">{{ data?.maxBoards ?? 0 }}</div><div class="sl">最高板</div>
        </div>
        <div class="stat up">
          <div class="sv">{{ data?.upCount ?? 0 }}</div><div class="sl">上涨</div>
        </div>
        <div class="stat down">
          <div class="sv">{{ data?.downCount ?? 0 }}</div><div class="sl">下跌</div>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button :class="{ on: tab === 'ladder' }" @click="tab = 'ladder'">连板梯队</button>
      <button :class="{ on: tab === 'bridge' }" @click="tab = 'bridge'">天梯</button>
      <button :class="{ on: tab === 'up' }" @click="tab = 'up'">涨停 {{ data?.limitUp ?? 0 }}</button>
      <button :class="{ on: tab === 'broken' }" @click="tab = 'broken'">炸板 {{ data?.broken ?? 0 }}</button>
      <button :class="{ on: tab === 'down' }" @click="tab = 'down'">跌停 {{ data?.limitDown ?? 0 }}</button>
      <span class="scan-info">
        <span v-if="scanning" class="dot-pulse"></span>
        {{ data ? hhmmss(data.updated) : '' }}
      </span>
    </div>

    <div class="body">
      <!-- 板块筛选条（梯队/天梯视图） -->
      <div v-if="tab === 'ladder' || tab === 'bridge'" class="board-filter">
        <button
          v-for="b in BOARD_OPTS" :key="b.k"
          class="bf-chip" :class="{ on: boardFilter.has(b.k) }"
          @click="toggleBoard(b.k)"
        >{{ b.label }}</button>
      </div>

      <!-- 连板梯队（含首板） -->
      <div v-if="tab === 'ladder'" class="ladder">
        <div v-if="!data" class="empty">正在全市场扫描…</div>
        <div v-else-if="data.ladder.length === 0" class="empty">当前无涨停股</div>
        <template v-else>
        <div
          v-for="g in data.ladder"
          :key="g.boards"
          class="lad-group"
          :class="[boardClass(g.boards), { top: g.boards === data.maxBoards }]"
        >
          <div class="lad-head">
            <div class="lad-badge">
              <span class="bn">{{ g.boards }}</span><span class="bt">板</span>
            </div>
            <div class="lad-meta">
              <span class="lc">{{ g.count }} 家</span>
              <span v-if="g.boards === data.maxBoards" class="crown">最高标</span>
              <span v-if="g.boards === 1" class="first-tag">首板</span>
            </div>
          </div>
          <div class="lad-items">
            <button
              v-for="s in shownItems(g).filter((x) => passFilter(x.code))"
              :key="s.code"
              class="stock-chip"
              :class="chipClass(s)"
              @click="emit('select', s.code)"
            >
              <span class="chip-main">
                <span class="sn">{{ s.name }}</span>
                <span v-if="s.pct != null" class="spct up">+{{ s.pct.toFixed(1) }}%</span>
                <span class="sp">{{ s.price.toFixed(2) }}</span>
              </span>
              <span class="chip-sub">
                <template v-if="ztOf(s.code) as ZtStock | undefined">
                  <span v-if="ztOf(s.code)!.firstSeal" class="z-time">{{ sealTime(ztOf(s.code)!.firstSeal) }}</span>
                  <span class="z-fund">{{ money(ztOf(s.code)!.fund) }}</span>
                  <span class="z-turn">换{{ ztOf(s.code)!.turnover.toFixed(0) }}%</span>
                  <span v-if="ztOf(s.code)!.broken > 0" class="z-broken">炸{{ ztOf(s.code)!.broken }}</span>
                  <span v-if="ztOf(s.code)!.turnover < 2" class="z-yizi">一字</span>
                  <span class="z-ind">{{ ztOf(s.code)!.industry }}</span>
                </template>
                <span v-else class="z-ind">—</span>
              </span>
            </button>
            <button
              v-if="g.boards === 1 && g.items.length > FIRST_SHOW"
              class="more-btn"
              @click="firstBoardExpanded = !firstBoardExpanded"
            >
              {{ firstBoardExpanded ? "收起" : `展开其余 ${g.items.length - FIRST_SHOW} 只` }}
            </button>
          </div>
        </div>
        </template>
      </div>

      <!-- 天梯：昨日高标 ↔ 今日晋级 -->
      <div v-if="tab === 'bridge'" class="bridge">
        <div v-if="!bridgeLoaded" class="empty">正在拉取相邻交易日涨停池…</div>
        <div v-else-if="bridgeError" class="empty err">{{ bridgeError }}</div>
        <template v-else>
          <!-- 板级晋级率统计条 -->
          <div class="br-stats">
            <span class="br-stat" v-for="s in bridgeStats" :key="s.boards">
              <b>{{ s.boards }}板</b> 晋级率
              <em :class="rateCls(s.promoted / s.total)">{{ s.total ? Math.round((s.promoted / s.total) * 100) : 0 }}%</em>
              <i>{{ s.promoted }}/{{ s.total }}</i>
            </span>
          </div>
          <div class="br-cols">
            <!-- 左：昨日高标 -->
            <div class="br-col">
              <div class="br-col-head">昨日高标 {{ bridgeRows.filter((r) => passFilter(r.code)).length }}</div>
              <div
                v-for="r in bridgeRows.filter((r) => passFilter(r.code)).sort((a, b) => b.prevBoards - a.prevBoards)"
                :key="'l' + r.code"
                class="br-row"
                :class="{ ok: r.todayBoards > 0, dead: r.todayBoards === 0 }"
                @click="emit('select', r.code)"
              >
                <span class="br-bn">{{ r.prevBoards }}板</span>
                <span class="br-nm">{{ r.name }}</span>
                <span class="br-pct" :class="r.todayBoards > 0 ? 'up' : (r.pct >= 0 ? 'flat' : 'down')">
                  <template v-if="r.todayBoards > 0">→{{ r.todayBoards }}板</template>
                  <template v-else>{{ r.pct >= 0 ? "+" : "" }}{{ r.pct.toFixed(1) }}%</template>
                </span>
              </div>
            </div>
            <!-- 右：今日晋级 -->
            <div class="br-col">
              <div class="br-col-head up">今日晋级 {{ bridgeRows.filter((r) => passFilter(r.code) && r.todayBoards > 0).length }}</div>
              <div
                v-for="r in bridgeRows.filter((r) => passFilter(r.code) && r.todayBoards > 0).sort((a, b) => b.todayBoards - a.todayBoards)"
                :key="'r' + r.code"
                class="br-row ok"
                @click="emit('select', r.code)"
              >
                <span class="br-bn up">{{ r.todayBoards }}板</span>
                <span class="br-nm">{{ r.name }}</span>
                <span class="br-ind">{{ r.industry }}</span>
              </div>
              <div v-if="bridgeRows.filter((r) => passFilter(r.code) && r.todayBoards > 0).length === 0" class="empty small">无晋级票</div>
            </div>
          </div>
        </template>
      </div>

      <!-- 涨停列表 -->
      <div v-if="tab === 'up'" class="list">
        <div v-for="s in data?.limitUpList ?? []" :key="s.code" class="row" @click="emit('select', s.code)">
          <span class="nm">{{ s.name }}</span>
          <span class="bd" :class="{ hi: s.boards >= 3 }">{{ s.boards }}板</span>
          <span class="pr">{{ s.price.toFixed(2) }}</span>
          <span class="pct up">{{ s.pct.toFixed(2) }}%</span>
        </div>
      </div>

      <!-- 炸板列表 -->
      <div v-if="tab === 'broken'" class="list">
        <div v-for="s in data?.brokenList ?? []" :key="s.code" class="row" @click="emit('select', s.code)">
          <span class="nm">{{ s.name }}</span>
          <span class="bd brk">炸板</span>
          <span class="pr">{{ s.price.toFixed(2) }}</span>
          <span :class="s.pct >= 0 ? 'pct up' : 'pct down'">{{ s.pct.toFixed(2) }}%</span>
        </div>
      </div>

      <!-- 跌停列表 -->
      <div v-if="tab === 'down'" class="list">
        <div v-for="s in data?.limitDownList ?? []" :key="s.code" class="row" @click="emit('select', s.code)">
          <span class="nm">{{ s.name }}</span>
          <span class="bd dn">跌停</span>
          <span class="pr">{{ s.price.toFixed(2) }}</span>
          <span class="pct down">{{ s.pct.toFixed(2) }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.radar { display: flex; flex-direction: column; height: 100%; font-size: 12px; }

/* 顶部 */
.top { display: flex; gap: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
.gauge { display: flex; flex-direction: column; align-items: center; flex: 0 0 128px; }
.g-num { fill: var(--text); font-size: 26px; font-weight: 700; }
.g-mood { fill: var(--text-dim); font-size: 11px; }
.g-label { color: var(--text-dim); font-size: 11px; margin-top: 2px; }

.stats { flex: 1; display: grid; grid-template-columns: repeat(4, 1fr); grid-auto-rows: minmax(40px, auto); gap: 6px; }
.stat {
  background: var(--bg-card2); border: 1px solid var(--border); border-radius: 7px; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
}
.sv { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
.sl { font-size: 10px; color: var(--text-dim); margin-top: 1px; }
.stat.up .sv { color: var(--up); }
.stat.down .sv { color: var(--down); }
.stat.warn .sv { color: var(--accent); }
.stat.gold .sv { color: var(--accent); }

/* tabs */
.tabs { display: flex; align-items: center; gap: 4px; padding: 9px 0 8px; }
.tabs button {
  background: none; border: none; color: var(--text-dim); font-size: 11px; cursor: pointer;
  padding: 4px 9px; border-radius: 6px;
}
.tabs button:hover { color: var(--text); }
.tabs button.on { background: var(--bg-hover); color: var(--text); font-weight: 600; }
.scan-info { margin-left: auto; display: flex; align-items: center; gap: 5px; color: var(--text-dim); font-size: 10px; font-variant-numeric: tabular-nums; }
.dot-pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--blue); animation: pulse 1.2s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }

/* body */
.body { flex: 1; overflow-y: auto; }
.empty { color: var(--text-dim); font-size: 11px; text-align: center; padding: 30px 10px; }

/* 板块筛选条 */
.board-filter { display: flex; gap: 5px; padding: 2px 0 8px; }
.bf-chip {
  background: var(--bg-card2); border: 1px solid var(--border); color: var(--text-dim);
  font-size: 10px; padding: 3px 10px; border-radius: 11px; cursor: pointer;
}
.bf-chip:hover { color: var(--text); border-color: var(--text-dim); }
.bf-chip.on { background: var(--accent); border-color: var(--accent); color: #1a1a1a; font-weight: 700; }
.empty.small { padding: 16px 6px; font-size: 10px; }
.empty.err { color: var(--accent); }

/* 天梯（昨日高标 ↔ 今日晋级） */
.bridge { display: flex; flex-direction: column; gap: 8px; height: 100%; }
.br-stats { display: flex; flex-wrap: wrap; gap: 5px; }
.br-stat {
  font-size: 10px; background: var(--bg-card2); border: 1px solid var(--border);
  border-radius: 6px; padding: 3px 7px; color: var(--text-dim); display: inline-flex; gap: 4px; align-items: baseline;
}
.br-stat b { color: var(--text); font-size: 11px; }
.br-stat em { font-style: normal; font-weight: 700; font-variant-numeric: tabular-nums; }
.br-stat em.hi { color: var(--up); }
.br-stat em.mid { color: #e3b341; }
.br-stat em.lo { color: var(--down); }
.br-stat i { font-style: normal; color: var(--text-dim); font-size: 9px; }
.br-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; flex: 1; min-height: 0; }
.br-col { overflow-y: auto; display: flex; flex-direction: column; }
.br-col-head { font-size: 11px; font-weight: 700; color: var(--accent); padding: 2px 2px 6px; position: sticky; top: 0; background: var(--bg-card); z-index: 1; }
.br-col-head.up { color: var(--up); }
.br-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 5px; cursor: pointer; font-size: 11px; }
.br-row:hover { background: var(--bg-hover); }
.br-bn { font-size: 9px; color: var(--text-dim); background: var(--bg-hover); border-radius: 3px; padding: 1px 5px; flex: 0 0 auto; }
.br-bn.up { color: var(--up); }
.br-row.dead { opacity: .62; }
.br-nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.br-pct { font-size: 10px; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
.br-pct.up { color: var(--up); font-weight: 700; }
.br-pct.down { color: var(--down); }
.br-pct.flat { color: var(--text-dim); }
.br-ind { font-size: 9px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 72px; flex: 0 0 auto; }

/* 梯队（含首板） */
.ladder { display: flex; flex-direction: column; gap: 9px; padding-top: 4px; }
.lad-group { border: 1px solid var(--border); border-radius: 9px; padding: 9px 10px; background: var(--bg-card); }
.lad-group.top { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.lad-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.lad-badge {
  width: 46px; height: 34px; border-radius: 8px; padding-top: 5px;
  display: flex; align-items: baseline; justify-content: center; gap: 2px; background: var(--bg-hover);
}
.lad-group.lv5 .lad-badge { background: linear-gradient(160deg,#6b531c,#3d2e12); }
.lad-group.lv3 .lad-badge { background: linear-gradient(160deg,#5e2a2a,#381a1c); }
.lad-group.lv2 .lad-badge { background: var(--bg-hover); }
.lad-group.lv1 .lad-badge { background: var(--bg-hover); }
.bn { font-size: 19px; font-weight: 800; }
.bt { font-size: 10px; }
.lad-group.lv5 .bn, .lad-group.lv5 .bt { color: #ffd76a; }
.lad-group.lv3 .bn { color: #ff7a5c; }
.lad-group.lv3 .bt { color: #d96a52; }
.lad-group.lv2 .bn { color: var(--accent); }
.lad-group.lv2 .bt { color: var(--text-dim); }
.lad-group.lv1 .bn { color: var(--text); }
.lad-group.lv1 .bt { color: var(--text-dim); }
.lad-meta { display: flex; align-items: center; gap: 8px; }
.lc { font-size: 11px; color: var(--text-dim); }
.crown {
  font-size: 10px; font-weight: 700; color: #1a1a1a;
  background: linear-gradient(160deg,#ffd76a,#d4af37); border-radius: 4px; padding: 2px 7px;
}
.first-tag { font-size: 10px; color: var(--blue); background: var(--bg-hover); border-radius: 4px; padding: 2px 7px; }
.lad-items { display: flex; flex-wrap: wrap; gap: 6px; }
.stock-chip {
  display: inline-flex; flex-direction: column; gap: 2px; cursor: pointer;
  background: var(--bg-card2); border: 1px solid var(--border); color: var(--text); font-size: 11px;
  padding: 5px 8px; border-radius: 7px; min-width: 108px; text-align: left;
}
.stock-chip:hover { border-color: var(--up); }
.chip-main { display: flex; align-items: baseline; gap: 5px; }
.chip-main .sn { font-weight: 600; font-size: 12px; }
.chip-main .spct { font-size: 10px; font-variant-numeric: tabular-nums; }
.chip-main .sp { font-size: 10px; color: var(--text-dim); font-variant-numeric: tabular-nums; margin-left: auto; }
.chip-sub {
  display: flex; flex-wrap: wrap; align-items: center; gap: 5px;
  font-size: 9.5px; color: var(--text-dim); font-variant-numeric: tabular-nums;
}
.z-ind { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.z-broken { color: var(--accent); font-weight: 700; }
.z-yizi { color: var(--blue); }
.z-fund.strong { color: #ffd76a; }
/* 封板质量染色 */
.stock-chip.early .sn { color: #ffd76a; }            /* 早盘强板 */
.stock-chip.late .sn { color: var(--text-dim); }      /* 尾盘偷袭板 */
.stock-chip.broken { border-color: var(--accent); }    /* 炸过板 */
.stock-chip.strong { border-color: #8a6d1f; }         /* 封单巨大 */
.more-btn {
  background: transparent; border: 1px dashed var(--border-light); color: var(--text-dim);
  font-size: 10px; padding: 4px 10px; border-radius: 7px; cursor: pointer;
}
.more-btn:hover { color: var(--accent); border-color: var(--accent); }

/* 列表 */
.list { display: flex; flex-direction: column; }
.row {
  display: grid; grid-template-columns: 1fr 46px 64px 70px; align-items: center;
  padding: 6px 6px; border-radius: 6px; cursor: pointer; gap: 6px;
}
.row:hover { background: var(--bg-hover); }
.nm { color: var(--text); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd { font-size: 10px; text-align: center; border-radius: 4px; padding: 2px 0; color: var(--up); background: var(--bg-hover); }
.bd.hi { background: var(--up); color: #fff; font-weight: 700; }
.bd.brk { color: var(--accent); background: var(--bg-hover); }
.bd.dn { color: var(--down); background: var(--bg-hover); }
.pr { text-align: right; color: var(--text); font-size: 11px; font-variant-numeric: tabular-nums; }
.pct { text-align: right; font-size: 11px; font-variant-numeric: tabular-nums; }
.pct.up { color: var(--up); }
.pct.down { color: var(--down); }
</style>
