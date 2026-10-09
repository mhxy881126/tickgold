// 卡片骨架路网 CardFrameGraph：把工作台视为一张由「可爬行结构」组成的图。
// 跨卡路径在图上用 A* 求解，路径点全部落在结构（标题栏 / 边框 / 间隙走廊 / 屏幕边车道）上，
// 数据区（卡片内部）不产生任何边，因此路径不会「空中飞行」或穿过卡片内容。
// 纯函数 + 纯几何：不碰 document，Node 环境可单测。

export type NodeKind = "corner" | "head" | "edge-mid" | "gap" | "lane";

export interface GraphNode {
  id: string;
  x: number;
  y: number;
  kind: NodeKind;
  cardId?: string;
}

export interface GraphEdge {
  a: string;
  b: string;
  /** 边权：长度 + 转角/非结构惩罚 */
  w: number;
  /** 是否为结构边（标题栏/边框/间隙）；屏幕兜底边为 false */
  structural: boolean;
}

export interface FrameGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** 卡片布局矩形（由 getBoundingClientRect 得到后传入） */
export interface CardRect {
  cardId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 标题栏高度（默认 32） */
  headHeight?: number;
}

export interface ViewSize {
  w: number;
  h: number;
}

// ===== 调参常量（单测引用）=====
export const GAP_MIN = 30; // 间隙走廊最小间距（约蜘蛛含腿半宽）
export const GAP_MAX = 190; // 间隙走廊最大间距（超过则视为跨空白，不直连）
export const GAP_PER_CARD_PAIR = 2; // 每对卡片最多保留几条间隙
export const LANE_PAD = 18; // 屏幕兜底车道距屏幕边内缩
export const LANE_PENALTY = 620; // 非结构兜底边附加权重（鼓励走结构）
export const TURN_PENALTY = 42; // 转一个陡角的附加权重
export const TURN_COS = 0.5; // 夹角余弦阈值（≈60°）：低于此值视为陡角
export const CARD_TO_LANE_MAX = 280; // 卡片角点连到屏幕车道的最大距离
const HEAD_INSET = 6; // 标题栏端点距卡片左右边内缩

