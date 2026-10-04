<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { fetchQuotes, type AlertEvent } from "../api/market";
import { signalList } from "../ai/api";
import { brokerListOrders } from "../broker/api";
import type { BrokerOrderInfo } from "../broker/api";
import { useWatchlistStore } from "../stores/watchlist";
import type { Quote } from "../api/types";

const wl = useWatchlistStore();
const win = getCurrentWindow();

const quotes = ref<Quote[]>([]);
const idx = ref(0);
const expanded = ref(false);
// loading=首次加载 ready=就绪（含空自选） error=失败可重试
const phase = ref<"loading" | "ready" | "error">("loading");
const errMsg = ref("");

// 预警事件（最新在前，最多保留 20 条）
const alertEvents = ref<AlertEvent[]>([]);
const alertMode = ref(true); // 折叠态有预警时优先展示预警
let pollTimer: number | null = null;
let rotateTimer: number | null = null;
let unlistenAlert: (() => void) | null = null;
let unlistenWatch: (() => void) | null = null;
let unlistenSignal: (() => void) | null = null;
let unlistenSignalUpdated: (() => void) | null = null;
let signalSyncTimer: number | null = null;

// 待人工确认的交易信号（最新在前，≤20）
interface SignalEvent {
  sigId: string;
  code: string;
  name: string;
  side: string;
  source: string;
  price: number;
  vol: number;
  time: number;
}
const signalEvents = ref<SignalEvent[]>([]);
const signalMode = ref(true);
// v2.5 活跃券商委托（报单中/已报/部分成交）
const activeOrders = ref<BrokerOrderInfo[]>([]);

function bkLabel(s: string): string {
  return (
    { submitting: "报单中", submitted: "已报", part_filled: "部分成交" } as Record<string, string>
  )[s] || s;
}
async function syncOrders() {
  try {
    const all = await brokerListOrders(null);
    activeOrders.value = all.filter((o) =>
      ["submitting", "submitted", "part_filled"].includes(o.status),
    );
  } catch {
    /* 忽略：未初始化不阻断 */
  }
}

const current = computed(() => quotes.value[idx.value] ?? null);
const latestAlert = computed(() => alertEvents.value[0] ?? null);
const latestSignal = computed(() => signalEvents.value[0] ?? null);

function cls(pct: number) {
  if (pct > 0) return "up";
  if (pct < 0) return "down";
  return "flat";
}

async function refresh() {
  try {
    await wl.load(); // 每次从 SQLite 读取最新自选（主窗口可能已增删）
    if (wl.codes.length === 0) {
      quotes.value = [];
      phase.value = "ready";
      return;
    }
    const list = await fetchQuotes(wl.codes);
    quotes.value = list.sort((a, b) => b.pct - a.pct);
    if (idx.value >= quotes.value.length) idx.value = 0;
    phase.value = "ready";
  } catch (e: any) {
    errMsg.value = String(e?.message || e || "加载失败");
    phase.value = quotes.value.length > 0 ? "ready" : "error";
  }
}

async function retry() {
  phase.value = "loading";
  await refresh();
}

function rotate() {
  // 信号 / 预警展示中不轮播行情
  if ((signalMode.value && signalEvents.value.length)
    || (alertMode.value && alertEvents.value.length)) return;
  if (quotes.value.length > 1 && !expanded.value) {
    idx.value = (idx.value + 1) % quotes.value.length;
  }
}

async function toggleExpand() {
  expanded.value = !expanded.value;
  const h = expanded.value ? 340 : 52;
  await win.setSize(new LogicalSize(320, h));
}

function backToQuotes() {
  alertMode.value = false;
  signalMode.value = false;
}

function pick(q: Quote) {
  const i = quotes.value.findIndex((x) => x.code === q.code);
  if (i >= 0) idx.value = i;
  emit("island:select", q.code);
  if (expanded.value) toggleExpand();
}

function pickAlert(e: AlertEvent) {
  emit("island:select", e.code);
  if (expanded.value) toggleExpand();
}

function pickSignal(s: SignalEvent) {
  emit("island:select", s.code);
  emit("island:open-card", "signalbridge");
  if (expanded.value) toggleExpand();
}

