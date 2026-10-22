<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit as tauriEmit, type UnlistenFn } from "@tauri-apps/api/event";
import { openInAppBrowser } from "../utils/openInApp";
import { useTheme, type ThemeId } from "../composables/useTheme";
import { useAccessibility } from "../composables/useAccessibility";

import { useSkins } from "../composables/useSkins";
import { useNovice } from "../composables/useNovice";
import { useWindowControls } from "../composables/useWindowControls";
import { tsStatus } from "../composables/useTimeSeries";
import { collectorStatus } from "../composables/useCollector";
import { logger, type LogLevel } from "../utils/logger";
import { toast } from "../composables/useToast";
import { isEnabled as autoStartEnabled, enable as enableAutoStart, disable as disableAutoStart } from "@tauri-apps/plugin-autostart";
import {
  brokerGetStatus,
  brokerGetConfig,
  brokerSetConfig,
  brokerEnableLive,
  brokerConnect,
  brokerDisconnect,
  brokerOcrEngine,
  brokerEmergencyHalt,
  brokerReleaseKill,
  mockSeedPosition,
  mockReset,
  brokerClientSelfcheck,
  brokerLiveWhitelistSet,
  brokerLiveMarkDrill,
  brokerLiveUsage,
  brokerProbePaths,
  type BrokerStatus,
  type BrokerOcrStatus,
  type ProbeResult,
  type PathProbe,
  type BrokerConfigFull,
  type ClientSelfcheck,
  type LiveUsage,
} from "../broker/api";
import {
  pluginList,
  pluginScan,
  pluginInstall,
  pluginEnable,
  pluginDisable,
  pluginUninstall,
  pluginReload,
  pluginGetDevMode,
  pluginSetDevMode,
  pluginL2SetKey,
  pluginL2KeySet,
  pluginL2ClearKey,
  type PluginRow,
} from "../plugin/api";
import {
  getAiConfig,
  saveAiConfig,
  getCloudKeySet,
  setCloudKey,
  clearCloudKey,
  testConnection as testAiConnection,
  kbStats as fetchKbStats,
  listDocs,
  importDocs as invokeImportDocs,
  deleteDoc as invokeDeleteDoc,
  reindex as invokeReindex,
  indexDaily,
  autoexecGetConfig,
  autoexecSetConfig,
  layaHealth,
} from "../ai/api";
import type { AiConfig, ConnTest, KbStats, IndexProgress } from "../ai/types";
import type { AutoExecConfigInfo } from "../ai/api";
import { ISLAND_SKINS, getIslandSkin, setIslandSkin, applyIslandSkin, ISLAND_SKIN_EVENT, type IslandSkinId } from "../lib/islandSkins";
import { usePaperStore } from "../stores/paper";
import { useWatchlistStore } from "../stores/watchlist";
import { fetchRankBoard, snapshotSectorDay, sectorDayStats } from "../api/market";
import {
  createBackup, listBackups, writeBackupConfig, restoreBackup, deleteBackup,
  takePendingBackupConfig,
  type BackupSetInfo,
} from "../api/backup";
import { exit as exitApp } from "@tauri-apps/plugin-process";
import { confirmDialog } from "../composables/useDialog";
import { confirmEmergencyHalt, formatEmergencyHaltResult } from "../composables/emergencyHalt";
import { useLicenseStore } from "../stores/license";
import { planLabel } from "../lib/license";

const props = defineProps<{ open: boolean; initialTab?: Tab }>();
const emit = defineEmits<{ "update:open": [boolean]; "replay-onboarding": []; "check-update": [] }>();
function close() {
  emit("update:open", false);
}

const { theme, setTheme, THEMES } = useTheme();
const { zoom, highContrast, setZoom, setHighContrast, ZOOM_LEVELS } = useAccessibility();

const { curVersion } = useWindowControls();
const skinsApi = useSkins();
const noviceApi = useNovice();

// 灵动岛皮肤
const islandSkin = ref<IslandSkinId>(getIslandSkin());
function pickIslandSkin(id: IslandSkinId) {
  islandSkin.value = id;
  setIslandSkin(id);
  applyIslandSkin(); // 主窗口自己也应用（虽然主窗口不一定用这些变量，但保持一致）
  tauriEmit(ISLAND_SKIN_EVENT, id); // 通知灵动岛窗口
}

// 皮肤预览色块：表面 / 左条渐变 / 辉光
function skinSw(s: import("../lib/skin").SkinSpec): string[] {
  const t = s.tokens;
  return [
    t.surface?.bg ?? "#15181d",
    t.leftBar?.from ?? "#888",
    t.leftBar?.to ?? t.leftBar?.from ?? "#555",
    t.glow?.rest?.color ?? t.glow?.accent ?? "#333",
  ];
}
const skinMsg = ref("");
async function onImportSkin() {
  skinMsg.value = "";
  try {
    const text = await invoke<string>("open_text_file", { filterName: "皮肤 JSON", ext: "json" });
    const id = await skinsApi.importSpec(JSON.parse(text));
    skinMsg.value = `已导入：${id}`;
  } catch (e) {
    skinMsg.value = `导入失败：${e}`;
  }
}
function onExportSkin(id: string) {
  const body = skinsApi.exportSpec(id);
  if (!body) return;
  invoke("save_export_file", { defaultName: `tickgold-skin-${id}.json`, content: body })
    .catch((e) => { skinMsg.value = `导出失败：${e}`; });
}
async function onDeleteSkin(id: string) {
  const ok = await skinsApi.remove(id);
  if (!ok) skinMsg.value = "内置皮肤不可删除";
}
function replayOnboarding() { close(); emit("replay-onboarding"); }

// ===== 开机自动启动 =====
const autoStart = ref(false);
const autoStartBusy = ref(false);
async function loadAutoStart() {
  try { autoStart.value = await autoStartEnabled(); } catch { /* ignore */ }
}
async function toggleAutoStart(v: boolean) {
  autoStartBusy.value = true;
  try {
    if (v) await enableAutoStart(); else await disableAutoStart();
    autoStart.value = v;
  } catch (e) {
    console.warn("[autostart]", e);
  } finally {
    autoStartBusy.value = false;
  }
}
void loadAutoStart();

type Tab = "pro" | "appearance" | "data" | "ai" | "autotrade" | "knowledge" | "broker" | "plugins" | "logs" | "about";
const tab = ref<Tab>("appearance");

// ===== Pro 订阅授权（v3.0.2 面包多卡密 · 离线验签）=====
const license = useLicenseStore();

// 当前应用版本号（关于页显示，来自后端 app_version 命令）
const appVersion = ref("");
void invoke<string>("app_version")
  .then((v) => (appVersion.value = v))
  .catch(() => {});

// 面包多购买链接
const PLAN_URLS = {
  monthly: "https://mbd.pub/o/bread/YZaVm59rbA==",
  quarterly: "https://mbd.pub/o/bread/YZaVm59rbQ==",
  annual: "https://mbd.pub/o/bread/YZaVmppuZg==",
};
const TOPUP_URLS = {
  500: "https://mbd.pub/o/bread/YZaVm51vZQ==",
  1000: "https://mbd.pub/o/bread/YZaVm59sZQ==",
  2000: "https://mbd.pub/o/bread/YZaVm59sZw==",
};
function goBuy(plan: keyof typeof PLAN_URLS = "annual") {
  void openInAppBrowser(PLAN_URLS[plan]);
}
function goBuyTopup(count: keyof typeof TOPUP_URLS = 1000) {
  void openInAppBrowser(TOPUP_URLS[count]);
}
const codeInput = ref("");
const actBusy = ref(false);
const actMsg = ref("");
async function onActivate() {
  actMsg.value = "";
  const c = codeInput.value.trim();
  if (!c) {
    actMsg.value = "请先粘贴激活码";
    return;
  }
  actBusy.value = true;
  try {
    const ok = await license.activate(c);
    actMsg.value = ok ? "激活成功，Pro 已生效" : (license.error || "激活失败");
    if (ok) codeInput.value = "";
  } finally {
    actBusy.value = false;
  }
}

// ===== Debug：清除激活码回到免费版（仅 dev 构建可见）=====
const IS_DEV = import.meta.env.DEV;
const clearBusy = ref(false);
async function onClearLicense() {
  const yes = await confirmDialog({
    title: "清除激活码",
    message: "将删除本地 Pro 授权与 AI 次数包，回到免费版状态。确定继续？",
    confirmText: "清除",
    danger: true,
  });
  if (!yes) return;
  clearBusy.value = true;
  try {
    await license.deactivate();
    await license.load();
  } finally {
    clearBusy.value = false;
  }
}

// ===== v3.4 设备绑定 / 换机授权 =====
const relocInput = ref("");
const relocBusy = ref(false);
const relocMsg = ref("");
async function onRelocate() {
  relocMsg.value = "";
  const c = relocInput.value.trim();
  if (!c) {
    relocMsg.value = "请先粘贴卖家给的换机授权码";
    return;
  }
  relocBusy.value = true;
  try {
    const ok = await license.relocate(c);
    relocMsg.value = ok ? "换机成功，Pro 已在本机生效" : (license.error || "换机失败");
    if (ok) relocInput.value = "";
  } finally {
    relocBusy.value = false;
  }
}
async function copyRelocReq() {
  const v = license.relocateRequest;
  if (!v) { relocMsg.value = "没有可复制的申请码"; return; }
  try {
    await navigator.clipboard.writeText(v);
    relocMsg.value = "申请码已复制，请发给卖家";
  } catch {
    relocMsg.value = "复制失败，请手动选择复制：" + v;
  }
}
watch(() => props.open, (v) => {
  if (v && props.initialTab) tab.value = props.initialTab;
});
function pick(id: ThemeId) {
  setTheme(id);
}
function fmtTime(ts: number) {
  return ts ? new Date(ts).toLocaleString() : "尚未采集";
}

// ===== 诊断日志（合并前端 logger 与 Rust 内存日志）=====
interface LogRow { ts: number; t: string; level: string; source: string; message: string; }
const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const logMin = ref<LogLevel>("info");
const logRows = ref<LogRow[]>([]);
const logMsg = ref("");

async function refreshLogs() {
  logMsg.value = "";
  const fe: LogRow[] = logger.entries(logMin.value).map((e) => ({
    ts: e.t, t: new Date(e.t).toLocaleTimeString(),
    level: e.level, source: e.source, message: e.message,
  }));
  let rust: LogRow[] = [];
  try {
    const items = await invoke<Array<{ ts: number; level: string; target: string; msg: string }>>(
      "rust_logs", { minLevel: logMin.value }
    );
    rust = items.map((i) => ({
      ts: i.ts, t: new Date(i.ts).toLocaleTimeString(),
      level: i.level, source: i.target, message: i.msg,
    }));
  } catch (e) {
    logMsg.value = `读取后端日志失败：${e}`;
  }
  logRows.value = [...rust, ...fe].sort((a, b) => a.ts - b.ts);
}
function onLevelChange(e: Event) {
  logMin.value = (e.target as HTMLSelectElement).value as LogLevel;
  refreshLogs();
}
async function clearLogs() {
  const ok = await confirmDialog({
    title: "清空日志",
    message: "将清空全部本地日志，可能影响后续问题排查。是否继续？",
    confirmText: "清空",
    danger: true,
  });
  if (!ok) return;
  logger.clear();
  try { await invoke("rust_clear_logs"); } catch { /* ignore */ }
  logRows.value = [];
  logMsg.value = "日志已清空";
}
async function exportLogs() {
  await refreshLogs();
  const lines = logRows.value.map(
    (r) => `[${new Date(r.ts).toLocaleString()}] [${r.level.toUpperCase()}] [${r.source}] ${r.message}`
  );
  const content = `TickGold 诊断日志  导出时间：${new Date().toLocaleString()}\n${lines.join("\n")}`;
  try {
    await invoke("save_export_file", {
      defaultName: `TickGold-logs-${Date.now()}.txt`,
      content,
    });
  } catch (e) {
    logMsg.value = `导出失败（${e}）`;
  }
}
// ===== AI 模型配置 =====
const DEFAULT_AI_CFG: AiConfig = {
  provider: "ollama",
  baseUrl: "http://localhost:11434",
  chatModel: "",
  embedModel: "",
  temperature: 0.4,
  enableAutoIndex: true,
  useBuiltin: true,
};
const aiCfg = ref<AiConfig>({ ...DEFAULT_AI_CFG });
const aiLoaded = ref(false);
const aiMsg = ref("");
const cloudKeySet = ref(false);
const cloudKeyInput = ref("");
const testingAi = ref(false);
const connResult = ref<ConnTest | null>(null);
// 拉取到的云端可用模型列表（测试连接后自动填充）
const availableModels = ref<string[]>([]);
const fetchingModels = ref(false);

// ===== Ollama 模型管理 =====
interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}
const ollamaInstalled = ref<OllamaModel[]>([]);
const ollamaLoading = ref(false);
const ollamaError = ref("");
const downloadingModel = ref("");
const downloadProgress = ref(0);

// 推荐模型列表（按显存档位）
const RECOMMENDED_MODELS = [
  { name: "qwen2.5:7b", size: "4.7GB", ram: "8GB+", desc: "通义千问 7B，中文最好，性价比首选" },
  { name: "qwen2.5:14b", size: "9GB", ram: "16GB+", desc: "通义千问 14B，效果更好，速度适中" },
  { name: "deepseek-r1:7b", size: "4.7GB", ram: "8GB+", desc: "DeepSeek R1 推理模型，逻辑强" },
  { name: "llama3.1:8b", size: "4.9GB", ram: "8GB+", desc: "Llama 3.1 8B，英文好，通用" },
];

async function refreshOllamaModels() {
  ollamaLoading.value = true;
  ollamaError.value = "";
  try {
    const base = aiCfg.value.baseUrl || "http://localhost:11434";
    const models = await invoke<OllamaModel[]>("ollama_list", { baseUrl: base });
    ollamaInstalled.value = models;
  } catch (e: any) {
    ollamaError.value = e?.message || "无法连接 Ollama，请确认已安装并运行 Ollama";
    ollamaInstalled.value = [];
  } finally {
    ollamaLoading.value = false;
  }
}

const downloadSpeed = ref(0);

async function pullOllamaModel(name: string) {
  downloadingModel.value = name;
  downloadProgress.value = 0;
  downloadSpeed.value = 0;
  try {
    const base = aiCfg.value.baseUrl || "http://localhost:11434";
    // 监听进度事件
    const unlisten = await listen<{ name: string; percent: number | null; status: string; completed: number; total: number; speed: number }>(
      "ollama:pull-progress",
      (e) => {
        if (e.payload.name === name) {
          if (e.payload.percent != null) {
            downloadProgress.value = e.payload.percent!;
          }
          if (e.payload.speed != null) {
            downloadSpeed.value = e.payload.speed;
          }
        }
      }
    );
    await invoke("ollama_pull", { baseUrl: base, name });
    unlisten();
    toast.success(`模型 ${name} 下载完成`);
    await refreshOllamaModels();
  } catch (e: any) {
    toast.error(`下载失败：${e?.message || e}`);
  } finally {
    downloadingModel.value = "";
    downloadProgress.value = 0;
    downloadSpeed.value = 0;
  }
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec > 1e6) return (bytesPerSec / 1e6).toFixed(1) + " MB/s";
  if (bytesPerSec > 1e3) return (bytesPerSec / 1e3).toFixed(0) + " KB/s";
  return bytesPerSec + " B/s";
}

async function removeOllamaModel(name: string) {
  try {
    const base = aiCfg.value.baseUrl || "http://localhost:11434";
    await invoke("ollama_delete", { baseUrl: base, name });
    toast.success(`已删除 ${name}`);
    await refreshOllamaModels();
  } catch (e: any) {
    toast.error(`删除失败：${e?.message || e}`);
  }
}

function formatSize(bytes: number) {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + "GB";
  if (bytes > 1e6) return (bytes / 1e6).toFixed(0) + "MB";
  return bytes + "B";
}

function openOllamaSite() {
  void openInAppBrowser("https://ollama.com/download");
}

// 快脑 / Laya 控制台
const DEFAULT_FB_CFG: AutoExecConfigInfo = {
  enabled: false,
  brainMode: "rule",
  layaUrl: "http://127.0.0.1:8788",
  hardStopPct: -7,
  execConfidence: 0.7,
  watchConfidence: 0.55,
  slippagePct: 0.1,
  maxSinglePct: 20,
  maxTotalPct: 60,
  noOpenAfter: "14:55",
  // ===== 风控设置 =====
  dailyLossLimitPct: 5,        // 单日亏 5% 停止
  maxDrawdownLimitPct: 20,     // 最大回撤 20% 清仓
  consecutiveLossLimit: 3,      // 连亏 3 笔暂停
  // ===== 全自动模式 =====
  fullAutoMode: false,          // 默认关闭全自动模式（兼容旧版）
  // ===== 交易模式（新）=====
  tradeMode: "semi",            // 默认半自动模式
  bridgeEnabled: false,
  bridgeDefaultBroker: "",
  bridgeBrokerPath: "",
  bridgeDefaultAction: "copy",
  bridgeTtlMinutes: 30,
  bridgePriceDeviatePct: 1,
  bridgeOrderTemplate: "",
  indicatorsEnabled: {},
};

// 规则脑 12 个指标定义
const indicatorList = [
  { key: "pct", name: "涨跌幅", desc: "当天涨跌 0~7% 最健康，太高追高风险大" },
  { key: "speed5m", name: "5分钟涨速", desc: "最近5分钟涨得快=资金涌入" },
  { key: "volumeRatio", name: "量比", desc: "1.5~3倍最佳，>5倍可能出货" },
  { key: "turnover", name: "换手率", desc: "3~9%活跃，>18%过热" },
  { key: "distToLimit", name: "距涨停距离", desc: "越接近涨停越强" },
  { key: "pullback", name: "分时回撤", desc: "从高点回落越少越强" },
  { key: "blastCount", name: "炸板次数", desc: "从涨停跌开，0次最好" },
  { key: "marketEmotion", name: "市场情绪", desc: "全市场涨停温度，>70分情绪好" },
  { key: "indexChg", name: "指数环境", desc: "大盘涨它也涨成功率高" },
  { key: "themeRank", name: "题材排名", desc: "所属板块今天涨前几名" },
  { key: "catalystFreshness", name: "催化新鲜度", desc: "刚出的利好比旧消息好" },
  { key: "mainNetInflowYi", name: "主力净流入", desc: "大单买入越多越涨" },
  { key: "macdHist", name: "MACD 金叉", desc: "DIF>DEA 金叉看多，死叉看空" },
  { key: "rsi14", name: "RSI 14日", desc: "40~65健康，>75超买该卖，<30超卖" },
  // K线深度分析
  { key: "maBullish", name: "均线多头排列", desc: "MA5>MA10>MA20=上涨趋势，强" },
  { key: "maBearish", name: "均线空头排列", desc: "MA5<MA10<MA20=下跌趋势，弱" },
  { key: "distToSupportPct", name: "距支撑位", desc: "离20天最低点越近越安全" },
  { key: "distToResistancePct", name: "距压力位", desc: "离20天最高点越远空间越大" },
  { key: "klineIsHammer", name: "锤子线形态", desc: "下影线长=见底信号，看涨" },
  { key: "klineIsBullishEngulfing", name: "看涨吞没", desc: "今天阳包阴=反转信号" },
  { key: "klineIsBearishEngulfing", name: "看跌吞没", desc: "今天阴包阳=见顶信号" },
  { key: "volRatio20", name: "20天量比", desc: "今天量 vs 20天均量，放量涨好" },
];

function toggleIndicator(key: string) {
  if (!fbCfg.value) return;
  if (!fbCfg.value.indicatorsEnabled) fbCfg.value.indicatorsEnabled = {};
  const cur = fbCfg.value.indicatorsEnabled[key] !== false; // 默认 true
  fbCfg.value.indicatorsEnabled[key] = !cur;
}

// 战法列表
const strategyList = [
  { key: "oversold", name: "超跌抄底", desc: "股票跌太多了，抄底买入" },
  { key: "leader", name: "龙头战法", desc: "买板块里最强的龙头股" },
  { key: "firstToSecond", name: "1进2", desc: "首板涨停后，第二天博弈二板" },
];

function toggleStrategy(key: string) {
  if (!fbCfg.value) return;
  if (!fbCfg.value.strategiesEnabled) fbCfg.value.strategiesEnabled = {};
  const cur = fbCfg.value.strategiesEnabled[key] !== false; // 默认 true
  fbCfg.value.strategiesEnabled[key] = !cur;
}

const paper = usePaperStore();

const fbCfg = ref<AutoExecConfigInfo | null>(null);
const fbMsg = ref("");
const fbHealth = ref("");
async function loadFastBrain() {
  const remote = await autoexecGetConfig();
  fbCfg.value = { ...DEFAULT_FB_CFG, ...(remote ?? {}) };
}
async function saveFastBrain() {
  if (!fbCfg.value) return;
  fbMsg.value = "";
  try {
    await autoexecSetConfig(fbCfg.value);
    fbMsg.value = "快脑参数已保存";
  } catch (e) {
    fbMsg.value = `保存失败：${e}`;
  }
}
async function checkLaya() {
  if (!fbCfg.value) return;
  fbHealth.value = "检查中…";
  try {
    const ms = await layaHealth(fbCfg.value.layaUrl);
    fbHealth.value = `在线 · 延迟 ${ms.toFixed(0)}ms`;
  } catch {
    fbHealth.value = "不可达，将自动使用规则脑";
  }
}

async function loadAiTab() {
  aiMsg.value = "";
  try {
    const remote = await getAiConfig();
    aiCfg.value = { ...DEFAULT_AI_CFG, ...(remote ?? {}) };
    cloudKeySet.value = await getCloudKeySet();
    await loadFastBrain();
    await ensureKbListener();
    await loadKb();
  } catch (e) {
    aiMsg.value = `加载失败：${e}`;
  } finally {
    aiLoaded.value = true;
  }
}
async function saveAiTab() {
  aiMsg.value = "";
  try {
    await saveAiConfig(aiCfg.value);
    aiMsg.value = "已保存";
  } catch (e) {
    aiMsg.value = `保存失败：${e}`;
  }
}
async function onTestAi() {
  testingAi.value = true;
  aiMsg.value = "";
  connResult.value = null;
  try {
    await saveAiConfig(aiCfg.value);
    connResult.value = await testAiConnection();
    availableModels.value = connResult.value.models ?? [];
    aiMsg.value = `连接成功 · 延迟 ${connResult.value.latencyMs}ms · 可用模型 ${connResult.value.models.length} 个，已填充到下拉框`;
  } catch (e) {
    aiMsg.value = `连接失败：${e}`;
    availableModels.value = [];
  } finally {
    testingAi.value = false;
  }
}

function pickAi(p: "ollama" | "cloud") {
  aiCfg.value.useBuiltin = false;
  aiCfg.value.provider = p;
  if (p === "ollama") void refreshOllamaModels();
}

/** 单独拉取模型列表（不强制保存配置），用于手动刷新下拉选项 */
async function onFetchModels() {
  if (aiCfg.value.provider === "cloud" && !cloudKeySet.value) {
    aiMsg.value = "请先填写并保存云端 API Key";
    return;
  }
  fetchingModels.value = true;
  aiMsg.value = "";
  try {
    await saveAiConfig(aiCfg.value);
    const r = await testAiConnection();
    availableModels.value = r.models ?? [];
    aiMsg.value = `已拉取 ${r.models.length} 个模型 · 延迟 ${r.latencyMs}ms`;
  } catch (e) {
    aiMsg.value = `拉取失败：${e}`;
    availableModels.value = [];
  } finally {
    fetchingModels.value = false;
  }
}
async function saveCloudKeyEv() {
  const k = cloudKeyInput.value.trim();
  if (!k) return;
  try {
    await setCloudKey(k);
    cloudKeySet.value = true;
    cloudKeyInput.value = "";
    aiMsg.value = "密钥已保存";
  } catch (e) {
    aiMsg.value = `密钥保存失败：${e}`;
  }
}
async function clearCloudKeyEv() {
  const ok = await confirmDialog({
    title: "清除云端密钥",
    message: "将清除已保存的云端 AI 服务密钥，清除后需重新输入才能使用相关功能。是否继续？",
    confirmText: "清除",
    danger: true,
  });
  if (!ok) return;
  try {
    await clearCloudKey();
    cloudKeySet.value = false;
    aiMsg.value = "密钥已清除";
  } catch (e) {
    aiMsg.value = `清除失败：${e}`;
  }
}

