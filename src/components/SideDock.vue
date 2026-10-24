<script setup lang="ts">
import { ref, inject, computed, onMounted, onBeforeUnmount } from "vue";
import type { DockGroup, DockItem } from "../lib/dock";
import { useDockGroups } from "../composables/useDockGroups";
import type { CardId } from "../lib/cards";

const emit = defineEmits<{
  (e: "toggle", id: CardId): void;
  (e: "palette"): void;
  (e: "settings"): void;
}>();

// 工作台状态（从 App provide 注入；这里只需要 isOpen 判断高亮）
const bench = inject<{
  isOpen: (id: CardId) => boolean;
}>("workbench", null as any);

// 用户分组（出厂 DOCK_GROUPS + 自定义，meta 持久化）
const dock = useDockGroups();
const groups = dock.groups;

const activeGroup = ref<string | null>(null);
const hoverTimer = ref<number | null>(null);
// 点击后锁定面板：不受鼠标移开自动关闭影响（真实窗口下 hover 时序容易导致面板一闪即关）
const locked = ref(false);

// ===== 分组管理状态 =====
const addOpen = ref(false);        // 新增分组输入面板
const addName = ref("");
const manageGroup = ref<string | null>(null); // 正在管理（重命名/删除）的分组
const renameOpen = ref(false);
const renameName = ref("");
const confirmDelete = ref(false);
let confirmTimer: number | null = null;

// ===== 功能移动状态 =====
const moveItemId = ref<string | null>(null);  // 正在选择目标分组的功能
const moveGroupOf = ref<string | null>(null); // 该功能当前所在分组

// 每个分组已开卡片数（用于红色 badge）
function groupCount(g: DockGroup): number {
  return g.items.filter((it) => bench?.isOpen(it.id)).length;
}

function openGroup(g: DockGroup) {
  if (hoverTimer.value) { window.clearTimeout(hoverTimer.value); hoverTimer.value = null; }
  activeGroup.value = g.name;
  locked.value = true;
}
function scheduleClose() {
  if (locked.value) return;
  if (hoverTimer.value) window.clearTimeout(hoverTimer.value);
  hoverTimer.value = window.setTimeout(() => { activeGroup.value = null; }, 280);
}
function cancelClose() {
  if (hoverTimer.value) { window.clearTimeout(hoverTimer.value); hoverTimer.value = null; }
}
// 鼠标离开 Dock 时：如果是移向浮出面板（relatedTarget 在 .dock-panel 内），不关闭
function onDockLeave(e: MouseEvent) {
  if (locked.value) return;
  const rt = e.relatedTarget as Node | null;
  if (rt && (rt as HTMLElement).closest?.(".dock-panel")) return;
  scheduleClose();
}

// 点击 dock/面板外部：解除锁定并关闭面板
function unlockDock() {
  activeGroup.value = null;
  locked.value = false;
}
// 鼠标移出应用窗口 / 窗口失焦时：无条件收起展开的浮窗（不再依赖锁定状态）
function closeDock() {
  if (hoverTimer.value) { window.clearTimeout(hoverTimer.value); hoverTimer.value = null; }
  unlockDock();
}
onMounted(() => {
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest?.(".side-dock") || t.closest?.(".dock-panel")) return;
    if (locked.value) unlockDock();
  });
  // 鼠标离开整个窗口 / 窗口失焦（切到其他应用）时收起浮窗
  document.documentElement.addEventListener("mouseleave", closeDock);
  window.addEventListener("blur", closeDock);
});
onBeforeUnmount(() => {
  document.documentElement.removeEventListener("mouseleave", closeDock);
  window.removeEventListener("blur", closeDock);
});
function pick(it: DockItem) {
  emit("toggle", it.id);
  // 打开卡片后不自动收起面板，方便连续开多张；Esc / 点击空白由 App 层处理
}