// 待确认信号以 DB 为准（事件只负责即时置顶，状态以这里校正）
async function syncSignals() {
  try {
    const list = await signalList("pending", 20);
    signalEvents.value = list.map((t) => ({
      sigId: t.sigId,
      code: t.code,
      name: t.name,
      side: t.side,
      source: t.source,
      price: t.price || t.refPrice,
      vol: t.vol,
      time: t.createdAt,
    }));
    if (list.length) signalMode.value = true;
  } catch {
    /* 查询失败时保留当前展示，等待定时/事件兜底 */
  }
}

function fmtHM(t: number): string {
  return new Date(t).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

onMounted(async () => {
  await refresh();
  pollTimer = window.setInterval(refresh, 3000);
  rotateTimer = window.setInterval(rotate, 3000);

  // 预警触发：置顶 + 自动展开
  unlistenAlert = await listen<AlertEvent>("alert:triggered", (ev) => {
    const e = ev.payload;
    alertEvents.value = [e, ...alertEvents.value].slice(0, 20);
    alertMode.value = true;
    if (!expanded.value) toggleExpand();
  });

  // 自选股增删：立即重新加载并刷新（灵动岛实时同步）
  unlistenWatch = await listen("watch:changed", () => {
    refresh();
  });

  // 新交易信号：置顶 + 自动展开，随后以 DB 校正（去重/补全）
  unlistenSignal = await listen<SignalEvent>("signal:new", (ev) => {
    const s = { ...ev.payload, time: Date.now() };
    signalEvents.value = [s, ...signalEvents.value].slice(0, 20);
    signalMode.value = true;
    if (!expanded.value) toggleExpand();
    void syncSignals();
  });

  // 确认 / 驳回 / 完成：重新从 DB 同步待确认（计数即时回落）
  unlistenSignalUpdated = await listen("signal:updated", () => {
    void syncSignals();
  });

  // 初始 + 定时兜底：重启后恢复待确认、事件丢失时也能收敛
  await syncSignals();
  await syncOrders();
  signalSyncTimer = window.setInterval(() => {
    void syncSignals();
    void syncOrders();
  }, 15000);

  // v2.5 券商委托/成交回报：即时刷新活跃委托
  await listen("broker:event", () => void syncOrders());
  await listen("broker:sidecar", () => void syncOrders());
  await listen("broker:kill", () => void syncOrders());
});
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (rotateTimer) clearInterval(rotateTimer);
  if (unlistenAlert) unlistenAlert();
  if (unlistenWatch) unlistenWatch();
  if (unlistenSignal) unlistenSignal();
  if (unlistenSignalUpdated) unlistenSignalUpdated();
  if (signalSyncTimer) clearInterval(signalSyncTimer);
});
</script>

