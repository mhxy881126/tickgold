<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useJournalStore, type JournalEntry } from "../stores/journal";

const props = defineProps<{ code: string | null }>();
const j = useJournalStore();

const view = ref<"calendar" | "list">("calendar");
const now = new Date();
const calY = ref(now.getFullYear());
const calM = ref(now.getMonth());
const selectedDate = ref(todayStr());
const currentId = ref<number | null>(null);

// 编辑草稿
const title = ref("");
const content = ref("");
const mood = ref<string | null>(null);
const tags = ref<string[]>([]);
const linkCode = ref<string | null>(null);
const tagInput = ref("");
const search = ref("");
const saveStatus = ref<"" | "saving" | "saved">("");
let suppress = false;
let saveTimer: number | null = null;

const MOODS = [
  { v: "亢奋", c: "#f23645" }, { v: "愉悦", c: "#ff8a3d" },
  { v: "平静", c: "#d4af37" }, { v: "遗憾", c: "#4ea1ff" },
  { v: "沮丧", c: "#8a93a6" },
];
const TEMPLATE = [
  "【今日大盘】", "【持仓与操作】", "【盈亏情况】", "【复盘心得】", "【明日计划】",
].join("\n");

function pad(n: number) { return String(n).padStart(2, "0"); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ===== 日历 =====
const monthLabel = computed(() => `${calY.value} 年 ${calM.value + 1} 月`);
const calCells = computed(() => {
  const first = new Date(calY.value, calM.value, 1).getDay();
  const days = new Date(calY.value, calM.value + 1, 0).getDate();
  const cells: { date: string; d: number; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const dn = i - first + 1;
    const inM = dn >= 1 && dn <= days;
    // 计算实际年月
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

// ===== 当日条目 =====
const dayEntries = computed<JournalEntry[]>(() => j.byDate(selectedDate.value));
const current = computed(() => j.entries.find((e) => e.id === currentId.value) ?? null);

function selectDate(date: string) {
  selectedDate.value = date;
  const list = j.byDate(date);
  if (list.length) openEntry(list[0]);
  else currentId.value = null;
}
function openEntry(e: JournalEntry) {
  suppress = true;
  currentId.value = e.id;
  title.value = e.title; content.value = e.content; mood.value = e.mood;
  tags.value = e.tags ? e.tags.split(/[,，]/).filter(Boolean) : [];
  linkCode.value = e.code;
  saveStatus.value = "";
  setTimeout(() => { suppress = false; }, 0);
}
async function newEntry() {
  const e = await j.create(selectedDate.value);
  openEntry(e);
}
async function delEntry() {
  if (currentId.value == null) return;
  if (window.confirm("确定删除这篇日记？")) {
    const id = currentId.value;
    await j.remove(id);
    const list = j.byDate(selectedDate.value);
    if (list.length) openEntry(list[0]); else currentId.value = null;
  }
}

// ===== 标签 =====
function addTag() {
  const v = tagInput.value.trim().replace(/[,，]/g, "");
  if (v && !tags.value.includes(v)) tags.value.push(v);
  tagInput.value = "";
}
function removeTag(t: string) { tags.value = tags.value.filter((x) => x !== t); }

function useLink() { linkCode.value = props.code; }
function insertTemplate() { content.value = (content.value ? content.value + "\n" : "") + TEMPLATE; }

// ===== 自动保存（debounce） =====
watch([title, content, mood, tags, linkCode], () => {
  if (suppress || currentId.value == null) return;
  saveStatus.value = "saving";
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    if (currentId.value == null) return;
    await j.update(currentId.value, {
      title: title.value, content: content.value, mood: mood.value,
      tags: tags.value.join(","), code: linkCode.value,
    });
    saveStatus.value = "saved";
  }, 1100);
}, { deep: true });

// ===== 列表视图 =====
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return j.entries.slice(0, 120);
  return j.entries
    .filter((e) =>
      e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q) ||
      e.tags.toLowerCase().includes(q))
    .slice(0, 120);
});

onMounted(async () => {
  await j.load();
  selectDate(selectedDate.value);
});
</script>

