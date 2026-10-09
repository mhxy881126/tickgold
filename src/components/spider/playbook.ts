// 操作剧本规划器：把一张卡片内识别到的 UI 元素，编排成蜘蛛要依次执行的有序操作，
// 模拟真人交易员在卡片内的动作流：切换标签看不同维度 → 滚动加载更多 → 点重点个股看详情。
// 纯函数（不碰 document / 不执行事件），用 UiElement 作为输入，便于单测。
import type { UiElement } from "./uiGraph";

export type OpType = "tap" | "scroll-down" | "hover";
export type RescanKind = "none" | "tab" | "scroll";

export interface OpStep {
  type: OpType;
  /** 操作目标：tap/hover 为元素本身；scroll-down 为滚动容器 */
  ui: UiElement;
  /** 到达锚点 id：ProceduralSpider 在 arrived 时据此匹配并触发动作 */
  arriveId: string;
  /** 日志 / 头顶气泡文案 */
  label: string;
  /** 动作完成后等待反馈的时长（数据加载 / tab 切换 / 跳转） */
  waitMs: number;
  /** 动作后是否重新采集并续接剧本 */
  rescan: RescanKind;
}

export interface PlaybookCtx {
  /** 当前重点关注的股票代码（来自 fastbrain 信号 / 自选），点行时优先 */
  focusCode?: string | null;
  /** 已滚动加载的次数（外部状态，用于限制无限滚动） */
  scrollRounds?: number;
  /** 最多滚动加载次数，默认 2 */
  maxScrollRounds?: number;
  /** 最多切换的标签数，默认 2 */
  maxTabs?: number;
  /** 最多点开的个股数，默认 2 */
  maxRowOpens?: number;
  /** 已操作过的元素 id（rescan 续接时去重，避免重复点同一个） */
  doneIds?: Set<string>;
}

/** 生成一张卡片的操作剧本 */
export function planPlaybook(ui: UiElement[], ctx: PlaybookCtx = {}): OpStep[] {
  const steps: OpStep[] = [];
  let counter = 0;
  const nextId = (): string => `op:${counter++}`;
  const done = ctx.doneIds;
  const notDone = (u: UiElement): boolean => !done || !done.has(u.id);

  // ① 切换标签：点未激活、未点过的 tab，逐个维度浏览（每次切换后重新采集）
  const maxTabs = ctx.maxTabs ?? 2;
  const tabs = ui.filter(
    (u) => u.kind === "tab" && !u.active && !u.disabled && notDone(u),
  );
  tabs.slice(0, maxTabs).forEach((u) => {
    steps.push({
      type: "tap",
      ui: u,
      arriveId: nextId(),
      label: `切换标签「${u.text || "选项"}」`,
      waitMs: 780,
      rescan: "tab",
    });
  });

  // ② 向下滚动加载更多（取第一个仍可向下的滚动容器，受次数上限约束）
  const maxScroll = ctx.maxScrollRounds ?? 2;
  const scrollRounds = ctx.scrollRounds ?? 0;
  const scroller = ui.find(
    (u) => u.kind === "scroll" && u.scroll?.canDown && notDone(u),
  );
  if (scroller && scrollRounds < maxScroll) {
    steps.push({
      type: "scroll-down",
      ui: scroller,
      arriveId: nextId(),
      label: "向下滚动，加载更多数据",
      waitMs: 880,
      rescan: "scroll",
    });
  }

  // ③ 点重点个股：focusCode 优先，否则按涨幅 pct 取最高的行
  const maxRows = ctx.maxRowOpens ?? 2;
  const rows = ui.filter(
    (u) => u.kind === "row" && !u.disabled && notDone(u) && (u.code || u.name),
  );
  const ranked = [...rows].sort((a, b) => {
    const af = ctx.focusCode && a.code === ctx.focusCode ? 1 : 0;
    const bf = ctx.focusCode && b.code === ctx.focusCode ? 1 : 0;
    if (af !== bf) return bf - af;
    return (b.pct ?? -Infinity) - (a.pct ?? -Infinity);
  });
  ranked.slice(0, maxRows).forEach((u) => {
    const who = u.name || u.code || "条目";
    // 按行主体类型生成准确文案：个股 / 板块 / 指数 / 资讯，避免把非个股当个股点
    const label =
      u.rowKind === "stock" ? `点选个股「${who}」查看详情`
      : u.rowKind === "sector" ? `查看板块「${who}」`
      : u.rowKind === "index" ? `查看指数「${who}」`
      : u.rowKind === "info" ? `查看资讯「${who}」`
      : `查看「${who}」`;
    steps.push({
      type: "tap",
      ui: u,
      arriveId: nextId(),
      label,
      waitMs: 700,
      rescan: "none",
    });
  });

  return steps;
}

/** 便捷：统计剧本里某类 rescan 的数量（状态机做上限保护用） */
export function countRescan(steps: OpStep[], kind: RescanKind): number {
  return steps.reduce((n, s) => (s.rescan === kind ? n + 1 : n), 0);
}
