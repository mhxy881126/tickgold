<script setup lang="ts">
import { ref } from "vue";
import { useTheme, type ThemeId } from "../composables/useTheme";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [boolean] }>();
function close() {
  emit("update:open", false);
}

const { theme, setTheme, THEMES } = useTheme();

type Tab = "appearance" | "general" | "about";
const tab = ref<Tab>("appearance");
function pick(id: ThemeId) {
  setTheme(id);
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
            <button class="nav-item" :class="{ on: tab === 'general' }" @click="tab = 'general'">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M19.4 13a7.8 7.8 0 000-2l2-1.5-2-3.4-2.4 1a7.6 7.6 0 00-1.7-1L15 3.5H9l-.3 2.6a7.6 7.6 0 00-1.7 1l-2.4-1-2 3.4L4.6 11a7.8 7.8 0 000 2l-2 1.5 2 3.4 2.4-1a7.6 7.6 0 001.7 1l.3 2.6h6l.3-2.6a7.6 7.6 0 001.7-1l2.4 1 2-3.4zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z" /></svg>
              通用
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

            <!-- 通用（占位） -->
            <div v-else-if="tab === 'general'" class="ph">
              <svg viewBox="0 0 24 24" width="34" height="34"><path fill="currentColor" d="M19.4 13a7.8 7.8 0 000-2l2-1.5-2-3.4-2.4 1a7.6 7.6 0 00-1.7-1L15 3.5H9l-.3 2.6a7.6 7.6 0 00-1.7 1l-2.4-1-2 3.4L4.6 11a7.8 7.8 0 000 2l-2 1.5 2 3.4 2.4-1a7.6 7.6 0 001.7 1l.3 2.6h6l.3-2.6a7.6 7.6 0 001.7-1l2.4 1 2-3.4zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z" /></svg>
              <p>通用偏好（开机启动、刷新频率、数据默认源等）</p>
              <p class="ph2">即将推出，敬请期待</p>
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
