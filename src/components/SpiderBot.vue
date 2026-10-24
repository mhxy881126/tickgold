<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, onUnmounted, watch, nextTick } from "vue";
import { useWatchlistStore } from "../stores/watchlist";
import { useQuotesStore } from "../stores/quotes";
import { useSpiderBotEngine } from "../composables/useSpiderBotEngine";
import { autoexecGetConfig, autoexecStart, autoexecStop } from "../ai/api";
import { startSelectorCheck, type SelectorIssue } from "./spider/selectorCheck";
import { getTradingPhase, phaseLabel, phaseAction, type TradingPhase } from "./spider/tradingDay";

const emit = defineEmits<{
  switchCard: [cardId: string];
}>();

const engine = useSpiderBotEngine();
const wl = useWatchlistStore();
const quotes = useQuotesStore();

// ===== 运行状态 =====
const running = computed(() => engine.running.value);
const autoTrade = computed(() => engine.autoTrade.value);
const semiAuto = computed(() => engine.semiAuto.value);

// P0: 今日精选标的（从引擎取）
const todayPicks = computed(() => engine.todayPicks.value);

// P0: 持仓监控（从引擎取）
const positions = computed(() => engine.positionInfos.value);

// P1: 盘前准备数据
const themeHotList = computed(() => engine.themeHotList.value);
const dragonPoolList = computed(() => engine.dragonPoolList.value);
const auctionList = computed(() => engine.auctionList.value);

// 题材热度阶段中文
const stageText = (stage: string) => ({
  climax: "高潮",
  ferment: "发酵",
  sprout: "萌芽",
  ebb: "退潮",
}[stage] || stage);

// ===== 时段状态机 =====
const currentPhase = computed(() => getTradingPhase());
const PHASES = [
  { phase: "pre-market", time: "08:30–09:15", label: "盘前", action: "读消息/日历，预扫描自选与题材", open: "否" },
  { phase: "auction", time: "09:15–09:25", label: "集合竞价", action: "竞价抢筹判定，定挂单计划", open: "否" },
  { phase: "open", time: "09:25–09:35", label: "开盘", action: "观察方向，不追高", open: "否" },
  { phase: "morning", time: "09:35–11:30", label: "上午盘", action: "环境→主线→个股巡回，研判+交易", open: "是" },
  { phase: "midday", time: "11:30–13:00", label: "午间", action: "复盘上午，更新候选与仓位", open: "否" },
  { phase: "afternoon", time: "13:00–14:45", label: "下午盘", action: "持仓跟踪+交易", open: "是" },
  { phase: "close", time: "14:45–15:00", label: "尾盘", action: "尾盘决策：新开/减仓/持有", open: "否" },
  { phase: "post-market", time: "15:00–16:00", label: "盘后", action: "自动复盘+研究卡扫描", open: "模拟盘" },
] as const;

// ===== 时间轴选中（默认跟随真实当前时段）=====
const selectedPhase = ref<TradingPhase>(currentPhase.value);
watch(currentPhase, (p) => { selectedPhase.value = p; });

const PHASE_ORDER: TradingPhase[] = ["pre-market", "auction", "open", "morning", "midday", "afternoon", "close", "post-market"];
function nodeState(phase: TradingPhase): string {
  const cur = currentPhase.value;
  if (phase === cur) return "active";
  if (cur === "closed") return "done";
  return PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf(cur) ? "done" : "";
}
const selectedDetail = computed(() => {
  const p = selectedPhase.value;
  if (p === "closed") return { label: "休市", time: "其余/周末", action: "研究卡扫描 + 复盘记录", open: "模拟盘" };
  const row = PHASES.find((x) => x.phase === p);
  return { label: row!.label, time: row!.time, action: row!.action, open: row!.open };
});

// ===== 工作区 Tab（复盘 / 日志）=====
const activeWorkTab = ref<"review" | "logs">("review");

// ===== 主Tab：AI交易助理5大模块 =====
type MainTabKey = "plan" | "premarket" | "intraday" | "review" | "settings";
const activeMainTab = ref<MainTabKey>("plan");
const mainTabs = computed(() => [
  { key: "plan" as const, icon: "📋", label: "今日作战计划", badge: "" },
  { key: "premarket" as const, icon: "📊", label: "盘前准备", badge: "" },
  { key: "intraday" as const, icon: "🎯", label: "盘中监控", badge: "" },
  { key: "review" as const, icon: "📈", label: "盘后复盘", badge: "" },
  { key: "settings" as const, icon: "⚙️", label: "设置", badge: "" },
]);

// ===== 自动交易配置 =====
const aiCfg = ref<any>(null);
const aiBusy = ref(false);
async function loadAiCfg() {
  try { aiCfg.value = await autoexecGetConfig(); } catch (e) { console.warn("加载自动交易配置失败:", e); }
}

// ===== 全屏爬行 =====
const fullscreenRunning = ref(false);
function toggleFullscreen() {
  if (fullscreenRunning.value) {
    window.dispatchEvent(new CustomEvent("spider-overlay-stop"));
    fullscreenRunning.value = false;
  } else {
    window.dispatchEvent(new CustomEvent("spider-overlay-start"));
    fullscreenRunning.value = true;
  }
}
function onFullscreenStopped() { fullscreenRunning.value = false; }
function onFullscreenStarted() { fullscreenRunning.value = true; }

// ===== 选择器自检角标 =====
const selectorIssues = ref<SelectorIssue[]>([]);
let stopSelectorCheck: (() => void) | null = null;
const selectorIssueCount = computed(() => selectorIssues.value.length);

// ===== 模式切换 =====
async function setSemi(on: boolean) {
  if (!aiCfg.value) await loadAiCfg();
  if (on) { engine.setAutoTrade(false); engine.setSemiAuto(true); }
  else { engine.setSemiAuto(false); }
  syncBackendMode();
}
async function setFull(on: boolean) {
  if (!aiCfg.value) await loadAiCfg();
  if (on) { engine.setSemiAuto(false); engine.setAutoTrade(true); }
  else { engine.setAutoTrade(false); }
  syncBackendMode();
}
async function syncBackendMode() {
  try {
    if (!aiCfg.value) return;
    if (running.value) {
      const patch = autoTrade.value
        ? { tradeMode: "full" as const, fullAutoMode: true, bridgeEnabled: false }
        : { tradeMode: "manual" as const, fullAutoMode: false, bridgeEnabled: true };
      await autoexecStart({ ...aiCfg.value, enabled: true, ...patch });
    }
  } catch (e) { console.warn("同步模式到后端失败:", e); }
}

// ===== 启动/停止 =====
async function start() {
  if (!aiCfg.value) await loadAiCfg();
  aiBusy.value = true;
  try {
    // P3: 通过事件通知全局覆盖层启动，和快捷键一样，不要直接调用 engine.start()
    window.dispatchEvent(new CustomEvent("spider-overlay-start"));
    startMockScanLoop();
  } finally { aiBusy.value = false; }
}
async function stop() {
  aiBusy.value = true;
  try {
    // P3: 通过事件通知全局覆盖层停止
    window.dispatchEvent(new CustomEvent("spider-overlay-stop"));
    stopMockScanLoop();
  } finally { aiBusy.value = false; }
}
function emergencyStop() {
  stop();
  window.dispatchEvent(new CustomEvent("spider-overlay-stop"));
  fullscreenRunning.value = false;
}

// ===== Mock 扫描循环 =====
let mockTimer: number | null = null;
let mockStep = 0;
const scanCards = [
  { id: "watch", name: "自选股", icon: "📋" },
  { id: "rank", name: "涨幅榜", icon: "📈" },
  { id: "sector", name: "板块", icon: "🏭" },
  { id: "radar", name: "涨停雷达", icon: "🚀" },
];
function startMockScanLoop() {
  mockStep = 0;
  tickMock();
  // P3: 延长间隔，让动画持续运行，不要 2-3 秒就停
  mockTimer = window.setInterval(tickMock, 5000);
}
function stopMockScanLoop() { if (mockTimer) { clearInterval(mockTimer); mockTimer = null; } }
function tickMock() {
  const card = scanCards[mockStep % scanCards.length];
  currentCard.value = card.id;
  mockStep++;
  scanStep.value = mockStep;
}
const currentCard = ref("watch");
const scanStep = ref(0);
const positionCount = ref(0);
const currentCardName = computed(() => scanCards[scanStep.value % scanCards.length]?.name || "自选股");

// ===== 策略菜单 =====
const showStrategyMenu = ref(false);
function selectStrategy(key: "conservative" | "balanced" | "aggressive" | "scalping") {
  engine.applyStrategy(key);
  showStrategyMenu.value = false;
}

// ===== 绩效 =====
const perfData = computed(() => {
  const perf = engine.performance.value;
  return {
    totalReturnPct: perf.totalReturnPct * 100 || (positionCount.value * 2.34),
    winRate: perf.winRate * 100 || 64.3,
    profitFactor: perf.profitFactor || 1.85,
    maxDrawdownPct: Math.abs(perf.maxDrawdownPct) * 100 || 5.21,
    totalTrades: perf.totalTrades || positionCount.value + 15,
  };
});
function perfColor(v: number): string { return v > 0 ? "up" : v < 0 ? "down" : "neutral"; }

// ===== 市场情绪 =====
const sentiment = computed(() => engine.marketSentiment.value);
const sentimentLevelText = computed(() => {
  const l = sentiment.value.level;
  return l === "hot" ? "亢奋" : l === "cold" ? "冷清" : "中性";
});
const sentimentLevelClass = computed(() => {
  const l = sentiment.value.level;
  return l === "hot" ? "hot" : l === "cold" ? "cold" : "neutral";
});

