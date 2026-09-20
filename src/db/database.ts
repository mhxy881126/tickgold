// SQLite 数据访问单例（tauri-plugin-sql）
// 建表迁移在 Rust 端（lib.rs）配置；这里负责连接、默认数据与一次 localStorage 迁移。
import Database from "@tauri-apps/plugin-sql";
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
}

async function seedGroups(d: Database) {
  const r = await d.select<{ c: number }[]>("SELECT COUNT(*) AS c FROM groups");
  if ((r[0]?.c ?? 0) === 0) {
    await d.execute(
      "INSERT INTO groups(name, sort_order, created_at) VALUES('我的自选', 0, ?)",
      [Date.now()]
    );
  }
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
      "INSERT INTO stocks(code, name, group_id, sort_order, created_at) VALUES(?, ?, 1, ?, ?)",
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
      `INSERT INTO alerts(id, code, name, up_price, down_price, up_pct, down_pct, cooldown_sec, enabled, last_fired_at)
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
