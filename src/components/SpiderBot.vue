<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, onUnmounted, watch, nextTick } from "vue";
import { useWatchlistStore } from "../stores/watchlist";
import { useQuotesStore } from "../stores/quotes";
import { useSpiderBotEngine } from "../composables/useSpiderBotEngine";
import { autoexecGetConfig, autoexecStart, autoexecStop } from "../ai/api";
import { startSelectorCheck, type SelectorIssue } from "./spider/selectorCheck";

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

// ===== 自动交易配置 =====
const aiCfg = ref<any>(null);
const aiBusy = ref(false);

async function loadAiCfg() {
  try {
    aiCfg.value = await autoexecGetConfig();
  } catch (e) {
    console.warn("加载自动交易配置失败:", e);
  }
}

// ===== 全屏爬行模式 =====
const fullscreenRunning = ref(false);

// ===== 选择器自检角标（仅开发模式；DOM 改版导致采不到行时告警）=====
const selectorIssues = ref<SelectorIssue[]>([]);
let stopSelectorCheck: (() => void) | null = null;
const selectorIssueCount = computed(() => selectorIssues.value.length);

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

// ===== 模式切换 =====
async function setSemi(on: boolean) {
  if (!aiCfg.value) await loadAiCfg();
  if (on) {
    engine.setAutoTrade(false);
    engine.setSemiAuto(true);
  } else {
    engine.setSemiAuto(false);
  }
  syncBackendMode();
}

async function setFull(on: boolean) {
  if (!aiCfg.value) await loadAiCfg();
  if (on) {
    engine.setSemiAuto(false);
    engine.setAutoTrade(true);
  } else {
    engine.setAutoTrade(false);
  }
  syncBackendMode();
}

async function syncBackendMode() {
  try {
    if (!aiCfg.value) return;
    // 模式变更时如果正在运行，同步到后端
    if (running.value) {
      const patch = autoTrade.value
        ? { tradeMode: "full" as const, fullAutoMode: true, bridgeEnabled: false }
        : { tradeMode: "manual" as const, fullAutoMode: false, bridgeEnabled: true };
      await autoexecStart({ ...aiCfg.value, enabled: true, ...patch });
    }
  } catch (e) {
    console.warn("同步模式到后端失败:", e);
  }
}

// ===== 启动/停止 =====
async function start() {
  if (!aiCfg.value) await loadAiCfg();
  aiBusy.value = true;
  try {
    // 启动后端自动交易
    if (aiCfg.value) {
      const patch = autoTrade.value
        ? { tradeMode: "full" as const, fullAutoMode: true, bridgeEnabled: false }
        : { tradeMode: "manual" as const, fullAutoMode: false, bridgeEnabled: true };
      await autoexecStart({ ...aiCfg.value, enabled: true, ...patch });
    }
    // 启动前端引擎
    engine.start((cardId) => {
      emit("switchCard", cardId);
      return true;
    });
    // 开始生成 mock 扫描动画日志
    startMockScanLoop();
  } finally {
    aiBusy.value = false;
  }
}

async function stop() {
  aiBusy.value = true;
  try {
    await autoexecStop();
    engine.stop();
    stopMockScanLoop();
  } finally {
    aiBusy.value = false;
  }
}

function emergencyStop() {
  stop();
  window.dispatchEvent(new CustomEvent("spider-overlay-stop"));
  fullscreenRunning.value = false;
}

// ===== Mock 扫描循环（驱动卡片内的可视化 + 日志流）=====
let mockTimer: number | null = null;
let mockStep = 0;

const scanCards = [
  { id: "watch", name: "自选股", icon: "📋" },
  { id: "rank", name: "涨幅榜", icon: "📈" },
  { id: "sector", name: "板块", icon: "🏭" },
  { id: "concept", name: "概念题材", icon: "💡" },
  { id: "radar", name: "涨停雷达", icon: "🚀" },
  { id: "market", name: "大盘指数", icon: "📊" },
];

function startMockScanLoop() {
  mockStep = 0;
  tickMock();
  mockTimer = window.setInterval(tickMock, 2500);
}

function stopMockScanLoop() {
  if (mockTimer) { clearInterval(mockTimer); mockTimer = null; }
}

function tickMock() {
  const card = scanCards[mockStep % scanCards.length];
  currentCard.value = card.id;
  mockStep++;
  scanStep.value = mockStep;
}

function scanWatchMock() {
  const list = wl.currentStocks;
  if (!list.length) return;
  // 仅驱动蜘蛛动画，日志由 engine 产生
}

function scanRankMock() {
  // 仅驱动蜘蛛动画，日志由 engine 产生
}

function scanSectorMock() {
  // 仅驱动蜘蛛动画，日志由 engine 产生
}

function scanConceptMock() {
  // 仅驱动蜘蛛动画，日志由 engine 产生
}

function scanRadarMock() {
  // 仅驱动蜘蛛动画，日志由 engine 产生
}

function scanMarketMock() {
  // 仅驱动蜘蛛动画，日志由 engine 产生
}

// ===== 当前扫描卡片 =====
const currentCard = ref("watch");
const scanStep = ref(0);
const positionCount = ref(0);

// ===== 策略选择菜单 =====
const showStrategyMenu = ref(false);

function selectStrategy(key: "conservative" | "balanced" | "aggressive" | "scalping") {
  engine.applyStrategy(key);
  showStrategyMenu.value = false;
}

// ===== 绩效数据（mock + 实时）=====
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

function perfColor(v: number): string {
  return v > 0 ? "up" : v < 0 ? "down" : "neutral";
}

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

// ===== 风控数据 =====
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

// ====== 数据源标签 ======
const dataSources = computed(() => {
  const src = engine.crawlSources.value;
  return [
    { key: "watch", name: "自选", icon: "📋", enabled: src.watch },
    { key: "rank", name: "涨幅", icon: "📈", enabled: src.rank },
    { key: "sector", name: "板块", icon: "🏭", enabled: src.sector },
    { key: "concept", name: "概念", icon: "💡", enabled: src.concept },
    { key: "radar", name: "雷达", icon: "🚀", enabled: src.radar },
    { key: "market", name: "大盘", icon: "📊", enabled: src.market },
    { key: "dragon", name: "龙虎", icon: "🐉", enabled: src.dragon },
    { key: "screener", name: "选股", icon: "🔍", enabled: src.screener },
    { key: "auction", name: "竞价", icon: "🔔", enabled: src.auction },
    { key: "elf", name: "精灵", icon: "⚡", enabled: src.elf },
    { key: "themelib", name: "题材库", icon: "📚", enabled: src.themelib },
  ];
});

// ====== 日志系统 ======

type LogCategory = "scan" | "signal" | "trade" | "risk" | "system";

