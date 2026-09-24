<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { fetchAuction, type AuctionData, type AuctionStock } from "../api/market";

const emit = defineEmits<{ select: [code: string] }>();

const data = ref<AuctionData | null>(null);
const loading = ref(false);
const error = ref("");
const tab = ref<"high" | "low">("high");
let timer: number | undefined;

const phase = computed(() => {
  const now = new Date();
  const day = now.getDay();
  const hm = now.getHours() * 60 + now.getMinutes();
  if (day === 0 || day === 6) return { label: "休市 · 周末", live: false };
  if (hm < 9 * 60 + 15) return { label: "盘前待开盘", live: false };
  if (hm < 9 * 60 + 25) return { label: "集合竞价进行中", live: true };
  if (hm < 11 * 60 + 30 || (hm >= 13 * 60 && hm < 15 * 60))
    return { label: "连续竞价", live: true };
  return { label: "已收盘 · 展示开盘缺口", live: false };
});

const list = computed<AuctionStock[]>(() => {
  if (!data.value) return [];
  return tab.value === "high" ? data.value.highOpen : data.value.lowOpen;
});

function money(v: number): string {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(0) + "万";
  return v.toFixed(0);
}
function hhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await fetchAuction();
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
  // 竞价/盘中自动每 10s 刷新
  timer = window.setInterval(() => {
    if (phase.value.live) load();
  }, 10000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="auction">
    <!-- 状态条 -->
    <div class="bar">
      <span class="phase" :class="{ live: phase.live }">
        <span v-if="phase.live" class="dot"></span>{{ phase.label }}
      </span>
      <span class="meta">全市场 {{ data?.total ?? "—" }} 只</span>
      <span class="meta" v-if="data">更新 {{ hhmmss(data.updated) }}</span>
      <button class="refresh" :disabled="loading" @click="load">
        {{ loading ? "拉取中…" : "刷新" }}
      </button>
    </div>

    <!-- 口径提示 -->
    <div class="caliber">
      开盘缺口 =（今开 − 昨收）/ 昨收；9:25 定格时「成交额」即竞价成交额，其余时段/盘后为累计成交额。
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button :class="{ on: tab === 'high' }" @click="tab = 'high'">
        高开抢筹 {{ data?.highOpen.length ?? 0 }}
      </button>
      <button :class="{ on: tab === 'low' }" @click="tab = 'low'">
        低开出逃 {{ data?.lowOpen.length ?? 0 }}
      </button>
    </div>

    <!-- 表头 -->
    <div class="grid head">
      <span>名称</span><span>今开</span><span>缺口</span><span>成交额</span><span>现价</span><span>涨幅</span>
    </div>

    <div class="body">
      <div v-if="loading && !data" class="empty">正在拉取全市场竞价数据…</div>
      <div v-else-if="error" class="empty err">加载失败：{{ error }}</div>
      <div v-else-if="list.length === 0" class="empty">暂无数据</div>
      <template v-else>
        <div
          v-for="s in list"
          :key="s.code"
          class="grid row"
          @click="emit('select', s.code)"
        >
          <span class="nm">{{ s.name }} <i>{{ s.code }}</i></span>
          <span class="num">{{ s.open.toFixed(2) }}</span>
          <span class="num" :class="s.gap >= 0 ? 'up' : 'down'">
            {{ s.gap >= 0 ? "+" : "" }}{{ s.gap.toFixed(2) }}%
          </span>
          <span class="num dim">{{ money(s.amount) }}</span>
          <span class="num">{{ s.price.toFixed(2) }}</span>
          <span class="num" :class="s.pct >= 0 ? 'up' : 'down'">
            {{ s.pct >= 0 ? "+" : "" }}{{ s.pct.toFixed(2) }}%
          </span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.auction { display: flex; flex-direction: column; height: 100%; font-size: 12px; }

.bar { display: flex; align-items: center; gap: 10px; }
.phase { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--text); }
.phase.live { color: var(--up); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--up); animation: pulse 1.1s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
.meta { font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.refresh {
  margin-left: auto; background: var(--bg-hover); border: 1px solid var(--border); color: var(--text);
  font-size: 11px; padding: 3px 12px; border-radius: 6px; cursor: pointer;
}
.refresh:disabled { opacity: .6; cursor: default; }
.refresh:hover { border-color: var(--accent); }

.caliber { margin: 8px 0 4px; font-size: 10px; color: var(--text-dim); line-height: 1.5; }

.tabs { display: flex; gap: 4px; padding: 6px 0 8px; }
.tabs button {
  background: none; border: none; color: var(--text-dim); font-size: 11px; cursor: pointer;
  padding: 4px 10px; border-radius: 6px;
}
.tabs button:hover { color: var(--text); }
.tabs button.on { background: var(--bg-hover); color: var(--text); font-weight: 600; }

.grid { display: grid; grid-template-columns: 1.4fr 0.8fr 0.9fr 0.9fr 0.8fr 0.9fr; gap: 6px; align-items: center; }
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
</style>
