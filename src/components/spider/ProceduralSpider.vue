<script setup lang="ts">
// 全屏 Canvas 渲染层：只负责把 SpiderSim 画出来 + 响应扫描事件驱动路径。
// pointer-events:none，所有业务（评分/落桥/后端）在引擎与 Rust 侧。
import { onBeforeUnmount, onMounted, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { SpiderSim, type ScanPoint, type SignalKind } from "./sim";
import { resolveSignal } from "./signals";
import { useSpiderAnchors } from "../../composables/useSpiderAnchors";
import {
  onSpiderScan,
  advanceRound,
  heartbeat,
  addLog,
  autoTrade,
  type SpiderScanEvent,
} from "../../composables/useSpiderBotEngine";
import { usePaperStore } from "../../stores/paper";
import { useWorkbench } from "../../composables/useWorkbench";
import { naturalWaypoints, roamPath, localWanderPath, type Vec2 } from "./ik";
import type { Anchor } from "./anchors";
import { CARD_META, type CardId } from "../../lib/cards";
import { buildFrameGraph, type CardRect, type FrameGraph } from "./graph";
import { planCut, type CutPlan } from "./director";
import { collectUi, type UiElement } from "./uiGraph";
import { tap as actionTap, scrollBy as actionScroll } from "./actions";
import { planPlaybook, type OpStep } from "./playbook";
import { getCapability } from "./cardRegistry";

const props = defineProps<{ logEl: Element | null }>();

const COLORS = {
  buy: "#ff4d8d",
  sell: "#17c964",
  scan: "#2fd4e1",
  leg: "#37e6f0",
  joint: "#ff5ea8",
  string: "#ff7ad9",
};

const canvasRef = ref<HTMLCanvasElement | null>(null);
const anchors = useSpiderAnchors();
const paperStore = usePaperStore();
const bench = useWorkbench();
const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

let sim: SpiderSim;
let ctx2d: CanvasRenderingContext2D | null = null;
let raf = 0;
let last = 0;
let signalByCode = new Map<string, SignalKind>();
let flyTimer = 0;
// 有界重采令牌
let collectToken = 0;
let collectRetry = 0;
let lastCardId: CardId | null = null;
// 轮次推进
let roundDone = false;
let advanceTimer = 0;
let cardEnterAt = 0;
let lastHeartbeat = 0;
// 滚动重采去抖
let scrollTimer = 0;
let alive = false;
// ===== P1 卡片骨架路网 + 三幕切卡 =====
let frameGraph: FrameGraph = { nodes: [], edges: [] };
let graphRaf = 0;
let graphBuilt = false;
// 切卡状态机
let cutActive = false;
let cutPlan: CutPlan | null = null;
let cutActIdx = 0;
let cutTarget: CardId | null = null;
let cutRetryTimer = 0;
let unlisten: (() => void) | null = null;
let unlistenSignal: (() => void) | null = null;
let dpr = 1;
// 扫描数据粒子：从行内被光束"吸出来"流向蜘蛛
const scanParticles: {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; size: number; color: string;
}[] = [];
const MAX_SCAN_PARTICLES = 60;
// 空转漫游定时器（统一管理启动阶段+引擎跳卡两种场景）
let idleRoamTimer = 0;
const IDLE_ROAM_MS = 600;
// ===== P2 卡片内主动操作（playbook 状态机） =====
let opActive = false;            // 是否处于"操作当前卡片"阶段
let opSteps: OpStep[] = [];      // 待执行 / 执行中的操作剧本
let opPending: OpStep | null = null; // 正在爬向 / 等待反馈的操作（非空时不取下一个）
let opWaitTimer = 0;             // 动作后等待反馈
let opCardId: CardId | null = null;
let opScrollRounds = 0;          // 本卡已滚动加载次数
let opDoneIds = new Set<string>(); // 本卡已操作元素 id（去重）
let opToken = 0;                 // 卡片切换令牌，作废旧回调
const OP_WAIT_FALLBACK = 400;
// ===== P2 交易闭环（fastbrain 信号 → 模拟交易卡点买卖 → 成交回报） =====
type TradeSide = "buy" | "sell";
interface TradeIntent {
  key: string;
  code: string;
  name: string;
  side: TradeSide;
  action: "executed" | "watch" | "rejected";
  confidence: number;
  message: string;
  ts: string;
}
type TradePhase =
  | "select-stock"   // 让全局选中 = 信号股票（点来源卡行）
  | "open-trade"     // 打开模拟交易卡
  | "set-side"       // 点 买入 / 卖出
  | "set-vol"        // 点仓位（1/3 等）
  | "submit"         // 点下单（watch 真实成交）/ 只按压（executed 已成交）
  | "report"         // 看持仓 / 委托，头顶气泡回报
  | "done";
const tradeQueue: TradeIntent[] = [];
const tradeHandled = new Set<string>();
let tradeActive = false;
let tradePhase: TradePhase = "done";
let tradeIntent: TradeIntent | null = null;
let tradeTarget: UiElement | null = null; // 当前阶段爬向的元素
let tradeArriveId = "";
let tradeWaitTimer = 0;
let tradeToken = 0;
const TRADE_TRY_LIMIT = 50;

// ===== 后端成交/信号事件：蜘蛛头顶状态气泡（fastbrain-signal）=====
interface BrokerToast {
  x: number; y: number;
  text: string; sub: string; color: string;
  born: number; life: number;
}
const brokerToasts: BrokerToast[] = [];
const BROKER_TOAST_LIFE = 3400;

/** 收到后端快脑成交/信号：写日志中心 + 在蜘蛛头顶生成状态气泡（P3 再补完整交易表演） */
function onBrokerSignal(p: any) {
  if (!sim) return;
  const action = String(p?.action ?? "watch");
  const name = String(p?.name ?? p?.code ?? "");
  const message = String(p?.message ?? "");
  const conf = typeof p?.confidence === "number" ? p.confidence : null;
  const haystack = `${p?.label ?? ""} ${message}`;

  let text: string;
  let color: string;
  let logType: "info" | "buy" | "sell" | "warn";
  if (action === "executed") {
    const isBuy = /买|BUY|买入|BUYING/i.test(haystack);
    text = isBuy ? "✅ 已买入成交" : "✅ 已卖出成交";
    color = isBuy ? COLORS.buy : COLORS.sell;
    logType = isBuy ? "buy" : "sell";
  } else if (action === "rejected") {
    text = "⛔ 交易被拦截";
    color = "#ff7a59";
    logType = "warn";
  } else {
    text = "👁 信号·关注";
    color = COLORS.scan;
    logType = "info";
  }
  const sub = `${name}${conf !== null ? " 置信" + Math.round(conf * 100) + "%" : ""}`;
  brokerToasts.push({
    x: sim.body.x, y: sim.body.y - 48,
    text, sub, color,
    born: performance.now(), life: BROKER_TOAST_LIFE,
  });
  if (brokerToasts.length > 4) brokerToasts.shift();
  addLog(`${text}｜${name}${message ? "｜" + message : ""}`, logType);

  // 交易闭环：解析方向并入队。rejected 不交易；watch 需授权才自动点；executed 只看回报。
  const code = String(p?.code ?? "");
  const ts = String(p?.ts ?? "");
  const key = `${code}:${action}:${ts}`;
  const dir: TradeSide = /卖|SELL/i.test(haystack) ? "sell" : "buy";
  if (code && action !== "rejected" && !tradeHandled.has(key)) {
    tradeQueue.push({
      key, code, name, side: dir,
      action: action as TradeIntent["action"],
      confidence: conf ?? 0, message, ts,
    });
    if (tradeQueue.length > 8) tradeQueue.shift();
  }
}

// 自动推进：路径走完后引擎没响应，就自动跳下一张卡（自动发现模式的补充）
let autoNextTimer = 0;
const AUTO_NEXT_MS = 1200;

function triggerAutoNext() {
  if (autoNextTimer) return;
  autoNextTimer = window.setTimeout(() => {
    autoNextTimer = 0;
    // 引擎在驱动（收到过 card 事件）→ 等引擎给卡，不自行轮转，避免双驱动打架；
    // 仅纯蜘蛛模式（无引擎事件）才自动发现下一张可见卡
    if (lastCardId !== null) return;
    autoDiscoverNext();
  }, AUTO_NEXT_MS);
}

function clearAutoNext() {
  if (autoNextTimer) { clearTimeout(autoNextTimer); autoNextTimer = 0; }
}

// ===== 自动发现：引擎事件没连上时，蜘蛛自己找页面上的卡片爬 =====
// 双保险：启动后 1.5s 还没收到 card 事件，就自动扫描页面上的卡片
const AUTO_DISCOVER_MS = 1500;
let autoDiscoverTimer = 0;

function startAutoDiscover() {
  if (autoDiscoverTimer) return;
  autoDiscoverTimer = window.setTimeout(() => {
    autoDiscoverTimer = 0;
    if (!alive || lastCardId !== null) return; // 已经收到过 card 事件就不用自动发现了
    autoDiscoverNext();
  }, AUTO_DISCOVER_MS);
}

function autoDiscoverNext() {
  if (!alive) return;
  if (lastCardId !== null) return; // 引擎在驱动：不自行轮转（单一调度中枢）
  // 页面当前所有可见卡（动态采集，覆盖全部已打开卡片，而非固定清单）
  const visible = collectCardRects().map((r) => r.cardId);
  if (!visible.length) {
    // 一个都找不到 → 1 秒后再试
    autoDiscoverTimer = window.setTimeout(autoDiscoverNext, 1000);
    return;
  }
  // 从当前卡的下一张开始轮转（当前卡不在列表则从头）
  const cur = lastCardId ? visible.indexOf(lastCardId) : -1;
  const next = visible[(cur + 1 + visible.length) % visible.length];
  planCard(next as CardId);
}

function stopAutoDiscover() {
  if (autoDiscoverTimer) { clearTimeout(autoDiscoverTimer); autoDiscoverTimer = 0; }
}

function signalColor(s: SignalKind): string {
  return s === "BUY" ? COLORS.buy : s === "SELL" ? COLORS.sell : COLORS.scan;
}

// ===== P1 卡片骨架路网：采集卡片矩形 → 构图 =====
function collectCardRects(): CardRect[] {
  const els = document.querySelectorAll(".card-shell[data-card-id]");
  const out: CardRect[] = [];
  els.forEach((el) => {
    const cardId = el.getAttribute("data-card-id");
    if (!cardId) return;
    const rc = el.getBoundingClientRect();
    if (rc.width <= 0 || rc.height <= 0) return;
    let headHeight = 32;
    const head = el.querySelector(".card-head");
    if (head) {
      const hr = head.getBoundingClientRect();
      if (hr.height > 0) headHeight = hr.height;
    }
    out.push({ cardId, x: rc.left, y: rc.top, width: rc.width, height: rc.height, headHeight });
  });
  return out;
}

function rebuildGraph(): void {
  frameGraph = buildFrameGraph(collectCardRects(), { w: window.innerWidth, h: window.innerHeight });
  graphBuilt = true;
}

function scheduleRebuildGraph(): void {
  if (graphRaf) return;
  graphRaf = requestAnimationFrame(() => {
    graphRaf = 0;
    rebuildGraph();
  });
}

// ===== P1-6 卡片视觉呼应（DOM class 驱动，CSS 见 CardShell）=====
function focusCard(cardId: CardId): void {
  document.querySelectorAll(".card-shell[data-card-id]").forEach((el) => {
    const id = el.getAttribute("data-card-id");
    el.classList.toggle("spider-focus", id === cardId);
    el.classList.toggle("spider-dim", id !== cardId);
  });
}

function clearCardFocus(): void {
  document.querySelectorAll(".spider-focus,.spider-dim,.spider-pass").forEach((el) => {
    el.classList.remove("spider-focus", "spider-dim", "spider-pass");
  });
}

function pulsePassedCard(cardId: string): void {
  const el = document.querySelector(`.card-shell[data-card-id="${cardId}"]`);
  if (!el) return;
  el.classList.remove("spider-pass");
  void (el as HTMLElement).offsetWidth; // 重启动画
  el.classList.add("spider-pass");
}

// ===== P1 三幕切卡状态机 =====
function beginCut(cardId: CardId): void {
  cutTarget = cardId;
  let hmNode = frameGraph.nodes.find((n) => n.id === `${cardId}:hm`);
  if (!hmNode) {
    rebuildGraph();
    hmNode = frameGraph.nodes.find((n) => n.id === `${cardId}:hm`);
  }
  if (!hmNode) {
    // 目标卡尚未进入路网（DOM 未就绪）：排队重建，短延时后重试
    scheduleRebuildGraph();
    if (!cutRetryTimer) {
      cutRetryTimer = window.setTimeout(() => {
        cutRetryTimer = 0;
        if (alive && cutTarget === cardId && !cutActive) beginCut(cardId);
      }, 220);
    }
    return;
  }

  const sameAsCurrent = lastCardId === cardId;
  const plan = planCut({
    graph: frameGraph,
    from: { ...sim.body },
    targetCardId: cardId,
    entry: { x: hmNode.x, y: hmNode.y },
    currentCardId: sameAsCurrent ? cardId : (lastCardId ?? null),
  });
  cutPlan = plan;
  cutActIdx = 0;
  cutActive = true;
  runNextAct();
}

function runNextAct(): void {
  if (!cutPlan) return;
  // 跳过空幕
  while (cutActIdx < cutPlan.acts.length && cutPlan.acts[cutActIdx].points.length === 0) {
    cutActIdx++;
  }
  if (cutActIdx >= cutPlan.acts.length) {
    finishCut();
    return;
  }
  const act = cutPlan.acts[cutActIdx];
  if (act.name === "act3") focusCard(cutTarget!);
  sim.resetPath(act.points);
}

function finishCut(): void {
  const target = cutTarget;
  cutActive = false;
  cutPlan = null;
  cutActIdx = 0;
  if (!target) return;
  lastCardId = target;
  // act3:ready → 进入卡片主动操作（切标签/滚动/点个股）；无可操作元素则逐行扫描兜底
  startOperate(target);
}

// ===== P2 卡片内主动操作（playbook 状态机） =====
function startOperate(cardId: CardId): void {
  const token = ++opToken;
  opCardId = cardId;
  opActive = true;
  opPending = null;
  opSteps = [];
  opScrollRounds = 0;
  opDoneIds = new Set<string>();
  if (opWaitTimer) { clearTimeout(opWaitTimer); opWaitTimer = 0; }
  let tries = 0;
  const attempt = () => {
    if (token !== opToken || !alive) return;
    const ui = collectUi(cardId);
    if (ui.length === 0) {
      if (++tries < 40) { opWaitTimer = window.setTimeout(attempt, 50); return; }
      opActive = false; // 一直采不到 → 退回逐行扫描
      scanRowsWithinCard(cardId);
      return;
    }
    opSteps = planPlaybook(ui, { scrollRounds: opScrollRounds, doneIds: opDoneIds });
    if (opSteps.length === 0) {
      opActive = false; // 无可操作元素 → 逐行扫描浏览
      scanRowsWithinCard(cardId);
    }
    // 有步骤则由 frame 驱动 take next
  };
  attempt();
}

// 通用：构建爬到某 UI 元素的路径（naturalWaypoints 曲线 via + 终点非via，anchor.id=arriveId）
function crawlToUi(ui: UiElement, arriveId: string): void {
  const target: Vec2 = { x: ui.cx, y: ui.cy };
  const pts: ScanPoint[] = [];
  const prev: Vec2 = { ...sim.body };
  const seed = Date.now() + arriveId.charCodeAt(arriveId.length - 1);
  const curve = naturalWaypoints(prev, target, { seed, intensity: 0.32 });
  curve.forEach((v, i) => {
    pts.push({
      x: v.x, y: v.y,
      anchor: { id: `${arriveId}:via${i}`, cardId: ui.cardId, x: v.x, y: v.y, width: 0, height: 0 },
      signal: null, via: true,
    });
  });
  pts.push({
    x: target.x, y: target.y,
    anchor: {
      id: arriveId, cardId: ui.cardId,
      x: target.x, y: target.y,
      width: ui.width, height: ui.height,
      code: ui.code, name: ui.name,
    },
    signal: null,
  });
  sim.resetPath(pts);
}
function crawlToOp(step: OpStep): void { crawlToUi(step.ui, step.arriveId); }

// 元素按压视觉：短暂高亮 + 涟漪（CSS 动画）
function pressVisual(el: HTMLElement): void {
  el.classList.remove("spider-press");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("spider-press");
  window.setTimeout(() => el.classList.remove("spider-press"), 420);
}

// 到达操作点 → 执行真实动作
function executeOp(step: OpStep): void {
  pressVisual(step.ui.el);
  let ok = false;
  if (step.type === "scroll-down") ok = actionScroll(step.ui.el, 1, 0.8).ok;
  else if (step.type === "tap") ok = actionTap(step.ui.el).ok;
  opDoneIds.add(step.ui.id);
  addLog(`${ok ? "🖱" : "⚠"} ${step.label}${ok ? "" : "（界面未响应）"}`, ok ? "info" : "warn");

  const rescan = step.rescan;
  const cardId = opCardId;
  const token = opToken;
  if (opWaitTimer) clearTimeout(opWaitTimer);
  opWaitTimer = window.setTimeout(() => {
    opWaitTimer = 0;
    opPending = null; // 反馈等待结束，允许取下一个
    if (token !== opToken || !alive || !cardId) return;
    if (rescan === "scroll") opScrollRounds++;
    if (rescan !== "none") {
      const ui = collectUi(cardId);
      const more = planPlaybook(ui, { scrollRounds: opScrollRounds, doneIds: opDoneIds });
      const queued = new Set(opSteps.map((s) => s.ui.id));
      more.forEach((s) => {
        if (!queued.has(s.ui.id)) { opSteps.push(s); queued.add(s.ui.id); }
      });
    }
  }, step.waitMs || OP_WAIT_FALLBACK);
}

// ===== P2 交易闭环状态机（信号 → 选中股票 → 打开交易卡 → 点买卖/仓位/下单 → 成交回报） =====
function startTrade(): void {
  if (tradeActive) return;
  const intent = tradeQueue.shift();
  if (!intent) return;
  if (intent.action === "watch" && !autoTrade.value) {
    tradeHandled.add(intent.key);
    addLog(`👁 未开启自动交易授权，信号【${intent.name}】仅观察，不下单`, "info");
    return;
  }
  tradeActive = true;
  tradeIntent = intent;
  tradeToken++;
  tradeTarget = null;
  tradePhase = "select-stock";
  addLog(
    `🧾 交易任务：${intent.side === "buy" ? "买入" : "卖出"} ${intent.name}（${intent.action === "executed" ? "后端已成交" : "前端下单"}）`,
    "info",
  );
}

function endTrade(): void {
  if (tradeIntent) tradeHandled.add(tradeIntent.key);
  tradeActive = false;
  tradeIntent = null;
  tradeTarget = null;
  tradePhase = "done";
  if (tradeWaitTimer) { clearTimeout(tradeWaitTimer); tradeWaitTimer = 0; }
}

let tradeArriveCounter = 0;
function setTradeTarget(ui: UiElement): void {
  tradeArriveId = `trade-op:${++tradeArriveCounter}`;
  tradeTarget = ui;
  crawlToUi(ui, tradeArriveId);
}
function scheduleTradeWait(fn: () => void, ms: number): void {
  if (tradeWaitTimer) clearTimeout(tradeWaitTimer);
  const token = tradeToken;
  tradeWaitTimer = window.setTimeout(() => {
    tradeWaitTimer = 0;
    if (token === tradeToken) fn();
  }, ms);
}
function nextTradePhase(): void {
  const order: TradePhase[] = ["select-stock", "open-trade", "set-side", "set-vol", "submit", "report", "done"];
  tradePhase = order[Math.min(order.indexOf(tradePhase) + 1, order.length - 1)]!;
  tradeTarget = null;
}
function failTrade(reason: string): void {
  if (tradeIntent) addLog(`⚠ 交易任务中止：${reason}`, "warn");
  endTrade();
}
function cardInDom(id: string): boolean {
  return !!document.querySelector(`.card-shell[data-card-id="${id}"]`);
}
function findRowAcrossVisible(code: string): UiElement | null {
  for (const c of collectCardRects()) {
    const hit = collectUi(c.cardId as CardId).find((u) => u.kind === "row" && u.code === code);
    if (hit) return hit;
  }
  return null;
}

// 每阶段决定目标 / 开卡；设置 tradeTarget 后由 frame 爬过去
function driveTrade(): void {
  const intent = tradeIntent;
  if (!intent || tradeTarget) return;

  switch (tradePhase) {
    case "select-stock": {
      const row = findRowAcrossVisible(intent.code);
      if (row) { setTradeTarget(row); return; }
      bench.open("watch"); // 信号股票通常在自选 → 打开自选卡再找
      scheduleTradeWait(() => {
        const r = findRowAcrossVisible(intent.code);
        if (r) setTradeTarget(r); else failTrade("找不到信号股票所在行");
      }, 650);
      return;
    }
    case "open-trade": {
      if (cardInDom("trade")) { nextTradePhase(); return; }
      bench.open("trade");
      scheduleTradeWait(() => {
        if (cardInDom("trade")) nextTradePhase(); else failTrade("打不开模拟交易卡");
      }, 700);
      return;
    }
    case "set-side": {
      const btn = collectUi("trade").find(
        (u) => u.kind === "tab" && u.el.closest(".seg") &&
          (intent.side === "buy" ? /买入/ : /卖出/).test(u.text) && !u.active,
      );
      if (btn) setTradeTarget(btn); else nextTradePhase();
      return;
    }
    case "set-vol": {
      const want = intent.side === "sell" ? "全仓" : "1/3";
      const btn = collectUi("trade").find(
        (u) => u.kind === "tab" && u.el.closest(".quick") && u.text.includes(want),
      );
      if (btn) setTradeTarget(btn); else nextTradePhase();
      return;
    }
    case "submit": {
      const go = collectUi("trade").find(
        (u) => u.el.classList.contains("go") || u.semantic === "confirm",
      );
      if (!go) { failTrade("找不到下单按钮"); return; }
      if (intent.action === "executed") {
        // 后端已成交：同步前端 + 只做按压视觉，不真点，避免重复下单
        void paperStore.reloadAll().then(() => {
          pressVisual(go.el);
          addLog(`✅ ${intent.name} 已在后端成交，前端持仓已同步`, intent.side === "buy" ? "buy" : "sell");
          scheduleTradeWait(() => nextTradePhase(), 500);
        });
        return;
      }
      setTradeTarget(go); // watch：爬到下单按钮，到达真实点击提交
      return;
    }
    case "report": {
      void paperStore.reloadAll().then(() => {
        const ui0 = collectUi("trade");
        const orderTab = ui0.find(
          (u) => u.kind === "tab" && u.el.closest(".ltab") && /委托|成交/.test(u.text) && !u.active,
        );
        if (orderTab) { pressVisual(orderTab.el); actionTap(orderTab.el); }
        scheduleTradeWait(() => {
          const rec = collectUi("trade").find((u) => u.kind === "row" && u.code === intent.code);
          const head = `${intent.side === "buy" ? "✅ 已买入" : "✅ 已卖出"} ${intent.name}`;
          const sub = [rec?.price ? `@${rec.price}` : "", rec?.text ?? ""].join(" ").trim();
          brokerToasts.push({
            x: sim.body.x, y: sim.body.y - 48, text: head, sub,
            color: intent.side === "buy" ? COLORS.buy : COLORS.sell,
            born: performance.now(), life: BROKER_TOAST_LIFE,
          });
          if (brokerToasts.length > 4) brokerToasts.shift();
          addLog(`📒 成交回报：${head}${sub ? " " + sub : ""}`, intent.side === "buy" ? "buy" : "sell");
          endTrade();
        }, 750);
      });
      return;
    }
  }
}

// 爬到当前阶段目标 → 真实点击 → 等待反馈 → 下一阶段
function onTradeArrived(): void {
  const target = tradeTarget;
  if (!target) return;
  pressVisual(target.el);
  actionTap(target.el);
  const wait = tradePhase === "submit" ? 950 : tradePhase === "select-stock" ? 350 : 600;
  scheduleTradeWait(() => { nextTradePhase(); }, wait);
}

// ===== 扫描事件入口：切卡 =====
function planCard(cardId: CardId) {
  const token = ++collectToken;
  lastCardId = cardId;
  cardEnterAt = performance.now();
  roundDone = false;
  clearAutoNext();
  if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = 0; }
  cancelAnimationFrame(collectRetry);
  if (cutRetryTimer) { clearTimeout(cutRetryTimer); cutRetryTimer = 0; }
  // 切走 → 作废旧卡的操作阶段（等待回调 / 剧本一并清空）
  opActive = false;
  opSteps = [];
  opPending = null;
  opCardId = null;
  opToken++;
  if (opWaitTimer) { clearTimeout(opWaitTimer); opWaitTimer = 0; }
  if (tradeActive) endTrade();
  tradeToken++;
  if (tradeWaitTimer) { clearTimeout(tradeWaitTimer); tradeWaitTimer = 0; }
  // 布局可能变化 → 路网排队重建；beginCut 内会确保路网含目标卡
  scheduleRebuildGraph();
  beginCut(cardId);
}

