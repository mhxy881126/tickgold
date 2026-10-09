<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, onUnmounted } from "vue";
import { useWatchlistStore } from "../stores/watchlist";
import { useQuotesStore } from "../stores/quotes";
import { useSpiderBotEngine } from "../composables/useSpiderBotEngine";
import { autoexecGetConfig, autoexecStart, autoexecStop, listDecisionLogs } from "../ai/api";
import type { Quote } from "../api/types";

const emit = defineEmits<{
  select: [code: string];
  switchCard: [cardId: string];
}>();

const engine = useSpiderBotEngine();
const wl = useWatchlistStore();
const quotes = useQuotesStore();

// ===== 爬虫状态（和引擎同步） =====
const running = computed(() => engine.running.value);
const autoTrade = ref(false);
const crawlerIdx = ref(0);
const currentCard = ref("watch");

// ===== 自动交易机器人配置 =====
const aiCfg = ref<any>(null);
const aiBusy = ref(false);
let decisionTimer: number | null = null;
let lastDecisionId = 0;

async function loadAiCfg() {
  try {
    aiCfg.value = await autoexecGetConfig();
  } catch (e) {
    console.warn("加载自动交易配置失败:", e);
  }
}

// ===== 拉取决策日志 =====
async function fetchDecisionLogs() {
  try {
    const logs = await listDecisionLogs(null, 10);
    if (logs && logs.length > 0) {
      const newLogs = logs.filter(l => l.id > lastDecisionId);
      if (newLogs.length > 0) {
        lastDecisionId = Math.max(...newLogs.map(l => l.id));
        newLogs.forEach(l => {
          const actionText = l.action === "executed" ? "✅ 已执行" : l.action === "watch" ? "👀 观察" : l.action;
          addLog({
            card: "AI决策",
            action: `${l.label} ${actionText}`,
            code: l.code,
            name: l.name,
            detail: `置信度 ${(l.confidence * 100).toFixed(0)}% | ${l.mode === "cloud_llm" ? "云端大模型" : "规则脑"}`,
          });
        });
      }
    }
  } catch (e) {
    // 静默失败
  }
}

onMounted(() => {
  loadAiCfg();
});

// ===== 启动/停止 =====
async function start() {
  if (!aiCfg.value) await loadAiCfg();
  if (!aiCfg.value) return;
  
  aiBusy.value = true;
  try {
    // 启动自动交易机器人
    await autoexecStart({ ...aiCfg.value, enabled: true });
    await loadAiCfg();
    
    // 同时启动蜘蛛爬虫引擎（可视化）
    engine.start((cardId) => {
      emit("switchCard", cardId);
      // mini-stage 内嵌卡片视角无 isOpen 状态：切卡事件已交父级，按可切换处理
      return true;
    });
    
    // 启动可视化动画定时器（驱动蜘蛛爬行扫描效果）
    timer = window.setInterval(tick, filter.value.scanInterval);
    
    // 启动决策日志定时器（每3秒拉一次）
    decisionTimer = window.setInterval(fetchDecisionLogs, 3000);
  } finally {
    aiBusy.value = false;
  }
}

async function stop() {
  aiBusy.value = true;
  try {
    // 停止自动交易机器人
    await autoexecStop();
    await loadAiCfg();
    
    // 同时停止蜘蛛爬虫引擎
    engine.stop();
    
    // 停止可视化动画定时器
    if (timer) { clearInterval(timer); timer = null; }
    
    // 停止决策日志定时器
    if (decisionTimer) { clearInterval(decisionTimer); decisionTimer = null; }
  } finally {
    aiBusy.value = false;
  }
}

function emergencyStop() {
  stop();
  // 急停同时关掉全屏蜘蛛
  window.dispatchEvent(new CustomEvent("spider-overlay-stop"));
  fullscreenRunning.value = false;
}

// ===== 全屏爬行模式 =====
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

