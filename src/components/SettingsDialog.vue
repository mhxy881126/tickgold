<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTheme, type ThemeId } from "../composables/useTheme";
import { useAccessibility } from "../composables/useAccessibility";
import { useMotion } from "../composables/useMotion";
import { useSkins } from "../composables/useSkins";
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
  brokerKillSwitch,
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

defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [boolean]; "replay-onboarding": [] }>();
function close() {
  emit("update:open", false);
}

const { theme, setTheme, THEMES } = useTheme();
const { zoom, highContrast, setZoom, setHighContrast, ZOOM_LEVELS } = useAccessibility();
const { tier: motionTier, setTier: setMotionTier, MOTION_TIERS } = useMotion();
const skinsApi = useSkins();

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

type Tab = "appearance" | "data" | "ai" | "broker" | "plugins" | "logs" | "about";
const tab = ref<Tab>("appearance");
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
const aiCfg = ref<AiConfig>({
  provider: "ollama",
  baseUrl: "http://localhost:11434",
  chatModel: "",
  embedModel: "",
  temperature: 0.4,
  enableAutoIndex: true,
});
const aiLoaded = ref(false);
const aiMsg = ref("");
const cloudKeySet = ref(false);
const cloudKeyInput = ref("");
const testingAi = ref(false);
const connResult = ref<ConnTest | null>(null);

