// 流式事件 reducer：把 ai://* 事件应用到消息列表，按 sessionId 过滤。
// 零 Tauri/Vue 依赖，node 环境直接单测。所有函数原地变更传入的 list。
import type {
  FactRef,
  MessageInfo,
  StreamMessage,
  ToolState,
} from "./types";

export function toStream(m: MessageInfo): StreamMessage {
  let factRefs: FactRef[] = [];
  try {
    const parsed = JSON.parse(m.refs || "[]");
    if (Array.isArray(parsed)) factRefs = parsed as FactRef[];
  } catch {
    /* refs 不是合法 JSON 时回退空数组 */
  }
  return { ...m, tools: [], factRefs, streaming: false };
}

/** 新建空的 streaming assistant 占位消息（id=-1 表示尚未落库）。 */
function emptyAssistant(): StreamMessage {
  return {
    id: -1,
    role: "assistant",
    content: "",
    toolCalls: "[]",
    tools: [],
    refs: "[]",
    factRefs: [],
    createdAt: Date.now(),
    streaming: true,
  };
}

/** 末尾若没有 streaming 的 assistant 消息，则追加一个空占位并返回它。 */
function ensureStreamingAssistant(list: StreamMessage[]): StreamMessage {
  const last = list[list.length - 1];
  if (last && last.role === "assistant" && last.streaming) return last;
  const msg = emptyAssistant();
  list.push(msg);
  return msg;
}

/** 处理 token 事件：返回是否属于当前会话。 */
export function applyToken(
  list: StreamMessage[],
  sessionId: number,
  ev: { sessionId: number; text: string },
): boolean {
  if (ev.sessionId !== sessionId) return false;
  const msg = ensureStreamingAssistant(list);
  msg.content += ev.text;
  return true;
}

/**
 * 处理工具事件：返回是否属于当前会话。
 * M3 规则（覆盖 brief 原实现）：
 * 1. sessionId 不匹配返回 false；
 * 2. 末尾没有 streaming assistant 时自动建空占位再挂工具条；
 * 3. callId 已存在只更新 status/elapsedMs；
 * 4. 新 callId 且 status==="running" 时先清空 content（作废后端已丢弃的思考碎片）；
 * 5. tools 跨批次累积，从不清空。
 */
export function applyTool(
  list: StreamMessage[],
  sessionId: number,
  ev: {
    sessionId: number;
    callId: string;
    name: string;
    args: unknown;
    status: ToolState["status"];
    elapsedMs: number;
  },
): boolean {
  if (ev.sessionId !== sessionId) return false;
  const msg = ensureStreamingAssistant(list);
  const existing = msg.tools.find((t) => t.callId === ev.callId);
  if (existing) {
    existing.status = ev.status;
    existing.elapsedMs = ev.elapsedMs;
  } else {
    if (ev.status === "running") msg.content = "";
    msg.tools.push({
      callId: ev.callId,
      name: ev.name,
      args: ev.args,
      status: ev.status,
      elapsedMs: ev.elapsedMs,
    });
  }
  return true;
}

/** 处理 done 事件：落库后补正式 messageId/refs 并停止流式。 */
export function applyDone(
  list: StreamMessage[],
  sessionId: number,
  ev: { sessionId: number; messageId: number; refs: FactRef[]; aborted: boolean },
): boolean {
  if (ev.sessionId !== sessionId) return false;
  const last = list[list.length - 1];
  if (last && last.role === "assistant") {
    last.streaming = false;
    last.id = ev.messageId;
    last.factRefs = ev.refs ?? [];
    last.refs = JSON.stringify(ev.refs ?? []);
  }
  return true;
}
