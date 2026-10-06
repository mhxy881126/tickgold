<script setup lang="ts">
import { ref, computed, onUnmounted, watch } from "vue";
import { useSpiderBotEngine } from "../composables/useSpiderBotEngine";
import { useWorkbench } from "../composables/useWorkbench";
import type { CardId } from "../lib/cards";

const engine = useSpiderBotEngine();
const bench = useWorkbench();

const visible = ref(false); // 本地控制显示

// 监听引擎的 visible 状态，同步到本地
watch(() => engine.visible.value, (v) => {
  visible.value = v;
});

// ===== 切换卡片 =====
// 尊重用户关闭意图：只在卡片已打开时切焦点，不硬把用户关掉的卡重新 open 回来。
function switchCard(cardId: CardId) {
  try {
    if (!bench.isOpen(cardId)) return;
    if (!bench.freeMode.value) {
      // 主卡+右导航：切主卡
      bench.setGlassActive(cardId);
    } else {
      // 自由布局：聚焦到主区
      bench.focus(cardId);
      bench.focusId.value = cardId;
    }
  } catch (e) {
    console.warn("切换卡片失败:", e);
  }
}

// ===== 控制函数 =====
function start() {
  visible.value = true;
  engine.start(switchCard);
  startWalking(); // 启动实时爬行动画
}

function stop() {
  engine.stop();
  visible.value = false;
}

// ===== 从 DOM 真实读取股票列表 =====
function readStocksFromDOM() {
  // 找到自选股卡片里的所有股票行
  const rows = document.querySelectorAll('.watch-list tr, .card-watch tr, [data-card="watch"] tr');
  const points: { x: number; y: number; label: string; action?: string; isCurrent?: boolean }[] = [];

  rows.forEach((row, i) => {
    const rect = row.getBoundingClientRect();
    if (rect.height === 0) return; // 跳过隐藏的行

    // 从 DOM 里读真实文字
    const nameEl = row.querySelector('.nm');
    const priceEl = row.querySelectorAll('.r')[0];
    const pctEl = row.querySelectorAll('.r')[1];

    const name = nameEl?.textContent?.trim() || `股票${i+1}`;
    const price = priceEl?.textContent?.trim() || "--";
    const pct = pctEl?.textContent?.trim() || "";

    points.push({
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      label: `${name} ${price} ${pct}`,
      isCurrent: i === 0,
    });
  });

  return points;
}

// 当前卡片名称
const currentCardName = computed(() => {
  const names: Record<string, string> = {
    watch: "自选股",
    rank: "涨幅榜",
    sector: "板块行情",
    radar: "涨停雷达",
    chart: "K线图",
    trade: "交易面板",
  };
  return names[engine.currentCard.value] || "未知";
});

// ===== 实时爬行动画 =====
const spiderPos = ref({ x: 200, y: 250 });
const spiderTarget = ref({ x: 200, y: 250 });
const currentPointIdx = ref(0);
const walkingPhase = ref(0); // 走路相位（腿摆动）

// 启动爬行动画循环
let animFrame: number;
function startWalking() {
  const points = engine.targetPoints.value;
  if (points.length === 0) return;

  // 每隔 2 秒，爬到下一个数据点
  setInterval(() => {
    currentPointIdx.value = (currentPointIdx.value + 1) % points.length;
    const pt = points[currentPointIdx.value];
    spiderTarget.value = { x: pt.x, y: pt.y };
  }, 2000);

  // 连续动画（每帧都在动）
  function animate() {
    // 1. 平滑移动到目标点
    const dx = spiderTarget.value.x - spiderPos.value.x;
    const dy = spiderTarget.value.y - spiderPos.value.y;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      spiderPos.value = {
        x: spiderPos.value.x + dx * 0.05,
        y: spiderPos.value.y + dy * 0.05,
      };
    }

    // 2. 走路相位（腿摆动）
    walkingPhase.value += 0.1;

    animFrame = requestAnimationFrame(animate);
  }
  animate();
}

onUnmounted(() => {
  cancelAnimationFrame(animFrame);
  engine.stop();
});

// 生成一条抓取腿的路径
function makeLeg(sx: number, sy: number, tx: number, ty: number, legIdx: number) {
  // 腿的弯曲方向（左右交替）
  const side = legIdx % 2 === 0 ? 1 : -1;
  const bend = 40 + (legIdx % 3) * 20;
  
  const dx = tx - sx;
  const dy = ty - sy;
  
  // 3 段折线
  const p1x = sx + dx * 0.25;
  const p1y = sy + dy * 0.25 + side * bend;
  
  const p2x = sx + dx * 0.6;
  const p2y = sy + dy * 0.6 + side * bend * 0.5;
  
  return `M ${sx} ${sy} L ${p1x} ${p1y} L ${p2x} ${p2y} L ${tx} ${ty}`;
}

defineExpose({ start, stop, running: engine.running });
</script>

