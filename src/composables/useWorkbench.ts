import { ref, computed, watch } from "vue";
import { db } from "../db/database";

export type CardId =
  | "radar"
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
  | "ipo";

export type Zone = "main" | "side";

export interface CardMeta {
  title: string;
  accent: string;
  kind: "chart" | "narrow";
}

// 卡片元信息
export const CARD_META: Record<CardId, CardMeta> = {
  radar: { title: "涨停雷达", accent: "#e0455a", kind: "chart" },
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
};

// 宽卡片（主干区域）与窄卡片（右侧）的默认排列顺序，也决定卡片的默认分区
const WIDE_ORDER: CardId[] = ["radar", "breadth", "chart", "sectorheat", "sector", "screener", "f10", "trade", "journal", "calendar", "ipo"];
const NARROW_ORDER: CardId[] = ["alert", "spider", "sectorevent", "order", "fundflow", "watch", "rank"];
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

const GAP = 12;
const COLS = 12;
const ROWS = 6;

// 由网格线编号生成定位样式 + leave 脱标用的 CSS 变量
function cell(s: number, e: number, r: number, er: number) {
  return {
    gridColumn: `${s} / ${e}`,
    gridRow: `${r} / ${er}`,
    "--x": `calc(${s - 1} * (100% + ${GAP}px) / ${COLS})`,
    "--w": `calc(${e - s} * (100% + ${GAP}px) / ${COLS} - ${GAP}px)`,
    "--y": `calc(${r - 1} * (100% + ${GAP}px) / ${ROWS})`,
    "--h": `calc(${er - r} * (100% + ${GAP}px) / ${ROWS} - ${GAP}px)`,
  } as Record<string, string>;
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
}

export interface NamedLayout {
  id: number;
  name: string;
  cards: string;
  updated_at: number;
}

const CURRENT_KEY = "workbench_current";