// ===== 知识库管理 =====
const kbData = ref<KbStats>({ total: 0, embedded: 0, bytesEstimate: 0, byType: [] });
const kbDocs = ref<Array<[string, number]>>([]);
const kbBusy = ref(false);
const kbIndexing = ref(false);
const kbProgress = ref<IndexProgress>({ phase: "", done: 0, total: 0 });
const kbProgPct = computed(() =>
  kbProgress.value.total > 0
    ? Math.min(100, Math.round((kbProgress.value.done / kbProgress.value.total) * 100))
    : 0
);
const kbSizeText = computed(() => {
  const b = kbData.value.bytesEstimate;
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
});
function kbTypeName(k: string): string {
  const map: Record<string, string> = {
    catalyst: "催化剂", theme: "题材", limitup: "涨停",
    announcement: "公告", note: "笔记", other: "其他",
  };
  return map[k] ?? k;
}
let unlistenKb: (() => void) | null = null;
async function ensureKbListener() {
  if (unlistenKb) return;
  unlistenKb = await listen<IndexProgress>("ai://index_progress", (ev) => {
    kbProgress.value = ev.payload;
    kbIndexing.value = true;
  });
}
async function loadKb() {
  try {
    const stats = (await fetchKbStats()) as Partial<KbStats> | null;
    kbData.value = {
      total: stats?.total ?? 0,
      embedded: stats?.embedded ?? 0,
      bytesEstimate: stats?.bytesEstimate ?? 0,
      byType: stats?.byType ?? [],
    };
    kbDocs.value = (await listDocs()) ?? [];
  } catch (e) {
    aiMsg.value = `知识库加载失败：${e}`;
  }
}
async function onImportDocs() {
  kbBusy.value = true; aiMsg.value = "";
  try {
    const added = await invokeImportDocs();
    aiMsg.value = added.length ? `已导入：${added.join("、")}` : "没有新增内容";
    await loadKb();
  } catch (e) {
    aiMsg.value = `导入失败：${e}`;
  } finally {
    kbBusy.value = false;
  }
}
async function onReindex() {
  kbBusy.value = true; kbIndexing.value = true; aiMsg.value = "";
  try {
    const n = await invokeReindex();
    aiMsg.value = `重建嵌入完成：${n} 块`;
    await loadKb();
  } catch (e) {
    aiMsg.value = `重建失败：${e}`;
  } finally {
    kbBusy.value = false; kbIndexing.value = false;
  }
}
async function onIndexToday() {
  kbBusy.value = true; kbIndexing.value = true; aiMsg.value = "";
  try {
    const n = await indexDaily(tradeDateStr(new Date()));
    aiMsg.value = `今日入库：${n} 块`;
    await loadKb();
  } catch (e) {
    aiMsg.value = `入库失败：${e}`;
  } finally {
    kbBusy.value = false; kbIndexing.value = false;
  }
}
async function onDeleteDoc(name: string) {
  try {
    await invokeDeleteDoc(name);
    aiMsg.value = `已删除：${name}`;
    await loadKb();
  } catch (e) {
    aiMsg.value = `删除失败：${e}`;
  }
}
function tradeDateStr(d: Date): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function pickTab(id: Tab) {
  tab.value = id;
  if (id === "logs") refreshLogs();
  if (id === "data" && !histLoaded.value) void loadHistTab();
  if (id === "ai" && !aiLoaded.value) void loadAiTab();
  if (id === "autotrade" && !fbCfg.value) void loadFastBrain(); // 第一次打开AI操盘手时加载配置
  if (id === "broker" && !brokerLoaded.value) void loadBrokerTab();
  if (id === "plugins") void loadPluginsTab();
}

// ===== 数据治理（v2.29）=====
interface StorageStatsInfo {
  totalBytes: number;
  files: { name: string; size: number; kind: string }[];
  tableRows: [string, number][];
}
const storageStats = ref<StorageStatsInfo | null>(null);
const govBusy = ref(false);
const govMsg = ref("");

async function loadStorageStats() {
  govBusy.value = true;
  govMsg.value = "";
  try {
    storageStats.value = await invoke<StorageStatsInfo>("storage_stats");
  } catch (e) {
    govMsg.value = `统计失败：${e}`;
  } finally {
    govBusy.value = false;
  }
}

async function onCleanupOrphans() {
  govMsg.value = "";
  govBusy.value = true;
  try {
    const [n, bytes] = await invoke<[number, number]>("storage_cleanup_orphans");
    govMsg.value = n ? `清理 ${n} 个孤儿文件，释放 ${fmtBytes(bytes)}` : "没有可清理的孤儿文件";
    await loadStorageStats();
  } catch (e) {
    govMsg.value = `清理失败：${e}`;
  } finally {
    govBusy.value = false;
  }
}

async function onVacuum() {
  const ok = await confirmDialog({
    title: "压缩主库",
    message: "将对主数据库执行 VACUUM 回收空闲页，期间界面可能短暂卡顿。继续？",
  });
  if (!ok) return;
  govBusy.value = true;
  govMsg.value = "";
  try {
    const size = await invoke<number>("storage_vacuum");
    govMsg.value = `压缩完成，主库当前 ${fmtBytes(size)}`;
    await loadStorageStats();
  } catch (e) {
    govMsg.value = `压缩失败：${e}`;
  } finally {
    govBusy.value = false;
  }
}

// ===== 过期数据策略（v2.29）=====
interface PurgeTargetInfo { key: string; label: string; cutoff: string; rows: number }
interface PurgePlanInfo {
  intradayCutoff: string;
  aiCutoffMs: number;
  targets: PurgeTargetInfo[];
  totalRows: number;
}
const keepIntradayDays = ref(60);
const keepAiDays = ref(180);
const purgePlan = ref<PurgePlanInfo | null>(null);

async function onPurgePreview() {
  govMsg.value = "";
  govBusy.value = true;
  try {
    purgePlan.value = await invoke<PurgePlanInfo>("storage_purge_preview", {
      keepIntradayDays: Number(keepIntradayDays.value) || 0,
      keepAiDays: Number(keepAiDays.value) || 0,
    });
  } catch (e) {
    govMsg.value = `预览失败：${e}`;
  } finally {
    govBusy.value = false;
  }
}

async function onPurgeRun() {
  if (!purgePlan.value || purgePlan.value.totalRows <= 0) {
    govMsg.value = "没有可清理的过期数据";
    return;
  }
  const ok = await confirmDialog({
    title: "清理过期数据",
    message: `将删除 ${purgePlan.value.totalRows} 行过期数据（分时 / 知识库 / 历史对话）。删除前建议先在备份中心创建备份。继续？`,
  });
  if (!ok) return;
  govBusy.value = true;
  govMsg.value = "";
  try {
    const plan = await invoke<PurgePlanInfo>("storage_purge_run", {
      keepIntradayDays: Number(keepIntradayDays.value) || 0,
      keepAiDays: Number(keepAiDays.value) || 0,
    });
    govMsg.value = `清理完成，共删除 ${plan.totalRows} 行过期数据`;
    purgePlan.value = plan;
    await loadStorageStats();
  } catch (e) {
    govMsg.value = `清理失败：${e}`;
  } finally {
    govBusy.value = false;
  }
}

// ===== 备份 / 恢复中心（v2.29）=====
const backupSets = ref<BackupSetInfo[]>([]);
const backupBusy = ref(false);
const backupMsg = ref("");

function fmtBackupTime(ms: number): string {
  if (!ms) return "未知时间";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 导出 localStorage 配置快照（自选 / 布局 / 皮肤 / 设置等均存于其中） */
function exportLocalConfig(): string {
  const dump: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k) dump[k] = localStorage.getItem(k) ?? "";
  }
  return JSON.stringify({ v: 1, exportedAt: Date.now(), data: dump });
}

/** 重启后若有暂存配置快照则取回并还原（先不覆盖已存在键？恢复语义=整体覆盖） */
async function applyPendingConfigRestore() {
  try {
    const json = await takePendingBackupConfig();
    if (!json) return;
    const parsed = JSON.parse(json) as { data?: Record<string, string> };
    if (!parsed.data) return;
    localStorage.clear();
    for (const [k, v] of Object.entries(parsed.data)) localStorage.setItem(k, v);
    backupMsg.value = "配置已从备份恢复";
  } catch { /* ignore */ }
}

async function loadBackupSets() {
  try {
    backupSets.value = await listBackups();
  } catch (e) {
    backupMsg.value = `备份列表读取失败：${e}`;
  }
}

async function onCreateBackup() {
  backupMsg.value = "";
  backupBusy.value = true;
  try {
    const set = await createBackup();
    await writeBackupConfig(set.id, exportLocalConfig());
    backupMsg.value = "备份完成";
    await loadBackupSets();
  } catch (e) {
    backupMsg.value = `备份失败：${e}`;
  } finally {
    backupBusy.value = false;
  }
}

async function onRestoreBackup(b: BackupSetInfo) {
  const ok = await confirmDialog({
    title: "恢复备份",
    danger: true,
    confirmText: "恢复并重启",
    message: `将恢复到 ${fmtBackupTime(b.createdMs)} 的备份，应用会自动退出并重启，当前未备份的改动会丢失。确认恢复？`,
  });
  if (!ok) return;
  backupBusy.value = true;
  backupMsg.value = "";
  try {
    await restoreBackup(b.id);
    await exitApp(0);
  } catch (e) {
    backupBusy.value = false;
    backupMsg.value = `恢复失败：${e}`;
  }
}

async function onDeleteBackup(b: BackupSetInfo) {
  const ok = await confirmDialog({ title: "删除备份", danger: true, message: `删除 ${fmtBackupTime(b.createdMs)} 的备份？` });
  if (!ok) return;
  try {
    await deleteBackup(b.id);
    await loadBackupSets();
  } catch (e) {
    backupMsg.value = `删除失败：${e}`;
  }
}

// ===== 板块日级快照（v2.29）=====
const sectorDayCount = ref(0);
const sectorDayInput = ref("");
const sectorDayBusy = ref(false);
const sectorDayMsg = ref("");

async function refreshSectorDayStats() {
  try {
    sectorDayCount.value = await sectorDayStats();
  } catch { /* ignore */ }
}

async function onSectorDaySnapshot() {
  const day = sectorDayInput.value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    sectorDayMsg.value = "日期格式应为 YYYY-MM-DD";
    return;
  }
  sectorDayMsg.value = "";
  sectorDayBusy.value = true;
  try {
    const n = await snapshotSectorDay(day);
    sectorDayMsg.value = `${day} 补采完成，写入 ${n} 个板块`;
    await refreshSectorDayStats();
  } catch (e) {
    sectorDayMsg.value = `补采失败：${e}`;
  } finally {
    sectorDayBusy.value = false;
  }
}

// ===== 多年历史 K 线库（v2.27）=====
type HistAdj = "qfq" | "hfq" | "none";
interface HistProgressInfo {
  running: boolean; total: number; done: number; ok: number; fail: number; lastCode: string;
}
interface HistStatsInfo {
  rows: number; codes: number; earliest: string | null; latest: string | null;
  calendarDays: number; dbSizeBytes: number;
}
interface BackfillResultInfo {
  requested: number; ok: number; fail: number; stopped: boolean; failures: string[];
}

const histLoaded = ref(false);
const histStats = ref<HistStatsInfo | null>(null);
const histProgress = ref<HistProgressInfo | null>(null);
const histMsg = ref("");
const histBusy = ref(false);
const histScope = ref<"watchlist" | "all" | "custom">("watchlist");
const histAdj = ref<HistAdj>("qfq");
const histYears = ref(5);
const histCustom = ref("");
const histLastFailures = ref<string[]>([]);
let histPoll: ReturnType<typeof setInterval> | undefined;
onUnmounted(() => {
  stopHistPoll();
  unlistenBroker?.();
  unlistenBroker = null;
});

const histPercent = computed(() => {
  const p = histProgress.value;
  return p && p.total > 0 ? Math.min(100, (p.done / p.total) * 100) : 0;
});

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

async function loadHistTab() {
  histLoaded.value = true;
  await applyPendingConfigRestore();
  await loadStorageStats();
  await loadBackupSets();
  await refreshHistStats();
  await refreshSectorDayStats();
  try {
    histProgress.value = await invoke<HistProgressInfo>("hist_backfill_status");
    if (histProgress.value.running) startHistPoll();
  } catch {
    /* ignore */
  }
}

async function refreshHistStats() {
  try {
    histStats.value = await invoke<HistStatsInfo>("hist_stats");
  } catch (e) {
    histMsg.value = `统计读取失败：${e}`;
  }
}

function startHistPoll() {
  if (histPoll !== undefined) return;
  histPoll = setInterval(async () => {
    try {
      histProgress.value = await invoke<HistProgressInfo>("hist_backfill_status");
      if (!histProgress.value.running) stopHistPoll();
    } catch {
      /* ignore */
    }
  }, 1000);
}

function stopHistPoll() {
  if (histPoll !== undefined) {
    clearInterval(histPoll);
    histPoll = undefined;
  }
}

async function resolveHistCodes(): Promise<string[]> {
  if (histScope.value === "watchlist") {
    return useWatchlistStore().codes;
  }
  if (histScope.value === "custom") {
    return histCustom.value.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
  }
  // 全市场：成交额榜分页拉全 A（约 5000+ 只）
  const out: string[] = [];
  for (let page = 1; page <= 80; page++) {
    const rows = await fetchRankBoard("amount", page, 100);
    if (!rows.length) break;
    out.push(...rows.map((r) => r.code));
    if (rows.length < 100) break;
  }
  return [...new Set(out)];
}

async function onHistBackfill() {
  histMsg.value = "";
  histBusy.value = true;
  let codes: string[];
  try {
    codes = await resolveHistCodes();
  } catch (e) {
    histBusy.value = false;
    histMsg.value = `股票范围获取失败：${e}`;
    return;
  }
  if (!codes.length) {
    histBusy.value = false;
    histMsg.value = "没有可回填的股票，请先加入自选或填写代码";
    return;
  }
  startHistPoll();
  try {
    const r = await invoke<BackfillResultInfo>("hist_backfill", {
      codes,
      years: histYears.value,
      adj: histAdj.value,
      period: 101,
    });
    histLastFailures.value = r.failures;
    histMsg.value = r.stopped
      ? `已停止：成功 ${r.ok} / 失败 ${r.fail}`
      : `回填完成：成功 ${r.ok} / 失败 ${r.fail}（共 ${r.requested} 只）`;
  } catch (e) {
    histMsg.value = `回填失败：${e}`;
  } finally {
    histBusy.value = false;
    stopHistPoll();
    try {
      histProgress.value = await invoke<HistProgressInfo>("hist_backfill_status");
    } catch {
      /* ignore */
    }
    await refreshHistStats();
  }
}

async function onHistStop() {
  try {
    await invoke("hist_backfill_stop");
    histMsg.value = "正在停止…未派发的股票将跳过";
  } catch (e) {
    histMsg.value = `停止失败：${e}`;
  }
}

async function onHistRetry() {
  const codes = histLastFailures.value
    .map((f) => f.split(":")[0].trim())
    .filter((c) => /^\d{6}$/.test(c));
  if (!codes.length) {
    histMsg.value = "没有可重试的失败代码";
    return;
  }
  histScope.value = "custom";
  histCustom.value = codes.join(",");
  await onHistBackfill();
}

async function onHistSyncCalendar() {
  try {
    const n = await invoke<number>("hist_sync_calendar");
    histMsg.value = `交易日历已同步：${n} 个交易日`;
    await refreshHistStats();
  } catch (e) {
    histMsg.value = `交易日历同步失败：${e}`;
  }
}

// ===== 券商交易（v2.6）=====
const brokerLoaded = ref(false);
const bStatus = ref<BrokerStatus | null>(null);
const bForm = ref<BrokerConfigFull | null>(null);
const bMsg = ref("");
const seedForm = reactive({ code: "", vol: 1000, price: 10 });
function bFlash(m: string) {
  bMsg.value = m;
}
// P3 同花顺客户端通道：连接自检结果
const bSelfcheck = ref<ClientSelfcheck | null>(null);
const bConnectBusy = ref(false);
const bDisconnectBusy = ref(false);
const bSelfcheckBusy = ref(false);
async function bRefreshSelfcheck() {
  bSelfcheckBusy.value = true;
  try {
    // 未连接：先做本机路径自检（Python / 客户端 / OCR，不依赖 sidecar），让「刷新自检」点一下就有结果
    if (!bStatus.value?.connected && bForm.value) {
      bProbe.value = await brokerProbePaths(bForm.value.kind, {
        pythonPath: bForm.value.pythonPath,
        clientPath: bForm.value.clientPath,
      });
      const sum = bProbeSummary.value;
      if (sum) {
        bFlash(sum + (bProbe.value?.summary.bad ? "；修复后点「保存并连接」即可连接" : "；点「保存并连接」即可开始"));
      } else {
        bFlash("自检无结果：请先点「保存并连接」连接通道");
      }
      return;
    }
    const sc = await brokerClientSelfcheck();
    bSelfcheck.value = sc && (sc.vendor || (sc.checks && sc.checks.length)) ? sc : null;
    if (!sc || !(sc.vendor || (sc.checks && sc.checks.length))) {
      bFlash("连接自检无结果：通道未连接或 sidecar 未运行，请先点「保存并连接」");
    }
  } catch (e) {
    bSelfcheck.value = null;
    bFlash(`自检失败：${e}`);
  } finally {
    bSelfcheckBusy.value = false;
  }
}
// broker:sidecar / broker:sidecar_error 实时联动（连接结果不再靠轮询猜）
let unlistenBroker: (() => void) | null = null;
// 连接失败原因（sidecar stderr / fatal 透传），状态条红条展示
const bSidecarErr = ref("");
async function ensureBrokerListener() {
  if (unlistenBroker) return;
  const offs: UnlistenFn[] = [];
  offs.push(
    await listen("broker:sidecar", (ev) => {
      const e = (ev.payload as { event?: string })?.event;
      if (e === "connected") {
        bMsg.value = "";
        bSidecarErr.value = "";
        void refreshBStatus();
        void bRefreshSelfcheck();
        bFlash("交易通道已连接");
      } else if (e === "disconnected") {
        void refreshBStatus();
        bFlash("交易通道已断开");
      }
    })
  );
  offs.push(
    await listen("broker:sidecar_error", (ev) => {
      const payload = ev.payload as { message?: string; fatal?: boolean };
      bSidecarErr.value = payload.message ?? "交易通道异常";
      bFlash(payload.message ?? "交易通道异常");
      if (payload.fatal) void refreshBStatus();
    })
  );
  unlistenBroker = () => offs.forEach((u) => u());
}
// P8 券商路径一键自检（本机探测，不依赖 sidecar）
const bProbe = ref<ProbeResult | null>(null);
const bProbeBusy = ref(false);
async function bProbeRun() {
  if (!bForm.value) return;
  bProbeBusy.value = true;
  try {
    bProbe.value = await brokerProbePaths(bForm.value.kind, {
        pythonPath: bForm.value.pythonPath,
        clientPath: bForm.value.clientPath,
      });
  } catch (e) {
    bProbe.value = null;
    bFlash(`路径自检失败：${e}`);
  } finally {
    bProbeBusy.value = false;
  }
}
function bProbeItem(field: string): PathProbe | null {
  return bProbe.value?.probes.find((p) => p.field === field) ?? null;
}
function bProbeClass(field: string): string {
  const p = bProbeItem(field);
  if (!p) return "";
  return p.status === "ok" ? "ok" : p.status === "empty" ? "warn" : "bad";
}
function bProbeText(field: string): string {
  const p = bProbeItem(field);
  if (!p) return "未检查";
  if (p.status === "ok") return "✓ 可用";
  if (p.status === "empty") return "⚠ 未配置";
  return "✗ 路径无效";
}
function bProbeHint(field: string): string {
  return bProbeItem(field)?.hint ?? "";
}
// P12-11 OCR 引擎管理（ddddocr 探测/安装/卸载）
const bOcrStatus = ref<BrokerOcrStatus | null>(null);
const bOcrBusy = ref(false);
async function bOcrManage(action: "status" | "install" | "uninstall") {
  if (bOcrBusy.value) return;
  bOcrBusy.value = true;
  try {
    const r = await brokerOcrEngine(action);
    if (action === "status") {
      bOcrStatus.value = r;
      bFlash(r.installed ? `内置引擎 ddddocr v${r.version} 已就绪` : "内置引擎未安装：点「安装 / 升级」即可启用自动识别");
    } else {
      bFlash(r.message || "完成");
    }
  } catch (e) {
    bFlash(String(e));
  } finally {
    bOcrBusy.value = false;
  }
}

/** 探测当前模式全部路径；某字段有建议值则自动填入。 */
async function bProbeFill(field: string) {
  if (!bForm.value || bProbeBusy.value) return;
  bProbeBusy.value = true;
  try {
    bProbe.value = await brokerProbePaths(bForm.value.kind, {
        pythonPath: bForm.value.pythonPath,
        clientPath: bForm.value.clientPath,
      });
    const p = bProbe.value?.probes.find((x) => x.field === field);
    if (p && p.status !== "ok" && p.suggested) {
      (bForm.value as unknown as Record<string, unknown>)[field] = p.suggested;
      bFlash(`已填入自动探测路径：${p.suggested}`);
    } else if (p && p.status === "ok") {
      bFlash(`${p.label} 已可用`);
    } else if (p) {
      bFlash(`${p.label}：${p.hint}`);
    }
  } catch (e) {
    bFlash(`路径探测失败：${e}`);
  } finally {
    bProbeBusy.value = false;
  }
}
const bProbeSummary = computed(() => {
  const s = bProbe.value?.summary;
  return s ? `路径自检：${s.ok} 项可用 · ${s.bad} 项待处理` : "";
});

// 真实通道（非模拟）强制半自动，自动确认仅模拟环境可开
function toggleClientAuto() {
  if (!bForm.value || !bForm.value.clientSim) return;
  bForm.value.clientAutoConfirm = !bForm.value.clientAutoConfirm;
}
// P12-5 通道二选一：本地模拟（内置虚拟账户，dry-run）/ 实盘（同花顺客户端真实通道）
function bPickChannel(ch: "mock" | "live") {
  if (!bForm.value) return;
  if (ch === "mock") {
    bForm.value.kind = "mock";
    bForm.value.clientDryRun = true; // 本地模拟 = sidecar 内置虚拟账户，不操控客户端
    bForm.value.clientAutoConfirm = true; // 模拟默认全自动
  } else {
    bForm.value.kind = "client";
    bForm.value.clientSim = false; // 实盘强制真实通道
    bForm.value.clientDryRun = false; // 实盘真操控同花顺客户端
    bForm.value.clientAutoConfirm = false; // 实盘强制确认桥
  }
  bFlash(ch === "mock" ? "已选本地模拟：内置虚拟资金，无需券商环境，可全自动练手联调" : "已选实盘：操控同花顺真实账户，真实委托需人工确认，未武装前不会提交");
}

