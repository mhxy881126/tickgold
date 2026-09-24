import { ref, computed, watch } from "vue";
import { db } from "../db/database";

export type CardId =
  | "radar"
  | "radarsweep"
  | "reviewtimeline"
  | "multigrid"
  | "heatmatrix"
  | "bentofocus"
  | "telegraph"
  | "breadth"
  | "chart"
  | "sectorheat"
  | "sector"
  | "screener"
  | "spider"
  | "sectorevent"
  | "order"
  | "fundflow"
  | "watch"
  | "rank"
  | "alert"
  | "f10"
  | "trade"
  | "journal"
  | "calendar"
  | "ipo"
  | "dist"
  | "theme"
  | "news"
  | "calc"
  | "export";

export type Zone = "main" | "side";

export interface CardMeta {
  title: string;
  accent: string;
  kind: "chart" | "narrow";
}

// 卡片元信息
export const CARD_META: Record<CardId, CardMeta> = {
  radar: { title: "涨停雷达", accent: "#e0455a", kind: "chart" },
  radarsweep: { title: "雷达扫盘", accent: "#2de1ff", kind: "chart" },
  reviewtimeline: { title: "复盘时间线", accent: "#c9a24a", kind: "chart" },
  multigrid: { title: "多股同列", accent: "#36b8e8", kind: "chart" },
  heatmatrix: { title: "全市场热力矩阵", accent: "#ff7a45", kind: "chart" },
  bentofocus: { title: "Bento聚焦网格", accent: "#e8c66a", kind: "chart" },
  telegraph: { title: "异动电报墙", accent: "#1dffa0", kind: "chart" },
  breadth: { title: "市场宽度", accent: "#4ea1ff", kind: "chart" },
  chart: { title: "K线图", accent: "#2f6fed", kind: "chart" },
  sectorheat: { title: "板块热力图", accent: "#d4af37", kind: "chart" },
  sector: { title: "板块行情", accent: "#35c4a8", kind: "chart" },
  screener: { title: "条件选股", accent: "#d4af37", kind: "chart" },
  spider: { title: "短线精灵", accent: "#e0556b", kind: "narrow" },
  sectorevent: { title: "板块异动", accent: "#e0556b", kind: "narrow" },
  order: { title: "五档盘口", accent: "#d9a23b", kind: "narrow" },
  fundflow: { title: "资金流向", accent: "#f0883e", kind: "narrow" },
  watch: { title: "自选股", accent: "#26d07c", kind: "narrow" },
  rank: { title: "榜单", accent: "#e0556b", kind: "narrow" },
  alert: { title: "预警管理", accent: "#ffd700", kind: "narrow" },
  f10: { title: "F10 个股资料", accent: "#d4af37", kind: "chart" },
  trade: { title: "模拟交易", accent: "#f0883e", kind: "chart" },
  journal: { title: "盯盘日记", accent: "#d4af37", kind: "chart" },
  calendar: { title: "财经日历", accent: "#4ea1ff", kind: "chart" },
  ipo: { title: "新股解禁", accent: "#ff8a3d", kind: "chart" },
  dist: { title: "涨跌分布", accent: "#4ea1ff", kind: "narrow" },
  theme: { title: "题材轮动", accent: "#d4af37", kind: "chart" },
  news: { title: "盘中快讯", accent: "#b07cff", kind: "narrow" },
  calc: { title: "投资计算器", accent: "#e8c878", kind: "chart" },
  export: { title: "数据导出", accent: "#6aa6e8", kind: "chart" },
};

// 宽卡片（主干区域）与窄卡片（右侧）的默认排列顺序，也决定卡片的默认分区
const WIDE_ORDER: CardId[] = ["radar", "radarsweep", "reviewtimeline", "multigrid", "heatmatrix", "bentofocus", "telegraph", "breadth", "chart", "sectorheat", "sector", "screener", "theme", "dist", "f10", "trade", "journal", "calendar", "ipo", "calc", "export"];
const NARROW_ORDER: CardId[] = ["alert", "spider", "sectorevent", "order", "fundflow", "news", "watch", "rank"];
const ALL_IDS: CardId[] = [...WIDE_ORDER, ...NARROW_ORDER];

