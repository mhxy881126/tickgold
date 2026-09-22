<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useCalendarStore, type CalEvent } from "../stores/calendar";

const props = defineProps<{ code: string | null }>();
const cal = useCalendarStore();

// ===== 节假日（2026 官方休市区间） =====
const HOLIDAYS = [
  { name: "元旦", start: "2026-01-01", end: "2026-01-03" },
  { name: "春节", start: "2026-02-15", end: "2026-02-23" },
  { name: "清明节", start: "2026-04-04", end: "2026-04-06" },
  { name: "劳动节", start: "2026-05-01", end: "2026-05-05" },
  { name: "端午节", start: "2026-06-19", end: "2026-06-21" },
  { name: "中秋节", start: "2026-09-25", end: "2026-09-27" },
  { name: "国庆节", start: "2026-10-01", end: "2026-10-07" },
];

const TYPES = [
  { v: "macro", lb: "宏观", c: "#4ea1ff" },
  { v: "policy", lb: "政策", c: "#d4af37" },
  { v: "ipo", lb: "新股", c: "#ff8a3d" },
  { v: "restricted", lb: "解禁", c: "#f23645" },
  { v: "earnings", lb: "财报", c: "#0ecb81" },
  { v: "other", lb: "其他", c: "#8a93a6" },
];
const typeMeta = (v: string) => TYPES.find((t) => t.v === v) ?? TYPES[5];

function pad(n: number) { return String(n).padStart(2, "0"); }
function dstr(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayType(date: string): { kind: "trade" | "weekend" | "holiday"; name?: string } {
  const h = HOLIDAYS.find((x) => date >= x.start && date <= x.end);
  if (h) return { kind: "holiday", name: h.name };
  const dow = new Date(date + "T00:00").getDay();
  if (dow === 0 || dow === 6) return { kind: "weekend" };
  return { kind: "trade" };
}

// ===== 月历 =====
const now = new Date();
const calY = ref(now.getFullYear());
const calM = ref(now.getMonth());
const selectedDate = ref(dstr(now));
const monthLabel = computed(() => `${calY.value} 年 ${calM.value + 1} 月`);
const calCells = computed(() => {
  const first = new Date(calY.value, calM.value, 1).getDay();
  const days = new Date(calY.value, calM.value + 1, 0).getDate();
  const cells: { date: string; d: number; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const dn = i - first + 1;
    const inM = dn >= 1 && dn <= days;
    let y = calY.value; let m = calM.value; let d = dn;
    if (dn < 1) { m -= 1; d = new Date(y, m + 1, 0).getDate() + dn; }
    else if (dn > days) { m += 1; d = dn - days; }
    if (m < 0) { m = 11; y -= 1; } if (m > 11) { m = 0; y += 1; }
    cells.push({ date: `${y}-${pad(m + 1)}-${pad(d)}`, d: inM ? dn : d, inMonth: inM });
  }
  return cells;
});
function shiftMonth(delta: number) {
  let m = calM.value + delta; let y = calY.value;
  if (m < 0) { m = 11; y -= 1; } if (m > 11) { m = 0; y += 1; }
  calM.value = m; calY.value = y;
}
const dayEvents = computed<CalEvent[]>(() => cal.byDate(selectedDate.value));
const selectedType = computed(() => dayType(selectedDate.value));

// ===== 表单（新增 / 编辑） =====
const showForm = ref(false);
const editId = ref<number | null>(null);
const fTime = ref("");
const fTitle = ref("");
const fType = ref("other");
const fCode = ref<string | null>(null);
const fRemind = ref(false);
const fNote = ref("");
const formMsg = ref("");

function resetForm() {
  fTime.value = ""; fTitle.value = ""; fType.value = "other";
  fCode.value = null; fRemind.value = false; fNote.value = ""; formMsg.value = "";
}
function openCreate() {
  resetForm(); editId.value = null; showForm.value = true;
}
function openEdit(e: CalEvent) {
  editId.value = e.id;
  fTime.value = e.time ?? ""; fTitle.value = e.title; fType.value = e.type;
  fCode.value = e.code; fRemind.value = e.remind === 1; fNote.value = e.note;
  formMsg.value = ""; showForm.value = true;
}
async function saveForm() {
  if (!fTitle.value.trim()) { formMsg.value = "请填写事件标题"; return; }
  if (fRemind.value && !fTime.value) { formMsg.value = "到点提醒需要设置具体时间"; return; }
  const payload = {
    time: fTime.value || null, title: fTitle.value.trim(), type: fType.value,
    code: fCode.value, remind: fRemind.value ? 1 : 0, note: fNote.value,
  };
  if (editId.value != null) await cal.update(editId.value, payload);
  else await cal.create(selectedDate.value).then((e) => cal.update(e.id, payload));
  showForm.value = false;
}
function useLink() { fCode.value = props.code; }

async function toggleDone(e: CalEvent) {
  await cal.update(e.id, { done: e.done === 1 ? 0 : 1 });
}
async function toggleRemind(e: CalEvent) {
  if (e.remind !== 1 && !e.time) {
    formMsg.value = "请先编辑事件并设置时间，再开到点提醒"; return;
  }
  await cal.update(e.id, { remind: e.remind === 1 ? 0 : 1 });
}

// ===== 到点提醒（Web Notification） =====
const firedSet = new Set<number>();
let timer: number | null = null;
function checkRemind() {
  const now = new Date();
  for (const e of cal.events) {
    if (e.remind !== 1 || e.done === 1 || firedSet.has(e.id)) continue;
    const hm = e.time ?? "09:00";
    const fireAt = new Date(e.date + "T" + hm + ":00");
    if (now >= fireAt) {
      firedSet.add(e.id);
      try {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification(`日历提醒 · ${typeMeta(e.type).lb}`, { body: e.title });
        }
      } catch { /* ignore */ }
    }
  }
}