// 快脑 / Laya 控制台
const fbCfg = ref<AutoExecConfigInfo | null>(null);
const fbMsg = ref("");
const fbHealth = ref("");
async function loadFastBrain() {
  fbCfg.value = await autoexecGetConfig();
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
    aiCfg.value = await getAiConfig();
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
    aiMsg.value = `连接成功 · 延迟 ${connResult.value.latencyMs}ms · 可用模型 ${connResult.value.models.length} 个`;
  } catch (e) {
    aiMsg.value = `连接失败：${e}`;
  } finally {
    testingAi.value = false;
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
    kbData.value = await fetchKbStats();
    kbDocs.value = await listDocs();
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
  if (id === "ai" && !aiLoaded.value) void loadAiTab();
  if (id === "broker" && !brokerLoaded.value) void loadBrokerTab();
  if (id === "plugins") void loadPluginsTab();
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
  if (v) {
    const ok = window.confirm(
      "开启实盘后，已确认信号可能被提交为真实委托并产生真实资金变动。确认开启实盘？",
    );
    if (!ok) {
      if (bForm.value) bForm.value.liveEnabled = false;
      return;
    }
  }
  try {
    await brokerEnableLive(v);
    await refreshBStatus();
    bFlash(v ? "实盘已开启，请谨慎操作" : "实盘已关闭");
  } catch (e) {
    bFlash(String(e));
  }
}
async function bKill(cancelAll: boolean) {
  try {
    bFlash(await brokerKillSwitch(cancelAll));
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
  const { code, vol, price } = seedForm;
  if (!code.trim()) return bFlash("请填写代码");
  try {
    await mockSeedPosition(code.trim(), vol, price);
    bFlash(`已注入模拟持仓 ${code} ${vol} 股`);
  } catch (e) {
    bFlash(String(e));
  }
}
async function bMockReset() {
  try {
    await mockReset();
    bFlash("模拟账户已重置");
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
              <div v-if="tsStatus.lastError" class="dc-err">采集异常：{{ tsStatus.lastError }}</div>
            </div>

            <!-- AI 模型配置 -->
            <div v-else-if="tab === 'ai'" class="ai-tab">
              <!-- 快脑盘中决策引擎 -->
              <template v-if="fbCfg">
                <div class="section-title">快脑盘中决策引擎</div>
                <div class="section-sub">规则脑零依赖、默认可用、可解释；Laya 为本地决策模型 sidecar，不可达时自动降级规则脑</div>
                <div class="seg ai-provider">
                  <button type="button" class="seg-btn" :class="{ on: fbCfg.brainMode === 'rule' }" @click="fbCfg.brainMode = 'rule'">规则脑</button>
                  <button type="button" class="seg-btn" :class="{ on: fbCfg.brainMode === 'laya' }" @click="fbCfg.brainMode = 'laya'">Laya 模型</button>
                </div>

                <div class="ai-field" style="margin-top:12px">
                  <label>Laya 服务地址</label>
                  <div class="fb-urlrow">
                    <input v-model="fbCfg.layaUrl" type="text" spellcheck="false" placeholder="http://127.0.0.1:8788" />
                    <button type="button" class="logs-btn" @click="checkLaya">健康检查</button>
                  </div>
                  <span v-if="fbHealth" class="fb-health">{{ fbHealth }}</span>
                </div>

                <div class="fb-params">
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
                </div>
                <div class="ai-field">
                  <label>禁止开仓时间（之后只卖不买）</label>
                  <input v-model="fbCfg.noOpenAfter" type="text" spellcheck="false" placeholder="14:55" />
                </div>
                <div class="bridge-box">
                  <div class="bridge-title">
                    <span>信号人工确认桥（不自动下单）</span>
                    <button type="button" class="switch" :class="{ on: fbCfg.bridgeEnabled }" @click="fbCfg.bridgeEnabled = !fbCfg.bridgeEnabled"><span class="knob"></span></button>
                  </div>
                  <div class="section-sub">双脑 BUY/SELL 信号落待确认单，人工改价改量后生成券商指令，可唤起券商软件；真实成交由你完成</div>
                  <div class="bridge-grid">
                    <label class="ai-field"><span>默认券商</span>
                      <input v-model="fbCfg.bridgeDefaultBroker" type="text" spellcheck="false" placeholder="同花顺" /></label>
                    <label class="ai-field grow2"><span>券商软件路径（.exe / .app）</span>
                      <input v-model="fbCfg.bridgeBrokerPath" type="text" spellcheck="false" placeholder="留空则不唤起" /></label>
                  </div>
                  <div class="bridge-grid">
                    <label class="ai-field"><span>有效期(分钟)：{{ fbCfg.bridgeTtlMinutes }}</span>
                      <input v-model.number="fbCfg.bridgeTtlMinutes" type="range" min="5" max="240" step="5" /></label>
                    <label class="ai-field"><span>价偏提示%：{{ fbCfg.bridgePriceDeviatePct }}</span>
                      <input v-model.number="fbCfg.bridgePriceDeviatePct" type="range" min="0.2" max="5" step="0.1" /></label>
                    <label class="ai-field"><span>默认动作</span>
                      <select v-model="fbCfg.bridgeDefaultAction">
                        <option value="copy">复制指令</option>
                        <option value="export">仅生成</option>
                        <option value="hotkey">唤起券商</option>
                      </select></label>
                  </div>
                  <div class="bridge-grid">
                    <label class="ai-field grow2"><span>下单指令模板（留空 = 内置默认）</span>
                      <textarea v-model="fbCfg.bridgeOrderTemplate" class="bridge-tpl" rows="2" spellcheck="false"
                        placeholder="{side} {code} {name} 价格 {price} 数量 {vol} · {broker}"></textarea>
                      <span class="tpl-hint">占位符：{side} {sideEn} {code} {name} {price} {vol} {amount} {broker} {date}；未识别的占位符会原样保留</span>
                    </label>
                    <button type="button" class="logs-btn" @click="fbCfg.bridgeOrderTemplate = ''">恢复默认</button>
                  </div>
                </div>
                <div class="ai-actions">
                  <button type="button" class="logs-btn primary" @click="saveFastBrain">保存快脑参数</button>
                  <span v-if="fbMsg" class="ai-msg" :class="{ ok: fbMsg.includes('已保存') }">{{ fbMsg }}</span>
                </div>
                <div class="fb-divider"></div>
              </template>

              <div class="section-title">模型提供方</div>
              <div class="section-sub">本地 Ollama 数据不出本机；云端为 OpenAI 兼容接口，需 API Key</div>
              <div class="seg ai-provider">
                <button type="button" class="seg-btn" :class="{ on: aiCfg.provider === 'ollama' }" @click="aiCfg.provider = 'ollama'">本地 Ollama</button>
                <button type="button" class="seg-btn" :class="{ on: aiCfg.provider === 'cloud' }" @click="aiCfg.provider = 'cloud'">云端兼容</button>
              </div>

              <div class="ai-field">
                <label>接口地址 Base URL</label>
                <input v-model="aiCfg.baseUrl" type="text" spellcheck="false" :placeholder="aiCfg.provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1'" />
              </div>

              <div class="ai-field-row">
                <div class="ai-field">
                  <label>对话模型</label>
                  <input v-model="aiCfg.chatModel" type="text" spellcheck="false" placeholder="qwen2.5:7b / gpt-4o-mini" />
                </div>
                <div class="ai-field">
                  <label>嵌入模型</label>
                  <input v-model="aiCfg.embedModel" type="text" spellcheck="false" placeholder="bge-m3 / text-embedding-3-small" />
                </div>
              </div>

              <div class="ai-field">
                <label>温度 Temperature：{{ aiCfg.temperature.toFixed(1) }}</label>
                <input v-model.number="aiCfg.temperature" type="range" min="0" max="1" step="0.1" />
              </div>

              <template v-if="aiCfg.provider === 'cloud'">
                <div class="section-title" style="margin-top:18px">云端 API Key</div>
                <div class="ai-keyrow">
                  <span v-if="cloudKeySet" class="key-ok">已设置（保存在本机，仅用于请求）</span>
                  <input v-else v-model="cloudKeyInput" type="password" placeholder="粘贴 API Key（sk-…）" />
                  <button v-if="cloudKeySet" type="button" class="logs-btn" @click="clearCloudKeyEv">清除</button>
                  <button v-else type="button" class="logs-btn" :disabled="!cloudKeyInput.trim()" @click="saveCloudKeyEv">保存密钥</button>
                </div>
              </template>

              <div class="startup-row" style="margin-top:16px">
                <div class="startup-info">
                  <div class="startup-name">每日自动入库</div>
                  <div class="section-sub" style="margin:3px 0 0">收盘后自动把当日资料切块入知识库</div>
                </div>
                <button type="button" class="switch" :class="{ on: aiCfg.enableAutoIndex }" @click="aiCfg.enableAutoIndex = !aiCfg.enableAutoIndex"><span class="knob"></span></button>
              </div>

              <div class="ai-actions">
                <button type="button" class="logs-btn" :disabled="testingAi" @click="onTestAi">{{ testingAi ? "测试中…" : "测试连接" }}</button>
                <button type="button" class="logs-btn primary" @click="saveAiTab">保存配置</button>
                <span v-if="aiMsg" class="ai-msg" :class="{ ok: /成功|已保存/.test(aiMsg) }">{{ aiMsg }}</span>
              </div>
              <div class="section-title" style="margin-top:24px">知识库</div>
              <div class="section-sub">本地切块与向量索引，是「知识库语义检索」的数据来源</div>
              <div class="dc-stats kb-stats">
                <div class="dc-stat"><b>{{ kbData.total }}</b><span>总分块</span></div>
                <div class="dc-stat"><b>{{ kbData.embedded }}</b><span>已嵌入</span></div>
                <div class="dc-stat"><b>{{ kbSizeText }}</b><span>估算体积</span></div>
                <div class="dc-stat"><b>{{ kbDocs.length }}</b><span>文档数</span></div>
              </div>
              <div v-if="kbData.byType.length" class="kb-kinds">
                <span v-for="t in kbData.byType" :key="t[0]" class="kb-kind">{{ kbTypeName(t[0]) }} · {{ t[1] }}</span>
              </div>
              <div v-if="kbIndexing" class="kb-prog-wrap">
                <div class="kb-prog-label">
                  {{ kbProgress.phase === 'embed' ? '向量嵌入中' : '资料收集中' }} · {{ kbProgress.done }}/{{ kbProgress.total }}
                  <span v-if="kbProgress.error" class="kb-prog-err">{{ kbProgress.error }}</span>
                </div>
                <div class="kb-prog"><div class="kb-prog-bar" :style="{ width: kbProgPct + '%' }"></div></div>
              </div>
              <div class="ai-actions kb-actions">
                <button type="button" class="logs-btn" :disabled="kbBusy" @click="onImportDocs">导入文档</button>
                <button type="button" class="logs-btn" :disabled="kbBusy" @click="onReindex">重建嵌入</button>
                <button type="button" class="logs-btn" :disabled="kbBusy" @click="onIndexToday">入库今日</button>
              </div>
              <div class="kb-docs">
                <div v-if="!kbDocs.length" class="logs-empty">暂无文档，点击「导入文档」或「入库今日」</div>
                <div v-for="d in kbDocs" :key="d[0]" class="kb-doc">
                  <span class="kbd-name" :title="d[0]">{{ d[0] }}</span>
                  <span class="kbd-chunks">{{ d[1] }} 块</span>
                  <button type="button" class="kbd-del" title="删除该文档" @click="onDeleteDoc(d[0])">✕</button>
                </div>
              </div>
              <div class="ai-tip">嵌入模型用于知识库语义检索；模型输出仅供参考，不构成投资建议。</div>
            </div>

            <!-- 券商交易（v2.6）-->
            <div v-else-if="tab === 'broker'" class="broker-tab">
              <!-- 状态行 -->
              <div class="bk-statusbar">
                <span class="bk-chip" :class="{ on: bStatus?.connected }">
                  {{ bStatus?.connected ? "已连接" : "未连接" }} · {{ bStatus?.kind }}
                </span>
                <span v-if="bStatus?.killSwitch" class="bk-chip kill">Kill Switch 已触发</span>
                <button type="button" class="logs-btn" @click="refreshBStatus">刷新状态</button>
              </div>

              <!-- 紧急停止 -->
              <div class="section-title" style="margin-top:16px">紧急停止 Kill Switch</div>
              <div class="section-sub">立即断开券商通道，任何模型或流程不得拦截</div>
              <div class="bk-actions">
                <button type="button" class="logs-btn danger" @click="bKill(false)">紧急停止（断开）</button>
                <button type="button" class="logs-btn danger" @click="bKill(true)">紧急停止 + 全撤</button>
                <button v-if="bStatus?.killSwitch" type="button" class="logs-btn" @click="bReleaseKill">解除 Kill Switch</button>
              </div>

              <!-- 适配器 -->
              <div class="section-title" style="margin-top:20px">券商适配器</div>
              <div class="section-sub">默认「模拟」，无需券商环境即可离线联调；QMT 需本机 miniQMT 极简登录 + xtquant</div>
              <div v-if="bForm" class="bk-actions">
                <label class="bk-radio"><input v-model="bForm.kind" type="radio" value="mock" /> 模拟（默认）</label>
                <label class="bk-radio"><input v-model="bForm.kind" type="radio" value="qmt" /> QMT / xtquant</label>
              </div>
              <div class="bk-actions">
                <button type="button" class="logs-btn primary" @click="bConnect">连接</button>
                <button type="button" class="logs-btn" @click="bDisconnect">断开</button>
              </div>

              <!-- QMT 环境 -->
              <template v-if="bForm && bForm.kind === 'qmt'">
                <div class="section-title" style="margin-top:18px">QMT 环境</div>
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

              <!-- 实盘开关 -->
              <div class="section-title" style="margin-top:20px">实盘交易</div>
              <div class="section-sub">默认关闭；开启后已确认信号可能提交真实委托</div>
              <div v-if="bForm" class="bk-actions">
                <button type="button" class="switch" :class="{ on: bForm.liveEnabled }" @click="toggleLive(!bForm.liveEnabled)">
                  <span class="knob"></span>
                </button>
                <span :class="{ 'bk-live-on': bForm.liveEnabled }">
                  {{ bForm.liveEnabled ? "实盘已开启" : "实盘关闭（模拟）" }}
                </span>
              </div>

              <!-- 风控参数 -->
              <div class="section-title" style="margin-top:20px">风控参数</div>
              <div v-if="bForm" class="bridge-grid">
                <label class="ai-field"><span>单票上限%：{{ bForm.maxSinglePct }}</span>
                  <input v-model.number="bForm.maxSinglePct" type="range" min="5" max="100" step="1" /></label>
                <label class="ai-field"><span>总仓位上限%：{{ bForm.maxTotalPct }}</span>
                  <input v-model.number="bForm.maxTotalPct" type="range" min="10" max="100" step="5" /></label>
              </div>
              <div v-if="bForm" class="bridge-grid">
                <label class="ai-field"><span>禁止开仓时间</span>
                  <input v-model="bForm.noOpenAfter" type="text" spellcheck="false" placeholder="14:55" /></label>
                <label class="ai-field"><span>预留费用%：{{ bForm.feePct }}</span>
                  <input v-model.number="bForm.feePct" type="range" min="0" max="1" step="0.01" /></label>
              </div>

              <!-- 模拟工具 -->
              <div class="section-title" style="margin-top:20px">模拟工具</div>
              <div class="section-sub">注入"昨日持仓"以联调卖出 / 止损；重置清空模拟账户</div>
              <div class="bridge-grid">
                <label class="ai-field"><span>代码</span>
                  <input v-model="seedForm.code" type="text" spellcheck="false" placeholder="600519" /></label>
                <label class="ai-field"><span>数量</span>
                  <input v-model.number="seedForm.vol" type="number" step="100" /></label>
                <label class="ai-field"><span>成本价</span>
                  <input v-model.number="seedForm.price" type="number" step="0.01" /></label>
              </div>
              <div v-if="bForm" class="bk-actions">
                <button type="button" class="logs-btn" @click="bSeed">注入模拟持仓</button>
                <label class="ai-field" style="margin-left:12px"><span>初始资金</span>
                  <input v-model.number="bForm.mockInitCash" type="number" step="10000" /></label>
                <button type="button" class="logs-btn" @click="bMockReset">重置模拟账户</button>
              </div>
              <div v-if="bForm" class="bk-actions" style="margin-top:14px">
                <label class="ai-field">
                  <input v-model="bForm.mockAllowAnytime" type="checkbox" />
                  模拟允许任意时间（休市 / 周末可联调）
                </label>
              </div>

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
              <div class="ab-desc">一套代码，图形化发布 Windows / macOS</div>
              <button type="button" class="ab-replay" @click="replayOnboarding">重新查看新手引导</button>
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
.ai-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 13px; }
.ai-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ai-field label { font-size: 11.5px; font-weight: 600; color: var(--text-dim); }
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
.bk-radio { font-size: 11.5px; color: var(--text-dim); display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.bk-radio input { accent-color: var(--accent); }
.bk-live-on { color: #ff5a6a; font-weight: 700; }
</style>
