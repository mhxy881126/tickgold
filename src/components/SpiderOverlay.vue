<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from "vue";
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
// 不依赖 workbench.isOpen()（SpiderOverlay 可能在 provide 层级外，拿到空实例）。
// 改用 DOM 存在性判断：只要页面上有 [data-card-id=xxx]，就认为卡片可见可以爬。
// 锚点采集采不到行也没关系，会自动走漫游兜底。
function switchCard(cardId: CardId): boolean {
  try {
    const el = document.querySelector(`[data-card-id="${cardId}"]`);
    if (!el) return false;
    // 尝试聚焦（workbench 可用的话），失败也不影响爬行
    try {
      if (bench && bench.isOpen?.(cardId)) {
        if (!bench.freeMode.value) {
          bench.setGlassActive(cardId);
        } else {
          bench.focus(cardId);
          bench.focusId.value = cardId;
        }
      }
    } catch {
      // 静默失败：即使不能切换卡片，只要 DOM 存在就能爬
    }
    return true;
  } catch (e) {
    console.warn("切换卡片失败:", e);
    return false;
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
  // 通知外部已启动
  window.dispatchEvent(new CustomEvent("spider-overlay-started"));
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
  // 通知外部已停止
  window.dispatchEvent(new CustomEvent("spider-overlay-stopped"));
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
    sector: "行业板块",
    concept: "概念题材",
    radar: "涨停雷达",
    chart: "K线图",
    trade: "交易面板",
    market: "大盘指数",
    dragon: "龙虎榜",
    screener: "条件选股",
  };
  return names[engine.currentCard.value] || "未知";
});

// 设置面板
const showSettings = ref(false);

// 策略标签映射
const strategyLabels = computed(() => engine.strategyNames);

// 切换策略
function switchStrategy(key: "conservative" | "balanced" | "aggressive" | "scalping") {
  engine.applyStrategy(key);
}

// 绩效数据
const performance = computed(() => engine.performance.value);

// 绩效颜色类
function perfClass(v: number): string {
  if (v > 0) return "up";
  if (v < 0) return "down";
  return "neutral";
}

// 监控股票数量（自选股数量）
import { useWatchlistStore } from "../stores/watchlist";
const watchCount = computed(() => {
  try {
    const wl = useWatchlistStore();
    return wl.codes?.length ?? 0;
  } catch {
    return 0;
  }
});

// ===== 外部启动/停止事件（供 SpiderBot 卡片等调用）=====
function handleStartRequest() {
  if (!visible.value) start().catch(() => {});
}
function handleStopRequest() {
  if (visible.value) stop().catch(() => {});
}

onMounted(() => {
  window.addEventListener("spider-overlay-start", handleStartRequest);
  window.addEventListener("spider-overlay-stop", handleStopRequest);
});

onUnmounted(() => {
  startSeq++;
  if (statusTimer) clearInterval(statusTimer);
  engine.stop();
  // 组件随应用关闭时兜底停掉 Rust 端自动执行器（IPC，fire-and-forget；幂等）
  autoexecStop().catch(() => {});
  window.removeEventListener("spider-overlay-start", handleStartRequest);
  window.removeEventListener("spider-overlay-stop", handleStopRequest);
});

defineExpose({ start, stop, running: engine.running });
</script>

