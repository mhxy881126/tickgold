<template>
  <div class="ss">
    <!-- 条件栏 -->
    <div class="ss-bar">
      <div class="ss-tacs">
        <button
          v-for="t in TACTICS"
          :key="t.id"
          class="ss-tac"
          :class="{ on: chosen.has(t.id) }"
          @click="toggle(t.id)"
        >
          {{ t.label }}
        </button>
      </div>
      <input v-model="theme" class="ss-in" placeholder="行业关键词，如 半导体" />
      <input v-model.number="limit" class="ss-in narrow" type="number" min="1" max="100" title="每战法上限" />
      <button class="ss-run" :disabled="loading" @click="run">
        {{ loading ? "扫描中…" : "全市场扫描" }}
      </button>
      <button class="ss-subbtn" title="把当前条件存为每日定时扫描" @click="openSave">订阅</button>
      <button class="ss-subbtn" :class="{ on: showSubs }" @click="toggleSubs">
        定时{{ subs.length ? `(${subs.length})` : "" }}
      </button>
    </div>

    <!-- 定时订阅面板 -->
    <div v-if="showSubs" class="ss-subpanel">
      <div v-if="saving" class="ss-saveform">
        <input v-model="subForm.name" class="ss-in" placeholder="订阅名称，如 每日首板复盘" />
        <input v-model="subForm.runTime" class="ss-in narrow" type="time" title="每日执行时间（北京时间）" />
        <label class="ss-en"><input v-model="subForm.enabled" type="checkbox" /> 启用</label>
        <button class="ss-mini primary" @click="saveSub">保存</button>
        <button class="ss-mini" @click="saving = false">取消</button>
      </div>
      <div v-if="!subs.length && !saving" class="ss-empty" style="padding:10px">
        暂无定时订阅，点「订阅」把当前战法/题材/上限条件存为每日扫描。
      </div>
      <div v-for="s in subs" :key="s.id" class="ss-subrow">
        <template v-if="editingId === s.id">
          <input v-model="editForm.name" class="ss-in" />
          <input v-model="editForm.runTime" class="ss-in narrow" type="time" />
          <label class="ss-en"><input v-model="editForm.enabled" type="checkbox" /> 启用</label>
          <button class="ss-mini primary" @click="saveEdit(s)">保存</button>
          <button class="ss-mini" @click="editingId = 0">取消</button>
        </template>
        <template v-else>
          <span class="ss-subname" :class="{ off: !s.enabled }">{{ s.name }}</span>
          <span class="ss-submeta">{{ subTacticText(s) }} · {{ s.runTime }}</span>
          <span v-if="s.lastRunAt" class="ss-submeta">上次 {{ fmtTime(s.lastRunAt) }}</span>
          <span class="ss-subacts">
            <button class="ss-mini" @click="runSubNow(s)">立即跑</button>
            <button class="ss-mini" @click="startEdit(s)">改</button>
            <button class="ss-mini danger" @click="removeSub(s)">删</button>
            <button class="ss-mini" @click="toggleRuns(s)">{{ runOpen === s.id ? "收起" : "记录" }}</button>
          </span>
        </template>
        <div v-if="runOpen === s.id" class="ss-runs">
          <div v-if="!runMap[s.id]?.length" class="ss-submeta">暂无执行记录</div>
          <div v-for="r in runMap[s.id]" :key="r.id" class="ss-runline">
            {{ fmtTime(r.ranAt) }} · 命中 {{ r.hitCount }} 只
            <span class="ss-codes">{{ r.codesJson }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 结果 -->
    <div class="ss-body">
      <div v-if="loading" class="ss-empty">正在扫描涨停池与涨幅榜前 300…</div>
      <div v-else-if="!hits.length" class="ss-empty">
        <div class="empty-icon">🎯</div>
        <div>选择战法后点击「全市场扫描」</div>
        <div class="ss-hint">首板/连板取涨停池；反包/弱转强/资金共振取涨幅榜并核验日 K。</div>
      </div>
      <div v-else class="ss-list">
        <div v-for="h in hits" :key="h.code" class="ss-row">
          <div class="ss-head" @click="open = open === h.code ? '' : h.code">
            <span class="ss-code">{{ h.code }}</span>
            <span class="ss-name">{{ h.name }}</span>
            <span class="ss-badges">
              <i v-for="t in h.tactics" :key="t" class="ss-badge">{{ tacLabel(t) }}</i>
            </span>
            <span class="ss-pct" :class="h.pct >= 0 ? 'up' : 'k'">{{ signed(h.pct) }}%</span>
            <span class="ss-net" :class="h.mainNet >= 0 ? 'up' : 'k'">
              主力 {{ (h.mainNet / 1e8).toFixed(2) }}亿
            </span>
            <span class="ss-turn">换手 {{ h.turnover.toFixed(1) }}%</span>
            <span class="ss-chev">{{ open === h.code ? "−" : "+" }}</span>
          </div>
          <div class="ss-actions">
            <button @click.stop="addWatch(h)">加自选</button>
            <button @click.stop="toConditional(h)">转条件单</button>
          </div>
          <div v-if="open === h.code" class="ss-detail">
            <div v-for="(r, i) in h.reasons" :key="i" class="ss-reason">· {{ r }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount } from "vue";
import {
  runStrategyScan,
  screenSubList,
  screenSubUpsert,
  screenSubDelete,
  screenSubRuns,
  screenSubRunNow,
  type TacticHit,
  type ScreenSubscription,
} from "../../api/market";
import { listen } from "@tauri-apps/api/event";
import { useWatchlistStore } from "../../stores/watchlist";
import { coCreate } from "../../broker/co";
import { toast } from "../../composables/useToast";

const TACTICS = [
  { id: "first_board", label: "首板" },
  { id: "multi_board", label: "连板" },
  { id: "reversal", label: "反包" },
  { id: "weak_to_strong", label: "弱转强" },
  { id: "fund_resonance", label: "资金共振" },
  { id: "theme_leader", label: "题材龙头" },
];
const chosen = ref<Set<string>>(new Set(TACTICS.map((t) => t.id)));
const theme = ref("");
const limit = ref(30);
const hits = ref<TacticHit[]>([]);
const loading = ref(false);
const open = ref("");
const watch = useWatchlistStore();

function toggle(id: string) {
  const next = new Set(chosen.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  chosen.value = next;
}
function tacLabel(id: string) {
  return TACTICS.find((t) => t.id === id)?.label ?? id;
}
function signed(v: number) {
  return (v > 0 ? "+" : "") + v.toFixed(2);
}

async function run() {
  loading.value = true;
  try {
    hits.value = await runStrategyScan({
      tactics: [...chosen.value],
      limit: limit.value,
      theme: theme.value.trim(),
    });
  } catch (e) {
    toast.error("扫描失败：" + String(e));
  } finally {
    loading.value = false;
  }
}

async function addWatch(h: TacticHit) {
  await watch.add(h.code, h.name);
  toast.success(`${h.name} 已加自选`);
}

/// 一键转买入条件单：触发涨幅阈值（板类 7%，其余 3%），100 股，5 日有效。
async function toConditional(h: TacticHit) {
  const boardLike = h.tactics.some((t) => ["first_board", "multi_board", "theme_leader"].includes(t));
  try {
    await coCreate({
      code: h.code,
      name: h.name,
      side: "BUY",
      trigger: [{ field: "pct", op: "gte", value: boardLike ? 7 : 3 }],
      vol: 100,
      priceMode: "market",
      ttl: "5d",
      note: `战法选股：${h.tactics.map(tacLabel).join("/")} · ${h.reasons[0] ?? ""}`,
    });
    toast.success(`已为 ${h.name} 创建买入条件单`);
  } catch (e) {
    toast.error("创建条件单失败：" + String(e));
  }
}

// ===== 定时订阅 =====
const subs = ref<ScreenSubscription[]>([]);
const showSubs = ref(false);
const saving = ref(false);
const editingId = ref(0);
const runOpen = ref(0);
const runMap = reactive<Record<number, Awaited<ReturnType<typeof screenSubRuns>>>>({});
const subForm = reactive({ name: "", runTime: "15:30", enabled: true });
const editForm = reactive({ name: "", runTime: "15:30", enabled: true });
let unlistenSub: (() => void) | null = null;

function currentTacticStr() {
  return [...chosen.value].join(",");
}
function currentFilterJson() {
  return JSON.stringify({ limit: limit.value, theme: theme.value.trim() });
}
function fmtTime(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function subTacticText(s: ScreenSubscription) {
  if (!s.tactic) return "全部战法";
  return s.tactic
    .split(",")
    .map((t) => tacLabel(t.trim()))
    .filter(Boolean)
    .join("/");
}

async function loadSubs() {
  try {
    subs.value = await screenSubList();
  } catch (e) {
    console.warn("订阅列表加载失败", e);
  }
}
function toggleSubs() {
  showSubs.value = !showSubs.value;
  if (showSubs.value) void loadSubs();
}
function openSave() {
  subForm.name = "";
  subForm.runTime = "15:30";
  subForm.enabled = true;
  saving.value = true;
  showSubs.value = true;
}
async function saveSub() {
  if (!subForm.name.trim()) {
    toast.error("订阅名称不能为空");
    return;
  }
  try {
    await screenSubUpsert({
      name: subForm.name.trim(),
      tactic: currentTacticStr(),
      filterJson: currentFilterJson(),
      runTime: subForm.runTime,
      enabled: subForm.enabled,
    });
    saving.value = false;
    toast.success("订阅已保存，到点自动扫描");
    await loadSubs();
  } catch (e) {
    toast.error("保存订阅失败：" + String(e));
  }
}
function startEdit(s: ScreenSubscription) {
  editingId.value = s.id;
  editForm.name = s.name;
  editForm.runTime = s.runTime;
  editForm.enabled = s.enabled;
}
async function saveEdit(s: ScreenSubscription) {
  try {
    await screenSubUpsert({
      id: s.id,
      name: editForm.name.trim() || s.name,
      tactic: s.tactic,
      filterJson: s.filterJson,
      runTime: editForm.runTime,
      enabled: editForm.enabled,
    });
    editingId.value = 0;
    await loadSubs();
  } catch (e) {
    toast.error("修改失败：" + String(e));
  }
}
async function removeSub(s: ScreenSubscription) {
  try {
    await screenSubDelete(s.id);
    toast.success("订阅已删除");
    await loadSubs();
  } catch (e) {
    toast.error("删除失败：" + String(e));
  }
}
async function runSubNow(s: ScreenSubscription) {
  try {
    const runId = await screenSubRunNow(s.id);
    toast.success(runId < 0 ? `${s.name} 已执行：0 条命中` : `${s.name} 已执行，去记录查看`);
    await loadSubs();
    if (runOpen.value === s.id) await toggleRuns(s);
  } catch (e) {
    toast.error("执行失败：" + String(e));
  }
}
async function toggleRuns(s: ScreenSubscription) {
  if (runOpen.value === s.id) {
    runOpen.value = 0;
    return;
  }
  runOpen.value = s.id;
  try {
    runMap[s.id] = await screenSubRuns(s.id);
  } catch (e) {
    console.warn("执行记录加载失败", e);
  }
}

onMounted(async () => {
  try {
    unlistenSub = await listen<{ name: string; hitCount: number }>("screen-sub:run", () => {
      // 全局 Toast 由 App.vue 统一弹；卡片打开时仅刷新订阅状态
      if (showSubs.value) void loadSubs();
    });
  } catch (e) {
    console.warn("screen-sub:run 监听失败", e);
  }
});
onBeforeUnmount(() => unlistenSub?.());
</script>

<style scoped>
.ss {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
}
.ss-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ss-tacs {
  display: flex;
  gap: 5px;
}
.ss-tac {
  border: 1px solid var(--border, #2a3344);
  background: transparent;
  color: var(--text-dim, #9aa4b8);
  border-radius: 7px;
  padding: 3px 11px;
  font-size: 11px;
  cursor: pointer;
}
.ss-tac.on {
  color: #ff3232;
  border-color: #ff323299;
  background: #ff323214;
}
.ss-in {
  border: 1px solid var(--border, #2a3344);
  background: var(--bg-card, #15181f);
  color: var(--text, #e6ecf5);
  border-radius: 7px;
  padding: 4px 9px;
  font-size: 11px;
  width: 150px;
}
.ss-in.narrow {
  width: 64px;
}
.ss-run {
  margin-left: auto;
  border: none;
  background: #ff3232;
  color: #fff;
  border-radius: 7px;
  padding: 5px 16px;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}
.ss-run:disabled {
  opacity: 0.6;
}
.ss-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.ss-empty {
  text-align: center;
  color: var(--text-dim, #8a93a6);
  font-size: 11px;
  padding: 36px 16px;
}
.empty-icon {
  font-size: 26px;
  margin-bottom: 6px;
}
.ss-hint {
  margin-top: 6px;
  font-size: 10px;
  opacity: 0.8;
}
.ss-row {
  border: 1px solid var(--border, #263043);
  border-radius: 9px;
  margin-bottom: 5px;
  overflow: hidden;
}
.ss-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 10px;
  font-size: 11px;
  cursor: pointer;
}
.ss-head:hover {
  background: var(--bg-hover, rgba(255, 255, 255, 0.04));
}
.ss-code {
  color: var(--text-dim, #9aa4b8);
  font-variant-numeric: tabular-nums;
}
.ss-name {
  color: var(--text, #e6ecf5);
  font-weight: 600;
}
.ss-badges {
  display: flex;
  gap: 4px;
}
.ss-badge {
  font-style: normal;
  font-size: 9.5px;
  color: #ffb13d;
  border: 1px solid #ffb13d66;
  background: #ffb13d12;
  border-radius: 5px;
  padding: 0 6px;
}
.ss-pct,
.ss-net,
.ss-turn {
  font-variant-numeric: tabular-nums;
  color: var(--text-dim, #98a1b5);
  font-size: 10.5px;
}
.up {
  color: #ff3232;
}
.k {
  color: #1dbe7d;
}
.ss-chev {
  margin-left: auto;
  color: var(--text-dim, #8a93a6);
  width: 12px;
}
.ss-actions {
  display: flex;
  gap: 6px;
  padding: 0 10px 7px;
}
.ss-actions button {
  border: 1px solid var(--border, #2a3344);
  background: transparent;
  color: var(--text-dim, #aab2c4);
  border-radius: 6px;
  padding: 2px 10px;
  font-size: 10px;
  cursor: pointer;
}
.ss-actions button:hover {
  color: var(--accent, #d4af37);
  border-color: var(--accent, #d4af37);
}
.ss-detail {
  border-top: 1px solid var(--border, #263043);
  padding: 7px 12px 9px;
}
.ss-reason {
  font-size: 10.5px;
  color: var(--text-dim, #b0b9cb);
  line-height: 1.7;
}
.ss-subbtn {
  border: 1px solid var(--border, #2a3344);
  background: transparent;
  color: var(--text-dim, #9aa4b8);
  border-radius: 7px;
  padding: 4px 12px;
  font-size: 11px;
  cursor: pointer;
}
.ss-subbtn.on {
  color: #ffb13d;
  border-color: #ffb13d99;
  background: #ffb13d12;
}
.ss-subpanel {
  border: 1px solid var(--border, #263043);
  border-radius: 9px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 42%;
  overflow-y: auto;
}
.ss-saveform {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.ss-en {
  font-size: 10.5px;
  color: var(--text-dim, #aab2c4);
  display: flex;
  align-items: center;
  gap: 3px;
}
.ss-mini {
  border: 1px solid var(--border, #2a3344);
  background: transparent;
  color: var(--text-dim, #aab2c4);
  border-radius: 6px;
  padding: 2px 9px;
  font-size: 10px;
  cursor: pointer;
}
.ss-mini:hover {
  color: var(--accent, #d4af37);
  border-color: var(--accent, #d4af37);
}
.ss-mini.primary {
  color: #ff3232;
  border-color: #ff323299;
}
.ss-mini.danger:hover {
  color: #ff5b5b;
  border-color: #ff5b5b;
}
.ss-subrow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
}
.ss-subname {
  color: var(--text, #e6ecf5);
  font-weight: 600;
}
.ss-subname.off {
  color: var(--text-dim, #6b7488);
  font-weight: 400;
}
.ss-submeta {
  color: var(--text-dim, #8a93a6);
  font-size: 10px;
}
.ss-subacts {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.ss-runs {
  width: 100%;
  border-top: 1px dashed var(--border, #263043);
  padding-top: 5px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ss-runline {
  font-size: 10px;
  color: var(--text-dim, #9aa4b8);
}
.ss-codes {
  color: #6b7488;
}
</style>