// ===== ACT3 ready 后：卡片内部逐行扫描（全 naturalWaypoints，同卡不飞行） =====
function scanRowsWithinCard(cardId: CardId) {
  const token = collectToken;
  let attempts = 0;

  const buildRowPath = (list: Anchor[]) => {
    const pts: ScanPoint[] = [];
    let prev: Vec2 = { ...sim.body };
    const seed = Date.now() + (cardId.charCodeAt(0) || 0);
    list.slice(0, 6).forEach((a: Anchor, i: number) => {
      const curve = naturalWaypoints(prev, a, { seed: seed + i, intensity: 0.35 });
      curve.forEach((v) => {
        pts.push({
          x: v.x, y: v.y,
          anchor: { ...a, x: v.x, y: v.y, width: 0, height: 0, id: `${a.id}:via${i}` },
          signal: null, via: true,
        });
      });
      pts.push({ x: a.x, y: a.y, anchor: a, signal: null });
      prev = { x: a.x, y: a.y };
    });
    if (pts.length) {
      sim.resetPath(pts);
      if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = 0; }
      roundDone = false;
    }
  };

  const attempt = () => {
    if (token !== collectToken) return;
    const list = anchors.collect(cardId);
    if (list.length > 0 && list.some((a) => a.kind === "row" || a.code)) {
      const rows = list.filter((a) => a.kind === "row" || a.code || a.name);
      if (rows.length > 0) {
        buildRowPath(rows);
        return;
      }
    }
    if (attempts++ < 40) {
      if (attempts < 15) {
        collectRetry = requestAnimationFrame(attempt);
      } else {
        collectRetry = window.setTimeout(
          () => { if (token === collectToken) requestAnimationFrame(attempt); },
          50,
        ) as unknown as number;
      }
      return;
    }
    // 重试耗尽：ACT3 已在标题总览扫过，直接推进下一轮
    scheduleAdvance();
  };
  attempt();
}

