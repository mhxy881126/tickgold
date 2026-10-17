<script setup lang="ts">
// P7 同花顺客户端控制台（移植 THSAutoTrader 能力）：
// 账户资金 / 持仓 / 当日成交 / 当日挂单 四表，一键撤单（全撤/撤买/撤卖），
// 仓位下单（全/半/1/3/1/4 档），进程窗口自检，键盘/点击高级调试，人工验证码。
// 真实通道：Python 侧强制半自动，下单/撤单均截图挂起，由人工核对后才在客户端落键。
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirmDialog } from "../composables/useDialog";
import { useActions } from "../composables/useActions";
import {
  brokerGetConfig,
  brokerGetStatus,
  brokerSetConfig,
  brokerConnect,
  brokerQueryAsset,
  brokerQueryPosition,
  brokerClientQueryTrades,
  brokerClientQueryPending,
  brokerClientCancelAll,
  brokerClientPositionOrder,
  brokerClientCheckApp,
  brokerClientCurrentPage,
  brokerClientSendKey,
  brokerClientClick,
  brokerClientCaptchaInput,
  brokerClientConfirm,
  type BrokerStatus,
  type BrokerAsset,
  type BrokerPosition,
  type BrokerTrade,
  type BrokerPending,
  type ClientAppState,
  type ClientCurrentPage,
  type ClientShot,
} from "../broker/api";

type TabKey = "position" | "trades" | "pending" | "api";
const TABS: { k: TabKey; t: string }[] = [
  { k: "position", t: "持仓" },
  { k: "trades", t: "当日成交" },
  { k: "pending", t: "当日挂单" },
  { k: "api", t: "API 控制台" },
];
const tab = ref<TabKey>("position");

const status = ref<BrokerStatus | null>(null);
const asset = ref<BrokerAsset | null>(null);
const positions = ref<BrokerPosition[]>([]);
const trades = ref<BrokerTrade[]>([]);
const pending = ref<BrokerPending[]>([]);
const appState = ref<ClientAppState>({});
const currentPage = ref<ClientCurrentPage>({});
const loading = ref(false);
const connected = computed(() => status.value?.connected === true);
const isLive = computed(() => status.value?.liveEnabled === true);

const toastMsg = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function flash(m: string) {
  toastMsg.value = m;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastMsg.value = ""), 3000);
}

function fmtMoney(v: number | undefined | null): string {
  if (v === undefined || v === null) return "--";
  return "¥" + v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}
