<script setup lang="ts">
// 信号人工确认桥：双脑 BUY/SELL 信号落「待确认单」，人工改价改量、选券商，
// 生成下单指令（复制/导出/唤起券商软件）。不自动成交，全程状态留痕。
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { confirmDialog } from "../composables/useDialog";
import {
  autoexecGetConfig,
  signalCreateManual,
  signalDone,
  signalExpire,
  signalLaunchBroker,
  signalList,
  signalConfirm,
  signalReject,
  type SignalTicketInfo,
} from "../ai/api";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  brokerSubmit,
  brokerConnect,
  brokerGetStatus,
  brokerListOrders,
  brokerCancel,
  type BrokerOrderInfo,
} from "../broker/api";

const TABS = [
  { k: "pending", t: "待确认" },
  { k: "confirmed", t: "已确认" },
  { k: "done", t: "已完成" },
  { k: "rejected", t: "已驳回" },
  { k: "expired", t: "已过期" },
  { k: "all", t: "全部" },
];
const tab = ref("pending");
const tickets = ref<SignalTicketInfo[]>([]);
const counts = reactive<Record<string, number>>({
  pending: 0, confirmed: 0, done: 0, rejected: 0, expired: 0,
});
const loading = ref(false);
const busy = ref<number | null>(null);
const toastMsg = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function flash(m: string) {
  toastMsg.value = m;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastMsg.value = ""), 2600);
}

// 待确认单的本地编辑值
interface EditV {
  price: string;
  vol: string;
  actionKind: string;
  broker: string;
}
const edit = reactive<Record<number, EditV>>({});
function ensureEdit(t: SignalTicketInfo): EditV {
  if (!edit[t.id]) {
    edit[t.id] = {
      price: (t.price || t.refPrice).toFixed(2),
      vol: String(t.vol || 0),
      actionKind: "copy",
      broker: t.broker || "同花顺",
    };
  }
  return edit[t.id];
}

const filtered = computed(() =>
  tab.value === "all"
    ? tickets.value
    : tickets.value.filter((t) => t.status === tab.value),
);

function recompute() {
  const c = { pending: 0, confirmed: 0, done: 0, rejected: 0, expired: 0 };
  for (const t of tickets.value) {
    if (t.status in c) c[t.status as keyof typeof c]++;
  }
  Object.assign(counts, c);
}
function initEdits() {
  for (const t of tickets.value) {
    if (t.status === "pending") ensureEdit(t);
  }
}

async function load() {
  loading.value = true;
  try {
    const all = await signalList("all", 500);
    // 过滤掉已清除的信号
    tickets.value = all.filter(t => !clearedIds.value.has(t.id));
    recompute();
    initEdits();
  } catch (e) {
    flash(`加载失败：${e}`);
  } finally {
    loading.value = false;
  }
}

// ===== 确认 / 驳回 / 完成 =====
async function onConfirm(t: SignalTicketInfo) {
  const e = ensureEdit(t);
  const price = parseFloat(e.price);
  const vol = parseInt(e.vol, 10);
  if (!(price > 0)) return flash("请填写有效价格");
  if (!(vol > 0)) return flash("请填写有效数量（100 的整数倍）");
  busy.value = t.id;
  try {
    const r = await signalConfirm(t.id, {
      price, vol, actionKind: e.actionKind, broker: e.broker,
      orderTemplate: orderTpl.value || null,
    });
    if (e.actionKind === "copy") {
      try {
        await navigator.clipboard.writeText(r.orderText);
        flash("指令已复制到剪贴板");
      } catch {
        flash("已生成指令，请手动选择文本复制");
      }
    } else {
      flash("已生成下单指令");
    }
    await load();
  } catch (err) {
    flash(String(err));
  } finally {
    busy.value = null;
  }
}

async function onReject(t: SignalTicketInfo) {
  busy.value = t.id;
  try {
    await signalReject(t.id);
    await load();
  } catch (e) {
    flash(String(e));
  } finally {
    busy.value = null;
  }
}