// ===== 基础几何 =====
interface Pt {
  x: number;
  y: number;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

interface Rect {
  x: number;
  y: number;
  r: number;
  b: number;
}

function toRect(c: CardRect): Rect {
  return { x: c.x, y: c.y, r: c.x + c.width, b: c.y + c.height };
}

/** 点是否严格在矩形内部（不含边界） */
function pointInRectStrict(p: Pt, rc: Rect): boolean {
  return p.x > rc.x && p.x < rc.r && p.y > rc.y && p.y < rc.b;
}

/**
 * 线段 p→q 是否穿过矩形 rc（数据区）：
 * 端点严格在内部，或线段与矩形四边相交。贴边框经过（仅边界接触）不算穿越。
 */
function segmentCrossesRect(p: Pt, q: Pt, rc: Rect): boolean {
  if (pointInRectStrict(p, rc) || pointInRectStrict(q, rc)) return true;
  const tl = { x: rc.x, y: rc.y };
  const tr = { x: rc.r, y: rc.y };
  const br = { x: rc.r, y: rc.b };
  const bl = { x: rc.x, y: rc.b };
  // 仅当出现「横跨」（proper crossing）才算；端点相接（贴边）不算
  return properCross(p, q, tl, tr) || properCross(p, q, tr, br)
    || properCross(p, q, br, bl) || properCross(p, q, bl, tl);
}

/** 严格横跨（不含端点相接），用于判定穿越数据区 */
function properCross(p: Pt, q: Pt, a: Pt, b: Pt): boolean {
  const d1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const d2 = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
  const d3 = (q.x - p.x) * (a.y - p.y) - (q.y - p.y) * (a.x - p.x);
  const d4 = (q.x - p.x) * (b.y - p.y) - (q.y - p.y) * (b.x - p.x);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 线段 p→q 是否被任意卡片（除 ignore 集合）的数据区阻挡 */
function blockedByAnyCard(p: Pt, q: Pt, rects: Rect[], ignore: Set<number>): boolean {
  for (let i = 0; i < rects.length; i++) {
    if (ignore.has(i)) continue;
    if (segmentCrossesRect(p, q, rects[i])) return true;
  }
  return false;
}

// ===== 图构建 =====
export function buildFrameGraph(cardRects: CardRect[], vp: ViewSize): FrameGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const rects = cardRects.map(toRect);

  const nodeById = new Map<string, GraphNode>();
  const addNode = (n: GraphNode): GraphNode => {
    const ex = nodeById.get(n.id);
    if (ex) return ex;
    nodes.push(n);
    nodeById.set(n.id, n);
    return n;
  };
  const addEdge = (a: string, b: string, structural: boolean, extra = 0): void => {
    if (a === b) return;
    const na = nodeById.get(a);
    const nb = nodeById.get(b);
    if (!na || !nb) return;
    // 去重（无向）
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ a, b, w: dist(na, nb) + extra, structural });
  };
  const edgeKeys = new Set<string>();

  // 每张卡片的「对外节点」id（角 + 边中点 + 标题端点），用于间隙/车道连接
  const portIds: string[][] = [];

  cardRects.forEach((c, ci) => {
    const { x, y } = c;
    const w = c.width;
    const h = c.height;
    const hh = c.headHeight ?? 32;
    const id = c.cardId;
    const yh = y + Math.min(hh, h * 0.6) / 2;

    const P = {
      tl: { x, y },
      tr: { x: x + w, y },
      br: { x: x + w, y: y + h },
      bl: { x, y: y + h },
      tm: { x: x + w / 2, y },
      rm: { x: x + w, y: y + h / 2 },
      bm: { x: x + w / 2, y: y + h },
      lm: { x, y: y + h / 2 },
      hl: { x: x + HEAD_INSET, y: yh },
      hr: { x: x + w - HEAD_INSET, y: yh },
      hm: { x: x + w / 2, y: yh },
    };

    const nid = (k: string) => `${id}:${k}`;
    (Object.keys(P) as Array<keyof typeof P>).forEach((k) => {
      const kind: NodeKind = k === "hl" || k === "hr" || k === "hm" ? "head"
        : k === "tl" || k === "tr" || k === "br" || k === "bl" ? "corner"
          : "edge-mid";
      addNode({ id: nid(k), x: P[k].x, y: P[k].y, kind, cardId: id });
    });

    // 标题栏中线
    addEdge(nid("hl"), nid("hm"), true);
    addEdge(nid("hm"), nid("hr"), true);
    // 顶部边框中点 → 标题中点（上下相邻卡从顶部间隙进入的通道，进入即扫标题）
    addEdge(nid("tm"), nid("hm"), true);
    // 标题端点 → 顶角
    addEdge(nid("hl"), nid("tl"), true);
    addEdge(nid("hr"), nid("tr"), true);
    // 卡片周长：顶部横向通道走标题栏（tl→hl→hm→hr→tr，已由标题边 + hl-tl/hr-tr 构成），
    // 保证沿卡片顶部移动必经过标题中点；右/下/左边经过边中点。
    addEdge(nid("tr"), nid("rm"), true);
    addEdge(nid("rm"), nid("br"), true);
    addEdge(nid("br"), nid("bm"), true);
    addEdge(nid("bm"), nid("bl"), true);
    addEdge(nid("bl"), nid("lm"), true);
    addEdge(nid("lm"), nid("tl"), true);

    portIds[ci] = ["tl", "tr", "br", "bl", "tm", "rm", "bm", "lm", "hl", "hr"].map(nid);
  });

  // ===== 间隙走廊：连接相邻卡片边框 =====
  for (let i = 0; i < cardRects.length; i++) {
    for (let j = i + 1; j < cardRects.length; j++) {
      const ignore = new Set([i, j]);
      const cands: Array<{ a: string; b: string; d: number; mx: number; my: number }> = [];
      for (const ai of portIds[i]) {
        const na = nodeById.get(ai)!;
        for (const bj of portIds[j]) {
          const nb = nodeById.get(bj)!;
          const d = dist(na, nb);
          if (d < GAP_MIN || d > GAP_MAX) continue;
          if (blockedByAnyCard(na, nb, rects, ignore)) continue;
          cands.push({ a: ai, b: bj, d, mx: (na.x + nb.x) / 2, my: (na.y + nb.y) / 2 });
        }
      }
      cands.sort((u, v) => u.d - v.d);
      // 贪心保留少量、端点不重复的间隙
      const used = new Set<string>();
      let kept = 0;
      for (const cd of cands) {
        if (used.has(cd.a) || used.has(cd.b)) continue;
        const gapId = `gap:${cardRects[i].cardId}:${cardRects[j].cardId}:${kept}`;
        addNode({ id: gapId, x: cd.mx, y: cd.my, kind: "gap" });
        addEdge(cd.a, gapId, true);
        addEdge(gapId, cd.b, true);
        used.add(cd.a);
        used.add(cd.b);
        kept++;
        if (kept >= GAP_PER_CARD_PAIR) break;
      }
    }
  }

  // ===== 屏幕边兜底车道（非结构，大权重，保证图始终连通）=====
  // 无卡片则不建车道，保持空图（findPath 对空图返回 []）
  if (cardRects.length === 0) return { nodes, edges };
  const pad = LANE_PAD;
  const lanePts = {
    tl: { x: pad, y: pad },
    tr: { x: vp.w - pad, y: pad },
    br: { x: vp.w - pad, y: vp.h - pad },
    bl: { x: pad, y: vp.h - pad },
    tm: { x: vp.w / 2, y: pad },
    rm: { x: vp.w - pad, y: vp.h / 2 },
    bm: { x: vp.w / 2, y: vp.h - pad },
    lm: { x: pad, y: vp.h / 2 },
  };
  (Object.keys(lanePts) as Array<keyof typeof lanePts>).forEach((k) => {
    addNode({ id: `lane:${k}`, x: lanePts[k].x, y: lanePts[k].y, kind: "lane" });
  });
  // 车道环（非结构，整段加 LANE_PENALTY）
  [["tl", "tm"], ["tm", "tr"], ["tr", "rm"], ["rm", "br"], ["br", "bm"], ["bm", "bl"], ["bl", "lm"], ["lm", "tl"]]
    .forEach(([u, v]) => addEdge(`lane:${u}`, `lane:${v}`, false, LANE_PENALTY));

  // 卡片角点 → 最近屏幕车道（连线不被其他卡片阻挡）
  cardRects.forEach((c, ci) => {
    const ignore = new Set([ci]);
    let best: { lane: string; d: number } | null = null;
    for (const pi of portIds[ci]) {
      const np = nodeById.get(pi)!;
      // 投影到最近屏幕边，找最近车道节点
      let laneId: string;
      const dl = np.x - pad;
      const dr = vp.w - pad - np.x;
      const dt = np.y - pad;
      const db = vp.h - pad - np.y;
      const m = Math.min(dl, dr, dt, db);
      if (m === dl) laneId = "lane:lm";
      else if (m === dr) laneId = "lane:rm";
      else if (m === dt) laneId = "lane:tm";
      else laneId = "lane:bm";
      const lp = nodeById.get(laneId)!;
      const d = dist(np, lp);
      if (d > CARD_TO_LANE_MAX) continue;
      if (blockedByAnyCard(np, lp, rects, ignore)) continue;
      if (!best || d < best.d) best = { lane: laneId, d };
      // 用该角点直连（addEdge 会自动取端点坐标）
      addEdge(pi, laneId, false, LANE_PENALTY * 0.4);
    }
    void best;
  });

  return { nodes, edges };
}