// ===== P4 实盘武装向导 =====
const liveUsage = ref<LiveUsage | null>(null);
const wlInput = ref("");
const armAckText = ref("");
const armBusy = ref(false);
// P0-4 合规逐项确认（武装前必勾；存 localStorage，便于重开仍保留已读状态）
const COMPLIANCE_KEY = "tickgold_live_compliance_v1";
const COMPLIANCE_ITEMS = [
  "我知道本系统通过界面自动化操作同花顺客户端，属非官方接口，可能违反券商软件使用协议，存在被更新或风控阻断的风险",
  "我知道程序化交易达到报备标准（申报笔数/瞬时速率等阈值，以交易所及券商最新口径为准）时，须事先向开户券商报备，我将自行咨询并完成",
  "我仅对本人自有账户使用，不代他人操作、不向他人提供买卖建议并收费；所有信号仅供研究参考，不构成投资建议，盈亏自负",
];
const complianceAck = ref<boolean[]>([false, false, false]);
try {
  const saved = JSON.parse(localStorage.getItem(COMPLIANCE_KEY) || "null");
  if (Array.isArray(saved) && saved.length === COMPLIANCE_ITEMS.length) {
    complianceAck.value = saved.map(Boolean);
  }
} catch { /* ignore */ }
const complianceAll = computed(() => complianceAck.value.every(Boolean));
function toggleCompliance(i: number) {
  if (!complianceAck.value[i]) {
    // 勾一项确认一次（避免误勾），与演练一致用原生 checkbox + 即时记忆
  }
  complianceAck.value[i] = !complianceAck.value[i];
  localStorage.setItem(COMPLIANCE_KEY, JSON.stringify(complianceAck.value));
  armError.value = ""; armErrorOk.value = false;
}
const armError = ref("");
const armErrorOk = ref(false);
const isLiveChannel = computed(() => {
  const f = bForm.value;
  return !!f && (f.kind === "qmt" || (f.kind === "client" && !f.clientSim));
});
const wlList = computed<string[]>(() => bForm.value?.liveCodesWhitelist ?? []);
function bFmtMoney(n: number) {
  return `${(Number(n) || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 })} 元`;
}
function bare6(raw: string) {
  const d = (raw || "").replace(/\D/g, "");
  return d.length >= 6 ? d.slice(-6) : d;
}
async function refreshLiveUsage() {
  if (!isLiveChannel.value) {
    liveUsage.value = null;
    return;
  }
  try {
    liveUsage.value = await brokerLiveUsage();
  } catch {
    liveUsage.value = null;
  }
}
async function bAddWhitelist() {
  if (!bForm.value) return;
  const code = bare6(wlInput.value);
  if (!/^\d{6}$/.test(code)) {
    bFlash("请输入 6 位数字证券代码");
    return;
  }
  if (bForm.value.liveCodesWhitelist.includes(code)) {
    bFlash("该代码已在白名单");
    wlInput.value = "";
    return;
  }
  try {
    const next = await brokerLiveWhitelistSet([...bForm.value.liveCodesWhitelist, code]);
    bForm.value.liveCodesWhitelist = next;
    wlInput.value = "";
    bFlash(`已加入白名单 ${code}（武装后改动将自动解除武装）`);
    await refreshLiveUsage();
  } catch (e) {
    bFlash(String(e));
  }
}
async function bRemoveWhitelist(code: string) {
  if (!bForm.value) return;
  try {
    const next = await brokerLiveWhitelistSet(
      bForm.value.liveCodesWhitelist.filter((c) => c !== code),
    );
    bForm.value.liveCodesWhitelist = next;
    bFlash(`已移出白名单 ${code}（若已武装将自动解除）`);
    await refreshLiveUsage();
  } catch (e) {
    bFlash(String(e));
  }
}
async function bToggleDrill() {
  if (!bForm.value) return;
  const next = !bForm.value.liveSimDrillPassed;
  if (next) {
    const ok = await confirmDialog({
      title: "确认模拟演练已完成",
      danger: true,
      confirmText: "我已完成模拟演练",
      message:
        "请确认你已在同花顺「模拟炒股」中完成真机演练：登录、半自动连续成功若干笔、撤单、资产/持仓回报均正常。\n\n勾选后才可武装真实通道。确认勾选？",
    });
    if (!ok) return;
  }
  try {
    await brokerLiveMarkDrill(next);
    bForm.value.liveSimDrillPassed = next;
    bFlash(next ? "模拟演练已标记通过" : "已撤销模拟演练标记");
    await refreshLiveUsage();
  } catch (e) {
    bFlash(String(e));
  }
}
async function bSaveLiveLimits() {
  if (!bForm.value) return;
  const single = Number(bForm.value.liveMaxOrderAmount);
  const daily = Number(bForm.value.liveMaxDailyAmount);
  if (!(single >= 0) || !(daily >= 0)) {
    bFlash("限额须为不小于 0 的数字");
    return;
  }
  if (single > 0 || daily > 0) {
    const ok = await confirmDialog({
      title: "保存实盘限额",
      danger: true,
      confirmText: "保存限额",
      message: `单笔上限 ${single.toLocaleString("zh-CN")} 元、单日累计买入上限 ${daily.toLocaleString("zh-CN")} 元。\n\n任一为 0 时实盘保持锁定；修改安全参数后若已武装将自动解除。确认保存？`,
    });
    if (!ok) return;
  }
  try {
    await brokerSetConfig({ liveMaxOrderAmount: single, liveMaxDailyAmount: daily });
    bFlash("实盘限额已保存");
    await refreshLiveUsage();
  } catch (e) {
    bFlash(String(e));
  }
}
async function bArm() {
  if (!bForm.value) return;
  armError.value = "";
  armErrorOk.value = false;
  if (!license.isPro) {
    armError.value = "真实通道接入为 Pro 订阅功能，请先订阅后武装";
    return;
  }
  if (!complianceAll.value) {
    armError.value = "请先逐项勾选并确认下方「合规与报备」三条事项";
    return;
  }
  if (armAckText.value.trim() !== "风险确认") {
    armError.value = "请在确认框输入「风险确认」四个字";
    return;
  }
  armBusy.value = true;
  try {
    await brokerEnableLive(true, true);
    bForm.value.liveEnabled = true;
    armAckText.value = "";
    armError.value = "实盘已武装：真实通道进入半自动，仅白名单标的、限额内可下单";
    armErrorOk.value = true;
    await refreshBStatus();
    await refreshLiveUsage();
  } catch (e) {
    armError.value = String(e);
    armErrorOk.value = false;
    bForm.value.liveEnabled = false;
  } finally {
    armBusy.value = false;
  }
}
async function bDisarm() {
  const ok = await confirmDialog({
    title: "解除实盘武装",
    confirmText: "解除武装",
    message: "解除后真实通道将停止接受任何真实委托，直到重新武装。确认解除？",
  });
  if (!ok) return;
  try {
    await brokerEnableLive(false, false);
    if (bForm.value) bForm.value.liveEnabled = false;
    armError.value = "实盘已解除武装";
    armErrorOk.value = true;
    await refreshBStatus();
    await refreshLiveUsage();
  } catch (e) {
    armError.value = String(e);
    armErrorOk.value = false;
  }
}
async function refreshBStatus() {
  try {
    bStatus.value = await brokerGetStatus();
  } catch {
    /* ignore */
  }
}
async function loadBrokerTab() {
  try {
    void ensureBrokerListener();
    bForm.value = await brokerGetConfig();
    // P12-5 旧 QMT 配置迁移：QMT 通道已下线，落到同花顺实盘通道
    if (bForm.value?.kind === "qmt") {
      bForm.value.kind = "client";
      bForm.value.clientSim = false;
    }
    await refreshBStatus();
    await bRefreshSelfcheck();
    brokerLoaded.value = true;
    void bOcrManage("status");
    await refreshLiveUsage();
  } catch (e) {
    bFlash(`加载失败：${e}`);
  }
}
async function saveBroker() {
  if (!bForm.value) return;
  const f = bForm.value;
  try {
    await brokerSetConfig({
      kind: f.kind,
      pythonPath: f.pythonPath,
      qmtPath: f.qmtPath,
      accountId: f.accountId,
      maxSinglePct: f.maxSinglePct,
      maxTotalPct: f.maxTotalPct,
      noOpenAfter: f.noOpenAfter,
      feePct: f.feePct,
      mockAllowAnytime: f.mockAllowAnytime,
      mockInitCash: f.mockInitCash,
      dailyLossLimitPct: f.dailyLossLimitPct,
      maxDrawdownLimitPct: f.maxDrawdownLimitPct,
      consecutiveLossLimit: f.consecutiveLossLimit,
      liveMaxOrderAmount: f.liveMaxOrderAmount,
      liveMaxDailyAmount: f.liveMaxDailyAmount,
      clientVendor: f.clientVendor,
      clientSim: f.clientSim,
      clientPath: f.clientPath,
      clientTemplateDir: f.clientTemplateDir,
      clientAutoConfirm: f.clientAutoConfirm,
      clientMinIntervalMs: f.clientMinIntervalMs,
      clientDryRun: f.clientDryRun,
      clientTesseract: f.clientTesseract,
      clientApiPort: f.clientApiPort,
      clientApiToken: f.clientApiToken,
    });
    bFlash("配置已保存");
  } catch (e) {
    bFlash(`保存失败：${e}`);
  }
}
async function bConnect() {
  if (bConnectBusy.value) return;
  bConnectBusy.value = true;
  try {
    // 新手习惯：改完配置直接点「保存并连接」，无需先记着保存。
    if (!bForm.value) throw new Error("配置未加载");
    await saveBroker();
    bSidecarErr.value = "";
    const startMsg = await brokerConnect();
    // sidecar 连接后异步推送自检（dry-run 秒级，真机起客户端较慢），稍候拉取，亦可手动刷新。
    await new Promise((r) => setTimeout(r, 2200));
    await refreshBStatus();
    await bRefreshSelfcheck();
    // P12-11 明确提示连接结果：成功 / 失败原因 / 未确认
    if (bStatus.value?.connected) {
      const kind = bStatus.value.kind === "mock" ? "本地模拟盘" : bStatus.value.clientSim ? "同花顺模拟盘" : "同花顺实盘";
      bFlash(`连接成功：${kind}通道已就绪`);
    } else if (bSidecarErr.value) {
      bFlash(`连接失败：${bSidecarErr.value}`);
    } else {
      bFlash(`${startMsg} 自检尚未确认，请查看下方自检详情或点「刷新自检」`);
    }
  } catch (e) {
    bFlash(`连接失败：${e}`);
  } finally {
    bConnectBusy.value = false;
  }
}
async function bDisconnect() {
  if (bDisconnectBusy.value) return;
  bDisconnectBusy.value = true;
  try {
    await brokerDisconnect();
    bSidecarErr.value = "";
    await refreshBStatus();
    bFlash("已断开");
  } catch (e) {
    bFlash(String(e));
  } finally {
    bDisconnectBusy.value = false;
  }
}
// v3.0.0-rc 一键急停：封新委托 + 停自动执行 + 撤全部条件单 / 在途委托 + 断通道
async function bEmergencyHalt() {
  // v3.14 P0-5：确认文案 / 成功反馈对齐共享口径，底层仍直调 brokerEmergencyHalt，行为不变。
  const ok = await confirmEmergencyHalt();
  if (!ok) return;
  try {
    const r = await brokerEmergencyHalt();
    bFlash(formatEmergencyHaltResult(r));
    await refreshBStatus();
  } catch (e) {
    bFlash(String(e));
  }
}
async function bReleaseKill() {
  try {
    await brokerReleaseKill();
    await refreshBStatus();
    bFlash("Kill Switch 已解除");
  } catch (e) {
    bFlash(String(e));
  }
}
async function bSeed() {
  let code = seedForm.code.trim();
  if (!code) code = "600519";
  try {
    await paper.load();
    await paper.buy(code, code, seedForm.price, seedForm.vol);
    bFlash(`已注入模拟持仓 ${code} ${seedForm.vol} 股 @ ${seedForm.price}`);
  } catch (e) {
    bFlash(String(e));
  }
}
async function bMockReset() {
  try {
    await paper.reset();
    bFlash("模拟账户已重置");
  } catch (e) {
    bFlash(String(e));
  }
}

// 保存自定义总资金到券商配置，并立即按该本金重置模拟账户
async function bSaveMockCash() {
  if (!bForm.value) return;
  const cash = Number(bForm.value.mockInitCash);
  if (!(cash > 0)) { bFlash("总资金须大于 0"); return; }
  const ok = await confirmDialog({
    title: "保存并重置",
    message: `将保存配置并清空模拟账户，总资金设为 ${cash.toLocaleString("zh-CN")} 元，确定？`,
    confirmText: "保存并重置",
    danger: true,
  });
  if (!ok) return;
  try {
    const f = bForm.value;
    await brokerSetConfig({
      kind: f.kind, pythonPath: f.pythonPath, qmtPath: f.qmtPath, accountId: f.accountId,
      maxSinglePct: f.maxSinglePct, maxTotalPct: f.maxTotalPct, noOpenAfter: f.noOpenAfter,
      feePct: f.feePct, mockAllowAnytime: f.mockAllowAnytime, mockInitCash: cash,
    });
    await paper.resetWith(cash);
    bFlash(`已保存，模拟账户总资金 ${cash.toLocaleString("zh-CN")} 元`);
  } catch (e) {
    bFlash(String(e));
  }
}

// ===== 插件生态（v2.6）=====
const plugins = ref<PluginRow[]>([]);
const pMsg = ref("");
const pMsgOk = ref(false);
const installPath = ref("");
const devMode = ref(false);

function pFlash(m: string, ok = false) {
  pMsg.value = m;
  pMsgOk.value = ok;
}
async function loadPluginsTab() {
  await refreshPlugins();
  await refreshL2Keys();
  try {
    devMode.value = await pluginGetDevMode();
  } catch {
    /* 忽略 */
  }
}
async function refreshPlugins() {
  try {
    plugins.value = await pluginList();
  } catch (e) {
    pFlash(String(e));
  }
}
async function scanPlugins() {
  try {
    const n = await pluginScan();
    await refreshPlugins();
    pFlash(`扫描完成，共登记 ${n} 个插件`, true);
  } catch (e) {
    pFlash(String(e));
  }
}
async function doInstall() {
  const p = installPath.value.trim();
  if (!p) {
    pFlash("请粘贴含 plugin.json 的插件文件夹路径");
    return;
  }
  try {
    const id = await pluginInstall(p);
    installPath.value = "";
    await refreshPlugins();
    pFlash(`已安装插件：${id}`, true);
  } catch (e) {
    pFlash(String(e));
  }
}
async function togglePlugin(r: PluginRow) {
  try {
    if (r.enabled) {
      await pluginDisable(r.pluginId);
      pFlash(`已停用 ${r.name}`, true);
    } else {
      await pluginEnable(r.pluginId);
      pFlash(`已启用 ${r.name}`, true);
    }
  } catch (e) {
    pFlash(String(e));
  }
  await refreshPlugins();
}
async function removePlugin(r: PluginRow) {
  const ok = await confirmDialog({
    title: "卸载插件",
    danger: true,
    message: `确认卸载插件「${r.name}」？其文件与配置将被移除。`,
    confirmText: "卸载",
  });
  if (!ok) return;
  try {
    await pluginUninstall(r.pluginId);
    pFlash(`已卸载 ${r.name}`, true);
  } catch (e) {
    pFlash(String(e));
  }
  await refreshPlugins();
}
async function reloadPlugin(r: PluginRow) {
  try {
    await pluginReload(r.pluginId);
    pFlash(`已热重载 ${r.name}`, true);
  } catch (e) {
    pFlash(String(e));
  }
  await refreshPlugins();
}
async function toggleDev() {
  try {
    await pluginSetDevMode(!devMode.value);
    devMode.value = await pluginGetDevMode();
    pFlash(devMode.value ? "开发者模式已开启" : "开发者模式已关闭", true);
  } catch (e) {
    pFlash(String(e));
  }
}

// ===== v2.32 Level-2 数据源 Key（系统凭据箱，不进插件 JS）=====
const l2KeySet = ref<Record<string, boolean>>({});
const l2Input = ref<Record<string, string>>({});
const l2Busy = ref<Record<string, boolean>>({});
const isL2Plugin = (r: PluginRow) => r.permissions.includes("level2:read");

async function refreshL2Keys() {
  const next: Record<string, boolean> = {};
  await Promise.all(
    plugins.value
      .filter(isL2Plugin)
      .map(async (r) => {
        try {
          next[r.pluginId] = await pluginL2KeySet(r.pluginId);
        } catch {
          next[r.pluginId] = false;
        }
      }),
  );
  l2KeySet.value = next;
}
async function saveL2Key(r: PluginRow) {
  if (!license.isPro) {
    pFlash("Level-2 十档为 Pro 订阅功能，请先订阅后配置");
    return;
  }
  const key = (l2Input.value[r.pluginId] || "").trim();
  if (!key) {
    pFlash("请先粘贴数据商 API Key");
    return;
  }
  l2Busy.value[r.pluginId] = true;
  try {
    await pluginL2SetKey(r.pluginId, key);
    l2Input.value[r.pluginId] = "";
    await refreshL2Keys();
    pFlash(`已保存 ${r.name} 的 API Key 到系统凭据箱`, true);
  } catch (e) {
    pFlash(String(e));
  } finally {
    l2Busy.value[r.pluginId] = false;
  }
}
async function clearL2Key(r: PluginRow) {
  const ok = await confirmDialog({
    title: "清除 API Key",
    message: `将清除「${r.name}」的 API Key，清除后需重新输入。是否继续？`,
    confirmText: "清除",
    danger: true,
  });
  if (!ok) return;
  l2Busy.value[r.pluginId] = true;
  try {
    await pluginL2ClearKey(r.pluginId);
    await refreshL2Keys();
    pFlash(`已清除 ${r.name} 的 API Key`, true);
  } catch (e) {
    pFlash(String(e));
  } finally {
    l2Busy.value[r.pluginId] = false;
  }
}
</script>