<template>
  <div v-if="visible" class="spider-overlay">
    <ProceduralSpider :log-el="logPanelRef" />

    <!-- 顶部状态栏（鎏金风格，靠左） -->
    <div class="sb-topbar">
      <div class="sb-left">
        <span class="sb-title">
          <span class="sb-title-icon">🕷</span>
          AI 爬虫机器人
        </span>
        <span class="sb-divider"></span>
        <span class="sb-card">📍 当前: {{ currentCardName }}</span>
        <span class="sb-status-tag">已扫描</span>
        <span class="sb-step">{{ engine.currentStep.value }} 轮</span>
      </div>
      <div class="sb-right">
        <span
          class="sb-market"
          :class="{ open: marketOpen }"
          :title="marketOpen ? 'A股交易时段，快脑实时产生信号' : '休市时段（午休/未开盘/已收盘），后端快脑不产生信号'"
        >
          <span class="sb-dot" :class="{ open: marketOpen }"></span>
          {{ marketOpen ? "交易中" : "休市中" }}
        </span>
        <button class="sb-btn" :class="{ on: showSettings }" @click="showSettings = !showSettings">
          <span class="sb-btn-icon">⚙️</span>
          设置
        </button>
        <button class="sb-btn" :class="{ on: engine.semiAuto.value }" @click="setSemi(!engine.semiAuto.value)">
          <span class="sb-btn-icon">👆</span>
          半自动
          <span class="sb-btn-state">{{ engine.semiAuto.value ? "ON" : "OFF" }}</span>
        </button>
        <button class="sb-btn" :class="{ on: engine.autoTrade.value }" @click="setFull(!engine.autoTrade.value)">
          <span class="sb-btn-icon">🤖</span>
          全自动
          <span class="sb-btn-state">{{ engine.autoTrade.value ? "ON" : "OFF" }}</span>
        </button>
        <button class="sb-btn danger" @click="stop">
          <span class="sb-btn-icon">🛑</span>
          停止
        </button>
      </div>
    </div>

    <!-- 右上角实时状态指示器（小蜘蛛 + 实时 + 股数） -->
    <div class="sb-status-widget">
      <div class="sw-live">
        <span class="sw-dot"></span>
        <span class="sw-label">实时</span>
      </div>
      <div class="sw-spider">
        <svg viewBox="0 0 120 100" class="sw-spider-svg">
          <!-- 蛛丝 -->
          <line x1="10" y1="5" x2="60" y2="30" stroke="#00d4ff" stroke-width="1" opacity="0.6" />
          <line x1="110" y1="5" x2="60" y2="30" stroke="#00d4ff" stroke-width="1" opacity="0.6" />
          <line x1="10" y1="95" x2="60" y2="65" stroke="#00d4ff" stroke-width="1" opacity="0.5" />
          <line x1="110" y1="95" x2="60" y2="65" stroke="#00d4ff" stroke-width="1" opacity="0.5" />
          <!-- 蜘蛛身体（两节） -->
          <ellipse cx="60" cy="48" rx="18" ry="14" fill="#0a1a28" stroke="#00d4ff" stroke-width="1.5" opacity="0.95" />
          <ellipse cx="60" cy="68" rx="14" ry="12" fill="#0a1a28" stroke="#00d4ff" stroke-width="1.5" opacity="0.95" />
          <!-- 腹节纹 -->
          <ellipse cx="60" cy="64" rx="8" ry="2" fill="none" stroke="#00d4ff" stroke-width="0.8" opacity="0.5" />
          <ellipse cx="60" cy="70" rx="9" ry="2.5" fill="none" stroke="#00d4ff" stroke-width="0.8" opacity="0.5" />
          <!-- 蜘蛛腿（8条） -->
          <g stroke="#00d4ff" stroke-width="1.2" fill="none" opacity="0.9">
            <!-- 左上腿 -->
            <path d="M45 40 Q25 25 15 15" />
            <path d="M44 45 Q20 40 8 35" />
            <path d="M45 52 Q22 55 10 60" />
            <path d="M47 58 Q28 72 18 85" />
            <!-- 右上腿 -->
            <path d="M75 40 Q95 25 105 15" />
            <path d="M76 45 Q100 40 112 35" />
            <path d="M75 52 Q98 55 110 60" />
            <path d="M73 58 Q92 72 102 85" />
          </g>
          <!-- 腿末端红点（信号点） -->
          <circle cx="15" cy="15" r="3" fill="#ff5096" class="sw-signal-dot">
            <animate attributeName="r" values="2;4;2" dur="1.5s" repeatCount="indefinite" />
          </circle>
          <circle cx="105" cy="15" r="3" fill="#ff5096" class="sw-signal-dot">
            <animate attributeName="r" values="2;4;2" dur="1.8s" repeatCount="indefinite" />
          </circle>
          <circle cx="18" cy="85" r="3" fill="#ff5096" class="sw-signal-dot">
            <animate attributeName="r" values="2;4;2" dur="2s" repeatCount="indefinite" />
          </circle>
          <circle cx="102" cy="85" r="3" fill="#ff5096" class="sw-signal-dot">
            <animate attributeName="r" values="2;4;2" dur="1.6s" repeatCount="indefinite" />
          </circle>
          <!-- 眼睛 -->
          <circle cx="54" cy="44" r="2.5" fill="#fff" />
          <circle cx="66" cy="44" r="2.5" fill="#fff" />
          <circle cx="54" cy="44" r="1.2" fill="#00d4ff" />
          <circle cx="66" cy="44" r="1.2" fill="#00d4ff" />
        </svg>
      </div>
      <div class="sw-divider"></div>
      <div class="sw-count">
        <span class="sw-count-num">{{ watchCount }}</span>
        <span class="sw-count-unit">只</span>
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

    <!-- 设置面板 -->
    <div v-if="showSettings" class="sb-settings-panel">
      <div class="sb-settings-title">⚙️ 爬虫配置</div>
      
      <div class="sb-settings-section">
        <div class="sb-settings-subtitle">📡 爬取数据源</div>
        <div class="sb-settings-grid">
          <label class="sb-setting-item">
            <input type="checkbox" v-model="engine.crawlSources.value.watch" />
            <span>自选股</span>
          </label>
          <label class="sb-setting-item">
            <input type="checkbox" v-model="engine.crawlSources.value.rank" />
            <span>涨幅榜</span>
          </label>
          <label class="sb-setting-item">
            <input type="checkbox" v-model="engine.crawlSources.value.market" />
            <span>大盘指数</span>
          </label>
          <label class="sb-setting-item">
            <input type="checkbox" v-model="engine.crawlSources.value.sector" />
            <span>行业板块</span>
          </label>
          <label class="sb-setting-item">
            <input type="checkbox" v-model="engine.crawlSources.value.concept" />
            <span>概念题材</span>
          </label>
          <label class="sb-setting-item">
            <input type="checkbox" v-model="engine.crawlSources.value.radar" />
            <span>涨停雷达</span>
          </label>
          <label class="sb-setting-item">
            <input type="checkbox" v-model="engine.crawlSources.value.dragon" />
            <span>龙虎榜</span>
          </label>
          <label class="sb-setting-item">
            <input type="checkbox" v-model="engine.crawlSources.value.screener" />
            <span>条件选股</span>
          </label>
        </div>
      </div>

      <div class="sb-settings-section">
        <div class="sb-settings-subtitle">🤖 自动交易授权</div>
        <div class="sb-settings-hint">勾选的数据源产生的信号，在全自动模式下会直接交易</div>
        <div class="sb-settings-grid">
          <label class="sb-setting-item">
            <input type="checkbox" v-model="engine.autoTradeSources.value.watch" />
            <span>自选股</span>
          </label>
          <label class="sb-setting-item">
            <input type="checkbox" v-model="engine.autoTradeSources.value.rank" />
            <span>涨幅榜</span>
          </label>
          <label class="sb-setting-item">
            <input type="checkbox" v-model="engine.autoTradeSources.value.market" />
            <span>大盘指数</span>
          </label>
          <label class="sb-setting-item">
            <input type="checkbox" v-model="engine.autoTradeSources.value.sector" />
            <span>行业板块</span>
          </label>
          <label class="sb-setting-item">
            <input type="checkbox" v-model="engine.autoTradeSources.value.concept" />
            <span>概念题材</span>
          </label>
          <label class="sb-setting-item">
            <input type="checkbox" v-model="engine.autoTradeSources.value.radar" />
            <span>涨停雷达</span>
          </label>
        </div>
      </div>

      <div class="sb-settings-section">
        <div class="sb-settings-subtitle">🎯 交易策略</div>
        <div class="sb-settings-hint">选择预设策略，一键切换风险收益偏好</div>
        <div class="sb-strategy-grid">
          <button
            v-for="(label, key) in strategyLabels"
            :key="key"
            class="sb-strategy-btn"
            :class="{ active: engine.currentStrategy.value === key }"
            @click="switchStrategy(key as any)"
          >
            <span class="sb-strategy-label">{{ label }}</span>
          </button>
        </div>
      </div>

      <div class="sb-settings-section">
        <div class="sb-settings-subtitle">📈 绩效统计</div>
        <div class="sb-perf-grid">
          <div class="sb-perf-item">
            <div class="sb-perf-label">总收益率</div>
            <div class="sb-perf-value" :class="perfClass(performance.totalReturnPct)">
              {{ (performance.totalReturnPct * 100).toFixed(2) }}%
            </div>
          </div>
          <div class="sb-perf-item">
            <div class="sb-perf-label">最大回撤</div>
            <div class="sb-perf-value" :class="perfClass(-Math.abs(performance.maxDrawdownPct))">
              {{ (Math.abs(performance.maxDrawdownPct) * 100).toFixed(2) }}%
            </div>
          </div>
          <div class="sb-perf-item">
            <div class="sb-perf-label">交易次数</div>
            <div class="sb-perf-value neutral">{{ performance.totalTrades }}</div>
          </div>
          <div class="sb-perf-item">
            <div class="sb-perf-label">当前策略</div>
            <div class="sb-perf-value neutral">{{ strategyLabels[engine.currentStrategy.value] }}</div>
          </div>
        </div>
      </div>

      <div class="sb-settings-section">
        <div class="sb-settings-subtitle">🛡️ 风控参数</div>
        <div class="sb-settings-hint">核心风控阈值（与当前策略联动）</div>
        <div class="sb-settings-grid">
          <div class="sb-setting-item full">
            <span>止盈比例</span>
            <span class="sb-val">{{ ((engine.riskConfig.value.takeProfitPct ?? 0.08) * 100).toFixed(0) }}%</span>
          </div>
          <div class="sb-setting-item full">
            <span>止损比例</span>
            <span class="sb-val">{{ Math.abs((engine.riskConfig.value.stopLossPct ?? -0.04) * 100).toFixed(0) }}%</span>
          </div>
          <div class="sb-setting-item full">
            <span>移动止盈回撤</span>
            <span class="sb-val">{{ ((engine.riskConfig.value.trailingStopPct ?? 0.03) * 100).toFixed(0) }}%</span>
          </div>
          <div class="sb-setting-item full">
            <span>最大持仓</span>
            <span class="sb-val">{{ engine.riskConfig.value.maxPositions ?? 5 }} 只</span>
          </div>
          <div class="sb-setting-item full">
            <span>单日最大亏损</span>
            <span class="sb-val">{{ Math.abs((engine.riskConfig.value.maxDailyLossPct ?? -0.03) * 100).toFixed(0) }}%</span>
          </div>
          <div class="sb-setting-item full">
            <span>最大回撤</span>
            <span class="sb-val">{{ Math.abs((engine.riskConfig.value.maxDrawdownPct ?? -0.1) * 100).toFixed(0) }}%</span>
          </div>
        </div>
      </div>

      <div class="sb-settings-section">
        <div class="sb-settings-subtitle">🕷 运动模式</div>
        <div class="sb-settings-hint">滑行扫描：蜘蛛经过目标时不停止，慢速通过更自然</div>
        <div class="sb-settings-grid">
          <label class="sb-setting-item">
            <input type="checkbox" checked disabled />
            <span>自然曲线路径</span>
          </label>
          <label class="sb-setting-item">
            <input type="checkbox" checked disabled />
            <span>滑行扫描模式</span>
          </label>
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