export function useWorkbench() {
  const openCards = ref<CardId[]>([]);
  // 用户对卡片分区的自定义覆盖（未设置则用默认分区）
  const zoneOverride = ref<Partial<Record<CardId, Zone>>>({});

  function open(id: CardId) {
    if (!openCards.value.includes(id)) openCards.value.push(id);
  }
  function close(id: CardId) {
    openCards.value = openCards.value.filter((c) => c !== id);
  }
  function toggle(id: CardId) {
    openCards.value.includes(id) ? close(id) : open(id);
  }
  function isOpen(id: CardId) {
    return openCards.value.includes(id);
  }
  // 模式：整组替换，并恢复默认分区
  function setMode(cards: CardId[]) {
    zoneOverride.value = {};
    openCards.value = [...cards];
  }

  function zoneOf(id: CardId): Zone {
    return zoneOverride.value[id] ?? defaultZone(id);
  }

  // 按分区分组（保持 openCards 内的相对顺序）
  const mainCards = computed(() => openCards.value.filter((id) => zoneOf(id) === "main"));
  const sideCards = computed(() => openCards.value.filter((id) => zoneOf(id) === "side"));

  // 布局：返回每个卡片的定位
  const layout = computed<Record<string, Record<string, string>>>(() => {
    const wides = mainCards.value;
    const w = wides.length;
    const narrows = sideCards.value;
    const n = narrows.length;
    const style: Record<string, Record<string, string>> = {};

    if (w > 0) {
      // 宽卡片占主干 col1-7（6 行细分）
      if (w === 1) {
        style[wides[0]] = cell(1, 7, 1, 7); // 全高
      } else if (w === 2) {
        style[wides[0]] = cell(1, 7, 1, 4); // 上半
        style[wides[1]] = cell(1, 7, 4, 7); // 下半
      } else if (w === 3) {
        style[wides[0]] = cell(1, 7, 1, 3); // 上
        style[wides[1]] = cell(1, 7, 3, 5); // 中
        style[wides[2]] = cell(1, 7, 5, 7); // 下
      } else if (w === 4) {
        // 2 列 × 2 行
        style[wides[0]] = cell(1, 4, 1, 4);
        style[wides[1]] = cell(4, 7, 1, 4);
        style[wides[2]] = cell(1, 4, 4, 7);
        style[wides[3]] = cell(4, 7, 4, 7);
      } else {
        // w >= 5：2 列 × 3 行（最多 6 个宽卡）
        const wcells: [number, number, number, number][] = [
          [1, 4, 1, 3],
          [4, 7, 1, 3],
          [1, 4, 3, 5],
          [4, 7, 3, 5],
          [1, 4, 5, 7],
          [4, 7, 5, 7],
        ];
        wides.slice(0, 6).forEach((id, i) => {
          const c = wcells[i];
          style[id] = cell(c[0], c[1], c[2], c[3]);
        });
      }
      // 窄卡片在右侧 col7-13
      if (n === 1) {
        style[narrows[0]] = cell(7, 13, 1, 7);
      } else if (n === 2) {
        style[narrows[0]] = cell(7, 10, 1, 7);
        style[narrows[1]] = cell(10, 13, 1, 7);
      } else if (n === 3) {
        style[narrows[0]] = cell(7, 13, 1, 4);
        style[narrows[1]] = cell(7, 10, 4, 7);
        style[narrows[2]] = cell(10, 13, 4, 7);
      } else if (n === 4) {
        style[narrows[0]] = cell(7, 10, 1, 4);
        style[narrows[1]] = cell(10, 13, 1, 4);
        style[narrows[2]] = cell(7, 10, 4, 7);
        style[narrows[3]] = cell(10, 13, 4, 7);
      } else if (n === 5) {
        // 上排 3、下排 2
        style[narrows[0]] = cell(7, 9, 1, 4);
        style[narrows[1]] = cell(9, 11, 1, 4);
        style[narrows[2]] = cell(11, 13, 1, 4);
        style[narrows[3]] = cell(7, 10, 4, 7);
        style[narrows[4]] = cell(10, 13, 4, 7);
      } else {
        // n >= 6：上排 3、下排 3
        style[narrows[0]] = cell(7, 9, 1, 4);
        style[narrows[1]] = cell(9, 11, 1, 4);
        style[narrows[2]] = cell(11, 13, 1, 4);
        style[narrows[3]] = cell(7, 9, 4, 7);
        style[narrows[4]] = cell(9, 11, 4, 7);
        style[narrows[5]] = cell(11, 13, 4, 7);
      }
    } else {
      // 无宽卡片：窄卡片横向均分、全高
      const spans: Record<number, [number, number][]> = {
        1: [[1, 13]],
        2: [[1, 7], [7, 13]],
        3: [[1, 5], [5, 9], [9, 13]],
        4: [[1, 4], [4, 7], [7, 10], [10, 13]],
      };
      if (n <= 4) {
        (spans[n] || []).forEach(([s, e], i) => {
          style[narrows[i]] = cell(s, e, 1, 7);
        });
      } else {
        // n===5：上排 3、下排 2；n>=6：上排 3、下排 3
        ([[1, 5], [5, 9], [9, 13]] as [number, number][]).forEach(([s, e], i) => {
          style[narrows[i]] = cell(s, e, 1, 4);
        });
        if (n === 5) {
          style[narrows[3]] = cell(1, 7, 4, 7);
          style[narrows[4]] = cell(7, 13, 4, 7);
        } else {
          style[narrows[3]] = cell(1, 5, 4, 7);
          style[narrows[4]] = cell(5, 9, 4, 7);
          style[narrows[5]] = cell(9, 13, 4, 7);
        }
      }
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
    dragEnd();
  }

  // ===== 序列化 / 恢复 =====
  function serialize(): string {
    const cards: SnapshotCard[] = openCards.value.map((id) => ({ id, zone: zoneOf(id) }));
    return JSON.stringify(cards);
  }
  function applySnapshot(json: string) {
    try {
      const arr = JSON.parse(json) as SnapshotCard[];
      if (!Array.isArray(arr)) return;
      const ov: Partial<Record<CardId, Zone>> = {};
      const ids: CardId[] = [];
      for (const c of arr) {
        if (!ALL_IDS.includes(c.id)) continue;
        ids.push(c.id);
        if (c.zone && c.zone !== defaultZone(c.id)) ov[c.id] = c.zone;
      }
      zoneOverride.value = ov;
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
      } catch {
        /* db 未就绪，忽略 */
      }
    }, 400);
  }
  // 启动恢复：返回是否恢复出了卡片
  async function restoreCurrent(): Promise<boolean> {
    try {
      const rows = await db().select<{ value: string }[]>(
        "SELECT value FROM meta WHERE key=?",
        [CURRENT_KEY]
      );
      if (rows[0]?.value) {
        applySnapshot(rows[0].value);
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
    zoneOverride.value = {};
    openCards.value = [...openCards.value].sort((a, b) => rankDefault(a) - rankDefault(b));
  }

  watch([openCards, zoneOverride], persistCurrent, { deep: true });

  return {
    openCards,
    open,
    close,
    toggle,
    isOpen,
    setMode,
    layout,
    zoneOf,
    // 拖拽
    dragId,
    dropHint,
    dragStart,
    hintOver,
    hintZone,
    clearHint,
    applyDrop,
    dragEnd,
    // 持久化 / 布局
    restoreCurrent,
    saveNamedLayout,
    listNamedLayouts,
    loadNamedLayout,
    deleteNamedLayout,
    resetLayout,
  };
}
