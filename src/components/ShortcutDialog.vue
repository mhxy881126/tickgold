<template>
  <Transition name="sc">
    <div v-if="open" class="sc-mask" @click.self="close">
      <div class="sc-card" role="dialog" aria-modal="true" aria-label="键盘快捷键">
        <div class="sc-head">
          <span class="sc-title">键盘快捷键</span>
          <button class="sc-x" @click="close" aria-label="关闭">✕</button>
        </div>
        <div class="sc-tip">macOS 下 <b>Ctrl</b> 对应 <b>⌘（Command）</b>。</div>
        <div class="sc-body">
          <div v-for="g in groups" :key="g.title" class="sc-group">
            <div class="sc-gtitle">{{ g.title }}</div>
            <div v-for="it in g.items" :key="it[0]" class="sc-row">
              <span class="sc-desc">{{ it[1] }}</span>
              <span class="sc-keys">
                <kbd v-for="(k, i) in splitKeys(it[0])" :key="i">
                  <span v-if="i > 0" class="sc-plus">+</span>{{ k }}
                </kbd>
              </span>
            </div>
          </div>
        </div>
        <div class="sc-foot">
          <button class="sc-ok" @click="close">知道了</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "update:open", v: boolean): void }>();

function close() {
  emit("update:open", false);
}

// 把 "Ctrl/⌘ + K" 拆成单个按键胶囊（按 " + " 分隔）
function splitKeys(s: string): string[] {
  return s.split(" + ").map((x) => x.trim());
}

// 快捷键分组（与 App.vue onGlobalKey 中实际注册的保持一致）
const groups: { title: string; items: [string, string][] }[] = [
  {
    title: "全局 / 窗口",
    items: [
      ["Alt + `", "显示 / 隐藏窗口（老板键）"],
      ["Ctrl/⌘ + K", "打开命令面板"],
      ["Ctrl/⌘ + ,", "打开设置"],
      ["Ctrl/⌘ + U", "检查更新"],
      ["Ctrl/⌘ + /", "打开本快捷键速查"],
    ],
  },
  {
    title: "命令面板",
    items: [
      ["↑ / ↓", "移动选择"],
      ["Enter", "打开所选功能"],
      ["Esc", "关闭面板"],
    ],
  },
  {
    title: "通用",
    items: [["Esc", "退出卡片聚焦 / 关闭弹窗"]],
  },
  {
    title: "K 线 / 复盘",
    items: [
      ["双击蜡烛", "打开历史分时复盘工作台"],
      ["Esc", "结束画线 / 关闭弹窗"],
    ],
  },
];

function onKey(e: KeyboardEvent) {
  if (props.open && e.key === "Escape") {
    e.preventDefault();
    close();
  }
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<style scoped>
.sc-mask {
  position: fixed; inset: 0; z-index: 10000;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
  backdrop-filter: blur(2px);
}
.sc-card {
  width: 520px; max-width: calc(100vw - 40px);
  max-height: 84vh; display: flex; flex-direction: column;
  background: var(--bg-panel); color: var(--text);
  border: 1px solid var(--border-light); border-radius: 12px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
.sc-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--border);
}
.sc-title { font-size: 15px; font-weight: 700; }
.sc-x {
  background: transparent; border: none; color: var(--text-dim);
  font-size: 14px; cursor: pointer; padding: 2px 6px; border-radius: 6px;
}
.sc-x:hover { color: var(--text); background: var(--bg-hover); }
.sc-tip {
  padding: 8px 18px; font-size: 12px; color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.sc-body { overflow-y: auto; padding: 6px 18px 12px; }
.sc-group { padding: 10px 0 4px; }
.sc-gtitle {
  font-size: 12px; font-weight: 700; color: var(--accent);
  margin-bottom: 6px; letter-spacing: 0.5px;
}
.sc-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 5px 0;
}
.sc-desc { font-size: 13px; color: var(--text); }
.sc-keys { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
kbd {
  display: inline-flex; align-items: center; gap: 3px;
  min-width: 22px; justify-content: center;
  padding: 2px 7px; font-size: 12px; line-height: 1.5;
  color: var(--text); background: var(--bg-card);
  border: 1px solid var(--border-light); border-bottom-width: 2px;
  border-radius: 6px; font-family: inherit; white-space: nowrap;
}
.sc-plus { color: var(--text-dim); margin-right: 1px; }
.sc-foot {
  padding: 12px 18px; border-top: 1px solid var(--border);
  display: flex; justify-content: flex-end;
}
.sc-ok {
  background: var(--accent); color: #1a1407; border: none;
  padding: 7px 20px; border-radius: 8px; font-weight: 700;
  cursor: pointer; font-size: 13px;
}
.sc-ok:hover { filter: brightness(1.08); }

.sc-enter-active, .sc-leave-active { transition: opacity 0.18s ease; }
.sc-enter-active .sc-card, .sc-leave-active .sc-card { transition: transform 0.18s ease, opacity 0.18s ease; }
.sc-enter-from, .sc-leave-to { opacity: 0; }
.sc-enter-from .sc-card, .sc-leave-to .sc-card { transform: scale(0.96); opacity: 0; }
</style>
