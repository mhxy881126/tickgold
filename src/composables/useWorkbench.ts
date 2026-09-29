import { ref, computed, watch, inject } from "vue";
import { db } from "../db/database";
import type { CardId, Zone, CardMeta, CardCustom, SnapshotCard } from "../lib/cards";
import { CARD_META, CARD_SWATCHES } from "../lib/cards";
import {
  ALL_IDS,
  cell,
  defaultSizeOf,
  defaultZone,
  rankDefault,
  packBento,
  settleFreeRects,
} from "../lib/layout";
import type { FreeRect } from "../lib/layout";
import {
  MODES,
  TIME_PRESETS,
  SCENES,
  currentTimeSlot,
} from "../lib/scenes";
import type { TimePreset, Scene, NamedLayout } from "../lib/scenes";
import { useFreeLayout } from "./workbench/useFreeLayout";
import { useSkins } from "./useSkins";
import { resolveTokens, skinCssVars } from "../lib/skin";
import {
  insertWidget as insertWidgetPure,
  makeWidgetId,
  packWidgets,
  reorderWidgets,
  resizeWidget as resizeWidgetPure,
  type CardWidgets,
  type WidgetInstance,
} from "../lib/widgets";
import { hasSingleton, widgetDefOf } from "../components/widgets/registry";
import { presetOf } from "../lib/widget-presets";
import { migrateSnapshot } from "../lib/widget-migrate";

// 对外保持原有导出路径兼容
export type { CardId, Zone, CardMeta, CardCustom, SnapshotCard };
export { CARD_META, CARD_SWATCHES };
export type { FreeRect };
export { MODES, TIME_PRESETS, SCENES, currentTimeSlot };
export type { TimePreset, Scene, NamedLayout };

const CURRENT_KEY = "workbench_current";
const TIME_KEY = "workbench_time_mode";
const SCENE_KEY = "workbench_scene";
const PRE_V1_KEY = "workbench_current_pre_v1";

