// AI 命令封装（风格对齐 src/api/kb.ts）。
import { invoke } from "@tauri-apps/api/core";
import type { AiConfig, ConnTest, KbStats, MessageInfo, SessionInfo } from "./types";

export function getAiConfig(): Promise<AiConfig> {
  return invoke<AiConfig>("ai_get_config");
}

export function saveAiConfig(cfg: AiConfig): Promise<void> {
  return invoke("ai_save_config", { cfg });
}

export function getCloudKeySet(): Promise<boolean> {
  return invoke<boolean>("ai_get_cloud_key_set");
}

export function setCloudKey(secret: string): Promise<void> {
  return invoke("ai_set_cloud_key", { secret });
}

export function clearCloudKey(): Promise<void> {
  return invoke("ai_clear_cloud_key");
}

export function testConnection(): Promise<ConnTest> {
  return invoke<ConnTest>("ai_test_connection");
}

export function newSession(): Promise<number> {
  return invoke<number>("ai_new_session");
}

export function listSessions(): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>("ai_list_sessions");
}

export function loadSession(sessionId: number): Promise<MessageInfo[]> {
  return invoke<MessageInfo[]>("ai_load_session", { sessionId });
}

export function deleteSession(sessionId: number): Promise<void> {
  return invoke("ai_delete_session", { sessionId });
}

export function chatSend(sessionId: number, text: string): Promise<void> {
  return invoke("ai_chat_send", { sessionId, text });
}

export function chatAbort(sessionId: number): Promise<void> {
  return invoke("ai_chat_abort", { sessionId });
}

export function kbStats(): Promise<KbStats> {
  return invoke<KbStats>("ai_kb_stats");
}

export function listDocs(): Promise<Array<[string, number]>> {
  return invoke<Array<[string, number]>>("ai_list_docs");
}

/** 弹出原生多选框导入 md/txt；返回实际产生新分块的文件名。 */
export function importDocs(): Promise<string[]> {
  return invoke<string[]>("ai_import_docs");
}

export function deleteDoc(fileName: string): Promise<number> {
  return invoke<number>("ai_delete_doc", { fileName });
}

export function reindex(): Promise<number> {
  return invoke<number>("ai_reindex");
}

export function indexDaily(tradeDate: string): Promise<number> {
  return invoke<number>("ai_index_daily", { tradeDate });
}