<template>
  <div v-if="visible" class="spider-overlay">
    <svg class="spider-svg">
      <defs>
        <filter id="overlay-glow">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <!-- ===== 蜘蛛腿（从身体伸出去连到数据点） ===== -->
      <g v-for="(pt, i) in engine.targetPoints.value" :key="i">
        <!-- 腿 -->
        <path
          :d="makeLeg(spiderPos.x, spiderPos.y, pt.x, pt.y, i)"
          :stroke="pt.action === 'buy' ? '#00ff88' : pt.action === 'sell' ? '#ff4466' : '#00cccc'"
          :stroke-width="pt.isCurrent ? 2 : 1.5"
          fill="none"
          :opacity="pt.isCurrent ? 1 : 0.7"
          filter="url(#overlay-glow)"
        />
        
        <!-- 关节点 -->
        <circle :cx="spiderPos.x + (pt.x - spiderPos.x) * 0.3" :cy="spiderPos.y + (pt.y - spiderPos.y) * 0.3 + (i % 2 === 0 ? 20 : -20)" 
                r="2.5" fill="#ff6699" opacity="0.8" />
        <circle :cx="spiderPos.x + (pt.x - spiderPos.x) * 0.6" :cy="spiderPos.y + (pt.y - spiderPos.y) * 0.6 + (i % 2 === 0 ? 10 : -10)" 
                r="2" fill="#ff6699" opacity="0.6" />
        
        <!-- 腿尖光点 -->
        <circle :cx="pt.x" :cy="pt.y" r="pt.isCurrent ? 5 : 4"
          :fill="pt.action === 'buy' ? '#00ff88' : pt.action === 'sell' ? '#ff4466' : '#ff6699'"
          filter="url(#overlay-glow)"
        />
        
        <!-- 标注文字 -->
        <text :x="pt.x + 10" :y="pt.y + 4"
          :fill="pt.action === 'buy' ? '#00ff88' : pt.action === 'sell' ? '#ff4466' : '#a0b0c0'"
          font-size="11"
          font-family="Consolas, monospace"
        >{{ pt.label }}</text>
      </g>

      <!-- ===== 蜘蛛身体（实时移动） ===== -->
      <g>
        <circle :cx="spiderPos.x" :cy="spiderPos.y" r="20" fill="#0066cc" opacity="0.1" />
        <circle :cx="spiderPos.x" :cy="spiderPos.y" r="15" fill="#0066cc" opacity="0.15" />
        <rect :x="spiderPos.x - 8" :y="spiderPos.y - 10" width="16" height="20"
          fill="#004488" rx="2" />
        <rect :x="spiderPos.x - 6" :y="spiderPos.y - 8" width="12" height="16"
          fill="#0066cc" rx="1" />
        <circle :cx="spiderPos.x" :cy="spiderPos.y" r="3" fill="#fff" />
      </g>
    </svg>

    <!-- 顶部状态栏 -->
    <div class="sb-topbar">
      <div class="sb-left">
        <span class="sb-title">🕷 AI 爬虫机器人</span>
        <span class="sb-card">📍 当前: {{ currentCardName }}</span>
        <span class="sb-step">已扫描 {{ engine.currentStep.value }} 轮</span>
      </div>
      <div class="sb-right">
        <button class="sb-btn" :class="{ on: engine.semiAuto.value }" @click="engine.setSemiAuto(!engine.semiAuto.value)">
          👆 半自动 {{ engine.semiAuto.value ? "ON" : "OFF" }}
        </button>
        <button class="sb-btn" :class="{ on: engine.autoTrade.value }" @click="engine.setAutoTrade(!engine.autoTrade.value)">
          🤖 全自动 {{ engine.autoTrade.value ? "ON" : "OFF" }}
        </button>
        <button class="sb-btn danger" @click="stop">🛑 停止</button>
      </div>
    </div>

    <!-- 日志面板 -->
    <div class="sb-log-panel">
      <div class="sb-log-title">📡 爬虫日志</div>
      <div class="sb-log-list">
        <div v-for="(log, i) in engine.logs.value" :key="i"
          class="sb-log-row" :class="log.type">
          <span class="sb-log-time">{{ log.time }}</span>
          <span class="sb-log-text">{{ log.text }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.spider-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 9999;
  pointer-events: none;
}

.spider-svg {
  width: 100%;
  height: 100%;
}

.sb-topbar {
  position: absolute;
  top: 10px; left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  background: rgba(10, 20, 18, 0.9);
  border: 1px solid #00ffd5;
  border-radius: 8px;
  pointer-events: auto;
  box-shadow: 0 0 20px rgba(0, 255, 213, 0.3);
}

.sb-title { color: #00ffd5; font-weight: bold; font-size: 14px; }
.sb-card { color: #ffb13d; font-size: 12px; }
.sb-step { color: #6a7a72; font-size: 12px; }

.sb-right { display: flex; gap: 8px; }
.sb-btn {
  padding: 4px 10px; border-radius: 4px;
  border: 1px solid #2a3a35; background: #14201c;
  color: #9fb3aa; cursor: pointer; font-size: 11px;
  pointer-events: auto;
}
.sb-btn.on { background: #281a06; color: #ffb13d; border-color: #d4a017; }
.sb-btn.danger { background: #2a0a0a; color: #f23645; border-color: #f23645; }

.sb-log-panel {
  position: absolute;
  bottom: 10px; right: 10px;
  width: 360px;
  max-height: 280px;
  background: rgba(10, 20, 18, 0.9);
  border: 1px solid #1a2a24;
  border-radius: 8px;
  padding: 8px;
  pointer-events: auto;
  overflow: hidden;
}

.sb-log-title { font-size: 11px; color: #6a7a72; margin-bottom: 4px; }
.sb-log-list { overflow-y: auto; max-height: 240px; }
.sb-log-row {
  display: flex; gap: 6px; padding: 2px 0;
  font-family: Consolas, monospace; font-size: 10px;
}
.sb-log-time { color: #4a5a52; width: 55px; }
.sb-log-text { color: #9fb3aa; flex: 1; }
.sb-log-row.buy .sb-log-text { color: #00ff88; }
.sb-log-row.sell .sb-log-text { color: #ff4466; }
.sb-log-row.warn .sb-log-text { color: #ffb13d; }
</style>
