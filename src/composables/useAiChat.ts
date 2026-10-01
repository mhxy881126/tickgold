// AI 流式会话状态机：订阅 ai://* 事件并转发给 streamReducer 纯函数。
// 模块级单例：跨组件共享同一份状态，事件在首次 ensureInit 时只订阅一次。
import { ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  FactRef,
  SessionInfo,
  StreamMessage,
  ToolStatus,
} from "../ai/types";
import { applyDone, applyTool, applyToken, toStream } from "../ai/streamReducer";
import * as api from "../ai/api";

interface TokenPayload {
  sessionId: number;
  text: string;
}

interface ToolPayload {
  sessionId: number;
  callId: string;
  name: string;
  args: unknown;
  status: ToolStatus;
  elapsedMs: number;
}

interface DonePayload {
  sessionId: number;
  messageId: number;
  refs: FactRef[];
  aborted: boolean;
}

interface ErrorPayload {
  sessionId: number;
  message: string;
}

let unlisten: UnlistenFn[] | null = null;

const configured = ref(false);
const sessions = ref<SessionInfo[]>([]);
const currentId = ref<number | null>(null);
const messages = ref<StreamMessage[]>([]);
const streaming = ref(false);
const error = ref("");

/** 按当前配置判断是否可用：云端看密钥是否已设置，本地看地址与模型是否已填。 */
async function refreshConfigured(): Promise<void> {
  try {
    const cfg = await api.getAiConfig();
    if (cfg.provider === "cloud") {
      configured.value = await api.getCloudKeySet();
    } else {
      configured.value = cfg.baseUrl.trim() !== "" && cfg.chatModel.trim() !== "";
    }
  } catch {
    configured.value = false;
  }
}

async function refreshSessions(keepCurrent = true): Promise<void> {
  sessions.value = await api.listSessions();
  if ((!keepCurrent || currentId.value === null) && sessions.value.length > 0) {
    currentId.value = sessions.value[0].id;
    await loadCurrent();
  }
}

async function loadCurrent(): Promise<void> {
  if (currentId.value === null) {
    messages.value = [];
    return;
  }
  const rows = await api.loadSession(currentId.value);
  messages.value = rows.map(toStream);
}

export async function ensureInit(): Promise<void> {
  if (!unlisten) {
    unlisten = [];
    unlisten.push(
      await listen<TokenPayload>("ai://token", (e) => {
        applyToken(messages.value, currentId.value ?? -1, e.payload);
      }),
    );
    unlisten.push(
      await listen<ToolPayload>("ai://tool", (e) => {
        applyTool(messages.value, currentId.value ?? -1, e.payload);
      }),
    );
    unlisten.push(
      await listen<DonePayload>("ai://done", (e) => {
        applyDone(messages.value, currentId.value ?? -1, e.payload);
        streaming.value = false;
        void refreshSessions();
      }),
    );
    unlisten.push(
      await listen<ErrorPayload>("ai://error", (e) => {
        if (e.payload.sessionId === (currentId.value ?? -1)) {
          error.value = e.payload.message;
          streaming.value = false;
          const last = messages.value[messages.value.length - 1];
          if (last?.role === "assistant") last.streaming = false;
        }
      }),
    );
  }
  await Promise.all([refreshConfigured(), refreshSessions(false)]);
  if (currentId.value === null) {
    currentId.value = await api.newSession();
    messages.value = [];
  }
}

export async function selectSession(id: number): Promise<void> {
  currentId.value = id;
  error.value = "";
  await loadCurrent();
}

export async function startNewSession(): Promise<void> {
  currentId.value = await api.newSession();
  messages.value = [];
  error.value = "";
  await refreshSessions(true);
}

export async function removeSession(id: number): Promise<void> {
  await api.deleteSession(id);
  if (currentId.value === id) currentId.value = null;
  await refreshSessions(false);
  if (currentId.value === null) {
    currentId.value = await api.newSession();
    messages.value = [];
  }
}

export async function send(text: string): Promise<void> {
  const t = text.trim();
  if (!t || streaming.value || currentId.value === null) return;
  error.value = "";
  messages.value.push({
    id: -1,
    role: "user",
    content: t,
    toolCalls: "[]",
    tools: [],
    refs: "[]",
    factRefs: [],
    createdAt: Date.now(),
  });
  streaming.value = true;
  try {
    await api.chatSend(currentId.value, t);
  } catch (e) {
    streaming.value = false;
    error.value = e instanceof Error ? e.message : String(e);
  }
}

export async function abort(): Promise<void> {
  if (currentId.value !== null) await api.chatAbort(currentId.value);
}

export function useAiChat() {
  return {
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
  };
}