function fmtNum(v: number | undefined | null, d = 2): string {
  if (v === undefined || v === null) return "--";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function pnlCls(v: number | undefined | null): string {
  if (v === undefined || v === null) return "";
  return v > 1e-6 ? "up" : v < -1e-6 ? "down" : "";
}
function sideText(s: string | undefined): string {
  if (!s) return "--";
  if (s.includes("买") || s.toUpperCase() === "BUY" || s === "21") return "买入";
  if (s.includes("卖") || s.toUpperCase() === "SELL" || s === "23") return "卖出";
  return s;
}
function sideCls(s: string | undefined): string {
  const t = sideText(s);
  return t === "买入" ? "up" : t === "卖出" ? "down" : "";
}

// ===== 数据加载 =====
async function loadStatus() {
  try {
    status.value = await brokerGetStatus();
  } catch {
    status.value = null;
  }
}
async function loadAsset() {
  try {
    asset.value = await brokerQueryAsset();
  } catch {
    /* 未连接时不阻断 */
  }
}
async function loadPositions() {
  try {
    const r = await brokerQueryPosition();
    if (r.positions) positions.value = r.positions;
  } catch {
    /* ignore */
  }
}
async function loadTrades() {
  try {
    const r = await brokerClientQueryTrades();
    if (r.trades) trades.value = r.trades;
  } catch {
    /* ignore */
  }
}
async function loadPending() {
  try {
    const r = await brokerClientQueryPending();
    if (r.orders) pending.value = r.orders;
  } catch {
    /* ignore */
  }
}
async function refresh() {
  loading.value = true;
  await loadStatus();
  await loadAsset();
  if (connected.value) {
    await loadPositions();
    await loadTrades();
    await loadPending();
  }
  loading.value = false;
}
async function refreshTab() {
  if (!connected.value) return;
  if (tab.value === "position") await loadPositions();
  else if (tab.value === "trades") await loadTrades();
  else if (tab.value === "pending") await loadPending();
}

// ===== P10-3 API 控制台：展示 THSAutoTrader 兼容 REST 接口，curl 示例 + 一键调用 + JSON 预览 =====
interface ApiEndpoint {
  key: string;
  path: string;
  desc: string;
  group: string;
  params: { name: string; ph: string; options?: { v: string; t: string }[] }[];
}
const APIS: ApiEndpoint[] = [
  { key: "health", path: "/health", desc: "服务存活探测", group: "探测", params: [] },
  { key: "checkTradingApp", path: "/check_trading_app", desc: "同花顺下单程序进程探测", group: "探测", params: [] },
  { key: "currentPage", path: "/current_page", desc: "当前前台窗口信息（句柄/标题）", group: "探测", params: [] },
  { key: "balance", path: "/balance", desc: "账户资金（现金/市值/盈亏）", group: "查询", params: [] },
  { key: "position", path: "/position", desc: "持仓列表", group: "查询", params: [] },
  { key: "todayTrades", path: "/today_trades", desc: "当日成交流水", group: "查询", params: [] },
  { key: "pendingOrders", path: "/pending_orders", desc: "当日挂单（未成交委托）", group: "查询", params: [] },
  {
    key: "xiadan", path: "/xiadan", desc: "闪电下单（THSAutoTrader 同款）", group: "下单",
    params: [
      { name: "code", ph: "代码 600519" },
      { name: "status", ph: "1=买入 2=卖出", options: [{ v: "1", t: "买入" }, { v: "2", t: "卖出" }] },
      { name: "amount", ph: "数量（可选）" },
      { name: "price", ph: "价格（可选）" },
    ],
  },
  {
    key: "confirmOrder", path: "/confirm_order", desc: "用最近一次下单上下文按仓位确认", group: "下单",
    params: [{ name: "position", ph: "1=全仓 2=半仓 3=1/3 4=1/4", options: [{ v: "1", t: "全仓" }, { v: "2", t: "半仓" }, { v: "3", t: "1/3" }, { v: "4", t: "1/4" }] }],
  },
  {
    key: "cancelAll", path: "/cancel_all_orders", desc: "一键撤单（全撤/撤买/撤卖）", group: "下单",
    params: [{ name: "type", ph: "A=全撤 X=撤买 C=撤卖", options: [{ v: "A", t: "全撤" }, { v: "X", t: "撤买" }, { v: "C", t: "撤卖" }] }],
  },
  { key: "sendKey", path: "/send_key", desc: "键盘精灵：向同花顺发送按键序列", group: "调试", params: [{ name: "key", ph: "如 F4 或 600519 ENTER 21 ENTER" }] },
  { key: "click", path: "/click", desc: "坐标点击（客户区相对坐标）", group: "调试", params: [{ name: "x", ph: "x" }, { name: "y", ph: "y" }] },
];
const apiCfg = ref<{ port: number; token: string }>({ port: 0, token: "" });
const apiForm = reactive<Record<string, Record<string, string>>>({
  xiadan: { code: "", status: "1", amount: "", price: "" },
  confirmOrder: { position: "2" },
  cancelAll: { type: "A" },
  sendKey: { key: "" },
  click: { x: "", y: "" },
});
const apiResult = ref<{ endpoint: string; ok: boolean; text: string } | null>(null);
const apiBusy = ref<string | null>(null);
const apiHealth = ref<"unknown" | "ok" | "fail">("unknown");
async function loadApiCfg() {
  try {
    const c = await brokerGetConfig();
    apiCfg.value = { port: c.clientApiPort ?? 0, token: c.clientApiToken ?? "" };
  } catch {
    /* ignore */
  }
}
function apiBase(): string | null {
  if (!apiCfg.value.port || apiCfg.value.port <= 0) return null;
  return `http://127.0.0.1:${apiCfg.value.port}`;
}
function apiUrl(ep: ApiEndpoint): string {
  const base = apiBase();
  if (!base) return "";
  const q: string[] = [];
  for (const p of ep.params) {
    const v = (apiForm[ep.key]?.[p.name] ?? "").trim();
    if (v !== "") q.push(`${p.name}=${encodeURIComponent(v)}`);
  }
  const qs = q.length ? "?" + q.join("&") : "";
  const tok = apiCfg.value.token.trim();
  const tq = tok ? (qs ? "&" : "?") + `token=${encodeURIComponent(tok)}` : "";
  return `${base}${ep.path}${qs}${tq}`;
}
function apiCurl(ep: ApiEndpoint): string {
  return `curl "${apiUrl(ep)}"`;
}
async function apiCall(ep: ApiEndpoint) {
  const base = apiBase();
  if (!base) {
    flash("请先在设置中开启 HTTP API 服务并连接通道");
    return;
  }
  if (apiBusy.value) return;
  apiBusy.value = ep.key;
  try {
    const r = await fetch(apiUrl(ep));
    const txt = await r.text();
    let ok = r.ok;
    let pretty = txt;
    try {
      pretty = JSON.stringify(JSON.parse(txt), null, 2);
      const j = JSON.parse(txt);
      if (j && typeof j === "object" && j.status === "error") ok = false;
    } catch {
      /* 非 JSON 原样展示 */
    }
    apiResult.value = { endpoint: ep.path, ok, text: pretty };
  } catch (e) {
    apiResult.value = { endpoint: ep.path, ok: false, text: `请求失败：${e}` };
  } finally {
    apiBusy.value = null;
  }
}
async function apiPing() {
  const base = apiBase();
  if (!base) {
    apiHealth.value = "fail";
    flash("API 服务未开启：设置 → 券商交易 → 同花顺客户端 → 启用 API 服务");
    return;
  }
  apiHealth.value = "unknown";
  try {
    const r = await fetch(`${base}/health`);
    if (r.ok) apiHealth.value = "ok";
    else apiHealth.value = "fail";
  } catch {
    apiHealth.value = "fail";
  }
}
const API_GROUPS = ["探测", "查询", "下单", "调试"];

// ===== P8 一键演练（dry-run）：未连接时一键切到同花顺 dry-run 通道并展示虚拟数据 =====
const drillBusy = ref(false);
async function onDrillRun() {
  drillBusy.value = true;
  try {
    // 切到同花顺客户端通道 + 模拟 + dry-run（不碰真客户端/真钱）
    await brokerSetConfig({ kind: "client", clientSim: true, clientDryRun: true });
    await brokerConnect();
    await refresh();
    flash("dry-run 演练已启动：下方展示虚拟账户数据（未连接真实客户端）");
  } catch (e) {
    flash(`演练启动失败：${e}`);
  } finally {
    drillBusy.value = false;
  }
}
function goSettings() {
  try {
    const a = useActions()
      .list()
      .find((x) => x.id === "app.settings");
    a?.run();
  } catch {
    /* ignore */
  }
}

// ===== 自检：进程 / 窗口 =====
async function onCheckApp() {
  try {
    const a = await brokerClientCheckApp();
    appState.value = a || {};
    const p = await brokerClientCurrentPage();
    currentPage.value = p || {};
    flash(a?.running ? "同花顺下单程序运行中" : "未检测到同花顺下单程序窗口");
  } catch (e) {
    flash(String(e));
  }
}

// ===== 一键撤单 =====
const cancelBusy = ref(false);
async function onCancelAll(kind: string) {
  const label = kind === "A" ? "全部委托" : kind === "X" ? "全部买单" : "全部卖单";
  if (isLive.value) {
    const ok = await confirmDialog({
      title: "撤单确认",
      message: `即将在同花顺客户端撤销${label}。真实通道会先截图、由你核对后才落键，确认继续？`,
      confirmText: `撤销${label}`,
      danger: true,
    });
    if (!ok) return;
  }
  cancelBusy.value = true;
  try {
    await brokerClientCancelAll(kind);
    flash(`已提交撤销${label}，请在核对弹窗确认`);
  } catch (e) {
    flash(String(e));
  } finally {
    cancelBusy.value = false;
  }
}

// ===== 仓位下单 =====
const posForm = reactive({
  code: "",
  side: "BUY",
  position: 2,
  refPrice: "",
});
const POSITIONS = [
  { v: 1, t: "全仓" },
  { v: 2, t: "半仓" },
  { v: 3, t: "1/3 仓" },
  { v: 4, t: "1/4 仓" },
];
const posBusy = ref(false);
async function onPositionOrder() {
  const code = posForm.code.trim();
  const refPrice = parseFloat(posForm.refPrice);
  if (!/^\d{6}$/.test(code)) return flash("请填写 6 位股票代码");
  if (!(refPrice > 0)) return flash("请填写参考价（用于资金护栏与金额估算）");
  if (isLive.value) {
    const ok = await confirmDialog({
      title: "真实资金 · 仓位下单",
      message:
        `即将在同花顺真实账户以「${POSITIONS.find((p) => p.v === posForm.position)?.t}」${posForm.side === "BUY" ? "买入" : "卖出"} ${code}。\n\n` +
        "系统会先按可用资金换算股数并截图，由你核对后才会点「确定」。确认继续？",
      confirmText: "去核对下单",
      danger: true,
    });
    if (!ok) return;
  }
  posBusy.value = true;
  try {
    const cid = await brokerClientPositionOrder(
      code,
      posForm.side,
      posForm.position,
      refPrice,
    );
    flash(`已按仓位填单（${cid}），请到下单核对弹窗确认`);
  } catch (e) {
    flash(String(e));
  } finally {
    posBusy.value = false;
  }
}

// ===== 高级调试（默认折叠，藏能力换简单）=====
const advOpen = ref(false);
const keySeq = ref("");
const clickX = ref("");
const clickY = ref("");
const advBusy = ref(false);
async function onSendKey() {
  const key = keySeq.value.trim();
  if (!key) return flash("请输入键盘序列，如 F4 或 600519 ENTER 21 ENTER");
  advBusy.value = true;
  try {
    await brokerClientSendKey(key);
    flash("已发送键盘序列");
  } catch (e) {
    flash(String(e));
  } finally {
    advBusy.value = false;
  }
}
async function onClick() {
  const x = parseInt(clickX.value, 10);
  const y = parseInt(clickY.value, 10);
  if (!(x >= 0) || !(y >= 0)) return flash("请输入有效坐标");
  advBusy.value = true;
  try {
    await brokerClientClick(x, y);
    flash(`已点击 (${x}, ${y})`);
  } catch (e) {
    flash(String(e));
  } finally {
    advBusy.value = false;
  }
}

// ===== 人工验证码 / 撤单截图确认（来自 broker:client_screenshot）=====
const captchaShot = ref<ClientShot | null>(null);
const captchaText = ref("");
const cancelShot = ref<ClientShot | null>(null);
const shotBusy = ref(false);
async function onCaptchaSubmit() {
  const text = captchaText.value.trim();
  if (!text) return flash("请输入图中验证码数字");
  shotBusy.value = true;
  try {
    await brokerClientCaptchaInput(text);
    captchaShot.value = null;
    captchaText.value = "";
    flash("验证码已提交，正在继续读取表格");
  } catch (e) {
    flash(String(e));
  } finally {
    shotBusy.value = false;
  }
}
async function onCancelConfirm(approved: boolean) {
  const shot = cancelShot.value;
  if (!shot?.client_order_id || shotBusy.value) return;
  shotBusy.value = true;
  try {
    await brokerClientConfirm(shot.client_order_id, approved);
    flash(approved ? "已确认撤单" : "已取消撤单");
    cancelShot.value = null;
  } catch (e) {
    flash(String(e));
  } finally {
    shotBusy.value = false;
  }
}

// ===== 事件监听 / 轮询 =====
let tick: ReturnType<typeof setInterval> | undefined;
const unlisteners: UnlistenFn[] = [];
onMounted(() => {
  void refresh();
  void loadApiCfg();
  tick = setInterval(() => {
    void loadStatus();
    void loadAsset();
    if (connected.value) void refreshTab();
  }, 6000);
  listen<{ trades?: BrokerTrade[] }>("broker:trades", (ev) => {
    if (ev.payload?.trades) trades.value = ev.payload.trades;
  }).then((u) => unlisteners.push(u));
  listen<{ orders?: BrokerPending[] }>("broker:pending", (ev) => {
    if (ev.payload?.orders) pending.value = ev.payload.orders;
  }).then((u) => unlisteners.push(u));
  listen<ClientAppState>("broker:app_state", (ev) => {
    if (ev.payload) appState.value = ev.payload;
  }).then((u) => unlisteners.push(u));
  listen<ClientCurrentPage>("broker:current_page", (ev) => {
    if (ev.payload) currentPage.value = ev.payload;
  }).then((u) => unlisteners.push(u));
  listen<ClientShot>("broker:client_screenshot", (ev) => {
    const shot = ev.payload;
    if (!shot) return;
    if (shot.expect?.captcha) {
      captchaShot.value = shot;
      captchaText.value = "";
    } else if (shot.expect?.cancelPage) {
      cancelShot.value = shot;
    }
  }).then((u) => unlisteners.push(u));
  // 连接 / 断开事件：状态实时联动，不再等 6s 轮询。
  listen<{ event?: string }>("broker:sidecar", (ev) => {
    const e = ev.payload?.event;
    if (e === "connected" || e === "disconnected") {
      void refresh();
    }
  }).then((u) => unlisteners.push(u));
});
onBeforeUnmount(() => {
  if (tick) clearInterval(tick);
  clearTimeout(toastTimer);
  for (const u of unlisteners) u();
  unlisteners.length = 0;
});
</script>

<template>
  <div class="bc">
    <!-- 状态条 -->
    <div class="bc-head">
      <span class="bc-dot" :class="{ on: connected }"></span>
      <span class="bc-conn">{{ connected ? "客户端已连接" : "客户端未连接" }}</span>
      <span v-if="connected && status?.accountId" class="bc-acct">· {{ status.accountId }}</span>
      <span v-if="isLive" class="bc-live">真实盘</span>
      <span v-else-if="connected" class="bc-sim">模拟盘</span>
      <span class="bc-spacer"></span>
      <button class="bc-btn" :disabled="loading" @click="onCheckApp">探测客户端</button>
      <button class="bc-btn" :disabled="loading" @click="refresh">刷新</button>
    </div>

    <!-- 自检结果 -->
    <div v-if="appState.running !== undefined || currentPage.found !== undefined" class="bc-selfcheck">
      <template v-if="appState.running !== undefined">
        <span class="sc-item">进程：<b :class="appState.running ? 'ok' : 'bad'">{{ appState.running ? "运行中" : "未运行" }}</b></span>
      </template>
      <template v-if="currentPage.found !== undefined">
        <span class="sc-item">窗口：<b :class="currentPage.found ? 'ok' : 'bad'">{{ currentPage.found ? "已找到" : "未找到" }}</b></span>
        <span v-if="currentPage.title" class="sc-item sc-title">{{ currentPage.title }}</span>
      </template>
    </div>

    <!-- 资金四格 -->
    <div class="bc-asset">
      <div class="ba-cell">
        <div class="ba-k">总资产</div>
        <div class="ba-v">{{ fmtMoney(asset?.totalAsset) }}</div>
      </div>
      <div class="ba-cell">
        <div class="ba-k">可用资金</div>
        <div class="ba-v">{{ fmtMoney(asset?.cash) }}</div>
      </div>
      <div class="ba-cell">
        <div class="ba-k">持仓市值</div>
        <div class="ba-v">{{ fmtMoney(asset?.marketValue) }}</div>
      </div>
      <div class="ba-cell">
        <div class="ba-k">当日盈亏</div>
        <div class="ba-v" :class="pnlCls(asset?.dayPnl)">{{ fmtMoney(asset?.dayPnl) }}</div>
      </div>
    </div>
    <div v-if="asset?.note" class="bc-note">{{ asset.note }}</div>

    <!-- Tabs -->
    <div class="bc-tabs">
      <button
        v-for="t in TABS"
        :key="t.k"
        class="bc-tab"
        :class="{ on: tab === t.k }"
        @click="tab = t.k; refreshTab()"
      >{{ t.t }}</button>
      <span class="bc-spacer"></span>
      <!-- 挂单页：撤单操作 -->
      <template v-if="tab === 'pending'">
        <button class="bc-btn danger" :disabled="cancelBusy || !connected" @click="onCancelAll('X')">撤买</button>
        <button class="bc-btn danger" :disabled="cancelBusy || !connected" @click="onCancelAll('C')">撤卖</button>
        <button class="bc-btn danger" :disabled="cancelBusy || !connected" @click="onCancelAll('A')">全撤</button>
      </template>
    </div>

    <!-- API 控制台（独立于连接状态：API 服务开启即可用） -->
    <div v-if="tab === 'api'" class="bc-api">
      <div class="api-head">
        <div class="api-addr">
          <span class="api-dot" :class="apiHealth"></span>
          <span class="api-base">{{ apiBase() || "API 服务未开启" }}</span>
          <span v-if="apiCfg.token" class="api-tag">令牌保护</span>
          <span v-else class="api-tag ghost">本机免密</span>
        </div>
        <div class="api-actions">
          <button class="bc-btn" :disabled="apiBusy === 'health'" @click="apiPing">
            {{ apiHealth === "unknown" ? "健康检查" : apiHealth === "ok" ? "服务正常 · 再查" : "检查服务" }}
          </button>
          <button class="bc-btn" :disabled="apiBusy !== null" @click="loadApiCfg">刷新配置</button>
        </div>
      </div>
      <div v-if="!apiBase()" class="api-tip">
        未开启 HTTP API 服务：设置 → 券商交易 → 同花顺客户端 → 「HTTP API 服务」打开并保存配置，然后连接通道。开启后本页即可一键调用全部接口。
      </div>
      <template v-else>
        <div class="api-group" v-for="g in API_GROUPS" :key="g">
          <div class="api-group-title">{{ g }}</div>
          <div v-for="ep in APIS.filter((e) => e.group === g)" :key="ep.key" class="api-card">
            <div class="api-card-head">
              <code class="api-path">{{ ep.path }}</code>
              <span class="api-desc">{{ ep.desc }}</span>
              <span class="api-spacer"></span>
              <button class="bc-btn" :disabled="apiBusy !== null" @click="apiCall(ep)">
                {{ apiBusy === ep.key ? "调用中…" : "调用" }}
              </button>
            </div>
            <div v-if="ep.params.length" class="api-params">
              <template v-for="p in ep.params" :key="p.name">
                <select v-if="p.options" v-model="apiForm[ep.key][p.name]" class="api-in">
                  <option v-for="o in p.options" :key="o.v" :value="o.v">{{ o.t }}</option>
                </select>
                <input v-else v-model="apiForm[ep.key][p.name]" class="api-in" :placeholder="p.ph" spellcheck="false" />
              </template>
            </div>
            <code class="api-curl" :title="apiCurl(ep)">{{ apiCurl(ep) }}</code>
          </div>
        </div>
        <div v-if="apiResult" class="api-result" :class="{ bad: !apiResult.ok }">
          <div class="api-result-head">
            <span>{{ apiResult.endpoint }}</span>
            <span class="api-result-state">{{ apiResult.ok ? "✓ 成功" : "✗ 失败" }}</span>
          </div>
          <pre class="api-json">{{ apiResult.text }}</pre>
        </div>
      </template>
    </div>

    <!-- 未连接空态 -->
    <div v-else-if="!connected" class="bc-empty">
      <div class="be-icon">🔌</div>
      <div class="be-title">客户端通道未连接</div>
      <div class="be-desc">连接真实同花顺客户端前，可以先一键演练：自动切换 dry-run 通道并展示完整的虚拟账户数据（持仓 / 成交 / 挂单 / 资金），不碰真实客户端、不碰真钱。</div>
      <div class="bc-drill-row">
        <button class="bc-drill-btn" :disabled="drillBusy" @click="onDrillRun">
          {{ drillBusy ? "演练启动中…" : "一键演练（dry-run）" }}
        </button>
        <button class="bc-drill-btn ghost" @click="goSettings">去设置连接</button>
      </div>
    </div>

    <!-- 表格区 -->
    <div v-else class="bc-table-wrap">
      <!-- 持仓 -->
      <table v-if="tab === 'position'" class="bc-table">
        <thead>
          <tr>
            <th>代码</th><th>名称</th><th class="r">持仓</th><th class="r">可用</th>
            <th class="r">成本</th><th class="r">现价</th><th class="r">市值</th><th class="r">盈亏</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!positions.length"><td colspan="8" class="bc-row-empty">暂无持仓</td></tr>
          <tr v-for="p in positions" :key="p.code">
            <td class="mono">{{ p.code }}</td>
            <td>{{ p.name || "--" }}</td>
            <td class="r mono">{{ p.vol }}</td>
            <td class="r mono">{{ p.avail }}</td>
            <td class="r mono">{{ fmtNum(p.cost) }}</td>
            <td class="r mono">{{ fmtNum(p.price) }}</td>
            <td class="r mono">{{ fmtMoney(p.marketValue) }}</td>
            <td class="r mono" :class="pnlCls(p.pnl)">{{ fmtMoney(p.pnl) }}</td>
          </tr>
        </tbody>
      </table>

      <!-- 当日成交 -->
      <table v-else-if="tab === 'trades'" class="bc-table">
        <thead>
          <tr>
            <th>时间</th><th>代码</th><th>名称</th><th>方向</th>
            <th class="r">价格</th><th class="r">数量</th><th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!trades.length"><td colspan="7" class="bc-row-empty">暂无当日成交</td></tr>
          <tr v-for="(t, i) in trades" :key="i">
            <td class="mono">{{ t.time || "--" }}</td>
            <td class="mono">{{ t.code }}</td>
            <td>{{ t.name || "--" }}</td>
            <td :class="sideCls(t.side)">{{ sideText(t.side) }}</td>
            <td class="r mono">{{ fmtNum(t.price) }}</td>
            <td class="r mono">{{ t.vol }}</td>
            <td>{{ t.status || "--" }}</td>
          </tr>
        </tbody>
      </table>

      <!-- 当日挂单 -->
      <table v-else class="bc-table">
        <thead>
          <tr>
            <th>时间</th><th>代码</th><th>名称</th><th>方向</th>
            <th class="r">价格</th><th class="r">委托</th><th class="r">已成</th><th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!pending.length"><td colspan="8" class="bc-row-empty">暂无当日挂单</td></tr>
          <tr v-for="(o, i) in pending" :key="i">
            <td class="mono">{{ o.time || "--" }}</td>
            <td class="mono">{{ o.code }}</td>
            <td>{{ o.name || "--" }}</td>
            <td :class="sideCls(o.side)">{{ sideText(o.side) }}</td>
            <td class="r mono">{{ fmtNum(o.price) }}</td>
            <td class="r mono">{{ o.vol }}</td>
            <td class="r mono">{{ o.filledVol ?? 0 }}</td>
            <td>{{ o.status || "--" }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 仓位下单 -->
    <div v-if="connected" class="bc-posbox">
      <div class="bp-title">仓位下单（键盘精灵自动填单）</div>
      <div class="bp-row">
        <select v-model="posForm.side">
          <option value="BUY">买入</option>
          <option value="SELL">卖出</option>
        </select>
        <input v-model="posForm.code" placeholder="代码 600519" spellcheck="false" />
        <input v-model="posForm.refPrice" placeholder="参考价" type="number" step="0.01" />
      </div>
      <div class="bp-row">
        <div class="bp-seg">
          <button
            v-for="p in POSITIONS"
            :key="p.v"
            class="bp-seg-btn"
            :class="{ on: posForm.position === p.v }"
            @click="posForm.position = p.v"
          >{{ p.t }}</button>
        </div>
        <button class="bp-submit" :disabled="posBusy" @click="onPositionOrder">
          {{ posBusy ? "填单中…" : "按仓位填单" }}
        </button>
      </div>
    </div>

    <!-- 高级调试（折叠） -->
    <details v-if="connected" class="bc-adv">
      <summary>高级调试（键盘 / 点击透传，真机校准用）</summary>
      <div class="adv-row">
        <input v-model="keySeq" placeholder="键盘序列，如 F4 或 600519 ENTER 21 ENTER" spellcheck="false" />
        <button class="bc-btn" :disabled="advBusy" @click="onSendKey">发送</button>
      </div>
      <div class="adv-row">
        <input v-model="clickX" placeholder="x" type="number" />
        <input v-model="clickY" placeholder="y" type="number" />
        <button class="bc-btn" :disabled="advBusy" @click="onClick">点击坐标</button>
      </div>
    </details>

    <!-- 人工验证码弹窗 -->
    <transition name="bc-fade">
      <div v-if="captchaShot" class="bc-mask" @click.self="captchaShot = null">
        <div class="bc-modal">
          <div class="bm-title">需要验证码</div>
          <div class="bm-desc">同花顺复制表格时弹出验证码，请输入下图中的数字后继续。</div>
          <div class="bm-shot">
            <img v-if="captchaShot.shot" :src="captchaShot.shot" alt="验证码" />
            <div v-else class="bm-noshot">未获取到验证码图片</div>
          </div>
          <div class="adv-row">
            <input
              v-model="captchaText"
              placeholder="输入图中数字"
              spellcheck="false"
              @keydown.enter="onCaptchaSubmit"
            />
            <button class="bp-submit" :disabled="shotBusy" @click="onCaptchaSubmit">提交</button>
          </div>
        </div>
      </div>
    </transition>

    <!-- 撤单截图确认 -->
    <transition name="bc-fade">
      <div v-if="cancelShot" class="bc-mask" @click.self="cancelShot = null">
        <div class="bc-modal">
          <div class="bm-title">撤单核对</div>
          <div class="bm-desc">请核对截图中的撤单页面（撤买 / 撤卖 / 全撤），确认后才会在客户端落键。</div>
          <div class="bm-shot">
            <img v-if="cancelShot.shot" :src="cancelShot.shot" alt="撤单页面" />
            <div v-else class="bm-noshot">暂无截图</div>
          </div>
          <div class="bm-actions">
            <button class="bc-btn" :disabled="shotBusy" @click="onCancelConfirm(false)">取消撤单</button>
            <button class="bp-submit danger" :disabled="shotBusy" @click="onCancelConfirm(true)">核对无误 · 确认撤单</button>
          </div>
        </div>
      </div>
    </transition>

    <transition name="bc-toast">
      <div v-if="toastMsg" class="bc-toast">{{ toastMsg }}</div>
    </transition>
  </div>
</template>

<style scoped>
.bc {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  font-size: 12px;
  overflow-y: auto;
}
.bc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.bc-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #4a5565; flex-shrink: 0;
}
.bc-dot.on { background: #26d07c; box-shadow: 0 0 6px rgba(38, 208, 124, 0.6); }
.bc-conn { font-weight: 600; color: var(--text, #e6ecf5); }
.bc-acct { color: var(--text-dim, #7c8798); font-size: 11px; }
.bc-live { color: #fff; background: #f23645; border-radius: 4px; padding: 0 6px; font-size: 10px; font-weight: 700; }
.bc-sim { color: #ffb13d; border: 1px solid rgba(255, 177, 61, 0.5); border-radius: 4px; padding: 0 6px; font-size: 10px; }
.bc-spacer { flex: 1; }
.bc-btn {
  border: 1px solid var(--border, #2a3344);
  background: transparent;
  color: var(--text-dim, #97a0b2);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
}
.bc-btn:hover:not(:disabled) { color: var(--accent, #e8c878); border-color: var(--accent, #e8c878); }
.bc-btn.danger { color: #ff7a85; border-color: rgba(242, 54, 69, 0.5); }
.bc-btn.danger:hover:not(:disabled) { background: rgba(242, 54, 69, 0.12); }
.bc-btn:disabled { opacity: 0.5; cursor: default; }

.bc-selfcheck {
  display: flex; flex-wrap: wrap; gap: 6px 14px;
  padding: 6px 9px; border-radius: 7px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border, #2a3344);
  font-size: 11px; color: var(--text-dim, #97a0b2);
  flex-shrink: 0;
}
.sc-item b { font-weight: 700; }
.sc-item b.ok { color: #26d07c; }
.sc-item b.bad { color: #ff7a85; }
.sc-title { color: var(--text, #e6ecf5); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.bc-asset {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  flex-shrink: 0;
}
.ba-cell {
  background: var(--bg-card2, #15181f);
  border: 1px solid var(--border, #2a3344);
  border-radius: 8px;
  padding: 7px 9px;
  min-width: 0;
}
.ba-k { font-size: 10px; color: var(--text-dim, #7c8798); }
.ba-v { margin-top: 2px; font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text, #e6ecf5); }
.ba-v.up { color: #f23645; }
.ba-v.down { color: #0ecb81; }
.bc-note { font-size: 10px; color: var(--text-dim, #7c8798); flex-shrink: 0; }

.bc-tabs {
  display: flex; align-items: center; gap: 6px;
  border-bottom: 1px solid var(--border, #2a3344);
  flex-shrink: 0;
}
.bc-tab {
  border: none; background: none;
  color: var(--text-dim, #97a0b2);
  padding: 5px 12px; font-size: 12px; cursor: pointer;
  border-bottom: 2px solid transparent;
}
.bc-tab.on { color: var(--accent, #e8c878); border-bottom-color: var(--accent, #e8c878); font-weight: 600; }

.bc-empty {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 8px; text-align: center; padding: 24px;
  color: var(--text-dim, #8892a8);
}
.be-icon { font-size: 26px; }
.be-title { font-size: 13px; font-weight: 600; color: var(--text, #e0e6f0); }
.be-desc { font-size: 10.5px; line-height: 1.6; max-width: 300px; }
.bc-drill-row { display: flex; gap: 10px; margin-top: 6px; flex-wrap: wrap; justify-content: center; }
.bc-drill-btn {
  background: linear-gradient(135deg, #b8860b, #e8c878); color: #1a1306;
  border: none; border-radius: 8px; padding: 9px 18px; font-size: 12px; font-weight: 600;
  cursor: pointer;
}
.bc-drill-btn.ghost {
  background: transparent; color: var(--text-dim, #8892a8);
  border: 1px solid var(--border, #2a3344);
}
.bc-drill-btn:hover { filter: brightness(1.08); }
.bc-drill-btn:disabled { opacity: .55; cursor: default; }

.bc-api { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.api-head { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.api-addr { display: flex; align-items: center; gap: 7px; font-weight: 600; color: var(--text, #e6ecf5); }
.api-base { font-variant-numeric: tabular-nums; }
.api-dot { width: 8px; height: 8px; border-radius: 50%; background: #4a5565; flex-shrink: 0; }
.api-dot.ok { background: #26d07c; box-shadow: 0 0 6px rgba(38, 208, 124, 0.6); }
.api-dot.fail { background: #f23645; box-shadow: 0 0 6px rgba(242, 54, 69, 0.6); }
.api-tag { color: #ffb13d; border: 1px solid rgba(255, 177, 61, 0.5); border-radius: 4px; padding: 0 5px; font-size: 10px; }
.api-tag.ghost { color: var(--text-dim, #97a0b2); border-color: var(--border, #2a3344); }
.api-actions { margin-left: auto; display: flex; gap: 6px; flex-shrink: 0; }
.api-tip { padding: 10px 12px; border-radius: 7px; background: rgba(255, 177, 61, 0.08); border: 1px solid rgba(255, 177, 61, 0.35); color: var(--text-dim, #97a0b2); font-size: 11px; line-height: 1.6; }
.api-group-title { margin: 4px 0 2px; font-size: 11px; color: var(--text-dim, #7c8798); font-weight: 600; letter-spacing: 0.5px; }
.api-card { border: 1px solid var(--border, #2a3344); border-radius: 7px; padding: 6px 9px; background: rgba(255, 255, 255, 0.02); }
.api-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.api-path { color: var(--accent, #e8c878); font-size: 12px; font-weight: 600; }
.api-desc { color: var(--text-dim, #97a0b2); font-size: 11px; }
.api-spacer { flex: 1; }
.api-params { display: flex; gap: 6px; margin-top: 5px; flex-wrap: wrap; }
.api-in {
  background: #141b28; border: 1px solid var(--border, #2a3344); border-radius: 5px;
  color: var(--text, #e6ecf5); font-size: 11px; padding: 3px 7px; min-width: 90px; max-width: 180px;
}
.api-in:focus { outline: none; border-color: var(--accent, #e8c878); }
.api-curl {
  display: block; margin-top: 5px; font-size: 10px; color: var(--text-dim, #7c8798);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: all;
}
.api-result { border: 1px solid var(--border, #2a3344); border-radius: 7px; overflow: hidden; }
.api-result.bad { border-color: rgba(242, 54, 69, 0.5); }
.api-result-head { display: flex; align-items: center; gap: 8px; padding: 5px 9px; font-size: 11px; color: var(--text-dim, #97a0b2); background: rgba(255, 255, 255, 0.03); }
.api-result-state { margin-left: auto; color: #26d07c; font-weight: 600; }
.api-result.bad .api-result-state { color: #ff7a85; }
.api-json { margin: 0; padding: 8px 10px; font-size: 10px; line-height: 1.5; color: #9fd0a4; background: #0c111b; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
.bc-table-wrap { flex: 1; min-height: 0; overflow: auto; }
.bc-table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: auto; }
.bc-table th {
  position: sticky; top: 0; z-index: 1;
  text-align: left; font-weight: 600;
  color: var(--text-dim, #7c8798);
  background: var(--bg-panel, #15181f);
  padding: 5px 8px; border-bottom: 1px solid var(--border, #2a3344);
  white-space: nowrap;
}
.bc-table th.r, .bc-table td.r { text-align: right; }
.bc-table td { padding: 5px 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); color: var(--text, #e6ecf5); white-space: nowrap; }
.mono { font-variant-numeric: tabular-nums; }
.up { color: #f23645; }
.down { color: #0ecb81; }
.bc-row-empty { text-align: center; color: var(--text-dim, #7c8798); padding: 22px 0 !important; }

.bc-posbox {
  flex-shrink: 0;
  border: 1px solid var(--border, #2a3344);
  border-radius: 9px;
  padding: 9px;
  background: var(--bg-card2, #15181f);
  display: flex; flex-direction: column; gap: 7px;
}
.bp-title { font-size: 11.5px; font-weight: 600; color: var(--accent, #e8c878); }
.bp-row { display: flex; gap: 6px; align-items: center; }
.bp-row select, .bp-row input {
  flex: 1; min-width: 0;
  background: var(--bg-input, #0e1117);
  border: 1px solid var(--border, #2a3344);
  border-radius: 6px; color: var(--text, #e6ecf5);
  padding: 5px 8px; font-size: 11px;
}
.bp-seg { display: flex; flex: 1; border: 1px solid var(--border, #2a3344); border-radius: 6px; overflow: hidden; }
.bp-seg-btn { flex: 1; border: none; background: none; color: var(--text-dim, #97a0b2); padding: 5px 0; font-size: 11px; cursor: pointer; }
.bp-seg-btn.on { background: var(--accent, #e8c878); color: #14161c; font-weight: 700; }
.bp-submit {
  flex-shrink: 0; border: 1px solid var(--accent, #e8c878);
  background: var(--accent, #e8c878); color: #14161c;
  border-radius: 6px; padding: 5px 14px; font-size: 11px; font-weight: 700; cursor: pointer;
}
.bp-submit.danger { background: #f23645; border-color: #f23645; color: #fff; }
.bp-submit:disabled { opacity: 0.5; cursor: default; }

.bc-adv {
  flex-shrink: 0;
  border: 1px dashed var(--border, #2a3344);
  border-radius: 8px; padding: 7px 9px;
  color: var(--text-dim, #97a0b2);
}
.bc-adv summary { cursor: pointer; font-size: 11px; outline: none; }
.adv-row { display: flex; gap: 6px; margin-top: 7px; }
.adv-row input {
  flex: 1; min-width: 0;
  background: var(--bg-input, #0e1117);
  border: 1px solid var(--border, #2a3344);
  border-radius: 6px; color: var(--text, #e6ecf5);
  padding: 5px 8px; font-size: 11px;
}

.bc-mask { position: fixed; inset: 0; background: rgba(5, 8, 15, 0.72); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; z-index: 1200; padding: 24px; }
.bc-modal { width: min(420px, 92vw); max-height: 86vh; overflow: auto; background: #12161f; border: 1px solid rgba(90, 160, 255, 0.35); border-radius: 12px; padding: 16px; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.6); }
.bm-title { font-size: 15px; font-weight: 700; margin-bottom: 8px; color: var(--text, #e6ecf5); }
.bm-desc { font-size: 12px; color: var(--text-dim, #97a0b2); line-height: 1.6; margin-bottom: 10px; }
.bm-shot { border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; overflow: hidden; background: #0b0e14; margin-bottom: 12px; }
.bm-shot img { display: block; width: 100%; height: auto; }
.bm-noshot { padding: 26px; text-align: center; opacity: 0.5; font-size: 12px; }
.bm-actions { display: flex; gap: 10px; justify-content: flex-end; }
.bc-fade-enter-active, .bc-fade-leave-active { transition: opacity 0.18s; }
.bc-fade-enter-from, .bc-fade-leave-to { opacity: 0; }

.bc-toast {
  position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%);
  background: rgba(20, 22, 28, 0.95);
  border: 1px solid var(--accent, #e8c878);
  color: var(--text, #e6ecf5);
  border-radius: 8px; padding: 7px 16px; font-size: 11px;
  z-index: 30; white-space: nowrap; max-width: 90%;
  overflow: hidden; text-overflow: ellipsis;
}
.bc-toast-enter-active, .bc-toast-leave-active { transition: all 0.25s; }
.bc-toast-enter-from, .bc-toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(8px); }
</style>