// 监听全屏蜘蛛的停止事件（比如用户在顶栏点了停止）
function onFullscreenStopped() {
  fullscreenRunning.value = false;
}
function onFullscreenStarted() {
  fullscreenRunning.value = true;
}

onMounted(() => {
  loadAiCfg();
  window.addEventListener("spider-overlay-stopped", onFullscreenStopped);
  window.addEventListener("spider-overlay-started", onFullscreenStarted);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  window.removeEventListener("spider-overlay-stopped", onFullscreenStopped);
  window.removeEventListener("spider-overlay-started", onFullscreenStarted);
});

// ===== 要扫描的卡片列表（按顺序） =====
const scanCards = [
  { id: "watch", name: "自选股", icon: "📋" },
  { id: "chart", name: "K线图", icon: "📈" },
  { id: "radar", name: "涨停雷达", icon: "🚀" },
  { id: "sector", name: "板块", icon: "🏭" },
  { id: "rank", name: "涨幅排行", icon: "🏆" },
  { id: "trade", name: "交易", icon: "💰" },
];

// ===== 抓取日志 =====
interface CrawlLog {
  time: string;
  card: string;
  action: string;
  code?: string;
  name?: string;
  price?: number;
  pct?: number;
  detail?: string;
}
const crawlLog = ref<CrawlLog[]>([]);

// ===== 交易日志 =====
interface TradeLog {
  time: string;
  code: string;
  name: string;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  reason: string;
}
const tradeLog = ref<TradeLog[]>([]);

// ===== 风控 =====
const positionCount = ref(0);
const scanStep = ref(0); // 当前扫描到第几步

// ===== 筛选规则 =====
const filter = ref({
  minPct: 2,
  maxPct: 9.8,
  minAmount: 1e8,
  scanInterval: 2000, // 每 2 秒扫描一步
});

let timer: number | null = null;

function addLog(log: Omit<CrawlLog, "time">) {
  const now = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  crawlLog.value.unshift({ time: now, ...log });
  if (crawlLog.value.length > 50) crawlLog.value.pop();
}

function tick() {
  const step = scanStep.value;
  const cardIdx = step % scanCards.length;
  const card = scanCards[cardIdx];
  currentCard.value = card.id;

  // 1. 自动切换到当前卡片
  emit("switchCard", card.id);
  addLog({
    card: card.name,
    action: "🔄 切换卡片",
    detail: `正在扫描 ${card.name}`,
  });

  // 2. 根据卡片类型抓取数据
  switch (card.id) {
    case "watch":
      scanWatchlist();
      break;
    case "chart":
      scanChart();
      break;
    case "radar":
      scanRadar();
      break;
    case "trade":
      scanTrade();
      break;
    default:
      scanGeneric(card.name);
  }

  scanStep.value++;
}

// 扫描自选股
function scanWatchlist() {
  const list = wl.currentStocks;
  if (!list.length) return;

  const idx = crawlerIdx.value % list.length;
  crawlerIdx.value = idx;
  const s = list[idx];
  const q: Quote | undefined = quotes.map[s.code];

  if (!q) return;

  const action = evaluate(q);
  addLog({
    card: "自选股",
    action: action.startsWith("BUY") ? "🟢 发现买入信号" : action.startsWith("SELL") ? "🔴 发现卖出信号" : "👁 扫描中",
    code: s.code,
    name: q.name || s.name,
    price: q.price,
    pct: q.pct,
    detail: `${q.pct.toFixed(2)}% 成交额${(q.amount / 1e8).toFixed(2)}亿`,
  });

  // 触发交易
  if (autoTrade.value && action.startsWith("BUY")) {
    executeBuy(s.code, q, action);
  }

  crawlerIdx.value++;
}

// 扫描 K线图
function scanChart() {
  const list = wl.currentStocks;
  if (!list.length) return;
  const s = list[crawlerIdx.value % list.length];
  const q = quotes.map[s.code];
  if (q) {
    addLog({
      card: "K线图",
      action: "📈 分析K线",
      code: s.code,
      name: q.name || s.name,
      price: q.price,
      pct: q.pct,
      detail: `MA5/MA10/MA20 趋势分析`,
    });
  }
}

