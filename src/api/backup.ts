import { invoke } from "@tauri-apps/api/core";

export interface BackupFileInfo {
  name: string;
  size: number;
}
export interface BackupSetInfo {
  id: string;
  createdMs: number;
  verified: boolean;
  files: BackupFileInfo[];
  totalBytes: number;
}

/** 创建完整备份集（主库 + ai.db）；随后可用 writeBackupConfig 写入配置快照 */
export async function createBackup(): Promise<BackupSetInfo> {
  return await invoke<BackupSetInfo>("backup_full_create");
}

export async function listBackups(): Promise<BackupSetInfo[]> {
  return await invoke<BackupSetInfo[]>("backup_full_list");
}

export async function writeBackupConfig(id: string, content: string): Promise<void> {
  await invoke("backup_write_config", { id, content });
}

export async function readBackupConfig(id: string): Promise<string> {
  return await invoke<string>("backup_read_config", { id });
}

/** 恢复：返回被恢复的文件名；应用会自动退出，由外部脚本替换并重启 */
export async function restoreBackup(id: string): Promise<string[]> {
  return await invoke<string[]>("backup_full_restore", { id });
}

export async function deleteBackup(id: string): Promise<void> {
  await invoke("backup_full_delete", { id });
}

/** 重启后取回恢复流程暂存的配置快照（一次性，取出后后端删除暂存文件） */
export async function takePendingBackupConfig(): Promise<string> {
  return await invoke<string>("backup_take_pending_config");
}
