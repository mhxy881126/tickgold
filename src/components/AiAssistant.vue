<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useAiChat } from "../composables/useAiChat";
import { useWorkbench, CARD_META, type CardId } from "../composables/useWorkbench";
import { useMarketContext } from "../composables/useMarketContext";
import { useActions } from "../composables/useActions";
import { renderMarkdown } from "../ai/markdown";
import type { FactRef, StreamMessage, ToolState } from "../ai/types";

const {
  configured,
  sessions,
  currentId,
  messages,
  streaming,
  error,
  ensureInit,
  selectSession,
  startNewSession,
  removeSession,
  send,
  abort,
} = useAiChat();

const bench = useWorkbench();
// 行情上下文用于 FactRef 选股（卡片在 provider 内；缺失时降级为只开卡片）
let market: { select: (c: string) => void } | null = null;
try {
  market = useMarketContext();
} catch {
  market = null;
}

// ===== 初始化 =====
const ready = ref(false);
const bootError = ref("");
onMounted(async () => {
  try {
    await ensureInit();
  } catch (e) {
    bootError.value = e instanceof Error ? e.message : String(e);
  } finally {
    ready.value = true;
  }
});
async function retryBoot() {
  ready.value = false;
  bootError.value = "";
  try {
    await ensureInit();
  } catch (e) {
    bootError.value = e instanceof Error ? e.message : String(e);
  } finally {
    ready.value = true;
  }
}

// ===== 输入 / 发送 =====
const input = ref("");
const inputEl = ref<HTMLTextAreaElement | null>(null);
const busy = ref(false);

function autosize() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 140) + "px";
}
watch(input, autosize);

async function submit() {
  const text = input.value.trim();
  if (!text || streaming.value || busy.value) return;
  input.value = "";
  autosize();
  stickBottom.value = true;
  busy.value = true;
  try {
    await send(text);
  } finally {
    busy.value = false;
  }
  await scrollToBottom();
}
async function stop() {
  try {
    await abort();
  } catch {
    /* ignore */
  }
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void submit();
  }
}

// ===== 滚动跟随 =====
const scrollRef = ref<HTMLElement | null>(null);
const stickBottom = ref(true);
function onScroll() {
  const el = scrollRef.value;
  if (!el) return;
  stickBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}
async function scrollToBottom() {
  await nextTick();
  const el = scrollRef.value;
  if (el && stickBottom.value) el.scrollTop = el.scrollHeight;
}
watch(
  () => messages.value.map((m) => `${m.content.length}:${m.tools.length}`).join("|"),
  () => {
    if (stickBottom.value) void scrollToBottom();
  }
);
watch(streaming, (s) => {
  if (!s) {
    stickBottom.value = true;
    void scrollToBottom();
  }
});

// ===== 会话栏 =====
const sideOpen = ref(true);
async function newChat() {
  await startNewSession();
  stickBottom.value = true;
  await scrollToBottom();
}
async function pickSession(id: number) {
  await selectSession(id);
  stickBottom.value = true;
  await scrollToBottom();
}
async function removeSessionEv(id: number, e: Event) {
  e.stopPropagation();
  await removeSession(id);
}
function relTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toTimeString().slice(0, 5);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
const currentTitle = computed(() => {
  const s = sessions.value.find((x) => x.id === currentId.value);
  return s?.title || "新对话";
});

// ===== 工具回合 =====
const TOOL_LABEL: Record<string, string> = {
  market_overview: "市场情绪概览",
  list_themes: "题材列表",
  theme_detail: "题材详情",
  query_catalysts: "催化剂查询",
  stock_profile: "个股题材档案",
  list_limit_ups: "涨停定格记录",
  semantic_search: "知识库语义检索",
  paper_positions: "模拟盘持仓",
};
function toolLabel(n: string): string {
  return TOOL_LABEL[n] ?? n;
}
function toolArgsText(t: ToolState): string {
  if (t.args == null) return "";
  try {
    const o = t.args as Record<string, unknown>;
    return Object.entries(o)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(" · ");
  } catch {
    return "";
  }
}
function elapsedText(t: ToolState): string {
  if (t.status === "running") return "";
  return t.elapsedMs >= 1000
    ? `${(t.elapsedMs / 1000).toFixed(1)}s`
    : `${t.elapsedMs}ms`;
}

// ===== Markdown =====
function renderHtml(m: StreamMessage): string {
  return renderMarkdown(m.content);
}

