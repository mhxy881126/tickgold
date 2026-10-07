<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { fetchAuction, fetchAuctionPage, type AuctionData, type AuctionStock } from "../api/market";
import { useRetryableLoad } from "../composables/useRetryableLoad";

const emit = defineEmits<{ select: [code: string] }>();

const { data, loading, error, load, retry } = useRetryableLoad<AuctionData>(
  () => fetchAuction(),
  { retries: 1, baseDelay: 800 },
);
const tab = ref<"high" | "low" | "amount">("high");
let timer: number | undefined;

const page = ref(1);
const loadingMore = ref(false);
const hasMore = ref(true);
const extraList = ref<AuctionStock[]>([]);
const bodyEl = ref<HTMLElement | null>(null);

const phase = computed(() => {
  const now = new Date();
  const day = now.getDay();
  const hm = now.getHours() * 60 + now.getMinutes();
  if (day === 0 || day === 6) return { label: "周末休市", live: false, stage: "closed" as const };
  if (hm < 9 * 60 + 15) return { label: "盘前待竞价", live: false, stage: "pre" as const };
  if (hm < 9 * 60 + 20) return { label: "9:15-9:20 可撤单", live: true, stage: "cancelable" as const };
  if (hm < 9 * 60 + 25) return { label: "9:20-9:25 不可撤单", live: true, stage: "locked" as const };
  if (hm < 9 * 60 + 30) return { label: "9:25 开盘价已出", live: true, stage: "opened" as const };
  if (hm < 11 * 60 + 30 || (hm >= 13 * 60 && hm < 15 * 60))
    return { label: "连续竞价", live: true, stage: "trading" as const };
  return { label: "已收盘", live: false, stage: "closed" as const };
});

const stats = computed(() => {
  if (!data.value) return null;
  const high = data.value.highOpen;
  const low = data.value.lowOpen;
  const totalAmt = [...high, ...low].reduce((a, s) => a + (s.amount || 0), 0);
  const gt5 = high.filter((s) => s.gap >= 5).length;
  const gt2 = high.filter((s) => s.gap >= 2 && s.gap < 5).length;
  const gt0 = high.filter((s) => s.gap >= 0 && s.gap < 2).length;
  const limitUpOpen = high.filter((s) => s.gap >= 9.8).length;
  const bigAmt = [...high, ...low].filter((s) => s.amount >= 5e8).length;
  // 竞价涨幅中位数
  const allGaps = [...high, ...low].map((s) => s.gap).sort((a, b) => a - b);
  const medianGap = allGaps.length > 0 ? allGaps[Math.floor(allGaps.length / 2)] : 0;
  // 多空比例
  const total = high.length + low.length;
  const bullRatio = total > 0 ? Math.round((high.length / total) * 100) : 50;
  const mood = bullRatio >= 60 ? "偏多" : bullRatio >= 52 ? "中性偏多" : bullRatio >= 48 ? "中性" : bullRatio >= 40 ? "中性偏空" : "偏空";
  return {
    highCount: high.length, lowCount: low.length, totalAmt,
    gt5, gt2, gt0, limitUpOpen, bigAmt, medianGap, bullRatio, mood,
    amountTop: [...high, ...low].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 30),
  };
});

const list = computed<AuctionStock[]>(() => {
  if (!data.value) return [];
  let base: AuctionStock[];
  if (tab.value === "high") base = data.value.highOpen;
  else if (tab.value === "low") base = data.value.lowOpen;
  else return stats.value?.amountTop ?? [];
  const seen = new Set(base.map((s) => s.code));
  const extra = extraList.value.filter((s) => !seen.has(s.code));
  return [...base, ...extra];
});

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function fx(v: number | null | undefined, d = 2): string { return num(v).toFixed(d); }
function money(v: number | null | undefined): string {
  const n = num(v);
  if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(0) + "万";
  return n.toFixed(0);
}
function hhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value || !data.value) return;
  loadingMore.value = true;
  page.value += 1;
  const asc = tab.value === "low" ? 1 : 0;
  try {
    const more = await fetchAuctionPage(page.value, asc);
    if (more.length < 100) hasMore.value = false;
    extraList.value = [...extraList.value, ...more];
  } catch { hasMore.value = false; }
  finally { loadingMore.value = false; }
}

function onScroll() {
  const el = bodyEl.value;
  if (!el) return;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) loadMore();
}

function switchTab(t: "high" | "low" | "amount") {
  tab.value = t;
  page.value = 1;
  extraList.value = [];
  hasMore.value = true;
}

