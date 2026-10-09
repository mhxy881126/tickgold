// SQLite 数据访问单例（tauri-plugin-sql）
// 建表迁移在 Rust 端（lib.rs）配置；这里负责连接、默认数据与一次 localStorage 迁移。
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import type { AlertRule } from "../api/types";
import { ensureAlertV2 } from "../alert/repo";
import { seedStrategyProfiles } from "../lib/strategySeed";

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
    // 必须先赋值 instance，否则 seedStrategyProfiles() 内部 db() 会因 instance 为空抛错，
    // 该错误会被外层 catch 捕获 → 触发 restore_latest_backup → relaunch 无限重启循环。
    instance = d;
    await ensureTables(d);
    await seedGroups(d);
    await seedStocks(d);
    await seedAlerts(d);
    await ensureAlertV2(d);
    // 策略 profile 表 + 内置 seed（幂等）
    await seedStrategyProfiles();
    // 迁移完成后清理旧的 localStorage
    try {
      localStorage.removeItem("sd_watchlist_v1");
      localStorage.removeItem("sd_alerts_v1");
    } catch {
      /* ignore */
    }
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

/** 确保所有应用表存在（策略库、模拟交易等） */
async function ensureTables(d: Database) {
  // 策略 profile 表（版本化，key + version 唯一）
  await d.execute(`
    CREATE TABLE IF NOT EXISTS strategy_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      builtin INTEGER NOT NULL DEFAULT 0,
      is_current INTEGER NOT NULL DEFAULT 1,
      spec TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      parent_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await d.execute(`
    CREATE INDEX IF NOT EXISTS idx_strategy_profile_key ON strategy_profile(key)
  `);
  await d.execute(`
    CREATE INDEX IF NOT EXISTS idx_strategy_profile_current ON strategy_profile(is_current)
  `);

  // 模拟交易账户表
  await d.execute(`
    CREATE TABLE IF NOT EXISTS paper_account (
      id INTEGER PRIMARY KEY,
      init_cash REAL NOT NULL,
      cash REAL NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // 模拟交易持仓表
  await d.execute(`
    CREATE TABLE IF NOT EXISTS paper_position (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      vol INTEGER NOT NULL,
      avail_vol INTEGER NOT NULL,
      cost_amount REAL NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // 模拟交易委托表
  await d.execute(`
    CREATE TABLE IF NOT EXISTS paper_order (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      vol INTEGER NOT NULL,
      amount REAL NOT NULL,
      fee REAL NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      trade_date TEXT NOT NULL
    )
  `);
  await d.execute(`
    CREATE INDEX IF NOT EXISTS idx_paper_order_date ON paper_order(trade_date)
  `);
  await d.execute(`
    CREATE INDEX IF NOT EXISTS idx_paper_order_created ON paper_order(created_at)
  `);
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