// ===== 引用跳转 =====
const FACT_LABEL = "fact-web";
function refLabel(r: FactRef): string {
  if (r.kind === "url") return r.title || r.url || "来源链接";
  const parts: string[] = [];
  const title = r.card ? CARD_META[r.card as CardId]?.title : undefined;
  parts.push(title || r.card || "卡片");
  if (r.code) parts.push(r.code);
  if (r.date) parts.push(r.date);
  return parts.join(" · ");
}
async function openRef(r: FactRef) {
  if (r.kind === "url" && r.url) {
    try {
      const old = await WebviewWindow.getByLabel(FACT_LABEL);
      if (old) await old.close();
    } catch {
      /* ignore */
    }
    try {
      const w = new WebviewWindow(FACT_LABEL, {
        url: r.url,
        title: r.title || "引用来源",
        width: 1080,
        height: 760,
        resizable: true,
      });
      await new Promise((res, rej) => {
        w.once("tauri://created", res);
        w.once("tauri://error", rej);
      });
    } catch (e) {
      console.error("open fact webview", e);
    }
    return;
  }
  if (r.kind === "card") {
    if (r.card) bench.open(r.card as CardId);
    if (r.code) market?.select(r.code);
  }
}

// ===== 打开设置 =====
function openSettings() {
  try {
    const a = useActions()
      .list()
      .find((x) => x.id === "app.settings");
    a?.run();
  } catch {
    /* ignore */
  }
}

// ===== 空态示例 =====
const isEmpty = computed(() => messages.value.length === 0);
const EXAMPLES: { q: string; path: string }[] = [
  {
    q: "今天市场情绪怎么样？涨停和连板梯队如何？",
    path: "M3 12h4l2 7 4-16 2 9h6",
  },
  {
    q: "帮我梳理当前主线题材和龙头股",
    path: "M20.6 13.4 12 22l-9-9V3h10zM6.5 7.5h.01",
  },
  {
    q: "最近哪些板块在持续获得主力资金流入？",
    path: "M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6",
  },
  {
    q: "我模拟盘的持仓今天表现如何？",
    path: "M20 7H4a1 1 0 00-1 1v11a2 2 0 002 2h14a2 2 0 002-2V8a1 1 0 00-1-1zM16 3v4M8 3v4",
  },
];
async function askExample(q: string) {
  input.value = q;
  await submit();
}
</script>