// 扫描涨停雷达
function scanRadar() {
  addLog({
    card: "涨停雷达",
    action: "🚀 扫描涨停",
    detail: "监控连板梯队/炸板率/情绪指标",
  });
}

// 扫描交易面板
function scanTrade() {
  addLog({
    card: "交易",
    action: "💰 检查仓位",
    detail: `当前仓位 ${positionCount} 只`,
  });
}

// 通用扫描
function scanGeneric(cardName: string) {
  addLog({
    card: cardName,
    action: "👁 扫描中",
    detail: `正在抓取 ${cardName} 数据`,
  });
}

// 评估股票
function evaluate(q: Quote): string {
  const f = filter.value;
  if (q.pct >= f.maxPct) return "HOLD 涨停不追";
  if (q.pct >= f.minPct && q.amount >= f.minAmount) return "BUY 放量上涨";
  if (q.pct <= -3) return "SELL 跌破止损";
  return "SCAN";
}

// 执行买入
function executeBuy(code: string, q: Quote, reason: string) {
  const now = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  tradeLog.value.unshift({
    time: now,
    code,
    name: q.name || code,
    side: "BUY",
    price: q.price,
    qty: 100,
    reason,
  });
  positionCount.value++;
  emit("select", code);
  addLog({
    card: "交易",
    action: "✅ 自动买入",
    code,
    name: q.name || code,
    price: q.price,
    pct: q.pct,
    detail: `买入 100 股 @ ${q.price.toFixed(2)}`,
  });
}

onUnmounted(() => { if (timer) clearInterval(timer); });

// ===== 蜘蛛节点布局 =====
const stockNodes = computed(() => {
  const list = wl.currentStocks;
  const bodyX = 300, bodyY = 200;
  const nodes: {
    x: number; y: number;
    code: string; name: string;
    price: number; pct: number;
    isCurrent: boolean;
    legPath: string;
  }[] = [];

  list.forEach((s, i) => {
    const q = quotes.map[s.code];
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const x = bodyX + side * (160 + (i % 3) * 25);
    const y = bodyY - 100 + row * 55;

    const legPath = makeLegPath(bodyX, bodyY, x, y, i);

    nodes.push({
      x, y,
      code: s.code,
      name: q?.name || s.name || "",
      price: q?.price || 0,
      pct: q?.pct || 0,
      isCurrent: running.value && i === crawlerIdx.value % list.length,
      legPath,
    });
  });

  return nodes;
});