// 模式预设：一键切换一整套卡片
export const MODES: Record<string, CardId[]> = {
  pro: ["radar", "chart", "spider", "order", "watch", "alert"],
  sector: ["sectorheat", "sector", "sectorevent"],
  scanner: ["screener", "rank", "watch"],
  full: [
    "radar",
    "breadth",
    "chart",
    "sectorheat",
    "sector",
    "screener",
    "spider",
    "sectorevent",
    "order",
    "fundflow",
    "watch",
    "rank",
    "alert",
  ],
  chart: ["chart"],
};

// ===== 时段驾驶舱 Bento 布局 =====
export interface BentoPos { col: number; colEnd: number; row: number; rowEnd: number }
export interface TimePreset {
  id: string;
  label: string;
  from: string;
  to: string;
  cards: CardId[];
  bento: Partial<Record<CardId, BentoPos>>;
}
// 款5 Bento：12 列 × 3 大行（热力图大卡 + 情绪/雷达/资金/异动 + 题材/分布/快讯）
const BENTO: Partial<Record<CardId, BentoPos>> = {
  sectorheat: { col: 1, colEnd: 7, row: 1, rowEnd: 3 },
  breadth: { col: 7, colEnd: 10, row: 1, rowEnd: 2 },
  radar: { col: 10, colEnd: 13, row: 1, rowEnd: 2 },
  fundflow: { col: 7, colEnd: 10, row: 2, rowEnd: 3 },
  spider: { col: 10, colEnd: 13, row: 2, rowEnd: 3 },
  theme: { col: 1, colEnd: 5, row: 3, rowEnd: 4 },
  dist: { col: 5, colEnd: 8, row: 3, rowEnd: 4 },
  news: { col: 8, colEnd: 13, row: 3, rowEnd: 4 },
};
const TIME_CARDS: CardId[] = ["sectorheat", "breadth", "radar", "fundflow", "spider", "theme", "dist", "news"];
export const TIME_PRESETS: TimePreset[] = [
  { id: "auction", label: "集合竞价", from: "09:15", to: "09:30", cards: TIME_CARDS, bento: BENTO },
  { id: "morning", label: "早盘 9:30", from: "09:30", to: "11:30", cards: TIME_CARDS, bento: BENTO },
  { id: "midday", label: "午盘", from: "11:30", to: "14:30", cards: TIME_CARDS, bento: BENTO },
  { id: "tail", label: "尾盘 14:30", from: "14:30", to: "15:00", cards: TIME_CARDS, bento: BENTO },
  { id: "review", label: "盘后复盘", from: "15:00", to: "09:15", cards: TIME_CARDS, bento: BENTO },
];

/// 根据时间判断当前 A 股时段
export function currentTimeSlot(d: Date = new Date()): string {
  const hm = d.getHours() * 60 + d.getMinutes();
  const m = (s: string) => {
    const [a, b] = s.split(":").map(Number);
    return a * 60 + b;
  };
  if (hm >= m("09:15") && hm < m("09:30")) return "auction";
  if (hm >= m("09:30") && hm < m("11:30")) return "morning";
  if (hm >= m("11:30") && hm < m("14:30")) return "midday";
  if (hm >= m("14:30") && hm < m("15:00")) return "tail";
  return "review";
}

const GAP = 12;
const COLS = 12;
const ROWS = 6;

