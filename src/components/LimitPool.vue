<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { fetchZtPool, fetchZbPool, type ZtPool, type ZtStock } from "../api/market";

const emit = defineEmits<{ select: [code: string] }>();

const zt = ref<ZtPool | null>(null);
const zb = ref<ZtPool | null>(null);
const loading = ref(false);
const error = ref("");
const tab = ref<"zt" | "zb">("zt");

function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const dateStr = ref(todayISO());
function ymd(iso: string): string {
  return iso.replaceAll("-", "");
}

const list = computed<ZtStock[]>(() =>
  tab.value === "zt" ? zt.value?.list ?? [] : zb.value?.list ?? []
);

const maxBoards = computed(() =>
  Math.max(0, ...(zt.value?.list ?? []).map((s) => s.boards))
);
const totalFund = computed(() =>
  (zt.value?.list ?? []).reduce((a, s) => a + s.fund, 0)
);

function money(v: number): string {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(0) + "万";
  return v.toFixed(0);
}
function sealTime(v: number): string {
  if (!v) return "—";
  const s = String(v).padStart(6, "0");
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}
function boardClass(b: number): string {
  if (b >= 5) return "b5";
  if (b >= 3) return "b3";
  if (b === 2) return "b2";
  return "b1";
}

async function load() {
  loading.value = true;
  error.value = "";
  const d = ymd(dateStr.value);
  try {
    const [z, b] = await Promise.all([fetchZtPool(d), fetchZbPool(d)]);
    zt.value = z;
    zb.value = b;
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="pool">
    <!-- 工具条 -->
    <div class="bar">
      <input type="date" v-model="dateStr" class="date" @change="load" />
      <button class="refresh" :disabled="loading" @click="load">
        {{ loading ? "拉取中…" : "刷新" }}
      </button>
    </div>

    <!-- 汇总 -->
    <div class="summary">
      <div class="cell up"><div class="v">{{ zt?.total ?? 0 }}</div><div class="l">涨停</div></div>
      <div class="cell warn"><div class="v">{{ zb?.total ?? 0 }}</div><div class="l">炸板</div></div>
      <div class="cell gold"><div class="v">{{ maxBoards }}</div><div class="l">最高连板</div></div>
      <div class="cell"><div class="v">{{ money(totalFund) }}</div><div class="l">封单资金</div></div>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button :class="{ on: tab === 'zt' }" @click="tab = 'zt'">涨停池 {{ zt?.total ?? 0 }}</button>
      <button :class="{ on: tab === 'zb' }" @click="tab = 'zb'">炸板池 {{ zb?.total ?? 0 }}</button>
    </div>

    <!-- 涨停池表头 -->
    <div v-if="tab === 'zt'" class="grid zt head">
      <span>名称</span><span>连板</span><span>封单额</span><span>首封</span><span>炸板</span><span>换手</span><span>题材</span>
    </div>
    <!-- 炸板池表头 -->
    <div v-else class="grid zb head">
      <span>名称</span><span>现价</span><span>涨幅</span><span>涨停价</span><span>炸板</span><span>首封</span><span>题材</span>
    </div>

    <div class="body">
      <div v-if="loading && !zt && !zb" class="empty">正在拉取涨停池数据…</div>
      <div v-else-if="error" class="empty err">加载失败：{{ error }}</div>
      <div v-else-if="list.length === 0" class="empty">该日期无数据（请选择交易日）</div>

      <!-- 涨停行 -->
      <template v-else-if="tab === 'zt'">
        <div v-for="s in list" :key="s.code" class="grid zt row" @click="emit('select', s.code)">
          <span class="nm">{{ s.name }} <i>{{ s.code }}</i></span>
          <span class="board" :class="boardClass(s.boards)">{{ s.boards }}板</span>
          <span class="num up">{{ money(s.fund) }}</span>
          <span class="num dim">{{ sealTime(s.firstSeal) }}</span>
          <span class="num" :class="s.broken > 0 ? 'warn' : 'dim'">{{ s.broken }}</span>
          <span class="num dim">{{ s.turnover.toFixed(1) }}%</span>
          <span class="tag">{{ s.industry }}</span>
        </div>
      </template>

      <!-- 炸板行 -->
      <template v-else>
        <div v-for="s in list" :key="s.code" class="grid zb row" @click="emit('select', s.code)">
          <span class="nm">{{ s.name }} <i>{{ s.code }}</i></span>
          <span class="num">{{ s.price.toFixed(2) }}</span>
          <span class="num" :class="s.pct >= 0 ? 'up' : 'down'">
            {{ s.pct >= 0 ? "+" : "" }}{{ s.pct.toFixed(2) }}%
          </span>
          <span class="num dim">{{ s.limitPrice.toFixed(2) }}</span>
          <span class="num warn">{{ s.broken }}</span>
          <span class="num dim">{{ sealTime(s.firstSeal) }}</span>
          <span class="tag">{{ s.industry }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pool { display: flex; flex-direction: column; height: 100%; font-size: 12px; }

.bar { display: flex; align-items: center; gap: 10px; }
.date {
  background: var(--bg-hover); border: 1px solid var(--border); color: var(--text);
  font-size: 11px; padding: 3px 8px; border-radius: 6px; color-scheme: dark;
}
.refresh {
  margin-left: auto; background: var(--bg-hover); border: 1px solid var(--border); color: var(--text);
  font-size: 11px; padding: 3px 12px; border-radius: 6px; cursor: pointer;
}
.refresh:disabled { opacity: .6; cursor: default; }
.refresh:hover { border-color: var(--accent); }

.summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 10px 0; }
.cell {
  background: var(--bg-card2); border: 1px solid var(--border); border-radius: 8px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 7px 0;
}
.v { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; }
.l { font-size: 10px; color: var(--text-dim); margin-top: 1px; }
.cell.up .v { color: var(--up); }
.cell.warn .v { color: var(--accent); }
.cell.gold .v { color: #ffd76a; }

.tabs { display: flex; gap: 4px; padding: 4px 0 8px; }
.tabs button {
  background: none; border: none; color: var(--text-dim); font-size: 11px; cursor: pointer;
  padding: 4px 10px; border-radius: 6px;
}
.tabs button:hover { color: var(--text); }
.tabs button.on { background: var(--bg-hover); color: var(--text); font-weight: 600; }

.grid { display: grid; gap: 6px; align-items: center; }
.grid.zt { grid-template-columns: 1.3fr 0.55fr 0.85fr 0.8fr 0.5fr 0.6fr 1fr; }
.grid.zb { grid-template-columns: 1.3fr 0.7fr 0.8fr 0.75fr 0.5fr 0.8fr 1fr; }
.head { padding: 5px 8px; font-size: 10px; color: var(--text-dim); border-bottom: 1px solid var(--border); }
.head span:nth-child(n+2) { text-align: right; }

.body { flex: 1; overflow-y: auto; }
.empty { color: var(--text-dim); font-size: 11px; text-align: center; padding: 30px 10px; }
.empty.err { color: var(--accent); }
.row { padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.row:hover { background: var(--bg-hover); }
.nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm i { font-style: normal; font-size: 10px; color: var(--text-dim); margin-left: 4px; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.num.dim { color: var(--text-dim); }
.up { color: var(--up); }
.down { color: var(--down); }
.warn { color: var(--accent); }
.tag { font-size: 10px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.board { text-align: center; font-size: 10px; border-radius: 4px; padding: 2px 0; }
.board.b5 { background: linear-gradient(160deg,#6b531c,#3d2e12); color: #ffd76a; font-weight: 700; }
.board.b3 { background: linear-gradient(160deg,#5e2a2a,#381a1c); color: #ff7a5c; font-weight: 700; }
.board.b2 { background: var(--bg-hover); color: var(--accent); }
.board.b1 { background: var(--bg-hover); color: var(--text-dim); }
</style>
