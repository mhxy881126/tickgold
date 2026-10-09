// CutDirector 分幕切卡导演：把一次切卡编排为三幕，替代旧的一次性 resetPath。
//   ACT1 离场：旧卡最后扫描点 → 沿旧卡边框走到出口（旧卡已扫完，全 via 不再发光）
//   ACT2 穿行：沿骨架路网逐段移动；路过其他卡片标题时「快速一瞟」(短 glide，非 via)
//   ACT3 入场：沿新卡边框/标题栏进入 → 标题中点总览扫描（非 via），结束即 act3:ready
// 纯逻辑模块：坐标来自 graph 节点，不碰 DOM；渲染层按 acts 顺序逐幕 resetPath。

import type { Vec2 } from "./ik";
import type { Anchor } from "./anchors";
import { findPath, type FrameGraph, type GraphNode } from "./graph";
import type { ScanPoint } from "./sim";
import type { CardId } from "../../lib/cards";

export type ActName = "act1" | "act2" | "act3";

export interface Act {
  name: ActName;
  points: ScanPoint[];
}

export interface CutPlan {
  acts: Act[];
  /** 路过标题节点 id → 被路过卡片 id：蜘蛛到达该点时触发导航脉冲 / 标题轻亮 */
  glideAt: Map<string, string>;
}

export interface PlanCutOpts {
  graph: FrameGraph;
  /** 蜘蛛当前位置（旧卡最后扫描点） */
  from: Vec2;
  targetCardId: CardId;
  /** 新卡标题中点坐标（graph 中 `${cardId}:hm`） */
  entry: Vec2;
  currentCardId?: string | null;
}

/** 路过其他卡片标题的快速一瞟时长 */
export const QUICK_GLIDE_MS = 260;
/** 目标卡标题中点总览扫描时长 */
export const OVERVIEW_GLIDE_MS = 720;

/** 非结构节点 anchor（corner/edge/gap/lane），无尺寸 */
function nodeAnchor(n: GraphNode): Anchor {
  return {
    id: n.id,
    cardId: n.cardId ?? "structure",
    x: n.x,
    y: n.y,
    width: 0,
    height: 0,
    kind: "card-center",
  };
}

/** 标题节点 anchor：还原完整标题栏（左缘 x + 宽度 + 高度），供扫描光束覆盖整个标题 */
function headAnchor(n: GraphNode, g: FrameGraph): Anchor {
  const card = n.cardId ?? "structure";
  const find = (k: string) => g.nodes.find((x) => x.id === `${card}:${k}`);
  const hl = find("hl");
  const hr = find("hr");
  const tm = find("tm");
  const left = hl?.x ?? n.x;
  const width = hl && hr ? hr.x - hl.x : 0;
  const height = tm ? Math.max(20, (n.y - tm.y) * 2) : 32;
  return { id: n.id, cardId: card, x: left, y: n.y, width, height, kind: "header", name: "标题栏" };
}

function mkAnchor(n: GraphNode, g: FrameGraph): Anchor {
  return n.kind === "head" ? headAnchor(n, g) : nodeAnchor(n);
}

function viaPoint(n: GraphNode, g: FrameGraph): ScanPoint {
  return { x: n.x, y: n.y, anchor: mkAnchor(n, g), signal: null, via: true };
}

export function planCut(opts: PlanCutOpts): CutPlan {
  const { graph, from, targetCardId, entry, currentCardId } = opts;
  const t = String(targetCardId);

  const seq = findPath(graph, from, entry);
  const glideAt = new Map<string, string>();

  // 第一个目标卡节点（ACT3 起点）
  let tIdx = seq.findIndex((n) => n.cardId === t);
  if (tIdx === -1) tIdx = seq.length;

  // 旧卡在 [0,tIdx) 内的最后一个节点（ACT1 出口）
  let cIdx = -1;
  if (currentCardId) {
    for (let i = 0; i < tIdx; i++) {
      if (seq[i].cardId === currentCardId) cIdx = i;
    }
  }

  const act1Nodes = currentCardId ? seq.slice(0, cIdx + 1) : [];
  const act2Nodes = seq.slice(cIdx + 1, tIdx);
  const act3Nodes = seq.slice(tIdx);

  // ACT1：沿旧卡边框离场，全 via（不发光、不扫描）
  const act1: Act = { name: "act1", points: act1Nodes.map((n) => viaPoint(n, graph)) };

  // ACT2：结构节点 via；路过的其他卡标题 → 非 via 快速一瞟
  const act2: Act = {
    name: "act2",
    points: act2Nodes.map((n) => {
      if (n.kind === "head" && n.cardId && n.cardId !== t) {
        glideAt.set(n.id, n.cardId);
        return {
          x: n.x, y: n.y, anchor: headAnchor(n, graph), signal: null,
          glideMs: QUICK_GLIDE_MS,
        };
      }
      return viaPoint(n, graph);
    }),
  };

  // ACT3：沿新卡边框/标题入场；末尾标题中点 hm 非 via 做总览
  const act3: Act = {
    name: "act3",
    points: act3Nodes.map((n, i) => {
      const isLast = i === act3Nodes.length - 1;
      if (isLast && n.kind === "head") {
        return {
          x: n.x, y: n.y, anchor: headAnchor(n, graph), signal: null,
          glideMs: OVERVIEW_GLIDE_MS,
        };
      }
      return viaPoint(n, graph);
    }),
  };

  return { acts: [act1, act2, act3], glideAt };
}
