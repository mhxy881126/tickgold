// 预警规则 store：SQLite 持久化 + 与后端预警引擎同步
import { defineStore } from "pinia";
import { ref } from "vue";
import { ensureDb, db } from "../db/database";
import { startAlertEngine, stopAlertEngine } from "../api/market";
import type { AlertRule } from "../api/types";

interface AlertRow {
  id: string;
  code: string;
  name: string;
  upPrice: number | null;
  downPrice: number | null;
  upPct: number | null;
  downPct: number | null;
  cooldownSec: number;
  enabled: number;
  lastFiredAt: number | null;
}

export function newAlertId(): string {
  return `a_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export const useAlertStore = defineStore("alert", () => {
  const rules = ref<AlertRule[]>([]);
  const loaded = ref(false);

  async function load() {
    await ensureDb();
    const rs = await db().select<AlertRow[]>(
      `SELECT id, code, name, up_price AS upPrice, down_price AS downPrice,
         up_pct AS upPct, down_pct AS downPct, cooldown_sec AS cooldownSec,
         enabled, last_fired_at AS lastFiredAt
       FROM alerts ORDER BY code, id`
    );
    rules.value = rs.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      upPrice: r.upPrice ?? undefined,
      downPrice: r.downPrice ?? undefined,
      upPct: r.upPct ?? undefined,
      downPct: r.downPct ?? undefined,
      cooldownSec: r.cooldownSec ?? 300,
      enabled: !!r.enabled,
      lastFiredAt: r.lastFiredAt ?? undefined,
    }));
    loaded.value = true;
  }

  async function save(r: AlertRule) {
    const exists = rules.value.some((x) => x.id === r.id);
    await db().execute(
      `INSERT INTO alerts(id,code,name,up_price,down_price,up_pct,down_pct,cooldown_sec,enabled,last_fired_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name,
         up_price=excluded.up_price, down_price=excluded.down_price,
         up_pct=excluded.up_pct, down_pct=excluded.down_pct,
         cooldown_sec=excluded.cooldown_sec, enabled=excluded.enabled,
         last_fired_at=excluded.last_fired_at`,
      [
        r.id,
        r.code,
        r.name,
        r.upPrice ?? null,
        r.downPrice ?? null,
        r.upPct ?? null,
        r.downPct ?? null,
        r.cooldownSec,
        r.enabled ? 1 : 0,
        r.lastFiredAt ?? null,
      ]
    );
    if (exists) {
      const i = rules.value.findIndex((x) => x.id === r.id);
      rules.value[i] = { ...r };
    } else {
      rules.value.push({ ...r });
    }
    await syncEngine();
  }

  async function remove(id: string) {
    await db().execute("DELETE FROM alerts WHERE id=?", [id]);
    rules.value = rules.value.filter((r) => r.id !== id);
    await syncEngine();
  }

  async function toggle(r: AlertRule) {
    r.enabled = !r.enabled;
    await db().execute("UPDATE alerts SET enabled=? WHERE id=?", [
      r.enabled ? 1 : 0,
      r.id,
    ]);
    await syncEngine();
  }

  /** 触发后记录时间（由事件监听调用） */
  async function markFired(id: string, time: number) {
    const r = rules.value.find((x) => x.id === id);
    if (r) r.lastFiredAt = time;
    await db().execute("UPDATE alerts SET last_fired_at=? WHERE id=?", [time, id]);
  }

  /** 有启用规则则下发引擎，否则停止 */
  async function syncEngine() {
    const active = rules.value.filter((r) => r.enabled);
    if (active.length > 0) {
      await startAlertEngine(active);
    } else {
      await stopAlertEngine();
    }
  }

  return { rules, loaded, load, save, remove, toggle, markFired, syncEngine };
});
