<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import { fetchQuotes, type AlertEvent } from "../api/market";
import { signalList } from "../ai/api";
import { useWatchlistStore } from "../stores/watchlist";
import { brokerListOrders } from "../broker/api";
import type { BrokerOrderInfo } from "../broker/api";
import type { Quote } from "../api/types";
import { applyIslandSkin, ISLAND_SKIN_EVENT } from "../lib/islandSkins";
import { usePaperStore, type PaperOrder } from "../stores/paper";
import { listRules } from "../alert/repo";
import { useAlertV2Store, type AlertHistoryRow } from "../stores/alertV2";
import type { CoTriggerEvent } from "../broker/co";

const wl = useWatchlistStore();
const win = getCurrentWindow();
const alertStore = useAlertV2Store();

const quotes = ref<Quote[]>([]);
const idx = ref(0);
const expanded = ref(false);
// loading=首次加载 ready=就绪（含空自选） error=失败可重试
const phase = ref<"loading" | "ready" | "error">("loading");
const errMsg = ref("");

// 预警事件（最新在前，最多保留 20 条）
const alertEvents = ref<AlertEvent[]>([]);
const alertMode = ref(true); // 折叠态有预警时优先展示预警
const enabledRuleCount = ref(0); // 已启用预警规则数（用于空态提示）
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

// 模拟交易委托（最近 10 笔）
const paper = usePaperStore();
const recentOrders = ref<PaperOrder[]>([]);
// 实盘券商活跃委托
const activeOrders = ref<BrokerOrderInfo[]>([]);
function bkLabel(s: string): string {
  return (
    { submitting: "报单中", submitted: "已报", part_filled: "部分成交", filled: "已成", cancelled: "已撤", rejected: "已拒" } as Record<string, string>
  )[s] || s;
}
async function syncOrders() {
  try {
    // 模拟交易委托（本地 SQLite）
    await paper.load();
    recentOrders.value = [...paper.orders].slice(0, 10);
    // 实盘券商活跃委托（如果连了）
    const all = await brokerListOrders(null).catch(() => [] as BrokerOrderInfo[]);
    activeOrders.value = all.filter((o) =>
      ["submitting", "submitted", "part_filled", "filled"].includes(o.status),
    );
  } catch (e) {
    console.error("sync orders failed", e);
  }
}

// ===== D 版：tabs 分段控制器 =====
type TabId = "alert" | "signal" | "order";
const activeTab = ref<TabId>("alert");

const current = computed(() => quotes.value[idx.value] ?? null);
const latestAlert = computed(() => alertEvents.value[0] ?? null);
const latestSignal = computed(() => signalEvents.value[0] ?? null);
// 委托角标：仅统计在途委托（模拟即时成交无在途；实盘按未完成状态）
const liveActiveCount = computed(() =>
  activeOrders.value.filter((o) =>
    ["submitting", "submitted", "part_filled"].includes(o.status)
  ).length
);

function cls(pct: number) {
  if (pct > 0) return "up";
  if (pct < 0) return "down";
  return "flat";
}

// ===== 皮肤（已移至 设置-外观） =====
// 启动时读 localStorage 应用皮肤即可，切换在 SettingsDialog 里完成

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
  const h = expanded.value ? 400 : 52;
  await win.setSize(new LogicalSize(320, h));
}

function backToQuotes() {
  alertMode.value = false;
  signalMode.value = false;
}

