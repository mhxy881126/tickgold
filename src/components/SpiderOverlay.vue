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

    <!-- 顶部状态栏（极简居中版） -->
    <div class="sb-topbar">
      <div class="sb-left">
        <span class="sb-title-icon" title="AI 爬虫机器人">🕷</span>
        <span class="sb-card" :title="'当前: ' + currentCardName">{{ currentCardName }}</span>
        <span class="sb-step" :title="'已扫描 ' + engine.currentStep.value + ' 轮'">
          <b>{{ engine.currentStep.value }}</b> 轮
        </span>
      </div>
      <div class="sb-right">
        <span
          class="sb-market-dot"
          :class="{ open: marketOpen }"
          :title="marketOpen ? '交易中' : '休市中'"
        ></span>
        <button class="sb-icon-btn" :class="{ on: showSettings }" title="设置" @click="showSettings = !showSettings">
          ⚙️
        </button>
        <button
          class="sb-mode-btn"
          :class="{ on: engine.semiAuto.value }"
          :title="'半自动: ' + (engine.semiAuto.value ? 'ON' : 'OFF')"
          @click="setSemi(!engine.semiAuto.value)"
        >
          半自动
          <span class="sb-mode-state">{{ engine.semiAuto.value ? "ON" : "OFF" }}</span>
        </button>
        <button
          class="sb-mode-btn"
          :class="{ on: engine.autoTrade.value }"
          :title="'全自动: ' + (engine.autoTrade.value ? 'ON' : 'OFF')"
          @click="setFull(!engine.autoTrade.value)"
        >
          全自动
          <span class="sb-mode-state">{{ engine.autoTrade.value ? "ON" : "OFF" }}</span>
        </button>
        <button class="sb-stop-btn" title="停止爬虫" @click="stop">
          停止
        </button>
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

  /* 跟随全局主题：直接消费 --accent / --bg-panel / --border 等变量
     fallback 为鎏金风，确保无主题时也正常
  */
  --ov-gold: var(--accent, #e8c878);
  --ov-gold-2: var(--accent-2, #f0d69a);
  --ov-bg: var(--bg-panel, rgba(21, 18, 10, 0.95));
  --ov-bg2: var(--bg-card, rgba(18, 14, 8, 0.95));
  --ov-border: var(--border, rgba(232, 200, 120, 0.5));
  --ov-radius: 12px;
  --ov-title-color: var(--accent-2, #f0d69a);
  --ov-text: var(--text, #e6edf3);
  --ov-text-dim: var(--text-dim, #b8a878);
  --ov-text-muted: var(--text-dim, #7a6f52);
  --ov-bg-hover: var(--bg-hover, #201b0e);
}

/* ===== 极简风格顶栏（居中，跟随全局主题） ===== */
.sb-topbar {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 14px;
  background: var(--ov-bg, rgba(21, 18, 10, 0.92));
  border: 1px solid var(--ov-border, rgba(232, 200, 120, 0.4));
  border-radius: 12px;
  pointer-events: auto;
  box-shadow:
    0 4px 20px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 color-mix(in srgb, var(--ov-accent, #e8c878) 10%, transparent);
  backdrop-filter: blur(12px);
  white-space: nowrap;
}

.sb-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sb-title-icon {
  font-size: 16px;
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--ov-accent, #e8c878) 50%, transparent));
  cursor: default;
}

.sb-card {
  color: var(--ov-accent, #e8c878);
  font-size: 13px;
  font-weight: 600;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sb-step {
  color: var(--ov-text-muted, #7a6f52);
  font-size: 12px;
}
.sb-step b {
  color: var(--ov-accent-2, #f0d69a);
  font-family: Consolas, monospace;
  font-weight: 600;
}

.sb-right {
  display: flex;
  gap: 6px;
  align-items: center;
  padding-left: 12px;
  border-left: 1px solid color-mix(in srgb, var(--ov-accent, #e8c878) 15%, transparent);
}

/* 市场状态指示灯 */
.sb-market-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--ov-danger, #f23645);
  box-shadow: 0 0 6px var(--ov-danger, #f23645);
  cursor: help;
  animation: marketBlink 2s ease-in-out infinite;
  flex-shrink: 0;
}
.sb-market-dot.open {
  background: var(--ov-success, #26d07c);
  box-shadow: 0 0 8px var(--ov-success, #26d07c);
}
@keyframes marketBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* 图标按钮 */
.sb-icon-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--ov-accent, #e8c878) 25%, transparent);
  background: color-mix(in srgb, var(--ov-accent, #e8c878) 8%, transparent);
  color: var(--ov-text-dim, #b8a878);
  cursor: pointer;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.sb-icon-btn:hover {
  background: color-mix(in srgb, var(--ov-accent, #e8c878) 15%, transparent);
  color: var(--ov-text, #e6edf3);
  border-color: color-mix(in srgb, var(--ov-accent, #e8c878) 50%, transparent);
}
.sb-icon-btn.on {
  border-color: color-mix(in srgb, var(--ov-accent, #e8c878) 60%, transparent);
  background: color-mix(in srgb, var(--ov-accent, #e8c878) 20%, transparent);
  color: var(--ov-accent, #e8c878);
  box-shadow: 0 0 10px color-mix(in srgb, var(--ov-accent, #e8c878) 25%, transparent);
}

/* 模式切换按钮 */
.sb-mode-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--ov-accent, #e8c878) 25%, transparent);
  background: color-mix(in srgb, var(--ov-accent, #e8c878) 8%, transparent);
  color: var(--ov-text-dim, #b8a878);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.sb-mode-btn:hover {
  background: color-mix(in srgb, var(--ov-accent, #e8c878) 15%, transparent);
  color: var(--ov-text, #e6edf3);
  border-color: color-mix(in srgb, var(--ov-accent, #e8c878) 50%, transparent);
}
.sb-mode-btn.on {
  border-color: color-mix(in srgb, var(--ov-accent, #e8c878) 60%, transparent);
  background: color-mix(in srgb, var(--ov-accent, #e8c878) 20%, transparent);
  color: var(--ov-accent, #e8c878);
  box-shadow: 0 0 10px color-mix(in srgb, var(--ov-accent, #e8c878) 20%, transparent);
}
.sb-mode-state {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--ov-accent, #e8c878) 10%, transparent);
  color: var(--ov-text-muted, #7a6f52);
  font-family: Consolas, monospace;
  font-weight: 600;
}
.sb-mode-btn.on .sb-mode-state {
  background: color-mix(in srgb, var(--ov-accent, #e8c878) 25%, transparent);
  color: var(--ov-accent, #e8c878);
}

/* 停止按钮 */
.sb-stop-btn {
  padding: 4px 14px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--ov-danger, #ff6b78) 50%, transparent);
  background: color-mix(in srgb, var(--ov-danger, #ff6b78) 15%, transparent);
  color: var(--ov-danger, #ff6b78);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.sb-stop-btn:hover {
  background: color-mix(in srgb, var(--ov-danger, #ff6b78) 25%, transparent);
  border-color: color-mix(in srgb, var(--ov-danger, #ff6b78) 70%, transparent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--ov-danger, #ff6b78) 30%, transparent);
}

/* ===== 日志面板（鎏金风） ===== */
.sb-log-panel {
  position: absolute;
  bottom: 12px; right: 12px;
  width: 380px;
  max-height: 300px;
  background: linear-gradient(180deg, var(--bg-panel, rgba(18, 14, 8, 0.95)) 0%, var(--bg-card, rgba(12, 10, 6, 0.95)) 100%);
  border: 1px solid var(--border, rgba(212, 175, 55, 0.4));
  border-radius: 10px;
  padding: 10px;
  pointer-events: auto;
  overflow: hidden;
  box-shadow:
    0 0 20px rgba(0, 0, 0, 0.5),
    0 4px 24px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 color-mix(in srgb, var(--accent-2, #ffd76a) 10%, transparent);
}

.sb-log-title {
  font-size: 12px;
  color: var(--accent, #ffd76a);
  margin-bottom: 6px;
  font-weight: 600;
  letter-spacing: 0.5px;
  padding-bottom: 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--ov-gold, #ffd76a) 15%, transparent);
}
.sb-log-list { overflow-y: auto; max-height: 250px; }
.sb-log-row {
  display: flex; gap: 6px; padding: 3px 0;
  font-family: Consolas, monospace; font-size: 11px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}
.sb-log-time { color: var(--ov-text-muted, #6a5f42); width: 60px; flex-shrink: 0; }
.sb-log-text { color: var(--ov-text-dim, #b8a878); flex: 1; line-height: 1.5; }
.sb-log-row.buy .sb-log-text { color: #00e8a0; }
.sb-log-row.sell .sb-log-text { color: #ff6478; }
.sb-log-row.warn .sb-log-text { color: var(--accent, #ffb13d); }

/* 滚动条 */
.sb-log-list::-webkit-scrollbar { width: 4px; }
.sb-log-list::-webkit-scrollbar-track { background: transparent; }
.sb-log-list::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--ov-gold, #ffd76a) 30%, transparent);
  border-radius: 2px;
}
.sb-log-list::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--ov-gold, #ffd76a) 50%, transparent);
}

/* ===== 设置面板（鎏金风） ===== */
.sb-settings-panel {
  position: absolute;
  top: 62px;
  right: 12px;
  width: 360px;
  background: linear-gradient(180deg, var(--bg-panel, rgba(18, 14, 8, 0.97)) 0%, var(--bg-card, rgba(12, 10, 6, 0.97)) 100%);
  border: 1px solid var(--border, rgba(212, 175, 55, 0.5));
  border-radius: 10px;
  padding: 14px;
  pointer-events: auto;
  box-shadow:
    0 0 24px rgba(0, 0, 0, 0.5),
    0 8px 32px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 color-mix(in srgb, var(--accent-2, #ffd76a) 12%, transparent);
  max-height: calc(100vh - 90px);
  overflow-y: auto;
}
.sb-settings-panel::-webkit-scrollbar { width: 4px; }
.sb-settings-panel::-webkit-scrollbar-track { background: transparent; }
.sb-settings-panel::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--accent, #ffd76a) 30%, transparent);
  border-radius: 2px;
}

.sb-settings-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--accent, #ffd76a);
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--ov-gold, #ffd76a) 20%, transparent);
  letter-spacing: 0.5px;
  text-shadow: 0 0 8px color-mix(in srgb, var(--ov-gold, #ffd76a) 30%, transparent);
}
.sb-settings-section {
  margin-bottom: 14px;
}
.sb-settings-subtitle {
  font-size: 12px;
  color: var(--accent-2, #00e8d8);
  margin-bottom: 6px;
  font-weight: 600;
}
.sb-settings-hint {
  font-size: 10.5px;
  color: var(--ov-text-muted, #7a6f52);
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
  color: var(--ov-text-dim, #b8a878);
  cursor: pointer;
  border-radius: 5px;
  transition: all 0.2s;
}
.sb-setting-item:hover {
  background: color-mix(in srgb, var(--ov-gold, #ffd76a) 8%, transparent);
  color: var(--ov-gold, #ffd76a);
}
.sb-setting-item input[type="checkbox"] {
  accent-color: var(--ov-gold, #d4af37);
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
  color: var(--accent-2, #00e8d8);
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
  border: 1px solid color-mix(in srgb, var(--ov-gold, #ffd76a) 25%, transparent);
  background: color-mix(in srgb, var(--ov-gold, #ffd76a) 10%, rgba(30, 25, 15, 0.6));
  color: var(--ov-text-dim, #b8a878);
  cursor: pointer;
  transition: all 0.2s;
  text-align: left;
}
.sb-strategy-btn:hover {
  border-color: color-mix(in srgb, var(--ov-gold, #ffd76a) 50%, transparent);
  background: color-mix(in srgb, var(--ov-gold, #ffd76a) 18%, rgba(50, 40, 20, 0.7));
  color: var(--ov-gold, #ffd76a);
}
.sb-strategy-btn.active {
  border-color: color-mix(in srgb, var(--accent-2, #00e8d8) 60%, transparent);
  background: color-mix(in srgb, var(--accent-2, #00e8d8) 20%, rgba(0, 60, 55, 0.5));
  color: var(--accent-2, #00e8d8);
  box-shadow: 0 0 10px color-mix(in srgb, var(--accent-2, #00e8d8) 20%, transparent);
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
  border: 1px solid color-mix(in srgb, var(--ov-gold, #ffd76a) 10%, transparent);
}
.sb-perf-label {
  font-size: 10.5px;
  color: var(--ov-text-muted, #7a6f52);
  margin-bottom: 3px;
}
.sb-perf-value {
  font-size: 15px;
  font-weight: 700;
  font-family: Consolas, monospace;
}
.sb-perf-value.up { color: #ff6478; }
.sb-perf-value.down { color: #00e8a0; }
.sb-perf-value.neutral { color: var(--accent, #ffd76a); }
</style>