// ===== P12-16 交易工具页分区：主线置顶 + 按使用环节归类 =====
const TOOL_GROUP_NAME = "交易工具";
// 各环节：label 为分区小标题，ids 为该环节出厂功能（未列出的进「辅助工具」兜底）
const TOOL_SECTIONS: { label: string; ids: string[] }[] = [
  { label: "★ 今日主线：先跑作战流", ids: ["cockpit"] },
  { label: "盘后计划 · 选股做计划", ids: ["battleplan", "strategyscan", "sieve", "screener"] },
  { label: "盘中执行 · 信号与下单", ids: ["brokerconsole", "signalbridge", "co", "spiderbot", "trade"] },
  { label: "收盘复盘 · 结算进化", ids: ["review", "performance", "decisionlog", "evolution", "backtest", "reviewreport"] },
  { label: "辅助工具 · 随时用", ids: ["ai", "risk", "strategy", "mainline", "journal", "calendar", "ipo", "calc", "export"] },
];
const isToolGroup = computed(() => current.value?.name === TOOL_GROUP_NAME);
function sectionOf(id: string): number {
  for (let i = 0; i < TOOL_SECTIONS.length; i++) {
    if (TOOL_SECTIONS[i]!.ids.includes(id)) return i;
  }
  return TOOL_SECTIONS.length - 1; // 兜底：辅助工具
}
function itemsOfSection(i: number): DockItem[] {
  const items = current.value?.items ?? [];
  return items.filter((it) => sectionOf(it.id) === i);
}

const current = computed<DockGroup | null>(
  () => groups.value.find((g) => g.name === activeGroup.value) ?? null
);

// ===== 分组管理操作 =====
function startAdd() {
  addOpen.value = true;
  addName.value = "";
  activeGroup.value = null;
}
async function commitAdd() {
  const ok = await dock.addGroup(addName.value);
  if (ok) {
    addOpen.value = false;
    activeGroup.value = addName.value.trim();
  }
  addName.value = "";
}

function openManage(g: DockGroup) {
  manageGroup.value = g.name;
  renameOpen.value = false;
  confirmDelete.value = false;
  renameName.value = g.name;
}
function closeManage() {
  manageGroup.value = null;
  if (confirmTimer) window.clearTimeout(confirmTimer);
  confirmTimer = null;
  renameOpen.value = false;
  confirmDelete.value = false;
}
async function commitRename() {
  const old = manageGroup.value;
  if (!old) return;
  const ok = await dock.renameGroup(old, renameName.value);
  if (ok) {
    if (activeGroup.value === old) activeGroup.value = renameName.value.trim();
    closeManage();
  }
}
async function doDelete() {
  const name = manageGroup.value;
  if (!name) return;
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    if (confirmTimer) window.clearTimeout(confirmTimer);
    confirmTimer = window.setTimeout(() => { confirmDelete.value = false; }, 2500);
    return;
  }
  const ok = await dock.removeGroup(name);
  if (ok) {
    if (activeGroup.value === name) activeGroup.value = null;
    closeManage();
  }
}

// ===== 功能移动 =====
function startMove(it: DockItem, fromGroup: string) {
  moveItemId.value = it.id;
  moveGroupOf.value = fromGroup;
}
async function doMove(toGroup: string) {
  const id = moveItemId.value;
  if (!id) return;
  await dock.moveItem(id, toGroup);
  moveItemId.value = null;
  moveGroupOf.value = null;
}
</script>

