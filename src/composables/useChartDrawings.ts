// 画线工具 composable：KLineChart 内置 overlay + SQLite 持久化。
// 从 StockChart.vue 原样抽取，行为不变——仅把 chart 实例 / 股票代码 / 周期索引改为注入的 getter。
import { ref, computed, onMounted, onUnmounted } from "vue";
import { OverlayMode } from "klinecharts";
import type { Chart } from "klinecharts";
import { db } from "../db/database";

type Maybe<T> = T | null | undefined;

export function useChartDrawings(opts: {
  getChart: () => Maybe<Chart>;
  getCode: () => string;
  activePeriod: () => number;
}) {
  const { getChart, getCode, activePeriod } = opts;

  // ===== 画线工具状态 =====
  const drawBar = ref(false);
  const activeDraw = ref("");
  const continuous = ref(true);
  const magnet = ref<OverlayMode>(OverlayMode.Normal);
  const drawColor = ref("#E6B85C");
  const drawSize = ref(1);
  const drawDirty = ref(false);
  let selectedOverlayId: string | null = null;
  let overlayRightHit = 0;

  // 工具按类型分组（short 为按钮上的短标签）
  const drawGroups: { name: string; label: string; short: string }[][] = [
    [
      { name: "segment", label: "线段", short: "段" },
      { name: "rayLine", label: "射线", short: "射" },
      { name: "straightLine", label: "直线", short: "直" },
    ],
    [
      { name: "horizontalSegment", label: "水平线段", short: "横段" },
      { name: "horizontalRayLine", label: "水平射线", short: "横射" },
      { name: "horizontalStraightLine", label: "水平直线", short: "横直" },
      { name: "priceLine", label: "水平价位线", short: "价位" },
    ],
    [
      { name: "verticalSegment", label: "垂直线段", short: "垂段" },
      { name: "verticalRayLine", label: "垂直射线", short: "垂射" },
      { name: "verticalStraightLine", label: "垂直直线", short: "垂直" },
    ],
    [
      { name: "parallelStraightLine", label: "平行直线 / 通道", short: "平行" },
      { name: "priceChannelLine", label: "价格通道线", short: "通道" },
      { name: "fibonacciLine", label: "黄金分割（0.382/0.5/0.618…）", short: "黄金" },
    ],
    [
      { name: "simpleTag", label: "标签", short: "标签" },
      { name: "simpleAnnotation", label: "文字标注", short: "文字" },
    ],
  ];

  const drawInstances = new Map<string, any>();
  const drawScope = computed(() => `draw_${getCode()}_${activePeriod()}`);
  let drawTimer = 0;
  let saving = false;

  function toggleDraw() {
    drawBar.value = !drawBar.value;
  }

  // 磁吸模式循环：关 → 弱 → 强 → 关
  function cycleMagnet() {
    magnet.value =
      magnet.value === OverlayMode.Normal ? OverlayMode.WeakMagnet
      : magnet.value === OverlayMode.WeakMagnet ? OverlayMode.StrongMagnet
      : OverlayMode.Normal;
  }
  const magnetLabel = computed(() =>
    magnet.value === OverlayMode.Normal ? "磁"
    : magnet.value === OverlayMode.WeakMagnet ? "弱吸" : "强吸");
  const magnetTitle = computed(() =>
    magnet.value === OverlayMode.Normal ? "磁吸：关"
    : magnet.value === OverlayMode.WeakMagnet ? "磁吸：弱（端点靠近K线时吸附）"
    : "磁吸：强（强制吸附到开高低收）");

  function cycleSize() {
    drawSize.value = drawSize.value >= 3 ? 1 : drawSize.value + 1;
  }

  // 画线样式（黄金分割保留默认多色；其余统一颜色/粗细）
  function buildDrawStyles(name: string) {
    const c = drawColor.value, s = drawSize.value;
    const point = {
      color: c, borderColor: c, borderSize: 1, radius: 3,
      activeColor: c, activeBorderColor: c, activeBorderSize: 1, activeRadius: 4,
    };
    if (name === "fibonacciLine") return {};
    if (name === "simpleTag" || name === "simpleAnnotation") {
      return { text: { color: c, size: 12 }, point };
    }
    return {
      line: { color: c, style: "solid", smooth: false, size: s, dashedValue: [2, 2] as [number, number] },
      point,
      text: { color: c, size: 11 },
    };
  }

  // 创建一条 overlay 并绑定事件；points 传入表示恢复（不进入绘制、不触发连画）
  function makeOverlay(name: string, points?: any[]): string | null {
    const chart = getChart();
    if (!chart) return null;
    const value: any = {
      name,
      mode: magnet.value,
      styles: buildDrawStyles(name),
      onSelected: (e: any) => { selectedOverlayId = e.overlay.id; return false; },
      onDeselected: () => { if (selectedOverlayId) selectedOverlayId = null; return false; },
      onRightClick: (e: any) => {
        overlayRightHit = Date.now();
        const id = e.overlay.id;
        window.setTimeout(() => removeOne(id), 0);
        return true;
      },
      onDrawEnd: () => {
        drawDirty.value = true;
        if (continuous.value && activeDraw.value === name) {
          window.setTimeout(() => makeOverlay(name), 0);
        }
        return false;
      },
    };
    if (points) value.points = points;
    const id = chart.createOverlay(value) as unknown as string;
    if (id) {
      const ins = chart.getOverlayById(id);
      if (ins) drawInstances.set(id, ins);
    }
    return id;
  }

  // 移除尚未画完的 overlay（切换工具 / 回到光标时清理）
  function removeUnfinished() {
    for (const [id, ins] of drawInstances) {
      if ((ins.currentStep ?? 0) < (ins.totalStep ?? 2) - 1) {
        getChart()?.removeOverlay(id);
        drawInstances.delete(id);
      }
    }
  }
  function startDraw(name: string) {
    if (!getChart()) return;
    removeUnfinished();
    activeDraw.value = name;
    makeOverlay(name);
  }
  function pickCursor() {
    removeUnfinished();
    activeDraw.value = "";
  }
  function removeOne(id: string) {
    getChart()?.removeOverlay(id);
    drawInstances.delete(id);
    if (selectedOverlayId === id) selectedOverlayId = null;
    drawDirty.value = true;
  }

  // 只收集已画完的线（点数达到 totalStep-1），points 原样深拷贝（不假设内部坐标格式）
  function collectFinished(): any[] {
    const out: any[] = [];
    for (const [, ins] of drawInstances) {
      const pts = ins.points ?? [];
      if (pts.length >= (ins.totalStep ?? 2) - 1) {
        out.push({ name: ins.name, points: pts.map((p: any) => ({ ...p })) });
      }
    }
    return out;
  }

  // 全量写回当前作用域（force=true 时无论是否有改动都写）
  async function saveDrawings(force = false) {
    if (saving) return;
    if (!force && !drawDirty.value) return;
    let d;
    try { d = db(); } catch { return; }
    saving = true;
    try {
      const finished = collectFinished();
      const now = Date.now();
      await d.execute("DELETE FROM drawing WHERE scope=?", [drawScope.value]);
      for (let i = 0; i < finished.length; i++) {
        await d.execute(
          "INSERT INTO drawing(scope,name,points,sort,updated_at) VALUES(?,?,?,?,?)",
          [drawScope.value, finished[i].name, JSON.stringify(finished[i].points), i, now]
        );
      }
      drawDirty.value = false;
    } catch (e) {
      console.warn("[draw] save failed", e);
    } finally {
      saving = false;
    }
  }

  async function restoreDrawings() {
    if (!getChart()) return;
    let d;
    try { d = db(); } catch { return; }
    try {
      const rows = await d.select<{ name: string; points: string }[]>(
        "SELECT name,points FROM drawing WHERE scope=? ORDER BY sort",
        [drawScope.value]
      );
      for (const r of rows) {
        let pts;
        try { pts = JSON.parse(r.points); } catch { continue; }
        makeOverlay(r.name, pts);
      }
    } catch (e) {
      console.warn("[draw] restore failed", e);
    }
    // 清理旧版本遗留的 localStorage
    try {
      localStorage.removeItem(`tg_draw_${getCode()}_${activePeriod()}`);
      localStorage.removeItem(drawScope.value);
    } catch {
      /* ignore */
    }
  }

  async function clearDrawings() {
    for (const [id] of drawInstances) getChart()?.removeOverlay(id);
    drawInstances.clear();
    activeDraw.value = "";
    selectedOverlayId = null;
    let d;
    try { d = db(); } catch { return; }
    try {
      await d.execute("DELETE FROM drawing WHERE scope=?", [drawScope.value]);
      drawDirty.value = false;
    } catch {
      /* ignore */
    }
    try { localStorage.removeItem(`tg_draw_${getCode()}_${activePeriod()}`); } catch { /* ignore */ }
  }

  // Esc：取消当前工具 / 未完成画线；Delete：删除选中画线
  function onDrawKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (activeDraw.value) { removeUnfinished(); activeDraw.value = ""; }
    } else if (e.key === "Delete" || e.key === "Backspace") {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (selectedOverlayId) { removeOne(selectedOverlayId); e.preventDefault(); }
    }
  }

  // ===== 组件生命周期：定时保存 / 快捷键 / 卸载前强制保存 =====
  onMounted(() => {
    drawTimer = window.setInterval(() => saveDrawings(false), 3000);
    window.addEventListener("keydown", onDrawKey);
  });

  onUnmounted(() => {
    void saveDrawings(true);
    window.clearInterval(drawTimer);
    window.removeEventListener("keydown", onDrawKey);
  });

  // 供组件右键菜单判断：刚在某条画线上右键（已触发单条删除）时，不再弹图表菜单
  function isRecentOverlayRightClick(): boolean {
    return Date.now() - overlayRightHit < 250;
  }

  return {
    // 状态
    drawBar,
    activeDraw,
    continuous,
    magnet,
    drawColor,
    drawSize,
    drawGroups,
    magnetLabel,
    magnetTitle,
    // 模板动作
    toggleDraw,
    cycleMagnet,
    cycleSize,
    startDraw,
    pickCursor,
    clearDrawings,
    // 组件内部集成（渲染 / 切换周期时调用）
    drawInstances,
    restoreDrawings,
    saveDrawings,
    isRecentOverlayRightClick,
  };
}
