<template>
  <Transition name="sc">
    <div v-if="open" class="sc-mask" @click.self="close">
      <div class="sc-card" role="dialog" aria-modal="true" aria-label="键盘快捷键">
        <div class="sc-head">
          <span class="sc-title">键盘快捷键</span>
          <button class="sc-x" @click="close" aria-label="关闭">✕</button>
        </div>
        <div class="sc-tip">
          macOS 下 <b>Ctrl</b> 对应 <b>⌘（Command）</b>；点击右侧 ✎ 可自定义快捷键。
        </div>
        <div class="sc-body">
          <!-- 可自定义：来自动作注册表 -->
          <div v-for="g in dynGroups" :key="g.title" class="sc-group">
            <div class="sc-gtitle">{{ g.title }}</div>
            <div v-for="it in g.items" :key="it.id" class="sc-row">
              <span class="sc-desc">{{ it.title }}</span>
              <span class="sc-right">
                <template v-if="recordingId === it.id && !clashId">
                  <span class="rec-hint">请按下新快捷键… <em>Backspace 清除 · Esc 取消</em></span>
                </template>
                <template v-else-if="recordingId === it.id && clashId">
                  <span class="rec-conflict">与「{{ clashTitle }}」冲突</span>
                  <button class="mini danger" @click="confirmReplace">替换</button>
                  <button class="mini" @click="retryPress">重按</button>
                </template>
                <template v-else>
                  <span class="sc-keys">
                    <kbd v-if="!it.keys" class="unbound">未绑定</kbd>
                    <kbd v-for="(k, i) in keyTokens(it.keys)" :key="i">{{ k }}</kbd>
                  </span>
                  <button v-if="isCustom(it.id)" class="icon-btn" title="恢复默认" @click="resetBinding(it.id)">↺</button>
                  <button class="icon-btn" title="自定义" @click="startRecord(it.id)">✎</button>
                </template>
              </span>
            </div>
          </div>

          <!-- 不可自定义：系统级 / 面板内部 / 鼠标操作 -->
          <div v-for="g in staticGroups" :key="g.title" class="sc-group">
            <div class="sc-gtitle muted">{{ g.title }}</div>
            <div v-for="(it, i) in g.items" :key="i" class="sc-row static">
              <span class="sc-desc">{{ it.desc }}</span>
              <span class="sc-keys">
                <kbd v-for="(k, j) in it.tokens" :key="j">{{ k }}</kbd>
              </span>
            </div>
          </div>
        </div>
        <div class="sc-foot">
          <button class="sc-reset" @click="resetAll">全部恢复默认</button>
          <button class="sc-ok" @click="close">知道了</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useActions, type Action } from "../composables/useActions";
import { parseCombo, sameCombo } from "../lib/keymap";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "update:open", v: boolean): void }>();

const { os, list, setBinding, resetBinding, resetAll, effectiveKeys } = useActions();

function close() {
  cancelRecord();
  emit("update:open", false);
}

interface DynItem {
  id: string;
  title: string;
  keys: string | null;
}
// 动态分组：动作注册表里"原本带默认快捷键"的动作（即使被清空也保留行，便于重绑）
const dynGroups = computed<{ title: string; items: DynItem[] }[]>(() => {
  const map = new Map<string, DynItem[]>();
  for (const a of list()) {
    if (!a.defaultKeys || a.id === "app.shortcuts-qm") continue;
    const arr = map.get(a.category) ?? [];
    arr.push({ id: a.id, title: a.title, keys: effectiveKeys(a.id) });
    map.set(a.category, arr);
  }
  return [...map.entries()].map(([title, items]) => ({ title, items }));
});

const staticGroups: { title: string; items: { tokens: string[]; desc: string }[] }[] = [
  {
    title: "全局 / 窗口（系统级，不可改）",
    items: [{ tokens: ["Alt", "`"], desc: "显示 / 隐藏窗口（老板键）" }],
  },
  {
    title: "命令面板（面板内）",
    items: [
      { tokens: ["↑ / ↓"], desc: "移动选择" },
      { tokens: ["Enter"], desc: "打开所选功能" },
      { tokens: ["Esc"], desc: "关闭面板" },
    ],
  },
  {
    title: "K 线 / 复盘（鼠标）",
    items: [
      { tokens: ["双击蜡烛"], desc: "打开历史分时复盘工作台" },
      { tokens: ["Esc"], desc: "结束画线 / 关闭弹窗" },
    ],
  },
];

