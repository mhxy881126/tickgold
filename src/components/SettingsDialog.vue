<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit as tauriEmit } from "@tauri-apps/api/event";
import { openInAppBrowser } from "../utils/openInApp";
import { useTheme, type ThemeId } from "../composables/useTheme";
import { useAccessibility } from "../composables/useAccessibility";
import { useMotion } from "../composables/useMotion";
import { useSkins } from "../composables/useSkins";
import { useNovice } from "../composables/useNovice";
import { useWindowControls } from "../composables/useWindowControls";
import { tsStatus } from "../composables/useTimeSeries";
import { collectorStatus } from "../composables/useCollector";
import { logger, type LogLevel } from "../utils/logger";
import { isEnabled as autoStartEnabled, enable as enableAutoStart, disable as disableAutoStart } from "@tauri-apps/plugin-autostart";
import {
  brokerGetStatus,
  brokerGetConfig,
  brokerSetConfig,
  brokerEnableLive,
  brokerConnect,
  brokerDisconnect,
  brokerEmergencyHalt,
  brokerReleaseKill,
  mockSeedPosition,
  mockReset,
  type BrokerStatus,
  type BrokerConfigFull,
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
import { useLicenseStore } from "../stores/license";

const props = defineProps<{ open: boolean; initialTab?: Tab }>();
const emit = defineEmits<{ "update:open": [boolean]; "replay-onboarding": []; "check-update": [] }>();
function close() {
  emit("update:open", false);
}

const { theme, setTheme, THEMES } = useTheme();
const { zoom, highContrast, setZoom, setHighContrast, ZOOM_LEVELS } = useAccessibility();
const { tier: motionTier, setTier: setMotionTier, MOTION_TIERS } = useMotion();
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

// 面包多购买链接（TickGold Pro 年卡商品）
const PRO_PURCHASE_URL = "https://mbd.pub/o/bread/YZaVmplyZg==";
function goBuy() {
  void openInAppBrowser(PRO_PURCHASE_URL);
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
async function onDeactivate() {
  actBusy.value = true;
  try {
    await license.deactivate();
  } finally {
    actBusy.value = false;
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
onUnmounted(stopHistPoll);

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
async function refreshBStatus() {
  try {
    bStatus.value = await brokerGetStatus();
  } catch {
    /* ignore */
  }
}
async function loadBrokerTab() {
  try {
    bForm.value = await brokerGetConfig();
    await refreshBStatus();
    brokerLoaded.value = true;
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
    });
    bFlash("配置已保存");
  } catch (e) {
    bFlash(`保存失败：${e}`);
  }
}
async function bConnect() {
  try {
    bFlash(await brokerConnect());
    await refreshBStatus();
  } catch (e) {
    bFlash(String(e));
  }
}
async function bDisconnect() {
  try {
    await brokerDisconnect();
    await refreshBStatus();
    bFlash("已断开");
  } catch (e) {
    bFlash(String(e));
  }
}
async function toggleLive(v: boolean) {
  if (v && !license.isPro) {
    bFlash("QMT 实盘接入为 Pro 订阅功能，请先订阅后开启");
    if (bForm.value) bForm.value.liveEnabled = false;
    return;
  }
  if (v) {
    // P1-1 实盘风险告知书 + 程序化交易报告义务（二次确认）
    const ok = await confirmDialog({
      title: "实盘风险告知书",
      message:
        "开启实盘前请逐条确认：\n\n① 实盘委托将产生真实资金变动，风险自担；\n② 本软件的自动/半自动交易属于程序化交易，按《证券市场程序化交易管理规定（试行）》，你须自行向交易所履行程序化交易报告义务；\n③ 建议先在模拟盘充分验证策略后再启用实盘；\n④ 单笔金额上限已设置（>0 元）方可开启。\n\n确认已阅读并接受上述条款？",
      confirmText: "已阅读并确认",
      danger: true,
    });
    if (!ok) {
      if (bForm.value) bForm.value.liveEnabled = false;
      return;
    }
  }
  try {
    await brokerEnableLive(v, v); // ack=true 仅在开启时生效；关闭无需确认
    await refreshBStatus();
    bFlash(v ? "实盘已开启（QMT），请谨慎操作" : "实盘已关闭");
  } catch (e) {
    bFlash(String(e));
  }
}
// v3.0.0-rc 一键急停：封新委托 + 停自动执行 + 撤全部条件单 / 在途委托 + 断通道
async function bEmergencyHalt() {
  const ok = await confirmDialog({
    title: "一键急停",
    danger: true,
    confirmText: "立即急停",
    message:
      "将立即执行：① 封死全部新委托 ② 停止自动执行 ③ 撤销全部条件单 ④ 撤销全部在途委托并断开券商通道。\n\n该操作不可撤销，恢复需手动解除、重连并重启自动执行。确认继续？",
  });
  if (!ok) return;
  try {
    const r = await brokerEmergencyHalt();
    bFlash(`已急停：撤销条件单 ${r.coCount} 个、在途委托 ${r.orderCount} 笔`);
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
// 实盘单笔金额上限：默认 0 = 锁定；设置 >0 放开实盘委托，须 danger 二次确认
async function bSaveLiveLimit() {
  if (!bForm.value) return;
  const amount = Number(bForm.value.liveMaxOrderAmount);
  if (!(amount >= 0) || Number.isNaN(amount)) {
    bFlash("单笔金额上限须为不小于 0 的数字");
    return;
  }
  if (amount > 0) {
    const ok = await confirmDialog({
      title: "放开实盘限额",
      danger: true,
      confirmText: "设置并放开",
      message:
        `单笔金额上限设为 ${amount.toLocaleString("zh-CN")} 元后，已确认信号将可能提交真实委托，单笔成交金额不得超过该上限。\n\n设为 0 则实盘重新锁定。确认设置？`,
    });
    if (!ok) return;
  }
  try {
    await brokerSetConfig({ liveMaxOrderAmount: amount });
    bFlash(amount > 0 ? `实盘单笔上限已设为 ${amount.toLocaleString("zh-CN")} 元` : "实盘已锁定（上限 0）");
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
              <span v-if="license.isPro" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#00ffd5;margin-left:6px" title="Pro 已生效"></span>
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
                <div class="pro-status-row" style="display:flex;align-items:center;gap:8px;padding:12px 14px;border:1px solid rgba(0,255,213,.4);border-radius:10px;background:rgba(0,255,213,.06)">
                  <span style="width:9px;height:9px;border-radius:50%;background:#00ffd5"></span>
                  <span style="font-weight:600">Pro 订阅生效中</span>
                </div>
                <div style="margin-top:12px;font-size:13px;color:#e6edf7">
                  订阅计划：{{ license.plan || "pro-annual" }} · 到期：{{ license.expiresAt }} · 剩余 {{ license.daysLeft }} 天
                </div>
                <div v-if="license.status?.rollback_detected" style="margin-top:10px;font-size:12.5px;color:#ff5f57">检测到系统时间回拨，Pro 已暂停，请校正系统时间后重新打开软件。</div>
                <button class="primary-btn" style="margin-top:16px" :disabled="actBusy" @click="onDeactivate">{{ actBusy ? "处理中…" : "退出 Pro（恢复免费版）" }}</button>
              </template>
              <template v-else>
                <div class="section-sub" style="margin:4px 0 10px">尚未激活 Pro，当前为免费版。</div>
                <div style="margin:0 0 12px;padding:12px 14px;border:1px solid #1f2a3f;border-radius:10px;background:rgba(15,23,42,.5)">
                  <div style="font-size:13px;font-weight:600;margin-bottom:8px">如何获取激活码</div>
                  <div style="font-size:12px;line-height:1.9;color:#9fb3d1">
                    ① 点击下方按钮跳转面包多平台完成支付（支持微信/支付宝，年卡 ¥99）；<br>
                    ② 支付成功后卡密自动发货，复制收到的 TG 激活码；<br>
                    ③ 粘贴到下方输入框，点击「激活 Pro」，立即生效。
                  </div>
                  <button class="primary-btn" style="margin-top:10px" @click="goBuy">去面包多购买</button>
                </div>
                <textarea v-model="codeInput" rows="3" style="width:100%;box-sizing:border-box;background:#0a0f1a;border:1px solid #1f2a3f;border-radius:8px;color:#e6edf7;font-size:13px;padding:10px 12px;resize:vertical" placeholder="粘贴激活码（TG.xxx.xxx.xxx）"></textarea>
                <button class="primary-btn" style="margin-top:12px" :disabled="actBusy" @click="onActivate">{{ actBusy ? "激活中…" : "激活 Pro" }}</button>
                <div v-if="actMsg" style="margin-top:10px;font-size:12.5px;color:#ffd76a">{{ actMsg }}</div>
                <div class="section-sub" style="margin-top:14px;font-size:12px;line-height:1.8">激活后立即生效，到期自动降级免费版。卡密仅供本人使用，请勿转售。</div>
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
              <div class="startup-row" style="margin-top:10px">
                <div class="startup-info">
                  <div class="startup-name">动效强度</div>
                  <div class="section-sub" style="margin:3px 0 0">数值补间 / 涨跌辉光 / 悬停抬升，省电档瞬时到位</div>
                </div>
                <div class="seg">
                  <button v-for="m in MOTION_TIERS" :key="m.id" type="button" class="seg-btn" :class="{ on: motionTier === m.id }" :title="m.desc" @click="setMotionTier(m.id)">{{ m.name }}</button>
                </div>
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
              <div class="section-sub">备份主库、知识库与本地配置（自选 / 布局 / 设置）；恢复时自动重启</div>
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
                </div>
                <button type="button" class="logs-btn" :disabled="backupBusy" @click="onRestoreBackup(b)">恢复</button>
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
              <!-- 第一步：选 AI 模型 -->
              <div class="section-title">AI 模型</div>
              <div class="section-sub">选本地或云端模型，用于智能问答和选股分析</div>
              <div class="seg ai-provider">
                <button type="button" class="seg-btn" :class="{ on: aiCfg.useBuiltin }" @click="aiCfg.useBuiltin = true">内置模型（推荐）</button>
                <button type="button" class="seg-btn" :class="{ on: !aiCfg.useBuiltin && aiCfg.provider === 'ollama' }" @click="pickAi('ollama')">本地 Ollama</button>
                <button type="button" class="seg-btn" :class="{ on: !aiCfg.useBuiltin && aiCfg.provider === 'cloud' }" @click="pickAi('cloud')">云端 API</button>
              </div>

              <div v-if="aiCfg.useBuiltin" class="builtin-tip">
                <div class="builtin-title">内置智谱 GLM-4.5 · 开箱即用</div>
                <div class="section-sub" style="margin-top:4px">订阅 Pro 激活后 AI 功能直接可用，无需配置模型或密钥。每日 AI 调用设有合理配额（100 次/天），防止账号滥用，次日自动重置。</div>
              </div>

              <template v-else>
                <div class="ai-field">
                  <label>接口地址 Base URL</label>
                  <input v-model="aiCfg.baseUrl" type="text" spellcheck="false" :placeholder="aiCfg.provider === 'ollama' ? 'http://localhost:11434' : 'https://api.deepseek.com/v1'" />
                </div>

                <div class="ai-field-row">
                  <div class="ai-field">
                    <label>对话模型
                      <button v-if="aiCfg.provider === 'cloud'" type="button" class="mini-link" :disabled="fetchingModels" @click.prevent="onFetchModels">
                        ↻ 拉取模型列表
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
                <span v-if="aiMsg" class="ai-msg" :class="{ ok: /成功|已保存/.test(aiMsg) }">{{ aiMsg }}</span>
              </div>

            </div>

            <!-- 自动交易（独立 tab）-->
            <div v-else-if="tab === 'autotrade'" class="ai-tab">
              <div v-if="fbCfg">
                <div class="section-title">盘中决策引擎</div>
                <div class="section-sub">自动扫描自选股信号，规则脑默认可用；Laya 是更强的本地模型（可选）</div>
                <div class="seg ai-provider">
                  <button type="button" class="seg-btn" :class="{ on: fbCfg.brainMode === 'rule' }" @click="fbCfg.brainMode = 'rule'">技术指标规则脑</button>
                  <button type="button" class="seg-btn" :class="{ on: fbCfg.brainMode === 'cloud_llm' }" @click="fbCfg.brainMode = 'cloud_llm'">云端大模型</button>
                </div>

                <div v-if="fbCfg.brainMode === 'cloud_llm'" class="section-sub" style="margin-top:8px; color: var(--accent-2)">
                  💡 使用上方配置的云端大模型（DeepSeek/GPT等）归纳行情特征（仅做特征归纳，不构成投资建议），API Key 在 AI模型 里设置
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
                    <template v-else>
                      {{ bStatus?.connected ? "● QMT 已连接" : "○ QMT 未连接" }}
                    </template>
                  </span>
                  <button type="button" class="logs-btn" @click="refreshBStatus">刷新</button>
                </div>
                <div v-if="bStatus?.killSwitch" class="bk-kill-warn">
                  ⚠ Kill Switch 已触发 —— 所有交易通道已断开
                  <button type="button" class="logs-btn danger" @click="bReleaseKill">解除</button>
                </div>
              </div>

              <!-- 第一步：选模式 -->
              <div class="section-title" style="margin-top:20px">选择交易模式</div>
              <div v-if="bForm" class="bk-mode-grid">
                <label class="bk-mode-card" :class="{ on: bForm.kind === 'mock' }">
                  <input v-model="bForm.kind" type="radio" value="mock" />
                  <div class="bk-mode-name">模拟交易</div>
                  <div class="bk-mode-desc">无需券商环境，本地虚拟资金，适合练手联调</div>
                </label>
                <label class="bk-mode-card" :class="{ on: bForm.kind === 'qmt' }">
                  <input v-model="bForm.kind" type="radio" value="qmt" />
                  <div class="bk-mode-name">QMT 实盘</div>
                  <div class="bk-mode-desc">连接本机 miniQMT + xtquant，可提交真实委托</div>
                </label>
              </div>

              <!-- QMT 配置（选了 QMT 才显示） -->
              <template v-if="bForm && bForm.kind === 'qmt'">
                <div class="section-title" style="margin-top:16px">QMT 连接参数</div>
                <div class="bridge-grid">
                  <label class="ai-field"><span>Python 路径</span>
                    <input v-model="bForm.pythonPath" type="text" spellcheck="false" placeholder="python.exe（已装 xtquant）" /></label>
                  <label class="ai-field"><span>userdata_mini 路径</span>
                    <input v-model="bForm.qmtPath" type="text" spellcheck="false" placeholder="miniQMT userdata_mini" /></label>
                </div>
                <div class="bridge-grid">
                  <label class="ai-field"><span>资金账号</span>
                    <input v-model="bForm.accountId" type="text" spellcheck="false" placeholder="资金账号" /></label>
                </div>
              </template>

              <!-- 第二步：连接（仅 QMT 模式需要） -->
              <template v-if="bForm && bForm.kind === 'qmt'">
                <div class="section-title" style="margin-top:20px">连接</div>
                <div class="bk-actions">
                  <button type="button" class="logs-btn primary big" @click="bConnect">连接通道</button>
                  <button type="button" class="logs-btn" @click="bDisconnect">断开</button>
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

              <!-- 第三步：实盘开关（醒目警示） -->
              <div class="section-title" style="margin-top:20px">实盘委托</div>
              <div v-if="bForm && bForm.kind === 'mock'" class="bk-live-card disabled">
                <div>
                  <div class="bk-live-title">⚪ 当前为模拟模式</div>
                  <div class="section-sub">模拟交易不涉及真实委托。如需实盘，请先在上方选择「QMT 实盘」</div>
                </div>
              </div>
              <div v-else-if="bForm" class="bk-live-card" :class="{ on: bForm.liveEnabled }">
                <div>
                  <div class="bk-live-title">{{ bForm.liveEnabled ? '🔴 实盘已开启' : '⚪ 实盘关闭' }}</div>
                  <div class="section-sub">{{ bForm.liveEnabled ? '信号确认后会提交真实委托，资金有风险' : '开启后已确认信号可能提交真实委托' }}</div>
                </div>
                <button type="button" class="switch" :class="{ on: bForm.liveEnabled }" @click="toggleLive(!bForm.liveEnabled)">
                  <span class="knob"></span>
                </button>
              </div>

              <!-- 实盘单笔金额上限（仅 QMT，默认 0 = 锁定） -->
              <template v-if="bForm && bForm.kind === 'qmt'">
                <div class="section-title" style="margin-top:16px">实盘单笔金额上限</div>
                <div class="section-sub">
                  硬兜底：单笔委托金额（价格 × 数量）超过上限一律拒绝；<b>0 = 实盘锁定</b>，须显式设置正数后已确认信号才能提交真实委托。
                </div>
                <div class="mock-cash-row">
                  <label class="mock-cash-lb">上限（元）</label>
                  <input v-model.number="bForm.liveMaxOrderAmount" type="number" min="0" step="1000" class="mock-cash-in" />
                  <button type="button" class="mock-cash-preset" @click="bForm.liveMaxOrderAmount = 10000">1万</button>
                  <button type="button" class="mock-cash-preset" @click="bForm.liveMaxOrderAmount = 50000">5万</button>
                  <button type="button" class="mock-cash-preset" @click="bForm.liveMaxOrderAmount = 100000">10万</button>
                  <button type="button" class="logs-btn danger" @click="bSaveLiveLimit">保存限额</button>
                </div>
              </template>

              <!-- 账户级风控阈值（全通道唯一事实源；模拟 / 条件单 / 自动机器人 / 实盘共用） -->
              <template v-if="bForm">
                <div class="section-title" style="margin-top:20px">账户级风控阈值（全通道统一）</div>
                <div class="section-sub">
                  手动模拟、条件单、自动机器人、QMT 实盘共用同一套阈值；触发后仅停止开新仓，卖出永不锁死。
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
            <div v-else class="about">
              <div class="ab-logo">TG</div>
              <div class="ab-name">TickGold</div>
              <div class="ab-desc">开源跨平台 A 股盯盘终端</div>
              <div class="ab-tech">Tauri 2.0 · Rust · Vue 3 · TypeScript · ECharts</div>
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
.bk-mode-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
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
</style>