<template>
  <div class="island" :class="{ open: expanded }">
    <!-- 折叠态 -->
    <div v-if="!expanded" class="bar" data-tauri-drag-region>
      <!-- 待确认信号胶囊（最优先） -->
      <template v-if="signalMode && latestSignal">
        <div class="sg-pill" :class="latestSignal.side === 'BUY' ? 'buy' : 'sell'" data-tauri-drag-region>
          {{ latestSignal.side === "BUY" ? "买" : "卖" }}
        </div>
        <div class="al-nm" data-tauri-drag-region>{{ latestSignal.name }}</div>
        <div class="sg-info" data-tauri-drag-region>
          {{ latestSignal.price.toFixed(2) }}<span v-if="latestSignal.vol"> · {{ latestSignal.vol }}</span>
        </div>
        <button class="mini-btn" title="看行情" @click.stop="backToQuotes">⚡</button>
        <button class="chev" title="展开" @click.stop="toggleExpand">⌄</button>
      </template>

      <!-- 预警胶囊 -->
      <template v-else-if="alertMode && latestAlert">
        <div class="bell" :class="latestAlert.tone" data-tauri-drag-region>
          <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C8.63 5.36 7 7.92 7 11v5l-2 2v1h14v-1l-2-2z"/></svg>
        </div>
        <div class="al-nm" data-tauri-drag-region>{{ latestAlert.name }}</div>
        <div class="al-lb" :class="latestAlert.tone" data-tauri-drag-region>{{ latestAlert.label }}</div>
        <div class="al-px" :class="latestAlert.tone" data-tauri-drag-region>{{ latestAlert.price.toFixed(2) }}</div>
        <button class="mini-btn" title="看行情" @click.stop="backToQuotes">⚡</button>
        <button class="chev" title="展开" @click.stop="toggleExpand">⌄</button>
      </template>

      <!-- 正常行情 -->
      <template v-else-if="phase === 'ready' && current">
        <div class="icon" data-tauri-drag-region>⚡</div>
        <div class="nm" data-tauri-drag-region>{{ current.name }}</div>
        <div class="px" :class="cls(current.pct)" data-tauri-drag-region>{{ current.price.toFixed(2) }}</div>
        <div class="pct" :class="cls(current.pct)" data-tauri-drag-region>
          {{ current.pct > 0 ? "+" : "" }}{{ current.pct.toFixed(2) }}%
        </div>
        <button class="chev" title="展开" @click.stop="toggleExpand">⌄</button>
      </template>

      <!-- 空自选 -->
      <div v-else-if="phase === 'ready'" class="status-line" data-tauri-drag-region>
        <span class="sl-ico">★</span><span>暂无自选 · 主窗口添加</span>
      </div>
      <!-- 失败可重试 -->
      <div v-else-if="phase === 'error'" class="status-line err" @click.stop="retry">
        <span>加载失败 · 点击重试</span>
      </div>
      <!-- 加载中 -->
      <div v-else class="status-line" data-tauri-drag-region>
        <span class="sl-spin"></span><span>加载中…</span>
      </div>
    </div>

    <!-- 展开态 -->
    <div v-else class="open-wrap">
      <!-- 待确认信号区（最优先） -->
      <div v-if="signalEvents.length" class="signal-sec">
        <div class="sec-head">
          <span class="sec-title">
            <span class="sg-dot"></span>
            待确认信号 {{ signalEvents.length }}
          </span>
        </div>
        <div class="signal-list">
          <div
            v-for="s in signalEvents"
            :key="s.sigId"
            class="signal-row"
            :class="s.side === 'BUY' ? 'buy' : 'sell'"
            @click="pickSignal(s)"
          >
            <span class="sr-side">{{ s.side === "BUY" ? "买入" : "卖出" }}</span>
            <span class="sr-nm">{{ s.name }}</span>
            <span class="sr-px">{{ s.price.toFixed(2) }}</span>
            <span v-if="s.vol" class="sr-vol">x{{ s.vol }}</span>
            <span class="sr-src">{{ s.source }}</span>
          </div>
        </div>
      </div>

      <!-- v2.5 活跃券商委托 -->
      <div v-if="activeOrders.length" class="broker-sec">
        <div class="sec-head">
          <span class="sec-title">
            <span class="bk-dot"></span>
            券商委托 {{ activeOrders.length }}
          </span>
        </div>
        <div class="bk-list">
          <div
            v-for="o in activeOrders"
            :key="o.sigId"
            class="bk-row"
            :class="`bk-${o.status}`"
          >
            <span class="bk-state">{{ bkLabel(o.status) }}</span>
            <span class="bk-code">{{ o.code }}</span>
            <span class="bk-fill">{{ o.filledVol }}/{{ o.vol }}</span>
          </div>
        </div>
      </div>

      <!-- 预警区 -->
      <div v-if="alertEvents.length" class="alert-sec">
        <div class="sec-head">
          <span class="sec-title">
            <span class="bell-ico">
              <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C8.63 5.36 7 7.92 7 11v5l-2 2v1h14v-1l-2-2z"/></svg>
            </span>
            预警 {{ alertEvents.length }}
          </span>
        </div>
        <div class="alert-list">
          <div
            v-for="(e, i) in alertEvents"
            :key="i"
            class="alert-row"
            :class="e.tone"
            @click="pickAlert(e)"
          >
            <span class="ar-bar"></span>
            <span class="ar-time">{{ fmtHM(e.time) }}</span>
            <span class="ar-lb">{{ e.label }}</span>
            <span class="ar-msg">{{ e.name }} {{ e.price.toFixed(2) }}</span>
          </div>
        </div>
      </div>

      <!-- 自选行情区 -->
      <div class="quote-head" data-tauri-drag-region @click="toggleExpand">
        <span class="head-title">
          <span class="head-icon">⚡</span>
          智能异动提醒
        </span>
        <span class="head-right">
          <span class="head-count">{{ quotes.length }} 只</span>
          <button class="chev up" title="收起">⌃</button>
        </span>
      </div>
      <div class="open-list">
        <div
          v-for="q in quotes"
          :key="q.code"
          class="row"
          :class="{ active: current && q.code === current.code }"
          @click="pick(q)"
        >
          <span class="arrow" :class="cls(q.pct)">{{ q.pct > 0 ? "↑" : "↓" }}</span>
          <span class="rnm">{{ q.name }}</span>
          <span class="rpct" :class="cls(q.pct)">{{ q.pct > 0 ? "+" : "" }}{{ q.pct.toFixed(2) }}%</span>
        </div>
        <div v-if="quotes.length === 0" class="empty">主窗口添加自选股</div>
      </div>
    </div>
  </div>
