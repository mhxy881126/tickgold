<template>
  <Transition name="ob">
    <div v-if="open" class="ob-mask">
      <div class="ob-card" role="dialog" aria-modal="true" aria-label="首次引导">
        <!-- 步骤指示 -->
        <div class="ob-dots">
          <i v-for="i in steps" :key="i" :class="{ on: i - 1 === step }"></i>
        </div>

        <!-- 0 欢迎 -->
        <div v-if="step === 0" class="ob-pane">
          <div class="ob-logo">TickGold</div>
          <h2>欢迎使用 TickGold</h2>
          <p class="ob-lead">跨平台 A 股盯盘桌面终端 · 灵动岛版<br />实时行情、智能预警、分时复盘，一个工作台全搞定。</p>
        </div>

        <!-- 1 核心能力 -->
        <div v-else-if="step === 1" class="ob-pane">
          <h2>核心能力</h2>
          <div class="ob-feats">
            <div class="ob-feat">
              <div class="ob-fi" style="color: var(--up)">◈</div>
              <div class="ob-ft">实时盯盘</div>
              <div class="ob-fd">自选 / 榜单 / 板块 / 资金流，多源容灾、毫秒级刷新，支持卡片自由布局与主从聚焦。</div>
            </div>
            <div class="ob-feat">
              <div class="ob-fi" style="color: var(--accent)">♨</div>
              <div class="ob-ft">智能预警</div>
              <div class="ob-fd">价格边沿、跳水、封板 / 炸板、换手率等多类条件，触发即系统通知 + 提示音，历史可回溯。</div>
            </div>
            <div class="ob-feat">
              <div class="ob-fi" style="color: var(--blue)">⟳</div>
              <div class="ob-ft">分时复盘</div>
              <div class="ob-fd">双击 K 线蜡烛打开复盘工作台，逐分钟回放、多日分时叠加、量比副图，盘后推演更从容。</div>
            </div>
          </div>
        </div>

        <!-- 2 个性化 -->
        <div v-else-if="step === 2" class="ob-pane">
          <h2>个性化设置</h2>
          <div class="ob-sec-title">界面主题（可稍后在设置中更改）</div>
          <div class="ob-themes">
            <button
              v-for="t in THEMES"
              :key="t.id"
              class="ob-theme"
              :class="{ on: theme === t.id }"
              @click="setTheme(t.id)"
            >
              <span class="ob-sw">
                <i v-for="(c, ci) in t.sw" :key="ci" :style="{ background: c }"></i>
              </span>
              <span class="ob-tn">{{ t.name }}</span>
            </button>
          </div>
          <div class="ob-sec-title">启动</div>
          <div class="ob-row">
            <div>
              <div class="ob-rl">开机自动启动 TickGold</div>
              <div class="ob-rd">登录系统后在后台运行，随时从托盘唤出</div>
            </div>
            <button class="ob-switch" :class="{ on: autoStart }" @click="toggleAuto" role="switch" :aria-checked="autoStart">
              <span class="ob-knob"></span>
            </button>
          </div>
        </div>

        <!-- 3 完成 -->
        <div v-else class="ob-pane">
          <div class="ob-done">✓</div>
          <h2>一切就绪</h2>
          <p class="ob-lead">
            按 <b>Ctrl/⌘ + K</b> 打开命令面板快速跳转；<br />
            按 <b>Ctrl/⌘ + /</b> 随时查看全部快捷键。
          </p>
        </div>

        <!-- 底部导航 -->
        <div class="ob-nav">
          <button v-if="step < steps - 1" class="ob-skip" @click="finish">跳过</button>
          <span v-else></span>
          <div class="ob-right">
            <button v-if="step > 0" class="ob-back" @click="step--">上一步</button>
            <button v-if="step < steps - 1" class="ob-next" @click="step++">下一步</button>
            <button v-else class="ob-next" @click="finish">开始使用</button>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useTheme, type ThemeId } from "../composables/useTheme";
import { isEnabled as asLoad, enable as asEnable, disable as asDisable } from "@tauri-apps/plugin-autostart";
import { db } from "../db/database";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "update:open", v: boolean): void }>();

const steps = 4;
const step = ref(0);
const { THEMES, theme, setTheme } = useTheme();

// 开机自启
const autoStart = ref(false);
async function syncAuto() {
  try {
    autoStart.value = await asLoad();
  } catch {
    /* web 预览 */
  }
}
async function toggleAuto() {
  try {
    if (autoStart.value) {
      await asDisable();
      autoStart.value = false;
    } else {
      await asEnable();
      autoStart.value = true;
    }
  } catch {
    /* ignore */
  }
}
void syncAuto();