/* ===== 鎏金风格顶栏（靠左） ===== */
.sb-topbar {
  position: absolute;
  top: 10px; left: 12px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 18px;
  background: linear-gradient(180deg, rgba(20, 16, 8, 0.95) 0%, rgba(12, 10, 6, 0.95) 100%);
  border: 1px solid rgba(212, 175, 55, 0.6);
  border-radius: 12px;
  pointer-events: auto;
  box-shadow:
    0 0 24px rgba(212, 175, 55, 0.25),
    0 0 48px rgba(212, 175, 55, 0.1),
    inset 0 1px 0 rgba(255, 215, 100, 0.15);
}

.sb-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.sb-title {
  color: #00e8d8;
  font-weight: 700;
  font-size: 15px;
  display: flex;
  align-items: center;
  gap: 6px;
  text-shadow: 0 0 8px rgba(0, 232, 216, 0.5);
  letter-spacing: 0.5px;
}
.sb-title-icon {
  font-size: 16px;
  filter: drop-shadow(0 0 4px rgba(0, 232, 216, 0.6));
}
.sb-divider {
  width: 1px;
  height: 20px;
  background: linear-gradient(180deg, transparent 0%, rgba(212, 175, 55, 0.4) 50%, transparent 100%);
  margin: 0 4px;
}
.sb-status-tag {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  background: rgba(0, 232, 216, 0.1);
  color: #00e8d8;
  border: 1px solid rgba(0, 232, 216, 0.3);
}
.sb-card {
  color: #ffd76a;
  font-size: 13px;
  font-weight: 500;
}
.sb-step {
  color: #8a7e5a;
  font-size: 12px;
  font-family: Consolas, monospace;
}