function makeLegPath(x1: number, y1: number, x2: number, y2: number, seed: number): string {
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const offset = 30 + (seed % 3) * 15;
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
</script>

<template>
  <div class="spider-bot">
    <!-- 控制栏 -->
    <div class="sb-control">
      <button class="sb-btn" :class="{ on: running }" @click="running ? stop() : start()">
        {{ running ? "⏸ 停止爬取" : "▶ 启动爬虫" }}
      </button>
      <button class="sb-btn fullscreen" @click="toggleFullscreen">
        🕷 {{ fullscreenRunning ? "退出全屏" : "全屏爬行" }}
      </button>
      <button class="sb-btn" :class="{ trade: autoTrade }" @click="autoTrade = !autoTrade">
        🤖 自动交易: {{ autoTrade ? "ON" : "OFF" }}
      </button>
      <button class="sb-btn danger" @click="emergencyStop">🛑 急停</button>
      <div class="sb-stats">
        <span class="sb-stat">仓位: <b>{{ positionCount }}</b></span>
        <span class="sb-stat">步数: <b>{{ scanStep }}</b></span>
      </div>
    </div>

    <!-- 当前状态条 -->
    <div class="sb-status" v-if="running">
      <span class="sb-status-text">
        正在扫描: <b>{{ scanCards[scanStep % scanCards.length]?.name }}</b>
      </span>
      <div class="sb-progress">
        <div class="sb-progress-bar" :style="{ width: `${(scanStep % scanCards.length) / scanCards.length * 100}%` }"></div>
      </div>
    </div>

    <!-- 蜘蛛可视化区（SVG） -->
    <div class="spider-stage">
      <svg viewBox="0 0 600 400" class="spider-svg">
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <!-- 蛛丝流动渐变 -->
          <linearGradient id="threadGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#0a8ab0" stop-opacity="0.3" />
            <stop offset="50%" stop-color="#00dcff" stop-opacity="1" />
            <stop offset="100%" stop-color="#0a8ab0" stop-opacity="0.3" />
          </linearGradient>
          <!-- 扫描光束渐变 -->
          <radialGradient id="scanBeam" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#00dcff" stop-opacity="0.4" />
            <stop offset="100%" stop-color="#00dcff" stop-opacity="0" />
          </radialGradient>
        </defs>

        <!-- 背景网格（科技感） -->
        <g opacity="0.08">
          <line v-for="i in 12" :key="'h'+i"
            :x1="0" :y1="400 / 12 * i" :x2="600" :y2="400 / 12 * i"
            stroke="#00dcff" stroke-width="0.5" />
          <line v-for="i in 18" :key="'v'+i"
            :x1="600 / 18 * i" :y1="0" :x2="600 / 18 * i" :y2="400"
            stroke="#00dcff" stroke-width="0.5" />
        </g>

        <!-- 蜘蛛腿（蛛丝） -->
        <g v-for="(node, i) in stockNodes" :key="i" class="spider-leg">
          <!-- 蛛丝底色 -->
          <path
            :d="node.legPath"
            :stroke="node.isCurrent ? '#00dcff' : '#0a4a60'"
            :stroke-width="node.isCurrent ? 2 : 1"
            fill="none"
            :opacity="node.isCurrent ? 0.8 : 0.35"
          />
          <!-- 流动光点（数据粒子） -->
          <circle
            v-for="j in 3"
            :key="'p'+j"
            r="2"
            :fill="node.isCurrent ? '#00ffff' : '#0a8ab0'"
            :opacity="node.isCurrent ? 0.9 : 0.4"
            filter="url(#glow)"
          >
            <animateMotion
              :dur="(2 + j * 0.7) + 's'"
              repeatCount="indefinite"
              :path="node.legPath"
              :begin="(j * 0.6) + 's'"
            />
          </circle>
          <!-- 当前扫描的节点：扫描光束 -->
          <circle v-if="node.isCurrent" :cx="node.x" :cy="node.y" r="30"
            fill="url(#scanBeam)" class="scan-beam" />
          <!-- 节点外光环（脉冲） -->
          <circle :cx="node.x" :cy="node.y" r="node.isCurrent ? 12 : 6"
            :fill="node.isCurrent ? '#ff5096' : '#ff88aa'"
            :opacity="node.isCurrent ? 0.2 : 0.1"
            :class="{ 'pulse-ring': node.isCurrent }"
          />
          <!-- 节点核心 -->
          <circle :cx="node.x" :cy="node.y" r="node.isCurrent ? 6 : 4"
            :fill="node.isCurrent ? '#ff5096' : '#ff88aa'"
            :opacity="node.isCurrent ? 1 : 0.7"
            filter="url(#glow)"
            :class="{ 'node-pulse': node.isCurrent }"
          />
          <!-- 节点名称 -->
          <text :x="node.x" :y="node.y - 14"
            text-anchor="middle"
            :fill="node.isCurrent ? '#00ffff' : '#7aa'"
            font-size="11"
            font-weight="node.isCurrent ? 600 : 400"
            font-family="Consolas, monospace"
          >{{ node.name }}</text>
          <!-- 价格 + 涨跌幅 -->
          <text :x="node.x" :y="node.y + 20"
            text-anchor="middle"
            :fill="node.pct >= 0 ? '#ff6464' : '#00e0a0'"
            font-size="10"
            font-family="Consolas, monospace"
            font-weight="500"
          >{{ node.price.toFixed(2) }} {{ node.pct >= 0 ? '+' : '' }}{{ node.pct.toFixed(2) }}%</text>
        </g>

        <!-- 蜘蛛身体（带呼吸脉动效果） -->
        <g class="spider-body" :class="{ crawling: running }">
          <!-- 外层光晕 -->
          <circle cx="300" cy="200" r="34" fill="#00d4ff" opacity="0.06" class="body-halo-outer" />
          <circle cx="300" cy="200" r="26" fill="#00d4ff" opacity="0.1" class="body-halo" />
          <circle cx="300" cy="200" r="18" fill="#00d4ff" opacity="0.18" class="body-halo-inner" />
          <!-- 身体外壳 -->
          <ellipse cx="300" cy="200" rx="16" ry="14"
            fill="#0a1628" stroke="#00d4ff" stroke-width="1.5"
            filter="url(#glow)" class="body-shell" />
          <!-- 内部芯片纹理 -->
          <rect x="291" y="192" width="18" height="16" fill="#004466" rx="2" />
          <line x1="295" y1="196" x2="305" y2="196" stroke="#00d4ff" stroke-width="1" opacity="0.8" />
          <line x1="295" y1="200" x2="305" y2="200" stroke="#00d4ff" stroke-width="1" opacity="0.6" />
          <line x1="295" y1="204" x2="305" y2="204" stroke="#00d4ff" stroke-width="1" opacity="0.4" />
          <!-- 中央核心（眼睛） -->
          <circle cx="300" cy="200" r="4" fill="#fff" class="core-eye">
            <animate attributeName="opacity" values="1;0.6;1" dur="2s" repeatCount="indefinite" />
          </circle>
          <circle cx="300" cy="200" r="2" fill="#ff5096" />
        </g>

        <text v-if="!stockNodes.length" x="300" y="200" text-anchor="middle"
          fill="#4a5a52" font-size="14">
          等待自选股数据...
        </text>
      </svg>
    </div>

    <!-- 日志区 -->
    <div class="sb-logs">
      <div class="sl-panel">
        <div class="sl-title">📡 抓取日志 ({{ crawlLog.length }})</div>
        <div class="sl-list">
          <div v-for="(l, i) in crawlLog" :key="i" class="sl-row"
            :class="{ buy: l.action.includes('买入') }">
            <span class="sl-time">{{ l.time }}</span>
            <span class="sl-card">{{ l.card }}</span>
            <span class="sl-act">{{ l.action }}</span>
            <span v-if="l.code" class="sl-code">{{ l.code }}</span>
            <span class="sl-detail">{{ l.detail }}</span>
          </div>
          <div v-if="!crawlLog.length" class="sl-empty">启动爬虫后显示...</div>
        </div>
      </div>
      <div class="sl-panel">
        <div class="sl-title">💰 交易日志 ({{ tradeLog.length }})</div>
        <div class="sl-list">
          <div v-for="(t, i) in tradeLog" :key="i" class="sl-row">
            <span class="sl-time">{{ t.time }}</span>
            <span class="sl-side" :class="t.side.toLowerCase()">{{ t.side }}</span>
            <span class="sl-code">{{ t.code }}</span>
            <span class="sl-price">{{ t.price.toFixed(2) }} × {{ t.qty }}</span>
          </div>
          <div v-if="!tradeLog.length" class="sl-empty">无交易记录</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.spider-bot {
  display: flex; flex-direction: column; height: 100%;
  background: #0a0f0d; color: #e6edf3; font-size: 12px;
  padding: 10px; gap: 8px; overflow: hidden;
}

/* 控制栏 */
.sb-control { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.sb-btn {
  padding: 5px 12px; border-radius: 6px; border: 1px solid #2a3a35;
  background: #14201c; color: #9fb3aa; cursor: pointer; font-size: 12px;
}
.sb-btn.on { background: #062818; color: #00ffd5; border-color: #0c6; box-shadow: 0 0 8px rgba(0,255,213,0.3); }
.sb-btn.trade { background: #281a06; color: #ffb13d; border-color: #d4a017; }
.sb-btn.danger { background: #2a0a0a; color: #f23645; border-color: #f23645; margin-left: auto; }
.sb-stats { display: flex; gap: 12px; color: #6a7a72; }
.sb-stat b { color: #e6edf3; }

/* 状态条 */
.sb-status {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 10px; background: #0d1a16; border-radius: 6px;
  border: 1px solid #1a2a24;
}
.sb-status-text { font-size: 12px; color: #9fb3aa; white-space: nowrap; }
.sb-status-text b { color: #00ffd5; }
.sb-progress { flex: 1; height: 4px; background: #1a2a24; border-radius: 2px; overflow: hidden; }
.sb-progress-bar { height: 100%; background: #00ffd5; transition: width 0.3s; }

/* 蜘蛛舞台 */
.spider-stage {
  flex: 1; min-height: 0; background: #0d1412;
  border: 1px solid #1a2a24; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  padding: 10px;
}
.spider-svg { width: 100%; height: 100%; max-height: 280px; }

/* 蜘蛛身体呼吸动画 */
.spider-body.crawling .body-shell {
  animation: bodyBreath 2s ease-in-out infinite;
}
.spider-body.crawling .body-halo {
  animation: haloPulse 2s ease-in-out infinite;
}
.spider-body.crawling .body-halo-outer {
  animation: haloPulse 2.5s ease-in-out infinite;
}
.spider-body.crawling .body-halo-inner {
  animation: haloPulse 1.5s ease-in-out infinite reverse;
}
@keyframes bodyBreath {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.06); }
}
@keyframes haloPulse {
  0%, 100% { opacity: 0.1; transform: scale(1); }
  50% { opacity: 0.25; transform: scale(1.15); }
}

/* 核心眼睛闪烁 */
.core-eye {
  filter: drop-shadow(0 0 4px #fff);
}

/* 节点脉冲动画 */
.node-pulse {
  animation: nodePulse 1.2s ease-in-out infinite;
}
@keyframes nodePulse {
  0%, 100% { r: 6; }
  50% { r: 8; }
}

/* 光环扩散 */
.pulse-ring {
  animation: pulseRing 1.5s ease-out infinite;
  transform-origin: center;
}
@keyframes pulseRing {
  0% { r: 12; opacity: 0.3; }
  100% { r: 28; opacity: 0; }
}

/* 扫描光束呼吸 */
.scan-beam {
  animation: scanBeam 1.5s ease-in-out infinite;
}
@keyframes scanBeam {
  0%, 100 { opacity: 0.4; }
  50% { opacity: 0.7; }
}

/* 日志 */
.sb-logs { display: flex; gap: 8px; height: 160px; }
.sl-panel {
  flex: 1; background: #0d1412; border: 1px solid #1a2a24;
  border-radius: 8px; padding: 6px; display: flex; flex-direction: column;
}
.sl-title { font-size: 11px; color: #6a7a72; margin-bottom: 4px; }
.sl-list { flex: 1; overflow: auto; }
.sl-row {
  display: flex; gap: 6px; padding: 2px 4px;
  font-family: Consolas, monospace; font-size: 11px;
  align-items: center;
}
.sl-row.buy { background: rgba(242,54,69,0.1); }
.sl-time { color: #4a5a52; width: 60px; flex-shrink: 0; }
.sl-card { color: #7aa; width: 60px; flex-shrink: 0; }
.sl-act { color: #c8d4ce; flex-shrink: 0; }
.sl-code { color: #9fb3aa; width: 56px; flex-shrink: 0; }
.sl-price { width: 60px; text-align: right; }
.sl-detail { color: #6a7a72; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sl-side { width: 36px; }
.sl-side.buy { color: #f23645; }
.sl-side.sell { color: #0ecb81; }
.sl-empty { color: #3a4a42; text-align: center; padding: 10px; }
</style>
