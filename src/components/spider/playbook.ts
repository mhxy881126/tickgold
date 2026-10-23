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

/**
 * 生成一张卡片的操作剧本
 *
 * 【AI交易助理改版】彻底废弃"蜘蛛到处点卡片、切标签、滚动"的仿真动作。
 * 真正的量化交易助理直接在后台分析数据，不操作 UI，因此始终返回空剧本。
 * 保留函数签名与导出，避免 ProceduralSpider 等调用方报错。
 */
export function planPlaybook(_ui: UiElement[], _ctx: PlaybookCtx = {}): OpStep[] {
  return [];
}

/** 便捷：统计剧本里某类 rescan 的数量（状态机做上限保护用） */
export function countRescan(steps: OpStep[], kind: RescanKind): number {
  return steps.reduce((n, s) => (s.rescan === kind ? n + 1 : n), 0);
}