// ===== 底部按钮实际功能 =====
// 预警 tab
function openAllAlerts() {
  emit("island:open-card", "alert");
  if (expanded.value) toggleExpand();
}
function pinTopAlert() {
  if (!latestAlert.value) return;
  emit("island:select", latestAlert.value.code);
  if (expanded.value) toggleExpand();
}
// 信号 tab
async function dismissSignal() {
  if (!latestSignal.value) return;
  const sid = latestSignal.value.sigId;
  signalEvents.value = signalEvents.value.filter((s) => s.sigId !== sid);
  try {
    const { signalReject } = await import("../ai/api");
    const numId = parseInt(sid, 10);
    if (!isNaN(numId)) await signalReject(numId, "手动忽略");
  } catch (e) {
    console.error("signal reject failed", e);
  }
}
function oneClickTrade() {
  emit("island:open-card", "signalbridge");
  if (expanded.value) toggleExpand();
}
// 委托 tab
async function cancelAllOrders() {
  try {
    const { brokerKillSwitch } = await import("../broker/api");
    await brokerKillSwitch(true);
    void syncOrders();
  } catch (e) {
    console.error("cancel all failed", e);
  }
}
function openTrade() {
  emit("island:open-card", "trade");
  if (expanded.value) toggleExpand();
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

// ===== 预警回补：以 DB(alert_event) 为基线，事件只负责即时置顶 =====
function rowToAlert(h: AlertHistoryRow): AlertEvent {
  return {
    time: h.triggeredAt ?? 0,
    id: String(h.id),
    code: h.code ?? "",
    name: h.name ?? "",
    kind: h.kind ?? "",
    label: h.label ?? "",
    message: h.message ?? "",
    price: h.price ?? 0,
    pct: h.pct ?? 0,
    target: h.target ?? 0,
    tone: h.tone ?? "flat",
  };
}
async function syncAlerts() {
  try {
    await alertStore.loadHistory(20);
    const rows = alertStore.history;
    // 事件刚到、DB 尚未可见时，保留比 DB 基线更新的即时事件，避免被回补抹掉
    const dbMax = rows.length ? rows[0].triggeredAt ?? 0 : 0;
    const extras = alertEvents.value.filter((e) => e.time > dbMax);
    alertEvents.value = [...extras, ...rows.map(rowToAlert)].slice(0, 20);
  } catch (e) {
    console.error("sync alerts failed", e);
  }
}

function fmtHM(t: number): string {
  return new Date(t).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function fetchRuleCount() {
  try {
    const rules = await listRules();
    enabledRuleCount.value = rules.filter((r) => r.enabled).length;
  } catch (e) {
    console.error("fetch rule count failed", e);
  }
}

// 收起态显示内容优先级：信号 > 预警 > 正常行情
const collapsedMode = computed<"signal" | "alert" | "quote" | "empty" | "loading" | "error">(() => {
  if (phase.value === "error") return "error";
  if (phase.value === "loading") return "loading";
  if (signalMode.value && latestSignal.value) return "signal";
  if (alertMode.value && latestAlert.value) return "alert";
  if (phase.value === "ready" && current.value) return "quote";
  return "empty";
});

onMounted(async () => {
  applyIslandSkin();
  await refresh();
  void fetchRuleCount();
  pollTimer = window.setInterval(refresh, 3000);
  rotateTimer = window.setInterval(rotate, 3000);

  // 预警触发：置顶 + 自动展开
  unlistenAlert = await listen<AlertEvent>("alert:triggered", (ev) => {
    const e = ev.payload;
    alertEvents.value = [e, ...alertEvents.value].slice(0, 20);
    alertMode.value = true;
    activeTab.value = "alert";
    if (!expanded.value) toggleExpand();
    void syncAlerts();
  });

  // 条件单触发：自动展开；模拟自动成交→委托 tab，否则→信号 tab 待人工确认
  await listen<CoTriggerEvent>("co:triggered", (ev) => {
    const c = ev.payload;
    if (!expanded.value) toggleExpand();
    if (c.autoConfirm && c.matched) {
      activeTab.value = "order";
      void syncOrders();
    } else {
      activeTab.value = "signal";
      signalMode.value = true;
      void syncSignals();
    }
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
    activeTab.value = "signal";
    if (!expanded.value) toggleExpand();
    void syncSignals();
  });

  // 确认 / 驳回 / 完成：重新从 DB 同步待确认（计数即时回落）
  unlistenSignalUpdated = await listen("signal:updated", () => {
    void syncSignals();
  });

  // 初始 + 定时兜底：重启后恢复待确认/预警、事件丢失时也能收敛
  await syncSignals();
  void syncAlerts();
  signalSyncTimer = window.setInterval(() => {
    void syncSignals(); void syncOrders(); void syncAlerts();
  }, 15000);

  // v2.6 活跃券商委托：定时 + 事件驱动同步
  void syncOrders();
  await listen("broker:event", () => void syncOrders());
  await listen("broker:sidecar", () => void syncOrders());
  await listen("broker:kill", () => void syncOrders());

  // 主窗口切换灵动岛皮肤：立即重新应用
  await listen(ISLAND_SKIN_EVENT, () => {
    applyIslandSkin();
  });
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
    <!-- ===== 收起态 ===== -->
    <div v-if="!expanded" class="pill" data-tauri-drag-region @click="toggleExpand">
      <!-- 信号 -->
      <template v-if="collapsedMode === 'signal' && latestSignal">
        <div class="avatar" :class="latestSignal.side === 'BUY' ? 'buy' : 'sell'">
          {{ latestSignal.name.slice(0, 1) }}
        </div>
        <div class="info">
          <div class="n">{{ latestSignal.name }}</div>
          <div class="p">{{ latestSignal.price.toFixed(2) }}</div>
        </div>
        <span class="chg" :class="latestSignal.side === 'BUY' ? 'up' : 'down'">
          {{ latestSignal.side === "BUY" ? "买入" : "卖出" }}
        </span>
      </template>

      <!-- 预警 -->
      <template v-else-if="collapsedMode === 'alert' && latestAlert">
        <div class="avatar" :class="latestAlert.tone">{{ latestAlert.name.slice(0, 1) }}</div>
        <div class="info">
          <div class="n">{{ latestAlert.name }}</div>
          <div class="p">{{ latestAlert.price.toFixed(2) }}</div>
        </div>
        <span class="chg" :class="latestAlert.tone">{{ latestAlert.label }}</span>
      </template>

      <!-- 正常行情 -->
      <template v-else-if="collapsedMode === 'quote' && current">
        <div class="avatar">{{ current.name.slice(0, 1) }}</div>
        <div class="info">
          <div class="n">{{ current.name }}</div>
          <div class="p">{{ current.price.toFixed(2) }}</div>
        </div>
        <span class="chg" :class="cls(current.pct)">
          {{ current.pct > 0 ? "+" : "" }}{{ current.pct.toFixed(2) }}%
        </span>
      </template>

      <!-- 空/加载/错误 -->
      <div v-else class="status-line" data-tauri-drag-region>
        <span v-if="collapsedMode === 'loading'" class="sl-spin"></span>
        <span>{{ collapsedMode === 'error' ? '加载失败·点击重试' : collapsedMode === 'empty' ? '暂无自选' : '加载中…' }}</span>
      </div>

      <span class="chev">⌄</span>
    </div>

    <!-- ===== 展开态 ===== -->
    <div v-else class="open-wrap">
      <!-- 头部：当前股票 + 收起按钮 -->
      <div class="head" data-tauri-drag-region>
        <div class="head-left" v-if="current">
          <div class="avatar sm">{{ current.name.slice(0, 1) }}</div>
          <span class="head-name">{{ current.name }}</span>
          <span class="head-px">{{ current.price.toFixed(2) }}</span>
          <span class="chg" :class="cls(current.pct)">
            {{ current.pct > 0 ? "+" : "" }}{{ current.pct.toFixed(2) }}%
          </span>
        </div>
        <button class="chev up" title="收起" @click.stop="toggleExpand">⌃</button>
      </div>

      <!-- tabs 分段控制器 -->
      <div class="tabs">
        <div
          class="tab"
          :class="{ active: activeTab === 'alert' }"
          @click="activeTab = 'alert'"
        >预警<span class="count">{{ alertEvents.length }}</span></div>
        <div
          class="tab"
          :class="{ active: activeTab === 'signal' }"
          @click="activeTab = 'signal'"
        >信号<span class="count">{{ signalEvents.length }}</span></div>
        <div
          class="tab"
          :class="{ active: activeTab === 'order' }"
          @click="activeTab = 'order'"
        >委托<span v-if="liveActiveCount > 0" class="count">{{ liveActiveCount }}</span></div>
      </div>

      <!-- 预警列表 -->
      <div v-if="activeTab === 'alert'" class="tab-body">
        <div
          v-for="(e, i) in alertEvents"
          :key="i"
          class="alert-row"
          @click="pickAlert(e)"
        >
          <span class="dir" :class="e.tone">{{ e.tone === 'up' ? '↑' : '↓' }}</span>
          <span class="desc"><b>{{ e.name }}</b> {{ e.label }}</span>
          <span class="val" :class="e.tone">{{ e.price.toFixed(2) }}</span>
        </div>
        <div v-if="alertEvents.length === 0" class="empty">
          暂无触发预警<br><span style="opacity:.6">已启用 {{ enabledRuleCount }} 条规则，运行中</span>
        </div>
      </div>

      <!-- 信号列表 -->
      <div v-else-if="activeTab === 'signal'" class="tab-body">
        <div
          v-for="s in signalEvents"
          :key="s.sigId"
          class="sig-row"
          :class="s.side === 'BUY' ? 'buy' : 'sell'"
          @click="pickSignal(s)"
        >
          <div class="sig-head">
            <span class="sig-name">{{ s.name }}</span>
            <span class="sig-side">{{ s.side === "BUY" ? "买入" : "卖出" }}</span>
          </div>
          <div class="sig-meta">{{ s.source }} · {{ s.price.toFixed(2) }}<span v-if="s.vol"> · ×{{ s.vol }}</span></div>
        </div>
        <div v-if="signalEvents.length === 0" class="empty">暂无待确认信号</div>
      </div>

      <!-- 委托列表：模拟 + 实盘分组 -->
      <div v-else class="tab-body">
        <div class="order-group-title">模拟交易</div>
        <div v-for="o in recentOrders" :key="o.id" class="order-row">
          <span class="ord-code">
            <span :class="o.side === 'buy' ? 'up' : 'down'">{{ o.side === 'buy' ? '买' : '卖' }}</span>
            {{ o.name }} {{ o.vol }}股
          </span>
          <span class="ord-st">{{ bkLabel(o.status) }}</span>
        </div>
        <div v-if="recentOrders.length === 0" class="empty-sm">暂无模拟委托</div>

        <div class="order-group-title">实盘交易</div>
        <div v-for="o in activeOrders" :key="o.sigId" class="order-row">
          <span class="ord-code">{{ o.code }} {{ o.filledVol }}/{{ o.vol }}</span>
          <span class="ord-st live">{{ bkLabel(o.status) }}</span>
        </div>
        <div v-if="activeOrders.length === 0" class="empty-sm">未连接实盘</div>
      </div>

      <!-- 底部操作：按 tab 切换 -->
      <div class="actions">
        <template v-if="activeTab === 'alert'">
          <div class="btn" @click="openAllAlerts">查看全部</div>
          <div class="btn primary" @click="pinTopAlert">一键置顶</div>
        </template>
        <template v-else-if="activeTab === 'signal'">
          <div class="btn" @click="dismissSignal">忽略</div>
          <div class="btn primary" @click="oneClickTrade">一键下单</div>
        </template>
        <template v-else>
          <div class="btn" @click="cancelAllOrders">撤全部</div>
          <div class="btn primary" @click="openTrade">打开交易</div>
        </template>
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
  color: #e8eaed;
  user-select: none;
  --bg-from: #1a1f2e;
  --bg-to: #0d1018;
  --border: rgba(212,175,55,.35);
  --accent: #d4af37;
  --accent-soft: #e8c96a;
  --avatar-from: #d4af37;
  --avatar-to: #8a6d1f;
}

/* ===== 收起态胶囊 ===== */
.pill {
  height: 52px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  background: linear-gradient(135deg, var(--bg-from), var(--bg-to));
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  transition: box-shadow .2s;
}
.pill:hover { box-shadow: 0 8px 32px rgba(0,0,0,.5); }

.avatar {
  width: 28px; height: 28px; border-radius: 50%;
  background: linear-gradient(135deg, var(--avatar-from), var(--avatar-to));
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: #000; flex-shrink: 0;
}
.avatar.sm { width: 20px; height: 20px; font-size: 10px; }
.avatar.buy { background: linear-gradient(135deg, #f23645, #8a1a25); color: #fff; }
.avatar.sell { background: linear-gradient(135deg, #08db94, #0a5f3f); color: #fff; }
.avatar.up { background: linear-gradient(135deg, #f23645, #8a1a25); color: #fff; }
.avatar.down { background: linear-gradient(135deg, #08db94, #0a5f3f); color: #fff; }

.info { flex: 1; min-width: 0; }
.info .n { font-size: 11px; color: #8a919e; }
.info .p { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }

.chg { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.chg.up { color: #f23645; }
.chg.down { color: #08db94; }
.chg.flat { color: #8a919e; }

.chev {
  background: transparent; border: none; color: var(--accent);
  font-size: 14px; cursor: pointer; padding: 2px 4px; line-height: 1;
}

.status-line {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
  color: var(--accent); font-size: 12px;
}
.sl-spin {
  width: 12px; height: 12px; border: 2px solid rgba(212,175,55,.3);
  border-top-color: var(--accent); border-radius: 50%; animation: ispin .8s linear infinite;
}
@keyframes ispin { to { transform: rotate(360deg); } }

/* ===== 展开态 ===== */
.open-wrap {
  height: 400px;
  box-sizing: border-box;
  display: flex; flex-direction: column;
  background: linear-gradient(180deg, var(--bg-from), var(--bg-to));
  border: 1px solid var(--border);
  border-radius: 18px;
  overflow: hidden;
  padding: 12px;
}

.head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 10px;
}
.head-left { display: flex; align-items: center; gap: 8px; }
.head-name { font-size: 12px; color: #e8eaed; }
.head-px { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }

.tabs {
  display: flex; gap: 4px; background: rgba(0,0,0,.35);
  padding: 3px; border-radius: 8px; margin-bottom: 10px;
}
.tab {
  flex: 1; text-align: center; font-size: 11px; padding: 5px 4px;
  border-radius: 6px; color: #8a919e; cursor: pointer;
  transition: all .15s;
}
.tab.active { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent-soft); }
.tab .count { opacity: .7; margin-left: 2px; }

.tab-body { flex: 1; overflow-y: auto; }

.alert-row {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 6px; border-radius: 6px; cursor: pointer;
}
.alert-row:hover { background: rgba(255,255,255,.04); }
.alert-row .dir { font-size: 12px; width: 14px; text-align: center; }
.alert-row .dir.up { color: #f23645; }
.alert-row .dir.down { color: #08db94; }
.alert-row .desc { flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alert-row .desc b { color: #e8eaed; margin-right: 4px; }
.alert-row .val { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.alert-row .val.up { color: #f23645; }
.alert-row .val.down { color: #08db94; }

.sig-row {
  padding: 8px; background: color-mix(in srgb, var(--accent) 6%, transparent);
  border-radius: 8px; margin-bottom: 6px;
  border-left: 3px solid var(--accent);
}
.sig-row .sig-head { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
.sig-row .sig-side { color: #f23645; font-weight: 600; }
.sig-row.sell .sig-side { color: #08db94; }
.sig-row .sig-meta { font-size: 11px; color: #8a919e; }

.order-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 7px 6px; border-bottom: 1px solid rgba(255,255,255,.05); font-size: 12px;
}
.order-row:last-child { border: none; }
.order-group-title {
  font-size: 10px; color: var(--accent-soft); opacity: .7;
  padding: 8px 4px 4px; letter-spacing: 1px;
}
.empty-sm { text-align: center; color: #8a919e; font-size: 11px; padding: 6px; }
.ord-st.live { background: rgba(242,54,69,.2); color: #f23645; }
.ord-st {
  font-size: 10px; padding: 1px 6px; border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent-soft);
}

.empty { text-align: center; color: #8a919e; padding: 30px 10px; font-size: 12px; }

.actions { display: flex; gap: 6px; margin-top: 10px; }
.btn {
  flex: 1; padding: 7px; text-align: center; font-size: 12px;
  border-radius: 8px; background: rgba(255,255,255,.06); color: #e8eaed;
  cursor: pointer; transition: background .1s;
}
.btn:hover { background: rgba(255,255,255,.1); }
.btn.primary { background: var(--accent); color: #000; font-weight: 600; }
.btn.primary:hover { filter: brightness(1.1); }
</style>