<template>
  <Transition name="dlg">
    <div v-if="open" class="set-mask" @click.self="close">
      <div class="set-dialog" role="dialog" aria-label="设置">
        <!-- 标题栏 -->
        <header class="set-head">
          <span class="set-title">设置</span>
          <button class="set-x" title="关闭" @click="close">
            <svg viewBox="0 0 24 24" width="15" height="15">
              <path fill="currentColor" d="M18.3 5.71 12 12.01l-6.3-6.3-1.4 1.4 6.3 6.3-6.3 6.3 1.4 1.4 6.3-6.3 6.3 6.3 1.4-1.4-6.3-6.3 6.3-6.3z" />
            </svg>
          </button>
        </header>

        <div class="set-main">
          <!-- 左侧分组 -->
          <nav class="set-nav">
            <button class="nav-item" :class="{ on: tab === 'pro' }" @click="pickTab('pro')">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 17.3 6.1 20l1.1-6.5L2.5 9l6.5-1L12 2l3 6 6.5 1-4.7 4.5L17.9 20z" /></svg>
              订阅 Pro
            </button>
            <button class="nav-item" :class="{ on: tab === 'appearance' }" @click="pickTab('appearance')">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 2v14a7 7 0 000-14zm0 0a7 7 0 010 14z" /></svg>
              外观
            </button>
            <button class="nav-item" :class="{ on: tab === 'data' }" @click="pickTab('data')">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 3C7.6 3 4 4.8 4 7v10c0 2.2 3.6 4 8 4s8-1.8 8-4V7c0-2.2-3.6-4-8-4zm6 14c0 .6-2.2 1.7-6 1.7S6 17.6 6 17v-2.6c1.3 1 3.4 1.6 6 1.6s4.7-.6 6-1.6zm0-5c0 .6-2.2 1.7-6 1.7S6 12.6 6 12V9.4c1.3 1 3.4 1.6 6 1.6s4.7-.6 6-1.6zm0-5c0 .6-2.2 1.7-6 1.7S6 7.6 6 7s2.2-1.7 6-1.7S18 6.4 18 7z" /></svg>
              数据中心
            </button>
            <button class="nav-item" :class="{ on: tab === 'ai' }" @click="pickTab('ai')">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2zM9 21h6M10 17v4M14 17v4" /></svg>
              AI 模型
            </button>
            <button class="nav-item" :class="{ on: tab === 'autotrade' }" @click="pickTab('autotrade')">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M7 2v2h10V2h2v4h-2v12h2v4H5v-4h2V6H5V2h2zm2 4v12h6V6H9z" /></svg>
              AI 操盘手
            </button>
            <button class="nav-item" :class="{ on: tab === 'knowledge' }" @click="pickTab('knowledge')">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z" /></svg>
              知识库
            </button>
            <button class="nav-item" :class="{ on: tab === 'broker' }" @click="pickTab('broker')">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M3 6l9-3 9 3v12l-9 3-9-3V6zm9 1.5L6 9.5v5l6 2 6-2v-5l-6-2zM7 15h2v2H7v-2zm8 0h2v2h-2v-2z" /></svg>
              券商交易
            </button>
            <button class="nav-item" :class="{ on: tab === 'plugins' }" @click="pickTab('plugins')">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M10 3h4v5h5v4h-5v4h-4v-4H5V8h5V3zM4 18h16v2H4v-2z" /></svg>
              插件生态
            </button>
            <button class="nav-item" :class="{ on: tab === 'logs' }" @click="pickTab('logs')">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M3 13h2l2-6 3 12 3-9 2 3h6v-2h-4.6l-1.2-1.8L12 5.2 9.2 16 7.3 8.6 6.4 11H3z" /></svg>
              诊断日志
            </button>
            <button class="nav-item" :class="{ on: tab === 'about' }" @click="pickTab('about')">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2zm0-8h-2V7h2z" /></svg>
              关于
            </button>
          </nav>

          <!-- 右侧内容 -->
          <div class="set-content">
            <!-- Pro 订阅 -->
            <div v-if="tab === 'pro'" class="ai-tab">
              <div class="section-title">订阅 Pro</div>
              <template v-if="license.isPro">
                <div class="pro-active-card">
                  <div class="pro-active-glow"></div>
                  <div class="pro-badge-corner">PRO</div>
                  <div class="pro-active-head">
                    <span class="pro-active-dot"></span>
                    <span class="pro-active-title">Pro 订阅生效中</span>
                  </div>
                  <div class="pro-active-row"><span>订阅计划</span><b>{{ planLabel(license.plan) }}</b></div>
                  <div class="pro-active-row"><span>到期时间</span><b>{{ license.expiresAt }}</b></div>
                  <div class="pro-active-row"><span>剩余天数</span><b>{{ license.daysLeft }} 天</b></div>
                  <div class="pro-active-row">
                    <span>每日 AI 配额</span>
                    <b>
                      <span style="color:var(--q-accent,#22d3c5)">{{ license.todayUsed ?? 0 }}</span>
                      <span style="opacity:.6"> / {{ license.dailyQuota ?? 0 }} 次</span>
                    </b>
                  </div>
                  <div class="pro-active-row">
                    <span>AI 次数包</span>
                    <b v-if="license.aiBalance != null" style="color:var(--q-accent,#22d3c5)">剩余 {{ license.aiBalance }} 次</b>
                    <b v-else style="opacity:.5">未购买（叠加包不占用每日配额）</b>
                  </div>
                  <div class="pro-active-row"><span>设备绑定</span><b v-if="license.needRelocate" style="color:var(--q-err,#e04b4b)">需换机授权</b><b v-else>已绑定本机</b></div>
                  <div v-if="license.status?.rollback_detected" class="pro-rollback">检测到系统时间回拨，Pro 已暂停，请校正系统时间后重新打开软件。</div>
                  <div v-if="IS_DEV" class="pro-debug-zone">
                    <div class="pro-debug-tip">DEBUG 构建 · 测试专用</div>
                    <button class="pro-debug-btn" :disabled="clearBusy" @click="onClearLicense">
                      {{ clearBusy ? "清除中…" : "清除激活码 · 回到免费版" }}
                    </button>
                  </div>
                </div>

                <!-- 升级套餐 -->
                <div class="pro-section-title">升级套餐</div>
                <div class="pro-upgrade-grid">
                  <div class="pro-plan-card" :class="{ hot: license.plan === 'monthly' }">
                    <div class="pro-plan-name">月卡</div>
                    <div class="pro-plan-price">¥19<span>/月</span></div>
                    <div class="pro-plan-quota">50 次 AI/天</div>
                    <button class="pro-plan-btn" @click="goBuy('monthly')">升级</button>
                  </div>
                  <div class="pro-plan-card" :class="{ hot: license.plan === 'quarterly' }">
                    <div class="pro-plan-name">季卡</div>
                    <div class="pro-plan-price">¥69<span>/季</span></div>
                    <div class="pro-plan-quota">80 次 AI/天</div>
                    <button class="pro-plan-btn" @click="goBuy('quarterly')">升级</button>
                  </div>
                  <div class="pro-plan-card hot" :class="{ active: license.plan === 'annual' || license.plan === 'pro-annual' }">
                    <div class="pro-plan-name">年卡</div>
                    <div class="pro-plan-price">¥199<span>/年</span></div>
                    <div class="pro-plan-quota">100 次 AI/天</div>
                    <button class="pro-plan-btn" @click="goBuy('annual')">{{ (license.plan === 'annual' || license.plan === 'pro-annual') ? '当前套餐' : '升级' }}</button>
                  </div>
                </div>

                <!-- AI 次数包 -->
                <div class="pro-section-title">AI 次数包 <span class="pro-section-sub">不占用每日配额，叠加使用</span></div>
                <div class="pro-topup-grid">
                  <div class="pro-topup-card">
                    <div class="pro-topup-name">500 次</div>
                    <div class="pro-topup-price">¥19</div>
                    <button class="pro-topup-btn" @click="goBuyTopup(500)">购买</button>
                  </div>
                  <div class="pro-topup-card">
                    <div class="pro-topup-name">1000 次</div>
                    <div class="pro-topup-price">¥35</div>
                    <button class="pro-topup-btn" @click="goBuyTopup(1000)">购买</button>
                  </div>
                  <div class="pro-topup-card hot">
                    <div class="pro-topup-name">2000 次</div>
                    <div class="pro-topup-price">¥59</div>
                    <div class="pro-topup-tag">超值</div>
                    <button class="pro-topup-btn" @click="goBuyTopup(2000)">购买</button>
                  </div>
                </div>

                <!-- 激活码输入（试用期内购买后激活） -->
                <div class="pro-section-title" style="margin-top:20px">激活升级</div>
                <div class="pro-activate">
                  <textarea v-model="codeInput" rows="2" class="pro-code-input" placeholder="粘贴购买后获得的激活码（TG.xxx.xxx）"></textarea>
                  <button class="pro-act-btn" :disabled="actBusy" @click="onActivate">{{ actBusy ? "激活中…" : "激活" }}</button>
                </div>
                <div v-if="actMsg" class="pro-msg">{{ actMsg }}</div>
                <div class="pro-note" style="margin-top:6px">试用期内购买升级，粘贴激活码即可立即生效，试用期剩余天数自动折算。</div>
              </template>
              <template v-else-if="license.needRelocate">
                <div class="pro-relocate">
                  <div class="pro-reloc-title">需要换机授权</div>
                  <div class="pro-msg">检测到该激活码已绑定其他设备，当前 Pro 已暂停。请复制下面的申请码发给卖家，获取换机授权码后粘贴提交（授权码 7 天内有效）。</div>
                  <div class="reloc-req">
                    <code>{{ license.relocateRequest }}</code>
                    <button class="pro-act-btn" @click="copyRelocReq">复制申请码</button>
                  </div>
                  <textarea v-model="relocInput" rows="2" class="pro-code-input" placeholder="粘贴卖家给的换机授权码（TGR.xxx.xxx）"></textarea>
                  <button class="pro-act-btn" :disabled="relocBusy" @click="onRelocate">{{ relocBusy ? "提交中…" : "确认换机" }}</button>
                  <div v-if="relocMsg" class="pro-msg">{{ relocMsg }}</div>
                  <div class="pro-note">换机授权码由卖家签发，与本机指纹绑定，不可转用于其他设备；新授权码 7 天内有效。</div>
                </div>
              </template>
              <template v-else>
                <div class="pro-hero">
                  <div class="pro-hero-glow"></div>
                  <div class="pro-badge">PRO</div>
                  <div class="pro-hero-title">TickGold <span>Pro</span></div>
                  <div class="pro-hero-sub">解锁 AI 盯盘助手与全部 Pro 高级能力</div>
                  <div class="pro-plans">
                    <div class="pro-plan-card">
                      <div class="pro-plan-name">月卡</div>
                      <div class="pro-plan-price">¥19<span>/月</span></div>
                      <div class="pro-plan-quota">50 次 AI/天</div>
                    </div>
                    <div class="pro-plan-card">
                      <div class="pro-plan-name">季卡</div>
                      <div class="pro-plan-price">¥69<span>/季</span></div>
                      <div class="pro-plan-quota">80 次 AI/天</div>
                    </div>
                    <div class="pro-plan-card hot">
                      <div class="pro-plan-name">年卡</div>
                      <div class="pro-plan-price">¥199<span>/年</span></div>
                      <div class="pro-plan-quota">100 次 AI/天</div>
                    </div>
                  </div>
                  <button class="pro-buy-btn" @click="goBuy">
                    <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z" /></svg>
                    去面包多购买
                  </button>
                  <div class="pro-hero-foot">支持微信 / 支付宝 · 支付成功后卡密自动发货</div>
                </div>
                <div class="pro-steps">
                  <div class="pro-step">
                    <div class="pro-step-num">1</div>
                    <div class="pro-step-txt">完成支付<span>面包多平台</span></div>
                  </div>
                  <div class="pro-step-line"></div>
                  <div class="pro-step">
                    <div class="pro-step-num">2</div>
                    <div class="pro-step-txt">复制激活码<span>自动发货</span></div>
                  </div>
                  <div class="pro-step-line"></div>
                  <div class="pro-step">
                    <div class="pro-step-num">3</div>
                    <div class="pro-step-txt">粘贴激活<span>立即生效</span></div>
                  </div>
                </div>
                <div class="pro-activate">
                  <textarea v-model="codeInput" rows="2" class="pro-code-input" placeholder="粘贴激活码（TG.xxx.xxx）"></textarea>
                  <button class="pro-act-btn" :disabled="actBusy" @click="onActivate">{{ actBusy ? "激活中…" : "激活 Pro" }}</button>
                </div>
                <div v-if="actMsg" class="pro-msg">{{ actMsg }}</div>
                <div class="pro-note">激活后立即生效，到期自动降级免费版。激活码绑定首次激活的设备；换机或重装导致绑定失效时，请联系卖家授权。</div>
              </template>
            </div>
            <!-- 外观 / 配色 -->
            <div v-if="tab === 'appearance'">
              <div class="section-title">启动设置</div>
              <div class="startup-row">
                <div class="startup-info">
                  <div class="startup-name">开机自动启动 TickGold</div>
                  <div class="section-sub" style="margin:3px 0 0">登录系统后自动运行，便于开盘前自动盯盘</div>
                </div>
                <button
                  type="button"
                  class="switch"
                  :class="{ on: autoStart }"
                  :disabled="autoStartBusy"
                  @click="toggleAutoStart(!autoStart)"
                ><span class="knob"></span></button>
              </div>
              <div class="section-title" style="margin-top:22px">配色主题</div>
              <div class="section-sub">选择后立即生效，并自动记住你的选择</div>
              <div class="theme-grid">
                <button
                  v-for="t in THEMES"
                  :key="t.id"
                  type="button"
                  class="theme-card"
                  :class="{ on: theme === t.id }"
                  @click="pick(t.id)"
                >
                  <span class="tc-preview">
                    <i v-for="(c, i) in t.sw" :key="i" class="swatch" :style="{ background: c }"></i>
                  </span>
                  <span class="tc-info">
                    <span class="tc-name">
                      {{ t.name }}
                      <svg v-if="theme === t.id" class="tc-check" viewBox="0 0 24 24" width="14" height="14">
                        <path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" />
                      </svg>
                    </span>
                    <span class="tc-desc">{{ t.desc }}</span>
                  </span>
                </button>
              </div>

              <div class="section-title" style="margin-top:22px">体验模式</div>
              <div class="startup-row">
                <div class="startup-info">
                  <div class="startup-name">新手模式</div>
                  <div class="section-sub" style="margin:3px 0 0">开启后界面显示操作提示，关键按钮带文字说明，帮助快速上手</div>
                </div>
                <button
                  type="button"
                  class="switch"
                  :class="{ on: noviceApi.novice.value }"
                  @click="noviceApi.toggle()"
                ><span class="knob"></span></button>
              </div>

              <div class="section-title" style="margin-top:22px">卡片皮肤</div>
              <div class="section-sub">在配色主题之上的卡片渲染层；「默认」即与无皮肤时完全一致</div>
              <div class="theme-grid">
                <button
                  type="button"
                  class="theme-card"
                  :class="{ on: skinsApi.appSkinId.value === null }"
                  @click="skinsApi.select(null)"
                >
                  <span class="tc-preview">
                    <i class="swatch" style="background:#15181d"></i>
                  </span>
                  <span class="tc-info">
                    <span class="tc-name">默认（无皮肤）</span>
                    <span class="tc-desc">跟随当前主题，不叠加装饰</span>
                  </span>
                </button>
                <div
                  v-for="s in skinsApi.skins.value"
                  :key="s.id"
                  class="theme-card skin-card"
                  :class="{ on: skinsApi.appSkinId.value === s.id }"
                  @click="skinsApi.select(s.id)"
                >
                  <span class="tc-preview">
                    <i v-for="(c, i) in skinSw(s)" :key="i" class="swatch" :style="{ background: c }"></i>
                  </span>
                  <span class="tc-info">
                    <span class="tc-name">{{ s.name }}</span>
                    <span class="tc-desc">v{{ s.version }}</span>
                  </span>
                  <span class="skin-card-tools" @click.stop>
                    <button type="button" title="导出" @click="onExportSkin(s.id)">↥</button>
                    <button type="button" title="删除" @click="onDeleteSkin(s.id)">✕</button>
                  </span>
                </div>
              </div>
              <div class="skin-bar">
                <button type="button" class="logs-btn" @click="onImportSkin">导入皮肤</button>
                <span v-if="skinMsg" class="skin-msg">{{ skinMsg }}</span>
              </div>

              <div class="section-title" style="margin-top:22px">灵动岛皮肤</div>
              <div class="section-sub">悬浮灵动岛的配色主题，选择后立即生效</div>
              <div class="theme-grid">
                <button
                  v-for="s in ISLAND_SKINS"
                  :key="s.id"
                  type="button"
                  class="theme-card"
                  :class="{ on: islandSkin === s.id }"
                  @click="pickIslandSkin(s.id)"
                >
                  <span class="tc-preview">
                    <i class="swatch" :style="{ background: s.vars['--accent'] }"></i>
                    <i class="swatch" :style="{ background: s.vars['--bg-from'] }"></i>
                  </span>
                  <span class="tc-info">
                    <span class="tc-name">{{ s.label }}</span>
                    <span class="tc-desc">{{ s.desc }}</span>
                  </span>
                </button>
              </div>

              <div class="section-title" style="margin-top:22px">显示与可访问性</div>
              <div class="section-sub">界面缩放与高对比，选择后立即生效并记住</div>
              <div class="startup-row">
                <div class="startup-info">
                  <div class="startup-name">界面缩放</div>
                  <div class="section-sub" style="margin:3px 0 0">整体放大或缩小文字与控件</div>
                </div>
                <div class="seg">
                  <button v-for="z in ZOOM_LEVELS" :key="z.value" type="button" class="seg-btn" :class="{ on: zoom === z.value }" @click="setZoom(z.value)">{{ z.label }}</button>
                </div>
              </div>
              <div class="startup-row">
                <div class="startup-info">
                  <div class="startup-name">高对比模式</div>
                  <div class="section-sub" style="margin:3px 0 0">增强文字与边框对比，更易辨识</div>
                </div>
                <button type="button" class="switch" :class="{ on: highContrast }" @click="setHighContrast(!highContrast)"><span class="knob"></span></button>
              </div>
            </div>

            <!-- 数据中心：本地时序采集状态 -->
            <div v-else-if="tab === 'data'" class="data-center">
              <div class="dc-banner">
                <span class="dc-dot" :class="{ on: tsStatus.running }"></span>
                <div class="dc-bt">
                  <div class="dc-title">本地时序采集引擎</div>
                  <div class="dc-sub">{{ tsStatus.running ? "运行中 · 盘中自动采集，收盘自动归档" : "未运行" }}</div>
                </div>
                <span class="dc-daily" :class="{ ok: tsStatus.todayDaily }">
                  {{ tsStatus.todayDaily ? "今日已收盘归档" : "今日未归档" }}
                </span>
              </div>

              <div class="section-title">最近采集</div>
              <div class="dc-rows">
                <div class="dc-row"><span class="dr-k">市场情绪</span><span class="dr-v">{{ fmtTime(tsStatus.lastMarketTs) }}</span></div>
                <div class="dc-row"><span class="dr-k">指数</span><span class="dr-v">{{ fmtTime(tsStatus.lastIndexTs) }}</span></div>
                <div class="dc-row"><span class="dr-k">板块</span><span class="dr-v">{{ fmtTime(tsStatus.lastSectorTs) }}</span></div>
                <div class="dc-row"><span class="dr-k">公告催化</span><span class="dr-v">{{ fmtTime(collectorStatus.lastAnnouncement) }} · {{ collectorStatus.announcementCount }} 条</span></div>
                <div class="dc-row"><span class="dr-k">互动易（e互动待校准）</span><span class="dr-v">{{ fmtTime(collectorStatus.lastIrm) }} · {{ collectorStatus.irmCount }} 条</span></div>
                <div class="dc-row"><span class="dr-k">题材归因</span><span class="dr-v">{{ collectorStatus.lastAttribution || "未运行" }}</span></div>
              </div>

              <div class="section-title">本地数据量</div>
              <div class="dc-stats">
                <div class="dc-stat"><b>{{ tsStatus.marketRows }}</b><span>情绪分时</span></div>
                <div class="dc-stat"><b>{{ tsStatus.indexRows }}</b><span>指数分时</span></div>
                <div class="dc-stat"><b>{{ tsStatus.sectorRows }}</b><span>板块分时</span></div>
                <div class="dc-stat"><b>{{ tsStatus.dayRows }}</b><span>交易日(日级)</span></div>
              </div>

              <div class="dc-note">分时明细保留最近 60 天；收盘日级长期保留，用于情绪周期与题材轮动分析。</div>
              <div v-if="tsStatus.makeupPending > tsStatus.makeupDone" class="dc-note">
                正在补采缺失交易日板块快照：{{ tsStatus.makeupDone }} / {{ tsStatus.makeupPending }}
              </div>
              <div v-if="tsStatus.lastError" class="dc-err">采集异常：{{ tsStatus.lastError }}</div>

              <!-- 数据治理（v2.29）-->
              <div class="section-title" style="margin-top:24px">数据治理</div>
              <div class="section-sub">查看占用、清理恢复留证等孤儿文件、压缩主库空闲空间</div>
              <div v-if="storageStats" class="dc-rows">
                <div class="dc-row">
                  <span class="dr-k">数据目录总占用</span>
                  <span class="dr-v">{{ fmtBytes(storageStats.totalBytes) }}</span>
                </div>
                <div
                  v-for="f in storageStats.files"
                  :key="f.name"
                  class="dc-row"
                >
                  <span class="dr-k">{{ f.name }}</span>
                  <span class="dr-v">{{ fmtBytes(f.size) }}</span>
                </div>
              </div>
              <div v-if="storageStats && storageStats.tableRows.length" class="dc-note">
                <span v-for="(trow) in storageStats.tableRows" :key="trow[0]" class="gov-trow">
                  {{ trow[0].replace("ts_", "") }} {{ trow[1] }}
                </span>
              </div>

              <!-- 过期策略 -->
              <div class="section-sub" style="margin-top:12px">过期策略：分时明细与知识库 / 历史对话可按保留天数清理（日级快照长期保留）；填 0 表示该项不清理</div>
              <div class="hist-form">
                <div class="hist-field">
                  <label>分时明细保留天数</label>
                  <input v-model.number="keepIntradayDays" type="number" min="0" step="1" spellcheck="false" />
                </div>
                <div class="hist-field">
                  <label>知识库 / 对话保留天数</label>
                  <input v-model.number="keepAiDays" type="number" min="0" step="1" spellcheck="false" />
                </div>
              </div>
              <div v-if="purgePlan && purgePlan.targets.length" class="dc-rows" style="margin-top:6px">
                <div v-for="t in purgePlan.targets" :key="t.key" class="dc-row">
                  <span class="dr-k">{{ t.label }}</span>
                  <span class="dr-v">将清理 {{ t.rows }} 行</span>
                </div>
                <div v-if="purgePlan.totalRows === 0" class="dc-note">当前保留期内没有可清理数据</div>
              </div>
              <div class="ai-actions">
                <button type="button" class="logs-btn" :disabled="govBusy" @click="onPurgePreview">预览过期数据</button>
                <button type="button" class="logs-btn" :disabled="govBusy || !purgePlan || purgePlan.totalRows === 0" @click="onPurgeRun">执行清理</button>
              </div>

              <div class="ai-actions">
                <button type="button" class="logs-btn" :disabled="govBusy" @click="loadStorageStats">
                  {{ govBusy ? "统计中…" : "重新统计" }}
                </button>
                <button type="button" class="logs-btn" :disabled="govBusy" @click="onCleanupOrphans">清理孤儿文件</button>
                <button type="button" class="logs-btn" :disabled="govBusy" @click="onVacuum">压缩主库</button>
              </div>
              <div v-if="govMsg" class="ai-msg" :class="{ ok: /成功|完成|释放|清理/.test(govMsg) }">{{ govMsg }}</div>

              <!-- 备份 / 恢复中心（v2.29）-->
              <div class="section-title" style="margin-top:24px">备份 / 恢复中心</div>
              <div class="section-sub">备份主库（含成交流水 / 委托）、知识库、券商配置与本地配置（自选 / 布局 / 设置）；恢复前做完整性校验，恢复时自动重启</div>
              <div class="ai-actions">
                <button type="button" class="logs-btn primary" :disabled="backupBusy" @click="onCreateBackup">
                  {{ backupBusy ? "备份中…" : "立即备份" }}
                </button>
                <button type="button" class="logs-btn" @click="loadBackupSets">刷新列表</button>
              </div>
              <div v-if="backupMsg" class="ai-msg" :class="{ ok: /成功|完成/.test(backupMsg) }">{{ backupMsg }}</div>

              <div v-for="b in backupSets" :key="b.id" class="backup-row">
                <div class="backup-info">
                  <div class="backup-id">{{ fmtBackupTime(b.createdMs) }}</div>
                  <div class="backup-meta">
                    {{ b.files.map((f) => f.name.replace(".db", "")).join(" · ") }}
                    · {{ fmtBytes(b.totalBytes) }}
                  </div>
                  <div class="backup-verify" :class="{ ok: b.verified, bad: !b.verified }">
                    {{ b.verified ? "完整性校验通过" : "校验未通过，恢复将被拒绝" }}
                  </div>
                </div>
                <button type="button" class="logs-btn" :disabled="backupBusy || !b.verified" @click="onRestoreBackup(b)">恢复</button>
                <button type="button" class="logs-btn" :disabled="backupBusy" @click="onDeleteBackup(b)">删除</button>
              </div>

              <!-- 板块日级快照（v2.29）-->
              <div class="section-title" style="margin-top:24px">板块日级快照</div>
              <div class="section-sub">收盘自动归档行业 / 概念板块涨跌幅、成交额、主力净流入、涨跌家数，供题材轮动矩阵使用</div>
              <div class="dc-rows">
                <div class="dc-row"><span class="dr-k">已归档交易日</span><span class="dr-v">{{ sectorDayCount }} 天</span></div>
              </div>
              <div class="hist-form">
                <div class="hist-field">
                  <label>补采指定交易日（YYYY-MM-DD）</label>
                  <input v-model="sectorDayInput" type="text" spellcheck="false" placeholder="如 2026-10-10" />
                </div>
              </div>
              <div class="ai-actions">
                <button type="button" class="logs-btn primary" :disabled="sectorDayBusy || !sectorDayInput.trim()" @click="onSectorDaySnapshot">
                  {{ sectorDayBusy ? "采集中…" : "补采该日" }}
                </button>
              </div>
              <div v-if="sectorDayMsg" class="ai-msg" :class="{ ok: /成功|完成/.test(sectorDayMsg) }">{{ sectorDayMsg }}</div>

              <!-- 多年历史 K 线库（v2.27）-->
              <div class="section-title" style="margin-top:24px">多年历史 K 线库</div>
              <div class="section-sub">本地增量回填多年日 K，供深度复盘与回测；数据仅保存在本机</div>

              <div class="dc-stats">
                <div class="dc-stat"><b>{{ histStats?.rows ?? "-" }}</b><span>K 线条数</span></div>
                <div class="dc-stat"><b>{{ histStats?.codes ?? "-" }}</b><span>覆盖股票</span></div>
                <div class="dc-stat"><b>{{ histStats?.earliest ?? "-" }}</b><span>最早日期</span></div>
                <div class="dc-stat"><b>{{ histStats?.latest ?? "-" }}</b><span>最新日期</span></div>
              </div>
              <div class="dc-rows">
                <div class="dc-row"><span class="dr-k">交易日历</span><span class="dr-v">{{ histStats?.calendarDays ?? 0 }} 个交易日</span></div>
                <div class="dc-row"><span class="dr-k">数据库占用</span><span class="dr-v">{{ fmtBytes(histStats?.dbSizeBytes ?? 0) }}</span></div>
              </div>

              <div class="hist-form">
                <div class="hist-field">
                  <label>回填范围</label>
                  <div class="seg">
                    <button type="button" class="seg-btn" :class="{ on: histScope === 'watchlist' }" @click="histScope = 'watchlist'">自选股</button>
                    <button type="button" class="seg-btn" :class="{ on: histScope === 'all' }" @click="histScope = 'all'">全市场 A 股</button>
                    <button type="button" class="seg-btn" :class="{ on: histScope === 'custom' }" @click="histScope = 'custom'">自定义</button>
                  </div>
                </div>
                <div v-if="histScope === 'custom'" class="hist-field">
                  <label>股票代码（逗号/空格/换行分隔）</label>
                  <input v-model="histCustom" type="text" spellcheck="false" placeholder="如 600519, 000001, 300750" />
                </div>
                <div class="hist-field-row">
                  <div class="hist-field">
                    <label>复权口径</label>
                    <div class="seg">
                      <button type="button" class="seg-btn" :class="{ on: histAdj === 'qfq' }" @click="histAdj = 'qfq'">前复权</button>
                      <button type="button" class="seg-btn" :class="{ on: histAdj === 'hfq' }" @click="histAdj = 'hfq'">后复权</button>
                      <button type="button" class="seg-btn" :class="{ on: histAdj === 'none' }" @click="histAdj = 'none'">不复权</button>
                    </div>
                  </div>
                  <div class="hist-field hist-years">
                    <label>回填年数</label>
                    <select v-model.number="histYears">
                      <option :value="1">1 年</option>
                      <option :value="3">3 年</option>
                      <option :value="5">5 年</option>
                      <option :value="10">10 年</option>
                      <option :value="20">20 年</option>
                    </select>
                  </div>
                </div>
              </div>

              <div v-if="histProgress && histProgress.running" class="hist-prog">
                <div class="hist-prog-bar">
                  <div class="hist-prog-fill" :style="{ width: histPercent + '%' }"></div>
                </div>
                <div class="hist-prog-txt">
                  {{ histProgress.done }} / {{ histProgress.total }} · 成功 {{ histProgress.ok }} · 失败 {{ histProgress.fail }}
                  <span v-if="histProgress.lastCode"> · 当前 {{ histProgress.lastCode }}</span>
                </div>
              </div>

              <div class="ai-actions">
                <button v-if="histProgress && histProgress.running" type="button" class="logs-btn" @click="onHistStop">停止</button>
                <button type="button" class="logs-btn primary" :disabled="histBusy || (histProgress?.running ?? false)" @click="onHistBackfill">
                  {{ histBusy ? "准备中…" : "开始回填" }}
                </button>
                <button type="button" class="logs-btn" :disabled="histBusy || (histProgress?.running ?? false)" @click="onHistSyncCalendar">同步交易日历</button>
                <button v-if="histLastFailures.length" type="button" class="logs-btn" :disabled="histBusy" @click="onHistRetry">重试失败 ({{ histLastFailures.length }})</button>
              </div>
              <div v-if="histMsg" class="ai-msg" :class="{ ok: /成功|完成|已同步/.test(histMsg) }">{{ histMsg }}</div>
              <div v-if="histLastFailures.length" class="hist-fails">
                <div v-for="(f, i) in histLastFailures.slice(0, 20)" :key="i" class="hist-fail-line">{{ f }}</div>
                <div v-if="histLastFailures.length > 20" class="dc-note">其余 {{ histLastFailures.length - 20 }} 条失败未展开</div>
              </div>
            </div>

            <!-- AI 模型配置 -->
            <div v-else-if="tab === 'ai'" class="ai-tab">
              <!-- v3.0.9 门控：AI 配置为 Pro 专属，免费态锁定 -->
              <div v-if="!license.isPro" class="ai-locked">
                <svg class="ai-lock-icon" viewBox="0 0 24 24" width="34" height="34"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm0 2a3 3 0 0 1 3 3v3H9V7a3 3 0 0 1 3-3zm0 8.5a1.5 1.5 0 0 1 1 2.65V18a1 1 0 0 1-2 0v-2.85a1.5 1.5 0 0 1 1-2.65z"/></svg>
                <div class="ai-lock-title">AI 功能为 Pro 订阅专享</div>
                <div class="ai-lock-sub">激活 Pro 后可使用内置智谱 GLM-4.5 开箱即用，每日 100 次调用配额；本地 Ollama / 云端 API 模型源同样仅在 Pro 下生效。</div>
                <div v-if="license.aiBalance != null" class="ai-lock-sub" style="margin-top:6px;color:var(--q-accent,#22d3c5)">AI 次数包剩余：<b>{{ license.aiBalance }} 次</b>（用完后可购买 AI 次数卡在 Pro 页充值，不限当日次数）。</div>
                <button class="pro-buy-btn" @click="goBuy">订阅 Pro 解锁 AI</button>
              </div>
              <template v-else>
              <!-- 第一步：选 AI 模型 -->
              <div class="section-title">AI 模型</div>
              <div class="seg ai-provider">
                <button type="button" class="seg-btn" :class="{ on: aiCfg.useBuiltin }" @click="aiCfg.useBuiltin = true">内置模型（推荐）</button>
                <button type="button" class="seg-btn" :class="{ on: !aiCfg.useBuiltin && aiCfg.provider === 'ollama' }" @click="pickAi('ollama')">本地 Ollama</button>
                <button type="button" class="seg-btn" :class="{ on: !aiCfg.useBuiltin && aiCfg.provider === 'cloud' }" @click="pickAi('cloud')">云端 API</button>
              </div>

              <!-- 当前模型简短提示 -->
              <div class="current-model-tip">
                <span v-if="aiCfg.useBuiltin">⭐ 内置智谱 GLM-4.5 · 开箱即用，每日 20-100 次配额（按套餐）</span>
                <span v-else-if="aiCfg.provider === 'ollama'">🖥️ 本地 Ollama · 离线运行，不耗配额，需先安装 Ollama 并下载模型</span>
                <span v-else>☁️ 云端 API · 用你自己的 Key，不耗 TickGold 配额，API 费用由第三方收取</span>
              </div>

              <template v-if="!aiCfg.useBuiltin">
                <div class="ai-field">
                  <label>接口地址 Base URL</label>
                  <input v-model="aiCfg.baseUrl" type="text" spellcheck="false" :placeholder="aiCfg.provider === 'ollama' ? 'http://localhost:11434（不要加 /v1）' : 'https://api.deepseek.com/v1'" />
                </div>

                <div class="ai-field-row">
                  <div class="ai-field">
                    <label>对话模型
                      <button v-if="aiCfg.provider === 'cloud'" type="button" class="mini-link" :disabled="fetchingModels" @click.prevent="onFetchModels">
                        ↻ 拉取模型列表
                      </button>
                      <button v-if="aiCfg.provider === 'ollama'" type="button" class="mini-link" :disabled="ollamaLoading" @click.prevent="refreshOllamaModels">
                        ↻ 刷新
                      </button>
                    </label>
                    <input v-model="aiCfg.chatModel" type="text" spellcheck="false"
                      :placeholder="aiCfg.provider === 'ollama' ? 'qwen2.5:7b' : '如 deepseek-chat'" />
                    <div v-if="aiCfg.provider === 'cloud' && availableModels.length" class="model-chips">
                      <button v-for="m in availableModels" :key="m" type="button"
                        class="model-chip" :class="{ on: aiCfg.chatModel === m }"
                        @click="aiCfg.chatModel = m">{{ m }}</button>
                    </div>
                  </div>
                  <div class="ai-field">
                    <label>嵌入模型（知识库用）</label>
                    <input v-model="aiCfg.embedModel" type="text" spellcheck="false"
                      placeholder="bge-m3 / text-embedding-3-small" />
                  </div>
                </div>

                <!-- Ollama 模型管理面板 -->
                <div v-if="aiCfg.provider === 'ollama'" class="ollama-panel">
                  <div class="ollama-head">
                    <span class="ollama-title">本地模型管理</span>
                    <span class="ollama-status" :class="{ ok: !ollamaError }">
                      <span class="ollama-dot" :class="{ ok: !ollamaError }"></span>
                      {{ ollamaError ? '未连接' : '已连接' }}
                    </span>
                    <button class="logs-btn" :disabled="ollamaLoading" @click="refreshOllamaModels">
                      {{ ollamaLoading ? "加载中…" : "刷新列表" }}
                    </button>
                  </div>

                  <div v-if="ollamaError" class="ollama-error">
                    <div class="ollama-error-title">⚠️ 本地 Ollama 未连接</div>
                    <div class="ollama-error-desc">你还没有安装 Ollama 软件，或 Ollama 没有在运行。Ollama 是本地大模型运行环境，模型需要在它上面跑。</div>
                    <div class="ollama-steps">
                      <div class="ollama-step">1. 下载并安装 Ollama（免费开源）</div>
                      <div class="ollama-step">2. 安装后自动后台运行，无需手动启动</div>
                      <div class="ollama-step">3. 回到这里点「刷新列表」</div>
                    </div>
                    <button class="ollama-install-btn" @click="openOllamaSite">
                      下载 Ollama 官网 →
                    </button>
                  </div>

                  <!-- 已安装模型 -->
                  <div v-if="ollamaInstalled.length" class="ollama-section">
                    <div class="ollama-sec-title">已安装（{{ ollamaInstalled.length }}）</div>
                    <div v-for="m in ollamaInstalled" :key="m.name" class="ollama-model-row">
                      <span class="ollama-model-name">{{ m.name }}</span>
                      <span class="ollama-model-size">{{ formatSize(m.size) }}</span>
                      <button class="ollama-use-btn" :class="{ active: aiCfg.chatModel === m.name }"
                        @click="aiCfg.chatModel = m.name">
                        {{ aiCfg.chatModel === m.name ? '使用中' : '设为对话模型' }}
                      </button>
                      <button class="ollama-del-btn" @click="removeOllamaModel(m.name)">卸载</button>
                    </div>
                  </div>

                  <!-- 推荐模型 -->
                  <div class="ollama-section">
                    <div class="ollama-sec-title">推荐下载</div>
                    <div v-for="r in RECOMMENDED_MODELS" :key="r.name" class="ollama-model-row">
                      <span class="ollama-model-name">{{ r.name }}</span>
                      <span class="ollama-model-size">{{ r.size }} · {{ r.ram }}</span>
                      <span class="ollama-model-desc" :title="r.desc">{{ r.desc }}</span>
                      <button v-if="downloadingModel === r.name" class="ollama-dl-btn disabled">
                        下载中…
                      </button>
                      <button v-else class="ollama-dl-btn" :disabled="!!ollamaError" @click="pullOllamaModel(r.name)">
                        下载
                      </button>
                    </div>
                    <div v-if="downloadingModel" class="ollama-progress">
                      <div class="ollama-progress-bar">
                        <div class="ollama-progress-fill" :style="{ width: downloadProgress + '%' }"></div>
                      </div>
                      <span>{{ downloadingModel }} · {{ downloadProgress }}% · {{ formatSpeed(downloadSpeed) }}</span>
                    </div>
                  </div>
                </div>

                <template v-if="aiCfg.provider === 'cloud'">
                  <div class="ai-field">
                    <label>API Key</label>
                    <div class="ai-keyrow">
                      <span v-if="cloudKeySet" class="key-ok">✓ 已设置</span>
                      <input v-else v-model="cloudKeyInput" type="password" placeholder="粘贴 API Key（sk-…）" />
                      <button v-if="cloudKeySet" type="button" class="logs-btn" @click="clearCloudKeyEv">清除</button>
                      <button v-else type="button" class="logs-btn" :disabled="!cloudKeyInput.trim()" @click="saveCloudKeyEv">保存密钥</button>
                    </div>
                  </div>
                </template>
              </template>

              <div class="ai-actions">
                <button type="button" class="logs-btn" :disabled="testingAi" @click="onTestAi">{{ testingAi ? "测试中…" : "测试连接" }}</button>
                <button type="button" class="logs-btn primary" @click="saveAiTab">保存模型配置</button>
              </div>
              <div v-if="aiMsg" class="ai-msg" :class="{ ok: /成功|已保存/.test(aiMsg) }" style="margin-top: 6px;">{{ aiMsg }}</div>
              </template>

            </div>

            <!-- 自动交易（独立 tab）-->
            <div v-else-if="tab === 'autotrade'" class="ai-tab">
              <div v-if="fbCfg">
                <div class="section-title">盘中决策引擎</div>
                <div class="section-sub">选择 AI 分析行情的方式：规则脑免费即用，大模型分析更智能</div>
                <div class="seg ai-provider">
                  <button type="button" class="seg-btn" :class="{ on: fbCfg.brainMode === 'rule' }" @click="fbCfg.brainMode = 'rule'">技术指标规则脑</button>
                  <button type="button" class="seg-btn" :class="{ on: fbCfg.brainMode === 'cloud_llm' }" @click="fbCfg.brainMode = 'cloud_llm'">AI 大模型</button>
                </div>

                <div v-if="fbCfg.brainMode === 'rule'" class="section-sub" style="margin-top:8px; color: var(--accent-2)">
                  💡 基于内置技术指标自动扫描信号，无需 API Key，免费使用
                </div>
                <div v-if="fbCfg.brainMode === 'cloud_llm'" class="section-sub" style="margin-top:8px; color: var(--accent-2)">
                  💡 使用「AI模型」页配置的模型分析行情
                  <span v-if="aiCfg.useBuiltin" style="margin-left:8px; padding:2px 8px; border-radius:4px; background:rgba(255,215,0,0.15); color:#ffd700">当前：内置模型</span>
                  <span v-else-if="aiCfg.provider === 'ollama'" style="margin-left:8px; padding:2px 8px; border-radius:4px; background:rgba(100,200,255,0.15); color:#64c8ff">当前：本地 Ollama · 离线运行</span>
                  <span v-else-if="aiCfg.provider === 'cloud'" style="margin-left:8px; padding:2px 8px; border-radius:4px; background:rgba(100,255,100,0.15); color:#64ff64">当前：云端 API</span>
                </div>

                <!-- 交易模式选择 -->
                <div class="bridge-box" style="margin-top:12px">
                  <div class="bridge-title">
                    <span>🤖 交易模式</span>
                  </div>
                  <div class="section-sub">
                    选择机器人如何处理行情特征信号
                  </div>
                  <div class="bridge-grid" style="margin-top:10px">
                    <label class="ai-field">
                      <select v-model="fbCfg.tradeMode">
                        <option value="semi">半自动（只有高置信度自动下单）</option>
                        <option value="full">全自动（仅限模拟盘，所有信号直接下单）</option>
                        <option value="manual">人工确认（所有信号都需要人工确认）</option>
                      </select>
                    </label>
                  </div>
                </div>

                <!-- 规则脑指标说明 + 开关 -->
                <div v-if="fbCfg.brainMode === 'rule'" class="rule-indicators">
                  <div class="ri-title">📊 规则脑指标开关（关掉=该指标不参与打分）</div>
                  <div class="ri-grid">
                    <div v-for="ind in indicatorList" :key="ind.key" class="ri-item" :class="{ off: fbCfg.indicatorsEnabled?.[ind.key] === false }">
                      <div class="ri-head">
                        <b>{{ ind.name }}</b>
                        <button type="button" class="switch sm" :class="{ on: fbCfg.indicatorsEnabled?.[ind.key] !== false }"
                          @click="toggleIndicator(ind.key)">
                          <span class="knob"></span>
                        </button>
                      </div>
                      <span>{{ ind.desc }}</span>
                    </div>
                  </div>

                  <!-- 选择战法 -->
                  <div class="ri-title" style="margin-top:16px">🎯 选择战法（关掉=该战法不发出信号）</div>
                  <div class="ri-grid">
                    <div v-for="s in strategyList" :key="s.key" class="ri-item" :class="{ off: fbCfg.strategiesEnabled?.[s.key] === false }">
                      <div class="ri-head">
                        <b>{{ s.name }}</b>
                        <button type="button" class="switch sm" :class="{ on: fbCfg.strategiesEnabled?.[s.key] !== false }"
                          @click="toggleStrategy(s.key)">
                          <span class="knob"></span>
                        </button>
                      </div>
                      <span>{{ s.desc }}</span>
                    </div>
                  </div>
                </div>

                <!-- 折叠：高级参数 -->
                <details class="bk-advanced" style="margin-top:14px">
                  <summary>高级参数（止损/仓位/置信度）— 模拟交易和真实交易都用这套</summary>
                  <div class="fb-params" style="margin-top:10px">
                    <div class="ai-field">
                      <label>硬止损 %：{{ fbCfg.hardStopPct }}</label>
                      <input v-model.number="fbCfg.hardStopPct" type="range" min="-15" max="-3" step="0.5" />
                    </div>
                    <div class="ai-field">
                      <label>执行置信度：{{ fbCfg.execConfidence }}</label>
                      <input v-model.number="fbCfg.execConfidence" type="range" min="0.55" max="0.95" step="0.05" />
                    </div>
                    <div class="ai-field">
                      <label>观察置信度：{{ fbCfg.watchConfidence }}</label>
                      <input v-model.number="fbCfg.watchConfidence" type="range" min="0.4" max="0.75" step="0.05" />
                    </div>
                    <div class="ai-field">
                      <label>滑点 %：{{ fbCfg.slippagePct }}</label>
                      <input v-model.number="fbCfg.slippagePct" type="range" min="0" max="0.5" step="0.05" />
                    </div>
                    <div class="ai-field">
                      <label>单票仓位上限 %：{{ fbCfg.maxSinglePct }}</label>
                      <input v-model.number="fbCfg.maxSinglePct" type="range" min="5" max="50" step="1" />
                    </div>
                    <div class="ai-field">
                      <label>总仓位上限 %：{{ fbCfg.maxTotalPct }}</label>
                      <input v-model.number="fbCfg.maxTotalPct" type="range" min="20" max="100" step="5" />
                    </div>

                    <!-- 风控设置 -->
                    <div class="ai-field" style="margin-top:12px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.1);">
                      <label style="font-weight:600; color:#ff6464;">🛡️ 风控设置（保命用）</label>
                    </div>
                    <div class="ai-field">
                      <label>单日亏损限制 %：{{ fbCfg.dailyLossLimitPct }}（今天亏了就停止交易）</label>
                      <input v-model.number="fbCfg.dailyLossLimitPct" type="range" min="1" max="20" step="1" />
                    </div>
                    <div class="ai-field">
                      <label>最大回撤限制 %：{{ fbCfg.maxDrawdownLimitPct }}（从最高点跌了就清仓）</label>
                      <input v-model.number="fbCfg.maxDrawdownLimitPct" type="range" min="5" max="50" step="5" />
                    </div>
                    <div class="ai-field">
                      <label>连续亏损暂停：{{ fbCfg.consecutiveLossLimit }} 笔（连亏就暂停）</label>
                      <input v-model.number="fbCfg.consecutiveLossLimit" type="range" min="1" max="10" step="1" />
                    </div>
                  </div>
                  <div class="ai-field" style="margin-top:10px">
                    <label>禁止开仓时间（之后只卖不买）</label>
                    <input v-model="fbCfg.noOpenAfter" type="text" spellcheck="false" placeholder="14:55" />
                  </div>
                </details>

                <!-- 保存按钮 -->
                <div style="margin-top:16px; display:flex; gap:8px; align-items:center;">
                  <button type="button" class="logs-btn primary" @click="saveFastBrain">保存自动交易配置</button>
                  <span v-if="fbMsg" class="ai-msg" :class="{ ok: /成功|已保存/.test(fbMsg) }">{{ fbMsg }}</span>
                </div>
              </div>
            </div>

            <!-- 知识库（独立 tab）-->
            <div v-else-if="tab === 'knowledge'" class="ai-tab">
              <div class="section-title">📚 知识库</div>
              <div class="section-sub">
                导入你的研报、笔记、新闻 PDF，AI 问答时会自动参考这些资料。不用可以忽略。
              </div>

              <div class="startup-row" style="margin-top:16px">
                <div class="startup-info">
                  <div class="startup-name">每日自动入库</div>
                  <div class="section-sub" style="margin:3px 0 0">收盘后自动把当日资料切块入知识库</div>
                </div>
                <button type="button" class="switch" :class="{ on: aiCfg.enableAutoIndex }" @click="aiCfg.enableAutoIndex = !aiCfg.enableAutoIndex"><span class="knob"></span></button>
              </div>

              <div class="dc-stats kb-stats" style="margin-top:16px">
                <div class="dc-stat"><b>{{ kbData.total }}</b><span>总分块</span></div>
                <div class="dc-stat"><b>{{ kbData.embedded }}</b><span>已嵌入</span></div>
                <div class="dc-stat"><b>{{ kbSizeText }}</b><span>体积</span></div>
                <div class="dc-stat"><b>{{ kbDocs.length }}</b><span>文档数</span></div>
              </div>

              <div v-if="kbIndexing" class="kb-prog-wrap">
                <div class="kb-prog-label">
                  {{ kbProgress.phase === 'embed' ? '向量嵌入中' : '资料收集中' }} · {{ kbProgress.done }}/{{ kbProgress.total }}
                </div>
                <div class="kb-prog"><div class="kb-prog-bar" :style="{ width: kbProgPct + '%' }"></div></div>
              </div>

              <div class="ai-actions kb-actions" style="margin-top:16px">
                <button type="button" class="logs-btn primary" :disabled="kbBusy" @click="onImportDocs">📄 导入文档</button>
                <button type="button" class="logs-btn" :disabled="kbBusy" @click="onIndexToday">📥 入库今日</button>
                <button type="button" class="logs-btn" :disabled="kbBusy" @click="onReindex">🔄 重建嵌入</button>
              </div>

              <div class="kb-docs" style="margin-top:16px">
                <div v-if="!kbDocs.length" class="logs-empty" style="padding:30px 0; text-align:center">
                  📭 暂无文档<br>
                  <span style="font-size:11px; color:var(--text-dim)">点上方"导入文档"上传研报/笔记，或"入库今日"自动收当日资料</span>
                </div>
                <div v-for="d in kbDocs" :key="d[0]" class="kb-doc">
                  <span class="kbd-name" :title="d[0]">{{ d[0] }}</span>
                  <span class="kbd-chunks">{{ d[1] }} 块</span>
                  <button type="button" class="kbd-del" title="删除" @click="onDeleteDoc(d[0])">✕</button>
                </div>
              </div>
            </div>

            <!-- 券商交易（v2.6）-->
            <div v-else-if="tab === 'broker'" class="broker-tab">
              <!-- 顶部状态卡片 -->
              <div class="bk-status-card">
                <div class="bk-status-row">
                  <span class="bk-chip" :class="{ on: bStatus?.kind === 'mock' || bStatus?.connected }">
                    <template v-if="bForm && bForm.kind === 'mock'">
                      ⚪ 模拟交易 · 已就绪（本地虚拟资金，无需连接）
                    </template>
                    <template v-else-if="bForm && bForm.kind === 'client'">
                      {{ bStatus?.connected ? "● 实盘通道已连接" : "○ 实盘通道未连接" }}
                    </template>
                    <template v-else>
                      {{ bStatus?.connected ? "● QMT 已连接" : "○ QMT 未连接" }}
                    </template>
                  </span>
                  <button type="button" class="logs-btn" @click="refreshBStatus">刷新</button>
                </div>
                <div v-if="!bStatus?.connected && bSidecarErr" class="bk-sidecar-err">
                  连接失败：{{ bSidecarErr }}
                  <button type="button" class="logs-btn danger" @click="bSidecarErr = ''">知道了</button>
                </div>
                <div v-if="bStatus?.killSwitch" class="bk-kill-warn">
                  ⚠ Kill Switch 已触发 —— 所有交易通道已断开
                  <button type="button" class="logs-btn danger" @click="bReleaseKill">解除</button>
                </div>
              </div>

              <!-- P8 一键自检路径 -->
              <div class="bk-probe-bar">
                <button type="button" class="logs-btn primary" :disabled="bProbeBusy" @click="bProbeRun">
                  {{ bProbeBusy ? "探测中…" : "一键自检路径" }}
                </button>
                <span v-if="bProbeSummary" class="bk-probe-summary" :class="{ bad: (bProbe?.summary.bad ?? 0) > 0 }">{{ bProbeSummary }}</span>
                <span v-else class="bk-probe-tip">点「一键自检」检查本机 Python / 客户端 / OCR 路径是否可用，缺什么可直接自动填入</span>
              </div>

              <!-- 第一步：选通道（两卡：本地模拟交易 / 实盘） -->
              <div class="section-title" style="margin-top:20px">选择通道</div>
              <div v-if="bForm" class="bk-mode-grid">
                <label class="bk-mode-card" :class="{ on: bForm.kind === 'mock' }" @click="bPickChannel('mock')">
                  <div class="bk-mode-name">本地模拟交易</div>
                  <div class="bk-mode-desc">无需券商环境，本地虚拟资金，适合练手联调，可全自动</div>
                </label>
                <label class="bk-mode-card" :class="{ on: bForm.kind === 'client' && !bForm.clientSim }" @click="bPickChannel('live')">
                  <div class="bk-mode-name">实盘</div>
                  <div class="bk-mode-desc">操控本机同花顺真实资金账户，委托需人工确认，真实资金</div>
                </label>
              </div>

              <!-- 同花顺客户端通道（P3/P12）：程序路径必填，其余参数折叠 -->
              <template v-if="bForm && bForm.kind === 'client'">
                <div class="section-title" style="margin-top:20px">同花顺客户端程序路径</div>
                <div class="bk-auto-summary">
                  <span class="bk-auto-dot"></span>
                  <span v-if="bProbeSummary" class="bk-probe-summary" :class="{ bad: (bProbe?.summary.bad ?? 0) > 0 }">{{ bProbeSummary }}</span>
                  <span v-else class="bk-auto-tip">点「一键自检」自动探测本机 xiadan.exe；一般无需手动填写</span>
                </div>
                <div class="bridge-grid">
                  <label class="ai-field"><span>同花顺客户端路径（xiadan.exe）</span>
                    <div class="bk-probe-row">
                      <input v-model="bForm.clientPath" type="text" spellcheck="false" placeholder="xiadan.exe / 模拟炒股可执行文件，留空自动探测" />
                      <button type="button" class="bk-probe-btn" @click="bProbeFill('clientPath')" title="自动探测同花顺下单程序并填入">探测</button>
                    </div>
                    <span class="bk-probe-badge" :class="bProbeClass('clientPath')">{{ bProbeText('clientPath') }}</span>
                    <span v-if="bProbeItem('clientPath')" class="bk-probe-hint">{{ bProbeHint('clientPath') }}</span>
                  </label>
                </div>

                <details class="bk-advanced" style="margin-top:8px">
                <summary>参数细节（一般无需改动）</summary>
                <div class="bridge-grid">
                  <label class="ai-field"><span>Python 路径</span>
                    <div class="bk-probe-row">
                      <input v-model="bForm.pythonPath" type="text" spellcheck="false" placeholder="python.exe（3.10–3.12，装 pywinauto/pyautogui/pillow）" />
                      <button type="button" class="bk-probe-btn" @click="bProbeFill('pythonPath')" title="自动探测本机 python.exe 并填入">探测</button>
                    </div>
                    <span class="bk-probe-badge" :class="bProbeClass('pythonPath')">{{ bProbeText('pythonPath') }}</span>
                    <span v-if="bProbeItem('pythonPath')" class="bk-probe-hint">{{ bProbeHint('pythonPath') }}</span>
                  </label>
                  <label class="ai-field"><span>控件模板目录（可选）</span>
                    <input v-model="bForm.clientTemplateDir" type="text" spellcheck="false" placeholder="selectors.json 目录，留空用脚本内置" /></label>
                </div>
                <div class="bridge-grid">
                  <label class="ai-field"><span>最小操作间隔（毫秒）</span>
                    <input v-model.number="bForm.clientMinIntervalMs" type="number" min="300" step="100" /></label>
                  <div class="bk-ocr-block">
                    <div class="bk-sw-title" style="margin-top:0">验证码自动识别（OCR）</div>
                    <div class="bk-ocr-builtin" :class="{ off: bOcrStatus && !bOcrStatus.installed }">
                      {{ bOcrStatus ? (bOcrStatus.installed ? `✓ 内置引擎 ddddocr v${bOcrStatus.version} 已启用：复制表格遇验证码自动识别并提交` : "⚠ 内置引擎未安装：点下方「安装 / 升级」启用自动识别") : "检测 OCR 引擎中…" }}
                    </div>
                    <div class="bk-ocr-actions">
                      <button type="button" class="bk-probe-btn" :disabled="bOcrBusy" @click="bOcrManage('status')">探测引擎</button>
                      <button type="button" class="bk-probe-btn" :disabled="bOcrBusy" @click="bOcrManage('install')">安装 / 升级</button>
                      <button type="button" class="bk-probe-btn danger" :disabled="bOcrBusy || !bOcrStatus?.installed" @click="bOcrManage('uninstall')">卸载</button>
                    </div>
                    <div class="bk-probe-hint">内置引擎（ddddocr）点「安装 / 升级」即自动下载到 Python 环境，无需手动下载安装包；tesseract 仅作增强回退，可选。</div>
                    <label class="ai-field" style="margin-top:8px"><span>Tesseract OCR 路径（可选 · 增强回退）</span>
                      <div class="bk-probe-row">
                        <input v-model="bForm.clientTesseract" type="text" spellcheck="false" placeholder="tesseract.exe 路径，留空即可（内置引擎已够用）" />
                        <button type="button" class="bk-probe-btn" @click="bProbeFill('clientTesseract')" title="自动探测 tesseract.exe 并填入">探测</button>
                      </div>
                      <span class="bk-probe-badge" :class="bProbeClass('clientTesseract') === 'ok' ? 'ok' : ''">{{ bProbeItem('clientTesseract')?.status === 'ok' ? '✓ 已配置' : '未安装（可选回退）' }}</span>
                      <span v-if="bProbeItem('clientTesseract')" class="bk-probe-hint">{{ bProbeHint('clientTesseract') }}</span>
                    </label>
                  </div>
                </div>

                <div class="section-title" style="margin-top:16px">HTTP API 服务（THSAutoTrader 兼容）</div>
                <div class="section-sub">连接通道后在本机开放 REST 接口，供你的脚本 / EasyUp 平台 / Excel 宏调用下单与查询；仅监听 127.0.0.1，不绕过任何风控。<span style="color:var(--warn,#e8a33d)">注意：开启 API 端口后，360 安全卫士 / 腾讯电脑管家可能拦截通道进程导致无法连接；若提示「通道进程被终止」，请先关闭本服务或把 TickGold 加入安全软件信任区。</span></div>
                <div class="bk-switch-list">
                  <div class="bk-switch-row">
                    <div>
                      <div class="bk-sw-title">启用 API 服务</div>
                      <div class="section-sub">端口必须为 1024–65535；开启后连接通道即生效</div>
                    </div>
                    <button type="button" class="switch" :class="{ on: bForm.clientApiPort > 0 }" @click="bForm.clientApiPort = bForm.clientApiPort > 0 ? 0 : 5000"><span class="knob"></span></button>
                  </div>
                </div>
                <div class="bridge-grid">
                  <label class="ai-field"><span>端口（默认 5000）</span>
                    <input v-model.number="bForm.clientApiPort" type="number" min="1024" max="65535" step="1" :disabled="bForm.clientApiPort <= 0" /></label>
                  <label class="ai-field"><span>访问令牌（可选）</span>
                    <input v-model="bForm.clientApiToken" type="text" spellcheck="false" placeholder="留空=本机免密；设置后需 ?token= 或 Bearer 头" :disabled="bForm.clientApiPort <= 0" /></label>
                </div>
                <div v-if="bForm.clientApiPort > 0" class="bk-probe-hint" style="margin:6px 0 0">
                  API 地址：<code>http://127.0.0.1:{{ bForm.clientApiPort }}</code>{{ bForm.clientApiToken ? "（令牌保护）" : "（本机免密）" }} · 示例：curl http://127.0.0.1:{{ bForm.clientApiPort }}/balance
                </div>

                <div class="bk-switch-list">
                  <div class="bk-switch-row">
                    <div>
                      <div class="bk-sw-title">dry-run 空跑（不操控客户端）</div>
                      <div class="section-sub">开启后 sidecar 内置虚拟账户模拟全流程，不操控同花顺；关闭才真正操控客户端</div>
                    </div>
                    <button type="button" class="switch" :class="{ on: bForm.clientDryRun }" @click="bForm.clientDryRun = !bForm.clientDryRun"><span class="knob"></span></button>
                  </div>
                  <div class="bk-switch-row">
                    <div>
                      <div class="bk-sw-title">自动确认（全自动）</div>
                      <div class="section-sub">关闭则每笔下单前弹「截图确认桥」人工核对；仅模拟环境允许开启</div>
                    </div>
                    <button type="button" class="switch" :class="{ on: bForm.clientAutoConfirm, disabled: !bForm.clientSim }" @click="toggleClientAuto"><span class="knob"></span></button>
                  </div>
                </div>
                </details>

                <div class="bk-actions" style="margin-top:12px">
                  <button type="button" class="logs-btn primary big" :disabled="bConnectBusy" @click="bConnect">{{ bConnectBusy ? "连接中…" : "保存并连接" }}</button>
                  <button type="button" class="logs-btn" :disabled="bDisconnectBusy" @click="bDisconnect">{{ bDisconnectBusy ? "断开中…" : "断开" }}</button>
                  <button type="button" class="logs-btn" :disabled="bSelfcheckBusy" @click="bRefreshSelfcheck">{{ bSelfcheckBusy ? "自检中…" : "刷新自检" }}</button>
                </div>

                <div v-if="bSelfcheck" class="bk-selfcheck">
                  <div class="bk-sc-head">
                    <span class="bk-sc-title">连接自检</span>
                    <span class="bk-sc-mode">{{ bSelfcheck.vendor }} · {{ bSelfcheck.dryRun ? "dry-run 空跑" : bSelfcheck.sim ? "模拟交易" : "真实通道" }} · {{ bSelfcheck.mode }}</span>
                  </div>
                  <div v-for="(it, i) in bSelfcheck.checks" :key="i" class="bk-sc-item" :class="{ bad: !it.ok }">
                    <span class="bk-sc-ico">{{ it.ok ? "✓" : "✗" }}</span>
                    <span class="bk-sc-name">{{ it.name }}</span>
                    <span v-if="it.msg" class="bk-sc-msg">{{ it.msg }}</span>
                  </div>
                </div>
              </template>

              <!-- 模拟账户总资金（自定义，不写死100万） -->
              <template v-if="bForm && bForm.kind === 'mock'">
                <div class="section-title" style="margin-top:20px">模拟账户总资金</div>
                <div class="section-sub">自定义模拟盘初始总资金。保存后立即清空持仓 / 委托并按该本金重置。</div>
                <div class="mock-cash-row">
                  <label class="mock-cash-lb">总资金（元）</label>
                  <input v-model.number="bForm.mockInitCash" type="number" min="1000" step="10000" class="mock-cash-in" />
                  <button type="button" class="mock-cash-preset" @click="bForm.mockInitCash = 100000">10万</button>
                  <button type="button" class="mock-cash-preset" @click="bForm.mockInitCash = 500000">50万</button>
                  <button type="button" class="mock-cash-preset" @click="bForm.mockInitCash = 1000000">100万</button>
                  <button type="button" class="mock-cash-preset" @click="bForm.mockInitCash = 5000000">500万</button>
                </div>
                <div class="bk-actions" style="margin-top:10px">
                  <button type="button" class="logs-btn primary" @click="bSaveMockCash">保存并重置模拟账户</button>
                </div>
              </template>

              <!-- 第三步：实盘开关（醒目警示；默认折叠，模拟模式无需配置） -->
              <details class="bk-advanced" style="margin-top:16px">
              <summary>实盘与风控（模拟模式无需配置，保持出厂锁定即可）</summary>
              <div class="section-title" style="margin-top:14px">实盘委托</div>
              <div v-if="bForm && (bForm.kind === 'mock' || (bForm.kind === 'client' && bForm.clientSim))" class="bk-live-card disabled">
                <div>
                  <div class="bk-live-title">⚪ 当前为模拟模式</div>
                  <div class="section-sub">模拟交易不涉及真实委托。如需实盘，请在上方「选择通道」选「实盘」并按流程武装。</div>
                </div>
              </div>
              <div v-else-if="bForm && isLiveChannel" class="bk-arm" :class="{ armed: bForm.liveEnabled }">
                <!-- 武装状态条 -->
                <div class="bk-arm-status">
                  <div class="bk-arm-status-l">
                    <div class="bk-live-title">{{ bForm.liveEnabled ? '🔴 实盘已武装' : '⚪ 实盘未武装（锁定）' }}</div>
                    <div class="section-sub">
                      {{ bForm.liveEnabled
                        ? '真实通道运行中：每笔需人工截图确认，仅限白名单标的、限额内委托'
                        : '出厂即锁定，依次完成下方各项并武装后，真实委托才会被提交' }}
                    </div>
                  </div>
                  <button v-if="!bForm.liveEnabled" type="button" class="logs-btn danger" :disabled="armBusy" @click="bArm">武装实盘</button>
                  <button v-else type="button" class="logs-btn" @click="bDisarm">解除武装</button>
                </div>
                <div v-if="armError" class="bk-arm-msg" :class="{ ok: armErrorOk }">{{ armError }}</div>

                <!-- 武装后当日额度 -->
                <div v-if="bForm.liveEnabled && liveUsage" class="bk-arm-usage">
                  <div class="bk-usage-item"><span>今日已用买入</span><b class="live-red">{{ bFmtMoney(liveUsage.usedToday) }}</b></div>
                  <div class="bk-usage-item"><span>今日剩余额度</span><b class="live-amber">{{ bFmtMoney(liveUsage.remaining) }}</b></div>
                  <div class="bk-usage-item"><span>单日上限</span><b>{{ bFmtMoney(liveUsage.dailyLimit) }}</b></div>
                  <div class="bk-usage-item"><span>白名单</span><b>{{ liveUsage.whitelist.length }} 只</b></div>
                </div>

                <!-- ① 单笔上限 -->
                <div class="bk-arm-step">
                  <div class="bk-arm-step-h">① 单笔金额上限（元）</div>
                  <div class="mock-cash-row">
                    <input v-model.number="bForm.liveMaxOrderAmount" type="number" min="0" step="1000" class="mock-cash-in" />
                    <button type="button" class="mock-cash-preset" @click="bForm.liveMaxOrderAmount = 10000">1万</button>
                    <button type="button" class="mock-cash-preset" @click="bForm.liveMaxOrderAmount = 50000">5万</button>
                    <button type="button" class="mock-cash-preset" @click="bForm.liveMaxOrderAmount = 100000">10万</button>
                  </div>
                  <div class="section-sub">单笔委托金额（价格 × 数量）超过上限一律拒绝；<b>0 = 实盘锁定</b>。</div>
                </div>

                <!-- ② 单日累计上限 -->
                <div class="bk-arm-step">
                  <div class="bk-arm-step-h">② 单日累计买入上限（元）</div>
                  <div class="mock-cash-row">
                    <input v-model.number="bForm.liveMaxDailyAmount" type="number" min="0" step="10000" class="mock-cash-in" />
                    <button type="button" class="mock-cash-preset" @click="bForm.liveMaxDailyAmount = 50000">5万</button>
                    <button type="button" class="mock-cash-preset" @click="bForm.liveMaxDailyAmount = 200000">20万</button>
                    <button type="button" class="mock-cash-preset" @click="bForm.liveMaxDailyAmount = 500000">50万</button>
                    <button type="button" class="logs-btn danger" @click="bSaveLiveLimits">保存限额</button>
                  </div>
                  <div class="section-sub">单日真实买入累计（不含已撤/已拒）超过上限即拒绝，次日重置。</div>
                </div>

                <!-- ③ 白名单 -->
                <div class="bk-arm-step">
                  <div class="bk-arm-step-h">③ 实盘标的白名单（至少 1 只）</div>
                  <div class="mock-cash-row">
                    <input v-model="wlInput" type="text" maxlength="6" class="mock-cash-in" placeholder="6 位代码，如 600519" @keyup.enter="bAddWhitelist" />
                    <button type="button" class="mock-cash-preset" @click="bAddWhitelist">添加</button>
                  </div>
                  <div class="bk-wl-tags">
                    <span v-for="c in wlList" :key="c" class="bk-wl-tag">{{ c }}<i title="移出" @click="bRemoveWhitelist(c)">×</i></span>
                    <span v-if="!wlList.length" class="section-sub">（空）真实通道将拒绝所有标的</span>
                  </div>
                </div>

                <!-- ④ 同花顺真实通道：模拟演练 + 半自动提示 -->
                <div v-if="bForm.kind === 'client'" class="bk-arm-step">
                  <div class="bk-arm-step-h">④ 实盘演练确认</div>
                  <label class="bk-drill">
                    <input type="checkbox" :checked="bForm.liveSimDrillPassed" @change="bToggleDrill" />
                    <span>我已在同花顺「模拟炒股」完成真机演练（登录、半自动连续成功、撤单、资产/持仓回报正常）</span>
                  </label>
                  <div class="section-sub live-amber">同花顺真实通道强制半自动：每笔都需人工点确认，自动确认已永久禁用。</div>
                </div>

                <!-- ⑤/④ 合规与报备 + 风险告知（P0-4 强化） -->
                <div class="bk-arm-step">
                  <div class="bk-arm-step-h">{{ bForm.kind === 'client' ? '⑤' : '④' }} 合规与报备确认（逐项勾选）</div>
                  <div class="bk-arm-notice bk-compliance">
                    <label v-for="(txt, i) in COMPLIANCE_ITEMS" :key="i" class="bk-comp-item">
                      <input type="checkbox" :checked="complianceAck[i]" @change="toggleCompliance(i)" />
                      <span>{{ txt }}</span>
                    </label>
                  </div>
                  <div class="bk-arm-notice" style="margin-top:8px">
                    实盘委托将产生真实资金变动，风险自担；无实时涨跌停行情时将拒绝下单，防止乌龙指。
                  </div>
                  <input v-model="armAckText" type="text" class="mock-cash-in bk-arm-ack" placeholder="请先勾选上方三项，再输入「风险确认」四个字" @input="armError=''; armErrorOk=false" />
                </div>
              </div>

              <!-- 账户级风控阈值（全通道唯一事实源；模拟 / 条件单 / 自动机器人 / 实盘共用） -->
              <template v-if="bForm">
                <div class="section-title" style="margin-top:20px">账户级风控阈值（全通道统一）</div>
                <div class="section-sub">
                  手动模拟、条件单、自动机器人、实盘共用同一套阈值；触发后仅停止开新仓，卖出永不锁死。
                </div>
                <div class="bridge-grid" style="margin-top:8px">
                  <label class="ai-field"><span>单日亏损上限 %：{{ bForm.dailyLossLimitPct }}</span>
                    <input v-model.number="bForm.dailyLossLimitPct" type="range" min="1" max="20" step="0.5" /></label>
                  <label class="ai-field"><span>累计回撤上限 %：{{ bForm.maxDrawdownLimitPct }}</span>
                    <input v-model.number="bForm.maxDrawdownLimitPct" type="range" min="5" max="50" step="1" /></label>
                  <label class="ai-field"><span>连续亏损笔数上限：{{ bForm.consecutiveLossLimit }}</span>
                    <input v-model.number="bForm.consecutiveLossLimit" type="range" min="2" max="10" step="1" /></label>
                </div>
              </template>
              </details>

              <!-- 折叠：高级设置 -->
              <details class="bk-advanced" style="margin-top:20px">
                <summary>高级设置（模拟工具 / 紧急停止）</summary>

                <div v-if="bForm" class="bridge-grid" style="margin-top:10px">
                  <label class="ai-field"><span>预留费用%：{{ bForm.feePct }}</span>
                    <input v-model.number="bForm.feePct" type="range" min="0" max="1" step="0.01" /></label>
                </div>

                <!-- 模拟工具 -->
                <div v-if="bForm" class="bk-actions" style="margin-top:14px">
                  <button type="button" class="logs-btn" @click="bMockReset">清空模拟账户（恢复当前配置本金）</button>
                  <label class="ai-field">
                    <input v-model="bForm.mockAllowAnytime" type="checkbox" />
                    休市/周末也能买卖（联调用）
                  </label>
                </div>

                <!-- 一键急停（v3.0.0-rc 全局统一） -->
                <div class="section-title" style="margin-top:18px">一键急停</div>
                <div class="section-sub">
                  封死新委托、停止自动执行、撤销全部条件单与在途委托、断开券商通道；快捷键 Ctrl+Alt+K（零确认）。恢复需手动解除 → 重连 → 重启自动执行。
                </div>
                <div class="bk-actions">
                  <button type="button" class="logs-btn danger" @click="bEmergencyHalt">一键急停（撤全部）</button>
                </div>
              </details>

              <div class="bk-actions" style="margin-top:16px">
                <button type="button" class="logs-btn primary" @click="saveBroker">保存配置</button>
                <span v-if="bMsg" class="ai-msg" :class="{ ok: bMsg.includes('已保存') }">{{ bMsg }}</span>
              </div>
            </div>

            <div v-else-if="tab === 'plugins'" class="plugin-tab">
              <div class="section-title">插件生态 <span class="p-beta">beta</span></div>
              <div class="section-sub">卡片微件 / 自定义指标 / 自定义数据源。逻辑在受限 QuickJS 沙箱运行、UI 在隔离 frame 渲染；插件不能访问券商交易能力。</div>

              <div class="p-toolbar">
                <button type="button" class="logs-btn" @click="scanPlugins">扫描插件目录</button>
                <label class="p-dev"><input type="checkbox" :checked="devMode" @change="toggleDev" /> 开发者模式（允许运行未签名的本地插件）</label>
              </div>

              <div class="section-title" style="margin-top:16px">本地安装</div>
              <div class="p-install">
                <input v-model="installPath" type="text" spellcheck="false" placeholder="粘贴插件文件夹完整路径（文件夹内含 plugin.json）" />
                <button type="button" class="logs-btn primary" @click="doInstall">安装</button>
              </div>

              <div class="section-title" style="margin-top:18px">已登记插件</div>
              <div class="p-list">
                <div v-for="r in plugins" :key="r.pluginId" class="p-item">
                  <div class="p-rowhead">
                    <div class="p-name">
                      <span class="p-nm">{{ r.name || r.pluginId }}</span>
                      <span v-if="r.builtin" class="p-tag builtin">内置</span>
                      <span v-if="r.signed" class="p-tag signed">已签名</span>
                      <span v-else class="p-tag unsig">未签名</span>
                      <span class="p-version">v{{ r.version }}</span>
                    </div>
                    <div class="p-ops">
                      <button type="button" class="p-op" @click="togglePlugin(r)">{{ r.enabled ? "停用" : "启用" }}</button>
                      <button v-if="devMode && r.enabled" type="button" class="p-op" @click="reloadPlugin(r)">热重载</button>
                      <button v-if="!r.builtin" type="button" class="p-op danger" @click="removePlugin(r)">卸载</button>
                    </div>
                  </div>
                  <div class="p-meta">
                    <span class="p-status" :class="{ bad: r.status === 'error' }">{{ r.status }}</span>
                    <span class="p-scopes"><span v-for="s in r.permissions" :key="s" class="p-scope">{{ s }}</span></span>
                  </div>
                  <div v-if="r.errorMsg" class="p-err">{{ r.errorMsg }}</div>
                  <div v-if="isL2Plugin(r)" class="l2-key">
                    <div class="l2-key-head">
                      <span class="l2-key-title">Level-2 数据源 API Key</span>
                      <span class="l2-key-badge" :class="{ set: l2KeySet[r.pluginId] }">
                        {{ l2KeySet[r.pluginId] ? "已配置" : "未配置" }}
                      </span>
                    </div>
                    <div class="l2-key-row">
                      <input
                        v-model="l2Input[r.pluginId]"
                        type="password"
                        spellcheck="false"
                        autocomplete="off"
                        placeholder="粘贴数据商 API Key（仅存本机系统凭据箱）"
                        @keyup.enter="saveL2Key(r)"
                        :disabled="!license.isPro"
                      />
                      <button type="button" class="p-op" :disabled="l2Busy[r.pluginId] || !license.isPro" @click="saveL2Key(r)">保存</button>
                      <button
                        v-if="l2KeySet[r.pluginId]"
                        type="button"
                        class="p-op danger"
                        :disabled="l2Busy[r.pluginId]"
                        @click="clearL2Key(r)"
                      >清除</button>
                    </div>
                    <div class="l2-key-note">
                      <b>数据合规声明：</b>Level-2 行情（十档/逐笔）属持牌或授权数据，须由具备合法资质的机构提供。请确认你的数据商账号已获授权；数据仅供个人学习使用，<b>不得转售、再分发或用于商业产品</b>。Key 仅保存在系统凭据箱、由宿主代发请求时注入，永不进入插件沙箱；数据口径与使用合规责任由你与数据商的协议约定，本应用不内置任何 Level-2 数据。
                    </div>
                  </div>
                </div>
                <div v-if="!plugins.length" class="p-empty">暂无插件，点击「扫描插件目录」发现内置插件</div>
              </div>

              <div v-if="pMsg" class="ai-msg" :class="{ ok: pMsgOk }" style="margin-top:12px">{{ pMsg }}</div>
            </div>

            <!-- 诊断日志 -->
            <div v-else-if="tab === 'logs'" class="logs-panel">
              <div class="logs-bar">
                <label class="logs-lvl">级别
                  <select :value="logMin" @change="onLevelChange">
                    <option v-for="l in LEVELS" :key="l" :value="l">{{ l.toUpperCase() }}</option>
                  </select>
                </label>
                <button class="logs-btn" @click="refreshLogs">刷新</button>
                <button class="logs-btn" @click="clearLogs">清空</button>
                <button class="logs-btn primary" @click="exportLogs">导出日志</button>
              </div>
              <div v-if="logMsg" class="logs-msg">{{ logMsg }}</div>
              <div class="logs-list">
                <div v-if="!logRows.length" class="logs-empty">暂无日志</div>
                <div v-for="(r, i) in logRows" :key="i" class="log-line" :class="r.level">
                  <span class="ll-t">{{ r.t }}</span>
                  <span class="ll-l">{{ r.level.toUpperCase() }}</span>
                  <span class="ll-s">{{ r.source }}</span>
                  <span class="ll-m">{{ r.message }}</span>
                </div>
              </div>
              <div class="logs-note">日志仅保存在本机内存（前后端各保留最近 500 条），不会上传；遇到问题可导出后用于反馈定位。</div>
            </div>

            <!-- 关于 -->
            <div v-else-if="tab === 'about'" class="about">
              <div class="ab-logo">TG</div>
              <div class="ab-name">TickGold</div>
              <div class="ab-desc">开源跨平台 A 股盯盘终端</div>
              <div class="ab-tech">Tauri 2.0 · Rust · Vue 3 · TypeScript · ECharts</div>
              <div class="ab-version">当前版本：v{{ appVersion || "—" }}</div>
              <div class="ab-actions">
                <button type="button" class="ab-primary" @click="emit('check-update')">检查更新</button>
                <button type="button" class="ab-ghost" @click="replayOnboarding">新手引导</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.set-mask {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center; padding: 20px;
  background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(3px);
}
.set-dialog {
  width: 720px; max-width: 94vw; height: 470px; max-height: 88vh;
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 14px;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.65);
}
.set-head {
  height: 48px; flex: none; display: flex; align-items: center; padding: 0 14px 0 18px;
  border-bottom: 1px solid var(--border);
}
.set-title { font-size: 15px; font-weight: 700; color: var(--text); }
.set-x {
  margin-left: auto; display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 7px; border: none;
  background: transparent; color: var(--text-dim); cursor: pointer;
}
.set-x:hover { background: var(--bg-hover); color: var(--text); }