// ===== 卡片内快捷键：Enter 确认 / Ctrl(⌘)+Enter 确认并唤起 / R 驳回 =====
function firstPending(): SignalTicketInfo | undefined {
  return tickets.value.find((t) => t.status === "pending");
}
function isFormTarget(ev: KeyboardEvent): boolean {
  const el = ev.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
async function quickConfirm(ev: KeyboardEvent, launch: boolean) {
  if (isFormTarget(ev)) return;
  const t = firstPending();
  if (!t) return;
  const e = ensureEdit(t);
  if (launch) e.actionKind = "hotkey";
  ev.preventDefault();
  await onConfirm(t);
}
async function quickReject(ev: KeyboardEvent) {
  if (isFormTarget(ev)) return;
  const t = firstPending();
  if (!t) return;
  ev.preventDefault();
  await onReject(t);
}
function onCardKey(ev: KeyboardEvent) {
  if (ev.key === "Enter") {
    void quickConfirm(ev, ev.ctrlKey || ev.metaKey);
  } else if (
    (ev.key === "r" || ev.key === "R") &&
    !ev.ctrlKey && !ev.metaKey && !ev.altKey
  ) {
    void quickReject(ev);
  }
}

async function onDone(t: SignalTicketInfo) {
  busy.value = t.id;
  try {
    await signalDone(t.id);
    await load();
  } catch (e) {
    flash(String(e));
  } finally {
    busy.value = null;
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    flash("已复制");
  } catch {
    flash("复制失败，请手动选择");
  }
}

function selectAll(e: FocusEvent) {
  (e.target as HTMLTextAreaElement | null)?.select();
}

// ===== 券商实盘发送 / 委托回报（v2.6）=====
const orders = ref<Record<string, BrokerOrderInfo>>({});
const bConnected = ref(false);
const bKind = ref("mock");
const bLive = ref(false);
async function loadOrders() {
  try {
    const list = await brokerListOrders(null);
    const m: Record<string, BrokerOrderInfo> = {};
    for (const o of list) m[o.sigId] = o;
    orders.value = m;
    const st = await brokerGetStatus();
    bConnected.value = st.connected;
    bKind.value = st.kind;
    bLive.value = st.liveEnabled;
  } catch {
    /* 忽略：未初始化时不阻断 */
  }
}
function bkText(s: string): string {
  return (
    {
      submitting: "报单中",
      submitted: "已报",
      part_filled: "部分成交",
      filled: "全部成交",
      cancelled: "已撤单",
      error: "错误",
      rejected: "拒单",
    } as Record<string, string>
  )[s] || s;
}
async function onBrokerSend(t: SignalTicketInfo) {
  busy.value = t.id;
  try {
    if (!bConnected.value) {
      await brokerConnect();
      bConnected.value = true;
    }
    if (bLive.value) {
      const ok = await confirmDialog({
        title: "提交实盘委托",
        message: `实盘已开启，确认向券商提交真实委托 ${t.code} ${t.vol} 股？`,
        confirmText: "提交",
        danger: true,
      });
      if (!ok) return;
    }
    await brokerSubmit(t.sigId);
    flash(bLive.value ? "实盘委托已提交" : "模拟委托已提交");
    await loadOrders();
  } catch (e) {
    flash(String(e));
  } finally {
    busy.value = null;
  }
}
async function onBrokerCancel(t: SignalTicketInfo) {
  busy.value = t.id;
  try {
    await brokerCancel(t.sigId);
    await loadOrders();
  } catch (e) {
    flash(String(e));
  } finally {
    busy.value = null;
  }
}

// ===== 券商唤起 =====
const brokerPath = ref("");
const orderTpl = ref("");
async function loadBrokerPath() {
  try {
    const c = await autoexecGetConfig();
    brokerPath.value = c.bridgeBrokerPath || "";
    orderTpl.value = c.bridgeOrderTemplate || "";
  } catch {
    /* 忽略 */
  }
}
async function onLaunch() {
  const p = brokerPath.value.trim();
  if (!p) return flash("请先在「设置 - AI - 信号桥」配置券商软件路径");
  try {
    await signalLaunchBroker(p);
  } catch (e) {
    flash(String(e));
  }
}

// ===== 过期清理 =====
async function onCleanExpire() {
  try {
    const n = await signalExpire();
    flash(`已清理 ${n} 条过期信号`);
    await load();
  } catch (e) {
    flash(String(e));
  }
}

// ===== 清除历史记录（前端过滤 + localStorage 记住） =====
const clearedIds = ref<Set<number>>(new Set());

// 从 localStorage 读取已清除的信号 ID
function loadClearedIds() {
  try {
    const saved = localStorage.getItem("signal_bridge_cleared");
    if (saved) {
      clearedIds.value = new Set(JSON.parse(saved));
    }
  } catch {}
}

// 清除历史记录（已完成、已驳回、已过期）
function onClearHistory() {
  const before = tickets.value.length;
  tickets.value = tickets.value.filter(t => {
    // 保留待确认和已确认的，清除其他的
    if (t.status === "pending" || t.status === "confirmed") return true;
    clearedIds.value.add(t.id);
    return false;
  });
  // 保存到 localStorage
  localStorage.setItem("signal_bridge_cleared", JSON.stringify(Array.from(clearedIds.value)));
  const after = tickets.value.length;
  flash(`已清除 ${before - after} 条历史记录`);
  recompute();
}

// ===== 手动新建 =====
const showManual = ref(false);
const mForm = reactive({
  code: "", name: "", side: "BUY", price: "", vol: "", reason: "",
});
function resetManual() {
  mForm.code = ""; mForm.name = ""; mForm.side = "BUY";
  mForm.price = ""; mForm.vol = ""; mForm.reason = "";
}
async function onManual() {
  const price = parseFloat(mForm.price);
  const vol = parseInt(mForm.vol, 10);
  if (!mForm.code.trim()) return flash("请填写代码");
  try {
    await signalCreateManual(
      mForm.code.trim(), mForm.name.trim(), mForm.side, price, vol, mForm.reason,
    );
    flash("已创建待确认信号");
    showManual.value = false;
    resetManual();
    await load();
  } catch (e) {
    flash(String(e));
  }
}

// ===== 展示辅助 =====
function hhmmss(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function confColor(c: number) {
  return c >= 0.75 ? "#ff5a5a" : c >= 0.55 ? "#ffb13d" : "#8a93a6";
}

let timer: ReturnType<typeof setInterval> | undefined;
const unlisteners: UnlistenFn[] = [];
onMounted(() => {
  loadClearedIds(); // 读取已清除的信号 ID
  void load();
  void loadBrokerPath();
  void loadOrders();
  timer = setInterval(() => { void load(); void loadOrders(); }, 10000);
  window.addEventListener("keydown", onCardKey);
  // 事件驱动即时刷新：状态变更（确认/驳回/完成）或新信号到达立即重拉，
  // 不必等待 10s 轮询，避免卡片计数与 DB 短暂不一致。
  for (const ev of ["signal:updated", "signal:new"]) {
    listen(ev, () => void load()).then((u) => unlisteners.push(u));
  }
});
onUnmounted(() => {
  clearInterval(timer);
  window.removeEventListener("keydown", onCardKey);
  for (const u of unlisteners) u();
  unlisteners.length = 0;
});
</script>

<template>
  <div class="sb">
    <!-- 顶部说明 -->
    <div class="sb-intro">
      <div class="sb-intro-title">🌉 信号确认桥</div>
      <div class="sb-intro-desc">
        机器人发出的买卖信号，先落到这里，你确认后再下单。<b>不自动成交</b>，安全第一。
      </div>
    </div>

    <!-- 状态筛选 -->
    <div class="sb-tabs">
      <button
        v-for="t in TABS"
        :key="t.k"
        class="sb-tab"
        :class="{ on: tab === t.k }"
        @click="tab = t.k"
      >
        {{ t.t }}
        <span v-if="t.k !== 'all' && counts[t.k]" class="sb-badge"
          >{{ counts[t.k] }}</span
        >
      </button>
    </div>

    <!-- 工具行 -->
    <div class="sb-tools">
      <button class="tb-btn" @click="load">
        🔄 {{ loading ? "刷新中…" : "刷新" }}
      </button>
      <button class="tb-btn" @click="onCleanExpire">🗑️ 清理过期</button>
      <button class="tb-btn danger" @click="onClearHistory">🧹 清除历史记录</button>
      <button class="tb-btn" @click="showManual = !showManual">
        {{ showManual ? "收起" : "➕ 手动新建" }}
      </button>
    </div>

    <div class="hk-hint">
      💡 快捷键：Enter 确认最新 · Ctrl+Enter 确认并唤起券商 · R 驳回
    </div>

    <!-- 手动新建表单 -->
    <div v-if="showManual" class="manual-box">
      <div class="m-row">
        <select v-model="mForm.side">
          <option value="BUY">买入</option>
          <option value="SELL">卖出</option>
        </select>
        <input v-model="mForm.code" placeholder="代码 600519" spellcheck="false" />
        <input v-model="mForm.name" placeholder="名称" spellcheck="false" />
      </div>
      <div class="m-row">
        <input v-model="mForm.price" placeholder="价格" type="number" step="0.01" />
        <input v-model="mForm.vol" placeholder="数量" type="number" step="100" />
        <input v-model="mForm.reason" placeholder="理由（可选）" spellcheck="false" />
      </div>
      <button class="tb-btn primary" @click="onManual">生成待确认单</button>
    </div>

    <!-- 列表 -->
    <div class="sb-list">
      <div v-if="!filtered.length && !loading" class="sb-empty">
        <template v-if="tab === 'pending'">
          <div class="empty-icon">🔔</div>
          <div class="empty-title">暂无待确认信号</div>
          <div class="empty-desc">信号确认桥：快脑发出的买卖信号会先落到这里，你确认后再下单，不自动成交。</div>
          <div class="empty-steps">
            <div class="step">
              <span class="step-num">1</span>
              <div class="step-body">
                <div class="step-title">开启快脑自动执行</div>
                <div class="step-sub">在「机器人」页面启动快脑</div>
              </div>
            </div>
            <div class="step">
              <span class="step-num">2</span>
              <div class="step-body">
                <div class="step-title">设置为「人工确认」模式</div>
                <div class="step-sub">半自动/人工确认模式才会走信号桥</div>
              </div>
            </div>
            <div class="step">
              <span class="step-num">3</span>
              <div class="step-body">
                <div class="step-title">等待交易时段</div>
                <div class="step-sub">盘中有信号会自动出现在这里</div>
              </div>
            </div>
          </div>
        </template>
        <template v-else>
          暂无记录
        </template>
      </div>

      <div
        v-for="t in filtered"
        :key="t.id"
        class="sig"
        :class="[t.side === 'BUY' ? 'is-buy' : 'is-sell', `st-${t.status}`]"
      >
        <div class="sig-head">
          <span class="sig-side">{{ t.side === "BUY" ? "买入" : "卖出" }}</span>
          <span class="sig-code">{{ t.code }}</span>
          <span class="sig-name">{{ t.name }}</span>
          <span class="sig-src">{{ t.source }}</span>
          <span class="sig-time">{{ hhmmss(t.createdAt) }}</span>
          <span v-if="t.status !== 'pending'" class="sig-state">{{
            TABS.find((x) => x.k === t.status)?.t
          }}</span>
        </div>

        <div class="sig-meta">
          <span class="m-item">模型 <b>{{ t.modelVersion || "-" }}</b></span>
          <span class="m-item">策略 <b>{{ t.strategy || "-" }}</b></span>
          <span class="m-item">
            置信
            <i class="conf-bar"
              ><em
                :style="{
                  width: `${Math.round(t.confidence * 100)}%`,
                  background: confColor(t.confidence),
                }"
              ></em
            ></i>
            <b :style="{ color: confColor(t.confidence) }">{{
              Math.round(t.confidence * 100)
            }}%</b>
          </span>
          <span class="m-item">参考价 <b>{{ t.refPrice.toFixed(2) }}</b></span>
        </div>

        <div v-if="t.reason" class="sig-reason">{{ t.reason }}</div>

        <!-- 待确认：可改价改量 + 动作 + 券商 -->
        <template v-if="t.status === 'pending' && edit[t.id]">
          <div class="sig-edit">
            <label>
              限价
              <input
                v-model="edit[t.id].price"
                type="number"
                step="0.01"
                spellcheck="false"
              />
            </label>
            <label>
              数量
              <input
                v-model="edit[t.id].vol"
                type="number"
                step="100"
                spellcheck="false"
              />
            </label>
            <label class="grow">
              券商
              <input
                v-model="edit[t.id].broker"
                type="text"
                spellcheck="false"
              />
            </label>
          </div>
          <div class="sig-edit">
            <div class="seg">
              <button
                class="seg-b"
                :class="{ on: edit[t.id].actionKind === 'copy' }"
                @click="edit[t.id].actionKind = 'copy'"
              >
                复制指令
              </button>
              <button
                class="seg-b"
                :class="{ on: edit[t.id].actionKind === 'export' }"
                @click="edit[t.id].actionKind = 'export'"
              >
                仅生成
              </button>
              <button
                class="seg-b"
                :class="{ on: edit[t.id].actionKind === 'hotkey' }"
                @click="edit[t.id].actionKind = 'hotkey'"
              >
                唤起券商
              </button>
            </div>
          </div>
          <div class="sig-actions">
            <button
              class="act primary"
              :disabled="busy === t.id"
              @click="onConfirm(t)"
            >
              {{ busy === t.id ? "处理中…" : "确认并生成指令" }}
            </button>
            <button
              class="act ghost"
              :disabled="busy === t.id"
              @click="onReject(t)"
            >
              驳回
            </button>
          </div>
        </template>

        <!-- 已确认：指令 + 唤起 + 标记完成 -->
        <template v-if="t.status === 'confirmed'">
          <div class="order-box">
            <textarea readonly :value="t.orderText" @focus="selectAll"></textarea>
          </div>
          <div class="launch-row">
            <input
              v-model="brokerPath"
              class="path-input"
              placeholder="券商软件路径（.exe / .app）"
              spellcheck="false"
            />
            <button class="act" @click="onLaunch">唤起券商</button>
          </div>

          <!-- v2.6 券商委托回报 / 程序化发送 -->
          <div v-if="orders[t.sigId]" class="bk-box" :class="`bk-st-${orders[t.sigId].status}`">
            <div class="bk-line">
              <span class="bk-state">{{ bkText(orders[t.sigId].status) }}</span>
              <span class="bk-fill">成交 {{ orders[t.sigId].filledVol }}/{{ t.vol }}</span>
              <span v-if="orders[t.sigId].filledAvgPrice > 0" class="bk-fill">均价 {{ orders[t.sigId].filledAvgPrice.toFixed(2) }}</span>
              <span v-if="orders[t.sigId].brokerOrderId" class="bk-fill">委托号 {{ orders[t.sigId].brokerOrderId }}</span>
            </div>
            <div v-if="orders[t.sigId].errorMsg" class="bk-err">{{ orders[t.sigId].errorMsg }}</div>
            <button
              v-if="['submitting', 'submitted', 'part_filled'].includes(orders[t.sigId].status)"
              class="act ghost"
              :disabled="busy === t.id"
              @click="onBrokerCancel(t)"
            >撤单</button>
          </div>
          <div v-else class="sig-actions">
            <button
              class="act"
              :class="{ primary: !bLive, dangerlive: bLive }"
              :disabled="busy === t.id"
              @click="onBrokerSend(t)"
            >{{ busy === t.id ? "处理中…" : bLive ? "实盘发送" : bKind === "qmt" ? "QMT 发送" : "模拟发送" }}</button>
          </div>

          <div class="sig-actions">
            <button class="act" @click="copyText(t.orderText)">复制指令</button>
            <button class="act primary" @click="onDone(t)">我已下单 · 标记完成</button>
          </div>
        </template>
      </div>
    </div>

    <transition name="toast">
      <div v-if="toastMsg" class="sb-toast">{{ toastMsg }}</div>
    </transition>
  </div>
</template>

<style scoped>
.sb {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  font-size: 12px;
  gap: 10px;
  padding: 12px;
  overflow-y: auto;
}

/* 顶部说明 */
.sb-intro {
  padding: 12px;
  background: linear-gradient(135deg, rgba(90,160,255,0.05), rgba(0,255,213,0.05));
  border: 1px solid rgba(90,160,255,0.2);
  border-radius: 10px;
}
.sb-intro-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--accent, #5aa0ff);
  margin-bottom: 6px;
}
.sb-intro-desc {
  font-size: 13px;
  color: var(--text-dim, #8892a8);
  line-height: 1.6;
}
.sb-intro-desc b {
  color: #ff6464;
}

.hk-hint {
  margin: 6px 8px 0;
  padding: 5px 10px;
  border: 1px solid var(--border, #2a3344);
  border-radius: 7px;
  background: rgba(232, 198, 106, 0.08);
  color: var(--text-dim, #97a0b2);
  font-size: 10px;
  line-height: 1.6;
}
.hk-hint b { color: var(--accent, #e8c66a); font-weight: 700; }
.sb-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 8px 4px;
  flex-wrap: wrap;
}
.sb-tab {
  position: relative;
  border: 1px solid var(--border, #2a3344);
  background: var(--bg-card, #15181f);
  color: var(--text-dim, #97a0b2);
  border-radius: 7px;
  padding: 4px 10px;
  font-size: 11px;
  cursor: pointer;
}
.sb-tab.on {
  color: var(--accent, #e8c66a);
  border-color: var(--accent, #e8c66a);
}
.sb-badge {
  margin-left: 4px;
  background: #ff3b46;
  color: #fff;
  border-radius: 8px;
  font-size: 10px;
  padding: 0 5px;
  font-style: normal;
}
.sb-tools {
  display: flex;
  gap: 6px;
  padding: 2px 8px 8px;
}
.tb-btn {
  border: 1px solid var(--border, #2a3344);
  background: transparent;
  color: var(--text-dim, #97a0b2);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
}
.tb-btn.primary,
.tb-btn:hover {
  color: var(--accent, #e8c66a);
  border-color: var(--accent, #e8c66a);
}
.manual-box {
  margin: 0 8px 8px;
  padding: 8px;
  border: 1px dashed var(--border, #2a3344);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.m-row {
  display: flex;
  gap: 6px;
}
.m-row input,
.m-row select {
  flex: 1;
  min-width: 0;
  background: var(--bg-input, #0e1117);
  border: 1px solid var(--border, #2a3344);
  border-radius: 6px;
  color: var(--text, #e6ecf5);
  padding: 4px 7px;
  font-size: 11px;
}
.sb-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sb-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-dim, #97a0b2);
  text-align: center;
  padding: 20px;
}
.empty-icon { font-size: 28px; }
.empty-title { font-size: 13px; font-weight: 600; color: var(--text, #e0e6f0); }
.empty-desc { font-size: 10.5px; color: var(--text-dim, #8892a8); line-height: 1.5; max-width: 280px; }
.empty-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  max-width: 280px;
  margin-top: 4px;
}
.empty-steps .step {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 6px 8px;
  background: var(--bg-card2, #1a1712);
  border: 1px solid var(--border, #2c2619);
  border-radius: 6px;
  text-align: left;
}
.empty-steps .step-num {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(212, 175, 55, 0.15);
  color: #d4af37;
  font-size: 10px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.empty-steps .step-body { flex: 1; min-width: 0; }
.empty-steps .step-title { font-size: 10.5px; font-weight: 600; color: var(--text, #e0e6f0); }
.empty-steps .step-sub { font-size: 9.5px; color: var(--text-dim, #8892a8); margin-top: 1px; line-height: 1.4; }
.sig {
  border: 1px solid var(--border, #2a3344);
  border-left-width: 3px;
  border-radius: 9px;
  background: var(--bg-card, #15181f);
  padding: 8px 10px;
}
.sig.is-buy {
  border-left-color: #ff3b46;
}
.sig.is-sell {
  border-left-color: #1fbf75;
}
.st-rejected,
.st-expired {
  opacity: 0.6;
}
.st-done {
  border-left-color: #6aa6e8;
}
.sig-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sig-side {
  font-weight: 800;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 5px;
}
.is-buy .sig-side {
  color: #fff;
  background: #ff3b46;
}
.is-sell .sig-side {
  color: #fff;
  background: #1fbf75;
}
.sig-code {
  font-weight: 700;
  color: var(--text, #e6ecf5);
  font-variant-numeric: tabular-nums;
}
.sig-name {
  color: var(--text, #e6ecf5);
}
.sig-src {
  color: var(--text-dim, #97a0b2);
  border: 1px solid var(--border, #2a3344);
  border-radius: 5px;
  padding: 0 5px;
  font-size: 10px;
}
.sig-time {
  margin-left: auto;
  color: var(--text-dim, #97a0b2);
  font-variant-numeric: tabular-nums;
}
.sig-state {
  color: var(--accent, #e8c66a);
  font-size: 10px;
}
.sig-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.m-item {
  color: var(--text-dim, #97a0b2);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.m-item b {
  color: var(--text, #e6ecf5);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.conf-bar {
  width: 46px;
  height: 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
  display: inline-block;
}
.conf-bar em {
  display: block;
  height: 100%;
  border-radius: 3px;
}
.sig-reason {
  margin-top: 6px;
  color: var(--text-dim, #97a0b2);
  line-height: 1.5;
}
.sig-edit {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  align-items: center;
}
.sig-edit label {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-dim, #97a0b2);
}
.sig-edit label.grow {
  flex: 1;
}
.sig-edit input {
  width: 84px;
  background: var(--bg-input, #0e1117);
  border: 1px solid var(--border, #2a3344);
  border-radius: 6px;
  color: var(--text, #e6ecf5);
  padding: 4px 7px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.sig-edit label.grow input {
  flex: 1;
  width: auto;
}
.seg {
  display: flex;
  border: 1px solid var(--border, #2a3344);
  border-radius: 7px;
  overflow: hidden;
}
.seg-b {
  background: transparent;
  border: none;
  color: var(--text-dim, #97a0b2);
  padding: 4px 12px;
  font-size: 11px;
  cursor: pointer;
}
.seg-b.on {
  background: var(--accent, #e8c66a);
  color: #14161c;
  font-weight: 700;
}
.sig-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.act {
  border: 1px solid var(--border, #2a3344);
  background: transparent;
  color: var(--text, #e6ecf5);
  border-radius: 7px;
  padding: 5px 14px;
  font-size: 11px;
  cursor: pointer;
}
.act.primary {
  background: var(--accent, #e8c66a);
  border-color: var(--accent, #e8c66a);
  color: #14161c;
  font-weight: 700;
}
.act.ghost:hover {
  border-color: #ff5a6a;
  color: #ff5a6a;
}
.act:disabled {
  opacity: 0.5;
  cursor: default;
}
.order-box textarea {
  width: 100%;
  margin-top: 8px;
  min-height: 40px;
  resize: vertical;
  background: var(--bg-input, #0e1117);
  border: 1px solid var(--border, #2a3344);
  border-radius: 7px;
  color: var(--accent, #e8c66a);
  padding: 6px 8px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.launch-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.path-input {
  flex: 1;
  min-width: 0;
  background: var(--bg-input, #0e1117);
  border: 1px solid var(--border, #2a3344);
  border-radius: 7px;
  color: var(--text, #e6ecf5);
  padding: 5px 8px;
  font-size: 11px;
}
.sb-toast {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  background: rgba(20, 22, 28, 0.95);
  border: 1px solid var(--accent, #e8c66a);
  color: var(--text, #e6ecf5);
  border-radius: 8px;
  padding: 7px 16px;
  font-size: 11px;
  z-index: 30;
  white-space: nowrap;
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
/* v2.6 券商委托回报 */
.bk-box {
  margin-top: 8px;
  padding: 6px 9px;
  border-radius: 7px;
  border: 1px solid var(--border, #2a3344);
  background: rgba(255, 255, 255, 0.03);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bk-line {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 11px;
}
.bk-state { font-weight: 800; color: #6aa6e8; }
.bk-fill { color: var(--text-dim, #97a0b2); font-variant-numeric: tabular-nums; }
.bk-err { color: #ff5a6a; font-size: 10px; }
.bk-st-part_filled .bk-state { color: #ffb13d; }
.bk-st-filled .bk-state { color: #1fbf75; }
.bk-st-cancelled .bk-state { color: #8a93a6; }
.bk-st-error .bk-state,
.bk-st-rejected .bk-state { color: #ff5a6a; }
.act.dangerlive { background: #ff3b46; border-color: #ff3b46; color: #fff; font-weight: 700; }
.act.ghost { background: transparent; }
</style>
