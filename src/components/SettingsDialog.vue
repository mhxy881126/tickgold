<script setup lang="ts">
import { ref } from "vue";
import { useTheme, type ThemeId } from "../composables/useTheme";
import { tsStatus } from "../composables/useTimeSeries";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [boolean] }>();
function close() {
  emit("update:open", false);
}

const { theme, setTheme, THEMES } = useTheme();

type Tab = "appearance" | "data" | "about";
const tab = ref<Tab>("appearance");
function pick(id: ThemeId) {
  setTheme(id);
}
function fmtTime(ts: number) {
  return ts ? new Date(ts).toLocaleString() : "尚未采集";
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
            <button class="nav-item" :class="{ on: tab === 'appearance' }" @click="tab = 'appearance'">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 3a9 9 0 100 18 9 9 0 000-18zm0 2v14a7 7 0 000-14zm0 0a7 7 0 010 14z" /></svg>
              外观
            </button>
            <button class="nav-item" :class="{ on: tab === 'data' }" @click="tab = 'data'">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 3C7.6 3 4 4.8 4 7v10c0 2.2 3.6 4 8 4s8-1.8 8-4V7c0-2.2-3.6-4-8-4zm6 14c0 .6-2.2 1.7-6 1.7S6 17.6 6 17v-2.6c1.3 1 3.4 1.6 6 1.6s4.7-.6 6-1.6zm0-5c0 .6-2.2 1.7-6 1.7S6 12.6 6 12V9.4c1.3 1 3.4 1.6 6 1.6s4.7-.6 6-1.6zm0-5c0 .6-2.2 1.7-6 1.7S6 7.6 6 7s2.2-1.7 6-1.7S18 6.4 18 7z" /></svg>
              数据中心
            </button>
            <button class="nav-item" :class="{ on: tab === 'about' }" @click="tab = 'about'">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2zm0-8h-2V7h2z" /></svg>
              关于
            </button>
          </nav>

          <!-- 右侧内容 -->
          <div class="set-content">
            <!-- 外观 / 配色 -->
            <div v-if="tab === 'appearance'">
              <div class="section-title">配色主题</div>
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

/* 弹窗过渡 */
.dlg-enter-active, .dlg-leave-active { transition: opacity 0.22s; }
.dlg-enter-active .set-dialog, .dlg-leave-active .set-dialog { transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.22s; }
.dlg-enter-from, .dlg-leave-to { opacity: 0; }
.dlg-enter-from .set-dialog, .dlg-leave-to .set-dialog { transform: scale(0.94); opacity: 0; }
</style>