.sb-right {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* 市场状态标签 */
.sb-market {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 12px;
  border: 1px solid rgba(242, 54, 69, 0.4);
  background: rgba(40, 10, 15, 0.8);
  color: #ff6b78;
  white-space: nowrap;
  font-weight: 500;
}
.sb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f23645;
  box-shadow: 0 0 6px #f23645;
  animation: marketBlink 2s ease-in-out infinite;
}
.sb-market.open {
  border-color: rgba(38, 208, 124, 0.5);
  background: rgba(10, 40, 25, 0.8);
  color: #26d07c;
}
.sb-market.open .sb-dot {
  background: #26d07c;
  box-shadow: 0 0 8px #26d07c;
}
@keyframes marketBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* 按钮 */
.sb-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 13px;
  border-radius: 6px;
  border: 1px solid rgba(212, 175, 55, 0.3);
  background: linear-gradient(180deg, rgba(30, 25, 15, 0.9) 0%, rgba(20, 16, 10, 0.9) 100%);
  color: #c8b98a;
  cursor: pointer;
  font-size: 12px;
  pointer-events: auto;
  transition: all 0.2s ease;
  font-weight: 500;
}
.sb-btn-icon {
  font-size: 13px;
}
.sb-btn-state {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  color: #8a7e5a;
  margin-left: 2px;
  font-family: Consolas, monospace;
}
.sb-btn:hover {
  border-color: rgba(212, 175, 55, 0.6);
  color: #ffd76a;
  background: linear-gradient(180deg, rgba(50, 40, 20, 0.9) 0%, rgba(30, 24, 12, 0.9) 100%);
  box-shadow: 0 0 12px rgba(212, 175, 55, 0.2);
}
.sb-btn.on {
  border-color: rgba(255, 183, 61, 0.7);
  color: #ffb13d;
  background: linear-gradient(180deg, rgba(60, 40, 15, 0.9) 0%, rgba(40, 26, 10, 0.9) 100%);
  box-shadow:
    0 0 12px rgba(255, 183, 61, 0.3),
    inset 0 1px 0 rgba(255, 200, 100, 0.2);
}
.sb-btn.on .sb-btn-state {
  background: rgba(255, 183, 61, 0.15);
  color: #ffb13d;
}
.sb-btn.danger {
  border-color: rgba(242, 54, 69, 0.6);
  color: #ff6b78;
  background: linear-gradient(180deg, rgba(50, 15, 20, 0.9) 0%, rgba(35, 10, 15, 0.9) 100%);
}
.sb-btn.danger:hover {
  border-color: rgba(242, 54, 69, 0.9);
  box-shadow: 0 0 14px rgba(242, 54, 69, 0.3);
}