<template>
  <div class="ai-panel" :class="{ 'collapsed-side': !sideOpen }">
    <!-- ===== 会话栏 ===== -->
    <Transition name="side-slide">
      <aside v-if="sideOpen" class="ai-side">
        <button class="new-chat" @click="newChat">
          <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
          新建对话
        </button>
        <div class="side-list">
          <button
            v-for="s in sessions"
            :key="s.id"
            class="side-item"
            :class="{ active: s.id === currentId }"
            @click="pickSession(s.id)"
          >
            <span class="si-title">{{ s.title || "新对话" }}</span>
            <span class="si-meta">
              <span class="si-time">{{ relTime(s.lastAt) }}</span>
              <span class="si-del" title="删除" @click="removeSessionEv(s.id, $event)">
                <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" /></svg>
              </span>
            </span>
          </button>
        </div>
        <div class="side-foot">
          <span class="brand-dot" /> TickGold 慢脑
        </div>
      </aside>
    </Transition>

    <!-- ===== 聊天主区 ===== -->
    <section class="ai-main">
      <header class="ai-topbar">
        <button class="tb-icon" title="会话列表" @click="sideOpen = !sideOpen">
          <svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
        </button>
        <span class="tb-title">{{ currentTitle }}</span>
        <span v-if="streaming" class="tb-live"><span class="live-dot" />思考中</span>
      </header>

      <!-- 初始化中 -->
      <div v-if="!ready" class="ai-state">
        <span class="spinner" /> 正在初始化…
      </div>
      <!-- 初始化失败 -->
      <div v-else-if="bootError" class="ai-state">
        <p class="state-err">初始化失败：{{ bootError }}</p>
        <button class="pill-btn" @click="retryBoot">重试</button>
      </div>
      <!-- 未配置 -->
      <div v-else-if="!configured" class="ai-state config-guide">
        <div class="cg-icon">
          <svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2zM9 21h6M10 17v4M14 17v4" /></svg>
        </div>
        <h3>配置 AI 模型后开始问数</h3>
        <p class="cg-desc">
          支持本地 Ollama（数据不出本机）或云端 OpenAI 兼容接口。配置模型并完成知识库入库后，
          即可用自然语言查询行情、题材、资金与持仓。
        </p>
        <button class="primary-btn" @click="openSettings">前往配置</button>
        <p class="state-tip">所有结论仅供参考，不构成投资建议。</p>
      </div>

      <template v-else>
        <div ref="scrollRef" class="ai-scroll" @scroll="onScroll">
          <!-- 空态 -->
          <div v-if="isEmpty" class="welcome">
            <div class="welcome-head">
              <span class="w-logo">
                <svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2zM9 21h6" /></svg>
              </span>
              <h2>TickGold 问数助手</h2>
              <p>基于本地知识库与行情数据，回答盘面、题材、资金与持仓问题</p>
            </div>
            <div class="example-grid">
              <button
                v-for="(e, k) in EXAMPLES"
                :key="k"
                class="example"
                @click="askExample(e.q)"
              >
                <span class="ex-icon"><svg viewBox="0 0 24 24"><path :d="e.path" /></svg></span>
                <span class="ex-text">{{ e.q }}</span>
                <span class="ex-arrow">
                  <svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                </span>
              </button>
            </div>
          </div>

          <!-- 消息流 -->
          <div
            v-for="m in messages"
            :key="`${m.role}-${m.id}-${m.createdAt}`"
            class="msg-row"
            :class="m.role"
          >
            <div v-if="m.role === 'user'" class="user-bubble">{{ m.content }}</div>
            <div v-else class="assistant">
              <!-- 工具回合 -->
              <div v-if="m.tools.length" class="tool-stack">
                <div
                  v-for="t in m.tools"
                  :key="t.callId"
                  class="tool"
                  :class="t.status"
                >
                  <span class="tool-icon">
                    <svg v-if="t.status === 'running'" class="spin" viewBox="0 0 24 24">
                      <path d="M12 3a9 9 0 109 9" />
                    </svg>
                    <svg v-else-if="t.status === 'ok'" viewBox="0 0 24 24">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </span>
                  <span class="tool-name">{{ toolLabel(t.name) }}</span>
                  <span v-if="toolArgsText(t)" class="tool-args">{{ toolArgsText(t) }}</span>
                  <span class="tool-time">{{ elapsedText(t) }}</span>
                </div>
              </div>
              <!-- 正文 -->
              <div v-if="m.content" class="md" v-html="renderHtml(m)"></div>
              <div v-else-if="m.streaming" class="thinking">
                <span class="dots"><span /><span /><span /></span>
              </div>
              <!-- 引用 -->
              <div v-if="m.factRefs.length" class="refs">
                <button
                  v-for="(r, k) in m.factRefs"
                  :key="k"
                  class="ref-chip"
                  @click="openRef(r)"
                >
                  <svg class="ref-ic" viewBox="0 0 24 24">
                    <path
                      v-if="r.kind === 'url'"
                      d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"
                    />
                    <path
                      v-else
                      d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 8V4M8 13h8M8 17h5"
                    />
                  </svg>
                  {{ refLabel(r) }}
                </button>
              </div>
              <span v-if="m.streaming && m.content" class="caret" />
            </div>
          </div>

          <!-- 错误条（下次发送自动清除） -->
          <div v-if="error" class="chat-error">出错了：{{ error }}</div>
        </div>

        <!-- 输入栏 -->
        <div class="ai-inputbar">
          <div class="input-wrap">
            <textarea
              ref="inputEl"
              v-model="input"
              rows="1"
              placeholder="问点什么…  Enter 发送 / Shift+Enter 换行"
              @keydown="onKeydown"
              @input="autosize"
            ></textarea>
            <button
              v-if="!streaming"
              class="send"
              :disabled="!input.trim()"
              title="发送"
              @click="submit"
            >
              <svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" /></svg>
            </button>
            <button v-else class="stop" title="停止生成" @click="stop">
              <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
            </button>
          </div>
          <div class="input-hint">内容由模型生成，仅供参考，不构成投资建议</div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.ai-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

/* ===== 会话栏 ===== */
.ai-side {
  width: 212px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-card2);
  border-right: 1px solid var(--border);
  min-height: 0;
}
.new-chat {
  margin: 10px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  border-radius: 9px;
  border: 1px solid var(--border-light);
  background: var(--bg-card);
  color: var(--text);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.new-chat svg {
  width: 15px;
  height: 15px;
  stroke: var(--accent);
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
}
.new-chat:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}
.side-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 7px;
  min-height: 0;
}
.side-item {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 9px;
  margin-bottom: 2px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.side-item.active {
  background: var(--bg-hover);
  border-color: var(--border-light);
}
.si-title {
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.si-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.si-time {
  font-size: 10.5px;
  color: var(--text-dim);
}
.si-del {
  opacity: 0;
  display: flex;
  transition: opacity 0.15s;
}
.si-del svg {
  width: 13px;
  height: 13px;
  stroke: var(--text-dim);
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.side-item:hover .si-del {
  opacity: 1;
}
.si-del:hover svg {
  stroke: var(--up);
}
.side-foot {
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 7px;
}
.brand-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}

/* ===== 主区 ===== */
.ai-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.ai-topbar {
  height: 44px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
}
.tb-icon {
  display: flex;
  border: none;
  background: none;
  cursor: pointer;
  padding: 5px;
  border-radius: 7px;
}
.tb-icon svg {
  width: 17px;
  height: 17px;
  stroke: var(--text-dim);
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
}
.tb-icon:hover {
  background: var(--bg-hover);
}
.tb-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tb-live {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-dim);
}
.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--up);
  animation: blink 1s ease-in-out infinite;
}
@keyframes blink {
  50% {
    opacity: 0.3;
  }
}