<template>
  <div class="journal">
    <!-- 左侧 -->
    <div class="side">
      <div class="view-seg">
        <button :class="{ on: view === 'calendar' }" @click="view = 'calendar'">日历</button>
        <button :class="{ on: view === 'list' }" @click="view = 'list'">列表</button>
      </div>

      <div v-if="view === 'calendar'">
        <div class="cal-nav">
          <button @click="shiftMonth(-1)">‹</button>
          <span class="cal-lb">{{ monthLabel }}</span>
          <button @click="shiftMonth(1)">›</button>
        </div>
        <div class="cal-week"><span v-for="w in ['日','一','二','三','四','五','六']" :key="w">{{ w }}</span></div>
        <div class="cal-grid">
          <button v-for="c in calCells" :key="c.date" class="cal-day"
            :class="{ out: !c.inMonth, today: c.date === todayStr(), sel: c.date === selectedDate }"
            @click="selectDate(c.date)">
            <span class="cd">{{ c.d }}</span>
            <span v-if="j.dateCount[c.date]" class="cdot">{{ j.dateCount[c.date] }}</span>
          </button>
        </div>
      </div>

      <div v-else class="list-view">
        <input v-model="search" class="search" placeholder="搜索标题 / 内容 / 标签" />
        <div class="jlist">
          <div v-for="e in filtered" :key="e.id" class="jitem"
            :class="{ on: e.id === currentId }" @click="selectDate(e.date); openEntry(e)">
            <div class="ji-date">{{ e.date }}<span v-if="e.mood" class="ji-mood"
              :style="{ color: (MOODS.find(m=>m.v===e.mood)||{}).c }">{{ e.mood }}</span></div>
            <div class="ji-title">{{ e.title || "（无标题）" }}</div>
            <div class="ji-pre">{{ e.content.slice(0, 40) }}</div>
          </div>
          <div v-if="!filtered.length" class="j-empty">没有匹配的日记</div>
        </div>
      </div>
    </div>

    <!-- 右侧编辑器 -->
    <div class="editor">
      <template v-if="currentId !== null">
        <div class="ed-top">
          <div class="ed-date">
            {{ selectedDate }}
            <span v-if="dayEntries.length > 1" class="ed-count">当日第
              {{ dayEntries.findIndex(e=>e.id===currentId)+1 }} / {{ dayEntries.length }} 篇</span>
          </div>
          <div class="ed-chips">
            <button v-for="e in dayEntries" :key="e.id" class="ed-chip"
              :class="{ on: e.id === currentId }" @click="openEntry(e)">
              {{ e.title || "无标题" }}
            </button>
          </div>
          <button class="new-btn" @click="newEntry">+ 新建</button>
        </div>

        <input v-model="title" class="ed-title" placeholder="标题（如：放量突破，减仓一半）" />

        <div class="ed-row">
          <span class="row-lb">心情</span>
          <button v-for="m in MOODS" :key="m.v" class="mood-btn"
            :class="{ on: mood === m.v }" :style="mood === m.v ? { color: m.c, borderColor: m.c } : {}"
            @click="mood = mood === m.v ? null : m.v">{{ m.v }}</button>
        </div>

        <div class="ed-row">
          <span class="row-lb">标签</span>
          <span v-for="t in tags" :key="t" class="tag-chip">{{ t }}
            <i @click="removeTag(t)">×</i></span>
          <input v-model="tagInput" class="tag-in" size="7"
            @keydown.enter.prevent="addTag" @blur="addTag" />
        </div>

        <div class="ed-row">
          <span class="row-lb">关联</span>
          <span v-if="linkCode" class="tag-chip gold">{{ linkCode }}<i @click="linkCode = null">×</i></span>
          <button v-else-if="code" class="link-btn" @click="useLink">关联当前选中 {{ code }}</button>
          <span v-else class="row-hint">无</span>
        </div>

        <textarea v-model="content" class="ed-content"
          placeholder="记录盘面、操作、盈亏与心得…"></textarea>

        <div class="ed-foot">
          <button class="tpl-btn" @click="insertTemplate">插入复盘模板</button>
          <span class="save-st">
            <span v-if="saveStatus === 'saving'" class="saving">自动保存中…</span>
            <span v-else-if="saveStatus === 'saved'" class="saved">已自动保存</span>
          </span>
          <button class="del-btn" @click="delEntry">删除</button>
        </div>
      </template>

      <div v-else class="no-entry">
        <div class="ne-date">{{ selectedDate }}</div>
        <p class="ne-sub">当日还没有日记</p>
        <button class="ne-btn" @click="newEntry">写一篇</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.journal { flex: 1; min-height: 0; display: grid; grid-template-columns: 224px 1fr; gap: 10px; }

