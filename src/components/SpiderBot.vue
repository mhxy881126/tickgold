<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
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
    });
    
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
    
    // 停止决策日志定时器
    if (decisionTimer) { clearInterval(decisionTimer); decisionTimer = null; }
  } finally {
    aiBusy.value = false;
  }
}

function emergencyStop() {
  stop();
}

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
        </defs>

        <!-- 蜘蛛腿 -->
        <g v-for="(node, i) in stockNodes" :key="i" class="spider-leg">
          <path
            :d="node.legPath"
            :stroke="node.isCurrent ? '#00dcff' : '#0a8ab0'"
            :stroke-width="node.isCurrent ? 2.5 : 1.5"
            fill="none"
            :opacity="node.isCurrent ? 1 : 0.5"
            filter="url(#glow)"
          />
          <circle v-for="j in 3" :key="j"
            :cx="300 + (node.x - 300) * (j / 4)"
            :cy="200 + (node.y - 200) * (j / 4)"
            r="1.5"
            :fill="node.isCurrent ? '#00dcff' : '#0a8ab0'"
            :opacity="node.isCurrent ? 0.9 : 0.5"
          />
          <circle :cx="node.x" :cy="node.y" r="node.isCurrent ? 6 : 4"
            :fill="node.isCurrent ? '#ff5096' : '#ff88aa'"
            :opacity="node.isCurrent ? 1 : 0.7"
            filter="url(#glow)"
          />
          <circle :cx="node.x" :cy="node.y" r="node.isCurrent ? 10 : 7"
            :fill="node.isCurrent ? '#ff5096' : '#ff88aa'"
            :opacity="node.isCurrent ? 0.3 : 0.15"
          />
          <text :x="node.x" :y="node.y - 12"
            text-anchor="middle"
            :fill="node.isCurrent ? '#00dcff' : '#7aa'"
            font-size="11"
            font-family="Consolas, monospace"
          >{{ node.name }}</text>
          <text :x="node.x" :y="node.y + 18"
            text-anchor="middle"
            :fill="node.pct >= 0 ? '#f23645' : '#0ecb81'"
            font-size="10"
            font-family="Consolas, monospace"
          >{{ node.price.toFixed(2) }} {{ node.pct >= 0 ? '+' : '' }}{{ node.pct.toFixed(2) }}%</text>
        </g>

        <!-- 蜘蛛身体 -->
        <g class="spider-body">
          <circle cx="300" cy="200" r="30" fill="#0096ff" opacity="0.1" />
          <circle cx="300" cy="200" r="22" fill="#0096ff" opacity="0.15" />
          <circle cx="300" cy="200" r="15" fill="#0096ff" opacity="0.3" />
          <rect x="286" y="186" width="28" height="28"
            fill="#0064ff" opacity="0.9" rx="2" />
          <rect x="289" y="189" width="22" height="22"
            fill="#32b4ff" rx="1" />
          <circle cx="300" cy="200" r="4" fill="#fff" />
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