// 把 spec 拆成平台化的按键胶囊
function keyTokens(spec: string | null): string[] {
  if (!spec) return [];
  const c = parseCombo(spec);
  const t: string[] = [];
  if (os === "mac") {
    if (c.ctrl || c.meta) t.push("⌘");
    if (c.alt) t.push("⌥");
    if (c.shift) t.push("⇧");
  } else {
    if (c.ctrl) t.push("Ctrl");
    if (c.meta) t.push("Win");
    if (c.alt) t.push("Alt");
    if (c.shift) t.push("Shift");
  }
  t.push(c.key);
  return t;
}
function isCustom(id: string): boolean {
  const def = list().find((a) => a.id === id)?.defaultKeys ?? null;
  return effectiveKeys(id) !== def;
}

// ===== 自定义录制 =====
const recordingId = ref<string | null>(null);
const clashId = ref<string | null>(null);
const pendingSpec = ref<string | null>(null);

function startRecord(id: string) {
  recordingId.value = id;
  clashId.value = null;
  pendingSpec.value = null;
}
function cancelRecord() {
  recordingId.value = null;
  clashId.value = null;
  pendingSpec.value = null;
}
function retryPress() {
  clashId.value = null;
  pendingSpec.value = null;
}
const clashTitle = computed(
  () => list().find((a) => a.id === clashId.value)?.title ?? ""
);
function confirmReplace() {
  if (recordingId.value && clashId.value && pendingSpec.value) {
    setBinding(clashId.value, null);
    setBinding(recordingId.value, pendingSpec.value);
  }
  cancelRecord();
}

function eventToSpec(e: KeyboardEvent): string {
  const t: string[] = [];
  if (os === "mac") {
    if (e.metaKey || e.ctrlKey) t.push("Ctrl");
  } else {
    if (e.ctrlKey) t.push("Ctrl");
    if (e.metaKey) t.push("Meta");
  }
  if (e.altKey) t.push("Alt");
  if (e.shiftKey) t.push("Shift");
  let k = e.key;
  if (k.length === 1) k = k.toUpperCase();
  t.push(k);
  return t.join("+");
}

// 捕获阶段处理：录制时拦截，避免按键同时触发其他动作；否则 Esc 关闭弹窗
function onKey(e: KeyboardEvent) {
  if (!props.open) return;
  if (recordingId.value) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return cancelRecord();
    if (e.key === "Backspace") {
      setBinding(recordingId.value, null);
      return cancelRecord();
    }
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return; // 仅修饰键，继续等
    const spec = eventToSpec(e);
    const clash = list().find(
      (a: Action) =>
        a.id !== recordingId.value &&
        !!a.defaultKeys &&
        !!effectiveKeys(a.id) &&
        sameCombo(effectiveKeys(a.id)!, spec)
    );
    if (clash) {
      clashId.value = clash.id;
      pendingSpec.value = spec;
    } else {
      setBinding(recordingId.value, spec);
      cancelRecord();
    }
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  }
}
onMounted(() => window.addEventListener("keydown", onKey, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
</script>

<style scoped>
.sc-mask {
  position: fixed; inset: 0; z-index: 10000;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
  backdrop-filter: blur(2px);
}
.sc-card {
  width: 560px; max-width: calc(100vw - 40px);
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
.sc-gtitle.muted { color: var(--text-dim); }
.sc-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 5px 0;
}
.sc-row.static { opacity: 0.85; }
.sc-desc { font-size: 13px; color: var(--text); }
.sc-right { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.sc-keys { display: inline-flex; align-items: center; gap: 4px; }
kbd {
  display: inline-flex; align-items: center;
  min-width: 22px; justify-content: center;
  padding: 2px 7px; font-size: 12px; line-height: 1.5;
  color: var(--text); background: var(--bg-card);
  border: 1px solid var(--border-light); border-bottom-width: 2px;
  border-radius: 6px; font-family: inherit; white-space: nowrap;
}
kbd.unbound { color: var(--text-dim); border-style: dashed; }
.icon-btn {
  width: 24px; height: 24px; border-radius: 6px;
  background: transparent; border: 1px solid transparent;
  color: var(--text-dim); cursor: pointer; font-size: 13px;
  display: inline-flex; align-items: center; justify-content: center;
}
.icon-btn:hover { color: var(--text); background: var(--bg-hover); border-color: var(--border-light); }
.mini {
  padding: 3px 10px; font-size: 12px; border-radius: 6px;
  background: var(--bg-card); color: var(--text);
  border: 1px solid var(--border-light); cursor: pointer;
}
.mini.danger { color: #e5484d; border-color: #e5484d55; }
.rec-hint { font-size: 12px; color: var(--accent); }
.rec-hint em { color: var(--text-dim); font-style: normal; }
.rec-conflict { font-size: 12px; color: #e5484d; }
.sc-foot {
  padding: 12px 18px; border-top: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
}
.sc-reset {
  background: transparent; color: var(--text-dim); border: none;
  font-size: 12px; cursor: pointer;
}
.sc-reset:hover { color: var(--text); }
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
