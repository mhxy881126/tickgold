// AI 慢脑域类型：字段名与 Rust serde camelCase 输出一致。

export type ProviderKind = "ollama" | "cloud";

export interface AiConfig {
  provider: ProviderKind;
  baseUrl: string;
  chatModel: string;
  embedModel: string;
  temperature: number;
  enableAutoIndex: boolean;
}

export interface SessionInfo {
  id: number;
  title: string;
  createdAt: number;
  lastAt: number;
}

export type MessageRole = "user" | "assistant" | "tool";

export interface MessageInfo {
  id: number;
  role: MessageRole;
  content: string;
  toolCalls: string;
  refs: string;
  createdAt: number;
}

export type ToolStatus = "running" | "ok" | "error";

export interface ToolState {
  callId: string;
  name: string;
  args: unknown;
  status: ToolStatus;
  elapsedMs: number;
}

/** 前端流式消息（未落库的临时值；done 后补 messageId/refs）。 */
export interface StreamMessage extends MessageInfo {
  toolCalls: string;
  tools: ToolState[];
  refs: string;
  factRefs: FactRef[];
  streaming?: boolean;
}

export interface FactRef {
  kind: "card" | "url";
  card?: string;
  code?: string;
  date?: string;
  url?: string;
  title?: string;
}

export interface KbStats {
  total: number;
  embedded: number;
  bytesEstimate: number;
  byType: Array<[string, number]>;
}

export interface ConnTest {
  latencyMs: number;
  models: string[];
}

export interface IndexProgress {
  phase: string;
  done: number;
  total: number;
  error?: string;
}
