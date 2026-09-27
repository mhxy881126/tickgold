// v2 规则仓储：SQLite alert_rule_v2 表的建表、CRUD 与旧规则迁移
import type Database from "@tauri-apps/plugin-sql";
import { db } from "../db/database";
import type { AlertRuleV2 } from "./types";
import { newId, newRuleId, type Leaf, type TreeNode } from "./types";

interface RuleRow {
  id: string;
  name: string;
  scope_json: string;
  tree_json: string;
  actions_json: string;
  schedule_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
  last_fired_at: number | null;
}

/** 建表（幂等）。由 ensureDb 初始化阶段调用。 */
export async function ensureAlertV2(d: Database): Promise<void> {
  await d.execute(
    `CREATE TABLE IF NOT EXISTS alert_rule_v2(
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       scope_json TEXT NOT NULL,
       tree_json TEXT NOT NULL,
       actions_json TEXT NOT NULL,
       schedule_json TEXT NOT NULL,
       enabled INTEGER NOT NULL DEFAULT 1,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       last_fired_at INTEGER
     )`
  );
  await migrateLegacy(d);
}

/** 旧 alerts（固定字段）→ v2 条件树，一次性 */
async function migrateLegacy(d: Database): Promise<void> {
  let done = false;
  try {
    done = localStorage.getItem("sd_alert_v2_migrated") === "1";
  } catch {
    /* ignore */
  }
  if (done) return;

  const already = await d.select<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM alert_rule_v2"
  );
  const hasV2 = (already[0]?.c ?? 0) > 0;

  if (!hasV2) {
    let rows: LegacyRow[] = [];
    try {
      rows = await d.select<LegacyRow[]>(`SELECT * FROM alerts`);
    } catch {
      rows = [];
    }
    for (const r of rows) {
      const rule = legacyToV2(r);
      if (rule) await insert(d, rule);
    }
  }

  try {
    localStorage.setItem("sd_alert_v2_migrated", "1");
  } catch {
    /* ignore */
  }
}

interface LegacyRow {
  id: string;
  code: string;
  name: string;
  up_price: number | null;
  down_price: number | null;
  up_pct: number | null;
  down_pct: number | null;
  min_volume_ratio: number | null;
  rise_speed: number | null;
  down_speed: number | null;
  speed_window_sec: number | null;
  min_turnover: number | null;
  min_amount: number | null;
  seal_limit_up: number | null;
  seal_limit_down: number | null;
  broken_limit: number | null;
  cooldown_sec: number | null;
  enabled: number | null;
}

function leaf(
  field: string,
  op: Leaf["op"],
  value: number,
  params?: Record<string, number>
): Leaf {
  return { id: newId("l"), field, op, value, params };
}

/** 旧规则行 → v2（无任何条件则返回 null） */
export function legacyToV2(r: LegacyRow): AlertRuleV2 | null {
  const win = r.speed_window_sec ?? 300;
  const children: Leaf[] = [];
  if (r.up_price != null) children.push(leaf("price", "crossUp", r.up_price));
  if (r.down_price != null) children.push(leaf("price", "crossDown", r.down_price));
  if (r.up_pct != null) children.push(leaf("pct", ">=", r.up_pct));
  if (r.down_pct != null) children.push(leaf("pct", "<=", r.down_pct));
  if (r.min_volume_ratio != null)
    children.push(leaf("volumeRatio", ">=", r.min_volume_ratio));
  if (r.rise_speed != null)
    children.push(leaf("speedPct", ">=", r.rise_speed, { windowSec: win }));
  if (r.down_speed != null)
    children.push(leaf("speedPct", "<=", -r.down_speed, { windowSec: win }));
  if (r.min_turnover != null) children.push(leaf("turnover", ">=", r.min_turnover));
  if (r.min_amount != null) children.push(leaf("amountYi", ">=", r.min_amount));
  if (r.seal_limit_up != null) children.push(leaf("evt.sealUp", ">=", 1));
  if (r.seal_limit_down != null) children.push(leaf("evt.sealDn", ">=", 1));
  if (r.broken_limit != null) children.push(leaf("evt.broken", ">=", 1));
  if (children.length === 0) return null;

  const now = Date.now();
  const tree: TreeNode = { id: newId("n"), op: "AND", children };
  return {
    id: r.id || newRuleId(),
    name: r.name || `${r.code} 预警`,
    scope: { kind: "code", code: r.code },
    tree,
    actions: {
      notify: true,
      sound: true,
      popup: false,
      island: true,
      openChart: false,
      openBook: false,
    },
    tone: "auto",
    frequency: "persistent",
    cooldownSec: r.cooldown_sec ?? 300,
    quiet: [],
    enabled: r.enabled == null ? true : !!r.enabled,
    createdAt: now,
    updatedAt: now,
  };
}

function rowToRule(r: RuleRow): AlertRuleV2 {
  const schedule = JSON.parse(r.schedule_json) as Pick<
    AlertRuleV2,
    "tone" | "frequency" | "cooldownSec" | "quiet"
  >;
  return {
    id: r.id,
    name: r.name,
    scope: JSON.parse(r.scope_json),
    tree: JSON.parse(r.tree_json),
    actions: JSON.parse(r.actions_json),
    tone: schedule.tone,
    frequency: schedule.frequency,
    cooldownSec: schedule.cooldownSec,
    quiet: schedule.quiet,
    enabled: !!r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastFiredAt: r.last_fired_at ?? undefined,
  };
}

async function insert(d: Database, rule: AlertRuleV2): Promise<void> {
  await d.execute(
    `INSERT INTO alert_rule_v2(id,name,scope_json,tree_json,actions_json,
       schedule_json,enabled,created_at,updated_at,last_fired_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [
      rule.id,
      rule.name,
      JSON.stringify(rule.scope),
      JSON.stringify(rule.tree),
      JSON.stringify(rule.actions),
      JSON.stringify({
        tone: rule.tone,
        frequency: rule.frequency,
        cooldownSec: rule.cooldownSec,
        quiet: rule.quiet,
      }),
      rule.enabled ? 1 : 0,
      rule.createdAt,
      rule.updatedAt,
      rule.lastFiredAt ?? null,
    ]
  );
}

// ===== 对外 CRUD（用已初始化的默认连接）=====

export async function listRules(): Promise<AlertRuleV2[]> {
  const rs = await db().select<RuleRow[]>(
    "SELECT * FROM alert_rule_v2 ORDER BY created_at DESC, id DESC"
  );
  return rs.map(rowToRule);
}

export async function upsertRule(rule: AlertRuleV2): Promise<void> {
  await db().execute("DELETE FROM alert_rule_v2 WHERE id=?", [rule.id]);
  await insert(db(), rule);
}

export async function deleteRule(id: string): Promise<void> {
  await db().execute("DELETE FROM alert_rule_v2 WHERE id=?", [id]);
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  await db().execute(
    "UPDATE alert_rule_v2 SET enabled=?, updated_at=? WHERE id=?",
    [enabled ? 1 : 0, Date.now(), id]
  );
}

export async function setLastFired(id: string, time: number): Promise<void> {
  await db().execute("UPDATE alert_rule_v2 SET last_fired_at=? WHERE id=?", [
    time,
    id,
  ]);
}