// ===== 自由布局（卡片可随意拖拽摆放）=====
export interface FreeRect { x: number; y: number; w: number; h: number }
const ROW_UNIT = 88; // 自由布局每个逻辑行的像素高度
// 各卡在自由画布上的默认尺寸（w=12 列网格中的列数，h=逻辑行数）
const FREE_SIZE: Partial<Record<CardId, { w: number; h: number }>> = {
  chart: { w: 8, h: 5 },
  sectorheat: { w: 8, h: 5 },
  sector: { w: 6, h: 4 },
  screener: { w: 6, h: 4 },
  f10: { w: 6, h: 4 },
  trade: { w: 6, h: 4 },
  theme: { w: 6, h: 4 },
  calendar: { w: 6, h: 4 },
  ipo: { w: 6, h: 4 },
  journal: { w: 6, h: 4 },
  radar: { w: 4, h: 3 },
  breadth: { w: 4, h: 3 },
};
function freeSizeOf(id: CardId): { w: number; h: number } {
  return FREE_SIZE[id] ?? { w: 4, h: 3 };
}
// 自由布局初始装箱：按 12 列 shelf 换行，行高取该行最高卡，输出整数坐标
export function packFree(cards: CardId[]): Record<string, FreeRect> {
  const out: Record<string, FreeRect> = {};
  const rows: { id: CardId; w: number; h: number }[][] = [];
  let cur: { id: CardId; w: number; h: number }[] = [];
  let cw = 0;
  for (const id of cards) {
    const s = freeSizeOf(id);
    if (cur.length && cw + s.w > COLS) { rows.push(cur); cur = []; cw = 0; }
    cur.push({ id, w: s.w, h: s.h });
    cw += s.w;
  }
  if (cur.length) rows.push(cur);
  let y = 0;
  for (const row of rows) {
    const rh = Math.max(...row.map((r) => r.h));
    let x = 0;
    for (const r of row) { out[r.id] = { x, y, w: r.w, h: rh }; x += r.w; }
    y += rh;
  }
  return out;
}
// 两个自由矩形是否相交（边界相接不算重叠）
export function rectsOverlap(a: FreeRect, b: FreeRect): boolean {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0;
}
// 碰撞推开：重复扫描，凡相交则把更靠下的卡下移，直到无重叠（只向下，收敛）
export function settleFreeRects(rects: Record<string, FreeRect>) {
  let guard = 0;
  let any = true;
  while (any && guard < 400) {
    any = false;
    guard++;
    const ids = Object.keys(rects);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = rects[ids[i]];
        const b = rects[ids[j]];
        if (rectsOverlap(a, b)) {
          if (a.y <= b.y) b.y = a.y + a.h;
          else a.y = b.y + b.h;
          any = true;
        }
      }
    }
  }
}

// 由网格线编号生成定位样式 + leave 脱标用的 CSS 变量
function cell(s: number, e: number, r: number, er: number, totalRows: number = ROWS) {
  return {
    gridColumn: `${s} / ${e}`,
    gridRow: `${r} / ${er}`,
    "--x": `calc(${s - 1} * (100% + ${GAP}px) / ${COLS})`,
    "--w": `calc(${e - s} * (100% + ${GAP}px) / ${COLS} - ${GAP}px)`,
    "--y": `calc(${r - 1} * (100% + ${GAP}px) / ${totalRows})`,
    "--h": `calc(${er - r} * (100% + ${GAP}px) / ${totalRows} - ${GAP}px)`,
  } as Record<string, string>;
}

// x 的整数约数（用于在固定网格线上均匀分列）
function divisors(x: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= x; i++) if (x % i === 0) out.push(i);
  return out;
}

