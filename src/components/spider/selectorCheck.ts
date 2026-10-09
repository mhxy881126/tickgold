// 选择器自检：开发模式下检测「已打开卡片」的行/标题选择器与 extract 是否失效。
// 目的：卡片 DOM 改版后蜘蛛采不到行时，能在 spiderbot 面板直接看到告警，而不是默默不动。
// 纯检测逻辑放在这里，角标 UI 在 SpiderBot.vue。
import { CARD_ANCHOR_CONFIGS } from "./anchors";

export type SelectorIssueKind = "no-row" | "extract-empty";

export interface SelectorIssue {
  cardId: string;
  kind: SelectorIssueKind;
  message: string;
}

/**
 * 对当前「已打开」的卡片做一次选择器自检，返回问题清单（纯检测，不碰告警 UI）。
 * - 卡片未打开（无 [data-card-id] 根）→ 跳过，避免对未挂载卡片误报
 * - 卡片已开但行与标题都匹配不到 → no-row（选择器失效）
 * - 采到行但 extract 提不出 code/name → extract-empty（字段 class 已改）
 */
export function runSelectorCheck(): SelectorIssue[] {
  if (typeof document === "undefined") return [];

  const issues: SelectorIssue[] = [];

  for (const cardId of Object.keys(CARD_ANCHOR_CONFIGS)) {
    const cfg = CARD_ANCHOR_CONFIGS[cardId];
    const root = document.querySelector(`[data-card-id="${cardId}"]`);
    if (!root) continue; // 卡片未打开：不校验

    let rows: NodeListOf<Element>;
    let headers: NodeListOf<Element>;
    try {
      rows = document.querySelectorAll(cfg.rowSel);
      headers = document.querySelectorAll(cfg.headerSel);
    } catch {
      // 选择器本身语法非法
      issues.push({ cardId, kind: "no-row", message: `选择器语法非法：${cfg.rowSel}` });
      continue;
    }

    if (rows.length === 0) {
      // 连标题栏都采不到，才判定为失效；标题在而行不在，多为空卡 / 未加载，不判失效
      if (headers.length === 0) {
        issues.push({
          cardId,
          kind: "no-row",
          message: `卡片已打开，但行「${cfg.rowSel}」与标题「${cfg.headerSel}」都匹配不到元素`,
        });
      }
      continue;
    }

    // 抽查前 3 行 extract；若全部 code/name 皆空，说明字段选择器失效
    const sample = Array.from(rows).slice(0, Math.min(3, rows.length));
    const allEmpty = sample.every((el) => {
      const d = cfg.extract(el);
      return !d.code && !d.name;
    });
    if (allEmpty) {
      issues.push({
        cardId,
        kind: "extract-empty",
        message: `采到 ${rows.length} 行，但 extract 提取不到 code/name（字段 class 可能已改）`,
      });
    }
  }

  return issues;
}

/**
 * 启动周期自检（仅开发模式生效；生产构建返回空操作）。
 * 结果指纹变化时才回调，避免无谓刷新。返回 stop()，组件卸载时调用。
 */
export function startSelectorCheck(
  onIssues: (issues: SelectorIssue[]) => void,
  intervalMs = 4000,
): () => void {
  if (!import.meta.env.DEV) return () => {};
  if (typeof window === "undefined") return () => {};

  let lastKey = "";
  const tick = () => {
    const issues = runSelectorCheck();
    const key = issues.map((i) => `${i.cardId}:${i.kind}`).join("|");
    if (key !== lastKey) {
      lastKey = key;
      onIssues(issues);
    }
  };

  const first = window.setTimeout(tick, 800); // 等卡片首轮渲染
  const timer = window.setInterval(tick, intervalMs);

  return () => {
    window.clearTimeout(first);
    window.clearInterval(timer);
  };
}