// ===== A* 寻路 =====
function buildAdjacency(g: FrameGraph): Map<string, Array<{ id: string; w: number }>> {
  const adj = new Map<string, Array<{ id: string; w: number }>>();
  const push = (a: string, b: string, w: number) => {
    let list = adj.get(a);
    if (!list) {
      list = [];
      adj.set(a, list);
    }
    list.push({ id: b, w });
  };
  g.edges.forEach((e) => {
    push(e.a, e.b, e.w);
    push(e.b, e.a, e.w);
  });
  return adj;
}

function nearestNode(g: FrameGraph, p: Pt): GraphNode {
  let best = g.nodes[0];
  let bd = Infinity;
  for (const n of g.nodes) {
    const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}

/**
 * A* 求结构节点序列（不含原始起终点；调用方负责把 from/to 作为首尾 ScanPoint）。
 * 边权已含长度/非结构惩罚；此处再对路径上的陡转向加 TURN_PENALTY，鼓励顺滑。
 */
export function findPath(g: FrameGraph, from: Pt, to: Pt): GraphNode[] {
  if (g.nodes.length === 0) return [];
  const start = nearestNode(g, from);
  const goal = nearestNode(g, to);
  if (start.id === goal.id) return [start];

  const adj = buildAdjacency(g);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  const gscore = new Map<string, number>([[start.id, 0]]);
  const fscore = new Map<string, number>([[start.id, dist(start, goal)]]);
  const came = new Map<string, string>();
  const closed = new Set<string>();
  const open = new Set<string>([start.id]);

  while (open.size) {
    // 取 f 最小
    let cur = "";
    let bf = Infinity;
    for (const id of open) {
      const f = fscore.get(id) ?? Infinity;
      if (f < bf) {
        bf = f;
        cur = id;
      }
    }
    if (cur === goal.id) break;
    open.delete(cur);
    closed.add(cur);

    const prevId = came.get(cur);
    const curNode = byId.get(cur)!;
    const neighbors = adj.get(cur) ?? [];
    for (const nb of neighbors) {
      if (closed.has(nb.id)) continue;
      let step = nb.w;
      // 等长 tie-break：优先沿标题栏走（极小奖励，不主导长度，仅让等长路径经过标题）
      if (byId.get(nb.id)!.kind === "head") step -= 1;
      // 转角惩罚：当前段与上一段方向夹角过陡
      if (prevId) {
        const prevNode = byId.get(prevId)!;
        const v1x = curNode.x - prevNode.x;
        const v1y = curNode.y - prevNode.y;
        const v2x = (byId.get(nb.id)!.x) - curNode.x;
        const v2y = (byId.get(nb.id)!.y) - curNode.y;
        const l1 = Math.hypot(v1x, v1y);
        const l2 = Math.hypot(v2x, v2y);
        if (l1 > 0 && l2 > 0) {
          const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
          if (cos < TURN_COS) step += TURN_PENALTY;
        }
      }
      const tentative = (gscore.get(cur) ?? Infinity) + step;
      if (tentative < (gscore.get(nb.id) ?? Infinity)) {
        came.set(nb.id, cur);
        gscore.set(nb.id, tentative);
        fscore.set(nb.id, tentative + dist(byId.get(nb.id)!, goal));
        open.add(nb.id);
      }
    }
  }

  if (!came.has(goal.id) && goal.id !== start.id) return []; // 无通路（理论上车道兜底，不应发生）

  const seq: GraphNode[] = [];
  let cur: string | undefined = goal.id;
  while (cur) {
    seq.unshift(byId.get(cur)!);
    cur = came.get(cur);
  }
  return seq;
}
