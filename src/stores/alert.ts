import { defineStore } from "pinia";
import { ref } from "vue";
import { ensureDb, db } from "../db/database";
import type { AlertRule, Quote } from "../api/types";
import {
  sendNotification,
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

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

/** 预警引擎：规则存 SQLite，行情更新时检查，去抖 + 冷却 */
export const useAlertStore = defineStore("alert", () => {
  const rules = ref<AlertRule[]>([]);
  const firedLog = ref<string[]>([]); // 最近触发记录

  async function load() {
    await ensureDb();
    const rows = await db().select<AlertRow[]>(
      `SELECT id, code, name,
              up_price AS upPrice, down_price AS downPrice,
              up_pct AS upPct, down_pct AS downPct,
              cooldown_sec AS cooldownSec, enabled,
              last_fired_at AS lastFiredAt
       FROM alerts ORDER BY rowid`
    );
    rules.value = rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      upPrice: r.upPrice ?? undefined,
      downPrice: r.downPrice ?? undefined,
      upPct: r.upPct ?? undefined,
      downPct: r.downPct ?? undefined,
      cooldownSec: r.cooldownSec,
      enabled: r.enabled === 1,
      lastFiredAt: r.lastFiredAt ?? undefined,
    }));
  }

  async function add(rule: Omit<AlertRule, "id">) {
    const id = crypto.randomUUID();
    const full: AlertRule = { ...rule, id };
    await db().execute(
      `INSERT INTO alerts(id, code, name, up_price, down_price, up_pct, down_pct, cooldown_sec, enabled, last_fired_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        full.code,
        full.name ?? "",
        full.upPrice ?? null,
        full.downPrice ?? null,
        full.upPct ?? null,
        full.downPct ?? null,
        full.cooldownSec ?? 300,
        full.enabled ? 1 : 0,
        full.lastFiredAt ?? null,
      ]
    );
    rules.value.push(full);
  }

  async function remove(id: string) {
    await db().execute("DELETE FROM alerts WHERE id=?", [id]);
    rules.value = rules.value.filter((r) => r.id !== id);
  }

  async function toggle(id: string) {
    const r = rules.value.find((x) => x.id === id);
    if (!r) return;
    r.enabled = !r.enabled;
    await db().execute("UPDATE alerts SET enabled=? WHERE id=?", [r.enabled ? 1 : 0, id]);
  }

  /** 每次行情 tick 后调用：检查所有启用规则 */
  async function evaluate(quotes: Record<string, Quote>) {
    const now = Date.now();
    for (const rule of rules.value) {
      if (!rule.enabled) continue;
      const q = quotes[rule.code];
      if (!q) continue;
      // 行情陈旧（>15s）不触发，避免误报
      if (now - q.time > 15_000) continue;

      let hit: string | null = null;
      if (rule.upPrice != null && q.price >= rule.upPrice && q.prevClose < rule.upPrice)
        hit = `上穿 ${rule.upPrice}`;
      else if (rule.downPrice != null && q.price <= rule.downPrice && q.prevClose > rule.downPrice)
        hit = `下穿 ${rule.downPrice}`;
      else if (rule.upPct != null && q.pct >= rule.upPct) hit = `涨幅达 ${rule.upPct}%`;
      else if (rule.downPct != null && q.pct <= rule.downPct) hit = `跌幅达 ${rule.downPct}%`;

      if (hit) {
        const cd = rule.cooldownSec * 1000;
        if (rule.lastFiredAt && now - rule.lastFiredAt < cd) continue;
        rule.lastFiredAt = now;
        await db().execute("UPDATE alerts SET last_fired_at=? WHERE id=?", [now, rule.id]);
        firedLog.value.unshift(
          `[${new Date(now).toLocaleTimeString()}] ${q.name}(${q.code}) ${hit}`
        );
        if (firedLog.value.length > 50) firedLog.value.pop();
        notify(q, hit);
      }
    }
  }

  async function notify(q: Quote, hit: string) {
    const body = `${q.name} ${q.price} (${q.pct.toFixed(2)}%) ${hit}`;
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        const p = await requestPermission();
        granted = p === "granted";
      }
      if (granted) await sendNotification({ title: "灵动盯盘预警", body });
    } catch {
      try {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("灵动盯盘预警", { body });
        }
      } catch (e) {
        console.warn(e);
      }
    }
    console.log("[ALERT]", body);
  }

  return { rules, firedLog, load, add, remove, toggle, evaluate };
});