<template>
  <aside class="side-dock" @mouseleave="onDockLeave">
    <div class="dock-scroll">
    <button
      v-for="g in groups"
      :key="g.name"
      type="button"
      class="dock-btn"
      :class="{ on: activeGroup === g.name }"
      @mouseenter="openGroup(g)"
      @focus="openGroup(g)"
      @click="openGroup(g)"
    >
      <span v-if="groupCount(g) > 0" class="d-badge">{{ groupCount(g) }}</span>
      <span class="d-ic">
        <svg viewBox="0 0 24 24"><path fill="currentColor" :d="g.icon" /></svg>
      </span>
      <span class="d-label">{{ g.name.slice(0, 2) }}</span>
      <span class="d-manage" title="管理分组" @click.stop="openManage(g)">⋯</span>
    </button>

    <!-- 新增分组 -->
    <button type="button" class="dock-btn dock-add" title="新增分组" @click="startAdd">
      <span class="d-ic">＋</span>
      <span class="d-label">新增</span>
    </button>

    </div>

    <div class="dock-foot">
    <div class="dock-sep"></div>

    <button type="button" class="dock-btn" title="命令面板 (Ctrl+K)" @click="emit('palette')">
      <svg viewBox="0 0 24 24" class="d-ic"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 10-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1114 9.5 4.5 4.5 0 019.5 14z" /></svg>
      <span class="d-label">命令</span>
    </button>

    <button type="button" class="dock-btn" title="设置" @click="emit('settings')">
      <svg viewBox="0 0 24 24" class="d-ic"><path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" /></svg>
      <span class="d-label">设置</span>
    </button>

    </div>

    <Teleport to="body">
    <!-- 展开的分组面板：从 dock 右侧浮出（Teleport 到 body，避免被侧栏层叠/裁剪） -->
    <Transition name="dpop">
      <div
        v-if="current"
        :key="current.name"
        class="dock-panel"
        @mouseenter="cancelClose"
        @mouseleave="scheduleClose"
      >
        <div class="dp-head">
          <h3>{{ current.name }}</h3>
          <span>{{ current.items.length }} 个功能</span>
        </div>
        <template v-if="isToolGroup">
          <div v-for="(sec, si) in TOOL_SECTIONS" :key="si" class="dp-section">
            <div class="dp-sec-head" :class="{ main: si === 0 }">{{ sec.label }}</div>
            <div class="dp-grid dp-sec-grid">
              <div
                v-for="it in itemsOfSection(si)"
                :key="it.id"
                class="dp-item"
                :class="{ on: bench?.isOpen(it.id), main: si === 0 }"
                @click="pick(it)"
              >
                <span class="dpi-ic">
                  <svg viewBox="0 0 24 24"><path fill="currentColor" :d="it.icon" /></svg>
                </span>
                <span class="dpi-t" :title="it.desc">{{ it.label }}</span>
                <button
                  type="button"
                  class="dpi-move"
                  title="移动到其他分组"
                  @click.stop="startMove(it, current.name)"
                >⇄</button>
              </div>
              <div v-if="!itemsOfSection(si).length" class="dp-empty dp-sec-empty">本环节暂无出厂功能</div>
            </div>
          </div>
        </template>
        <div v-else class="dp-grid" :class="{ 'pro-grid': current.name === 'Pro 会员' }">
          <div
            v-for="it in current.items"
            :key="it.id"
            class="dp-item"
            :class="{ on: bench?.isOpen(it.id) }"
            @click="pick(it)"
          >
            <span class="dpi-ic">
              <svg viewBox="0 0 24 24"><path fill="currentColor" :d="it.icon" /></svg>
            </span>
            <span class="dpi-t" :title="it.desc">{{ it.label }}</span>
            <button
              type="button"
              class="dpi-move"
              title="移动到其他分组"
              @click.stop="startMove(it, current.name)"
            >⇄</button>
          </div>
          <div v-if="current.items.length === 0" class="dp-empty">
            暂无功能 · 可在其他分组的 <b>⇄</b> 上移动到本组
          </div>
        </div>
      </div>
    </Transition>

    <!-- 新增分组输入 -->
    <Transition name="dpop">
      <div v-if="addOpen" class="dock-panel dock-form" @mouseenter="cancelClose" @mouseleave="scheduleClose">
        <div class="dp-head"><h3>新增分组</h3><button class="dp-x" @click="addOpen = false">×</button></div>
        <input
          v-model="addName"
          class="dg-input"
          placeholder="分组名称（≤6字）"
          maxlength="6"
          @keydown.enter="commitAdd"
          @keydown.esc="addOpen = false"
        />
        <button class="dg-go" @click="commitAdd">创建</button>
      </div>
    </Transition>

    <!-- 分组管理（重命名/删除） -->
    <Transition name="dpop">
      <div v-if="manageGroup" class="dock-panel dock-form dock-manage" @mouseenter="cancelClose" @mouseleave="scheduleClose">
        <div class="dp-head"><h3>管理分组</h3><button class="dp-x" @click="closeManage">×</button></div>
        <template v-if="!renameOpen">
          <button class="dg-act" @click="renameOpen = true; renameName = manageGroup">✎ 重命名</button>
          <button
            class="dg-act danger"
            :class="{ armed: confirmDelete }"
            @click="doDelete"
          >{{ confirmDelete ? "再点确认删除" : "🗑 删除分组" }}</button>
          <div class="dg-note">删除后组内功能回到原出厂分组</div>
        </template>
        <template v-else>
          <input
            v-model="renameName"
            class="dg-input"
            placeholder="新名称（≤6字）"
            maxlength="6"
            @keydown.enter="commitRename"
            @keydown.esc="closeManage"
          />
          <button class="dg-go" @click="commitRename">保存</button>
        </template>
      </div>
    </Transition>

    <!-- 功能移动目标选择 -->
    <Transition name="dpop">
      <div v-if="moveItemId" class="dock-panel dock-form dock-move" @mouseenter="cancelClose" @mouseleave="scheduleClose">
        <div class="dp-head"><h3>移动到分组</h3><button class="dp-x" @click="moveItemId = null">×</button></div>
        <button
          v-for="g in groups"
          :key="g.name"
          class="dg-act"
          :disabled="g.name === moveGroupOf"
          @click="doMove(g.name)"
        >
          {{ g.name }}<span v-if="g.name === moveGroupOf" class="dg-cur">当前</span>
        </button>
      </div>
    </Transition>
    </Teleport>
  </aside>