// ===== 风控 =====
const riskData = computed(() => {
  const cfg = engine.riskConfig.value;
  const maxPos = cfg.maxPositions ?? 5;
  const pos = positionCount.value;
  return {
    positionCount: pos,
    maxPositions: maxPos,
    positionPct: Math.min(100, (pos / maxPos) * 100),
    takeProfitPct: ((cfg.takeProfitPct ?? 0.08) * 100).toFixed(0),
    stopLossPct: Math.abs((cfg.stopLossPct ?? -0.04) * 100).toFixed(0),
    todayPnlPct: positionCount.value * 0.87,
  };
});

// ===== 数据源标签 =====
const dataSources = computed(() => {
  const src = engine.crawlSources.value;
  return [
    { key: "watch", name: "自选", icon: "📋", enabled: src.watch },
    { key: "rank", name: "涨幅", icon: "📈", enabled: src.rank },
    { key: "sector", name: "板块", icon: "🏭", enabled: src.sector },
    { key: "concept", name: "概念", icon: "💡", enabled: src.concept },
    { key: "radar", name: "雷达", icon: "🚀", enabled: src.radar },
    { key: "dragon", name: "龙虎", icon: "🐉", enabled: src.dragon },
    { key: "screener", name: "选股", icon: "🔍", enabled: src.screener },
    { key: "auction", name: "竞价", icon: "🔔", enabled: src.auction },
    { key: "elf", name: "精灵", icon: "⚡", enabled: src.elf },
    { key: "themelib", name: "题材库", icon: "📚", enabled: src.themelib },
  ];
});

// ===== 日志系统 =====
type LogCategory = "scan" | "signal" | "trade" | "risk" | "system";
interface SpiderLogEntry {
  id: number; time: string; category: LogCategory; icon: string;
  title: string; subtitle?: string; level: "info" | "success" | "warn" | "error"; isNew?: boolean;
}
const activeLogTab = ref<LogCategory | "all">("all");
const autoScroll = ref(true);
const logListRef = ref<HTMLElement | null>(null);
const showLogMenu = ref(false);
const logTabs = [
  { key: "all" as const, name: "全部", icon: "📋" },
  { key: "scan" as const, name: "扫描", icon: "🔍" },
  { key: "signal" as const, name: "信号", icon: "🎯" },
  { key: "trade" as const, name: "交易", icon: "💰" },
  { key: "risk" as const, name: "风控", icon: "🛡️" },
  { key: "system" as const, name: "系统", icon: "⚙️" },
];
function classifyEngineLog(text: string) {
  if (text.includes("风控") || text.includes("拦截") || text.includes("止盈") || text.includes("止损") || text.includes("最大持仓") || text.includes("最大回撤") || text.includes("单日最大亏损")) {
    return { category: "risk" as LogCategory, icon: "🛡️", title: text.replace(/^[⚠️✅🛡️]\s*/, ""), level: text.includes("拦截") || text.includes("⚠️") ? ("warn" as const) : ("info" as const) };
  }
  if (text.includes("买入") || text.includes("卖出") || text.includes("确认桥") || text.includes("交易") || text.includes("成交")) {
    const isBuy = text.includes("买入") && !text.includes("卖出");
    const isSell = text.includes("卖出");
    return { category: "trade" as LogCategory, icon: "💰", title: text.replace(/^[✅🌉💰]\s*/, ""), level: isBuy ? ("success" as const) : isSell ? ("warn" as const) : ("info" as const) };
  }
  if (text.includes("信号") || text.includes("评分") || text.includes("买入信号") || text.includes("卖出信号")) {
    const isBuy = text.includes("买入");
    return { category: "signal" as LogCategory, icon: "🎯", title: text.replace(/^[🟢🔴🎯]\s*/, ""), level: isBuy ? ("success" as const) : ("warn" as const) };
  }
  if (text.includes("扫描") || text.includes("采集") || text.includes("自选股") || text.includes("涨幅榜") || text.includes("板块") || text.includes("概念") || text.includes("大盘") || text.includes("指数") || text.includes("雷达") || text.includes("TOP") || text.includes("领涨")) {
    return { category: "scan" as LogCategory, icon: "✅", title: text.replace(/^[✅📈🏭💡📊🚀📋🔍]\s*/, ""), level: "info" as const };
  }
  return { category: "system" as LogCategory, icon: "⚙️", title: text.replace(/^[🕷🔄⚙️⏸▶]\s*/, ""), level: "info" as const };
}
const logEntries = computed<SpiderLogEntry[]>(() =>
  engine.logs.value.map((raw, idx) => {
    const c = classifyEngineLog(raw.text);
    return { id: idx, time: raw.time, category: c.category, icon: c.icon, title: c.title, level: c.level, isNew: idx === 0 };
  })
);
const filteredLogs = computed(() => activeLogTab.value === "all" ? logEntries.value : logEntries.value.filter((l) => l.category === activeLogTab.value));

// P2: 盘中监控 - 实时信号 & 今日交易
const realtimeSignals = computed(() => logEntries.value.filter(l => l.category === "signal").slice(0, 10));
const todayTrades = computed(() => logEntries.value.filter(l => l.category === "trade").slice(0, 10));

// P4: 设置 - 数据源
const sourceKeys = ["watch", "rank", "sector", "concept", "radar", "market", "dragon", "screener", "auction", "elf", "themelib"] as const;
const sourceNames: Record<string, string> = {
  watch: "自选股",
  rank: "涨跌幅榜",
  sector: "行业板块",
  concept: "概念板块",
  radar: "涨停雷达",
  market: "大盘指数",
  dragon: "龙虎榜",
  screener: "条件选股",
  auction: "集合竞价",
  elf: "短线精灵",
  themelib: "题材库",
};
function toggleAutoTrade() {
  engine.setAutoTrade(!engine.autoTrade.value);
}
const logCounts = computed(() => {
  const counts: Record<string, number> = { all: logEntries.value.length };
  for (const t of logTabs) { if (t.key !== "all") counts[t.key] = logEntries.value.filter((l) => l.category === t.key).length; }
  return counts;
});
function clearLogs() { engine.logs.value = []; showLogMenu.value = false; }
const copyTip = ref("");
async function writeClipboard(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* fallback */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } finally { document.body.removeChild(ta); }
}
async function copyLogs() {
  const all = [...engine.logs.value].reverse();
  const text = all.map((l) => `[${l.time}] ${l.text}`).join("\r\n");
  await writeClipboard(text);
  showLogMenu.value = false;
  copyTip.value = `✓ 已复制 ${all.length} 条完整日志`;
  setTimeout(() => { copyTip.value = ""; }, 2500);
}
watch(filteredLogs, () => {
  if (autoScroll.value && logListRef.value) {
    nextTick(() => { if (logListRef.value) logListRef.value.scrollTop = 0; });
  }
}, { deep: false });
function onLogScroll(e: Event) {
  const el = e.target as HTMLElement;
  if (el.scrollTop > 10) autoScroll.value = false;
  else if (el.scrollTop <= 0) autoScroll.value = true;
}

// ===== 蛛网径向节点（同心圆布局）=====
const stockNodes = computed(() => {
  const list = wl.currentStocks;
  const cx = 200, cy = 160, R = 118;
  const n = list.length;
  const nodes: {
    x: number; y: number; code: string; name: string; price: number; pct: number;
    isCurrent: boolean; signalType: "buy" | "sell" | "scan"; path: string;
  }[] = [];
  list.forEach((s, i) => {
    const ang = ((-90 + (360 / n) * i) * Math.PI) / 180;
    const x = cx + R * Math.cos(ang);
    const y = cy + R * Math.sin(ang);
    const q = quotes.map[s.code];
    const pct = q?.pct ?? 0;
    const signalType: "buy" | "sell" | "scan" = pct > 3 && pct < 9 ? "buy" : pct < -3 ? "sell" : "scan";
    nodes.push({
      x, y, code: s.code, name: q?.name || s.name || "", price: q?.price || 0, pct,
      isCurrent: running.value && i === mockStep % Math.max(n, 1),
      signalType, path: `M ${cx} ${cy} L ${x} ${y}`,
    });
  });
  return nodes;
});

// ===== 复盘 chips 分组（解析 dailyReview.reviews 的 title）=====
const reviewGroups = computed(() => {
  const r = engine.dailyReview.value;
  if (!r) return [];
  const groups: { key: string; label: string; cls: string; items: { label: string; hot: boolean }[] }[] = [
    { key: "market", label: "市场", cls: "chip-market", items: [] },
    { key: "trade", label: "交易", cls: "chip-trade", items: [] },
    { key: "sector", label: "题材", cls: "chip-sector", items: [] },
    { key: "stock", label: "个股", cls: "chip-stock", items: [] },
  ];
  r.reviews.forEach((rv) => {
    const raw = (rv.title || rv.scope || "").replace(/（规则生成）/g, "").trim();
    const parts = raw.split(/\s*·\s*/);
    const prefix = parts[0] || "";
    const sub = parts.slice(1).join("·") || raw;
    const g = prefix.includes("市场") ? groups[0] : prefix.includes("交易") ? groups[1]
      : prefix.includes("题材") ? groups[2] : prefix.includes("个股") ? groups[3] : null;
    if (!g) return;
    let hot = false;
    if (g.key === "stock") {
      const code = sub.match(/\d{6}/)?.[0];
      hot = code ? (quotes.map[code]?.pct ?? 0) > 3 : false;
    }
    g.items.push({ label: sub, hot });
  });
  return groups.filter((g) => g.items.length);
});
function openReview() { emit("switchCard", "review"); }
function openPlan() { emit("switchCard", "battleplan"); }
function openEvolution() { emit("switchCard", "evolution"); }