onMounted(async () => {
  await cal.load();
  try {
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
  } catch { /* ignore */ }
  checkRemind();
  timer = window.setInterval(checkRemind, 30000);
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <div class="eco">
    <!-- 左侧月历 -->
    <div class="side">
      <div class="cal-nav">
        <button @click="shiftMonth(-1)">‹</button>
        <span class="cal-lb">{{ monthLabel }}</span>
        <button @click="shiftMonth(1)">›</button>
      </div>
      <div class="cal-week"><span v-for="w in ['日','一','二','三','四','五','六']" :key="w">{{ w }}</span></div>
      <div class="cal-grid">
        <button v-for="c in calCells" :key="c.date" class="cal-day"
          :class="{
            out: !c.inMonth,
            today: c.date === dstr(now),
            sel: c.date === selectedDate,
          }"
          @click="selectedDate = c.date">
          <span class="cd">{{ c.d }}</span>
          <span v-if="dayType(c.date).kind === 'holiday'" class="mark holiday"
            :title="dayType(c.date).name"></span>
          <span v-if="cal.byDate(c.date).length" class="mark event"
            :title="`${cal.byDate(c.date).length} 个事件`"></span>
        </button>
      </div>
      <div class="legend">
        <span><i class="lg-trade"></i>交易日</span>
        <span><i class="lg-holiday"></i>休市</span>
        <span><i class="lg-event"></i>事件</span>
      </div>
    </div>

    <!-- 右侧 -->
    <div class="main">
      <div class="day-head">
        <div class="day-date">{{ selectedDate }}</div>
        <span class="day-tag" :class="selectedType.kind">
          {{ selectedType.kind === 'trade' ? '交易日'
             : selectedType.kind === 'weekend' ? '周末休市'
             : `休市 · ${selectedType.name}` }}
        </span>
        <div class="spacer"></div>
        <button class="add-btn" @click="openCreate">+ 添加事件</button>
      </div>

      <!-- 表单 -->
      <div v-if="showForm" class="form">
        <div class="f-row">
          <input v-model="fTitle" class="f-title" placeholder="事件标题，如：美联储议息 / 某股解禁" />
        </div>
        <div class="f-row f-inline">
          <label>时间 <input v-model="fTime" type="time" class="f-time" />
            <span class="f-hint">留空为全天</span></label>
          <label class="f-remind"><input type="checkbox" v-model="fRemind" /> 到点提醒</label>
        </div>
        <div class="f-row">
          <span class="f-lb">类型</span>
          <button v-for="t in TYPES" :key="t.v" class="type-chip"
            :class="{ on: fType === t.v }"
            :style="fType === t.v ? { color: t.c, borderColor: t.c } : {}"
            @click="fType = t.v">{{ t.lb }}</button>
        </div>
        <div class="f-row">
          <span class="f-lb">关联</span>
          <span v-if="fCode" class="tag-chip">{{ fCode }}<i @click="fCode = null">×</i></span>
          <button v-else-if="code" class="link-btn" @click="useLink">关联当前选中 {{ code }}</button>
          <span v-else class="f-hint">无</span>
        </div>
        <div class="f-row">
          <input v-model="fNote" class="f-note" placeholder="备注（可选）" />
        </div>
        <div class="f-actions">
          <span class="f-msg">{{ formMsg }}</span>
          <button class="f-cancel" @click="showForm = false">取消</button>
          <button class="f-save" @click="saveForm">保存</button>
        </div>
      </div>

      <!-- 事件列表 -->
      <div class="elist">
        <div v-for="e in dayEvents" :key="e.id" class="erow" :class="{ done: e.done === 1 }">
          <button class="e-check" :class="{ on: e.done === 1 }" @click="toggleDone(e)">✓</button>
          <span class="e-time">{{ e.time ?? '全天' }}</span>
          <i class="e-dot" :style="{ background: typeMeta(e.type).c }"></i>
          <span class="e-type" :style="{ color: typeMeta(e.type).c }">{{ typeMeta(e.type).lb }}</span>
          <span class="e-title" @click="openEdit(e)">{{ e.title }}</span>
          <span v-if="e.code" class="e-code">{{ e.code }}</span>
          <div class="e-spacer"></div>
          <button class="e-bell" :class="{ on: e.remind === 1 }"
            title="到点提醒" @click="toggleRemind(e)">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor"
              d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 00-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
          </button>
          <button class="e-edit" title="编辑" @click="openEdit(e)">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor"
              d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          </button>
          <button class="e-del" title="删除" @click="cal.remove(e.id)">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor"
              d="M6 7h12l-1 14H7L6 7zm3 2v9h2V9H9zm4 0v9h2V9h-2zM9 4h6l1 2H8l1-2z"/></svg>
          </button>
        </div>
        <div v-if="!dayEvents.length && !showForm" class="empty">
          当日没有事件，点右上角「添加事件」记录将要发生的事
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.eco { flex: 1; min-height: 0; display: grid; grid-template-columns: 236px 1fr; gap: 10px; }

/* 左侧 */
.side { display: flex; flex-direction: column; background: var(--bg-panel);
  border: 1px solid var(--border); border-radius: 8px; padding: 9px; }
.cal-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }
.cal-nav button { width: 26px; background: transparent; border: 1px solid var(--border);
  border-radius: 4px; color: var(--text-dim); cursor: pointer; font-size: 14px; }