onMounted(() => {
  load();
  timer = window.setInterval(() => { if (phase.value.live) load(); }, 5000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div class="auction">
    <div class="bar">
      <span class="phase" :class="{ live: phase.live }">
        <span v-if="phase.live" class="dot"></span>{{ phase.label }}
      </span>
      <span class="meta" v-if="data">{{ data.total }}只 · {{ hhmmss(data.updated) }}</span>
      <button class="refresh" :class="{ spinning: loading }" :disabled="loading" @click="load">
        <svg v-if="loading" class="spin-icon" viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 7 7" fill="none" stroke="currentColor" stroke-width="2"/></svg>
        <span v-else>刷新</span>
      </button>
    </div>

    <!-- 时间轴 -->
    <div class="timeline">
      <div class="tl-seg" :class="{ on: ['cancelable','locked','opened','trading'].includes(phase.stage) }">
        <span class="tl-time">9:15</span><span class="tl-label">开始竞价</span>
      </div>
      <div class="tl-arrow"></div>
      <div class="tl-seg" :class="{ on: ['locked','opened','trading'].includes(phase.stage) }">
        <span class="tl-time">9:20</span><span class="tl-label">不可撤单</span>
      </div>
      <div class="tl-arrow"></div>
      <div class="tl-seg" :class="{ on: ['opened','trading'].includes(phase.stage) }">
        <span class="tl-time">9:25</span><span class="tl-label">开盘价</span>
      </div>
      <div class="tl-arrow"></div>
      <div class="tl-seg" :class="{ on: phase.stage === 'trading' }">
        <span class="tl-time">9:30</span><span class="tl-label">连续竞价</span>
      </div>
    </div>

    <!-- 情绪条 -->
    <div class="mood-bar" v-if="stats">
      <div class="mood-head">
        <span class="small dim">竞价情绪</span>
        <span class="mood-label" :class="stats.bullRatio>=52?'up':stats.bullRatio<=48?'down':''">{{ stats.mood }}</span>
      </div>
      <div class="mood-track">
        <div class="mood-fill" :class="stats.bullRatio>=52?'up':stats.bullRatio<=48?'down':''" :style="{width: stats.bullRatio + '%'}"></div>
      </div>
      <div class="mood-foot">
        <span class="up num">{{ stats.highCount }} 高开</span>
        <span class="dim num">{{ money(stats.totalAmt) }} 竞价额</span>
        <span class="down num">{{ stats.lowCount }} 低开</span>
      </div>
    </div>

    <!-- 4格指标 -->
    <div class="stat-grid" v-if="stats">
      <div class="stat-cell">
        <div class="stat-label">涨停开盘</div>
        <div class="stat-val up">{{ stats.limitUpOpen }}<span class="unit">只</span></div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">涨幅中位</div>
        <div class="stat-val" :class="stats.medianGap>=0?'up':'down'">{{stats.medianGap>=0?'+':''}}{{ fx(stats.medianGap,1) }}%</div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">高开>5%</div>
        <div class="stat-val up">{{ stats.gt5 }}<span class="unit">只</span></div>
      </div>
      <div class="stat-cell">
        <div class="stat-label">大额抢筹</div>
        <div class="stat-val gold">{{ stats.bigAmt }}<span class="unit">只</span></div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button :class="{on:tab==='high'}" @click="switchTab('high')">高开抢筹</button>
      <button :class="{on:tab==='low'}" @click="switchTab('low')">低开出逃</button>
      <button :class="{on:tab==='amount'}" @click="switchTab('amount')">竞价金额TOP</button>
    </div>

    <div class="grid head">
      <span>名称</span><span>今开</span><span>缺口</span><span>竞价额</span><span>现价</span><span>涨幅</span>
    </div>

    <div class="body" ref="bodyEl" @scroll="onScroll">
      <div v-if="loading && !data" class="empty">拉取中…</div>
      <div v-else-if="error" class="empty err">
        <div>加载失败：{{ error }}</div>
        <button class="retry-btn" @click="retry">重试</button>
      </div>
      <div v-else-if="list.length===0" class="empty">暂无数据</div>
      <template v-else>
        <div v-for="s in list" :key="s.code" class="grid row" @click="emit('select', s.code)">
          <span class="nm">
            {{ s.name }} <i>{{ s.code }}</i>
            <em v-if="num(s.gap)>=9.8" class="tag lu">涨停开</em>
            <em v-else-if="num(s.amount)>=5e8" class="tag big">大额</em>
          </span>
          <span class="num">{{ fx(s.open) }}</span>
          <span class="num" :class="num(s.gap)>=0?'up':'down'">{{num(s.gap)>=0?'+':''}}{{fx(s.gap)}}%</span>
          <span class="num dim">{{ money(s.amount) }}</span>
          <span class="num">{{ fx(s.price) }}</span>
          <span class="num" :class="num(s.pct)>=0?'up':'down'">{{num(s.pct)>=0?'+':''}}{{fx(s.pct)}}%</span>
        </div>
        <div v-if="loadingMore" class="loadmore">加载更多…</div>
        <div v-else-if="!hasMore && list.length > 30" class="loadmore end">— 已加载全部 —</div>
      </template>
    </div>
    <div class="foot">9:25前为虚拟撮合成交额 · 滚动加载更多</div>
  </div>
</template>

<style scoped>
.auction{display:flex;flex-direction:column;height:100%;font-size:12px;gap:6px}
.bar{display:flex;align-items:center;gap:10px}
.phase{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--text)}
.phase.live{color:var(--up)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--up);animation:pulse 1.1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.meta{font-size:11px;color:var(--text-dim)}
.refresh{margin-left:auto;display:flex;align-items:center;gap:4px;background:var(--bg-hover);border:1px solid var(--border);color:var(--text);font-size:11px;padding:3px 12px;border-radius:6px;cursor:pointer}
.refresh:hover:not(:disabled){border-color:var(--accent)}
.refresh:disabled{opacity:.7;cursor:default}
.spin-icon{width:12px;height:12px;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.timeline{display:flex;align-items:center;gap:2px;padding:4px 0}
.tl-seg{display:flex;flex-direction:column;align-items:center;gap:1px;opacity:.35}
.tl-seg.on{opacity:1}
.tl-time{font-size:10px;font-weight:700;color:var(--accent);font-variant-numeric:tabular-nums}
.tl-label{font-size:9px;color:var(--text-dim)}
.tl-arrow{flex:1;height:1px;background:var(--border);margin:0 2px 8px;min-width:12px}

/* 情绪条 */
.mood-bar{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:8px 10px}
.mood-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.mood-label{font-size:14px;font-weight:700}
.mood-track{height:6px;background:var(--border);border-radius:3px;overflow:hidden;display:flex}
.mood-fill{height:100%;transition:width .3s}
.mood-fill.up{background:linear-gradient(90deg,#f25266,#ff6b81)}
.mood-fill.down{background:linear-gradient(90deg,#22b573,#3ddc97)}
.mood-foot{display:flex;justify-content:space-between;margin-top:5px;font-size:10px}

/* 4格指标 */
.stat-grid{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px}
.stat-cell{background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:7px 8px;text-align:center}
.stat-label{font-size:9px;color:var(--text-dim);margin-bottom:2px}
.stat-val{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.stat-val .unit{font-size:9px;font-weight:400;color:var(--text-dim);margin-left:2px}
.stat-val.up{color:#f25266}
.stat-val.down{color:#22b573}
.stat-val.gold{color:#d2af37}

.tabs{display:flex;gap:4px}
.tabs button{background:none;border:1px solid var(--border);color:var(--text-dim);font-size:11px;cursor:pointer;padding:3px 10px;border-radius:6px}
.tabs button:hover{color:var(--text)}
.tabs button.on{background:rgba(212,175,55,.12);color:var(--accent);border-color:var(--accent)}
.grid{display:grid;grid-template-columns:1.6fr .7fr .8fr .8fr .7fr .8fr;gap:6px;align-items:center}
.head{padding:4px 8px;font-size:10px;color:var(--text-dim);border-bottom:1px solid var(--border)}
.head span:nth-child(n+2){text-align:right}
.body{flex:1;overflow-y:auto}
.empty{color:var(--text-dim);font-size:11px;text-align:center;padding:30px 10px}
.empty.err{color:var(--accent);display:flex;flex-direction:column;align-items:center;gap:10px}
.retry-btn{background:var(--bg-hover);border:1px solid var(--border);color:var(--text);font-size:11px;padding:4px 16px;border-radius:6px;cursor:pointer}
.row{padding:5px 8px;border-radius:6px;cursor:pointer}
.row:hover{background:var(--bg-hover)}
.nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:4px}
.nm i{font-style:normal;font-size:10px;color:var(--text-dim)}
.tag{font-style:normal;font-size:9px;padding:0 4px;border-radius:3px;flex:none}
.tag.lu{background:rgba(242,82,102,.15);color:#f25266}
.tag.big{background:rgba(212,175,55,.15);color:var(--accent)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.num.dim{color:var(--text-dim)}
.up{color:#f25266}.down{color:#22b573}
.foot{font-size:9px;color:var(--text-dim);text-align:right}
.loadmore{text-align:center;font-size:10px;color:var(--text-dim);padding:8px}
.loadmore.end{opacity:.5}
.small{font-size:10px}
.dim{color:var(--text-dim)}
</style>