/* ===== 状态页 ===== */
.ai-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 28px;
  text-align: center;
}
.spinner {
  width: 26px;
  height: 26px;
  border: 2.5px solid var(--border-light);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: rotate 0.8s linear infinite;
}
@keyframes rotate {
  to {
    transform: rotate(360deg);
  }
}
.state-err {
  color: var(--up);
  font-size: 12.5px;
}
.pill-btn,
.primary-btn {
  padding: 8px 26px;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #1a1408;
}
.primary-btn:hover {
  filter: brightness(1.08);
}
.cg-icon svg {
  width: 46px;
  height: 46px;
  stroke: var(--accent);
  fill: none;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.config-guide h3 {
  font-size: 16px;
  color: var(--text);
}
.cg-desc {
  max-width: 420px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
}
.state-tip {
  font-size: 11px;
  color: var(--text-dim);
}

/* ===== 滚动区 ===== */
.ai-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 18px 20px 8px;
}

/* 欢迎区 */
.welcome {
  max-width: 680px;
  margin: 6px auto 20px;
}
.welcome-head {
  text-align: center;
  margin-bottom: 22px;
}
.w-logo {
  display: inline-flex;
  margin-bottom: 12px;
}
.w-logo svg {
  width: 44px;
  height: 44px;
  stroke: var(--accent);
  fill: none;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.welcome-head h2 {
  font-size: 19px;
  color: var(--text);
  margin-bottom: 7px;
}
.welcome-head p {
  font-size: 12.5px;
  color: var(--text-dim);
}
.example-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.example {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 14px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--bg-card);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, transform 0.15s;
}
.example:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}
.ex-icon {
  flex-shrink: 0;
  display: flex;
}
.ex-icon svg {
  width: 19px;
  height: 19px;
  stroke: var(--accent);
  fill: none;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.ex-text {
  flex: 1;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
}
.ex-arrow {
  flex-shrink: 0;
  display: flex;
  opacity: 0;
  transition: opacity 0.15s;
}
.ex-arrow svg {
  width: 15px;
  height: 15px;
  stroke: var(--text-dim);
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.example:hover .ex-arrow {
  opacity: 1;
}

/* ===== 消息 ===== */
.msg-row {
  margin-bottom: 16px;
  display: flex;
}
.msg-row.user {
  justify-content: flex-end;
}
.user-bubble {
  max-width: 78%;
  padding: 9px 13px;
  border-radius: 13px 13px 4px 13px;
  background: var(--bg-hover);
  border: 1px solid var(--border-light);
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.assistant {
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

/* 工具回合 */
.tool-stack {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.tool {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-card);
  align-self: flex-start;
  max-width: 100%;
}
.tool-icon {
  display: flex;
  flex-shrink: 0;
}
.tool-icon svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.tool.running .tool-icon svg {
  stroke: var(--accent);
}
.tool.ok .tool-icon svg {
  stroke: var(--down);
}
.tool.error .tool-icon svg {
  stroke: var(--up);
}
.spin {
  animation: rotate 0.9s linear infinite;
}
.tool-name {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text);
  flex-shrink: 0;
}
.tool-args {
  font-size: 10.5px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.tool-time {
  font-size: 10.5px;
  color: var(--text-dim);
  flex-shrink: 0;
  margin-left: auto;
}

/* 思考三点 */
.thinking {
  display: flex;
  padding: 4px 2px;
}
.dots {
  display: flex;
  gap: 4px;
}
.dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-dim);
  animation: bounce 1.2s ease-in-out infinite;
}
.dots span:nth-child(2) {
  animation-delay: 0.15s;
}
.dots span:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.5;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

/* ===== Markdown 排版 ===== */
.md {
  font-size: 12.5px;
  line-height: 1.72;
  color: var(--text);
  word-break: break-word;
}
.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4) {
  margin: 14px 0 7px;
  line-height: 1.4;
  font-weight: 700;
}
.md :deep(h1) {
  font-size: 16px;
}
.md :deep(h2) {
  font-size: 15px;
}
.md :deep(h3) {
  font-size: 13.5px;
}
.md :deep(h4) {
  font-size: 13px;
}
.md :deep(p) {
  margin: 7px 0;
}
.md :deep(ul),
.md :deep(ol) {
  margin: 7px 0;
  padding-left: 20px;
}
.md :deep(li) {
  margin: 3px 0;
}
.md :deep(ul) {
  list-style: disc;
}
.md :deep(ol) {
  list-style: decimal;
}
.md :deep(a) {
  color: var(--blue);
  text-decoration: none;
}
.md :deep(a:hover) {
  text-decoration: underline;
}
.md :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--accent);
  color: var(--text-dim);
}
.md :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 14px 0;
}
.md :deep(code.md-ic) {
  padding: 1.5px 6px;
  border-radius: 5px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
  font-family: "Consolas", "SF Mono", monospace;
  font-size: 11.5px;
  color: var(--accent);
}
.md :deep(pre) {
  margin: 9px 0;
  padding: 11px 13px;
  border-radius: 9px;
  background: var(--bg);
  border: 1px solid var(--border);
  overflow-x: auto;
}
.md :deep(pre code) {
  font-family: "Consolas", "SF Mono", monospace;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text);
  white-space: pre;
}
/* 表格 */
.md :deep(.md-table) {
  margin: 10px 0;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 9px;
}
.md :deep(table) {
  border-collapse: collapse;
  width: 100%;
  font-size: 11.5px;
}
.md :deep(th),
.md :deep(td) {
  padding: 7px 11px;
  border-bottom: 1px solid var(--border);
  border-right: 1px solid var(--border);
  text-align: left;
  white-space: nowrap;
}
.md :deep(th) {
  background: var(--bg-card2);
  font-weight: 700;
  color: var(--text);
}
.md :deep(tr:last-child td) {
  border-bottom: none;
}
.md :deep(td:last-child),
.md :deep(th:last-child) {
  border-right: none;
}