function onScan(ev: SpiderScanEvent) {
  if (ev.type === "card") {
    signalByCode = new Map();
    // 收到真实 card 事件 → 停止自动发现和自动推进，进入正常模式
    stopAutoDiscover();
    clearAutoNext();
    planCard(ev.cardId);
  } else {
    const { code, signal } = ev;
    signalByCode.set(code, signal);
    // 蜘蛛正停在该行驻留时，即时补上信号色
    if (signal && sim.current && !sim.current.via && sim.current.anchor.code === code) {
      sim.current.signal = signal;
    }
  }
}

// 滚动重采
function onScroll(ev: Event) {
  const target = ev.target as Element | null;
  if (!target?.closest?.("[data-card-id]")) return;
  if (scrollTimer) clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(() => {
    scrollTimer = 0;
    if (alive && sim.active && lastCardId !== null) planCard(lastCardId);
  }, 150);
}

function refreshFlyTarget() {
  const bridge = anchors.cardCenter("signalbridge");
  const fallback = anchors.elCenter(props.logEl);
  const target = bridge ?? fallback;
  if (target) sim.setFlyTarget({ x: target.x, y: target.y });
}

// ===== 绘制 =====
function draw(ctx: CanvasRenderingContext2D, now: number) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.scale(dpr, dpr);

  // 当前驻留行：高亮整行 + 光束（via 中途点不扫描、不高亮）
  const cur = sim.current;
  // 非 via（via 为 undefined/false 都算非 via）且有宽度 → 真实扫描点
  if (cur && !cur.via && cur.anchor.width > 0) {
    const color = signalColor(cur.signal);
    const a = cur.anchor;
    const isHeader = a.kind === "header" || a.kind === "card-center";
    const pulse = 0.6 + 0.4 * Math.sin(now / 90);
    // 扫描进度 0~1：
    // - 驻留中：用 sim.scanProgress（与驻留同步，0→1 完整扫完）
    // - 接近中（未到达）：根据距离计算预热进度（0~0.25），营造"正在靠近并准备扫描"的感觉
    const sp = sim.scanProgress;
    let scanProgress: number;
    if (sp > 0) {
      scanProgress = sp;
    } else {
      // 接近阶段：根据到目标的距离计算预热强度（越近越强，最多到 25%）
      const dx = sim.body.x - cur.x;
      const dy = sim.body.y - cur.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const approachDist = 120; // 进入此距离开始预热
      const approachT = Math.max(0, Math.min(1, 1 - dist / approachDist));
      scanProgress = approachT * 0.25; // 最多扫到 25%，营造蓄势感
    }

    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = reduced ? 0 : 18;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    // ═══ 通用：扫描光束横扫（行和标题栏都有）═══
    const topY = a.y - a.height / 2;
    const botY = a.y + a.height / 2;
    const leftX = a.x - 8;
    const rightX = a.x + a.width + 8;
    const totalW = rightX - leftX;

    // 1. 横向扫描光束（从左向右扫过整行）
    const beamX = leftX + scanProgress * totalW;
    const beamWidth = Math.max(60, totalW * 0.15);
    const beamGrad = ctx.createLinearGradient(beamX - beamWidth, 0, beamX + beamWidth, 0);
    beamGrad.addColorStop(0, "transparent");
    beamGrad.addColorStop(0.3, color + "18");
    beamGrad.addColorStop(0.5, color + "55");
    beamGrad.addColorStop(0.7, color + "18");
    beamGrad.addColorStop(1, "transparent");
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = beamGrad;
    ctx.fillRect(beamX - beamWidth, topY - 2, beamWidth * 2, a.height + 4);

    // 2. 扫描竖线（亮线）
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowBlur = reduced ? 0 : 25;
    ctx.beginPath();
    ctx.moveTo(beamX, topY - 6);
    ctx.lineTo(beamX, botY + 6);
    ctx.stroke();
    ctx.shadowBlur = reduced ? 0 : 18;

    // 3. 行框脉冲（四角高亮 + 完整边框）
    ctx.globalAlpha = pulse * 0.85;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.strokeRect(leftX, topY, a.width + 16, a.height);

    // 四角装饰（科技感直角）
    const cornerLen = Math.min(16, a.height * 0.8);
    ctx.globalAlpha = pulse;
    ctx.lineWidth = 2;
    ctx.beginPath();
    // 左上
    ctx.moveTo(leftX, topY + cornerLen);
    ctx.lineTo(leftX, topY);
    ctx.lineTo(leftX + cornerLen, topY);
    // 右上
    ctx.moveTo(rightX - cornerLen, topY);
    ctx.lineTo(rightX, topY);
    ctx.lineTo(rightX, topY + cornerLen);
    // 左下
    ctx.moveTo(leftX, botY - cornerLen);
    ctx.lineTo(leftX, botY);
    ctx.lineTo(leftX + cornerLen, botY);
    // 右下
    ctx.moveTo(rightX - cornerLen, botY);
    ctx.lineTo(rightX, botY);
    ctx.lineTo(rightX, botY - cornerLen);
    ctx.stroke();

    // 4. 行内已扫描区域的渐变填充（左侧亮，右侧暗）
    const scannedW = scanProgress * totalW;
    if (scannedW > 2) {
      const fillGrad = ctx.createLinearGradient(leftX, 0, leftX + scannedW, 0);
      fillGrad.addColorStop(0, color + "2a");
      fillGrad.addColorStop(0.7, color + "14");
      fillGrad.addColorStop(1, color + "05");
      ctx.globalAlpha = 0.65;
      ctx.fillStyle = fillGrad;
      ctx.fillRect(leftX, topY, scannedW, a.height);
    }

    // 5. 标题栏专属：顶部高亮条 + 底部波纹
    if (isHeader && a.width > 120) {
      // 顶部高亮条（呼吸）
      ctx.globalAlpha = 0.8 + 0.2 * Math.sin(now / 130);
      ctx.fillStyle = color;
      ctx.fillRect(leftX, topY - 3, totalW, 3);

      // 底部波纹扩散（2~3 圈）
      if (!reduced) {
        for (let i = 0; i < 3; i++) {
          const ringT = ((now / 1000) + i * 0.33) % 1;
          const ringY = botY + ringT * 28;
          const ringAlpha = (1 - ringT) * 0.45;
          ctx.globalAlpha = ringAlpha;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.ellipse(a.x + a.width / 2, ringY, a.width / 2 * (0.8 + ringT * 0.3), 5 * (1 + ringT), 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // 6. 蜘蛛头到扫描线的锥形光束 + 粒子
    const head = { x: sim.body.x, y: sim.body.y - 26 };
    const cx = beamX;  // 光束跟随扫描线
    const cy = a.y;
    ctx.globalAlpha = pulse * 0.75;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(head.x, head.y - 3);
    ctx.lineTo(cx, cy - 6);
    ctx.lineTo(cx, cy + 6);
    ctx.lineTo(head.x, head.y + 3);
    ctx.stroke();

    // 沿线脉冲小方块（3 个错落，对应视频效果）
    if (!reduced) {
      for (let i = 0; i < 3; i++) {
        const tt = ((now / 700) + i * 0.35) % 1;
        const px = head.x + (cx - head.x) * tt;
        const py = head.y + (cy - head.y) * tt;
        ctx.globalAlpha = (1 - tt) * 0.95;
        ctx.fillStyle = color;
        const size = 3 + (1 - tt) * 3.5;
        // 旋转 45 度的菱形方块（更有"脉冲数据块"的感觉）
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-size / 2, -size / 2, size, size);
        ctx.restore();
      }
    }

    // 7. 扫描线两端的端点亮点
    ctx.globalAlpha = pulse;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(beamX, topY, 3.5, 0, Math.PI * 2);
    ctx.arc(beamX, botY, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // 8. 数据粒子：从光束位置被"吸出来"流向蜘蛛头
    if (!reduced && sp > 0.05) {
      // 每帧生成 2-4 个粒子
      const emitCount = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < emitCount && scanParticles.length < MAX_SCAN_PARTICLES; i++) {
        const px = beamX + (Math.random() - 0.5) * 20;
        const py = a.y + (Math.random() - 0.5) * a.height * 0.7;
        const dx = head.x - px;
        const dy = head.y - py;
        const dist = Math.hypot(dx, dy) || 1;
        const speed = 80 + Math.random() * 60;
        scanParticles.push({
          x: px, y: py,
          vx: (dx / dist) * speed,
          vy: (dy / dist) * speed,
          life: 0,
          maxLife: 600 + Math.random() * 400,
          size: 1 + Math.random() * 2,
          color,
        });
      }
    }

    ctx.restore();
  }

  // ===== 数据粒子更新与绘制 =====
  if (!reduced && scanParticles.length > 0) {
    const dt = Math.min(50, now - last);
    ctx.save();
    for (let i = scanParticles.length - 1; i >= 0; i--) {
      const p = scanParticles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        scanParticles.splice(i, 1);
        continue;
      }
      p.x += p.vx * (dt / 1000);
      p.y += p.vy * (dt / 1000);
      // 越靠近蜘蛛，粒子越淡越小
      const t = p.life / p.maxLife;
      const alpha = (1 - t) * 0.8;
      const size = p.size * (1 - t * 0.5);
      ctx.globalAlpha = alpha;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 6;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // 腿
  ctx.lineCap = "round";
  for (const l of sim.legsForRender()) {
    ctx.strokeStyle = COLORS.leg;
    ctx.lineWidth = l.lifting ? 2.6 : 1.6;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(l.hip.x, l.hip.y);
    ctx.lineTo(l.knee.x, l.knee.y);
    ctx.lineTo(l.foot.x, l.foot.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS.joint;
    ctx.beginPath();
    ctx.arc(l.foot.x, l.foot.y, l.lifting ? 3 : 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // 身体：呼吸起伏 + 多节轮廓 + 头眼 + 须肢
  const bob = reduced ? 0 : Math.sin(now / 160) * 2.5;
  const bx = sim.body.x;
  const by = sim.body.y + bob;
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(sim.angle);
  ctx.lineJoin = "round";

  // 一体轮廓
  ctx.save();
  if (!reduced) { ctx.shadowColor = COLORS.leg; ctx.shadowBlur = 14; }
  ctx.fillStyle = "rgba(10,40,54,0.95)";
  ctx.strokeStyle = COLORS.leg;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -22);
  ctx.bezierCurveTo(8, -22, 13, -16, 13, -8);
  ctx.bezierCurveTo(13, -2, 9, 3, 6, 5);
  ctx.bezierCurveTo(11, 7, 16, 12, 16, 20);
  ctx.bezierCurveTo(16, 30, 8, 35, 0, 36);
  ctx.bezierCurveTo(-8, 35, -16, 30, -16, 20);
  ctx.bezierCurveTo(-16, 12, -11, 7, -6, 5);
  ctx.bezierCurveTo(-9, 3, -13, -2, -13, -8);
  ctx.bezierCurveTo(-13, -16, -8, -22, 0, -22);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // 腹节纹 3 条 + 中轴暗纹
  ctx.save();
  ctx.strokeStyle = "rgba(55,230,240,0.3)";
  ctx.lineWidth = 1;
  for (const yy of [12, 20, 27]) {
    ctx.beginPath();
    ctx.ellipse(0, yy, 10, 4, 0, 0, Math.PI);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.moveTo(0, 7);
  ctx.lineTo(0, 34);
  ctx.stroke();
  ctx.restore();

  // 尾端纺器
  ctx.strokeStyle = COLORS.leg;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-2, 36); ctx.lineTo(-2, 39);
  ctx.moveTo(2, 36); ctx.lineTo(2, 39);
  ctx.stroke();

  // 头眼（4：2 大 2 小）
  ctx.fillStyle = COLORS.leg;
  if (!reduced) { ctx.shadowColor = COLORS.leg; ctx.shadowBlur = 8; }
  for (const [ex, ey, er] of [
    [-4, -18, 1.8], [4, -18, 1.8], [-7, -14, 1.2], [7, -14, 1.2],
  ] as const) {
    ctx.beginPath();
    ctx.arc(ex, ey, er, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  // 须肢
  ctx.strokeStyle = COLORS.leg;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(-4, -20); ctx.lineTo(-7, -26); ctx.lineTo(-5, -31);
  ctx.moveTo(4, -20); ctx.lineTo(7, -26); ctx.lineTo(5, -31);
  ctx.stroke();

  ctx.restore();

  // 数据包
  for (const p of sim.packets) {
    const color = p.side === "BUY" ? COLORS.buy : COLORS.sell;

    // 拖尾线（trailing 和 flying 状态都画）
    if (p.trail && p.trail.length > 1) {
      for (let i = 0; i < p.trail.length - 1; i++) {
        const alpha = (1 - i / p.trail.length) * 0.6;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(0.5, 2 - i * 0.15);
        ctx.beginPath();
        ctx.moveTo(p.trail[i].x, p.trail[i].y);
        ctx.lineTo(p.trail[i + 1].x, p.trail[i + 1].y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // 粉色牵引线（trailing 状态连接蜘蛛身体，抽出阶段连接行位置）
    if (p.state === "trailing" || p.state === "extracting") {
      const lineStart = p.state === "trailing"
        ? { x: sim.body.x, y: sim.body.y + 8 }
        : p.extractFrom;
      // 外发光
      if (!reduced) {
        ctx.shadowColor = COLORS.string;
        ctx.shadowBlur = 8;
      }
      ctx.strokeStyle = COLORS.string;
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(lineStart.x, lineStart.y);
      ctx.lineTo(p.pos.x, p.pos.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }

    // 数据包磁贴（extracting/trailing/flying 状态都显示）
    if (p.state === "extracting" || p.state === "trailing" || p.state === "flying") {
      const nameText = p.name || p.code;
      const priceText = p.price > 0 ? `${p.price.toFixed(2)}` : "";
      const pctText = p.pct !== undefined ? `${p.pct >= 0 ? "+" : ""}${p.pct.toFixed(1)}%` : "";
      const label = nameText + "  " + priceText + "  " + pctText;
      ctx.font = "bold 10px Consolas, monospace";
      const tw = Math.max(78, ctx.measureText(label).width + 18);
      const th = 24;

      // 抽出动画：scale 从 0.3 弹到 1
      let scale = 1;
      if (p.state === "extracting") {
        const t = p.t;
        // 弹性回弹：0 → 1.1 → 1
        scale = t < 0.6
          ? t / 0.6 * 1.1
          : 1.1 - (t - 0.6) / 0.4 * 0.1;
        scale = Math.max(0.2, scale);
      }

      // 飞行状态下前 15% 和后 15% 渐隐
      let bodyAlpha = 1;
      if (p.state === "flying") {
        if (p.t < 0.15) bodyAlpha = p.t / 0.15;
        else if (p.t > 0.85) bodyAlpha = (1 - p.t) / 0.15;
      }
      if (p.state === "extracting") {
        bodyAlpha = 0.3 + 0.7 * p.t; // 抽出时渐显
      }

      ctx.save();
      ctx.translate(p.pos.x, p.pos.y);
      ctx.scale(scale, scale);
      ctx.globalAlpha = bodyAlpha;
      ctx.shadowColor = color;
      ctx.shadowBlur = reduced ? 0 : 16;

      // 磁贴背景
      ctx.fillStyle = "rgba(18,6,16,0.96)";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      roundRect(ctx, -tw / 2, -th / 2, tw, th, 4);
      ctx.fill();
      ctx.stroke();

      // 左侧色条（磁贴感）
      ctx.shadowBlur = 0;
      ctx.fillStyle = color;
      ctx.globalAlpha = bodyAlpha * 0.9;
      ctx.fillRect(-tw / 2 + 1, -th / 2 + 1, 3.5, th - 2);

      // BUY/SELL 小箭头图标
      ctx.globalAlpha = bodyAlpha;
      ctx.fillStyle = color;
      ctx.font = "bold 9px Consolas, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const arrow = p.side === "BUY" ? "▲" : "▼";
      ctx.fillText(arrow, -tw / 2 + 7, -3);

      // 股票名称（上排，粗体）
      ctx.fillStyle = "#e8f4f2";
      ctx.font = "bold 10px Consolas, 'PingFang SC', sans-serif";
      ctx.textAlign = "center";
      const displayName = nameText.length > 5 ? nameText.slice(0, 5) + ".." : nameText;
      ctx.fillText(displayName, 4, -3);

      // 价格 + 涨跌幅（下排）
      ctx.fillStyle = color;
      ctx.font = "9px Consolas, monospace";
      const pricePct = priceText + " " + pctText;
      ctx.fillText(pricePct, 4, 6);

      ctx.restore();
    }

    // 消散粒子
    if (p.state === "dissolving" && p.particles) {
      for (const pt of p.particles) {
        if (pt.life >= pt.maxLife) continue;
        const alpha = 1 - pt.life / pt.maxLife;
        ctx.globalAlpha = alpha * 0.8;
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = reduced ? 0 : 6;
        ctx.beginPath();
        ctx.arc(pt.pos.x, pt.pos.y, pt.size * alpha, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }
  }

  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 绘制后端成交/信号气泡：跟随蜘蛛头顶，淡入淡出、纵向堆叠 */
// ===== 蜘蛛头顶状态气泡：实时显示它正在干什么（切卡 / 扫描标题 / 扫描个股 / 买卖下单）=====
type BubbleKind = "buy" | "sell" | "scan" | "move";
function cardTitleOf(id: CardId | null): string {
  return id ? (CARD_META[id]?.title ?? id) : "";
}
function currentStatus(): { text: string; kind: BubbleKind } {
  if (cutActive && cutTarget) return { text: `前往【${cardTitleOf(cutTarget)}】…`, kind: "move" };
  // 操作阶段：点击 / 切标签 / 查看板块个股 / 滚动加载（像人一样操作卡片）
  if (opActive && opPending) return { text: opPending.label, kind: "move" };
  const cur = sim.current;
  if (cur && !cur.via) {
    const a = cur.anchor;
    const isHeader = a.kind === "header" || a.kind === "card-center";
    if (cur.signal === "BUY") return { text: "买入信号 · 下单中", kind: "buy" };
    if (cur.signal === "SELL") return { text: "卖出信号 · 平仓中", kind: "sell" };
    if (isHeader) return { text: `扫描【${cardTitleOf(lastCardId)}】标题`, kind: "scan" };
    if (a.name) return { text: `扫描 · ${a.name}`, kind: "scan" };
  }
  return lastCardId ? { text: `巡视【${cardTitleOf(lastCardId)}】`, kind: "scan" }
    : { text: "巡视中…", kind: "scan" };
}

function roundRectPath(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawStatusBubble(ctx: CanvasRenderingContext2D, now: number): void {
  if (!sim || !sim.active) return;
  const st = currentStatus();
  const color =
    st.kind === "buy" ? COLORS.buy
    : st.kind === "sell" ? COLORS.sell
    : st.kind === "move" ? "#ffb13d"
    : COLORS.scan;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 明确 dpr 变换，不受上一帧状态影响
  ctx.font = "12px 'Segoe UI', 'Microsoft YaHei', sans-serif";
  const padX = 10, h = 24;
  const w = ctx.measureText(st.text).width + padX * 2;

  // 锚点：蜘蛛身体正上方；边界钳制 + 轻微浮动
  const cx = sim.body.x;
  let bx = cx - w / 2;
  let by = sim.body.y - 54 + Math.sin(now / 300) * 2;
  bx = Math.max(8, Math.min(window.innerWidth - w - 8, bx));
  by = Math.max(8, by);

  // 气泡底 + 描边
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = "rgba(8,14,28,0.85)";
  roundRectPath(ctx, bx, by, w, h, 8);
  ctx.fill();
  ctx.shadowColor = color;
  ctx.shadowBlur = reduced ? 0 : 10;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  roundRectPath(ctx, bx, by, w, h, 8);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 指向蜘蛛的小三角
  const tipX = Math.max(bx + 8, Math.min(bx + w - 8, cx));
  ctx.fillStyle = "rgba(8,14,28,0.85)";
  ctx.beginPath();
  ctx.moveTo(tipX - 5, by + h);
  ctx.lineTo(tipX + 5, by + h);
  ctx.lineTo(tipX, by + h + 6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(tipX - 5, by + h);
  ctx.lineTo(tipX, by + h + 6);
  ctx.lineTo(tipX + 5, by + h);
  ctx.stroke();

  // 文字
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(st.text, bx + padX, by + h / 2 + 0.5);
  ctx.restore();
}

function drawBrokerToasts(ctx: CanvasRenderingContext2D, now: number) {
  for (let i = brokerToasts.length - 1; i >= 0; i--) {
    const t = brokerToasts[i];
    const age = now - t.born;
    if (age > t.life) { brokerToasts.splice(i, 1); continue; }
    const p = age / t.life;
    let alpha = 1;
    if (p < 0.12) alpha = p / 0.12;
    else if (p > 0.8) alpha = (1 - p) / 0.2;

    // 位置平滑跟随蜘蛛身体
    t.x += (sim.body.x - t.x) * 0.2;
    t.y += (sim.body.y - 50 - t.y) * 0.2;
    const stackY = t.y - (brokerToasts.length - 1 - i) * 34;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = "bold 11px Consolas, 'PingFang SC', sans-serif";
    const tw = Math.max(ctx.measureText(t.text).width, ctx.measureText(t.sub).width) + 22;
    const th = 29;
    const x = t.x - tw / 2;
    const y = stackY - th / 2;
    ctx.fillStyle = "rgba(10,14,20,0.9)";
    ctx.strokeStyle = t.color;
    ctx.lineWidth = 1.3;
    ctx.shadowColor = t.color;
    ctx.shadowBlur = reduced ? 0 : 12;
    roundRect(ctx, x, y, tw, th, 6);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, x + 9, y + 9);
    ctx.fillStyle = "rgba(232,240,244,0.92)";
    ctx.font = "10px Consolas, 'PingFang SC', sans-serif";
    ctx.fillText(t.sub, x + 9, y + 20);
    ctx.restore();
  }
}

/** 卡片级硬超时：单卡最长停留，到时强制切卡（不被原地 heartbeat 刷新）。 */
const MAX_CARD_DWELL_MS = 22000;

/** 一轮收尾：路径走完且数据包飞完 600ms 后推进下一轮 */
function scheduleAdvance() {
  if (roundDone) return;
  roundDone = true;
  if (advanceTimer) clearTimeout(advanceTimer);
  // 停留节奏：保证在卡上至少停留注册表建议的 dwellMs（看完再走），不足则补，够了则 600ms 缓冲
  const dwell = getCapability(lastCardId)?.dwellMs ?? 3000;
  const remain = Math.max(600, dwell - (performance.now() - cardEnterAt));
  advanceTimer = window.setTimeout(() => {
    advanceTimer = 0;
    if (alive && roundDone) advanceRound();
  }, remain);
}

function frame(now: number) {
  const ctx = ctx2d;
  if (!ctx) return;
  if (!last) last = now;
  const dt = Math.min(50, now - last);
  last = now;
  // 卡片级硬超时：无论蜘蛛是否在原地活动 / heartbeat，每卡最多停留 MAX_CARD_DWELL_MS，
  // 到时复位阶段并强制切卡（解决"只停自选不切卡"——普通看门狗会被 heartbeat 刷新）。
  if (lastCardId && now - cardEnterAt > MAX_CARD_DWELL_MS) {
    addLog(
      `⏱ 在【${cardTitleOf(lastCardId)}】停留超过 ${Math.round(MAX_CARD_DWELL_MS / 1000)}s，强制切卡`,
      "warn",
    );
    cardEnterAt = now;
    roundDone = false;
    opActive = false;
    opSteps = [];
    opPending = null;
    if (tradeActive) endTrade();
    cutActive = false;
    cutPlan = null;
    advanceRound();
  }
  const ev = sim.update(dt, now);

  // 到达帧：操作点 → 执行动作；路过标题 → 标题轻亮；解析信号
  if (ev.arrived && !ev.arrived.via) {
    if (tradeActive && ev.arrived.anchor.id === tradeArriveId) {
      onTradeArrived();
    } else if (opActive && opPending && ev.arrived.anchor.id === opPending.arriveId) {
      executeOp(opPending);
    } else {
      const passed = cutPlan?.glideAt.get(ev.arrived.anchor.id);
      if (passed) pulsePassedCard(passed);
      const sig = resolveSignal(signalByCode, ev.arrived.anchor.code, ev.arrived.signal);
      ev.arrived.signal = sig;
      if (sig) sim.spawnPacket(ev.arrived);
    }
  }

  if (cutActive) {
    // ═══ 三幕切卡：当前幕路径走完（无数据包）→ 推进下一幕 ═══
    if (!sim.active && sim.packets.length === 0) {
      cutActIdx++;
      runNextAct();
    }
  } else {
    // ═══ 非切卡 ═══
    if (opActive) {
      // P2 主动操作阶段：爬向下一个操作元素；剧本走完则推进下一张卡
      if (!sim.active && sim.packets.length === 0 && !opPending) {
        const next = opSteps.find((s) => !opDoneIds.has(s.ui.id));
        if (next) {
          opPending = next;
          crawlToOp(next);
        } else {
          opActive = false;
          opCardId = null;
          scheduleAdvance();
        }
      }
    } else if (tradeActive) {
      // P2 交易闭环：推进当前交易阶段
      if (!sim.active && sim.packets.length === 0 && !tradeTarget) driveTrade();
    } else if (!sim.active && sim.packets.length === 0) {
      // ═══ 路径走完后的调度 ═══
      const hasCards = collectCardRects().length > 0;
      if (hasCards) {
        // 有交易信号 → 优先交易（不切卡）；否则推进引擎 + 自动轮转兜底，不漫游
        if (tradeQueue.length > 0) startTrade();
        if (!tradeActive) {
          if (lastCardId !== null) scheduleAdvance();
          triggerAutoNext();
        }
        if (idleRoamTimer) { clearTimeout(idleRoamTimer); idleRoamTimer = 0; }
      } else if (!idleRoamTimer) {
        // 页面无卡：空转漫游等卡片出现（启动阶段贴边 / 短暂等待）
        idleRoamTimer = window.setTimeout(() => {
          idleRoamTimer = 0;
          if (!alive || sim.active) return;
          const cardAnchor = lastCardId ? anchors.cardCenter(lastCardId) : null;
          const cardIdForAnchor = lastCardId ?? "warmup";
          const pts: ScanPoint[] = [];
          if (cardAnchor) {
            // 有目标卡片 → 在卡片附近椭圆游荡
            const wander = localWanderPath(sim.body, cardAnchor,
              { radiusX: 55, radiusY: 38, loops: 1.2, points: 10 });
            wander.forEach((v, j) => {
              pts.push({
                x: v.x, y: v.y,
                anchor: { ...cardAnchor, x: v.x, y: v.y, width: 0, height: 0, id: `idle:${cardIdForAnchor}:${j}` },
                signal: null, via: true,
              });
            });
          } else {
            // 没有目标（启动阶段）→ 贴边短漫游
            const roam = roamPath(sim.body, { w: window.innerWidth, h: window.innerHeight },
              { distance: Math.min(1000, window.innerWidth + window.innerHeight) * 0.5 });
            roam.forEach((v, j) => {
              pts.push({
                x: v.x, y: v.y,
                anchor: { id: `warmup:${j}`, cardId: cardIdForAnchor, x: v.x, y: v.y, width: 0, height: 0 },
                signal: null, via: true,
              });
            });
          }
          if (pts.length) {
            sim.resetPath(pts);
            roundDone = false;
          }
        }, lastCardId === null ? 300 : IDLE_ROAM_MS);
      }
    } else {
      // 有真实路径 / 数据包在走 → 清掉自动切卡与漫游
      clearAutoNext();
      if (idleRoamTimer) { clearTimeout(idleRoamTimer); idleRoamTimer = 0; }
    }
  }

  // 活动心跳（5s 重置看门狗）
  if (now - lastHeartbeat > 5000) { lastHeartbeat = now; heartbeat(); }

  draw(ctx, now);
  drawBrokerToasts(ctx, now);
  drawStatusBubble(ctx, now);

  // rAF 永不停止（蜘蛛绘制量极小，永久运行开销可忽略）
  if (alive) {
    raf = requestAnimationFrame(frame);
  } else {
    raf = 0;
  }
}

function resize() {
  const c = canvasRef.value;
  if (!c) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = window.innerWidth * dpr;
  c.height = window.innerHeight * dpr;
  c.style.width = `${window.innerWidth}px`;
  c.style.height = `${window.innerHeight}px`;
  // 视口变化 → 路网坐标重建
  scheduleRebuildGraph();
}

onMounted(() => {
  alive = true;
  sim = new SpiderSim(
    { x: window.innerWidth / 2, y: 80 },
    { reducedMotion: reduced },
  );
  resize();
  ctx2d = canvasRef.value?.getContext("2d") ?? null;
  refreshFlyTarget();
  flyTimer = window.setInterval(refreshFlyTarget, 250);
  window.addEventListener("resize", resize);
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  unlisten = onSpiderScan(onScan);
  // 订阅后端快脑成交/信号事件（P0：日志 + 头顶气泡；P3 再做完整交易表演）
  void listen("fastbrain-signal", (e) => onBrokerSignal(e.payload)).then((u) => {
    unlistenSignal = u;
  });
  // 挂载即漫游一小段（0.3 屏周长），消除首个 card 事件前的空窗期
  const roam = roamPath(sim.body, { w: window.innerWidth, h: window.innerHeight },
    { distance: Math.min(500, window.innerWidth + window.innerHeight) * 0.3, spacing: 150 });
  if (roam.length) {
    sim.resetPath(roam.map((v, j) => ({
      x: v.x, y: v.y,
      anchor: { id: "roam:init:" + j, cardId: "roam", x: v.x, y: v.y, width: 0, height: 0 },
      signal: null, via: true,
    })));
  }
  // 初始构建卡片骨架路网（beginCut 内也会兜底）
  rebuildGraph();
  raf = requestAnimationFrame(frame);
  // 启动自动发现：1.5s 没收到 card 事件就自己找卡片爬
  startAutoDiscover();
});

onBeforeUnmount(() => {
  alive = false;
  collectToken++;
  cancelAnimationFrame(raf);
  cancelAnimationFrame(collectRetry);
  clearInterval(flyTimer);
  stopAutoDiscover();
  clearAutoNext();
  if (advanceTimer) clearTimeout(advanceTimer);
  if (scrollTimer) clearTimeout(scrollTimer);
  if (idleRoamTimer) clearTimeout(idleRoamTimer);
  if (cutRetryTimer) clearTimeout(cutRetryTimer);
  if (opWaitTimer) clearTimeout(opWaitTimer);
  opToken++;
  if (tradeWaitTimer) clearTimeout(tradeWaitTimer);
  tradeToken++;
  tradeQueue.length = 0;
  cancelAnimationFrame(graphRaf);
  clearCardFocus();
  window.removeEventListener("resize", resize);
  window.removeEventListener("scroll", onScroll, true);
  unlisten?.();
  unlistenSignal?.();
});
</script>

<template>
  <canvas ref="canvasRef" class="spider-canvas" aria-hidden="true" />
</template>

<style scoped>
.spider-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
}
</style>

<!-- 全局：蜘蛛主动操作 UI 元素时的按压视觉（命中卡片内任意 button/tab/行/tr） -->
<style>
.spider-press {
  animation: spider-press-ring 0.42s ease-out;
  border-radius: 6px;
}
@keyframes spider-press-ring {
  0% {
    outline: 2px solid rgba(0, 255, 213, 0.9);
    outline-offset: -1px;
    filter: brightness(1.35);
  }
  100% {
    outline: 2px solid rgba(0, 255, 213, 0);
    outline-offset: 8px;
    filter: brightness(1);
  }
}
</style>