</template>

<style>
html,
body,
#app {
  background: transparent !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
}
</style>

<style scoped>
.island {
  height: 100%;
  font-size: 13px;
  color: #e6edf3;
  user-select: none;
}

/* 折叠态 */
.bar {
  height: 52px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  background: linear-gradient(135deg, #1a1500 0%, #2a2000 100%);
  border: 1px solid #ffd700;
  border-radius: 999px;
  animation: pulse-gold 2s ease-in-out infinite;
}
@keyframes pulse-gold {
  0%, 100% { box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
  50% { box-shadow: 0 4px 30px rgba(255, 215, 0, 0.3); }
}
.icon {
  width: 22px; height: 22px;
  background: linear-gradient(135deg, #ffd700, #ffaa00);
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: #000; font-weight: 700;
}
.nm { font-weight: 600; max-width: 80px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: #ffd700; }
.px { font-variant-numeric: tabular-nums; font-weight: 600; }
.pct { font-variant-numeric: tabular-nums; margin-left: auto; font-weight: 600; }
.chev {
  background: transparent; border: none; color: #ffd700;
  font-size: 16px; cursor: pointer; padding: 2px 4px; line-height: 1;
}
.chev:hover { color: #ffaa00; }
.mini-btn {
  background: transparent; border: 1px solid rgba(255,215,0,.4); color: #ffd700;
  border-radius: 50%; width: 20px; height: 20px; font-size: 10px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; padding: 0;
}

/* 预警胶囊 */
.bell { color: #ff5a5a; display: flex; }
.bell.down { color: #ff7043; }
.al-nm { font-weight: 700; max-width: 76px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.al-lb { font-size: 11px; font-weight: 700; }
.al-lb.up { color: #ff5a5a; }
.al-lb.down { color: #ff7043; }
.al-px { font-variant-numeric: tabular-nums; font-weight: 700; margin-left: auto; }
.al-px.up { color: #ff5a5a; }
.al-px.down { color: #ff7043; }

/* 状态行 */
.status-line {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
  color: #ffd700;
}
.status-line.err { cursor: pointer; color: #ff8a98; }
.sl-ico { color: #ffd700; }
.sl-spin {
  width: 12px; height: 12px; border: 2px solid rgba(255,215,0,.3);
  border-top-color: #ffd700; border-radius: 50%; animation: ispin .8s linear infinite;
}
@keyframes ispin { to { transform: rotate(360deg); } }

/* 展开态 */
.open-wrap {
  height: 340px;
  display: flex; flex-direction: column;
  background: linear-gradient(135deg, #1a1500 0%, #2a2000 100%);
  border: 1px solid #ffd700;
  border-radius: 28px;
  overflow: hidden;
}

/* 预警区 */
.alert-sec { border-bottom: 1px solid rgba(255,215,0,.2); flex-shrink: 0; }
.sec-head { padding: 10px 16px 4px; }
.sec-title { display: flex; align-items: center; gap: 6px; color: #ffd700; font-size: 12px; font-weight: 700; }
.bell-ico { color: #ff5a5a; display: flex; }
.alert-list { max-height: 118px; overflow-y: auto; padding-bottom: 4px; }
.alert-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 16px; cursor: pointer; position: relative;
}
.alert-row:hover { background: rgba(255,215,0,.07); }
.ar-bar { width: 3px; height: 22px; border-radius: 2px; background: #ff5a5a; flex-shrink: 0; }
.alert-row.down .ar-bar { background: #ff7043; }
.ar-time { color: #8b98a5; font-size: 10px; font-variant-numeric: tabular-nums; width: 38px; }
.ar-lb { font-size: 11px; font-weight: 700; width: 58px; color: #ff5a5a; }
.alert-row.down .ar-lb { color: #ff7043; }
.ar-msg { font-size: 11px; color: #c9d1d9; margin-left: auto; font-variant-numeric: tabular-nums; }

/* 行情区 */
.quote-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; cursor: pointer; flex-shrink: 0;
}
.head-right { display: flex; align-items: center; gap: 8px; }
.head-title { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #ffd700; }
.head-icon {
  width: 20px; height: 20px;
  background: linear-gradient(135deg, #ffd700, #ffaa00);
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: #000; font-weight: 700;
}
.head-count {
  background: linear-gradient(135deg, #ffd700, #ffaa00);
  color: #000; font-size: 10px; font-weight: 600;
  padding: 2px 8px; border-radius: 10px;
}
.open-list { flex: 1; overflow-y: auto; padding-bottom: 8px; }
.row { display: flex; align-items: center; gap: 8px; padding: 7px 16px; cursor: pointer; }
.row:hover { background: rgba(255, 215, 0, 0.08); }
.row.active { background: rgba(255, 215, 0, 0.15); }
.arrow { font-size: 12px; width: 16px; text-align: center; }
.rnm { max-width: 110px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rpct { font-variant-numeric: tabular-nums; margin-left: auto; width: 72px; text-align: right; }
.empty { text-align: center; color: #ffd700; padding: 30px 10px; font-size: 12px; }

.up { color: #ef5350; }
.down { color: #26a69a; }
.flat { color: #8b98a5; }

/* 待确认信号胶囊 */
.sg-pill {
  font-weight: 800; font-size: 11px; width: 22px; height: 22px;
  border-radius: 50%; display: flex; align-items: center; justify-content: center;
}
.sg-pill.buy { background: #ff3b46; color: #fff; }
.sg-pill.sell { background: #1fbf75; color: #fff; }
.sg-info {
  font-variant-numeric: tabular-nums; font-weight: 700;
  margin-left: auto; color: #ffd700; font-size: 12px;
}

/* 展开态 待确认信号区 */
.broker-sec { border-bottom: 1px solid rgba(106,166,232,.2); flex-shrink: 0; }
.bk-list { padding-bottom: 4px; }
.bk-row { display: flex; align-items: center; gap: 8px; padding: 5px 16px; font-size: 11px; }
.bk-row .bk-state { font-weight: 800; color: #6aa6e8; min-width: 56px; }
.bk-row .bk-code { color: #e6ecf5; font-variant-numeric: tabular-nums; }
.bk-row .bk-fill { color: #97a0b2; font-variant-numeric: tabular-nums; }
.bk-submitting .bk-state { color: #97a0b2; }
.bk-part_filled .bk-state { color: #ffb13d; }
.bk-dot {
  display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  background: #6aa6e8; margin-right: 5px;
}
.signal-sec { border-bottom: 1px solid rgba(255,215,0,.2); flex-shrink: 0; }.signal-list { max-height: 128px; overflow-y: auto; padding-bottom: 4px; }
.signal-row { display: flex; align-items: center; gap: 8px; padding: 6px 16px; cursor: pointer; }
.signal-row:hover { background: rgba(255,215,0,.07); }
.sr-side { font-size: 10px; font-weight: 800; padding: 1px 6px; border-radius: 5px; }
.signal-row.buy .sr-side { background: #ff3b46; color: #fff; }
.signal-row.sell .sr-side { background: #1fbf75; color: #fff; }
.sr-nm { font-size: 11px; color: #c9d1d9; }
.sr-px { font-size: 11px; color: #ffd700; font-variant-numeric: tabular-nums; margin-left: auto; }
.sr-vol { font-size: 10px; color: #8b98a5; font-variant-numeric: tabular-nums; }
.sr-src {
  font-size: 10px; color: #8b98a5; border: 1px solid rgba(255,215,0,.25);
  border-radius: 5px; padding: 0 5px;
}
.sg-dot {
  width: 8px; height: 8px; border-radius: 50%; background: #ffb13d;
  box-shadow: 0 0 6px rgba(255,177,61,.8);
}
</style>