// 通用装箱：把 cards 均匀铺满一个 Lw 列 × 6 行的逻辑网格（列起点 colStart）。
// 任意卡片数都保证每卡有整数网格线坐标、不重叠；末行不满则拉伸铺满，无孤卡、无右侧空洞。
function packZone(
  cards: CardId[],
  colStart: number,
  Lw: number,
  out: Record<string, Record<string, string>>
) {
  const n = cards.length;
  if (!n) return;
  let best: { k: number; m: number; cost: number } | null = null;
  for (const k of divisors(Lw)) {
    const m = Math.ceil(n / k);
    if (6 % m !== 0) continue; // 行高必须落在整数网格线
    const cw = Lw / k;
    const ch = 6 / m;
    const ratio = cw / ch;
    const fill = n / (k * m);
    const cost = Math.abs(ratio - 1.4) + (1 - fill) * 0.6;
    if (!best || cost < best.cost) best = { k, m, cost };
  }
  if (!best) {
    out[cards[0]] = cell(1 + colStart, 1 + colStart + Lw, 1, 7); // 极端兜底
    return;
  }
  const { k, m } = best;
  const colW = Lw / k;
  const rowH = 6 / m;
  let i = 0;
  for (let row = 0; row < m; row++) {
    const remain = n - i;
    const inRow = Math.min(k, remain);
    const grs = 1 + row * rowH;
    const gre = 1 + (row + 1) * rowH;
    if (remain < k) {
      // 末行不满：把 Lw 列分给 inRow 张（宽 base / base+1），铺满整行、无右侧空洞
      const base = Math.floor(Lw / inRow);
      const extra = Lw % inRow;
      let cx = 1 + colStart;
      for (let c = 0; c < inRow; c++) {
        const w = base + (c < extra ? 1 : 0);
        out[cards[i]] = cell(cx, cx + w, grs, gre);
        cx += w;
        i++;
      }
    } else {
      for (let c = 0; c < k; c++) {
        out[cards[i]] = cell(
          1 + colStart + c * colW,
          1 + colStart + (c + 1) * colW,
          grs,
          gre
        );
        i++;
      }
    }
  }
}

function defaultZone(id: CardId): Zone {
  return WIDE_ORDER.includes(id) ? "main" : "side";
}

// 默认分区下的全局排序权重（用于"重置布局"）
function rankDefault(id: CardId): number {
  const wi = WIDE_ORDER.indexOf(id);
  if (wi >= 0) return wi;
  const ni = NARROW_ORDER.indexOf(id);
  return 100 + (ni >= 0 ? ni : 999);
}

interface SnapshotCard {
  id: CardId;
  zone: Zone;
  rect?: FreeRect;
}

export interface NamedLayout {
  id: number;
  name: string;
  cards: string;
  updated_at: number;
}

const CURRENT_KEY = "workbench_current";
const TIME_KEY = "workbench_time_mode";