/* 引用 chips */
.refs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ref-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border-light);
  border-radius: 14px;
  background: var(--bg-card);
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
  max-width: 100%;
}
.ref-chip:hover {
  border-color: var(--accent);
  color: var(--text);
}
.ref-ic {
  width: 13px;
  height: 13px;
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex-shrink: 0;
}

/* 流式光标 */
.caret {
  width: 7px;
  height: 14px;
  display: inline-block;
  background: var(--accent);
  vertical-align: text-bottom;
  animation: blink 0.9s step-start infinite;
}

/* 错误条 */
.chat-error {
  margin: 6px 2px 12px;
  padding: 8px 12px;
  border: 1px solid rgba(239, 95, 107, 0.4);
  border-radius: 8px;
  background: rgba(239, 95, 107, 0.1);
  color: var(--up);
  font-size: 11.5px;
}

/* ===== 输入栏 ===== */
.ai-inputbar {
  flex-shrink: 0;
  padding: 8px 16px 10px;
  border-top: 1px solid var(--border);
}
.input-wrap {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 7px 8px 7px 13px;
  border: 1px solid var(--border-light);
  border-radius: 13px;
  background: var(--bg-card);
  transition: border-color 0.15s;
}
.input-wrap:focus-within {
  border-color: var(--accent);
}
.input-wrap textarea {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  resize: none;
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.6;
  font-family: inherit;
  max-height: 140px;
}
.input-wrap textarea::placeholder {
  color: var(--text-dim);
}
.send,
.stop {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.send {
  background: var(--accent);
}
.send:disabled {
  background: var(--border);
  cursor: not-allowed;
}
.send svg {
  width: 16px;
  height: 16px;
  stroke: #1a1408;
  stroke-width: 2;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.send:disabled svg {
  stroke: var(--text-dim);
}
.stop {
  background: var(--bg-hover);
  border: 1px solid var(--border-light);
}
.stop svg {
  width: 15px;
  height: 15px;
  fill: var(--up);
}
.input-hint {
  margin-top: 6px;
  text-align: center;
  font-size: 10.5px;
  color: var(--text-dim);
}

/* ===== 会话栏过渡 ===== */
.side-slide-enter-active,
.side-slide-leave-active {
  transition: width 0.22s ease, opacity 0.22s ease;
}
.side-slide-enter-from,
.side-slide-leave-to {
  width: 0;
  opacity: 0;
}
@media (max-width: 760px) {
  .example-grid {
    grid-template-columns: 1fr;
  }
}
</style>