.set-main { flex: 1; display: flex; min-height: 0; }
.set-nav {
  width: 150px; flex: none; display: flex; flex-direction: column; gap: 4px;
  padding: 12px 10px; border-right: 1px solid var(--border);
}
.nav-item {
  display: flex; align-items: center; gap: 9px; padding: 9px 12px;
  border: none; border-radius: 8px; background: transparent;
  color: var(--text-dim); font-size: 12px; font-weight: 600; cursor: pointer; text-align: left;
}
.nav-item:hover { background: var(--bg-hover); color: var(--text); }
.nav-item.on { color: var(--accent-2); background: color-mix(in srgb, var(--accent) 15%, transparent); }

.set-content { flex: 1; min-width: 0; overflow: auto; padding: 20px 22px; }
.section-title { font-size: 13px; font-weight: 700; color: var(--text); }
.section-sub { font-size: 11px; color: var(--text-dim); margin: 4px 0 18px; }

.theme-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.theme-card {
  display: flex; gap: 12px; padding: 12px; text-align: left;
  border: 1px solid var(--border); border-radius: 11px;
  background: var(--bg-card); cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s;
}
.theme-card:hover { border-color: var(--border-light); }
.theme-card.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.tc-preview { display: flex; gap: 3px; flex: none; }
.swatch { width: 13px; height: 42px; border-radius: 4px; display: block; }
.tc-info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 5px; }
.tc-name { font-size: 12px; font-weight: 700; color: var(--text); display: flex; align-items: center; }
.tc-check { color: var(--accent-2); margin-left: 6px; }
.tc-desc { font-size: 11px; color: var(--text-dim); line-height: 1.5; }