/* 左侧 */
.side { display: flex; flex-direction: column; min-height: 0;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
.view-seg { display: flex; gap: 4px; margin-bottom: 8px; }
.view-seg button { flex: 1; padding: 4px 0; font-size: 11.5px; background: transparent;
  color: var(--text-dim); border: 1px solid var(--border); border-radius: 5px; cursor: pointer; }
.view-seg button.on { color: var(--accent); background: #1a2438; }
.cal-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.cal-nav button { width: 24px; background: transparent; border: 1px solid var(--border);
  border-radius: 4px; color: var(--text-dim); cursor: pointer; font-size: 13px; }
.cal-lb { font-size: 12px; font-weight: 600; }
.cal-week { display: grid; grid-template-columns: repeat(7,1fr); text-align: center;
  font-size: 10px; color: var(--text-dim); margin-bottom: 3px; }
.cal-grid { display: grid; grid-template-columns: repeat(7,1fr); gap: 2px; }
.cal-day { position: relative; aspect-ratio: 1; background: transparent; border: none;
  border-radius: 5px; cursor: pointer; color: var(--text); font-size: 11px; }
.cal-day.out { color: #45506a; }
.cal-day.today { background: #1a2438; }
.cal-day.sel { background: #2a3c5e; color: #fff; }
.cd { position: absolute; top: 2px; left: 0; right: 0; }
.cdot { position: absolute; bottom: 1px; left: 0; right: 0; font-size: 8.5px;
  color: var(--accent); font-weight: 700; }
.search { width: 100%; background: #0d1219; border: 1px solid var(--border); border-radius: 5px;
  color: var(--text); font-size: 11.5px; padding: 5px 7px; margin-bottom: 8px; }
.list-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.jlist { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
.jitem { padding: 6px 7px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
.jitem:hover { background: var(--bg-hover); }
.jitem.on { background: #16233a; border-color: var(--border); }
.ji-date { font-size: 10px; color: var(--text-dim); display: flex; justify-content: space-between; }
.ji-title { font-size: 11.5px; font-weight: 600; margin: 1px 0; }
.ji-pre { font-size: 10px; color: var(--text-dim); }
.j-empty { text-align: center; color: var(--text-dim); font-size: 11px; padding: 20px 0; }

/* 右侧 */
.editor { min-width: 0; min-height: 0; display: flex; flex-direction: column;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px; }
.ed-top { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; flex-shrink: 0; }
.ed-date { font-size: 12px; font-weight: 700; white-space: nowrap; }
.ed-count { font-size: 10px; color: var(--text-dim); font-weight: 400; margin-left: 5px; }
.ed-chips { flex: 1; display: flex; gap: 4px; overflow-x: auto; min-width: 0; }
.ed-chip { font-size: 10.5px; padding: 2px 9px; background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 11px; cursor: pointer; white-space: nowrap; }
.ed-chip.on { color: var(--accent); border-color: var(--accent); }
.new-btn { font-size: 10.5px; padding: 3px 10px; background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 5px; cursor: pointer; white-space: nowrap; }
.new-btn:hover { color: var(--accent); border-color: var(--accent); }

.ed-title { background: transparent; border: none; border-bottom: 1px solid var(--border);
  color: var(--text); font-size: 15px; font-weight: 700; padding: 4px 2px 7px; margin-bottom: 8px; }
.ed-row { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; flex-wrap: wrap; flex-shrink: 0; }
.row-lb { font-size: 11px; color: var(--text-dim); width: 26px; flex-shrink: 0; }
.mood-btn { font-size: 10.5px; padding: 2px 10px; background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 11px; cursor: pointer; }
.tag-chip { font-size: 10.5px; padding: 2px 6px 2px 9px; background: #1a2438; color: var(--text);
  border-radius: 11px; display: inline-flex; align-items: center; gap: 5px; }
.tag-chip.gold { color: var(--accent); }
.tag-chip i { font-style: normal; cursor: pointer; opacity: .7; }
.tag-in { background: #0d1219; border: 1px solid var(--border); border-radius: 11px;
  color: var(--text); font-size: 10.5px; padding: 2px 8px; }
.link-btn { font-size: 10.5px; padding: 2px 9px; background: transparent; color: var(--accent);
  border: 1px solid var(--accent); border-radius: 11px; cursor: pointer; }
.row-hint { font-size: 11px; color: var(--text-dim); }

.ed-content { flex: 1; min-height: 80px; resize: none; background: #0d1219;
  border: 1px solid var(--border); border-radius: 7px; color: var(--text);
  font-size: 12px; line-height: 1.7; padding: 8px 10px; margin-top: 2px; font-family: inherit; }
.ed-foot { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-shrink: 0; }
.tpl-btn { font-size: 11px; padding: 4px 11px; background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 5px; cursor: pointer; }
.tpl-btn:hover { color: var(--text); }
.save-st { flex: 1; font-size: 11px; }
.saving { color: #4ea1ff; } .saved { color: #0ecb81; }
.del-btn { font-size: 11px; padding: 4px 12px; background: transparent; color: #f23645;
  border: 1px solid var(--border); border-radius: 5px; cursor: pointer; }

.no-entry { flex: 1; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 6px; }
.ne-date { font-size: 16px; font-weight: 700; }
.ne-sub { font-size: 12px; color: var(--text-dim); margin: 0; }
.ne-btn { margin-top: 8px; padding: 8px 22px; font-size: 13px; background: #2f6fed;
  border: none; border-radius: 7px; color: #fff; cursor: pointer; }
</style>