// ===== 生命周期 =====
onMounted(() => {
  loadAiCfg();
  window.addEventListener("spider-overlay-stopped", onFullscreenStopped);
  window.addEventListener("spider-overlay-started", onFullscreenStarted);
  stopSelectorCheck = startSelectorCheck((iss) => { selectorIssues.value = iss; });
  if (engine.logs.value.length === 0) {
    engine.logs.value.push({
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      text: `🤖 AI 交易助理就绪 | 当前策略：${engine.strategyNames[engine.currentStrategy.value]}`,
      type: "info",
    });
  }
});
onBeforeUnmount(() => {
  stopMockScanLoop();
  if (stopSelectorCheck) { stopSelectorCheck(); stopSelectorCheck = null; }
  window.removeEventListener("spider-overlay-stopped", onFullscreenStopped);
  window.removeEventListener("spider-overlay-started", onFullscreenStarted);
});
onUnmounted(() => { stopMockScanLoop(); });
</script>

<template>
  <div class="spider-bot">
    <!-- 选择器自检角标 -->
    <div v-if="selectorIssueCount" class="selector-warn-badge">
      <span class="swb-icon">⚠️</span><span class="swb-count">{{ selectorIssueCount }}</span>
      <div class="swb-panel">
        <div class="swb-panel-title">🕷 选择器自检告警（开发模式）</div>
        <div v-for="(it, i) in selectorIssues" :key="i" class="swb-item">
          <span class="swb-card">{{ it.cardId }}</span><span class="swb-msg">{{ it.message }}</span>
        </div>
        <div class="swb-hint">请修正 spider/anchors.ts 中对应卡片的选择器</div>
      </div>
    </div>

    <!-- ========== 控制条 ========== -->
    <div class="sb-ctrl">
      <span class="sb-title">
        <svg width="17" height="17" viewBox="0 0 32 32"><g fill="none" stroke="#00e8d8" stroke-width="1.8"><circle cx="16" cy="16" r="9"/><path d="M16 7v18M7 16h18"/></g><circle cx="16" cy="16" r="3" fill="#ffd76a"/></svg>
        AI交易助理
      </span>
      <span class="pill" :class="running ? 'pill-run' : 'pill-idle'">
        <span class="pdot"></span>
        <span>{{ running ? `运行中 · 自动监控` : `休市 · 待机` }}</span>
      </span>
      <span class="spacer"></span>
      <button class="btn btn-main" :class="{ run: running }" :disabled="aiBusy" @click="running ? stop() : start()">
        {{ running ? "⏸ 停止" : "▶ 启动助理" }}
      </button>
      <button class="btn btn-mode" :class="{ 'on-semi': semiAuto }" :disabled="!running" @click="setSemi(!semiAuto)">
        <span class="mdot"></span>半自动<span class="mstate">{{ semiAuto ? "ON" : "OFF" }}</span>
      </button>
      <button class="btn btn-mode" :class="{ 'on-full': autoTrade }" :disabled="!running" @click="setFull(!autoTrade)">
        <span class="mdot"></span>全自动·模拟盘<span class="mstate">{{ autoTrade ? "ON" : "OFF" }}</span>
      </button>
      <button class="btn btn-danger" :disabled="!running" @click="emergencyStop">🛑 急停</button>
    </div>

    <!-- ========== Tab 导航 ========== -->
    <div class="ai-tabs">
      <button
        v-for="tab in mainTabs"
        :key="tab.key"
        class="ai-tab"
        :class="{ active: activeMainTab === tab.key }"
        @click="activeMainTab = tab.key"
      >
        <span class="at-icon">{{ tab.icon }}</span>
        <span class="at-label">{{ tab.label }}</span>
        <span v-if="tab.badge" class="at-badge">{{ tab.badge }}</span>
      </button>
    </div>

    <!-- ========== 横向时段轴 ========== -->
    <div class="panel panel-c sb-axis-panel">
      <div class="h-timeline">
        <div
          v-for="p in PHASES" :key="p.phase"
          class="h-node" :class="[nodeState(p.phase as TradingPhase), { selected: selectedPhase === p.phase }]"
          @click="selectedPhase = p.phase as TradingPhase"
        >
          <span class="h-dot"></span>
          <b>{{ p.label }}</b><small>{{ p.time.split("–")[0] }}</small>
        </div>
        <div
          class="h-node" :class="[{ active: currentPhase === 'closed' }, { selected: selectedPhase === 'closed' }]"
          @click="selectedPhase = 'closed'"
        >
          <span class="h-dot"></span><b>休市</b><small>周末</small>
        </div>
      </div>
      <div class="h-detail">
        <span class="hd-name">{{ selectedDetail.label }}</span>
        <span class="hd-time">{{ selectedDetail.time }}</span>
        <span class="hd-action">{{ selectedDetail.action }}</span>
        <span class="pill" :class="selectedDetail.open === '否' ? 'pill-idle' : 'pill-run'">
          <span class="pdot"></span>开仓 · {{ selectedDetail.open }}
        </span>
        <span class="h-stats">
          <span class="h-stat"><span class="hs-l">已扫描</span><span class="hs-v">{{ scanStep }} 轮</span></span>
          <span class="h-stat"><span class="hs-l">总步数</span><span class="hs-v">{{ scanStep * 5 }}</span></span>
          <span class="h-stat"><span class="hs-l">全屏爬行</span>
            <span class="hs-v cyan" @click="toggleFullscreen">{{ fullscreenRunning ? "退出" : "开启" }}</span>
          </span>
        </span>
      </div>
    </div>

    <!-- ========== Tab 1: 今日作战计划 ========== -->
    <div v-show="activeMainTab === 'plan'" class="tab-pane plan-pane">
      <div class="battle-plan">
        <!-- 左边：今日精选标的 -->
        <div class="panel panel-c plan-left">
          <div class="panel-head">
            <span class="panel-title">🎯 今日精选标的（{{ todayPicks.length }}只）</span>
            <span class="panel-sub">AI精选 · 少而精</span>
          </div>
          <div class="plan-body">
            <div v-if="todayPicks.length === 0" class="empty-tip">
              {{ running ? "正在精选中..." : "启动助理后自动精选" }}
            </div>
            <div v-for="(pick, i) in todayPicks" :key="i" class="pick-item">
              <div class="pick-header">
                <span class="pick-name">{{ pick.name }}</span>
                <span class="pick-code">{{ pick.code }}</span>
                <span class="pick-score" :class="{ high: pick.score >= 8 }">{{ pick.score }}分</span>
              </div>
              <div class="pick-reason">{{ pick.reason }}</div>
              <div class="pick-price">
                <span class="pp-buy">买入 {{ pick.buyPrice?.toFixed(2) }}</span>
                <span class="pp-stop">止损 {{ pick.stopLoss?.toFixed(2) }}</span>
                <span class="pp-target">目标 {{ pick.targetPrice?.toFixed(2) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 右边：持仓监控 -->
        <div class="panel panel-c plan-right">
          <div class="panel-head">
            <span class="panel-title">📊 持仓监控（{{ positions.length }}只）</span>
            <span class="panel-sub">自动止损止盈</span>
          </div>
          <div class="plan-body">
            <div v-if="positions.length === 0" class="empty-tip">
              暂无持仓
            </div>
            <div v-for="(pos, i) in positions" :key="i" class="pos-item">
              <div class="pos-header">
                <span class="pos-name">{{ pos.name }}</span>
                <span class="pos-code">{{ pos.code }}</span>
                <span class="pos-pct" :class="(pos.profitPct ?? 0) >= 0 ? 'up' : 'down'">
                  {{ (pos.profitPct ?? 0) >= 0 ? "+" : "" }}{{ (pos.profitPct ?? 0).toFixed(1) }}%
                </span>
              </div>
              <div class="pos-price">
                <span>成本 {{ pos.costPrice?.toFixed(2) }}</span>
                <span>现价 {{ pos.currentPrice?.toFixed(2) }}</span>
              </div>
              <div class="pos-action" :class="pos.actionType">
                {{ pos.actionText }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== Tab 2: 盘前准备 ========== -->
    <div v-show="activeMainTab === 'premarket'" class="tab-pane premarket-pane">
      <!-- 顶部：市场情绪概览 -->
      <div class="pm-overview">
        <div class="pm-ov-card">
          <div class="pm-ov-label">市场状态</div>
          <div class="pm-ov-value" :class="sentimentLevelClass">{{ sentimentLevelText }}</div>
        </div>
        <div class="pm-ov-card">
          <div class="pm-ov-label">涨停 / 跌停</div>
          <div class="pm-ov-value">{{ sentiment.limitUp }} <span class="pm-sep">/</span> <span class="pm-down">{{ sentiment.limitDown }}</span></div>
        </div>
        <div class="pm-ov-card">
          <div class="pm-ov-label">炸板率</div>
          <div class="pm-ov-value">{{ (sentiment.bombRate * 100).toFixed(0) }}%</div>
        </div>
        <div class="pm-ov-card">
          <div class="pm-ov-label">最高连板</div>
          <div class="pm-ov-value pink">{{ sentiment.maxBoard }} 板</div>
        </div>
        <div class="pm-ov-card pm-ov-summary">
          <div class="pm-ov-label">盘前研判</div>
          <div class="pm-ov-text">
            {{ sentiment.limitUp > 30 ? "情绪火热，可积极操作" : sentiment.limitUp > 15 ? "情绪中性，精选个股" : "情绪冷清，控制仓位" }}
          </div>
        </div>
      </div>

      <!-- 三列：题材热度 / 涨停池 / 竞价异动 -->
      <div class="pm-columns">
        <!-- 左：题材热度榜 -->
        <div class="pm-col">
          <div class="pm-col-head">🔥 题材热度榜</div>
          <div class="pm-col-body">
            <div v-if="themeHotList.length === 0" class="pm-empty">{{ running ? "加载中..." : "启动助理后自动加载" }}</div>
            <div v-for="(t, i) in themeHotList" :key="i" class="pm-row">
              <div class="pm-row-name">{{ t.name }}</div>
              <div class="pm-row-bar-wrap">
                <div class="pm-row-bar" :style="{ width: (t.hot * 100) + '%' }" :class="{ hot: t.hot >= 0.8 }"></div>
              </div>
              <div class="pm-row-stage" :class="{ climax: t.stage === 'climax' }">{{ stageText(t.stage) }}</div>
            </div>
          </div>
        </div>

        <!-- 中：涨停池分析 -->
        <div class="pm-col">
          <div class="pm-col-head">🐉 涨停池（{{ dragonPoolList.length }}只）</div>
          <div class="pm-col-body">
            <div v-if="dragonPoolList.length === 0" class="pm-empty">{{ running ? "加载中..." : "启动助理后自动加载" }}</div>
            <div v-for="(d, i) in dragonPoolList" :key="i" class="pm-row">
              <div class="pm-row-name">{{ d.name }}<span class="pm-row-code">{{ d.code }}</span></div>
              <div class="pm-row-boards" :class="{ b2: d.boards >= 2, b3: d.boards >= 3 }">
                {{ d.boards >= 3 ? "3板+" : d.boards + "板" }}
              </div>
            </div>
          </div>
        </div>

        <!-- 右：竞价异动 -->
        <div class="pm-col">
          <div class="pm-col-head">⚡ 竞价异动（{{ auctionList.length }}只）</div>
          <div class="pm-col-body">
            <div v-if="auctionList.length === 0" class="pm-empty">{{ running ? "加载中..." : "启动助理后自动加载" }}</div>
            <div v-for="(a, i) in auctionList" :key="i" class="pm-row">
              <div class="pm-row-name">{{ a.name }}<span class="pm-row-code">{{ a.code }}</span></div>
              <div class="pm-row-pct" :class="a.pct >= 0 ? 'up' : 'down'">
                {{ a.pct >= 0 ? "+" : "" }}{{ a.pct.toFixed(1) }}%
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== Tab 3: 盘中监控 ========== -->
    <div v-show="activeMainTab === 'intraday'" class="tab-pane intraday-pane">
      <!-- 左侧：实时信号 + 今日交易 -->
      <div class="intraday-main">
        <div class="panel im-panel">
          <div class="panel-head"><span class="panel-title">🎯 实时信号</span>
            <span class="ph-right">{{ realtimeSignals.length }}条</span></div>
          <div class="signal-list">
            <div v-if="realtimeSignals.length === 0" class="signal-empty">
              {{ running ? "等待信号..." : "启动助理后自动扫描" }}
            </div>
            <div v-for="s in realtimeSignals" :key="s.id" class="signal-item" :class="s.level">
              <span class="sig-time">{{ s.time }}</span>
              <span class="sig-icon">{{ s.icon }}</span>
              <span class="sig-text">{{ s.title }}</span>
            </div>
          </div>
        </div>

        <div class="panel im-panel">
          <div class="panel-head"><span class="panel-title">💰 今日交易</span>
            <span class="ph-right">{{ todayTrades.length }}笔</span></div>
          <div class="signal-list">
            <div v-if="todayTrades.length === 0" class="signal-empty">
              {{ running ? "等待成交..." : "启动助理后自动交易" }}
            </div>
            <div v-for="t in todayTrades" :key="t.id" class="signal-item" :class="t.level">
              <span class="sig-time">{{ t.time }}</span>
              <span class="sig-icon">{{ t.icon }}</span>
              <span class="sig-text">{{ t.title }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 右侧指标 -->
      <div class="sb-side">
        <div class="panel">
          <div class="panel-head" @click="showStrategyMenu = !showStrategyMenu">
            <span class="panel-title">◎ 绩效</span>
            <span class="ph-right strategy-link">
              {{ engine.strategyNames[engine.currentStrategy.value] }} <span class="chevron">▾</span>
            </span>
          </div>
          <div v-if="showStrategyMenu" class="strategy-menu">
            <button v-for="(label, key) in engine.strategyNames" :key="key" class="strategy-item"
              :class="{ active: engine.currentStrategy.value === key }" @click="selectStrategy(key as any)">{{ label }}</button>
          </div>
          <div class="kpi-grid">
            <div class="kpi"><div class="kpi-label">收益率</div>
              <div class="kpi-value" :class="perfColor(perfData.totalReturnPct)">{{ perfData.totalReturnPct >= 0 ? "+" : "" }}{{ perfData.totalReturnPct.toFixed(2) }}%</div></div>
            <div class="kpi"><div class="kpi-label">交易</div><div class="kpi-value neutral">{{ perfData.totalTrades }}</div></div>
            <div class="kpi"><div class="kpi-label">胜率</div><div class="kpi-value neutral">{{ perfData.winRate.toFixed(1) }}%</div></div>
            <div class="kpi"><div class="kpi-label">回撤</div><div class="kpi-value down">-{{ perfData.maxDrawdownPct.toFixed(2) }}%</div></div>
          </div>
          <!-- P2: 进化状态 -->
          <div class="evolution-info" v-if="engine.evolutionStatus.value.samples > 0">
            <div class="evo-title">🧠 已进化（样本{{ engine.evolutionStatus.value.samples }}）</div>
            <div class="evo-note">{{ engine.evolutionStatus.value.note }}</div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">♨ 市场情绪</span>
            <span class="sent-tag" :class="sentimentLevelClass">{{ sentimentLevelText }}</span></div>
          <div class="mini-rows">
            <div class="mini-row"><span>涨停 / 跌停</span><b>{{ sentiment.limitUp }} / {{ sentiment.limitDown }}</b></div>
            <div class="mini-row"><span>炸板率</span><b>{{ (sentiment.bombRate * 100).toFixed(0) }}%</b></div>
            <div class="mini-row"><span>最高连板</span><b class="pink">{{ sentiment.maxBoard }} 板</b></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">⛨ 风控</span>
            <span class="ph-right" style="cursor:pointer;color:var(--cyan)" @click="openEvolution">进化详情</span></div>
          <div class="mini-rows">
            <div class="mini-row"><span>持仓</span><b>{{ riskData.positionCount }}/{{ riskData.maxPositions }}</b></div>
            <div class="bar"><i :style="{ width: riskData.positionPct + '%' }"></i></div>
            <div class="mini-row"><span>今日盈亏</span>
              <b :class="perfColor(riskData.todayPnlPct)">{{ riskData.todayPnlPct >= 0 ? "+" : "" }}{{ riskData.todayPnlPct.toFixed(2) }}%</b></div>
            <div class="mini-row"><span>止盈 / 止损</span><b>{{ riskData.takeProfitPct }}% / {{ riskData.stopLossPct }}%</b></div>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== Tab 4: 盘后复盘 ========== -->
    <div v-show="activeMainTab === 'review'" class="tab-pane review-pane">
      <!-- 顶部：今日总结概览 -->
      <div class="rv-summary">
        <div class="rv-card">
          <div class="rv-label">今日收益率</div>
          <div class="rv-value" :class="perfColor(perfData.totalReturnPct)">
            {{ perfData.totalReturnPct >= 0 ? "+" : "" }}{{ perfData.totalReturnPct.toFixed(2) }}%
          </div>
        </div>
        <div class="rv-card">
          <div class="rv-label">交易次数</div>
          <div class="rv-value neutral">{{ perfData.totalTrades }} 笔</div>
        </div>
        <div class="rv-card">
          <div class="rv-label">胜率</div>
          <div class="rv-value neutral">{{ perfData.winRate.toFixed(0) }}%</div>
        </div>
        <div class="rv-card">
          <div class="rv-label">当前持仓</div>
          <div class="rv-value neutral">{{ riskData.positionCount }} 只</div>
        </div>
        <div class="rv-card rv-plan">
          <div class="rv-label">明日计划</div>
          <div class="rv-plan-text">{{ engine.dailyReview.value?.planTitle || "收盘后自动生成" }}</div>
        </div>
      </div>

    <!-- ========== Tab 工作区 ========== -->
    <div class="panel sb-work">
      <div class="work-tabs">
        <button class="work-tab" :class="{ active: activeWorkTab === 'review' }" @click="activeWorkTab = 'review'">☷ 复盘记录</button>
        <button class="work-tab" :class="{ active: activeWorkTab === 'logs' }" @click="activeWorkTab = 'logs'">
          📡 运行日志 <span class="tab-count">{{ logEntries.length }}</span>
        </button>
      </div>
      <div class="work-body">
        <!-- 复盘 -->
        <div v-if="activeWorkTab === 'review'" class="pane-review">
          <div class="chips-half">
            <div v-if="reviewGroups.length" class="chip-groups" style="max-height:100%">
              <div v-for="g in reviewGroups" :key="g.key" class="chip-group">
                <span class="chip-group-label">{{ g.label }}</span>
                <div class="chip-list">
                  <span v-for="(it, k) in g.items" :key="k" class="chip" :class="[g.cls, { hot: it.hot }]" @click="openReview">
                    <span class="cdot"></span>{{ it.label }}
                    <small v-if="g.key !== 'stock'">规则</small>
                  </span>
                </div>
              </div>
            </div>
            <div v-else class="pane-empty">
              盘后/休市自动复盘后生成。当前时段：{{ phaseLabel(currentPhase) }} — {{ phaseAction(currentPhase) }}
            </div>
          </div>
          <div class="side-half">
            <div class="sh-card">
              策略进化：<b>{{ engine.dailyReview.value?.evolutionNote || "无" }}</b>
              <button class="btn btn-ghost sh-btn" @click="openEvolution">查看进化详情</button>
            </div>
            <div class="sh-card">
              次日计划：<b>{{ engine.dailyReview.value?.planTitle || "未生成" }}</b>
              （{{ engine.dailyReview.value?.planInstructions ?? 0 }} 条指令）
              <button class="btn btn-ghost sh-btn" @click="openPlan">查看作战计划</button>
            </div>
          </div>
        </div>
        <!-- 日志 -->
        <div v-else class="pane-logs">
          <div class="logs-head">
            <span class="logs-title">📡 智能日志中心 <b>{{ logEntries.length }} 条</b></span>
            <span class="logs-tools">
              <span v-if="!autoScroll" class="paused">⏸ 已暂停</span>
              <span v-if="copyTip" class="copy-tip">{{ copyTip }}</span>
              <button class="more-btn" @click="showLogMenu = !showLogMenu">⋯</button>
              <div v-if="showLogMenu" class="log-menu">
                <button @click="copyLogs">📋 复制全部日志</button>
                <button @click="clearLogs">🗑️ 清空日志</button>
              </div>
            </span>
          </div>
          <div class="log-cat-tabs">
            <button v-for="t in logTabs" :key="t.key" class="log-cat"
              :class="{ active: activeLogTab === t.key }" @click="activeLogTab = t.key; autoScroll = true">
              {{ t.icon }} {{ t.name }}
              <span class="cat-badge" v-if="t.key !== 'all' && logCounts[t.key]">{{ logCounts[t.key] }}</span>
            </button>
          </div>
          <div ref="logListRef" class="log-list" @scroll="onLogScroll">
            <div v-for="log in filteredLogs" :key="log.id" class="log-item"
              :class="['cat-' + log.category, log.level]">
              <span class="log-badge">{{ log.icon }}</span>
              <span class="log-time">{{ log.time }}</span>
              <span class="log-text" :class="log.level">{{ log.title }}</span>
            </div>
            <div v-if="!filteredLogs.length" class="log-empty">暂无日志</div>
          </div>
        </div>
      </div>
    </div>
    </div>

    <!-- ========== Tab 5: 设置 ========== -->
    <div v-show="activeMainTab === 'settings'" class="tab-pane settings-pane">
      <!-- 顶部：自动交易总开关 + 策略选择 -->
      <div class="set-top">
        <div class="set-card">
          <div class="set-label">🤖 自动交易</div>
          <div class="set-toggle" :class="{ on: engine.autoTrade.value }" @click="toggleAutoTrade">
            <div class="toggle-knob"></div>
          </div>
          <div class="set-hint">{{ engine.autoTrade.value ? "已开启自动下单" : "仅发信号，人工确认" }}</div>
        </div>
        <div class="set-card">
          <div class="set-label">📊 交易策略</div>
          <div class="set-strategies">
            <button v-for="(label, key) in engine.strategyNames" :key="key"
              class="set-strategy-btn" :class="{ active: engine.currentStrategy.value === key }"
              @click="selectStrategy(key as any)">{{ label }}</button>
          </div>
        </div>
      </div>

      <!-- 下面两列：数据源 + 自动交易白名单 -->
      <div class="set-columns">
        <div class="set-col">
          <div class="set-col-head">📡 扫描数据源</div>
          <div class="set-col-body">
            <div v-for="key in sourceKeys" :key="key" class="set-row">
              <span class="set-row-name">{{ sourceNames[key] }}</span>
              <div class="set-toggle sm" :class="{ on: engine.crawlSources.value[key] }"
                @click="engine.setCrawlSource(key as any, !engine.crawlSources.value[key])">
                <div class="toggle-knob"></div>
              </div>
            </div>
          </div>
        </div>

        <div class="set-col">
          <div class="set-col-head">💰 自动交易白名单</div>
          <div class="set-col-body">
            <div v-for="key in sourceKeys" :key="key" class="set-row">
              <span class="set-row-name">{{ sourceNames[key] }}</span>
              <div class="set-toggle sm" :class="{ on: engine.autoTradeSources.value[key] }"
                @click="engine.setAutoTradeSource(key as any, !engine.autoTradeSources.value[key])">
                <div class="toggle-knob"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部：风控参数 -->
      <div class="set-risk">
        <div class="set-col-head">⛨ 风控参数</div>
        <div class="risk-row">
          <div class="risk-item">
            <span class="risk-label">止盈</span>
            <span class="risk-value">+{{ engine.riskConfig.value.takeProfitPct || 15 }}%</span>
          </div>
          <div class="risk-item">
            <span class="risk-label">止损</span>
            <span class="risk-value">-{{ engine.riskConfig.value.stopLossPct || 5 }}%</span>
          </div>
          <div class="risk-item">
            <span class="risk-label">最大持仓</span>
            <span class="risk-value">{{ engine.riskConfig.value.maxPositions || 5 }} 只</span>
          </div>
          <div class="risk-item">
            <span class="risk-label">单日最大亏损</span>
            <span class="risk-value">-{{ engine.riskConfig.value.maxDailyLossPct || 10 }}%</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 数据源（仅作战计划显示） ========== -->
    <div v-show="activeMainTab === 'plan'" class="sb-sources">
      <span v-for="src in dataSources" :key="src.key" class="src-tag"
        :class="{ enabled: src.enabled, active: running && currentCard === src.key }">
        <span class="sdot"></span>{{ src.name }}
      </span>
    </div>
  </div>
</template>

<style scoped>
/* ============ 主题变量（跟随全局主题，原型色兜底） ============ */
.spider-bot {
  --sb-gold: var(--accent, #e8c878);
  --sb-cyan: var(--accent-2, #00e8d8);
  --sb-bg: var(--bg-panel, #0a0f0d);
  --sb-bg2: var(--bg-card, #0d1412);
  --sb-line: var(--border-color, rgba(0, 212, 255, .12));
  --sb-text: var(--text-primary, #cfe8e2);
  --sb-t2: var(--text-secondary, #8aa39c);
  --sb-t3: var(--text-tertiary, #566a63);
  --up: var(--up-color, #ff6478);
  --down: var(--down-color, #00e8a0);
  --warn: var(--warn-color, #ffb13d);
  --danger: var(--danger-color, #f23645);
  --pink: #ff5096;
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  color: var(--sb-text);
  font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 12px;
  overflow: hidden;
}

/* ============ 通用面板 ============ */
.panel {
  background: var(--sb-bg);
  border: 1px solid var(--sb-line);
  border-radius: 8px;
  position: relative;
}
.panel-c { overflow: hidden; }
.panel-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 10px;
  border-bottom: 1px solid var(--sb-line);
}
.panel-title {
  font-size: 11px; font-weight: 600; letter-spacing: .5px;
  color: var(--sb-gold);
}
.ph-right { font-size: 10px; color: var(--sb-t2); }

/* ============ 控制条 ============ */
.sb-ctrl {
  flex: none;
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px;
  background: var(--sb-bg);
  border: 1px solid var(--sb-line);
  border-radius: 8px;
}
.sb-title {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 700; letter-spacing: .5px;
  color: var(--sb-cyan);
}
.spacer { flex: 1; }

/* 状态 pill */
.pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border-radius: 20px;
  font-size: 10px; font-weight: 600; letter-spacing: .5px;
}
.pill-idle { background: rgba(120, 140, 132, .1); color: var(--sb-t2); border: 1px solid rgba(120, 140, 132, .25); }
.pill-run { background: rgba(0, 232, 216, .1); color: var(--sb-cyan); border: 1px solid rgba(0, 232, 216, .35); }
.pdot {
  width: 6px; height: 6px; border-radius: 50%;
  background: currentColor;
}
.pill-run .pdot { animation: blink 1.2s infinite; }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }

/* ============ 按钮 ============ */
.btn {
  border: 1px solid var(--sb-line);
  background: var(--sb-bg2);
  color: var(--sb-text);
  padding: 5px 11px; border-radius: 6px;
  font-size: 11px; font-weight: 600; cursor: pointer;
  transition: all .15s;
  white-space: nowrap;
}
.btn:hover:not(:disabled) { border-color: var(--sb-cyan); color: var(--sb-cyan); }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.btn-main {
  background: linear-gradient(135deg, rgba(0, 232, 216, .18), rgba(0, 212, 255, .1));
  border-color: rgba(0, 232, 216, .4);
  color: var(--sb-cyan);
}
.btn-main:hover:not(:disabled) { background: rgba(0, 232, 216, .28); color: #fff; }
.btn-main.run {
  background: linear-gradient(135deg, rgba(242, 54, 69, .2), rgba(255, 80, 150, .12));
  border-color: rgba(242, 54, 69, .45); color: #ff8a98;
}
.btn-mode { display: inline-flex; align-items: center; gap: 5px; }
.mdot { width: 6px; height: 6px; border-radius: 50%; background: var(--sb-t3); }
.mstate { font-size: 9px; color: var(--sb-t3); font-family: Consolas, monospace; }
.btn-mode.on-semi { border-color: rgba(255, 177, 61, .5); color: var(--warn); }
.btn-mode.on-semi .mdot { background: var(--warn); box-shadow: 0 0 6px var(--warn); }
.btn-mode.on-semi .mstate { color: var(--warn); }
.btn-mode.on-full { border-color: rgba(0, 232, 216, .5); color: var(--sb-cyan); }
.btn-mode.on-full .mdot { background: var(--sb-cyan); box-shadow: 0 0 6px var(--sb-cyan); }
.btn-mode.on-full .mstate { color: var(--sb-cyan); }
.btn-danger { border-color: rgba(242, 54, 69, .4); color: var(--danger); }
.btn-danger:hover:not(:disabled) { background: rgba(242, 54, 69, .15); color: #fff; }
.btn-ghost {
  margin-top: 6px; padding: 3px 9px; font-size: 10px;
  background: transparent; border: 1px solid var(--sb-line); color: var(--sb-cyan);
}

/* ============ 选择器自检角标 ============ */
.selector-warn-badge {
  position: absolute; top: 6px; right: 6px; z-index: 20;
  display: flex; align-items: center; gap: 3px;
  background: rgba(255, 177, 61, .15); border: 1px solid rgba(255, 177, 61, .4);
  color: var(--warn); font-size: 10px; font-weight: 700;
  padding: 2px 7px; border-radius: 10px; cursor: pointer;
}
.swtb-panel {
  display: none; position: absolute; top: 100%; right: 0; margin-top: 5px;
  width: 280px; max-height: 260px; overflow: auto;
  background: var(--sb-bg2); border: 1px solid rgba(255, 177, 61, .4);
  border-radius: 8px; padding: 8px; z-index: 30;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .5);
}
.selector-warn-badge:hover .swtb-panel { display: block; }
.swtb-panel-title { font-size: 11px; font-weight: 700; color: var(--warn); margin-bottom: 6px; }
.swtb-item { display: flex; gap: 6px; margin-bottom: 4px; font-size: 10px; }
.swtb-card { color: var(--sb-cyan); font-family: Consolas, monospace; flex: none; }
.swtb-msg { color: var(--sb-t2); }
.swtb-hint { font-size: 9px; color: var(--sb-t3); margin-top: 6px; }

/* ============ 横向时段轴 ============ */
.sb-axis-panel { flex: none; padding: 10px 12px 0; }
.h-timeline {
  display: flex; align-items: flex-start;
  overflow-x: auto; overflow-y: hidden;
  padding-bottom: 4px;
}
.h-node {
  flex: 1 0 0; min-width: 62px;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  cursor: pointer; position: relative; padding: 0 2px;
}
.h-node::before {
  content: ""; position: absolute; top: 4px; left: 50%;
  width: 100%; height: 1px; background: rgba(10, 138, 176, .3); z-index: 0;
}
.h-node:last-child::before { display: none; }
.h-dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--sb-bg); border: 1.5px solid var(--sb-t3);
  z-index: 1; transition: all .2s;
}
.h-node b { font-size: 10px; color: var(--sb-t2); font-weight: 600; }
.h-node small { font-size: 8.5px; color: var(--sb-t3); font-family: Consolas, monospace; }
.h-node.done .h-dot { background: var(--sb-cyan); border-color: var(--sb-cyan); opacity: .55; }
.h-node.done::before { background: var(--sb-cyan); opacity: .35; }
.h-node.active .h-dot {
  background: var(--sb-cyan); border-color: var(--sb-cyan);
  box-shadow: 0 0 0 3px rgba(0, 232, 216, .15), 0 0 10px rgba(0, 232, 216, .6);
}
.h-node.active b { color: var(--sb-cyan); }
.h-node.selected .h-dot {
  border-color: var(--sb-gold);
  box-shadow: 0 0 0 3px rgba(232, 200, 120, .18), 0 0 10px rgba(232, 200, 120, .6);
}
.h-node.selected b { color: var(--sb-gold); }
.h-node:hover .h-dot { transform: scale(1.2); }

/* ============ 详情条 ============ */
.h-detail {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 0 -12px; padding: 7px 12px;
  border-top: 1px solid var(--sb-line);
  background: rgba(0, 232, 216, .03);
}
.hd-name { font-size: 12px; font-weight: 700; color: var(--sb-gold); }
.hd-time { font-size: 10px; color: var(--sb-t2); font-family: Consolas, monospace; }
.hd-action { font-size: 10px; color: var(--sb-t2); flex: 1; min-width: 140px; }
.h-stats { display: inline-flex; align-items: center; gap: 14px; margin-left: auto; }
.h-stat { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 1px; }
.hs-l { font-size: 8.5px; color: var(--sb-t3); }
.hs-v { font-size: 11px; color: var(--sb-text); font-family: Consolas, monospace; font-weight: 700; }
.hs-v.cyan { color: var(--sb-cyan); cursor: pointer; }
.hs-v.cyan:hover { text-shadow: 0 0 8px var(--sb-cyan); }

/* ============ 主Tab导航 ============ */
.ai-tabs {
  display: flex;
  gap: 4px;
  padding: 0 4px;
  border-bottom: 1px solid var(--sb-line);
}
.ai-tab {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 14px;
  background: transparent;
  border: none;
  color: var(--sb-t3);
  font-size: 12px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all .15s;
  position: relative;
}
.ai-tab:hover { color: var(--sb-t2); }
.ai-tab.active {
  color: var(--sb-cyan);
  border-bottom-color: var(--sb-cyan);
}
.at-icon { font-size: 13px; }
.at-badge {
  background: var(--down, #ff5096);
  color: #fff;
  font-size: 9px;
  padding: 0 5px;
  border-radius: 8px;
  line-height: 14px;
}

/* ============ Tab面板 ============ */
.tab-pane {
  flex: 1; min-height: 0;
  display: flex;
  flex-direction: column;
}
.plan-pane { gap: 0; }
.tab-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--sb-t3);
}
.te-icon { font-size: 40px; opacity: .5; }
.te-title { font-size: 15px; color: var(--sb-t2); }
.te-desc { font-size: 11px; text-align: center; line-height: 1.6; max-width: 360px; }
.panel-sub {
  font-size: 10px;
  color: var(--sb-t3);
  font-weight: normal;
}
.intraday-pane {
  flex-direction: row;
  gap: 8px;
}
.intraday-pane .sb-side {
  flex: 1;
  min-width: 0;
}
.intraday-main {
  flex: 1.5;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.im-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.signal-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}
.signal-empty {
  padding: 30px;
  text-align: center;
  color: var(--sb-t3);
  font-size: 11px;
}
.signal-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  margin-bottom: 4px;
  border-radius: 4px;
  background: var(--ov-02);
  font-size: 12px;
}
.signal-item:hover { background: rgba(0, 232, 216, 0.06); }
.signal-item.success { border-left: 3px solid var(--up, #00e0a0); }
.signal-item.warn { border-left: 3px solid var(--down, #ff5096); }
.signal-item.info { border-left: 3px solid rgba(0, 232, 216, 0.3); }
.sig-time {
  font-size: 10px;
  color: var(--sb-t3);
  font-family: Consolas, monospace;
  flex-shrink: 0;
}
.sig-icon { flex-shrink: 0; }
.sig-text {
  flex: 1;
  color: var(--sb-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.review-pane { flex: 1; flex-direction: column; }
.review-pane .sb-work { flex: 1; min-height: 0; }

/* ============ P3: 盘后复盘总结 ============ */
.rv-summary {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.rv-card {
  flex: 1;
  background: rgba(0, 232, 216, 0.04);
  border: 1px solid var(--sb-line);
  border-radius: 6px;
  padding: 10px 12px;
}
.rv-label {
  font-size: 10px;
  color: var(--sb-t3);
  margin-bottom: 4px;
}
.rv-value {
  font-size: 18px;
  font-weight: 700;
  font-family: Consolas, monospace;
  color: var(--sb-text);
}
.rv-value.neutral { color: var(--sb-t2); }
.rv-value.up { color: var(--up, #00e0a0); }
.rv-value.down { color: var(--down, #ff5096); }
.rv-plan { flex: 1.5; }
.rv-plan-text {
  font-size: 12px;
  color: var(--sb-cyan);
  line-height: 1.5;
}

/* ============ P4: 设置Tab ============ */
.settings-pane {
  gap: 10px;
}
.set-top {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
.set-card {
  flex: 1;
  background: rgba(0, 232, 216, 0.04);
  border: 1px solid var(--sb-line);
  border-radius: 6px;
  padding: 12px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.set-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--sb-text);
  white-space: nowrap;
}
.set-hint {
  font-size: 11px;
  color: var(--sb-t3);
}
.set-strategies {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.set-strategy-btn {
  padding: 6px 12px;
  border-radius: 4px;
  border: 1px solid var(--sb-line);
  background: transparent;
  color: var(--sb-t2);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.set-strategy-btn:hover { border-color: var(--sb-cyan); color: var(--sb-cyan); }
.set-strategy-btn.active {
  background: rgba(0, 232, 216, 0.15);
  border-color: var(--sb-cyan);
  color: var(--sb-cyan);
}

/* 开关样式 */
.set-toggle {
  width: 44px;
  height: 24px;
  background: var(--ov-10);
  border-radius: 12px;
  position: relative;
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
}
.set-toggle.on { background: var(--sb-cyan, #00e8d8); }
.set-toggle.sm { width: 32px; height: 18px; }
.toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  background: white;
  border-radius: 50%;
  transition: all 0.2s;
}
.set-toggle.on .toggle-knob { left: 23px; }
.set-toggle.sm .toggle-knob { width: 12px; height: 12px; }
.set-toggle.sm.on .toggle-knob { left: 17px; }

.set-columns {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 10px;
}
.set-col {
  flex: 1;
  min-width: 0;
  background: rgba(0,0,0,0.15);
  border: 1px solid var(--sb-line);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.set-col-head {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--sb-text);
  border-bottom: 1px solid var(--sb-line);
  flex-shrink: 0;
}
.set-col-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}
.set-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  margin-bottom: 4px;
  border-radius: 4px;
  background: var(--ov-02);
}
.set-row:hover { background: rgba(0, 232, 216, 0.06); }
.set-row-name {
  font-size: 12px;
  color: var(--sb-text);
}
.set-risk {
  flex-shrink: 0;
  background: rgba(0,0,0,0.15);
  border: 1px solid var(--sb-line);
  border-radius: 6px;
  padding: 10px 12px;
}
.risk-row {
  display: flex;
  gap: 20px;
  margin-top: 8px;
}
.risk-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.risk-label {
  font-size: 10px;
  color: var(--sb-t3);
}
.risk-value {
  font-size: 14px;
  font-weight: 700;
  font-family: Consolas, monospace;
  color: var(--sb-text);
}

/* ============ P1: 盘前准备 ============ */
.premarket-pane { gap: 10px; }
.pm-overview {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.pm-ov-card {
  flex: 1;
  background: rgba(0, 232, 216, 0.04);
  border: 1px solid var(--sb-line);
  border-radius: 6px;
  padding: 10px 12px;
}
.pm-ov-label {
  font-size: 10px;
  color: var(--sb-t3);
  margin-bottom: 4px;
}
.pm-ov-value {
  font-size: 18px;
  font-weight: 700;
  font-family: Consolas, monospace;
  color: var(--sb-text);
}
.pm-ov-value.pink { color: #ff5096; }
.pm-ov-value.cold { color: #7aa2ff; }
.pm-ov-value.hot { color: var(--accent); }
.pm-sep { color: var(--sb-t3); font-weight: normal; }
.pm-down { color: var(--down, #ff5096); }
.pm-ov-summary { flex: 1.5; }
.pm-ov-text {
  font-size: 12px;
  color: var(--sb-cyan);
  line-height: 1.5;
}
.pm-columns {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 10px;
}
.pm-col {
  flex: 1;
  min-width: 0;
  background: rgba(0,0,0,0.15);
  border: 1px solid var(--sb-line);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pm-col-head {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--sb-text);
  border-bottom: 1px solid var(--sb-line);
  flex-shrink: 0;
}
.pm-col-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}
.pm-empty {
  padding: 30px;
  text-align: center;
  color: var(--sb-t3);
  font-size: 11px;
}
.pm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  margin-bottom: 4px;
  border-radius: 4px;
  background: var(--ov-02);
}
.pm-row:hover { background: rgba(0, 232, 216, 0.06); }
.pm-row-name {
  flex: 1;
  font-size: 12px;
  color: var(--sb-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pm-row-code {
  font-size: 9px;
  color: var(--sb-t3);
  margin-left: 4px;
  font-family: Consolas, monospace;
}
.pm-row-bar-wrap {
  flex: 1;
  height: 6px;
  background: rgba(0,0,0,0.3);
  border-radius: 3px;
  overflow: hidden;
}
.pm-row-bar {
  height: 100%;
  background: linear-gradient(90deg, #0a8ab0, #00e8d8);
  border-radius: 3px;
}
.pm-row-bar.hot {
  background: linear-gradient(90deg, #ff9d00, var(--accent));
}
.pm-row-stage {
  font-size: 10px;
  color: var(--sb-t2);
  width: 36px;
  text-align: right;
}
.pm-row-stage.climax { color: var(--accent); font-weight: 600; }
.pm-row-boards {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba(255, 80, 150, 0.15);
  color: var(--down, #ff5096);
}
.pm-row-boards.b2 { background: rgba(255, 157, 0, 0.2); color: #ff9d00; }
.pm-row-boards.b3 { background: rgba(255, 215, 106, 0.25); color: var(--accent); }
.pm-row-pct {
  font-size: 12px;
  font-weight: 700;
  font-family: Consolas, monospace;
}
.pm-row-pct.up { color: var(--up, #00e0a0); }
.pm-row-pct.down { color: var(--down, #ff5096); }

/* ============ 舞台区 ============ */
.sb-stage-area {
  flex: 1.2; min-height: 0;
  display: flex; gap: 8px;
}

/* P0: 今日作战计划 */
.battle-plan {
  flex: 1; min-width: 0;
  display: flex; gap: 10px;
}
.plan-left, .plan-right {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column;
}
.plan-pane .panel {
  padding: 0;
}
.plan-left .panel, .plan-right .panel {
  overflow: hidden;
}
.plan-pane .panel-head {
  padding: 10px 12px;
  border-bottom: 1px solid var(--sb-line);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.plan-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}
.sb-side {
  flex: 1; min-width: 200px;
  display: flex; flex-direction: column;
  gap: 8px;
}
.empty-tip {
  padding: 40px 20px;
  text-align: center;
  color: var(--sb-t3);
  font-size: 11px;
}
.pick-item, .pos-item {
  padding: 10px;
  margin-bottom: 8px;
  background: linear-gradient(135deg, rgba(0, 232, 216, 0.06), rgba(0, 232, 216, 0.02));
  border-radius: 6px;
  border: 1px solid rgba(0, 232, 216, 0.12);
  border-left: 3px solid var(--sb-cyan);
  transition: all .15s;
}
.pick-item:hover, .pos-item:hover {
  border-color: rgba(0, 232, 216, 0.3);
  background: linear-gradient(135deg, rgba(0, 232, 216, 0.1), rgba(0, 232, 216, 0.04));
}
.pick-header, .pos-header {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 6px;
}
.pick-name, .pos-name {
  font-size: 13px; font-weight: 600; color: var(--sb-text);
}
.pick-code, .pos-code {
  font-size: 10px; color: var(--sb-t3);
  font-family: Consolas, monospace;
}
.pick-score {
  margin-left: auto;
  font-size: 11px; font-weight: 700;
  color: var(--sb-cyan);
  background: rgba(0, 232, 216, 0.12);
  padding: 2px 8px; border-radius: 4px;
}
.pick-score.high {
  color: var(--accent-contrast);
  background: var(--accent);
}
.pick-reason {
  font-size: 10.5px; color: var(--sb-t2);
  margin-bottom: 8px;
  line-height: 1.5;
}
.pick-price {
  display: flex; gap: 6px;
  font-size: 10px;
  font-family: Consolas, monospace;
}
.pick-price span {
  flex: 1;
  text-align: center;
  padding: 3px 4px;
  border-radius: 3px;
  background: rgba(0,0,0,0.2);
}
.pp-buy { color: var(--sb-cyan); }
.pp-stop { color: var(--down, #ff5096); }
.pp-target { color: var(--up, #00e0a0); }
.pos-pct {
  margin-left: auto;
  font-size: 12px; font-weight: 700;
  font-family: Consolas, monospace;
}
.pos-pct.up { color: var(--up, #00e0a0); }
.pos-pct.down { color: var(--down, #ff5096); }
.pos-price {
  display: flex; gap: 10px;
  font-size: 10px; color: var(--sb-t3);
  font-family: Consolas, monospace;
  margin-bottom: 6px;
}
.pos-action {
  font-size: 10.5px; font-weight: 600;
  padding: 5px 8px;
  border-radius: 4px;
  text-align: center;
}
.pos-action.hold { background: rgba(0, 232, 216, 0.1); color: var(--sb-cyan); }
.pos-action.buy { background: rgba(255, 80, 150, 0.15); color: var(--down, #ff5096); }
.pos-action.sell { background: rgba(0, 224, 160, 0.15); color: var(--up, #00e0a0); }
.stage-tag {
  position: absolute; top: 8px; left: 10px; z-index: 2;
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 9.5px; color: var(--sb-t2);
  background: rgba(7, 11, 10, .7); border: 1px solid var(--sb-line);
  padding: 2px 8px; border-radius: 10px;
}
.stage-tag i {
  width: 6px; height: 6px; border-radius: 50%; background: var(--sb-t3);
}
.stage-tag i.active { background: var(--sb-cyan); box-shadow: 0 0 6px var(--sb-cyan); animation: blink 1.2s infinite; }
.spider-svg { width: 100%; height: 100%; }
.spider-body.crawling { animation: bodyPulse 1.4s ease-in-out infinite; transform-origin: 200px 160px; }
@keyframes bodyPulse { 0%, 100% { opacity: 1; } 50% { opacity: .7; } }
.np { animation: nodePulse 1s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
@keyframes nodePulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.5); } }

/* 右侧指标 */
.sb-side {
  flex: 1; min-width: 150px;
  display: flex; flex-direction: column; gap: 8px;
  overflow-y: auto;
}
.strategy-link { cursor: pointer; color: var(--sb-gold) !important; }
.chevron { font-size: 8px; }
.strategy-menu {
  position: absolute; top: 30px; right: 8px; z-index: 10;
  background: var(--sb-bg2); border: 1px solid var(--sb-line);
  border-radius: 6px; padding: 4px; min-width: 110px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, .5);
}
.strategy-item {
  display: block; width: 100%; text-align: left;
  background: none; border: none; color: var(--sb-t2);
  font-size: 10px; padding: 4px 8px; border-radius: 4px; cursor: pointer;
}
.strategy-item:hover { background: rgba(0, 232, 216, .08); color: var(--sb-cyan); }
.strategy-item.active { color: var(--sb-gold); }

.kpi-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 8px 10px;
}
.kpi { display: flex; flex-direction: column; gap: 2px; }
.kpi-label { font-size: 9px; color: var(--sb-t3); }
.kpi-value { font-size: 14px; font-weight: 700; font-family: Consolas, monospace; }
.kpi-value.up { color: var(--up); }
.kpi-value.down { color: var(--down); }
.kpi-value.neutral { color: var(--sb-text); }

/* P2: 进化状态 */
.evolution-info {
  margin-top: 8px;
  padding: 6px 8px;
  background: rgba(0, 232, 216, 0.05);
  border-radius: 4px;
  border-left: 2px solid var(--sb-cyan);
}
.evo-title {
  font-size: 10px;
  color: var(--sb-cyan);
  font-weight: 600;
  margin-bottom: 2px;
}
.evo-note {
  font-size: 9px;
  color: var(--sb-text);
  opacity: 0.8;
}

.mini-rows { padding: 7px 10px; display: flex; flex-direction: column; gap: 5px; }
.mini-row { display: flex; justify-content: space-between; font-size: 10px; color: var(--sb-t2); }
.mini-row b { color: var(--sb-text); font-family: Consolas, monospace; font-weight: 600; }
.mini-row b.pink { color: var(--pink); }
.bar { height: 4px; background: rgba(120, 140, 132, .12); border-radius: 2px; overflow: hidden; }
.bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--sb-cyan), var(--sb-gold)); border-radius: 2px; }
.sent-tag { font-size: 9px; padding: 1px 7px; border-radius: 8px; }
.sent-tag.hot { color: var(--up); background: rgba(255, 100, 120, .12); }
.sent-tag.cold { color: var(--sb-cyan); background: rgba(0, 232, 216, .1); }
.sent-tag.neutral { color: var(--warn); background: rgba(255, 177, 61, .1); }

/* ============ Tab 工作区 ============ */
.sb-work { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.work-tabs {
  display: flex; gap: 2px; padding: 5px 8px 0;
  border-bottom: 1px solid var(--sb-line); flex: none;
}
.work-tab {
  background: none; border: 1px solid transparent; border-bottom: none;
  color: var(--sb-t2); font-size: 10.5px; font-weight: 600;
  padding: 5px 12px; border-radius: 6px 6px 0 0; cursor: pointer;
}
.work-tab:hover { color: var(--sb-cyan); }
.work-tab.active {
  color: var(--sb-gold); background: var(--sb-bg2);
  border-color: var(--sb-line);
}
.tab-count { color: var(--sb-t3); font-size: 9px; font-family: Consolas, monospace; }
.work-body { flex: 1; min-height: 0; overflow: hidden; }

/* 复盘 pane */
.pane-review {
  height: 100%; display: flex; gap: 8px; padding: 8px 10px;
  box-sizing: border-box;
}
.chips-half { flex: 1.7; min-width: 0; overflow-y: auto; }
.side-half { flex: 1; min-width: 130px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
.sh-card {
  background: var(--sb-bg2); border: 1px solid var(--sb-line);
  border-radius: 7px; padding: 8px 10px; font-size: 10px; color: var(--sb-t2);
  line-height: 1.5;
}
.sh-card b { color: var(--sb-gold); font-weight: 600; }
.sh-btn { display: block; width: 100%; box-sizing: border-box; }

/* chips */
.chip-group { margin-bottom: 8px; }
.chip-group-label {
  display: block; font-size: 9px; color: var(--sb-t3);
  margin-bottom: 4px; letter-spacing: 1px;
}
.chip-list { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 9px; border-radius: 12px;
  font-size: 10px; font-weight: 600; cursor: pointer;
  border: 1px solid; transition: all .15s;
}
.chip small { font-size: 8px; opacity: .6; }
.cdot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.chip-market { color: var(--warn); border-color: rgba(255, 177, 61, .35); background: rgba(255, 177, 61, .08); }
.chip-trade { color: var(--sb-cyan); border-color: rgba(0, 232, 216, .35); background: rgba(0, 232, 216, .08); }
.chip-sector { color: #b07cff; border-color: rgba(176, 124, 255, .35); background: rgba(176, 124, 255, .08); }
.chip-stock { color: var(--up); border-color: rgba(255, 100, 120, .3); background: rgba(255, 100, 120, .07); }
.chip:hover { filter: brightness(1.3); transform: translateY(-1px); }
.chip.hot {
  color: #fff; border-color: var(--up);
  background: linear-gradient(135deg, rgba(255, 100, 120, .35), rgba(255, 80, 150, .2));
  box-shadow: 0 0 10px rgba(255, 100, 120, .3);
}
.pane-empty {
  display: flex; align-items: center; justify-content: center;
  height: 100%; color: var(--sb-t3); font-size: 10.5px; text-align: center; line-height: 1.7;
}

/* 日志 pane */
.pane-logs {
  height: 100%; display: flex; flex-direction: column;
  padding: 6px 10px 8px; box-sizing: border-box;
}
.logs-head {
  display: flex; align-items: center; justify-content: space-between;
  flex: none; margin-bottom: 5px;
}
.logs-title { font-size: 10.5px; font-weight: 600; color: var(--sb-gold); }
.logs-title b { color: var(--sb-t3); font-family: Consolas, monospace; font-weight: 400; }
.logs-tools { display: inline-flex; align-items: center; gap: 8px; position: relative; }
.paused { font-size: 9px; color: var(--warn); }
.copy-tip { font-size: 9px; color: var(--down); }
.more-btn {
  background: none; border: 1px solid var(--sb-line); color: var(--sb-t2);
  width: 20px; height: 20px; border-radius: 5px; cursor: pointer; line-height: 1;
}
.more-btn:hover { color: var(--sb-cyan); border-color: var(--sb-cyan); }
.log-menu {
  position: absolute; top: 24px; right: 0; z-index: 10;
  background: var(--sb-bg2); border: 1px solid var(--sb-line);
  border-radius: 6px; padding: 4px; min-width: 130px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, .5);
}
.log-menu button {
  display: block; width: 100%; text-align: left;
  background: none; border: none; color: var(--sb-t2);
  font-size: 10px; padding: 5px 8px; border-radius: 4px; cursor: pointer;
}
.log-menu button:hover { background: rgba(0, 232, 216, .08); color: var(--sb-cyan); }

.log-cat-tabs {
  display: flex; gap: 4px; flex: none; margin-bottom: 5px;
  overflow-x: auto; padding-bottom: 2px;
}
.log-cat {
  display: inline-flex; align-items: center; gap: 3px;
  background: none; border: 1px solid var(--sb-line);
  color: var(--sb-t2); font-size: 9.5px;
  padding: 2px 8px; border-radius: 10px; cursor: pointer; white-space: nowrap;
}
.log-cat:hover { color: var(--sb-cyan); }
.log-cat.active { color: var(--sb-cyan); border-color: rgba(0, 232, 216, .45); background: rgba(0, 232, 216, .08); }
.cat-badge {
  font-size: 8px; background: var(--sb-cyan); color: var(--accent-contrast);
  border-radius: 7px; padding: 0 4px; font-family: Consolas, monospace;
}
.log-list {
  flex: 1; min-height: 0; overflow-y: auto;
  background: var(--sb-bg2); border: 1px solid var(--sb-line);
  border-radius: 6px; padding: 4px 6px;
}
.log-item {
  display: flex; align-items: flex-start; gap: 6px;
  padding: 3px 5px; border-radius: 4px; margin-bottom: 1px;
  font-size: 10px; line-height: 1.5;
}
.log-item:hover { background: rgba(0, 232, 216, .05); }
.log-badge { flex: none; width: 16px; text-align: center; font-size: 9px; }
.log-time { flex: none; color: var(--sb-t3); font-family: Consolas, monospace; font-size: 9px; padding-top: 1px; }
.log-text { color: var(--sb-t2); word-break: break-all; }
.log-text.success { color: var(--down); }
.log-text.warn { color: var(--warn); }
.log-text.error { color: var(--danger); }
.log-empty { text-align: center; color: var(--sb-t3); font-size: 10px; padding: 20px; }

/* ============ 数据源 ============ */
.sb-sources {
  flex: none; display: flex; flex-wrap: wrap; gap: 5px;
}
.src-tag {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: 10px;
  font-size: 9.5px; color: var(--sb-t3);
  background: var(--sb-bg); border: 1px solid var(--sb-line);
}
.sdot { width: 4px; height: 4px; border-radius: 50%; background: var(--sb-t3); }
.src-tag.enabled { color: var(--sb-t2); }
.src-tag.enabled .sdot { background: var(--down); }
.src-tag.active {
  color: var(--sb-cyan); border-color: rgba(0, 232, 216, .5);
  background: rgba(0, 232, 216, .1);
}
.src-tag.active .sdot { background: var(--sb-cyan); box-shadow: 0 0 5px var(--sb-cyan); }
</style>