export function useWorkbench() {
  const openCards = ref<CardId[]>([]);
  // 用户对卡片分区的自定义覆盖（未设置则用默认分区）
  const zoneOverride = ref<Partial<Record<CardId, Zone>>>({});
  // 时段驾驶舱模式（非 null = 使用 TIME_PRESETS 的显式 Bento 布局）
  const timeMode = ref<string | null>(null);
  // 自由布局：true=卡片按 freeRects 绝对定位，可随意拖拽
  const freeMode = ref(false);
  const freeRects = ref<Record<string, FreeRect>>({});
  const freeDrag = ref<(FreeRect & { id: CardId }) | null>(null);
  const freeCanvasRef = ref<HTMLElement | null>(null);
  // 卡片聚焦（主从分屏）：非 null = 该卡放大到主区，其余卡进入右侧快速切换栏
  const focusId = ref<CardId | null>(null);
  const isFocused = computed(() => focusId.value !== null);
  function focus(id: CardId) {
    focusId.value = id;
  }
  function restoreFocus() {
    focusId.value = null;
  }
  // 清除聚焦逻辑写入卡片根元素的全部内联定位样式
  // （非聚焦态必须无残留，否则卡片脱离网格 → 叠层 / 按钮点不到 / 排列混乱）
  function clearSlotInline() {
    document.querySelectorAll(".card-slot,.free-cell").forEach((node) => {
      const el = node as HTMLElement;
      el.style.position = "";
      el.style.left = "";
      el.style.top = "";
      el.style.width = "";
      el.style.height = "";
      el.style.margin = "";
      el.style.zIndex = "";
      el.style.transition = "";
      el.style.opacity = "";
    });
  }

  function open(id: CardId) {
    if (timeMode.value) timeMode.value = null; // 手动加卡 → 退出固定 Bento，回到自由网格
    if (!openCards.value.includes(id)) {
      openCards.value.push(id);
      if (freeMode.value) placeNewFree(id);
    }
  }
  function close(id: CardId) {
    if (timeMode.value) timeMode.value = null; // Bento 被改动 → 回到自由网格
    if (focusId.value !== null) {
      // 聚焦态关闭任意卡：先清内联定位、整体回到网格，杜绝叠层
      clearSlotInline();
      focusId.value = null;
    }
    openCards.value = openCards.value.filter((c) => c !== id);
    if (freeMode.value) delete freeRects.value[id];
  }
  function toggle(id: CardId) {
    openCards.value.includes(id) ? close(id) : open(id);
  }
  function isOpen(id: CardId) {
    return openCards.value.includes(id);
  }
  // 模式：整组替换，并恢复默认分区
  function setMode(cards: CardId[]) {
    clearSlotInline(); // 切换整组模式前清掉聚焦内联样式
    zoneOverride.value = {};
    timeMode.value = null;
    freeMode.value = false;
    freeRects.value = {};
    focusId.value = null;
    openCards.value = [...cards];
  }
  // 进入时段驾驶舱：套用该时段的卡片集合 + Bento 显式布局
  function enterTimeMode(id: string) {
    const p = TIME_PRESETS.find((x) => x.id === id);
    if (!p) return;
    clearSlotInline(); // 从聚焦 / 其他模式进入时段：清内联定位
    zoneOverride.value = {};
    timeMode.value = id;
    freeMode.value = false;
    freeRects.value = {};
    openCards.value = [...p.cards];
  }
  function exitTimeMode() {
    timeMode.value = null;
  }

  function zoneOf(id: CardId): Zone {
    return zoneOverride.value[id] ?? defaultZone(id);
  }

  // 按分区分组（保持 openCards 内的相对顺序）
  const mainCards = computed(() => openCards.value.filter((id) => zoneOf(id) === "main"));
  const sideCards = computed(() => openCards.value.filter((id) => zoneOf(id) === "side"));

  // 布局：返回每个卡片的定位
  const layout = computed<Record<string, Record<string, string>>>(() => {
    // 时段驾驶舱：使用预设的显式 Bento 坐标（3 大行）
    if (timeMode.value) {
      const p = TIME_PRESETS.find((x) => x.id === timeMode.value);
      if (p) {
        const st: Record<string, Record<string, string>> = {};
        openCards.value.forEach((id) => {
          const b = p.bento[id];
          if (b) st[id] = cell(b.col, b.colEnd, b.row, b.rowEnd, 3);
        });
        return st;
      }
    }
    const style: Record<string, Record<string, string>> = {};
    const wn = mainCards.value.length;
    const sn = sideCards.value.length;
    if (wn && sn) {
      // 两区都有：主干左 6 列、侧栏右 6 列
      packZone(mainCards.value, 0, 6, style);
      packZone(sideCards.value, 6, 6, style);
    } else if (wn) {
      packZone(mainCards.value, 0, 12, style); // 仅主干，占满整宽
    } else {
      packZone(sideCards.value, 0, 12, style); // 仅侧栏，占满整宽
    }
    return style;
  });

  // ===== 拖拽换位 / 跨区移动 =====
  const dragId = ref<CardId | null>(null);
  // 落点指示：目标分区 + 在该分区内的插入下标
  const dropHint = ref<{ zone: Zone; index: number } | null>(null);

  function dragStart(id: CardId) {
    dragId.value = id;
  }
  // 悬停在某张卡片上：ratio = 鼠标沿卡片主轴(纵向)的相对位置 0..1
  function hintOver(target: CardId, ratio: number) {
    const z = zoneOf(target);
    const list = z === "main" ? mainCards.value : sideCards.value;
    const ti = list.indexOf(target);
    const index = ratio > 0.5 ? ti + 1 : ti;
    dropHint.value = { zone: z, index };
  }
  // 悬停在某个分区的空白区：放到该区末尾
  function hintZone(z: Zone) {
    const list = z === "main" ? mainCards.value : sideCards.value;
    dropHint.value = { zone: z, index: list.length };
  }
  function clearHint() {
    dropHint.value = null;
  }
  function dragEnd() {
    dragId.value = null;
    dropHint.value = null;
  }

  // ===== Pointer 拖拽（替代 HTML5 DnD，WebView2 下更可靠）=====
  // 按住标题栏移动超过阈值即进入拖拽，实时按指针位置算落点，松手换位
  function pointerDragStart(id: CardId, e: PointerEvent) {
    if (e.button !== 0) return;
    const st = { sx: e.clientX, sy: e.clientY, active: false };
    let lastX = e.clientX;
    let lastY = e.clientY;
    let raf = 0;
    // 落点计算（elementFromPoint 会强制布局，放进 rAF，每帧最多一次）
    const compute = () => {
      raf = 0;
      const el = document.elementFromPoint(lastX, lastY) as HTMLElement | null;
      const slot = el && el.closest ? (el.closest(".card-slot") as HTMLElement | null) : null;
      if (slot) {
        const cid = slot.getAttribute("data-card-id") as CardId | null;
        if (cid) {
          const r = slot.getBoundingClientRect();
          hintOver(cid, (lastY - r.top) / r.height);
          return;
        }
      }
      // 落在网格空白区：按 x 归到主干 / 侧栏末尾
      const grid = el && el.closest ? (el.closest(".card-grid") as HTMLElement | null) : null;
      if (grid) {
        const gr = grid.getBoundingClientRect();
        const x = (lastX - gr.left) / gr.width;
        hintZone(x < 7 / 12 ? "main" : "side");
      }
    };
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - st.sx;
      const dy = ev.clientY - st.sy;
      if (!st.active && Math.hypot(dx, dy) < 6) return;
      if (!st.active) {
        st.active = true;
        dragId.value = id;
      }
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (!raf) raf = requestAnimationFrame(compute);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (raf) cancelAnimationFrame(raf);
      if (st.active) applyDrop();
      dragEnd();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // 在分区有序列表中把 src 放到锚点之后（after=null 表示该区开头）
  function insertIntoZone(ids: CardId[], src: CardId, z: Zone, after: CardId | null): CardId[] {
    const zIds = ids.filter((i) => zoneOf(i) === z);
    let nz: CardId[];
    if (!after) {
      nz = [src, ...zIds];
    } else {
      nz = [...zIds];
      const k = nz.indexOf(after);
      nz.splice(k >= 0 ? k + 1 : nz.length, 0, src);
    }
    const other = ids.filter((i) => zoneOf(i) !== z);
    // 规整为：主干区在前、侧栏区在后
    return z === "main" ? [...nz, ...other] : [...other, ...nz];
  }

  function applyDrop() {
    const src = dragId.value;
    const hint = dropHint.value;
    if (!src || !hint) {
      dragEnd();
      return;
    }
    const ids = openCards.value.filter((c) => c !== src);
    const zoneList = ids.filter((id) => zoneOf(id) === hint.zone);
    const clamped = Math.min(hint.index, zoneList.length);
    const after: CardId | null = clamped > 0 ? zoneList[clamped - 1] : null;
    if (zoneOf(src) !== hint.zone) zoneOverride.value[src] = hint.zone;
    openCards.value = insertIntoZone(ids, src, hint.zone, after);
    // 拖拽 = 自定义排布，退出时段驾驶舱固定 Bento，否则位置会被预设坐标覆盖
    timeMode.value = null;
    dragEnd();
  }

  // ===== 自由布局：开关 / 拖拽 =====
  function enableFree() {
    if (timeMode.value) timeMode.value = null;
    if (!freeMode.value) freeRects.value = packFree(openCards.value);
    freeMode.value = true;
  }
  function disableFree() {
    freeMode.value = false;
    freeRects.value = {};
    freeDrag.value = null;
  }
  // 自由模式下新卡：放在画布最下方，再碰撞整理
  function placeNewFree(id: CardId) {
    const s = freeSizeOf(id);
    let maxY = 0;
    Object.values(freeRects.value).forEach((r) => { maxY = Math.max(maxY, r.y + r.h); });
    freeRects.value[id] = { x: 0, y: maxY, w: s.w, h: s.h };
    settleFreeRects(freeRects.value);
  }
  function clampNum(v: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, v));
  }
  function startFreeDrag(e: PointerEvent, id: CardId) {
    const rect = freeRects.value[id];
    const canvas = freeCanvasRef.value;
    if (!rect || !canvas) return;
    e.preventDefault();
    const base = { ...rect };
    freeDrag.value = { id, ...base };
    const cr = canvas.getBoundingClientRect();
    const cellW = (cr.width - (COLS + 1) * GAP) / COLS;
    let lastX = 0;
    let lastY = 0;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const mx = lastX - cr.left;
      const my = lastY - cr.top;
      const col = Math.round((mx - GAP) / (cellW + GAP));
      const row = Math.round((my - GAP) / (ROW_UNIT + GAP));
      const nx = clampNum(col - Math.round(base.w / 2), 0, COLS - base.w);
      const ny = clampNum(row - Math.round(base.h / 2), 0, 60);
      freeDrag.value = { id, x: nx, y: ny, w: base.w, h: base.h };
    };
    const move = (ev: PointerEvent) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (!raf) raf = requestAnimationFrame(compute);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (raf) cancelAnimationFrame(raf);
      const g = freeDrag.value;
      if (g) {
        freeRects.value[id] = { x: g.x, y: g.y, w: g.w, h: g.h };
        settleFreeRects(freeRects.value);
      }
      freeDrag.value = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  // 自由卡定位样式（宽用百分比、高用固定像素）
  function freeCellStyle(id: CardId): Record<string, string> {
    const g = freeDrag.value && freeDrag.value.id === id ? freeDrag.value : freeRects.value[id];
    if (!g) return { display: "none" };
    return {
      position: "absolute",
      left: `calc(${g.x} * (100% + ${GAP}px) / ${COLS})`,
      width: `calc(${g.w} * (100% + ${GAP}px) / ${COLS} - ${GAP}px)`,
      top: `${GAP + g.y * (ROW_UNIT + GAP)}px`,
      height: `${g.h * (ROW_UNIT + GAP) - GAP}px`,
      zIndex: freeDrag.value && freeDrag.value.id === id ? "20" : "1",
    };
  }
  const freeHeight = computed(() => {
    let maxY = 0;
    const all: Record<string, FreeRect> = { ...freeRects.value };
    if (freeDrag.value) all[freeDrag.value.id] = freeDrag.value;
    Object.values(all).forEach((r) => { maxY = Math.max(maxY, r.y + r.h); });
    return GAP + maxY * (ROW_UNIT + GAP) + GAP;
  });

  // ===== 序列化 / 恢复 =====
  function serialize(): string {
    const cards: SnapshotCard[] = openCards.value.map((id) => {
      const c: SnapshotCard = { id, zone: zoneOf(id) };
      if (freeMode.value && freeRects.value[id]) c.rect = freeRects.value[id];
      return c;
    });
    return JSON.stringify(cards);
  }
  function applySnapshot(json: string) {
    clearSlotInline(); // 恢复命名布局 / 启动恢复：清掉聚焦内联定位
    focusId.value = null;
    try {
      const arr = JSON.parse(json) as SnapshotCard[];
      if (!Array.isArray(arr)) return;
      const ov: Partial<Record<CardId, Zone>> = {};
      const rects: Record<string, FreeRect> = {};
      const ids: CardId[] = [];
      let hasRect = false;
      for (const c of arr) {
        if (!ALL_IDS.includes(c.id)) continue;
        ids.push(c.id);
        if (c.zone && c.zone !== defaultZone(c.id)) ov[c.id] = c.zone;
        if (c.rect) { rects[c.id] = c.rect; hasRect = true; }
      }
      if (hasRect) {
        freeMode.value = true;
        freeRects.value = rects;
        ids.forEach((id) => { if (!rects[id]) placeNewFree(id); });
        settleFreeRects(freeRects.value);
      } else {
        freeMode.value = false;
        freeRects.value = {};
        zoneOverride.value = ov;
      }
      openCards.value = ids;
    } catch {
      /* ignore */
    }
  }

  // 当前布局：debounce 自动写入 meta
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function persistCurrent() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        db()
          .execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [CURRENT_KEY, serialize()])
          .catch(() => {});
        db()
          .execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [TIME_KEY, timeMode.value ?? ""])
          .catch(() => {});
      } catch {
        /* db 未就绪，忽略 */
      }
    }, 400);
  }
  // 启动恢复：返回是否恢复出了卡片
  async function restoreCurrent(): Promise<boolean> {
    try {
      const rows = await db().select<{ key: string; value: string }[]>(
        "SELECT key,value FROM meta WHERE key IN (?,?)",
        [CURRENT_KEY, TIME_KEY]
      );
      let cardsJson = "", tm = "";
      rows.forEach((r) => {
        if (r.key === CURRENT_KEY) cardsJson = r.value;
        if (r.key === TIME_KEY) tm = r.value;
      });
      if (cardsJson) {
        applySnapshot(cardsJson);
        if (tm && TIME_PRESETS.some((p) => p.id === tm)) timeMode.value = tm;
        return openCards.value.length > 0;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  // 命名布局 CRUD
  async function saveNamedLayout(name: string) {
    const now = Date.now();
    const trimmed = name.trim() || "未命名布局";
    await db().execute(
      "INSERT INTO layout(name,cards,created_at,updated_at) VALUES(?,?,?,?)",
      [trimmed, serialize(), now, now]
    );
  }
  async function listNamedLayouts(): Promise<NamedLayout[]> {
    return await db().select<NamedLayout[]>(
      "SELECT id,name,cards,updated_at FROM layout ORDER BY updated_at DESC"
    );
  }
  async function loadNamedLayout(id: number) {
    const rows = await db().select<{ cards: string }[]>(
      "SELECT cards FROM layout WHERE id=?",
      [id]
    );
    if (rows[0]?.cards) applySnapshot(rows[0].cards);
  }
  async function deleteNamedLayout(id: number) {
    await db().execute("DELETE FROM layout WHERE id=?", [id]);
  }
  // 重置：恢复默认分区 + 默认顺序
  function resetLayout() {
    clearSlotInline();
    focusId.value = null;
    zoneOverride.value = {};
    freeMode.value = false;
    freeRects.value = {};
    openCards.value = [...openCards.value].sort((a, b) => rankDefault(a) - rankDefault(b));
  }

  watch([openCards, zoneOverride, timeMode, freeMode, freeRects], persistCurrent, {
    deep: true,
  });

  return {
    openCards,
    open,
    close,
    toggle,
    isOpen,
    // 卡片聚焦（主从分屏）
    focusId,
    isFocused,
    focus,
    restoreFocus,
    clearSlotInline,
    setMode,
    layout,
    zoneOf,
    // 时段驾驶舱
    timeMode,
    enterTimeMode,
    exitTimeMode,
    // 拖拽
    dragId,
    dropHint,
    dragStart,
    hintOver,
    hintZone,
    clearHint,
    applyDrop,
    dragEnd,
    pointerDragStart,
    // 自由布局
    freeMode,
    freeRects,
    freeDrag,
    freeCanvasRef,
    enableFree,
    disableFree,
    startFreeDrag,
    freeCellStyle,
    freeHeight,
    // 持久化 / 布局
    restoreCurrent,
    saveNamedLayout,
    listNamedLayouts,
    loadNamedLayout,
    deleteNamedLayout,
    resetLayout,
  };
}
