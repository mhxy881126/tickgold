// 预警规则 store：SQLite 持久化 + 与后端预警引擎同步 + 触发历史
import { defineStore } from "pinia";
import { ref } from "vue";
import { ensureDb, db } from "../db/database";
import { startAlertEngine, stopAlertEngine, type AlertEvent } from "../api/market";
import type { AlertRule } from "../api/types";

interface AlertRow {
  id: string;
  code: string;
  name: string;
  upPrice: number | null;
  downPrice: number | null;
  upPct: number | null;
  downPct: number | null;
  minVolumeRatio: number | null;
  riseSpeed: number | null;
  downSpeed: number | null;
  speedWindowSec: number | null;
  minTurnover: number | null;
  minAmount: number | null;
  sealLimitUp: number | null;
  sealLimitDown: number | null;
  brokenLimit: number | null;
  cooldownSec: number;
  enabled: number;
  lastFiredAt: number | null;
}

/** 触发历史记录（alert_event 表行） */
export interface AlertHistoryRow {
  id: number;
  ruleId: string | null;
  code: string | null;
  name: string | null;
  kind: string | null;
  label: string | null;
  message: string | null;
  price: number | null;
  pct: number | null;
  target: number | null;
  tone: string | null;
  triggeredAt: number | null;
}

export function newAlertId(): string {
  return `a_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export const useAlertStore = defineStore("alert", () => {
  const rules = ref<AlertRule[]>([]);
  const loaded = ref(false);
  const history = ref<AlertHistoryRow[]>([]);
  const historyLoaded = ref(false);

  async function load() {
    await ensureDb();
    const rs = await db().select<AlertRow[]>(
      `SELECT id, code, name, up_price AS upPrice, down_price AS downPrice,
         up_pct AS upPct, down_pct AS downPct,
         min_volume_ratio AS minVolumeRatio, rise_speed AS riseSpeed,
         down_speed AS downSpeed, speed_window_sec AS speedWindowSec,
         min_turnover AS minTurnover, min_amount AS minAmount,
         seal_limit_up AS sealLimitUp, seal_limit_down AS sealLimitDown,
         broken_limit AS brokenLimit,
         cooldown_sec AS cooldownSec, enabled, last_fired_at AS lastFiredAt
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
      minVolumeRatio: r.minVolumeRatio ?? undefined,
      riseSpeed: r.riseSpeed ?? undefined,
      downSpeed: r.downSpeed ?? undefined,
      speedWindowSec: r.speedWindowSec ?? undefined,
      minTurnover: r.minTurnover ?? undefined,
      minAmount: r.minAmount ?? undefined,
      sealLimitUp: r.sealLimitUp != null ? !!r.sealLimitUp : undefined,
      sealLimitDown: r.sealLimitDown != null ? !!r.sealLimitDown : undefined,
      brokenLimit: r.brokenLimit != null ? !!r.brokenLimit : undefined,
      cooldownSec: r.cooldownSec ?? 300,
      enabled: !!r.enabled,
      lastFiredAt: r.lastFiredAt ?? undefined,
    }));
    loaded.value = true;
  }

  async function save(r: AlertRule) {
    const exists = rules.value.some((x) => x.id === r.id);
    await db().execute(
      `INSERT INTO alerts(id,code,name,up_price,down_price,up_pct,down_pct,
         min_volume_ratio,rise_speed,down_speed,speed_window_sec,
         min_turnover,min_amount,seal_limit_up,seal_limit_down,broken_limit,
         cooldown_sec,enabled,last_fired_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name,
         up_price=excluded.up_price, down_price=excluded.down_price,
         up_pct=excluded.up_pct, down_pct=excluded.down_pct,
         min_volume_ratio=excluded.min_volume_ratio, rise_speed=excluded.rise_speed,
         down_speed=excluded.down_speed, speed_window_sec=excluded.speed_window_sec,
         min_turnover=excluded.min_turnover, min_amount=excluded.min_amount,
         seal_limit_up=excluded.seal_limit_up, seal_limit_down=excluded.seal_limit_down,
         broken_limit=excluded.broken_limit,
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
        r.minVolumeRatio ?? null,
        r.riseSpeed ?? null,
        r.downSpeed ?? null,
        r.speedWindowSec ?? null,
        r.minTurnover ?? null,
        r.minAmount ?? null,
        r.sealLimitUp ? 1 : null,
        r.sealLimitDown ? 1 : null,
        r.brokenLimit ? 1 : null,
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

  // ===== 触发历史（alert_event）=====
  /** 触发事件写入历史（由事件监听调用） */
  async function addEvent(ev: AlertEvent) {
    await db().execute(
      `INSERT INTO alert_event(rule_id,code,name,kind,label,message,price,pct,target,tone,triggered_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ev.id,
        ev.code,
        ev.name,
        ev.kind,
        ev.label,
        ev.message,
        ev.price,
        ev.pct,
        ev.target,
        ev.tone,
        ev.time,
      ]
    );
    if (historyLoaded.value) {
      history.value.unshift({
        id: Date.now(),
        ruleId: ev.id,
        code: ev.code,
        name: ev.name,
        kind: ev.kind,
        label: ev.label,
        message: ev.message,
        price: ev.price,
        pct: ev.pct,
        target: ev.target,
        tone: ev.tone,
        triggeredAt: ev.time,
      });
    }
  }

  async function loadHistory(limit = 200) {
    await ensureDb();
    const rs = await db().select<AlertHistoryRow[]>(
      `SELECT id, rule_id AS ruleId, code, name, kind, label, message,
         price, pct, target, tone, triggered_at AS triggeredAt
       FROM alert_event ORDER BY triggered_at DESC, id DESC LIMIT ?`,
      [limit]
    );
    history.value = rs;
    historyLoaded.value = true;
  }

  async function clearHistory() {
    await db().execute("DELETE FROM alert_event");
    history.value = [];
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

  return {
    rules,
    loaded,
    history,
    historyLoaded,
    load,
    save,
    remove,
    toggle,
    markFired,
    addEvent,
    loadHistory,
    clearHistory,
    syncEngine,
  };
});