</template>

<style scoped>
.side-dock {
  position: relative;
  width: 68px;
  flex: none;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  z-index: 90;
}
.dock-scroll {
  flex: 1; min-height: 0;
  width: 100%;
  display: flex; flex-direction: column; align-items: center;
  gap: 2px; padding-top: 10px;
  overflow-y: auto;
}
.dock-scroll::-webkit-scrollbar { width: 0; }
.dock-foot {
  flex: none;
  width: 100%;
  display: flex; flex-direction: column; align-items: center;
  gap: 2px; padding-bottom: 10px;
}
.dock-btn {
  width: 54px; padding: 6px 0;
  border: 0; background: transparent;
  border-radius: 8px;
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  color: var(--text-dim);
  cursor: pointer;
  transition: background 0.14s, color 0.14s;
  position: relative;
}
.dock-btn .d-ic {
  width: 22px; height: 22px; border-radius: 6px;
  background: var(--ov-05);
  display: flex; align-items: center; justify-content: center;
  transition: all .18s;
}
.d-ic svg { width: 13px; height: 13px; opacity: .85; }
.d-label { font-size: 9px; line-height: 1; letter-spacing: 1px; }
.dock-btn:hover { color: var(--text); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.dock-btn.on { color: var(--text); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.dock-btn.on .d-ic {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
}
.dock-btn.on .d-ic svg { opacity: 1; color: var(--accent-contrast); }
.dock-add .d-ic { font-size: 16px; line-height: 20px; color: var(--text-dim); }
.dock-add:hover .d-ic { color: var(--accent); }
.dock-sep { width: 30px; height: 1px; background: var(--border); margin: auto 0 6px; }
.d-badge {
  position: absolute; top: 2px; right: 4px;
  min-width: 14px; height: 14px; border-radius: 7px;
  background: var(--up); color: #fff;
  font-size: 8.5px; font-weight: 700; line-height: 14px;
  text-align: center; padding: 0 3px;
  z-index: 2;
}
.d-manage {
  position: absolute; top: 0; left: 2px;
  width: 12px; height: 12px; border-radius: 3px;
  background: var(--ov-08);
  color: var(--text-dim);
  font-size: 9px; line-height: 12px; text-align: center;
  cursor: pointer;
  display: none;
}
.dock-btn:hover .d-manage { display: block; }
.d-manage:hover { background: color-mix(in srgb, var(--accent) 30%, transparent); color: var(--accent); }

/* dock 右侧浮出面板：视口相对定位，窄窗口自适应宽度（不超出视口） */
.dock-panel {
  position: fixed;
  left: 68px; top: 38px;
  width: min(250px, calc(100vw - 78px));
  background: var(--surface-solid);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--border-ov);
  border-radius: 10px;
  box-shadow: 20px 20px 50px rgba(0,0,0,.6);
  padding: 10px;
  max-height: min(520px, calc(100vh - 120px));
  overflow-y: auto;
  z-index: 95;
}
.dp-head {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-bottom: 8px; padding: 4px 6px;
}
.dp-head h3 { margin: 0; font-size: 10px; color: var(--accent); letter-spacing: 2px; font-weight: 600; }
.dp-head span { font-size: 9px; color: var(--text-dim); letter-spacing: 0; }
.dp-x { background: transparent; border: 0; color: var(--text-dim); font-size: 12px; cursor: pointer; padding: 0 2px; }
.dp-x:hover { color: var(--text); }
.dp-grid { display: grid; grid-template-columns: 1fr; gap: 4px; }
.dp-section { margin-bottom: 8px; }
.dp-sec-head {
  font-size: 10px; font-weight: 700; color: var(--text-dim);
  padding: 2px 2px 4px; letter-spacing: 0.5px;
}
.dp-sec-head.main { color: var(--accent); }
.dp-sec-grid { gap: 4px; }
.dp-sec-empty { padding: 6px 8px; }
.dp-item.main {
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}
.dp-item.main .dpi-t { font-weight: 600; color: var(--accent); }
.dp-item {
  display: grid;
  grid-template-columns: 24px 1fr;
  align-items: center;
  column-gap: 6px;
  padding: 5px 7px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  text-align: left; cursor: pointer;
  transition: background 0.14s, border-color 0.14s;
  position: relative;
  min-width: 0;
}
.dpi-ic {
  width: 24px; height: 24px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700;
}
.dpi-ic svg { width: 13px; height: 13px; }
.dpi-t { font-size: 11px; font-weight: 400; line-height: 1.2; display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 面板只保留「图标 + 名称」，一句话用途改为悬停 title，避免面板塞满文字 */
.dp-item:hover { background: var(--ov-05); }
.dp-item.on { background: color-mix(in srgb, var(--accent) 8%, transparent); border-color: color-mix(in srgb, var(--accent) 25%, transparent); }
.dp-item.on .dpi-t::after {
  content: ""; width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent); box-shadow: 0 0 6px var(--accent);
}
.dpi-move {
  position: absolute; right: 6px; top: 50%;
  transform: translateY(-50%);
  width: 20px; height: 20px;
  border: 0; border-radius: 4px;
  background: var(--ov-07);
  color: var(--text-dim); cursor: pointer;
  font-size: 12px; line-height: 20px; text-align: center;
  display: none;
}
.dp-item:hover .dpi-move { display: block; }
.dpi-move:hover { background: color-mix(in srgb, var(--accent) 30%, transparent); color: var(--accent); }
.dp-empty {
  padding: 14px 10px; text-align: center;
  color: var(--text-dim); font-size: 10.5px; line-height: 1.6;
}
.dp-empty b { color: var(--accent); }

/* Pro 会员组：金色边框 + 锁标记 */
.pro-grid .dp-item {
  border-left: 2px solid color-mix(in srgb, var(--accent) 40%, transparent);
  padding-left: 6px;
}
.pro-grid .dp-item .dpi-t::before {
  content: "🔒";
  font-size: 9px;
  opacity: 0.6;
  margin-right: 2px;
}

/* 新增/管理/移动表单面板 */
.dock-form { width: 190px; }
.dg-input {
  width: 100%; box-sizing: border-box;
  background: var(--ov-05);
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--text);
  font-size: 12px;
  padding: 6px 8px;
  outline: none;
  margin-bottom: 6px;
}
.dg-input:focus { border-color: color-mix(in srgb, var(--accent) 50%, transparent); }
.dg-go {
  width: 100%;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  border: 0; border-radius: 5px;
  color: #000; font-size: 11px; font-weight: 700;
  padding: 6px 0; cursor: pointer;
}
.dg-act {
  width: 100%; text-align: left;
  background: var(--ov-04);
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--text); font-size: 11.5px;
  padding: 7px 9px; margin-bottom: 5px; cursor: pointer;
  display: flex; justify-content: space-between; align-items: center;
}
.dg-act:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 12%, transparent); border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
.dg-act:disabled { opacity: .45; cursor: default; }
.dg-act.danger { color: var(--up); }
.dg-act.danger.armed { background: rgba(239,95,107,.18); border-color: var(--up); }
.dg-cur { font-size: 9px; color: var(--text-dim); }
.dg-note { font-size: 9px; color: var(--text-dim); padding: 2px 2px 0; }

/* 面板过渡 */
.dpop-enter-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.dpop-leave-active { transition: opacity 0.1s ease, transform 0.1s ease; }
.dpop-enter-from, .dpop-leave-to { opacity: 0; transform: translateX(-8px); }
</style>