/* ===== 日志面板（鎏金风） ===== */
.sb-log-panel {
  position: absolute;
  bottom: 12px; right: 12px;
  width: 380px;
  max-height: 300px;
  background: linear-gradient(180deg, rgba(18, 14, 8, 0.95) 0%, rgba(12, 10, 6, 0.95) 100%);
  border: 1px solid rgba(212, 175, 55, 0.4);
  border-radius: 10px;
  padding: 10px;
  pointer-events: auto;
  overflow: hidden;
  box-shadow:
    0 0 20px rgba(0, 0, 0, 0.5),
    0 4px 24px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 215, 100, 0.1);
}

.sb-log-title {
  font-size: 12px;
  color: #ffd76a;
  margin-bottom: 6px;
  font-weight: 600;
  letter-spacing: 0.5px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(212, 175, 55, 0.15);
}
.sb-log-list { overflow-y: auto; max-height: 250px; }
.sb-log-row {
  display: flex; gap: 6px; padding: 3px 0;
  font-family: Consolas, monospace; font-size: 11px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}
.sb-log-time { color: #6a5f42; width: 60px; flex-shrink: 0; }
.sb-log-text { color: #b8a878; flex: 1; line-height: 1.5; }
.sb-log-row.buy .sb-log-text { color: #00e8a0; }
.sb-log-row.sell .sb-log-text { color: #ff6478; }
.sb-log-row.warn .sb-log-text { color: #ffb13d; }

/* 滚动条 */
.sb-log-list::-webkit-scrollbar { width: 4px; }
.sb-log-list::-webkit-scrollbar-track { background: transparent; }
.sb-log-list::-webkit-scrollbar-thumb {
  background: rgba(212, 175, 55, 0.3);
  border-radius: 2px;
}
.sb-log-list::-webkit-scrollbar-thumb:hover {
  background: rgba(212, 175, 55, 0.5);
}

/* ===== 设置面板（鎏金风） ===== */
.sb-settings-panel {
  position: absolute;
  top: 62px;
  right: 12px;
  width: 360px;
  background: linear-gradient(180deg, rgba(18, 14, 8, 0.97) 0%, rgba(12, 10, 6, 0.97) 100%);
  border: 1px solid rgba(212, 175, 55, 0.5);
  border-radius: 10px;
  padding: 14px;
  pointer-events: auto;
  box-shadow:
    0 0 24px rgba(0, 0, 0, 0.5),
    0 8px 32px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 215, 100, 0.12);
  max-height: calc(100vh - 90px);
  overflow-y: auto;
}
.sb-settings-panel::-webkit-scrollbar { width: 4px; }
.sb-settings-panel::-webkit-scrollbar-track { background: transparent; }
.sb-settings-panel::-webkit-scrollbar-thumb {
  background: rgba(212, 175, 55, 0.3);
  border-radius: 2px;
}

.sb-settings-title {
  font-size: 14px;
  font-weight: 700;
  color: #ffd76a;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(212, 175, 55, 0.2);
  letter-spacing: 0.5px;
  text-shadow: 0 0 8px rgba(255, 183, 61, 0.3);
}
.sb-settings-section {
  margin-bottom: 14px;
}
.sb-settings-subtitle {
  font-size: 12px;
  color: #00e8d8;
  margin-bottom: 6px;
  font-weight: 600;
}
.sb-settings-hint {
  font-size: 10.5px;
  color: #7a6f52;
  margin-bottom: 8px;
  line-height: 1.5;
}
.sb-settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}
.sb-setting-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-size: 11.5px;
  color: #b8a878;
  cursor: pointer;
  border-radius: 5px;
  transition: all 0.2s;
}
.sb-setting-item:hover {
  background: rgba(212, 175, 55, 0.08);
  color: #ffd76a;
}
.sb-setting-item input[type="checkbox"] {
  accent-color: #d4af37;
  width: 13px;
  height: 13px;
}
.sb-setting-item span {
  flex: 1;
}
.sb-setting-item.full {
  justify-content: space-between;
}
.sb-val {
  color: #00e8d8;
  font-family: Consolas, monospace;
  font-weight: 600;
}

/* 策略按钮 */
.sb-strategy-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.sb-strategy-btn {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid rgba(212, 175, 55, 0.25);
  background: rgba(30, 25, 15, 0.6);
  color: #b8a878;
  cursor: pointer;
  transition: all 0.2s;
  text-align: left;
}
.sb-strategy-btn:hover {
  border-color: rgba(212, 175, 55, 0.5);
  background: rgba(50, 40, 20, 0.7);
  color: #ffd76a;
}
.sb-strategy-btn.active {
  border-color: rgba(0, 232, 216, 0.6);
  background: rgba(0, 60, 55, 0.5);
  color: #00e8d8;
  box-shadow: 0 0 10px rgba(0, 232, 216, 0.2);
}
.sb-strategy-label {
  font-size: 12px;
  font-weight: 600;
}

/* 绩效网格 */
.sb-perf-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.sb-perf-item {
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 6px;
  border: 1px solid rgba(212, 175, 55, 0.1);
}
.sb-perf-label {
  font-size: 10.5px;
  color: #7a6f52;
  margin-bottom: 3px;
}
.sb-perf-value {
  font-size: 15px;
  font-weight: 700;
  font-family: Consolas, monospace;
}
.sb-perf-value.up { color: #ff6478; }
.sb-perf-value.down { color: #00e8a0; }
.sb-perf-value.neutral { color: #ffd76a; }

/* ===== 右上角实时状态小部件 ===== */
.sb-status-widget {
  position: absolute;
  top: 8px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  background: linear-gradient(180deg, rgba(15, 12, 6, 0.9) 0%, rgba(10, 8, 4, 0.9) 100%);
  border: 1px solid rgba(212, 175, 55, 0.4);
  border-radius: 20px;
  pointer-events: auto;
  box-shadow:
    0 0 16px rgba(212, 175, 55, 0.15),
    inset 0 1px 0 rgba(255, 215, 100, 0.1);
}

.sw-live {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sw-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #26d07c;
  box-shadow: 0 0 8px #26d07c;
  animation: swPulse 1.5s ease-in-out infinite;
}
@keyframes swPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(0.85); }
}
.sw-label {
  color: #26d07c;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.sw-spider {
  display: flex;
  align-items: center;
  justify-content: center;
}
.sw-spider-svg {
  width: 64px;
  height: 52px;
  filter: drop-shadow(0 0 6px rgba(0, 212, 255, 0.5));
  animation: swSpiderBob 2.5s ease-in-out infinite;
}
@keyframes swSpiderBob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}
.sw-signal-dot {
  filter: drop-shadow(0 0 3px rgba(255, 80, 150, 0.8));
}

.sw-divider {
  width: 1px;
  height: 28px;
  background: linear-gradient(180deg, transparent 0%, rgba(212, 175, 55, 0.5) 50%, transparent 100%);
}

.sw-count {
  display: flex;
  align-items: baseline;
  gap: 3px;
  color: #ffd76a;
}
.sw-count-num {
  font-size: 18px;
  font-weight: 700;
  font-family: Consolas, monospace;
  text-shadow: 0 0 8px rgba(255, 215, 100, 0.4);
}
.sw-count-unit {
  font-size: 12px;
  color: #b8a878;
}
</style>
