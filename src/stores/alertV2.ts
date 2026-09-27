// v2 预警规则 store：SQLite 持久化（alert_rule_v2）+ 触发历史（复用 alert_event）
import { defineStore } from "pinia";
import { ref } from "vue";
import { ensureDb, db } from "../db/database";
import {
  listRules,
  upsertRule,
  deleteRule,
  setEnabled,
} from "../alert/repo";
import type { AlertRuleV2 } from "../alert/types";

/** 触发历史行（alert_event） */
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

export const useAlertV2Store = defineStore("alertV2", () => {
  const rules = ref<AlertRuleV2[]>([]);
  const loaded = ref(false);
  const history = ref<AlertHistoryRow[]>([]);
  const historyLoaded = ref(false);

  async function load() {
    await ensureDb();
    rules.value = await listRules();
    loaded.value = true;
  }

  async function save(rule: AlertRuleV2) {
    rule.updatedAt = Date.now();
    await upsertRule(rule);
    const i = rules.value.findIndex((x) => x.id === rule.id);
    if (i >= 0) rules.value[i] = { ...rule };
    else rules.value.unshift({ ...rule });
  }

  async function remove(id: string) {
    await deleteRule(id);
    rules.value = rules.value.filter((r) => r.id !== id);
  }

  async function toggle(rule: AlertRuleV2) {
    rule.enabled = !rule.enabled;
    await setEnabled(rule.id, rule.enabled);
  }

  async function addEvent(params: {
    ruleId: string;
    code: string;
    name: string;
    label: string;
    message: string;
    price: number;
    pct: number;
    target: number;
    tone: string;
    now: number;
  }) {
    await db().execute(
      `INSERT INTO alert_event(rule_id,code,name,kind,label,message,price,pct,target,tone,triggered_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        params.ruleId,
        params.code,
        params.name,
        "rule",
        params.label,
        params.message,
        params.price,
        params.pct,
        params.target,
        params.tone,
        params.now,
      ]
    );
    if (historyLoaded.value) {
      history.value.unshift({
        id: params.now,
        ruleId: params.ruleId,
        code: params.code,
        name: params.name,
        kind: "rule",
        label: params.label,
        message: params.message,
        price: params.price,
        pct: params.pct,
        target: params.target,
        tone: params.tone,
        triggeredAt: params.now,
      });
    }
  }

  async function loadHistory(limit = 200) {
    await ensureDb();
    history.value = await db().select<AlertHistoryRow[]>(
      `SELECT id, rule_id AS ruleId, code, name, kind, label, message,
         price, pct, target, tone, triggered_at AS triggeredAt
       FROM alert_event ORDER BY triggered_at DESC, id DESC LIMIT ?`,
      [limit]
    );
    historyLoaded.value = true;
  }

  async function clearHistory() {
    await db().execute("DELETE FROM alert_event");
    history.value = [];
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
    addEvent,
    loadHistory,
    clearHistory,
  };
});
