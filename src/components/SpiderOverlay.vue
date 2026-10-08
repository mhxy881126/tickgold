<script setup lang="ts">
import { ref, computed, nextTick, onUnmounted, watch } from "vue";
import { useSpiderBotEngine } from "../composables/useSpiderBotEngine";
import { useWorkbench } from "../composables/useWorkbench";
import {
  autoexecGetConfig,
  autoexecStart,
  autoexecStop,
  autoexecSetConfig,
  type AutoExecConfigInfo,
} from "../ai/api";
import type { CardId } from "../lib/cards";
import ProceduralSpider from "./spider/ProceduralSpider.vue";

const engine = useSpiderBotEngine();
const bench = useWorkbench();

const visible = ref(false); // 本地控制显示
const logPanelRef = ref<HTMLElement | null>(null);

// ===== 后端快脑配置（悬浮层按钮真正联动后端，而不是只播动画）=====
const backendCfg = ref<AutoExecConfigInfo | null>(null);

/// 当前模式对应的后端参数：
/// 半自动 = 全部信号落确认桥人工确认（manual + bridge 开）；
/// 全自动 = 信号直接下单不打扰（full + bridge 关）。
function modePatch(): Partial<AutoExecConfigInfo> {
  if (engine.autoTrade.value) {
    return { tradeMode: "full", fullAutoMode: true, bridgeEnabled: false };
  }
  return { tradeMode: "manual", fullAutoMode: false, bridgeEnabled: true };
}

async function loadBackendCfg() {
  backendCfg.value = await autoexecGetConfig();
}

async function syncModeToBackend() {
  try {
    if (!backendCfg.value) await loadBackendCfg();
    if (!backendCfg.value) return;
    const next = { ...backendCfg.value, ...modePatch() };
    backendCfg.value = next;
    await autoexecSetConfig(next); // 运行中改模式立即生效；enabled 由后端保留
  } catch (e) {
    console.warn("同步交易模式到后端失败:", e);
  }
}

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

// ===== A 股交易时段（与后端 spider::is_trading_time 一致）=====
const marketOpen = ref(false);
let statusTimer: number | undefined;
function refreshMarketStatus() {
  const now = new Date();
  const wd = now.getDay(); // 0=周日 ... 6=周六
  if (wd === 0 || wd === 6) { marketOpen.value = false; return; }
  const hm = now.getHours() * 100 + now.getMinutes();
  marketOpen.value = (hm >= 915 && hm <= 1131) || (hm >= 1259 && hm <= 1505);
}

// ===== 控制函数 =====
let startSeq = 0; // 启停竞态令牌：废弃 stop 之后才 resolve 的后端启动

async function start() {
  if (visible.value) return; // 防重入：重复启动会覆盖定时器/interval 句柄
  const seq = ++startSeq;
  visible.value = true;
  // v-if 的 ProceduralSpider 下一 tick 才挂载并注册扫描监听；
  // 必须等它就绪后再启动引擎首轮扫描，否则首轮 card/target 事件无人接收（蜘蛛空等一轮）
  await nextTick();
  if (seq !== startSeq) return; // 等待期间已被停止
  engine.start(switchCard);
  refreshMarketStatus();
  statusTimer = window.setInterval(refreshMarketStatus, 1000);

  // 联动后端「快脑自动执行器」：仅启动前端动画时，信号桥永远收不到信号
  try {
    await loadBackendCfg();
    if (seq !== startSeq) return; // await 期间已停止，放弃过期启动
    if (backendCfg.value) {
      await autoexecStart({ ...backendCfg.value, enabled: true, ...modePatch() });
    }
  } catch (e) {
    console.warn("后端快脑启动失败（前端评分仍会送桥）:", e);
  }
  if (seq !== startSeq) return;
  if (!marketOpen.value) {
    addEngineLog("⏸ 当前为休市时段，后端快脑不产信号；前端评分仍会送确认桥");
  }
}

async function stop() {
  startSeq++; // 使任何在途的 start() await 链失效
  engine.stop();
  visible.value = false;
  if (statusTimer) { clearInterval(statusTimer); statusTimer = undefined; }
  try {
    await autoexecStop();
  } catch (e) {
    console.warn("后端快脑停止失败:", e);
  }
}

// 半自动 / 全自动：互斥模式，切换即同步后端
async function setSemi(on: boolean) {
  if (on) engine.setAutoTrade(false);
  engine.setSemiAuto(on);
  await syncModeToBackend();
}
async function setFull(on: boolean) {
  if (on) engine.setSemiAuto(false);
  engine.setAutoTrade(on);
  await syncModeToBackend();
}

// 复用引擎日志面板
function addEngineLog(text: string) {
  engine.logs.value.unshift({
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    text,
    type: "warn",
  });
  if (engine.logs.value.length > 40) engine.logs.value.pop();
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

onUnmounted(() => {
  if (statusTimer) clearInterval(statusTimer);
  engine.stop();
});

defineExpose({ start, stop, running: engine.running });
</script>

<template>
  <div v-if="visible" class="spider-overlay">
    <ProceduralSpider :log-el="logPanelRef" />

    <!-- 顶部状态栏 -->
    <div class="sb-topbar">
      <div class="sb-left">
        <span class="sb-title">🕷 AI 爬虫机器人</span>
        <span class="sb-card">📍 当前: {{ currentCardName }}</span>
        <span class="sb-step">已扫描 {{ engine.currentStep.value }} 轮</span>
      </div>
      <div class="sb-right">
        <span
          class="sb-market"
          :class="{ open: marketOpen }"
          :title="marketOpen ? 'A股交易时段，快脑实时产生信号' : '休市时段（午休/未开盘/已收盘），后端快脑不产生信号'"
        >{{ marketOpen ? "🟢 交易中" : "🔴 休市中" }}</span>
        <button class="sb-btn" :class="{ on: engine.semiAuto.value }" @click="setSemi(!engine.semiAuto.value)">
          👆 半自动 {{ engine.semiAuto.value ? "ON" : "OFF" }}
        </button>
        <button class="sb-btn" :class="{ on: engine.autoTrade.value }" @click="setFull(!engine.autoTrade.value)">
          🤖 全自动 {{ engine.autoTrade.value ? "ON" : "OFF" }}
        </button>
        <button class="sb-btn danger" @click="stop">🛑 停止</button>
      </div>
    </div>

    <!-- 日志面板 -->
    <div ref="logPanelRef" class="sb-log-panel">
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

.sb-right { display: flex; gap: 8px; align-items: center; }
.sb-market {
  padding: 4px 9px; border-radius: 4px; font-size: 11px;
  border: 1px solid #6a2a2a; background: #241010; color: #f26464;
  white-space: nowrap;
}
.sb-market.open { border-color: #1f6a45; background: #0c2418; color: #35d98a; }
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
