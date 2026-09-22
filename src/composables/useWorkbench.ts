import { ref, computed } from "vue";

export type CardId =
  | "chart"
  | "sector"
  | "screener"
  | "spider"
  | "order"
  | "fundflow"
  | "watch"
  | "rank";

export interface CardMeta {
  title: string;
  accent: string;
  kind: "chart" | "narrow";
}

// 卡片元信息
export const CARD_META: Record<CardId, CardMeta> = {
  chart: { title: "K线图", accent: "#2f6fed", kind: "chart" },
  sector: { title: "板块行情", accent: "#35c4a8", kind: "chart" },
  screener: { title: "条件选股", accent: "#d4af37", kind: "chart" },
  spider: { title: "短线精灵", accent: "#e0556b", kind: "narrow" },
  order: { title: "五档盘口", accent: "#d9a23b", kind: "narrow" },
  fundflow: { title: "资金流向", accent: "#f0883e", kind: "narrow" },
  watch: { title: "自选股", accent: "#26d07c", kind: "narrow" },
  rank: { title: "榜单", accent: "#e0556b", kind: "narrow" },
};

// 宽卡片（主干区域，可上下并列）与窄卡片（右侧）的排列顺序
const WIDE_ORDER: CardId[] = ["chart", "sector", "screener"];
const NARROW_ORDER: CardId[] = ["spider", "order", "fundflow", "watch", "rank"];

// 模式预设：一键切换一整套卡片
export const MODES: Record<string, CardId[]> = {
  pro: ["chart", "spider", "order", "watch"],
  scanner: ["screener", "rank", "watch"],
  full: ["chart", "sector", "screener", "spider", "order", "fundflow", "watch", "rank"],
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

export function useWorkbench() {
  const openCards = ref<CardId[]>([]);

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
  // 模式：整组替换
  function setMode(cards: CardId[]) {
    openCards.value = [...cards];
  }

  // 布局：返回每个卡片的定位
  const layout = computed<Record<string, Record<string, string>>>(() => {
    const open = openCards.value;
    const wides = WIDE_ORDER.filter((id) => open.includes(id));
    const w = wides.length;
    const narrows = NARROW_ORDER.filter((id) => open.includes(id));
    const n = narrows.length;
    const style: Record<string, Record<string, string>> = {};

    if (w > 0) {
      // 宽卡片占主干 col1-7（6 行细分）
      if (w === 1) {
        style[wides[0]] = cell(1, 7, 1, 7); // 全高
      } else if (w === 2) {
        style[wides[0]] = cell(1, 7, 1, 4); // 上半
        style[wides[1]] = cell(1, 7, 4, 7); // 下半
      } else {
        style[wides[0]] = cell(1, 7, 1, 3); // 上
        style[wides[1]] = cell(1, 7, 3, 5); // 中
        style[wides[2]] = cell(1, 7, 5, 7); // 下
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

  return { openCards, open, close, toggle, isOpen, setMode, layout };
}