.cal-lb { font-size: 12.5px; font-weight: 600; }
.cal-week { display: grid; grid-template-columns: repeat(7,1fr); text-align: center;
  font-size: 10px; color: var(--text-dim); margin-bottom: 4px; }
.cal-grid { display: grid; grid-template-columns: repeat(7,1fr); gap: 2px; }
.cal-day { position: relative; aspect-ratio: 1; background: transparent; border: 1px solid transparent;
  border-radius: 5px; cursor: pointer; color: var(--text); font-size: 11.5px; }
.cal-day.out { color: #45506a; }
.cal-day.today { border-color: var(--border); }
.cal-day.sel { background: #2a3c5e; color: #fff; }
.cd { position: absolute; top: 3px; left: 0; right: 0; }
.mark { position: absolute; bottom: 3px; width: 5px; height: 5px; border-radius: 50%;
  left: calc(50% - 2.5px); }
.mark.holiday { background: #e2b440; }
.mark.event { background: #4ea1ff; left: calc(50% + 3px); }
.legend { display: flex; gap: 12px; justify-content: center; margin-top: 9px;
  font-size: 10px; color: var(--text-dim); }
.legend i { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 3px; }
.lg-holiday { background: #e2b440; } .lg-event { background: #4ea1ff; }
.lg-trade { background: var(--text-dim); }

/* 右侧 */
.main { min-width: 0; min-height: 0; display: flex; flex-direction: column;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; }
.day-head { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; flex-shrink: 0; }
.day-date { font-size: 16px; font-weight: 700; }
.day-tag { font-size: 10.5px; padding: 2px 10px; border-radius: 11px; border: 1px solid var(--border);
  color: var(--text-dim); }
.day-tag.trade { color: #0ecb81; border-color: #0ecb8144; }
.day-tag.weekend, .day-tag.holiday { color: #e2b440; border-color: #e2b44044; }
.spacer, .e-spacer { flex: 1; }
.add-btn { font-size: 11px; padding: 4px 12px; background: #2f6fed; border: none;
  border-radius: 6px; color: #fff; cursor: pointer; }

/* 表单 */
.form { background: #0d1219; border: 1px solid var(--border); border-radius: 8px;
  padding: 9px 10px; margin-bottom: 9px; flex-shrink: 0; }
.f-row { margin-bottom: 7px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.f-title { flex: 1; min-width: 180px; background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 5px; color: var(--text); font-size: 12.5px; padding: 6px 9px; }
.f-inline { justify-content: space-between; }
.f-inline label { font-size: 11px; color: var(--text-dim); display: flex; align-items: center; gap: 5px; }
.f-time { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 5px;
  color: var(--text); font-size: 11px; padding: 3px 6px; }
.f-hint { font-size: 10px; color: var(--text-dim); }
.f-remind { cursor: pointer; }
.f-lb { font-size: 11px; color: var(--text-dim); width: 26px; }
.type-chip { font-size: 10.5px; padding: 2px 11px; background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 11px; cursor: pointer; }
.tag-chip { font-size: 10.5px; padding: 2px 6px 2px 9px; background: #1a2438; color: var(--text);
  border-radius: 11px; display: inline-flex; gap: 5px; align-items: center; }
.tag-chip i { font-style: normal; cursor: pointer; opacity: .7; }
.link-btn { font-size: 10.5px; padding: 2px 9px; background: transparent; color: var(--accent);
  border: 1px solid var(--accent); border-radius: 11px; cursor: pointer; }
.f-note { flex: 1; min-width: 160px; background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 5px; color: var(--text); font-size: 11.5px; padding: 5px 9px; }
.f-actions { display: flex; align-items: center; gap: 8px; }
.f-msg { flex: 1; font-size: 10.5px; color: #ff8a3d; }
.f-cancel { font-size: 11px; padding: 4px 12px; background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.f-save { font-size: 11px; padding: 4px 16px; background: #2f6fed; border: none;
  border-radius: 6px; color: #fff; cursor: pointer; }

/* 事件行 */
.elist { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.erow { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 7px; }
.erow.done .e-title { text-decoration: line-through; color: var(--text-dim); }
.e-check { width: 18px; height: 18px; border-radius: 5px; border: 1px solid var(--border);
  background: transparent; color: transparent; cursor: pointer; font-size: 11px; line-height: 1; flex-shrink: 0; }
.e-check.on { background: #0ecb8122; border-color: #0ecb81; color: #0ecb81; }
.e-time { font-size: 11px; color: var(--text-dim); width: 42px; flex-shrink: 0; }
.e-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.e-type { font-size: 10.5px; width: 26px; flex-shrink: 0; }
.e-title { font-size: 12px; cursor: pointer; }
.e-code { font-size: 10px; color: var(--text-dim); background: #1a2438;
  padding: 1px 7px; border-radius: 9px; }
.e-bell, .e-edit, .e-del { background: transparent; border: none; cursor: pointer;
  color: var(--text-dim); padding: 2px; display: flex; }
.e-bell.on { color: #4ea1ff; }
.e-edit:hover { color: var(--text); } .e-del:hover { color: #f23645; }
.empty { flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); font-size: 12px; }
</style>