function createWorkbench() {
  const skins = useSkins();
  const openCards = ref<CardId[]>([]);
  // 用户对卡片分区的自定义覆盖（未设置则用默认分区）
  const zoneOverride = ref<Partial<Record<CardId, Zone>>>({});
  // 时段驾驶舱模式（非 null = 使用 TIME_PRESETS 的显式 Bento 布局）
  const timeMode = ref<string | null>(null);
  // 自由布局（实现见 workbench/useFreeLayout，行为不变）
  const {
    freeMode,
    freeRects,
    freeDrag,
    alignGuides,
    snapPulse,
    freeCanvasRef,
    enableFree,
    disableFree,
    placeNewFree,
    startFreeDrag,
    tidyFree,
    freeCellStyle,
    freeHeight,
    clampNum,
  } = useFreeLayout({ openCards, timeMode, pushUndo });
  // 卡片个性化（尺寸 / 折叠 / 强调色 / 刷新频率）
  const cardCustom = ref<Partial<Record<CardId, CardCustom>>>({});
  // v1 微件布局：有 widgets 的卡走 WidgetCanvas 渲染，无则 legacy CardContent
  const cardWidgets = ref<Partial<Record<CardId, CardWidgets>>>({});
  const sceneId = ref<string | null>(null);
  function patchCustom(id: CardId, patch: Partial<CardCustom>) {
    cardCustom.value = { ...cardCustom.value, [id]: { ...cardCustom.value[id], ...patch } };
  }
  // 数值归一：undefined / NaN 用默认值，其余 clamp 到区间
  function clampN(v: number | undefined, lo: number, hi: number, d: number) {
    return v === undefined || Number.isNaN(v) ? d : Math.max(lo, Math.min(hi, v));
  }
  // 单卡当前外观（全部字段解析为确定值，供组件渲染与设置弹层回显）
  function cardLook(id: CardId) {
    const cu = cardCustom.value[id] ?? {};
    return {
      color: cu.color ?? CARD_META[id].accent,
      gradientTo: cu.gradientTo ?? "",
      gradAngle: clampN(cu.gradAngle, 0, 360, 135),
      opacity: clampN(cu.opacity, 0.6, 1, 1),
      radius: clampN(cu.radius, 6, 18, 10),
      borderWidth: clampN(cu.borderWidth, 0, 2, 1),
      headStyle: clampN(cu.headStyle, 1, 5, 1) as 1 | 2 | 3 | 4 | 5,
      pinned: !!cu.pinned,
      locked: !!cu.locked,
      tag: (cu.tag ?? "").slice(0, 4),
      glow: cu.glow,
      barGlow: cu.barGlow,
    };
  }
  // 注入卡片根元素的 CSS 变量（仅作用于卡片外观，不触碰内部图表配色）
  function cardStyleVars(id: CardId): Record<string, string> {
    const L = cardLook(id);
    const grad = L.gradientTo
      ? `linear-gradient(${L.gradAngle}deg, ${L.color} 0%, ${L.gradientTo} 100%)`
      : L.color;
    const base: Record<string, string> = {
      "--card-accent": L.color,
      "--card-accent2": L.gradientTo || L.color,
      "--card-grad": grad,
      "--card-opacity": String(L.opacity),
      "--card-radius": `${L.radius}px`,
      "--card-border": `${L.borderWidth}px`,
    };
    // 皮肤层（全局 → 场景 → 单卡）；无 app_skin 时仅注入单卡开关，视觉与现状等效
    const tokens = resolveTokens({
      global: skins.appSkin.value,
      scene: skins.sceneSkinOf(sceneId.value ?? ""),
      custom: cardCustom.value[id],
    });
    return { ...base, ...skinCssVars(tokens) };
  }
  function cardColorOf(id: CardId): string {
    return cardCustom.value[id]?.color ?? CARD_META[id].accent;
  }
  function cardRefreshOf(id: CardId): number {
    return cardCustom.value[id]?.refresh ?? 0;
  }
  function isCollapsed(id: CardId): boolean {
    return !!cardCustom.value[id]?.collapsed;
  }
  // 当前生效尺寸（用户覆盖优先；折叠不改变返回的原始跨度）
  function cardSpanOf(id: CardId): { w: number; h: number } {
    const cu = cardCustom.value[id];
    const d = defaultSizeOf(id);
    return { w: cu?.span ?? d.w, h: cu?.rspan ?? d.h };
  }
  const focusId = ref<CardId | null>(null);
  const isFocused = computed(() => focusId.value !== null);
  // 右键菜单「改色」请求打开某卡设置弹层的瞬态信号（CardShell watch 后消费）
  const openCfgId = ref<CardId | null>(null);
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
      pushUndo();
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
    pushUndo();
    lastClosed.value = { id };
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
    pushUndo();
    clearSlotInline(); // 切换整组模式前清掉聚焦内联样式
    zoneOverride.value = {};
    timeMode.value = null;
    freeMode.value = false;
    freeRects.value = {};
    focusId.value = null;
    cardCustom.value = {};
    cardWidgets.value = {};
    sceneId.value = null;
    openCards.value = [...cards];
  }
  // 进入时段驾驶舱：套用该时段的卡片集合 + Bento 显式布局
  function enterTimeMode(id: string) {
    const p = TIME_PRESETS.find((x) => x.id === id);
    if (!p) return;
    pushUndo();
    clearSlotInline(); // 从聚焦 / 其他模式进入时段：清内联定位
    zoneOverride.value = {};
    timeMode.value = id;
    freeMode.value = false;
    freeRects.value = {};
    cardCustom.value = {};
    cardWidgets.value = {};
    sceneId.value = null;
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

  // 统一网格布局：时段 Bento（3 行铺满）或 Bento 自动排布（12×6，可扩展滚动）
  const gridLayout = computed<{
    cells: Record<string, Record<string, string>>;
    rows: number;
    scroll: boolean;
    time: boolean;
  }>(() => {
    // 时段驾驶舱：预设显式 Bento（3 大行）
    if (timeMode.value) {
      const p = TIME_PRESETS.find((x) => x.id === timeMode.value);
      const st: Record<string, Record<string, string>> = {};
      if (p)
        openCards.value.forEach((id) => {
          const b = p.bento[id];
          if (b) st[id] = cell(b.col, b.colEnd, b.row, b.rowEnd, 3);
        });
      return { cells: st, rows: 3, scroll: false, time: true };
    }
    // Bento 自动排布：尺寸取用户覆盖（折叠=1 行），否则默认
    const getSize = (id: CardId) => {
      const cu = cardCustom.value[id];
      const d = defaultSizeOf(id);
      const w = cu?.span ?? d.w;
      const h = cu?.collapsed ? 1 : cu?.rspan ?? d.h;
      return { w, h };
    };
    const pk = packBento(openCards.value, getSize);
    const effRows = Math.max(6, pk.rows);
    const st: Record<string, Record<string, string>> = {};
    openCards.value.forEach((id) => {
      const b = pk.pos[id];
      if (b) st[id] = cell(b.col, b.colEnd, b.row, b.rowEnd, effRows);
    });
    return { cells: st, rows: effRows, scroll: pk.rows > 6, time: false };
  });
  const layout = computed(() => gridLayout.value.cells);

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
    const st: {
      sx: number; sy: number; active: boolean; esc: boolean;
      beforeOrder: CardId[]; beforeZone: Partial<Record<CardId, Zone>>;
    } = { sx: e.clientX, sy: e.clientY, active: false, esc: false, beforeOrder: [], beforeZone: {} };
    let lastX = e.clientX;
    let lastY = e.clientY;
    let raf = 0;

    // 落点计算：忽略被拖卡自身（exclude），算出 {zone,index} 后立即实时换位。
    // elementFromPoint 会强制布局，放进 rAF，每帧最多一次。
    const computeTarget = (): { zone: Zone; index: number } | null => {
      const el = document.elementFromPoint(lastX, lastY) as HTMLElement | null;
      const slot = el && el.closest ? (el.closest(".card-slot") as HTMLElement | null) : null;
      if (slot) {
        const cid = slot.getAttribute("data-card-id") as CardId | null;
        if (cid && cid !== id) {
          const zone = zoneOf(cid);
          const list = openCards.value.filter((i) => i !== id && zoneOf(i) === zone);
          const ti = list.indexOf(cid);
          const r = slot.getBoundingClientRect();
          const ratio = (lastY - r.top) / r.height;
          return { zone, index: ratio > 0.5 ? ti + 1 : ti };
        }
      }
      const grid = el && el.closest ? (el.closest(".card-grid") as HTMLElement | null) : null;
      if (grid) {
        const gr = grid.getBoundingClientRect();
        const x = (lastX - gr.left) / gr.width;
        const zone: Zone = x < 7 / 12 ? "main" : "side";
        return { zone, index: openCards.value.filter((i) => i !== id && zoneOf(i) === zone).length };
      }
      return null;
    };
    const compute = () => {
      raf = 0;
      const t = computeTarget();
      if (!t) return;
      dropHint.value = t;
      reorderTo(id, t.zone, t.index);
    };
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - st.sx;
      const dy = ev.clientY - st.sy;
      if (!st.active && Math.hypot(dx, dy) < 6) return;
      if (!st.active) {
        st.active = true;
        dragId.value = id;
        st.beforeOrder = [...openCards.value];
        st.beforeZone = { ...zoneOverride.value };
        pushUndo(); // 拖拽真正开始时只记一次（实时换位不再重复入栈）
      }
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (!raf) raf = requestAnimationFrame(compute);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") st.esc = true;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
      if (raf) cancelAnimationFrame(raf);
      if (st.esc && st.active) {
        openCards.value = [...st.beforeOrder];
        zoneOverride.value = { ...st.beforeZone };
        // 状态已整体回滚，撤销栈里拖拽前的快照作废
        undoStack.pop();
        canUndo.value = undoStack.length > 0;
      }
      dragEnd();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
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

  // 实时重排：不可变地把 src 移到目标分区指定下标（同区/跨区通用）
  function reorderTo(src: CardId, zone: Zone, index: number) {
    const rest = openCards.value.filter((c) => c !== src);
    const zoneIds = rest.filter((i) => zoneOf(i) === zone);
    const other = rest.filter((i) => zoneOf(i) !== zone);
    const at = Math.max(0, Math.min(index, zoneIds.length));
    const nz = [...zoneIds.slice(0, at), src, ...zoneIds.slice(at)];
    // 跨区时固化分区覆盖；同区保持原覆盖
    if (zoneOverride.value[src] !== undefined || defaultZone(src) !== zone) {
      zoneOverride.value[src] = zone;
    }
    openCards.value = zone === "main" ? [...nz, ...other] : [...other, ...nz];
    timeMode.value = null;
  }

  function applyDrop() {
    const src = dragId.value;
    const hint = dropHint.value;
    if (!src || !hint) {
      dragEnd();
      return;
    }
    reorderTo(src, hint.zone, hint.index);
    dragEnd();
  }

  // ===== 卡片尺寸 / 折叠 / 外观（V1）=====
  function resizeCard(id: CardId, w: number, h: number) {
    patchCustom(id, {
      span: clampNum(Math.round(w), 1, 12),
      rspan: clampNum(Math.round(h), 1, 12),
      collapsed: false,
    });
    if (timeMode.value) timeMode.value = null; // 改尺寸 → 退出固定 Bento
  }
  function toggleCollapse(id: CardId) {
    patchCustom(id, { collapsed: !cardCustom.value[id]?.collapsed });
    if (timeMode.value) timeMode.value = null;
  }
  function setCardColor(id: CardId, color: string) { patchCustom(id, { color }); }
  function setCardRefresh(id: CardId, refresh: number) { patchCustom(id, { refresh }); }

  // ===== 外观/行为 setter（鎏金专业版）=====
  // 批量改外观，写入前统一 clamp；保留其它字段
  function setCardLook(id: CardId, patch: Partial<CardCustom>) {
    const p: Partial<CardCustom> = { ...patch };
    if (p.gradAngle !== undefined) p.gradAngle = clampN(p.gradAngle, 0, 360, 135);
    if (p.opacity !== undefined) p.opacity = clampN(p.opacity, 0.6, 1, 1);
    if (p.radius !== undefined) p.radius = clampN(p.radius, 6, 18, 10);
    if (p.borderWidth !== undefined) p.borderWidth = clampN(p.borderWidth, 0, 2, 1);
    if (p.headStyle !== undefined) p.headStyle = clampN(p.headStyle, 1, 5, 1) as 1 | 2 | 3 | 4 | 5;
    if (p.tag !== undefined) p.tag = p.tag.slice(0, 4);
    patchCustom(id, p);
  }
  function setCardTag(id: CardId, t: string) { patchCustom(id, { tag: t.slice(0, 4) }); }
  function togglePin(id: CardId) { patchCustom(id, { pinned: !cardCustom.value[id]?.pinned }); }
  function toggleLock(id: CardId) { patchCustom(id, { locked: !cardCustom.value[id]?.locked }); }

  // 样式剪贴板（仅会话内存，不持久化）：复制/粘贴纯外观字段
  const LOOK_KEYS = ["color", "gradientTo", "gradAngle", "opacity", "radius", "borderWidth", "headStyle"] as const;
  const copiedLook = ref<Partial<CardCustom> | null>(null);
  function copyLook(id: CardId) {
    const cu = cardCustom.value[id] ?? {};
    const out: Partial<CardCustom> = {};
    LOOK_KEYS.forEach((k) => {
      if (cu[k] !== undefined) (out as Record<string, unknown>)[k] = cu[k];
    });
    copiedLook.value = out;
  }
  function pasteLook(id: CardId) {
    if (copiedLook.value) setCardLook(id, copiedLook.value);
  }
  // 仅清外观/行为覆盖，保留 span/rspan/collapsed/refresh
  function resetCardLook(id: CardId) {
    const cu = cardCustom.value[id];
    if (!cu) return;
    cardCustom.value = {
      ...cardCustom.value,
      [id]: { span: cu.span, rspan: cu.rspan, collapsed: cu.collapsed, refresh: cu.refresh },
    };
  }

  // ===== v1 微件编排 =====
  function widgetsOf(id: CardId): CardWidgets | undefined {
    return cardWidgets.value[id];
  }
  // 渲染判定：空 widgets（编排时新建但未添加微件）不接管渲染，回落 legacy
  function isWidgetCard(id: CardId): boolean {
    return (cardWidgets.value[id]?.items.length ?? 0) > 0;
  }
  function setWidgets(id: CardId, w: CardWidgets | undefined) {
    cardWidgets.value = { ...cardWidgets.value, [id]: w };
  }
  // 进入编排：无 widgets 时以出厂模板初始化（无模板则空画布，由用户从托盘添加）
  function ensureWidgets(id: CardId): CardWidgets {
    const cur = cardWidgets.value[id];
    if (cur) return cur;
    const made: CardWidgets = presetOf(id) ?? { primary: null, items: [] };
    setWidgets(id, made);
    return made;
  }
  function addWidget(id: CardId, defId: string, index?: number): boolean {
    const def = widgetDefOf(defId);
    if (!def) return false;
    const cur = ensureWidgets(id);
    if (hasSingleton(cur.items, defId)) return false;
    const inst: Omit<WidgetInstance, "x" | "y"> = {
      id: makeWidgetId(defId), def: defId, w: def.defaultW, h: def.defaultH,
    };
    setWidgets(id, { ...cur, items: insertWidgetPure(cur.items, inst, index) });
    return true;
  }
  function removeWidgetInst(id: CardId, wId: string) {
    const cur = cardWidgets.value[id];
    if (!cur) return;
    const items = cur.items.filter((i) => i.id !== wId);
    setWidgets(id, items.length ? { ...cur, items } : undefined);
  }
  function reorderWidgetInst(id: CardId, wId: string, index: number) {
    const cur = cardWidgets.value[id];
    if (!cur) return;
    setWidgets(id, { ...cur, items: reorderWidgets(cur.items, wId, index) });
  }
  function resizeWidgetInst(id: CardId, wId: string, w: number, h: number) {
    const cur = cardWidgets.value[id];
    if (!cur) return;
    const items = cur.items.map((it) => {
      if (it.id !== wId) return it;
      const def = widgetDefOf(it.def);
      return def ? resizeWidgetPure(it, def, w, h) : it;
    });
    // 尺寸变化后重新装箱，保持无重叠
    setWidgets(id, { ...cur, items: packWidgets(items) });
  }
  function patchWidgetInst(id: CardId, wId: string, patch: Partial<WidgetInstance>) {
    const cur = cardWidgets.value[id];
    if (!cur) return;
    setWidgets(id, {
      ...cur,
      items: cur.items.map((it) => (it.id === wId ? { ...it, ...patch } : it)),
    });
  }
  function setCardPrimary(id: CardId, code: string | null) {
    const cur = ensureWidgets(id);
    setWidgets(id, { ...cur, primary: code || null });
  }
  // 恢复出厂微件模板（无模板的卡清空自定义 widgets）
  function resetCardWidgets(id: CardId) {
    setWidgets(id, presetOf(id));
  }

  // ===== V3 场景模板：整组替换 + 预设尺寸 =====
  function applyScene(scene: Scene) {
    pushUndo();
    clearSlotInline();
    focusId.value = null;
    timeMode.value = null;
    freeMode.value = false;
    freeRects.value = {};
    sceneId.value = scene.id;
    const cc: Partial<Record<CardId, CardCustom>> = {};
    if (scene.size) {
      (Object.keys(scene.size) as CardId[]).forEach((id) => {
        const s = scene.size![id]!;
        cc[id] = { span: s.w, rspan: s.h };
      });
    }
    cardCustom.value = cc;
    // 场景卡片：有出厂微件模板的直接走 v1，无模板的 legacy
    const wm: Partial<Record<CardId, CardWidgets>> = {};
    scene.cards.forEach((id) => {
      const p = presetOf(id);
      if (p) wm[id] = p;
    });
    cardWidgets.value = wm;
    openCards.value = [...scene.cards];
  }
  function saveCurrentAsScene() {
    void saveNamedLayout("我的场景 " + new Date().toLocaleString());
  }
  // ===== 序列化 / 恢复 =====
  function serialize(): string {
    const cards: SnapshotCard[] = openCards.value.map((id) => {
      const c: SnapshotCard = { id, zone: zoneOf(id) };
      if (freeMode.value && freeRects.value[id]) c.rect = freeRects.value[id];
      if (cardCustom.value[id]) c.cu = cardCustom.value[id];
      if (cardWidgets.value[id]?.items.length) {
        c.v = 1;
        c.widgets = cardWidgets.value[id];
      }
      return c;
    });
    return JSON.stringify(cards);
  }
  function applySnapshot(json: string) {
    clearSlotInline(); // 恢复命名布局 / 启动恢复：清掉聚焦内联定位
    focusId.value = null;
    try {
      const raw = JSON.parse(json) as SnapshotCard[];
      if (!Array.isArray(raw)) return;
      // 老布局自动迁移为微件布局（幂等；未知 def 丢弃）
      const arr = migrateSnapshot(raw).cards;
      const ov: Partial<Record<CardId, Zone>> = {};
      const rects: Record<string, FreeRect> = {};
      const customs: Partial<Record<CardId, CardCustom>> = {};
      const widgetsMap: Partial<Record<CardId, CardWidgets>> = {};
      const ids: CardId[] = [];
      let hasRect = false;
      for (const c of arr) {
        if (!ALL_IDS.includes(c.id)) continue;
        ids.push(c.id);
        if (c.zone && c.zone !== defaultZone(c.id)) ov[c.id] = c.zone;
        if (c.rect) { rects[c.id] = c.rect; hasRect = true; }
        if (c.cu) customs[c.id] = c.cu;
        if (c.widgets?.items.length) widgetsMap[c.id] = c.widgets;
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
      cardCustom.value = customs;
      cardWidgets.value = widgetsMap;
      sceneId.value = null;
      openCards.value = ids;
    } catch {
      /* ignore */
    }
  }

  // ===== 撤销栈（仅会话内，结构操作；外观实时调整不进栈）=====
  const undoStack: string[] = [];
  const UNDO_MAX = 20;
  const canUndo = ref(false);
  const lastClosed = ref<{ id: CardId } | null>(null);
  function pushUndo() {
    undoStack.push(serialize());
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    canUndo.value = undoStack.length > 0;
  }
  function undo(): boolean {
    const snap = undoStack.pop();
    canUndo.value = undoStack.length > 0;
    if (!snap) return false;
    clearSlotInline();
    applySnapshot(snap);
    return true;
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
        db()
          .execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [SCENE_KEY, sceneId.value ?? ""])
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
        "SELECT key,value FROM meta WHERE key IN (?,?,?)",
        [CURRENT_KEY, TIME_KEY, SCENE_KEY]
      );
      let cardsJson = "", tm = "", sc = "";
      rows.forEach((r) => {
        if (r.key === CURRENT_KEY) cardsJson = r.value;
        if (r.key === TIME_KEY) tm = r.value;
        if (r.key === SCENE_KEY) sc = r.value;
      });
      if (cardsJson) {
        // 迁移前自保：若为无 v 的老快照，先把原件另存一份（幂等，只存一次）
        try {
          const parsed = JSON.parse(cardsJson) as SnapshotCard[];
          const isLegacy = Array.isArray(parsed) && parsed.some((c) => c.v === undefined);
          if (isLegacy) {
            const bak = await db().select<{ value: string }[]>(
              "SELECT value FROM meta WHERE key=?", [PRE_V1_KEY]
            );
            if (!bak.length)
              await db().execute(
                "INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)",
                [PRE_V1_KEY, cardsJson]
              );
          }
        } catch {
          /* 自保失败不阻断恢复 */
        }
        applySnapshot(cardsJson);
        if (tm && TIME_PRESETS.some((p) => p.id === tm)) timeMode.value = tm;
        if (sc && SCENES.some((x) => x.id === sc)) sceneId.value = sc;
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
    pushUndo();
    clearSlotInline();
    focusId.value = null;
    zoneOverride.value = {};
    freeMode.value = false;
    freeRects.value = {};
    cardCustom.value = {};
    cardWidgets.value = {};
    sceneId.value = null;
    openCards.value = [...openCards.value].sort((a, b) => rankDefault(a) - rankDefault(b));
  }

  watch(
    [openCards, zoneOverride, timeMode, freeMode, freeRects, cardCustom, cardWidgets],
    persistCurrent,
    { deep: true }
  );

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
    gridLayout,
    mainCards,
    sideCards,
    zoneOf,
    // 卡片个性化（V1 单卡设置）
    cardCustom,
    cardLook,
    cardStyleVars,
    cardColorOf,
    cardRefreshOf,
    isCollapsed,
    cardSpanOf,
    resizeCard,
    toggleCollapse,
    setCardColor,
    setCardRefresh,
    setCardLook,
    setCardTag,
    togglePin,
    toggleLock,
    resetCardLook,
    copiedLook,
    copyLook,
    pasteLook,
    openCfgId,
    undo,
    canUndo,
    lastClosed,
    // V3 场景模板
    sceneId,
    applyScene,
    saveCurrentAsScene,
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
    alignGuides,
    snapPulse,
    freeCanvasRef,
    enableFree,
    disableFree,
    startFreeDrag,
    tidyFree,
    freeCellStyle,
    freeHeight,
    // 持久化 / 布局
    restoreCurrent,
    saveNamedLayout,
    listNamedLayouts,
    loadNamedLayout,
    deleteNamedLayout,
    resetLayout,
    // v1 微件编排
    cardWidgets,
    widgetsOf,
    isWidgetCard,
    setWidgets,
    ensureWidgets,
    addWidget,
    removeWidgetInst,
    reorderWidgetInst,
    resizeWidgetInst,
    patchWidgetInst,
    setCardPrimary,
    resetCardWidgets,
  };
}

export type Workbench = ReturnType<typeof createWorkbench>;

// App 根组件 provide 的唯一工作台实例；子孙组件 inject 复用，避免各自新建空状态
const WORKBENCH_KEY = "workbench";

export function useWorkbench(): Workbench {
  return inject<Workbench | null>(WORKBENCH_KEY, null) ?? createWorkbench();
}