interface SpiderLogEntry {
  id: number;
  time: string;
  category: LogCategory;
  icon: string;
  title: string;
  subtitle?: string;
  detail?: string;
  code?: string;
  name?: string;
  price?: number;
  pct?: number;
  score?: number;
  signals?: string[];
  amount?: number;
  qty?: number;
  side?: "BUY" | "SELL";
  reason?: string;
  level: "info" | "success" | "warn" | "error";
  isNew?: boolean;
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

// 将 engine 日志智能分类转换为 6 分类格式
function classifyEngineLog(text: string): {
  category: LogCategory;
  icon: string;
  title: string;
  subtitle?: string;
  level: "info" | "success" | "warn" | "error";
} {
  // 风控类
  if (text.includes("风控") || text.includes("拦截") || text.includes("止盈") || text.includes("止损") || text.includes("最大持仓") || text.includes("最大回撤") || text.includes("单日最大亏损")) {
    return {
      category: "risk",
      icon: "🛡️",
      title: text.replace(/^[⚠️✅🛡️]\s*/, ""),
      level: text.includes("拦截") || text.includes("⚠️") ? "warn" : "info",
    };
  }

  // 交易类
  if (text.includes("买入") || text.includes("卖出") || text.includes("确认桥") || text.includes("交易") || text.includes("成交")) {
    const isBuy = text.includes("买入") && !text.includes("卖出");
    const isSell = text.includes("卖出");
    return {
      category: "trade",
      icon: "💰",
      title: text.replace(/^[✅🌉💰]\s*/, ""),
      level: isBuy ? "success" : isSell ? "warn" : "info",
    };
  }

  // 信号类
  if (text.includes("信号") || text.includes("评分") || text.includes("买入信号") || text.includes("卖出信号")) {
    const isBuy = text.includes("买入");
    return {
      category: "signal",
      icon: "🎯",
      title: text.replace(/^[🟢🔴🎯]\s*/, ""),
      level: isBuy ? "success" : "warn",
    };
  }

  // 扫描/采集类
  if (
    text.includes("扫描") || text.includes("采集") ||
    text.includes("自选股") || text.includes("涨幅榜") ||
    text.includes("板块") || text.includes("概念") ||
    text.includes("大盘") || text.includes("指数") ||
    text.includes("雷达") || text.includes("TOP") ||
    text.includes("领涨")
  ) {
    return {
      category: "scan",
      icon: "✅",
      title: text.replace(/^[✅📈🏭💡📊🚀📋🔍]\s*/, ""),
      level: "info",
    };
  }

  // 系统类（启停、策略切换、切卡等）
  return {
    category: "system",
    icon: "⚙️",
    title: text.replace(/^[🕷🔄⚙️⏸▶]\s*/, ""),
    level: "info",
  };
}

// 从 engine.logs 转换来的结构化日志
const logEntries = computed<SpiderLogEntry[]>(() => {
  return engine.logs.value.map((raw, idx) => {
    const classified = classifyEngineLog(raw.text);
    return {
      id: idx,
      time: raw.time,
      category: classified.category,
      icon: classified.icon,
      title: classified.title,
      subtitle: classified.subtitle,
      level: classified.level as any,
      isNew: idx === 0,
    };
  });
});

const filteredLogs = computed(() => {
  if (activeLogTab.value === "all") return logEntries.value;
  return logEntries.value.filter(l => l.category === activeLogTab.value);
});

const logCounts = computed(() => {
  const counts: Record<string, number> = { all: logEntries.value.length };
  for (const tab of logTabs) {
    if (tab.key === "all") continue;
    counts[tab.key] = logEntries.value.filter(l => l.category === tab.key).length;
  }
  return counts;
});

function clearLogs() {
  engine.logs.value = [];
  showLogMenu.value = false;
}

// 复制完整日志：按时间正序（旧→新）拼成纯文本写入剪贴板
const copyTip = ref("");
async function writeClipboard(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* 走降级 */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
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

function toggleLogExpand(id: number) {
  const entry = logEntries.value.find(l => l.id === id);
  if (entry) {
    (entry as any).expanded = !(entry as any).expanded;
  }
}

// 自动滚动
watch(filteredLogs, () => {
  if (autoScroll.value && logListRef.value) {
    nextTick(() => {
      if (logListRef.value) {
        logListRef.value.scrollTop = 0;
      }
    });
  }
}, { deep: false });

function onLogScroll(e: Event) {
  const el = e.target as HTMLElement;
  if (el.scrollTop > 10) {
    autoScroll.value = false;
  } else if (el.scrollTop <= 0) {
    autoScroll.value = true;
  }
}

// ===== 蜘蛛节点布局（保留原有可视化） =====
const stockNodes = computed(() => {
  const list = wl.currentStocks;
  const bodyX = 180, bodyY = 140;
  const nodes: {
    x: number; y: number;
    code: string; name: string;
    price: number; pct: number;
    isCurrent: boolean;
    legPath: string;
    signalType: "buy" | "sell" | "scan";
  }[] = [];

  list.forEach((s, i) => {
    const q = quotes.map[s.code];
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const x = bodyX + side * (100 + (i % 3) * 18);
    const y = bodyY - 60 + row * 45;

    const legPath = makeLegPath(bodyX, bodyY, x, y, i);

    const pct = q?.pct ?? 0;
    const signalType: "buy" | "sell" | "scan" =
      pct > 3 && pct < 9 ? "buy" : pct < -3 ? "sell" : "scan";

    nodes.push({
      x, y,
      code: s.code,
      name: q?.name || s.name || "",
      price: q?.price || 0,
      pct,
      isCurrent: running.value && i === mockStep % Math.max(list.length, 1),
      legPath,
      signalType,
    });
  });

  return nodes;
});

function makeLegPath(x1: number, y1: number, x2: number, y2: number, seed: number): string {
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const offset = 22 + (seed % 3) * 12;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;

  const p1x = x1 + dx * 0.25 + nx * offset;
  const p1y = y1 + dy * 0.25 + ny * offset;
  const p2x = x1 + dx * 0.5 + nx * offset * 0.5;
  const p2y = y1 + dy * 0.5 + ny * offset * 0.5;
  const p3x = x1 + dx * 0.75 + nx * offset * 0.3;
  const p3y = y1 + dy * 0.75 + ny * offset * 0.3;

  return `M ${x1} ${y1} L ${p1x} ${p1y} L ${p2x} ${p2y} L ${p3x} ${p3y} L ${x2} ${y2}`;
}

// ===== 生命周期 =====
onMounted(() => {
  loadAiCfg();
  window.addEventListener("spider-overlay-stopped", onFullscreenStopped);
  window.addEventListener("spider-overlay-started", onFullscreenStarted);

  // 启动选择器自检（开发模式才真正运行，生产为空操作）
  stopSelectorCheck = startSelectorCheck((iss) => {
    selectorIssues.value = iss;
  });

  // 初始欢迎日志（仅在引擎日志为空时添加）
  if (engine.logs.value.length === 0) {
    engine.logs.value.push({
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      text: `🕷 AI 爬虫机器人就绪 | 当前策略：${engine.strategyNames[engine.currentStrategy.value]}`,
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
    <!-- ===== 选择器自检角标（仅开发模式、有失效项时出现；hover 看详情）===== -->
    <div v-if="selectorIssueCount" class="selector-warn-badge">
      <span class="swb-icon">⚠️</span>
      <span class="swb-count">{{ selectorIssueCount }}</span>
      <div class="swb-panel">
        <div class="swb-panel-title">🕷 选择器自检告警（开发模式）</div>
        <div v-for="(it, i) in selectorIssues" :key="i" class="swb-item">
          <span class="swb-card">{{ it.cardId }}</span>
          <span class="swb-msg">{{ it.message }}</span>
        </div>
        <div class="swb-hint">请修正 spider/anchors.ts 中对应卡片的选择器</div>
      </div>
    </div>

    <!-- ========== 顶部控制栏 ========== -->
    <div class="sb-header">
      <div class="sb-title-row">
        <div class="sb-title">
          <span class="sb-title-icon">🕷</span>
          <span class="sb-title-text">AI爬虫机器人</span>
        </div>
        <div class="sb-controls">
          <button
            class="sb-btn sb-btn-main"
            :class="{ on: running, 'is-loading': aiBusy }"
            :disabled="aiBusy"
            @click="running ? stop() : start()"
          >
            {{ running ? "⏸ 停止爬取" : "▶ 启动爬虫" }}
          </button>
          <button
            class="sb-btn sb-btn-semi"
            :class="{ on: semiAuto }"
            @click="setSemi(!semiAuto)"
            :disabled="!running"
          >
            <span class="sb-btn-dot"></span>
            半自动
            <span class="sb-btn-state">{{ semiAuto ? "ON" : "OFF" }}</span>
          </button>
          <button
            class="sb-btn sb-btn-full"
            :class="{ on: autoTrade }"
            @click="setFull(!autoTrade)"
            :disabled="!running"
          >
            <span class="sb-btn-dot"></span>
            全自动
            <span class="sb-btn-state">{{ autoTrade ? "ON" : "OFF" }}</span>
          </button>
          <button class="sb-btn sb-btn-danger" @click="emergencyStop" :disabled="!running">
            🛑 急停
          </button>
        </div>
      </div>

      <!-- 状态行 -->
      <div class="sb-status-bar" v-if="running">
        <div class="sb-status-item">
          <span class="sb-status-label">📍 当前</span>
          <span class="sb-status-value sb-val-accent">
            {{ scanCards[scanStep % scanCards.length]?.name || '自选股' }}
          </span>
        </div>
        <div class="sb-status-divider"></div>
        <div class="sb-status-item">
          <span class="sb-status-label">⟳ 已扫描</span>
          <span class="sb-status-value sb-val-num">{{ scanStep }} 轮</span>
        </div>
        <div class="sb-status-divider"></div>
        <div class="sb-status-item">
          <span class="sb-status-label">📊 步数</span>
          <span class="sb-status-value sb-val-num">{{ scanStep * 5 }}</span>
        </div>
        <div class="sb-status-divider"></div>
        <div class="sb-status-item">
          <span class="sb-status-label">🕷 全屏</span>
          <span class="sb-status-link" @click="toggleFullscreen">
            {{ fullscreenRunning ? '退出' : '开启' }}
          </span>
        </div>
      </div>
      <div class="sb-status-bar sb-status-idle" v-else>
        <span class="sb-idle-dot"></span>
        <span class="sb-idle-text">爬虫未启动，点击「启动爬虫」开始扫描</span>
      </div>
    </div>

    <!-- ========== 中部主区（左右分栏） ========== -->
    <div class="sb-main">
      <!-- 左栏：蜘蛛可视化舞台 -->
      <div class="sb-stage">
        <div class="sb-stage-title">
          <span class="sb-stage-dot" :class="{ active: running }"></span>
          <span>蛛网上的猎物</span>
        </div>
        <div class="spider-stage">
          <svg viewBox="0 0 360 280" class="spider-svg">
            <defs>
              <filter id="glow-card">
                <feGaussianBlur stdDeviation="2" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
              <linearGradient id="threadGradCard" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stop-color="#0a8ab0" stop-opacity="0.3" />
                <stop offset="50%" stop-color="#00dcff" stop-opacity="1" />
                <stop offset="100%" stop-color="#0a8ab0" stop-opacity="0.3" />
              </linearGradient>
              <radialGradient id="scanBeamCard" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="#00dcff" stop-opacity="0.4" />
                <stop offset="100%" stop-color="#00dcff" stop-opacity="0" />
              </radialGradient>
              <radialGradient id="buyBeamCard" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="#ff6478" stop-opacity="0.4" />
                <stop offset="100%" stop-color="#ff6478" stop-opacity="0" />
              </radialGradient>
            </defs>

            <!-- 背景网格 -->
            <g opacity="0.06">
              <line v-for="i in 10" :key="'h'+i"
                :x1="0" :y1="280 / 10 * i" :x2="360" :y2="280 / 10 * i"
                stroke="#00dcff" stroke-width="0.5" />
              <line v-for="i in 14" :key="'v'+i"
                :x1="360 / 14 * i" :y1="0" :x2="360 / 14 * i" :y2="280"
                stroke="#00dcff" stroke-width="0.5" />
            </g>

            <!-- 蜘蛛腿（蛛丝） -->
            <g v-for="(node, i) in stockNodes" :key="i" class="spider-leg">
              <path
                :d="node.legPath"
                :stroke="node.isCurrent ? '#00dcff' : node.signalType === 'buy' ? '#ff6478' : '#0a4a60'"
                :stroke-width="node.isCurrent ? 1.5 : 0.8"
                fill="none"
                :opacity="node.isCurrent ? 0.9 : 0.35"
              />
              <!-- 流动光点 -->
              <circle
                v-for="j in 2"
                :key="'p'+j"
                r="1.5"
                :fill="node.isCurrent ? '#00ffff' : node.signalType === 'buy' ? '#ff6478' : '#0a8ab0'"
                :opacity="node.isCurrent ? 0.9 : 0.4"
                filter="url(#glow-card)"
              >
                <animateMotion
                  :dur="(2 + j * 0.8) + 's'"
                  repeatCount="indefinite"
                  :path="node.legPath"
                  :begin="(j * 0.7) + 's'"
                />
              </circle>
              <!-- 扫描光束 -->
              <circle v-if="node.isCurrent" :cx="node.x" :cy="node.y" r="20"
                :fill="node.signalType === 'buy' ? 'url(#buyBeamCard)' : 'url(#scanBeamCard)'"
                class="scan-beam-sm" />
              <!-- 节点光环 -->
              <circle :cx="node.x" :cy="node.y" :r="node.isCurrent ? 10 : 5"
                :fill="node.signalType === 'buy' ? '#ff5096' : node.signalType === 'sell' ? '#00e0a0' : '#ff88aa'"
                :opacity="node.isCurrent ? 0.25 : 0.1"
                :class="{ 'pulse-ring-sm': node.isCurrent }"
              />
              <!-- 节点核心 -->
              <circle :cx="node.x" :cy="node.y" :r="node.isCurrent ? 5 : 3.5"
                :fill="node.signalType === 'buy' ? '#ff5096' : node.signalType === 'sell' ? '#00e0a0' : '#00d4ff'"
                :opacity="node.isCurrent ? 1 : 0.7"
                filter="url(#glow-card)"
                :class="{ 'node-pulse-sm': node.isCurrent }"
              />
              <!-- 节点名称 -->
              <text :x="node.x" :y="node.y - 11"
                text-anchor="middle"
                :fill="node.isCurrent ? '#00ffff' : '#7aa'"
                font-size="9"
                font-family="Consolas, monospace"
              >{{ node.name }}</text>
              <!-- 价格 -->
              <text :x="node.x" :y="node.y + 15"
                text-anchor="middle"
                :fill="node.pct >= 0 ? '#ff6478' : '#00e0a0'"
                font-size="8"
                font-family="Consolas, monospace"
                font-weight="500"
              >{{ node.price.toFixed(2) }} {{ node.pct >= 0 ? '+' : '' }}{{ node.pct.toFixed(1) }}%</text>
            </g>

            <!-- 蜘蛛身体 -->
            <g class="spider-body-sm" :class="{ crawling: running }">
              <circle cx="180" cy="140" r="26" fill="#00d4ff" opacity="0.06" />
              <circle cx="180" cy="140" r="20" fill="#00d4ff" opacity="0.1" />
              <circle cx="180" cy="140" r="14" fill="#00d4ff" opacity="0.18" />
              <ellipse cx="180" cy="140" rx="13" ry="11"
                fill="#0a1628" stroke="#00d4ff" stroke-width="1.2"
                filter="url(#glow-card)" />
              <rect x="173" y="134" width="14" height="12" fill="#004466" rx="1.5" />
              <line x1="176" y1="137" x2="184" y2="137" stroke="#00d4ff" stroke-width="0.8" opacity="0.8" />
              <line x1="176" y1="140" x2="184" y2="140" stroke="#00d4ff" stroke-width="0.8" opacity="0.6" />
              <line x1="176" y1="143" x2="184" y2="143" stroke="#00d4ff" stroke-width="0.8" opacity="0.4" />
              <circle cx="180" cy="140" r="3" fill="#fff" class="core-eye-sm">
                <animate attributeName="opacity" values="1;0.6;1" dur="2s" repeatCount="indefinite" />
              </circle>
              <circle cx="180" cy="140" r="1.5" fill="#ff5096" />
            </g>

            <text v-if="!stockNodes.length" x="180" y="140" text-anchor="middle"
              fill="#4a5a52" font-size="12">
              等待自选股数据...
            </text>
          </svg>
        </div>
      </div>

      <!-- 右栏：指标面板 -->
      <div class="sb-side">
        <!-- 策略 & 绩效 -->
        <div class="sb-panel">
          <div class="sb-panel-head" @click="showStrategyMenu = !showStrategyMenu">
            <span class="sb-panel-title">🎯 策略</span>
            <span class="sb-panel-strategy">
              {{ engine.strategyNames[engine.currentStrategy.value] }}
              <span class="sb-chevron">▾</span>
            </span>
          </div>
          <div v-if="showStrategyMenu" class="sb-strategy-menu">
            <button
              v-for="(label, key) in engine.strategyNames"
              :key="key"
              class="sb-strategy-item"
              :class="{ active: engine.currentStrategy.value === key }"
              @click="selectStrategy(key as any)"
            >
              {{ label }}
            </button>
          </div>
          <div class="sb-perf-grid">
            <div class="sb-perf-item">
              <div class="sb-perf-label">收益率</div>
              <div class="sb-perf-value" :class="perfColor(perfData.totalReturnPct)">
                {{ perfData.totalReturnPct >= 0 ? '+' : '' }}{{ perfData.totalReturnPct.toFixed(2) }}%
              </div>
            </div>
            <div class="sb-perf-item">
              <div class="sb-perf-label">交易次数</div>
              <div class="sb-perf-value neutral">{{ perfData.totalTrades }}</div>
            </div>
            <div class="sb-perf-item">
              <div class="sb-perf-label">胜率</div>
              <div class="sb-perf-value neutral">{{ perfData.winRate.toFixed(1) }}%</div>
            </div>
            <div class="sb-perf-item">
              <div class="sb-perf-label">最大回撤</div>
              <div class="sb-perf-value down">-{{ perfData.maxDrawdownPct.toFixed(2) }}%</div>
            </div>
          </div>
        </div>

        <!-- 市场情绪 -->
        <div class="sb-panel">
          <div class="sb-panel-head">
            <span class="sb-panel-title">🔥 市场情绪</span>
            <span class="sb-sentiment-tag" :class="sentimentLevelClass">
              {{ sentimentLevelText }}
            </span>
          </div>
          <div class="sb-sentiment-bar">
            <div class="sb-sentiment-track">
              <div
                class="sb-sentiment-fill"
                :class="sentimentLevelClass"
                :style="{ width: Math.min(100, sentiment.limitUp) + '%' }"
              ></div>
            </div>
            <span class="sb-sentiment-num">{{ sentiment.limitUp }}家</span>
          </div>
          <div class="sb-sentiment-stats">
            <span>涨停 <b>{{ sentiment.limitUp }}</b></span>
            <span>跌停 <b>{{ sentiment.limitDown }}</b></span>
            <span>炸板率 <b>{{ (sentiment.bombRate * 100).toFixed(0) }}%</b></span>
          </div>
          <div class="sb-sentiment-board">
            最高连板: <b>{{ sentiment.maxBoard }} 板</b>
          </div>
        </div>

        <!-- 风控 -->
        <div class="sb-panel">
          <div class="sb-panel-head">
            <span class="sb-panel-title">🛡️ 风控</span>
          </div>
          <div class="sb-risk-position">
            <div class="sb-risk-label">
              <span>持仓</span>
              <b>{{ riskData.positionCount }}/{{ riskData.maxPositions }}</b>
            </div>
            <div class="sb-risk-bar">
              <div class="sb-risk-fill" :style="{ width: riskData.positionPct + '%' }"></div>
            </div>
          </div>
          <div class="sb-risk-row">
            <span class="sb-risk-k">今日盈亏</span>
            <span class="sb-risk-v" :class="perfColor(riskData.todayPnlPct)">
              {{ riskData.todayPnlPct >= 0 ? '+' : '' }}{{ riskData.todayPnlPct.toFixed(2) }}%
            </span>
          </div>
          <div class="sb-risk-row">
            <span class="sb-risk-k">止盈 / 止损</span>
            <span class="sb-risk-v">{{ riskData.takeProfitPct }}% / {{ riskData.stopLossPct }}%</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 智能日志中心 ========== -->
    <div class="sb-log-section">
      <div class="sb-log-head">
        <div class="sb-log-title">
          <span class="sb-log-icon">📡</span>
          <span>智能日志中心</span>
          <span class="sb-log-count">{{ logEntries.length }} 条</span>
        </div>
        <div class="sb-log-tools">
          <span v-if="!autoScroll" class="sb-log-paused">⏸ 已暂停</span>
          <button class="sb-log-more" @click="showLogMenu = !showLogMenu">⋯</button>
          <span v-if="copyTip" class="sb-log-copytip">{{ copyTip }}</span>
          <div v-if="showLogMenu" class="sb-log-menu">
            <button @click="copyLogs">📋 复制全部日志</button>
            <button @click="clearLogs">🗑️ 清空日志</button>
          </div>
        </div>
      </div>

      <!-- 分类 Tab -->
      <div class="sb-log-tabs">
        <button
          v-for="tab in logTabs"
          :key="tab.key"
          class="sb-log-tab"
          :class="{ active: activeLogTab === tab.key, 'has-new': logCounts[tab.key] > 0 && activeLogTab !== tab.key }"
          @click="activeLogTab = tab.key; autoScroll = true"
        >
          <span class="sb-tab-icon">{{ tab.icon }}</span>
          <span class="sb-tab-name">{{ tab.name }}</span>
          <span class="sb-tab-badge" v-if="logCounts[tab.key] > 0">{{ logCounts[tab.key] }}</span>
        </button>
      </div>

      <!-- 日志列表 -->
      <div
        ref="logListRef"
        class="sb-log-list"
        @scroll="onLogScroll"
      >
        <div
          v-for="log in filteredLogs"
          :key="log.id"
          class="sb-log-item"
          :class="[log.category, log.level, { new: log.isNew, expanded: (log as any).expanded }]"
          @click="toggleLogExpand(log.id)"
        >
          <div class="sb-log-left">
            <div class="sb-log-icon-badge" :class="log.category">
              {{ log.icon }}
            </div>
          </div>
          <div class="sb-log-body">
            <div class="sb-log-main">
              <span class="sb-log-time">{{ log.time }}</span>
              <span class="sb-log-title-text">{{ log.title }}</span>
            </div>
            <div v-if="log.subtitle" class="sb-log-subtitle">{{ log.subtitle }}</div>
            <div v-if="(log as any).expanded && log.detail" class="sb-log-detail">
              {{ log.detail }}
            </div>
            <div v-if="(log as any).expanded && log.signals && log.signals.length" class="sb-log-signals">
              <span v-for="(s, i) in log.signals" :key="i" class="sb-signal-tag">{{ s }}</span>
            </div>
          </div>
          <div v-if="log.detail || log.signals" class="sb-log-expand-icon">
            {{ (log as any).expanded ? '▴' : '▾' }}
          </div>
        </div>

        <div v-if="!filteredLogs.length" class="sb-log-empty">
          暂无日志
        </div>
      </div>
    </div>

    <!-- ========== 底部数据源标签 ========== -->
    <div class="sb-sources">
      <div
        v-for="src in dataSources"
        :key="src.key"
        class="sb-source-tag"
        :class="{
          enabled: src.enabled,
          active: running && currentCard === src.key
        }"
      >
        <span class="sb-source-icon">{{ src.icon }}</span>
        <span class="sb-source-name">{{ src.name }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.spider-bot {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: linear-gradient(180deg, var(--bg, #0a0f0d) 0%, var(--bg-card, #0d1412) 100%);
  color: var(--text, #e6edf3);
  font-size: 12px;
  gap: 8px;
  overflow: hidden;
  padding: 10px;
  box-sizing: border-box;

  /* 主题变量映射：跟随全局配色主题
     主色 = --accent（金色/蓝色等）
     次色 = --accent-2（更亮的主色）
     青色（科技感）单独保留，但也会跟随主题色变化
  */
  --sb-gold: var(--accent, #e8c878);
  --sb-gold-2: var(--accent-2, #f0d69a);
  --sb-cyan: var(--accent-2, #00e8d8);
  --sb-bg: var(--bg-panel, #0d1412);
  --sb-bg2: var(--bg-card, #0a0f0d);
  --sb-border: var(--border, rgba(232, 200, 120, 0.4));
  --sb-text: var(--text, #e6edf3);
  --sb-text-dim: var(--text-dim, #9fb3aa);
  --sb-text-muted: var(--text-dim, #6a7a72);
  --sb-hover: var(--bg-hover, #1a2a24);
}

/* ========== 顶部控制栏 ========== */
.sb-header {
  flex: none;
  background: linear-gradient(180deg, var(--sb-bg2, rgba(18, 14, 8, 0.95)) 0%, var(--sb-bg, rgba(12, 10, 6, 0.92)) 100%);
  border: 1px solid var(--sb-border, rgba(212, 175, 55, 0.35));
  border-radius: 8px;
  padding: 8px 10px;
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--sb-gold, #ffd76a) 8%, transparent);
}

.sb-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
}

.sb-title {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sb-title-icon {
  font-size: 16px;
  filter: drop-shadow(0 0 4px rgba(0, 232, 216, 0.6));
}

.sb-title-text {
  font-weight: 700;
  font-size: 14px;
  color: var(--sb-cyan, #00e8d8);
  text-shadow: 0 0 8px color-mix(in srgb, var(--sb-cyan, #00e8d8) 40%, transparent);
  letter-spacing: 0.5px;
}

.sb-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sb-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 5px;
  border: 1px solid rgba(212, 175, 55, 0.3);
  background: linear-gradient(180deg, rgba(30, 25, 15, 0.8) 0%, rgba(20, 16, 10, 0.8) 100%);
  color: #c8b98a;
  cursor: pointer;
  font-size: 11px;
  transition: all 0.2s ease;
  font-weight: 500;
}

.sb-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sb-btn-main {
  border-color: rgba(38, 208, 124, 0.5);
  background: linear-gradient(180deg, rgba(10, 40, 25, 0.8) 0%, rgba(8, 30, 20, 0.8) 100%);
  color: #26d07c;
  font-weight: 600;
}
.sb-btn-main:hover:not(:disabled) {
  border-color: rgba(38, 208, 124, 0.8);
  box-shadow: 0 0 10px rgba(38, 208, 124, 0.25);
}
.sb-btn-main.on {
  border-color: rgba(242, 54, 69, 0.6);
  background: linear-gradient(180deg, rgba(50, 15, 20, 0.8) 0%, rgba(35, 10, 15, 0.8) 100%);
  color: #ff6b78;
}
.sb-btn-main.on:hover:not(:disabled) {
  box-shadow: 0 0 10px rgba(242, 54, 69, 0.3);
}

.sb-btn-semi {
  position: relative;
}
.sb-btn-semi .sb-btn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6a5f42;
  transition: all 0.3s;
}
.sb-btn-semi.on {
  border-color: rgba(255, 183, 61, 0.7);
  background: linear-gradient(180deg, rgba(60, 40, 15, 0.8) 0%, rgba(40, 26, 10, 0.8) 100%);
  color: #ffb13d;
  box-shadow: 0 0 8px rgba(255, 183, 61, 0.2);
}
.sb-btn-semi.on .sb-btn-dot {
  background: #ffb13d;
  box-shadow: 0 0 6px #ffb13d;
}

.sb-btn-full {
  position: relative;
}
.sb-btn-full .sb-btn-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6a5f42;
  transition: all 0.3s;
}
.sb-btn-full.on {
  border-color: rgba(255, 80, 150, 0.7);
  background: linear-gradient(180deg, rgba(60, 15, 40, 0.8) 0%, rgba(40, 10, 26, 0.8) 100%);
  color: #ff6ba8;
  box-shadow: 0 0 8px rgba(255, 80, 150, 0.25);
}
.sb-btn-full.on .sb-btn-dot {
  background: #ff5096;
  box-shadow: 0 0 6px #ff5096;
}

.sb-btn-state {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  color: #8a7e5a;
  font-family: Consolas, monospace;
}
.sb-btn-semi.on .sb-btn-state {
  background: rgba(255, 183, 61, 0.15);
  color: #ffb13d;
}
.sb-btn-full.on .sb-btn-state {
  background: rgba(255, 80, 150, 0.15);
  color: #ff6ba8;
}

.sb-btn-danger {
  border-color: rgba(242, 54, 69, 0.5);
  background: linear-gradient(180deg, rgba(50, 10, 15, 0.7) 0%, rgba(35, 8, 12, 0.7) 100%);
  color: #ff6b78;
}
.sb-btn-danger:hover:not(:disabled) {
  border-color: rgba(242, 54, 69, 0.8);
  box-shadow: 0 0 10px rgba(242, 54, 69, 0.3);
}

/* 状态行 */
.sb-status-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 5px;
  border: 1px solid rgba(212, 175, 55, 0.15);
}

.sb-status-idle {
  justify-content: center;
  padding: 6px 8px;
}

.sb-idle-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #5a5a5a;
  margin-right: 6px;
}

.sb-idle-text {
  color: #6a7a72;
  font-size: 11px;
}

.sb-status-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
}

.sb-status-label {
  color: #6a7a72;
}

.sb-status-value {
  color: #c8b98a;
  font-weight: 500;
}

.sb-val-accent {
  color: #00e8d8;
  font-weight: 600;
}

.sb-val-num {
  font-family: Consolas, monospace;
  color: #ffd76a;
}

.sb-status-link {
  color: #00e8d8;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
}
.sb-status-link:hover {
  text-decoration-style: solid;
}

.sb-status-divider {
  width: 1px;
  height: 14px;
  background: linear-gradient(180deg, transparent 0%, rgba(212, 175, 55, 0.3) 50%, transparent 100%);
}

/* ========== 中部主区 ========== */
.sb-main {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 8px;
}

/* 左栏：蜘蛛舞台 */
.sb-stage {
  flex: 1.2;
  min-width: 0;
  background: linear-gradient(180deg, rgba(10, 18, 16, 0.9) 0%, rgba(8, 14, 12, 0.9) 100%);
  border: 1px solid rgba(0, 232, 216, 0.2);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: inset 0 1px 0 rgba(0, 232, 216, 0.06);
}

.sb-stage-title {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 11px;
  color: #00e8d8;
  font-weight: 600;
  border-bottom: 1px solid rgba(0, 232, 216, 0.12);
  letter-spacing: 0.3px;
}

.sb-stage-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #3a5a52;
}
.sb-stage-dot.active {
  background: #00e8d8;
  box-shadow: 0 0 6px #00e8d8;
  animation: dotPulse 1.5s ease-in-out infinite;
}
@keyframes dotPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(0.8); }
}

.spider-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
}

.spider-svg {
  width: 100%;
  height: 100%;
}

/* 蜘蛛身体动画（小尺寸） */
.spider-body-sm.crawling {
  animation: bodyBreathSm 2s ease-in-out infinite;
  transform-origin: center;
}
@keyframes bodyBreathSm {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}

.core-eye-sm {
  filter: drop-shadow(0 0 3px #fff);
}

.node-pulse-sm {
  animation: nodePulseSm 1.2s ease-in-out infinite;
}
@keyframes nodePulseSm {
  0%, 100% { r: 5; }
  50% { r: 6.5; }
}

.pulse-ring-sm {
  animation: pulseRingSm 1.5s ease-out infinite;
  transform-origin: center;
}
@keyframes pulseRingSm {
  0% { r: 10; opacity: 0.25; }
  100% { r: 22; opacity: 0; }
}

.scan-beam-sm {
  animation: scanBeamSm 1.5s ease-in-out infinite;
}
@keyframes scanBeamSm {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 0.65; }
}

/* 右栏 */
.sb-side {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sb-panel {
  background: linear-gradient(180deg, rgba(18, 14, 8, 0.9) 0%, rgba(12, 10, 6, 0.88) 100%);
  border: 1px solid rgba(212, 175, 55, 0.25);
  border-radius: 7px;
  padding: 8px 10px;
  box-shadow: inset 0 1px 0 rgba(255, 215, 100, 0.05);
}

.sb-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(212, 175, 55, 0.12);
  cursor: pointer;
}

.sb-panel-title {
  font-size: 11px;
  font-weight: 600;
  color: #ffd76a;
  letter-spacing: 0.3px;
}

.sb-panel-strategy {
  font-size: 11px;
  color: #00e8d8;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 3px;
}

.sb-chevron {
  font-size: 9px;
  opacity: 0.7;
}

.sb-strategy-menu {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(212, 175, 55, 0.1);
}

.sb-strategy-item {
  padding: 5px 8px;
  border-radius: 4px;
  border: 1px solid rgba(212, 175, 55, 0.2);
  background: rgba(30, 25, 15, 0.5);
  color: #b8a878;
  cursor: pointer;
  font-size: 10.5px;
  text-align: left;
  transition: all 0.2s;
}
.sb-strategy-item:hover {
  border-color: rgba(212, 175, 55, 0.5);
  color: #ffd76a;
}
.sb-strategy-item.active {
  border-color: rgba(0, 232, 216, 0.5);
  background: rgba(0, 60, 55, 0.4);
  color: #00e8d8;
}

/* 绩效网格 */
.sb-perf-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.sb-perf-item {
  text-align: center;
  padding: 4px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 5px;
  border: 1px solid rgba(212, 175, 55, 0.08);
}

.sb-perf-label {
  font-size: 9.5px;
  color: #7a6f52;
  margin-bottom: 2px;
}

.sb-perf-value {
  font-size: 14px;
  font-weight: 700;
  font-family: Consolas, monospace;
}
.sb-perf-value.up { color: #ff6478; }
.sb-perf-value.down { color: #00e8a0; }
.sb-perf-value.neutral { color: #ffd76a; }

/* 市场情绪 */
.sb-sentiment-tag {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 8px;
  font-weight: 600;
}
.sb-sentiment-tag.hot {
  background: rgba(255, 100, 120, 0.15);
  color: #ff6478;
  border: 1px solid rgba(255, 100, 120, 0.3);
}
.sb-sentiment-tag.neutral {
  background: rgba(255, 183, 61, 0.15);
  color: #ffb13d;
  border: 1px solid rgba(255, 183, 61, 0.3);
}
.sb-sentiment-tag.cold {
  background: rgba(0, 232, 160, 0.12);
  color: #00e8a0;
  border: 1px solid rgba(0, 232, 160, 0.3);
}

.sb-sentiment-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.sb-sentiment-track {
  flex: 1;
  height: 14px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 7px;
  overflow: hidden;
  border: 1px solid rgba(212, 175, 55, 0.1);
}

.sb-sentiment-fill {
  height: 100%;
  border-radius: 7px;
  transition: width 0.5s ease;
  background: linear-gradient(90deg, rgba(255,183,61,0.6), rgba(255,100,120,0.8));
}
.sb-sentiment-fill.hot {
  background: linear-gradient(90deg, rgba(255,100,120,0.5), rgba(255,80,150,0.85));
}
.sb-sentiment-fill.neutral {
  background: linear-gradient(90deg, rgba(255,183,61,0.5), rgba(255,215,106,0.8));
}
.sb-sentiment-fill.cold {
  background: linear-gradient(90deg, rgba(0,232,160,0.5), rgba(0,232,216,0.8));
}

.sb-sentiment-num {
  font-size: 11px;
  font-weight: 600;
  color: #ffd76a;
  font-family: Consolas, monospace;
  min-width: 36px;
  text-align: right;
}

.sb-sentiment-stats {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #7a6f52;
  margin-bottom: 4px;
}
.sb-sentiment-stats b {
  color: #c8b98a;
  font-weight: 600;
}

.sb-sentiment-board {
  font-size: 10px;
  color: #7a6f52;
  text-align: center;
  padding-top: 4px;
  border-top: 1px solid rgba(212, 175, 55, 0.08);
}
.sb-sentiment-board b {
  color: #ff5096;
  font-weight: 700;
}

/* 风控 */
.sb-risk-position {
  margin-bottom: 6px;
}

.sb-risk-label {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: #7a6f52;
  margin-bottom: 3px;
}
.sb-risk-label b {
  color: #ffd76a;
  font-family: Consolas, monospace;
  font-weight: 600;
}

.sb-risk-bar {
  height: 8px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid rgba(212, 175, 55, 0.1);
}

.sb-risk-fill {
  height: 100%;
  background: linear-gradient(90deg, rgba(0, 232, 216, 0.6), rgba(0, 232, 160, 0.85));
  border-radius: 4px;
  transition: width 0.4s ease;
}

.sb-risk-row {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #7a6f52;
  padding: 3px 0;
}

.sb-risk-v {
  font-family: Consolas, monospace;
  font-weight: 500;
}
.sb-risk-v.up { color: #ff6478; }
.sb-risk-v.down { color: #00e8a0; }

/* ========== 日志中心 ========== */
.sb-log-section {
  flex: none;
  height: 42%;
  min-height: 150px;
  background: linear-gradient(180deg, rgba(18, 14, 8, 0.95) 0%, rgba(12, 10, 6, 0.92) 100%);
  border: 1px solid rgba(212, 175, 55, 0.3);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: inset 0 1px 0 rgba(255, 215, 100, 0.06);
}

.sb-log-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(212, 175, 55, 0.15);
}

.sb-log-title {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  font-weight: 600;
  color: #ffd76a;
  letter-spacing: 0.3px;
}

.sb-log-icon {
  font-size: 13px;
}

.sb-log-count {
  font-size: 10px;
  color: #7a6f52;
  font-weight: 400;
  margin-left: 4px;
  font-family: Consolas, monospace;
}

.sb-log-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  position: relative;
}

.sb-log-paused {
  font-size: 10px;
  color: #ffb13d;
}

.sb-log-copytip {
  font-size: 10px;
  color: #4ade80;
  white-space: nowrap;
}

.sb-log-more {
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: #7a6f52;
  cursor: pointer;
  font-size: 14px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sb-log-more:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #c8b98a;
}

.sb-log-menu {
  position: absolute;
  top: 24px;
  right: 0;
  background: rgba(18, 14, 8, 0.98);
  border: 1px solid rgba(212, 175, 55, 0.3);
  border-radius: 6px;
  padding: 4px;
  z-index: 10;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.sb-log-menu button {
  display: block;
  width: 100%;
  padding: 5px 10px;
  background: transparent;
  border: none;
  color: #c8b98a;
  cursor: pointer;
  font-size: 11px;
  text-align: left;
  border-radius: 4px;
  white-space: nowrap;
}
.sb-log-menu button:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #ff6b78;
}

/* 日志 Tab */
.sb-log-tabs {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 4px 6px;
  border-bottom: 1px solid rgba(212, 175, 55, 0.1);
  overflow-x: auto;
}

.sb-log-tab {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px 8px;
  border: none;
  background: transparent;
  color: #7a6f52;
  cursor: pointer;
  font-size: 10.5px;
  border-radius: 4px;
  white-space: nowrap;
  transition: all 0.15s;
  flex-shrink: 0;
}

.sb-log-tab:hover {
  background: rgba(255, 255, 255, 0.04);
  color: #b8a878;
}

.sb-log-tab.active {
  background: rgba(255, 215, 106, 0.1);
  color: #ffd76a;
  font-weight: 600;
}

.sb-tab-icon {
  font-size: 11px;
}

.sb-tab-badge {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: #8a7e5a;
  font-family: Consolas, monospace;
  min-width: 12px;
  text-align: center;
}
.sb-log-tab.active .sb-tab-badge {
  background: rgba(255, 215, 106, 0.15);
  color: #ffd76a;
}

.sb-log-tab.has-new .sb-tab-badge {
  animation: badgeBounce 0.4s ease;
}
@keyframes badgeBounce {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.2); }
}

/* 日志列表 */
.sb-log-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 6px;
  scroll-behavior: smooth;
}

.sb-log-item {
  display: flex;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.15s;
  border-left: 2px solid transparent;
  margin-bottom: 2px;
}

.sb-log-item:hover {
  background: rgba(255, 255, 255, 0.03);
}

.sb-log-item.new {
  animation: logFlash 0.8s ease;
}
@keyframes logFlash {
  0% { background: rgba(255, 215, 106, 0.2); }
  100% { background: transparent; }
}

/* 左侧图标条 */
.sb-log-left {
  flex: none;
  display: flex;
  align-items: flex-start;
  padding-top: 1px;
}

.sb-log-icon-badge {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.05);
  flex-shrink: 0;
}

.sb-log-item.scan .sb-log-icon-badge {
  background: rgba(0, 232, 216, 0.12);
  color: #00e8d8;
  border: 1px solid rgba(0, 232, 216, 0.25);
}
.sb-log-item.scan {
  border-left-color: rgba(0, 232, 216, 0.4);
}

.sb-log-item.signal .sb-log-icon-badge {
  background: rgba(255, 80, 150, 0.12);
  color: #ff5096;
  border: 1px solid rgba(255, 80, 150, 0.25);
}
.sb-log-item.signal {
  border-left-color: rgba(255, 80, 150, 0.4);
}

.sb-log-item.trade .sb-log-icon-badge {
  background: rgba(255, 215, 106, 0.12);
  color: #ffd76a;
  border: 1px solid rgba(255, 215, 106, 0.25);
}
.sb-log-item.trade {
  border-left-color: rgba(255, 215, 106, 0.4);
}

.sb-log-item.risk .sb-log-icon-badge {
  background: rgba(255, 183, 61, 0.12);
  color: #ffb13d;
  border: 1px solid rgba(255, 183, 61, 0.25);
}
.sb-log-item.risk {
  border-left-color: rgba(255, 183, 61, 0.4);
}

.sb-log-item.system .sb-log-icon-badge {
  background: rgba(150, 170, 180, 0.12);
  color: #9fb3aa;
  border: 1px solid rgba(150, 170, 180, 0.25);
}
.sb-log-item.system {
  border-left-color: rgba(150, 170, 180, 0.4);
}

/* 日志主体 */
.sb-log-body {
  flex: 1;
  min-width: 0;
}

.sb-log-main {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

.sb-log-time {
  font-size: 10px;
  color: #5a5242;
  font-family: Consolas, monospace;
  flex-shrink: 0;
}

.sb-log-title-text {
  font-size: 11px;
  color: #c8d4ce;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-log-item.success .sb-log-title-text {
  color: #00e8a0;
}
.sb-log-item.warn .sb-log-title-text {
  color: #ffb13d;
}
.sb-log-item.error .sb-log-title-text {
  color: #ff6478;
}

.sb-log-subtitle {
  font-size: 10px;
  color: #7a7262;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-log-detail {
  font-size: 10px;
  color: #9fb3aa;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  line-height: 1.5;
}

.sb-log-signals {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.sb-signal-tag {
  font-size: 9.5px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(255, 80, 150, 0.12);
  color: #ff6ba8;
  border: 1px solid rgba(255, 80, 150, 0.2);
}

.sb-log-expand-icon {
  flex-shrink: 0;
  color: #5a5242;
  font-size: 9px;
  align-self: center;
}

.sb-log-empty {
  text-align: center;
  padding: 20px;
  color: #4a5a52;
  font-size: 11px;
}

/* 滚动条 */
.sb-log-list::-webkit-scrollbar {
  width: 4px;
}
.sb-log-list::-webkit-scrollbar-track {
  background: transparent;
}
.sb-log-list::-webkit-scrollbar-thumb {
  background: rgba(212, 175, 55, 0.25);
  border-radius: 2px;
}
.sb-log-list::-webkit-scrollbar-thumb:hover {
  background: rgba(212, 175, 55, 0.45);
}

.sb-log-tabs::-webkit-scrollbar {
  height: 2px;
}
.sb-log-tabs::-webkit-scrollbar-thumb {
  background: rgba(212, 175, 55, 0.2);
  border-radius: 1px;
}

/* ========== 底部数据源 ========== */
.sb-sources {
  flex: none;
  display: flex;
  gap: 4px;
  overflow-x: auto;
  padding: 2px 4px;
}

.sb-source-tag {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px 8px;
  border-radius: 5px;
  font-size: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(212, 175, 55, 0.1);
  color: #5a5242;
  opacity: 0.5;
  transition: all 0.2s;
}

.sb-source-tag.enabled {
  opacity: 1;
  color: #b8a878;
  border-color: rgba(212, 175, 55, 0.25);
  background: rgba(30, 25, 15, 0.4);
}

.sb-source-tag.active {
  color: #00e8d8;
  border-color: rgba(0, 232, 216, 0.5);
  background: rgba(0, 60, 55, 0.3);
  box-shadow: 0 0 8px rgba(0, 232, 216, 0.15);
  animation: sourcePulse 2s ease-in-out infinite;
}
@keyframes sourcePulse {
  0%, 100% { box-shadow: 0 0 6px rgba(0, 232, 216, 0.15); }
  50% { box-shadow: 0 0 12px rgba(0, 232, 216, 0.3); }
}

.sb-source-icon {
  font-size: 11px;
}

.sb-sources::-webkit-scrollbar {
  height: 2px;
}
.sb-sources::-webkit-scrollbar-thumb {
  background: rgba(212, 175, 55, 0.2);
  border-radius: 1px;
}
/* ===== 选择器自检角标 ===== */
.selector-warn-badge {
  position: absolute;
  top: 10px;
  right: 12px;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 700;
  color: #ffd6d6;
  background: rgba(60, 12, 16, 0.82);
  border: 1px solid rgba(255, 86, 86, 0.6);
  box-shadow: 0 0 12px rgba(255, 60, 60, 0.35);
  cursor: pointer;
}
.selector-warn-badge .swb-icon { font-size: 13px; }
.selector-warn-badge .swb-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 9px;
  background: #ff4d4d;
  color: #fff;
  font-size: 11px;
}
.selector-warn-badge .swb-panel {
  display: none;
  position: absolute;
  top: 30px;
  right: 0;
  width: 320px;
  max-height: 300px;
  overflow-y: auto;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(14, 17, 24, 0.97);
  border: 1px solid rgba(255, 86, 86, 0.45);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
  text-align: left;
  font-weight: 500;
  cursor: default;
}
.selector-warn-badge:hover .swb-panel,
.selector-warn-badge:focus-within .swb-panel { display: block; }
.swb-panel-title { font-size: 12px; font-weight: 700; color: #ff9a9a; margin-bottom: 8px; }
.swb-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.08);
}
.swb-card {
  align-self: flex-start;
  padding: 1px 7px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 700;
  color: #ffd6d6;
  background: rgba(255, 86, 86, 0.16);
  border: 1px solid rgba(255, 86, 86, 0.4);
}
.swb-msg { font-size: 11px; line-height: 1.5; color: rgba(255, 255, 255, 0.78); word-break: break-all; }
.swb-hint { margin-top: 8px; font-size: 11px; color: rgba(255, 255, 255, 0.5); }
</style>
