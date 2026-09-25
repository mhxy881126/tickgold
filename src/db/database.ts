// SQLite 数据访问单例（tauri-plugin-sql）
// 建表迁移在 Rust 端（lib.rs）配置；这里负责连接、默认数据与一次 localStorage 迁移。
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import type { AlertRule } from "../api/types";

let instance: Database | null = null;
let pending: Promise<Database> | null = null;

const DEFAULT_CODES = ["600519", "000001", "300750", "601318"];
const DEFAULT_NAMES: Record<string, string> = {
  "600519": "贵州茅台",
  "000001": "平安银行",
  "300750": "宁德时代",
  "601318": "中国平安",
};

/** 获取已初始化的数据库（未初始化会抛错） */
export function db(): Database {
  if (!instance) throw new Error("数据库尚未初始化，请先 await ensureDb()");
  return instance;
}

/** 应用启动时调用一次：连接并初始化数据库 */
export function ensureDb(): Promise<Database> {
  if (instance) return Promise.resolve(instance);
  if (!pending) pending = init();
  return pending;
}

async function init(): Promise<Database> {
  try {
    const d = await Database.load("sqlite:stock-dock.db");
    await seedGroups(d);
    await seedStocks(d);
    await seedAlerts(d);
    // 迁移完成后清理旧的 localStorage
    try {
      localStorage.removeItem("sd_watchlist_v1");
      localStorage.removeItem("sd_alerts_v1");
    } catch {
      /* ignore */
    }
    instance = d;
    return d;
  } catch (e) {
    // 数据库可能损坏：自动恢复最近备份后重启（无备份则抛原错）
    try {
      const restored = await invoke<boolean>("restore_latest_backup");
      if (restored) {
        await relaunch();
        return new Promise<Database>(() => {
          /* 即将重启，挂起此 Promise */
        });
      }
    } catch (re) {
      console.error("[db] auto-restore failed", re);
    }
    throw e;
  }
}

async function seedGroups(d: Database) {
  // 幂等：NOT EXISTS 防止多窗口并发初始化插入重复默认分组
  await d.execute(
    "INSERT INTO groups(name, sort_order, created_at) SELECT '我的自选', 0, ? WHERE NOT EXISTS (SELECT 1 FROM groups)",
    [Date.now()]
  );
}

async function seedStocks(d: Database) {
  const r = await d.select<{ c: number }[]>("SELECT COUNT(*) AS c FROM stocks");
  if ((r[0]?.c ?? 0) !== 0) return;
  let codes: string[] = [];
  try {
    const raw = localStorage.getItem("sd_watchlist_v1");
    if (raw) codes = JSON.parse(raw) as string[];
  } catch {
    /* ignore */
  }
  if (!Array.isArray(codes) || codes.length === 0) codes = DEFAULT_CODES;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    await d.execute(
      "INSERT OR IGNORE INTO stocks(code, name, group_id, sort_order, created_at) VALUES(?, ?, 1, ?, ?)",
      [code, DEFAULT_NAMES[code] ?? "", i, Date.now()]
    );
  }
}

async function seedAlerts(d: Database) {
  const r = await d.select<{ c: number }[]>("SELECT COUNT(*) AS c FROM alerts");
  if ((r[0]?.c ?? 0) !== 0) return;
  let rules: AlertRule[] = [];
  try {
    const raw = localStorage.getItem("sd_alerts_v1");
    if (raw) rules = JSON.parse(raw) as AlertRule[];
  } catch {
    /* ignore */
  }
  for (const rule of rules) {
    await d.execute(
      `INSERT OR IGNORE INTO alerts(id, code, name, up_price, down_price, up_pct, down_pct, cooldown_sec, enabled, last_fired_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        rule.id,
        rule.code,
        rule.name ?? "",
        rule.upPrice ?? null,
        rule.downPrice ?? null,
        rule.upPct ?? null,
        rule.downPct ?? null,
        rule.cooldownSec ?? 300,
        rule.enabled ? 1 : 0,
        rule.lastFiredAt ?? null,
      ]
    );
  }
}
