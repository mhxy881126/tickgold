// E2E 假实现：@tauri-apps 的 plugin-sql / plugin-process / plugin-autostart /
// plugin-updater / plugin-opener。通过 Vite alias 指向本文件。
import { fakeDb } from "./backend";

// ---- plugin-sql（default export，带静态 load）----
class FakeDatabase {
  static async load(_uri: string): Promise<FakeDatabase> {
    return new FakeDatabase();
  }
  select<T = unknown[]>(sql: string, params?: unknown[]): Promise<T> {
    return fakeDb.select(sql, params) as unknown as Promise<T>;
  }
  execute(sql: string, params?: unknown[]): Promise<{ lastInsertId?: number; rowsAffected: number }> {
    return fakeDb.execute(sql, params);
  }
}
export default FakeDatabase;

// ---- plugin-process ----
export const relaunch = async (): Promise<void> => {};
export const exit = async (_code = 0): Promise<void> => {};

// ---- plugin-autostart ----
let autoStart = false;
export const isEnabled = async (): Promise<boolean> => autoStart;
export const enable = async (): Promise<void> => { autoStart = true; } ;
export const disable = async (): Promise<void> => { autoStart = false; };

// ---- plugin-updater（null 表示当前已是最新）----
export const check = async (): Promise<null> => null;

// ---- plugin-opener ----
export const openUrl = async (..._args: unknown[]): Promise<void> => {};
export const openPath = async (..._args: unknown[]): Promise<void> => {};
export const revealItemInDir = async (..._args: unknown[]): Promise<void> => {};
