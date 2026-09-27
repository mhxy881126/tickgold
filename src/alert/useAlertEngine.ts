// v0.71 预警引擎：订阅 quotes 刷新 → 展开作用域 → 建上下文 → 评估 → 门禁 → 动作分发
import { watch } from "vue";
import { useQuotesStore } from "../stores/quotes";
import { useWatchlistStore } from "../stores/watchlist";
import { useAlertV2Store } from "../stores/alertV2";
import { ContextProvider, expandScope, collectLeaves } from "./context";
import type { RuleTarget } from "./context";
import { evalTree } from "./evaluate";
import {
  newGateState,
  checkGate,
  markGateFired,
} from "./gates";
import { fieldSpec } from "./fields";
import { playAlert } from "../utils/sound";
import { pushToast, pushIsland, navPickStock, navOpenOrderBook } from "./bus";

let started = false;
const provider = new ContextProvider();
const gates = newGateState();

function leafSummary(field: string, value: number, actual: number): string {
  const s = fieldSpec(field);
  const unit = s?.unit ?? "";
  return `${s?.label ?? field} ${value}${unit}（当前 ${format(actual)}${unit}）`;
}

function format(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** 启动引擎（幂等，全局单例） */
export function startAlertEngineV2(): void {
  if (started) return;
  started = true;

  const quotes = useQuotesStore();
  const wl = useWatchlistStore();
  const store = useAlertV2Store();

  watch(
    () => quotes.lastUpdate,
    async () => {
      if (!store.loaded || store.rules.length === 0) return;
      const now = Date.now();
      const groupCodes = (gid: number) =>
        wl.stocksOf(gid).map((s) => s.code);

      const targets: RuleTarget[] = [];
      for (const rule of store.rules) {
        if (!rule.enabled) continue;
        const codes = expandScope(rule.scope, wl.codes, groupCodes);
        if (codes.length) targets.push({ rule, codes });
      }
      if (targets.length === 0) {
        provider.commitPrev();
        return;
      }

      await provider.refresh(targets, quotes.map, now);

      for (const { rule, codes } of targets) {
        for (const code of codes) {
          const ctx = { now, code, resolve: provider.resolver(code) };
          const result = evalTree(ctx, rule.tree);
          if (!result.hit) continue;

          const gate = checkGate({ rule, now, state: gates });
          if (!gate.pass) continue;
          markGateFired(gates, rule.id, now);

          const q = quotes.map[code];
          const price = q?.price ?? result.matched[0]?.actual ?? 0;
          const pct = q?.pct ?? 0;
          const tone =
            rule.tone !== "auto"
              ? rule.tone
              : (pct >= 0 ? "up" : "down");
          const summary = result.matched
            .map((h) => leafSummary(h.leaf.field, h.leaf.value, h.actual))
            .join("，");
          const name = wl.nameOf(code) || q?.name || code;
          const message = `${name}：${summary}`;
          const target = result.matched[0]?.leaf.value ?? 0;

          await store.addEvent({
            ruleId: rule.id,
            code,
            name,
            label: rule.name,
            message,
            price,
            pct,
            target,
            tone,
            now,
          });

          dispatch(rule, {
            ruleId: rule.id, code, name, ruleName: rule.name,
            message, tone, now, price, pct,
          });
        }
      }

      provider.commitPrev();
    }
  );
}

type Fire = {
  ruleId: string;
  code: string;
  name: string;
  ruleName: string;
  message: string;
  tone: string;
  now: number;
  price: number;
  pct: number;
};

function dispatch(rule: FireRule, f: Fire): void {
  if (rule.actions.notify) {
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(`预警 · ${f.ruleName}`, { body: f.message });
      }
    } catch {
      /* ignore */
    }
  }
  if (rule.actions.sound) {
    try {
      if (localStorage.getItem("tickgold_alert_sound") !== "0") playAlert(f.tone);
    } catch {
      /* ignore */
    }
  }
  if (rule.actions.popup) {
    pushToast({
      key: `${f.ruleId}_${f.now}`,
      title: `预警 · ${f.ruleName}`,
      body: f.message,
      code: f.code,
      tone: f.tone,
      at: f.now,
    });
  }
  if (rule.actions.island) {
    pushIsland({
      id: f.ruleId, code: f.code, name: f.name, label: f.ruleName,
      message: f.message, price: f.price, pct: f.pct, tone: f.tone, at: f.now,
    });
  }
  if (rule.actions.openChart) navPickStock(f.code);
  if (rule.actions.openBook) navOpenOrderBook(f.code);
}

type FireRule = import("./types").AlertRuleV2;

// 供单测/外部访问内部件
export const __internal = { provider, gates, collectLeaves };