.ph { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-dim); gap: 10px; font-size: 12px; }
.ph2 { opacity: 0.6; font-size: 11px; }

.startup-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px; border: 1px solid var(--border); border-radius: 11px; background: var(--bg-card);
}
.startup-info { min-width: 0; }
.startup-name { font-size: 12.5px; font-weight: 700; color: var(--text); }
.switch {
  flex: none; width: 42px; height: 24px; border-radius: 13px; border: none; cursor: pointer;
  background: #3a434f; padding: 2px; transition: background .18s;
}
.switch.on { background: #2f6fed; }
.switch:disabled { opacity: .6; cursor: default; }
.knob {
  display: block; width: 20px; height: 20px; border-radius: 50%; background: #fff;
  transition: transform .18s; transform: translateX(0);
}
.switch.on .knob { transform: translateX(18px); }

/* 数据中心 */
.data-center { display: flex; flex-direction: column; gap: 10px; }
.dc-banner {
  display: flex; align-items: center; gap: 12px;
  padding: 13px 15px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-card);
}
.dc-dot { width: 10px; height: 10px; border-radius: 50%; background: #555; flex: none; }
.dc-dot.on { background: #26d07c; box-shadow: 0 0 0 4px rgba(38, 208, 124, 0.15); }
.dc-bt { flex: 1; min-width: 0; }
.dc-title { font-size: 13px; font-weight: 700; color: var(--text); }
.dc-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
.dc-daily {
  flex: none; font-size: 11px; padding: 5px 11px; border-radius: 20px;
  border: 1px solid var(--border); color: var(--text-dim); white-space: nowrap;
}
.dc-daily.ok { color: #26d07c; border-color: rgba(38, 208, 124, 0.5); background: rgba(38, 208, 124, 0.1); }
.dc-rows { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 11px; overflow: hidden; }
.dc-row { display: flex; align-items: center; justify-content: space-between; padding: 9px 14px; font-size: 12px; background: var(--bg-card); }
.backup-row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; margin-top: 8px; font-size: 12px;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 9px;
}
.backup-info { flex: 1; min-width: 0; }
.backup-id { font-weight: 600; }
.backup-meta { margin-top: 2px; color: var(--text-dim); font-size: 11px; }
.backup-verify { margin-top: 4px; font-size: 10.5px; font-weight: 600; }
.backup-verify.ok { color: var(--down); }
.backup-verify.bad { color: var(--up); }
.gov-trow { display: inline-block; margin: 2px 8px 2px 0; color: var(--text-dim); font-size: 11px; }
.dc-row + .dc-row { border-top: 1px solid var(--border); }
.dr-k { color: var(--text-dim); }
.dr-v { color: var(--text); }
.dc-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.dc-stat {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 13px 6px; border: 1px solid var(--border); border-radius: 11px; background: var(--bg-card);
}
.dc-stat b { font-size: 19px; font-weight: 800; color: var(--accent-2); }
.dc-stat span { font-size: 10.5px; color: var(--text-dim); }
.dc-note { font-size: 11px; color: var(--text-dim); line-height: 1.6; }
.dc-err { font-size: 11px; color: #f23645; background: rgba(242, 54, 69, 0.1); border-radius: 8px; padding: 8px 11px; }

.about { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
.ab-logo {
  width: 60px; height: 60px; border-radius: 16px; display: flex; align-items: center; justify-content: center;
  font-size: 22px; font-weight: 800; color: #15151a;
  background: linear-gradient(135deg, #e8c66a, #c8992e);
  box-shadow: 0 8px 26px rgba(212, 175, 55, 0.35); margin-bottom: 6px;
}
.ab-name { font-size: 17px; font-weight: 800; color: var(--text); }
.ab-desc { font-size: 12px; color: var(--text-dim); }
.ab-tech { font-size: 11px; color: var(--text-dim); opacity: 0.75; margin: 4px 0; }

/* 诊断日志 */
.logs-panel { display: flex; flex-direction: column; gap: 10px; height: 100%; }
.logs-bar { display: flex; align-items: center; gap: 8px; flex: none; }
.logs-lvl { font-size: 11px; color: var(--text-dim); display: flex; align-items: center; gap: 6px; }
.logs-lvl select {
  padding: 5px 8px; font-size: 11px; color: var(--text);
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 7px; cursor: pointer;
}
.logs-btn {
  padding: 6px 14px; font-size: 11px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text); cursor: pointer;
}
.logs-btn:hover { border-color: var(--border-light); }
.logs-btn.primary { color: var(--accent-2); border-color: var(--accent); }
.logs-msg { font-size: 11px; color: var(--text-dim); flex: none; }
.logs-list {
  flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border);
  border-radius: 10px; background: var(--bg-card); padding: 4px 0;
}
.logs-empty { padding: 30px; text-align: center; font-size: 11px; color: var(--text-dim); }
.log-line {
  display: grid; grid-template-columns: 74px 52px 120px 1fr;
  gap: 8px; padding: 3px 12px; font-size: 11px; line-height: 1.5;
  align-items: baseline; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
}
.ll-t { color: var(--text-dim); font-variant-numeric: tabular-nums; }
.ll-l { font-weight: 700; font-size: 10px; }
.ll-s { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ll-m { color: var(--text); word-break: break-word; }
.log-line.error .ll-l { color: #ff5d6b; }
.log-line.warn .ll-l { color: #e8c66a; }
.log-line.info .ll-l { color: #5aa9ff; }
.log-line.debug .ll-l { color: var(--text-dim); }
.log-line.error .ll-m { color: #ff8b95; }
.logs-note { flex: none; font-size: 10.5px; color: var(--text-dim); line-height: 1.6; }

/* 弹窗过渡 */
.dlg-enter-active, .dlg-leave-active { transition: opacity 0.22s; }
.dlg-enter-active .set-dialog, .dlg-leave-active .set-dialog { transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.22s; }
.dlg-enter-from, .dlg-leave-to { opacity: 0; }
.dlg-enter-from .set-dialog, .dlg-leave-to .set-dialog { transform: scale(0.94); opacity: 0; }
.seg { display: inline-flex; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.seg-btn { background: transparent; color: var(--text-dim); border: none; padding: 6px 14px; cursor: pointer; font-size: 12.5px; font-family: inherit; }
.seg-btn.on { background: var(--accent); color: #1a1407; font-weight: 700; }
.seg-btn + .seg-btn { border-left: 1px solid var(--border); }
.ab-replay { margin-top: 16px; background: transparent; color: var(--accent); border: 1px solid var(--border-light); border-radius: 8px; padding: 8px 20px; cursor: pointer; font-size: 13px; font-family: inherit; }
.ab-replay:hover { background: var(--bg-hover); }
.ab-ver { font-size: 12px; color: var(--accent); margin-top: 6px; font-weight: 600; }
.ab-actions { display: flex; gap: 10px; margin-top: 18px; }
.ab-primary {
  background: var(--accent); color: #000; border: none;
  border-radius: 8px; padding: 8px 22px; cursor: pointer;
  font-size: 13px; font-weight: 600; font-family: inherit;
}
.ab-primary:hover { filter: brightness(1.1); }
.ab-ghost {
  background: transparent; color: var(--text-dim); border: 1px solid var(--border-light);
  border-radius: 8px; padding: 8px 18px; cursor: pointer; font-size: 13px; font-family: inherit;
}
.ab-ghost:hover { background: var(--bg-hover); color: var(--text); }

/* 卡片皮肤 */
.skin-card { position: relative; cursor: pointer; }
.skin-card-tools {
  position: absolute; top: 5px; right: 6px; display: none; gap: 2px;
}
.skin-card:hover .skin-card-tools { display: flex; }
.skin-card-tools button {
  width: 18px; height: 18px; border: none; border-radius: 4px;
  background: var(--bg-hover); color: var(--text-dim); font-size: 10px; cursor: pointer;
}
.skin-card-tools button:hover { color: var(--text); }
.skin-bar { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.skin-msg { font-size: 11px; color: var(--text-dim); }

/* AI 配置 Tab */
.ai-tab { display: flex; flex-direction: column; }
.bridge-box { margin-top:14px; padding:10px 12px; border:1px solid var(--border,#2a3344); border-radius:10px; background:rgba(255,255,255,0.02); }
.bridge-title { display:flex; align-items:center; justify-content:space-between; font-weight:700; color:var(--text,#e6ecf5); font-size:12px; }
.bridge-grid { display:flex; gap:12px; margin-top:10px; flex-wrap:wrap; }
.bridge-grid .ai-field { flex:1; min-width:130px; display:flex; flex-direction:column; gap:4px; color:var(--text-dim,#97a0b2); }
.bridge-grid .ai-field.grow2 { flex:2; min-width:200px; }
.bridge-grid input, .bridge-grid select { background:var(--bg-input,#0e1117); border:1px solid var(--border,#2a3344); border-radius:6px; color:var(--text,#e6ecf5); padding:5px 8px; font-size:11px; }
.bridge-tpl { width:100%; box-sizing:border-box; background:var(--bg-input,#0e1117); border:1px solid var(--border,#2a3344); border-radius:6px; color:var(--text,#e6ecf5); padding:6px 8px; font-size:11px; resize:vertical; font-family:inherit; line-height:1.5; }
.tpl-hint { color:var(--text-dim,#7d8698); font-size:10px; line-height:1.6; }
.ai-provider { align-self: flex-start; margin-bottom: 4px; }
/* ===== AI 模型对比卡片 ===== */
.ai-compare { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.ai-compare-row { display: flex; gap: 12px; padding: 12px 14px; border-radius: 10px;
  background: rgba(255,255,255,.02); border: 1px solid rgba(255,255,255,.06); transition: all .15s; }
.ai-compare-row.active { border-color: rgba(0,255,213,.4); background: rgba(0,255,213,.04); }
.ai-compare-icon { font-size: 22px; flex: none; }
.ai-compare-body { flex: 1; min-width: 0; }
.ai-compare-name { font-size: 13px; font-weight: 600; color: #fff; margin-bottom: 4px; }
.ai-compare-desc { font-size: 11.5px; color: #9fb3d1; line-height: 1.6; margin-bottom: 6px; }
.ai-compare-tags { display: flex; gap: 5px; flex-wrap: wrap; }
.ai-tag { font-size: 10px; padding: 2px 7px; border-radius: 4px; font-weight: 500; }
.ai-tag.green { color: #00ffd5; background: rgba(0,255,213,.1); border: 1px solid rgba(0,255,213,.25); }
.ai-tag.yellow { color: #ffd76a; background: rgba(255,215,106,.1); border: 1px solid rgba(255,215,106,.25); }
.ai-tag.orange { color: #ffa94d; background: rgba(255,169,77,.1); border: 1px solid rgba(255,169,77,.25); }
.current-model-tip { padding: 10px 14px; border-radius: 8px; font-size: 12px; color: #9fb3d1;
  background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); margin: 10px 0; }

/* ===== Ollama 模型管理面板 ===== */
.ollama-panel { margin: 12px 0; padding: 14px; border-radius: 10px;
  background: rgba(255,255,255,.02); border: 1px solid rgba(255,255,255,.08); }
.ollama-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.ollama-title { font-size: 13px; font-weight: 600; color: #e6ecf5; }
.ollama-head .logs-btn { margin-left: auto; }
.ollama-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: #9fb3d1; }
.ollama-dot { width: 8px; height: 8px; border-radius: 50%; background: #666; }
.ollama-dot.ok { background: #4ade80; box-shadow: 0 0 6px rgba(74,222,128,.5); }
.ollama-status.ok { color: #4ade80; }
.ollama-error { padding: 14px 16px; border-radius: 10px;
  background: rgba(255,169,77,.08); border: 1px solid rgba(255,169,77,.3); }
.ollama-error-title { font-size: 13px; font-weight: 600; color: #ffa94d; margin-bottom: 6px; }
.ollama-error-desc { font-size: 11.5px; color: #9fb3d1; line-height: 1.6; margin-bottom: 10px; }
.ollama-steps { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.ollama-step { font-size: 11.5px; color: #9fb3d1; }
.ollama-install-btn { padding: 8px 16px; border-radius: 8px; font-size: 12px; font-weight: 600;
  border: none; background: linear-gradient(135deg, #ffa94d, #ff6b35); color: #fff; cursor: pointer; }
.ollama-install-btn:hover { opacity: 0.9; }
.ollama-section { margin-top: 10px; }
.ollama-sec-title { font-size: 11px; font-weight: 600; color: #9fb3d1; margin-bottom: 6px; }
.ollama-model-row { display: flex; align-items: center; gap: 10px; padding: 7px 10px;
  border-radius: 6px; background: rgba(0,0,0,.2); margin-bottom: 4px; font-size: 12px; }
.ollama-model-name { color: #e6ecf5; font-weight: 500; font-family: monospace; min-width: 140px; }
.ollama-model-size { color: #6b7f9b; font-size: 11px; min-width: 80px; }
.ollama-model-desc { color: #6b7f9b; font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ollama-use-btn { padding: 3px 10px; border-radius: 5px; font-size: 11px; cursor: pointer;
  border: 1px solid rgba(0,255,213,.3); background: rgba(0,255,213,.08); color: #00ffd5; }
.ollama-use-btn.active { background: rgba(0,255,213,.2); font-weight: 600; }
.ollama-del-btn { padding: 3px 8px; border-radius: 5px; font-size: 11px; cursor: pointer;
  border: 1px solid rgba(255,95,87,.3); background: rgba(255,95,87,.08); color: #ff5f57; }
.ollama-del-btn:hover { background: rgba(255,95,87,.15); }
.ollama-dl-btn { padding: 3px 12px; border-radius: 5px; font-size: 11px; cursor: pointer;
  border: 1px solid rgba(232,200,120,.3); background: rgba(232,200,120,.08); color: #e8c878; }
.ollama-dl-btn:hover:not(.disabled) { background: rgba(232,200,120,.15); }
.ollama-dl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ollama-dl-btn.disabled { opacity: .6; cursor: default; }
.ollama-progress { margin-top: 8px; }
.ollama-progress-bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,.08); overflow: hidden; margin-bottom: 4px; }
.ollama-progress-fill { height: 100%; background: linear-gradient(90deg, #e8c878, #00ffd5); transition: width .3s; }
.ollama-progress span { font-size: 11px; color: #9fb3d1; }

.builtin-tip {
  margin: 0 0 12px; padding: 12px 14px;
  border: 1px solid rgba(0,255,213,.35); border-radius: 10px;
  background: rgba(0,255,213,.06);
}
.builtin-title { font-size: 13px; font-weight: 600; color: #00ffd5; }
.ai-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 13px; }
.ai-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ai-field label { font-size: 11.5px; font-weight: 600; color: var(--text-dim); display: flex; align-items: center; gap: 8px; }
.mini-link {
  margin-left: auto; font-size: 10.5px; font-weight: 500; cursor: pointer;
  background: transparent; border: 1px solid var(--border); color: var(--accent-2);
  padding: 2px 8px; border-radius: 5px; font-family: inherit;
}
.mini-link:hover:not(:disabled) { background: var(--bg-hover); }
.mini-link:disabled { opacity: 0.5; cursor: default; }
.field-hint { font-size: 10.5px; color: #26d07c; margin-top: 2px; }
.model-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.model-chip {
  font-size: 11px; padding: 4px 10px; border-radius: 12px; cursor: pointer;
  background: var(--bg-hover); border: 1px solid var(--border); color: var(--text);
  font-family: "JetBrains Mono", monospace;
}
.model-chip:hover { border-color: var(--accent-2); color: var(--accent-2); }
.model-chip.on { background: var(--accent-2); color: #fff; border-color: var(--accent-2); }
.ai-field input[type="text"],
.ai-field input[type="password"] {
  padding: 8px 11px; font-size: 12px; color: var(--text);
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px;
  outline: none; font-family: inherit;
}
.ai-field input:focus { border-color: var(--accent); }
.ai-field input[type="range"] { accent-color: var(--accent); width: 100%; }
.ai-keyrow { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.ai-keyrow input {
  flex: 1; padding: 8px 11px; font-size: 12px; color: var(--text);
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; outline: none;
}
.key-ok { font-size: 11.5px; color: #26d07c; }
.ai-actions { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.ai-msg { font-size: 11.5px; color: #f25868; }
.ai-msg.ok { color: #26d07c; }
.ai-tip { margin-top: 14px; font-size: 10.5px; color: var(--text-dim); line-height: 1.6; }

/* 知识库 */
.kb-stats { margin-bottom: 12px; }
.kb-kinds { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.kb-kind {
  font-size: 10.5px; padding: 3px 9px; border-radius: 20px;
  background: var(--bg-card); border: 1px solid var(--border); color: var(--text-dim);
}
.kb-prog-wrap { margin-bottom: 12px; }
.kb-prog-label { font-size: 11px; color: var(--text-dim); margin-bottom: 5px; }
.kb-prog-err { color: #f25868; }
.kb-prog { height: 6px; border-radius: 3px; background: var(--bg); overflow: hidden; }
.kb-prog-bar {
  height: 100%; border-radius: 3px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2)); transition: width .25s;
}
.kb-actions { margin-top: 2px; }
.kb-docs {
  margin-top: 12px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-card); max-height: 168px; overflow: auto;
}
.kb-doc { display: flex; align-items: center; gap: 10px; padding: 7px 12px; font-size: 11.5px; }
.kb-doc + .kb-doc { border-top: 1px solid color-mix(in srgb, var(--border) 45%, transparent); }
.kbd-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.kbd-chunks { color: var(--text-dim); font-size: 10.5px; flex: none; }
.kbd-del {
  width: 20px; height: 20px; border: none; border-radius: 5px; background: transparent;
  color: var(--text-dim); cursor: pointer; flex: none;
}
.kbd-del:hover { background: var(--bg-hover); color: #f25868; }

/* 快脑控制台 */
.fb-urlrow { display: flex; gap: 8px; }
.fb-urlrow input { flex: 1; padding: 8px 11px; font-size: 12px; color: var(--text);
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; outline: none; font-family: inherit; }
.fb-urlrow input:focus { border-color: var(--accent); }
.fb-health { font-size: 11px; color: var(--text-dim); margin-top: 5px; }
.fb-params { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 18px; }
.fb-divider { height: 1px; background: var(--border); margin: 18px 0 20px; }
/* 插件生态（v2.6） */
.plugin-tab { padding-bottom: 8px; }
.p-beta { font-size: 9px; font-weight: 700; color: var(--accent-2); border: 1px solid var(--accent-2);
  border-radius: 4px; padding: 0 4px; vertical-align: middle; margin-left: 5px; }
.p-toolbar { display: flex; align-items: center; gap: 14px; margin-top: 12px; flex-wrap: wrap; }
.p-dev { display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--text-dim); cursor: pointer; }
.p-install { display: flex; gap: 8px; margin-top: 8px; }
.p-install input { flex: 1; height: 28px; padding: 0 9px; border: 1px solid var(--border); border-radius: 6px;
  background: rgba(255, 255, 255, .03); color: var(--text); font-size: 10.5px; min-width: 0; }
.p-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.p-item { border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; background: rgba(255, 255, 255, .02); }
.p-rowhead { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.p-name { display: flex; align-items: center; gap: 7px; min-width: 0; flex-wrap: wrap; }
.p-nm { font-size: 12px; font-weight: 700; }
.p-version { font-size: 9.5px; color: var(--text-dim); }
.p-tag { font-size: 8.5px; padding: 1px 5px; border-radius: 4px; border: 1px solid var(--border); color: var(--text-dim); }
.p-tag.builtin { color: var(--accent-2); border-color: var(--accent-2); }
.p-tag.signed { color: #08db94; border-color: #08db94; }
.p-tag.unsig { color: #e8a33d; border-color: #e8a33d; }
.p-ops { display: flex; gap: 5px; flex-shrink: 0; }
.p-op { height: 22px; padding: 0 9px; font-size: 10px; border: 1px solid var(--border); border-radius: 5px;
  background: transparent; color: var(--text); cursor: pointer; }
.p-op:hover { border-color: var(--accent-2); color: var(--accent-2); }
.p-op.danger:hover { border-color: #f23645; color: #f23645; }
.p-meta { display: flex; align-items: center; gap: 8px; margin-top: 7px; flex-wrap: wrap; }
.p-status { font-size: 9.5px; color: var(--text-dim); text-transform: uppercase; }
.p-status.bad { color: #f23645; }
.p-scopes { display: flex; gap: 4px; flex-wrap: wrap; }
.p-scope { font-size: 8.5px; color: var(--text-dim); background: rgba(255, 255, 255, .05);
  border-radius: 4px; padding: 1px 5px; font-variant-numeric: tabular-nums; }
.p-err { font-size: 10px; color: #f23645; margin-top: 6px; word-break: break-all; }
.p-empty { font-size: 10.5px; color: var(--text-dim); padding: 14px 0; text-align: center; }
.p-op:disabled { opacity: .5; cursor: default; }
.l2-key { margin-top: 8px; padding: 8px 10px; border: 1px dashed var(--border); border-radius: 7px; background: rgba(47,111,237,.05); }
.l2-key-head { display: flex; align-items: center; gap: 8px; }
.l2-key-title { font-size: 11px; font-weight: 700; color: var(--text); }
.l2-key-badge { font-size: 9px; padding: 1px 6px; border-radius: 10px; border: 1px solid var(--border); color: var(--text-dim); }
.l2-key-badge.set { color: #08db94; border-color: #08db94; }
.l2-key-row { display: flex; gap: 6px; margin-top: 7px; }
.l2-key-row input { flex: 1; min-width: 0; height: 24px; padding: 0 8px; border: 1px solid var(--border); border-radius: 5px;
  background: rgba(255, 255, 255, .04); color: var(--text); font-size: 10.5px; }
.l2-key-note { font-size: 9.5px; color: var(--text-dim); line-height: 1.6; margin-top: 6px; }

/* 券商交易（v2.6） */
.broker-tab { padding-bottom: 8px; }
.bk-statusbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.bk-chip {
  font-size: 11px; padding: 3px 10px; border-radius: 20px;
  border: 1px solid var(--border); color: var(--text-dim);
}
.bk-chip.on { color: #26d07c; border-color: #26d07c; }
.bk-chip.kill { color: #ff5a6a; border-color: #ff5a6a; font-weight: 700; }
.bk-actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.bk-probe-row { display: flex; gap: 6px; align-items: center; }
.bk-probe-row input { flex: 1; min-width: 0; }
.bk-probe-btn { background: var(--bg-input, #0e1117); border: 1px solid var(--border, #2a3344); border-radius: 6px; color: var(--accent, #4d9fff); padding: 5px 10px; font-size: 11px; cursor: pointer; white-space: nowrap; }
.bk-probe-btn:hover { border-color: var(--accent, #4d9fff); }
.bk-probe-btn:disabled { opacity: .5; cursor: default; }
.bk-probe-badge { font-size: 10.5px; padding: 1px 8px; border-radius: 10px; width: fit-content; }
.bk-probe-badge.ok { color: #35d07f; background: rgba(53, 208, 127, .12); }
.bk-probe-badge.warn { color: #f5b84c; background: rgba(245, 184, 76, .12); }
.bk-probe-badge.bad { color: #ff6b6b; background: rgba(255, 107, 107, .12); }
.bk-probe-hint { font-size: 10px; color: var(--text-dim, #97a0b2); }
.bk-probe-bar { display: flex; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
.bk-probe-summary { font-size: 11.5px; color: var(--text, #e6ecf5); }
.bk-probe-summary.bad { color: #ff6b6b; }
.bk-probe-tip { font-size: 11px; color: var(--text-dim, #97a0b2); }
.mock-cash-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.mock-cash-lb { font-size: 12px; color: var(--text-dim); white-space: nowrap; }
.mock-cash-in { width: 150px; height: 30px; padding: 0 8px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg-deep); color: var(--text); font-size: 13px; }
.mock-cash-in:focus { border-color: var(--accent); outline: none; }
.mock-cash-preset { height: 30px; padding: 0 10px; font-size: 12px; border-radius: 6px;
  background: transparent; color: var(--text-dim); border: 1px solid var(--border); cursor: pointer; }
.mock-cash-preset:hover { color: var(--text); border-color: var(--text-dim); }
.bk-radio { font-size: 11.5px; color: var(--text-dim); display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }

/* 重排后的券商交易 */
.bk-status-card {
  background: rgba(255,255,255,.03); border: 1px solid var(--border);
  border-radius: 10px; padding: 12px;
}
.bk-status-row { display: flex; align-items: center; justify-content: space-between; }
.bk-kill-warn {
  margin-top: 10px; padding: 8px 12px; border-radius: 8px;
  background: rgba(242,54,69,.12); border: 1px solid rgba(242,54,69,.4);
  color: #f23645; font-size: 12px; display: flex; align-items: center; justify-content: space-between;
}
.bk-mode-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 10px; }
.bk-mode-card {
  border: 1px solid var(--border); border-radius: 10px; padding: 12px;
  cursor: pointer; transition: all .15s; display: block;
}
.bk-mode-card:hover { border-color: var(--accent-2); }
.bk-mode-card.on { border-color: var(--accent-2); background: rgba(212,175,55,.08); }
.bk-mode-card input { display: none; }
.bk-mode-name { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.bk-mode-desc { font-size: 11px; color: var(--text-dim); line-height: 1.4; }
.logs-btn.big { padding: 8px 24px; font-size: 13px; }
.bk-live-card {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px; border-radius: 10px; border: 1px solid var(--border);
  background: rgba(255,255,255,.02); margin-top: 10px;
}
.bk-live-card.on { border-color: #f23645; background: rgba(242,54,69,.08); }
.bk-live-card.disabled { opacity: 0.6; }
.bk-live-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }

/* P4 实盘武装向导 */
.live-red { color: #ff5a6a; }
.live-amber { color: #ffb13d; }
.bk-arm {
  margin-top: 10px; padding: 14px; border-radius: 10px;
  border: 1px solid rgba(242,54,69,.45);
  background: linear-gradient(180deg, rgba(242,54,69,.10), rgba(242,54,69,.04));
}
.bk-arm.armed {
  border-color: #f23645;
  background: linear-gradient(180deg, rgba(242,54,69,.16), rgba(242,54,69,.06));
  box-shadow: 0 0 0 1px rgba(242,54,69,.25) inset;
}
.bk-arm-status { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.bk-arm-status .bk-live-title { color: #ff5a6a; }
.bk-arm-msg {
  margin-top: 8px; padding: 7px 10px; border-radius: 8px;
  background: rgba(242,54,69,.14); border: 1px solid rgba(242,54,69,.45);
  color: #ff8a96; font-size: 12px; font-weight: 600; line-height: 1.5;
}
.bk-arm-msg.ok {
  background: rgba(45,212,140,.12); border-color: rgba(45,212,140,.4);
  color: #37d67a;
}
.bk-arm-usage {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
  margin-top: 12px;
}
.bk-usage-item {
  display: flex; flex-direction: column; gap: 3px;
  padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(242,54,69,.25);
  background: rgba(0,0,0,.18);
}
.bk-usage-item span { font-size: 11px; color: var(--text-dim); }
.bk-usage-item b { font-size: 14px; font-variant-numeric: tabular-nums; }
.bk-arm-step {
  margin-top: 12px; padding-top: 12px;
  border-top: 1px dashed rgba(255,255,255,.08);
}
.bk-arm-step-h { font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 6px; }
.bk-wl-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.bk-wl-tag {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 8px; font-size: 12px; font-variant-numeric: tabular-nums;
  border-radius: 6px; border: 1px solid rgba(242,54,69,.4);
  background: rgba(242,54,69,.12); color: #ff8a96;
}
.bk-wl-tag i {
  font-style: normal; cursor: pointer; color: var(--text-dim);
  width: 14px; height: 14px; line-height: 13px; text-align: center;
  border-radius: 50%;
}
.bk-wl-tag i:hover { color: #fff; background: #f23645; }
.bk-drill { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.6; cursor: pointer; }
.bk-drill input { margin-top: 3px; accent-color: #f23645; }
.bk-arm-notice {
  font-size: 12px; line-height: 1.7; color: var(--text-dim);
  padding: 10px 12px; border-radius: 8px; margin-bottom: 8px;
  border: 1px solid rgba(242,54,69,.3); background: rgba(242,54,69,.08);
}
.bk-arm-ack { width: 100%; max-width: 260px; }
.bk-compliance { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
.bk-comp-item { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.55; cursor: pointer; color: var(--text, #e8ecf4); margin: 0; }
.bk-comp-item input { margin-top: 3px; flex-shrink: 0; accent-color: #f23645; }
.bk-comp-item span { flex: 1; min-width: 0; }
.bk-advanced summary {
  cursor: pointer; font-size: 13px; color: var(--accent-2);
  padding: 8px 0; user-select: none;
}
.bk-advanced summary:hover { color: var(--text); }

/* 规则脑指标说明 */
.rule-indicators {
  margin-top: 14px; padding: 12px; border-radius: 10px;
  background: rgba(255,255,255,.03); border: 1px solid var(--border);
}
.ri-title { font-size: 12px; font-weight: 600; margin-bottom: 10px; color: var(--accent-2); }
.ri-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ri-item {
  padding: 8px; border-radius: 6px; background: rgba(255,255,255,.02);
  font-size: 11px; line-height: 1.4;
}
.ri-item b { display: block; color: var(--text); margin-bottom: 2px; font-size: 11.5px; }
.ri-item span { color: var(--text-dim); }
.ri-item.off { opacity: 0.45; }
.ri-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
.switch.sm { width: 28px; height: 16px; }
.switch.sm .knob { width: 12px; height: 12px; }
.bk-radio input { accent-color: var(--accent); }
.bk-live-on { color: #ff5a6a; font-weight: 700; }
.hist-form { margin-top: 12px; display: flex; flex-direction: column; gap: 12px; }
.hist-field { display: flex; flex-direction: column; gap: 6px; }
.hist-field label { font-size: 12px; color: var(--text-dim); font-weight: 600; }
.hist-field input, .hist-field select {
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  color: var(--text); padding: 8px 10px; font-size: 13px; font-family: inherit;
}
.hist-field-row { display: grid; grid-template-columns: 1fr 160px; gap: 12px; align-items: end; }
.hist-prog { margin-top: 14px; }
.hist-prog-bar { height: 8px; border-radius: 5px; background: var(--bg); overflow: hidden; border: 1px solid var(--border); }
.hist-prog-fill { height: 100%; background: var(--accent); border-radius: 5px; transition: width .3s ease; }
.hist-prog-txt { margin-top: 6px; font-size: 12px; color: var(--text-dim); }
.hist-fails { margin-top: 10px; max-height: 150px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
.hist-fail-line { font-size: 11.5px; color: #ff8a96; font-family: ui-monospace, monospace; }

/* ===== 订阅 Pro 页（v3.0.8 视觉升级）===== */
.pro-hero { position: relative; margin-top: 4px; padding: 28px 22px 20px; border-radius: 14px; text-align: center;
  background: linear-gradient(160deg, rgba(13,26,40,.92), rgba(6,14,24,.96));
  border: 1px solid rgba(0,255,213,.25); overflow: hidden; }
.pro-hero-glow { position: absolute; top: -70px; left: 50%; transform: translateX(-50%);
  width: 340px; height: 170px; pointer-events: none;
  background: radial-gradient(closest-side, rgba(0,255,213,.30), transparent 72%); }
.pro-badge { position: absolute; top: 12px; right: 14px; padding: 2px 9px; border-radius: 6px;
  font-size: 10px; font-weight: 800; letter-spacing: 1.5px; color: #04121a;
  background: linear-gradient(135deg, #00ffd5, #3ae0ff); }
.pro-badge-corner { position: absolute; top: 14px; right: 14px; padding: 2px 9px; border-radius: 6px;
  font-size: 10px; font-weight: 800; letter-spacing: 1.5px; color: #04121a;
  background: linear-gradient(135deg, #00ffd5, #3ae0ff); }
.pro-hero-title { font-size: 23px; font-weight: 800; color: #fff; letter-spacing: .5px; }
.pro-hero-title span { color: #00ffd5; }
.pro-hero-sub { margin-top: 7px; font-size: 12.5px; color: #9fb3d1; }
.pro-price { margin-top: 15px; font-size: 27px; font-weight: 800; color: #00ffd5; }
.pro-price span { font-size: 12px; color: #6b7f9b; font-weight: 500; }

/* ===== v3.14 三档价格卡片 ===== */
.pro-plans { margin-top: 16px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.pro-plan-card { padding: 12px 10px; border-radius: 10px; text-align: center;
  background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); }
.pro-plan-card.hot { background: rgba(0,255,213,.08); border-color: rgba(0,255,213,.4); }
.pro-plan-name { font-size: 12px; color: #8aa0bd; margin-bottom: 6px; }
.pro-plan-card.hot .pro-plan-name { color: #00ffd5; }
.pro-plan-price { font-size: 20px; font-weight: 800; color: #e8f1ff; }
.pro-plan-price span { font-size: 11px; color: #6b7f9b; font-weight: 500; margin-left: 2px; }
.pro-plan-quota { font-size: 11px; color: #6b7f9b; margin-top: 6px; }
.pro-buy-btn { margin-top: 15px; display: inline-flex; align-items: center; gap: 6px;
  padding: 10px 28px; border: none; border-radius: 10px; cursor: pointer;
  font-size: 13.5px; font-weight: 700; color: #04121a;
  background: linear-gradient(135deg, #00ffd5, #3ae0ff);
  box-shadow: 0 6px 20px rgba(0,255,213,.35);
  transition: transform .15s ease, box-shadow .2s ease, filter .2s ease; }
.pro-buy-btn:hover { filter: brightness(1.08); box-shadow: 0 8px 28px rgba(0,255,213,.5); }
.pro-buy-btn:active { transform: scale(.97); }
.pro-hero-foot { margin-top: 13px; font-size: 11px; color: #6b7f9b; }

.pro-steps { display: flex; align-items: center; margin: 18px 2px 16px; }
.pro-step { flex: none; display: flex; flex-direction: column; align-items: center; gap: 7px; width: 92px; }
.pro-step-num { width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 800; color: #04121a;
  background: linear-gradient(135deg, #00ffd5, #3ae0ff);
  box-shadow: 0 3px 10px rgba(0,255,213,.3); }
.pro-step-txt { font-size: 12px; color: var(--text); text-align: center; line-height: 1.5; }
.pro-step-txt span { display: block; color: #6b7f9b; font-size: 11px; }
.pro-step-line { flex: 1; height: 1px; margin: 0 6px;
  background: linear-gradient(90deg, rgba(0,255,213,.5), rgba(58,224,255,.15)); }

.pro-activate { display: flex; gap: 10px; }
.pro-code-input { flex: 1; box-sizing: border-box; background: rgba(10,15,26,.9); border: 1px solid #1f2a3f; border-radius: 10px;
  color: var(--text); font-size: 13px; padding: 11px 13px; resize: vertical; line-height: 1.5;
  transition: border-color .2s ease, box-shadow .2s ease; }
.pro-code-input:focus { outline: none; border-color: rgba(0,255,213,.7); box-shadow: 0 0 0 3px rgba(0,255,213,.15); }
.pro-act-btn { flex: none; padding: 0 24px; border: none; border-radius: 10px; cursor: pointer;
  font-size: 13.5px; font-weight: 700; color: #04121a;
  background: linear-gradient(135deg, #00ffd5, #3ae0ff);
  box-shadow: 0 4px 14px rgba(0,255,213,.28);
  transition: transform .15s ease, filter .2s ease; }
.pro-act-btn:hover:not(:disabled) { filter: brightness(1.08); }
.pro-act-btn:active:not(:disabled) { transform: scale(.97); }
.pro-act-btn:disabled { opacity: .55; cursor: not-allowed; }
.pro-msg { margin-top: 10px; font-size: 12.5px; color: #ffd76a; }
.pro-note { margin-top: 14px; font-size: 11.5px; color: #6b7f9b; line-height: 1.7; }

.pro-active-card { position: relative; margin-top: 4px; padding: 24px 22px; border-radius: 14px;
  background: linear-gradient(160deg, rgba(13,26,40,.92), rgba(6,14,24,.96));
  border: 1px solid rgba(0,255,213,.3); overflow: hidden; }
.pro-active-glow { position: absolute; top: -55px; right: -45px; width: 240px; height: 150px; pointer-events: none;
  background: radial-gradient(closest-side, rgba(0,255,213,.22), transparent 72%); }
.pro-active-head { display: flex; align-items: center; gap: 9px; }
.pro-active-dot { width: 10px; height: 10px; border-radius: 50%; background: #00ffd5;
  box-shadow: 0 0 10px rgba(0,255,213,.85); }
.pro-active-title { font-size: 15px; font-weight: 800; color: #fff; }
.pro-active-row { display: flex; align-items: center; justify-content: space-between; margin-top: 13px;
  padding: 10px 13px; border-radius: 8px; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.05); }
.pro-active-row span { font-size: 12.5px; color: #9fb3d1; }
.pro-active-row b { font-size: 13px; color: var(--text); font-weight: 600; }
.pro-rollback { margin-top: 14px; padding: 10px 12px; border-radius: 8px; font-size: 12.5px;
  color: #ff5f57; background: rgba(255,95,87,.08); border: 1px solid rgba(255,95,87,.3); }

/* ===== Debug 清除激活码（仅 dev 构建）===== */
.pro-debug-zone { margin-top: 14px; padding-top: 12px; border-top: 1px dashed rgba(255,255,255,.12); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pro-debug-tip { font-size: 11px; color: rgba(255,255,255,.45); letter-spacing: .5px; }
.pro-debug-btn { padding: 7px 14px; border-radius: 8px; font-size: 12.5px; font-weight: 600;
  color: #ff8a80; background: rgba(255,95,87,.1); border: 1px solid rgba(255,95,87,.35); cursor: pointer;
  transition: background .15s, color .15s; }
.pro-debug-btn:hover:not(:disabled) { background: rgba(255,95,87,.22); color: #ffd0cc; }
.pro-debug-btn:disabled { opacity: .5; cursor: not-allowed; }

/* ===== v3.7 升级套餐 + AI 次数包 ===== */
.pro-section-title { margin: 20px 0 10px; font-size: 13px; font-weight: 700; color: #e8c878; letter-spacing: .5px; display: flex; align-items: baseline; gap: 8px; }
.pro-section-sub { font-size: 11px; font-weight: 400; color: #6b7f9b; }
.pro-upgrade-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.pro-plan-card { position: relative; padding: 16px 14px; border-radius: 12px; text-align: center;
  background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); transition: all .15s; }
.pro-plan-card:hover { border-color: rgba(232,200,120,.4); background: rgba(232,200,120,.05); }
.pro-plan-card.hot { border-color: rgba(232,200,120,.4); background: rgba(232,200,120,.06); }
.pro-plan-card.active { border-color: rgba(0,255,213,.5); background: rgba(0,255,213,.06); }
.pro-plan-name { font-size: 12px; color: #9fb3d1; margin-bottom: 6px; }
.pro-plan-price { font-size: 24px; font-weight: 800; color: #fff; }
.pro-plan-price span { font-size: 12px; font-weight: 400; color: #6b7f9b; margin-left: 2px; }
.pro-plan-quota { font-size: 11px; color: #6b7f9b; margin-top: 4px; margin-bottom: 10px; }
.pro-plan-btn { width: 100%; padding: 6px 0; border-radius: 7px; font-size: 12px; font-weight: 600;
  border: 1px solid rgba(232,200,120,.35); background: rgba(232,200,120,.1); color: #e8c878; cursor: pointer;
  transition: all .15s; }
.pro-plan-btn:hover { background: rgba(232,200,120,.2); }
.pro-plan-card.active .pro-plan-btn { opacity: .5; cursor: default; }

.pro-topup-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.pro-topup-card { position: relative; padding: 16px 14px; border-radius: 12px; text-align: center;
  background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); transition: all .15s; }
.pro-topup-card:hover { border-color: rgba(0,255,213,.4); background: rgba(0,255,213,.05); }
.pro-topup-card.hot { border-color: rgba(0,255,213,.4); background: rgba(0,255,213,.06); }
.pro-topup-name { font-size: 13px; color: #e6ecf5; font-weight: 600; margin-bottom: 6px; }
.pro-topup-price { font-size: 22px; font-weight: 800; color: #00ffd5; margin-bottom: 10px; }
.pro-topup-tag { position: absolute; top: 8px; right: 8px; font-size: 9px; font-weight: 700;
  color: #000; background: #00ffd5; padding: 2px 6px; border-radius: 4px; }
.pro-topup-btn { width: 100%; padding: 6px 0; border-radius: 7px; font-size: 12px; font-weight: 600;
  border: 1px solid rgba(0,255,213,.35); background: rgba(0,255,213,.1); color: #00ffd5; cursor: pointer;
  transition: all .15s; }
.pro-topup-btn:hover { background: rgba(0,255,213,.2); }

/* ===== v3.4 换机授权 ===== */
.pro-relocate { border: 1px dashed rgba(255,149,0,.45); border-radius: 12px; padding: 16px;
  background: linear-gradient(160deg, rgba(40,22,4,.35), rgba(10,18,30,.8)); margin-top: 2px; }
.pro-reloc-title { font-size: 15px; font-weight: 800; color: #ffa94d; margin-bottom: 10px; }
.pro-relocate .pro-code-input { margin-top: 12px; }
.pro-relocate .pro-act-btn { margin-top: 10px; }
.reloc-req { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.reloc-req code { flex: 1; min-width: 220px; font-size: 11.5px; color: #ffd9a8; word-break: break-all;
  background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.08); border-radius: 8px; padding: 8px 10px; }


/* ===== v3.0.9 AI 配置锁定态 ===== */
.ai-locked { display: flex; flex-direction: column; align-items: center; text-align: center;
  padding: 42px 26px; border-radius: 14px; border: 1px dashed rgba(0,255,213,.35);
  background: linear-gradient(160deg, rgba(13,26,40,.6), rgba(6,14,24,.85)); }
.ai-lock-icon { color: rgba(0,255,213,.85); margin-bottom: 14px; }
.ai-lock-title { font-size: 16px; font-weight: 800; color: #fff; }
.ai-lock-sub { margin: 10px 0 18px; font-size: 12.5px; color: #9fb3d1; line-height: 1.8; max-width: 430px; }


.bk-ocr-block { padding: 8px 10px; border: 1px solid var(--border, #2a3040); border-radius: 8px; margin-top: 8px; }
.bk-ocr-builtin { font-size: 12px; color: #7ed49a; margin-top: 4px; }
.bk-ocr-builtin.off { color: var(--warn, #e8a33d); }
.bk-ocr-actions { display: flex; gap: 8px; margin-top: 8px; }
.bk-probe-badge:not(.ok):not(.warn):not(.bad) { color: var(--text-dim, #8a94a6); border-color: var(--border, #2a3040); }
.bk-ocr-actions .danger { color: var(--danger, #e5484d); }
.bk-switch-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.bk-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; }
.bk-sw-title { font-size: 12px; font-weight: 600; }
.bk-sidecar-err {
  margin-top: 8px; padding: 6px 10px; border-radius: 7px; font-size: 11px; line-height: 1.6;
  color: #ff7a85; background: rgba(242, 54, 69, 0.1); border: 1px solid rgba(242, 54, 69, 0.45);
  display: flex; align-items: center; gap: 8px; word-break: break-all;
}
.bk-auto-summary {
  display: flex; align-items: center; gap: 7px; margin-top: 8px;
  padding: 6px 10px; border-radius: 7px; font-size: 11px;
  background: rgba(38, 208, 124, 0.06); border: 1px solid rgba(38, 208, 124, 0.3); color: var(--text-dim, #97a0b2);
}
.bk-auto-dot { width: 7px; height: 7px; border-radius: 50%; background: #26d07c; flex-shrink: 0; }
.bk-auto-tip { color: var(--text-dim, #97a0b2); }
.bk-selfcheck { margin-top: 12px; border: 1px solid rgba(90,160,255,0.25); border-radius: 8px; padding: 10px 12px; background: rgba(90,160,255,0.05); }
.bk-sc-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.bk-sc-title { font-weight: 600; }
.bk-sc-mode { font-size: 11px; opacity: .7; }
.bk-sc-item { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; font-size: 12px; }
.bk-sc-ico { color: #37d67a; font-weight: 700; }
.bk-sc-item.bad .bk-sc-ico { color: #ff5a5a; }
.bk-sc-name { font-weight: 600; }
.bk-sc-msg { opacity: .7; }
.switch.disabled { opacity: .45; cursor: not-allowed; }
</style>
