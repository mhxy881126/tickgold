<script setup lang="ts">
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useTheme, type ThemeId } from "../composables/useTheme";
import { tsStatus } from "../composables/useTimeSeries";
import { logger, type LogLevel } from "../utils/logger";
import { isEnabled as autoStartEnabled, enable as enableAutoStart, disable as disableAutoStart } from "@tauri-apps/plugin-autostart";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [boolean] }>();
function close() {
  emit("update:open", false);
}

const { theme, setTheme, THEMES } = useTheme();

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

type Tab = "appearance" | "data" | "logs" | "about";
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
function pickTab(id: Tab) {
  tab.value = id;
  if (id === "logs") refreshLogs();
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
</style>