async function finish() {
  try {
    await db().execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [
      "onboarding_done",
      "1",
    ]);
  } catch {
    /* ignore */
  }
  step.value = 0;
  emit("update:open", false);
}

// 让模板中 setTheme 类型可用（ThemeId 仅用于约束）
void (null as unknown as ThemeId);
</script>

<style scoped>
.ob-mask {
  position: fixed; inset: 0; z-index: 10001;
  background: rgba(0, 0, 0, 0.62);
  display: flex; align-items: center; justify-content: center;
  backdrop-filter: blur(3px);
}
.ob-card {
  width: 620px; max-width: calc(100vw - 40px);
  background: var(--bg-panel); color: var(--text);
  border: 1px solid var(--border-light); border-radius: 14px;
  box-shadow: 0 28px 70px rgba(0, 0, 0, 0.6);
  padding: 22px 26px 16px; overflow: hidden;
}
.ob-dots { display: flex; gap: 7px; justify-content: center; margin-bottom: 18px; }
.ob-dots i {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--border-light); transition: all 0.2s;
}
.ob-dots i.on { background: var(--accent); width: 18px; border-radius: 4px; }

.ob-pane { min-height: 280px; display: flex; flex-direction: column; }
.ob-pane h2 { text-align: center; margin: 4px 0 12px; font-size: 20px; }
.ob-lead {
  text-align: center; color: var(--text-dim); font-size: 14px;
  line-height: 1.9; margin: 0;
}
.ob-logo {
  align-self: center; font-size: 30px; font-weight: 800; letter-spacing: 2px;
  color: var(--accent); margin: 26px 0 14px;
  padding: 10px 26px; border: 1px solid var(--border-light); border-radius: 12px;
  background: var(--bg-card);
}

/* 核心能力 */
.ob-feats { display: flex; flex-direction: column; gap: 12px; margin-top: 6px; }
.ob-feat {
  display: grid; grid-template-columns: 34px 84px 1fr; align-items: center;
  gap: 10px; padding: 12px 14px;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px;
}
.ob-fi { font-size: 20px; text-align: center; }
.ob-ft { font-weight: 700; font-size: 14px; }
.ob-fd { color: var(--text-dim); font-size: 12.5px; line-height: 1.7; }

/* 个性化 */
.ob-sec-title {
  font-size: 12.5px; font-weight: 700; color: var(--accent);
  margin: 14px 0 8px;
}
.ob-themes {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
}
.ob-theme {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 9px; cursor: pointer;
  background: var(--bg-card); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; font-family: inherit;
}
.ob-theme.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ob-sw { display: inline-flex; overflow: hidden; border-radius: 4px; flex-shrink: 0; }
.ob-sw i { width: 9px; height: 22px; display: block; }
.ob-tn { font-size: 12px; text-align: left; line-height: 1.3; }
.ob-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; background: var(--bg-card);
  border: 1px solid var(--border); border-radius: 10px;
}
.ob-rl { font-size: 13.5px; font-weight: 600; }
.ob-rd { font-size: 12px; color: var(--text-dim); margin-top: 2px; }
.ob-switch {
  width: 42px; height: 23px; border-radius: 12px; flex-shrink: 0;
  background: var(--border-light); border: none; position: relative;
  cursor: pointer; transition: background 0.2s; padding: 0;
}
.ob-switch.on { background: var(--accent); }
.ob-knob {
  position: absolute; top: 2.5px; left: 3px; width: 18px; height: 18px;
  border-radius: 50%; background: #fff; transition: transform 0.2s;
}
.ob-switch.on .ob-knob { transform: translateX(18px); }

/* 完成 */
.ob-done {
  align-self: center; width: 64px; height: 64px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 32px; color: var(--accent); margin: 24px 0 16px;
  background: var(--bg-card); border: 1px solid var(--border-light);
}

/* 导航 */
.ob-nav {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border);
}
.ob-right { display: flex; gap: 10px; }
.ob-skip, .ob-back {
  background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 16px; cursor: pointer; font-size: 13px; font-family: inherit;
}
.ob-skip:hover, .ob-back:hover { color: var(--text); border-color: var(--border-light); }
.ob-next {
  background: var(--accent); color: #1a1407; border: none;
  padding: 8px 22px; border-radius: 8px; font-weight: 700;
  cursor: pointer; font-size: 13px; font-family: inherit;
}
.ob-next:hover { filter: brightness(1.08); }

.ob-enter-active, .ob-leave-active { transition: opacity 0.2s ease; }
.ob-enter-from, .ob-leave-to { opacity: 0; }
</style>
