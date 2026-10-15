<script setup lang="ts">
import { ref, nextTick, onMounted, watch } from "vue";
import { useWatchlistStore } from "../stores/watchlist";
import { useQuotesStore } from "../stores/quotes";
import { searchStocks } from "../api/market";
import type { StockItem, Quote } from "../api/types";
import AnimatedNumber from "./common/AnimatedNumber.vue";
import {
  FIELD_GROUPS,
  FIELD_META,
  parseQuery,
  hasCondition,
  type QueryCondition,
  type SmartQueryRule,
} from "../lib/smartQuery";

const props = defineProps<{ selected: string | null }>();
const emit = defineEmits<{ select: [code: string] }>();

const wl = useWatchlistStore();
const quotes = useQuotesStore();

const keyword = ref("");
const searchResults = ref<StockItem[]>([]);
const showSearch = ref(false);

// 分组：新建 / 重命名
const adding = ref(false);
const newGroupName = ref("");
const editingId = ref<number | null>(null);
const editName = ref("");
const groupInput = ref<HTMLInputElement | null>(null);

// v2.31 智能分组 → v3 动态选股：选股问句 + 指标条件编辑器，榜单位每日动态筛选
const smartAdding = ref(false);
const smartName = ref("");
const smartQueryText = ref("");
const smartLogic = ref<"AND" | "OR">("AND");
const smartConds = ref<QueryCondition[]>([]);
const smartUnparsed = ref<string[]>([]);
// 条件编辑器
const smartFieldGroup = ref(FIELD_GROUPS[0].label);
const smartField = ref(FIELD_GROUPS[0].fields[0].key);
const smartOp = ref<QueryCondition["op"]>("<=");
const smartValue = ref<number | null>(null);

function resetSmartDraft() {
  smartName.value = "";
  smartQueryText.value = "";
  smartLogic.value = "AND";
  smartConds.value = [];
  smartUnparsed.value = [];
  smartFieldGroup.value = FIELD_GROUPS[0].label;
  smartField.value = FIELD_GROUPS[0].fields[0].key;
  smartOp.value = "<=";
  smartValue.value = null;
}

/** 问句解析：解析出的条件进入条件列表（可继续编辑） */
function parseSmartQuery() {
  const r = parseQuery(smartQueryText.value);
  smartLogic.value = r.logic;
  smartUnparsed.value = r.unparsed;
  for (const c of r.conditions) upsertCond(c);
}

function upsertCond(c: QueryCondition) {
  const idx = smartConds.value.findIndex((x) => x.field === c.field);
  if (idx >= 0) smartConds.value[idx] = c;
  else smartConds.value.push({ ...c });
}

/** 条件编辑器：切换类别时同步字段 */
function onFieldGroupChange() {
  const g = FIELD_GROUPS.find((x) => x.label === smartFieldGroup.value);
  if (g) smartField.value = g.fields[0].key;
}

function addSmartCond() {
  if (smartValue.value == null || Number.isNaN(smartValue.value)) return;
  upsertCond({ field: smartField.value, op: smartOp.value, value: smartValue.value });
  smartValue.value = null;
}

function removeSmartCond(i: number) {
  smartConds.value.splice(i, 1);
}

function condLabel(c: QueryCondition): string {
  const m = FIELD_META[c.field];
  const opTxt = c.op === ">=" ? "≥" : c.op === "<=" ? "≤" : "=";
  return `${m?.label ?? c.field} ${opTxt} ${c.value}${m?.unit ? " " + m.unit : ""}`;
}

/** v2 规则是否可创建 */
function smartCanCreate(): boolean {
  return smartName.value.trim().length > 0 && hasCondition({ version: 2, logic: smartLogic.value, conditions: smartConds.value });
}

/** 智能分组最近更新时间（v2） */
function smartUpdatedText(gid: number): string {
  const v = wl.smartV2[gid];
  if (!v) return "";
  const d = new Date(v.updatedAt);
  return `更新于 ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
}

/** 打开/切到 v2 分组时自动刷新（无缓存或超 3 分钟） */
function ensureSmartRefresh(gid: number) {
  const g = wl.groups.find((x) => x.id === gid);
  if (!g || g.kind !== "smart") return;
  let rule: SmartQueryRule | null = null;
  try {
    const parsed = JSON.parse(g.ruleJson || "{}");
    if (parsed.version === 2) rule = parsed as SmartQueryRule;
  } catch {
    rule = null;
  }
  if (!rule) return;
  const v = wl.smartV2[gid];
  if (!v || Date.now() - v.updatedAt > 3 * 60_000) {
    void wl.refreshSmartGroup(gid);
  }
}

onMounted(() => {
  ensureSmartRefresh(wl.currentGroupId);
});
watch(
  () => wl.currentGroupId,
  (gid) => ensureSmartRefresh(gid)
);

function hitBadge(code: string): string {
  const h = wl.hitOf(code);
  if (!h) return "";
  return h.boards >= 2 ? `${h.boards}连板` : "首板";
}
function isWatched(code: string): boolean {
  return wl.stocks.some((s) => s.code === code);
}
async function startSmartAdd() {
  smartAdding.value = true;
  resetSmartDraft();
  await nextTick();
  groupInput.value?.focus();
}
async function commitSmartAdd() {
  if (!smartAdding.value) return;
  const name = smartName.value.trim();
  smartAdding.value = false;
  if (!name) return;
  // 问句未解析部分提示（不阻断）
  if (smartUnparsed.value.length) {
    smartUnparsed.value = [];
  }
  const rule: SmartQueryRule = {
    version: 2,
    logic: smartLogic.value,
    conditions: smartConds.value,
  };
  await wl.addSmartGroup(name, rule as never);
}
function isSmartGroup(id: number): boolean {
  return wl.groups.find((g) => g.id === id)?.kind === "smart";
}

async function doSearch() {
  if (!keyword.value.trim()) {
    searchResults.value = [];
    showSearch.value = false;
    return;
  }
  searchResults.value = await searchStocks(keyword.value);
  showSearch.value = true;
}
function pick(s: StockItem) {
  wl.add(s.code, s.name);
  keyword.value = "";
  searchResults.value = [];
  showSearch.value = false;
  emit("select", s.code);
}

function qOf(code: string): Quote | undefined {
  return quotes.map[code];
}
function cls(pct?: number) {
  if (pct == null) return "flat";
  if (pct > 0) return "up";
  if (pct < 0) return "down";
  return "flat";
}

async function startAdd() {
  adding.value = true;
  newGroupName.value = "";
  await nextTick();
  groupInput.value?.focus();
}
async function commitAdd() {
  if (!adding.value) return;
  const name = newGroupName.value.trim();
  adding.value = false;
  if (name) await wl.addGroup(name);
}
async function startEdit(g: { id: number; name: string }) {
  editingId.value = g.id;
  editName.value = g.name;
  await nextTick();
  groupInput.value?.focus();
}
async function commitEdit(g: { id: number }) {
  if (editingId.value !== g.id) return;
  const name = editName.value.trim();
  editingId.value = null;
  if (name) await wl.renameGroup(g.id, name);
}

// 移动到分组（居中弹层，Teleport 到 body，避免被卡片 overflow 裁切或 fixed 定位异常）
const menuCode = ref<string | null>(null);
const moveNewName = ref("");
function openMove(code: string) {
  menuCode.value = code;
}
function closeMoveMenu() {
  menuCode.value = null;
  moveNewName.value = "";
}
function isCurrent(code: string, gid: number): boolean {
  return wl.stocks.find((x) => x.code === code)?.groupId === gid;
}
async function moveTo(code: string, gid: number) {
  await wl.moveToGroup(code, gid);
  wl.selectGroup(gid);
  closeMoveMenu();
}
async function moveAddGroup() {
  const n = moveNewName.value.trim();
  if (!n || !menuCode.value) return;
  const gid = await wl.addGroup(n);
  await moveTo(menuCode.value, gid);
}
</script>

<template>
  <div class="panel">
    <div class="search">
      <input
        v-model="keyword"
        placeholder="输入代码/名称，回车添加到当前分组"
        @input="doSearch"
        @keydown.enter="doSearch"
      />
      <div v-if="showSearch && searchResults.length" class="results">
        <div
          v-for="s in searchResults.slice(0, 8)"
          :key="s.code"
          class="result-item"
          @mousedown.prevent="pick(s)"
        >
          <span class="code">{{ s.code }}</span>
          <span>{{ s.name }}</span>
          <span class="mkt">{{ s.market }}</span>
        </div>
      </div>
    </div>

    <!-- 分组栏 -->
    <div class="groups">
      <div
        v-for="g in wl.groups"
        :key="g.id"
        class="chip"
        :class="{ active: g.id === wl.currentGroupId }"
        @click="wl.selectGroup(g.id)"
        @dblclick="startEdit(g)"
      >
        <input
          v-if="editingId === g.id"
          ref="groupInput"
          v-model="editName"
          class="chip-input"
          @click.stop
          @keydown.enter="commitEdit(g)"
          @blur="commitEdit(g)"
        />
        <template v-else>
          <span class="gname">{{ g.name }}</span>
          <i v-if="g.kind === 'smart'" class="gsmart" title="智能分组（动态选股/按规则自动归类）">智</i>
          <span v-if="g.kind === 'smart' && wl.smartV2[g.id]" class="gupd">{{ smartUpdatedText(g.id) }}</span>
          <span class="gcount">{{ wl.membersOf(g.id).length }}</span>
          <span
            v-if="g.kind === 'smart' && wl.smartV2Refreshing[g.id]"
            class="grefresh loading"
            title="刷新中…"
            >⟳</span
          >
          <span
            v-else-if="g.kind === 'smart'"
            class="grefresh"
            title="立即刷新动态成员"
            @click.stop="wl.refreshSmartGroup(g.id)"
            >⟳</span
          >
          <span
            v-if="g.id !== 1"
            class="gdel"
            :title="g.kind === 'smart' ? '删除智能分组（不影响自选）' : '删除分组（股票移回默认分组）'"
            @click.stop="wl.removeGroup(g.id)"
            >×</span
          >
        </template>
      </div>
      <div v-if="adding" class="chip editing">
        <input
          ref="groupInput"
          v-model="newGroupName"
          class="chip-input"
          @keydown.enter="commitAdd"
          @blur="commitAdd"
        />
      </div>
      <Teleport v-if="smartAdding" to="body">
        <div class="smart-modal">
          <div class="sm-mask" @click="smartAdding = false"></div>
          <div class="sm-box">
            <div class="sm-head">
              <span>新建智能分组 · 动态选股</span>
              <button class="sm-x" @click="smartAdding = false">×</button>
            </div>
            <input
              ref="groupInput"
              v-model="smartName"
              class="sm-in"
              placeholder="分组名称，如 低估值高换手"
              maxlength="12"
            />
            <div class="sm-q">
              <input
                v-model="smartQueryText"
                class="sm-in sm-q-in"
                placeholder="输入选股问句，如：市盈率低于20 且 换手率大于5%"
                @keydown.enter="parseSmartQuery"
              />
              <button class="sm-parse" @click="parseSmartQuery">解析</button>
            </div>
            <div v-if="smartUnparsed.length" class="sm-tip warn">
              未识别：{{ smartUnparsed.join("；") }}（请用下方条件编辑器补充）
            </div>

            <!-- 已解析条件 -->
            <div v-if="smartConds.length" class="sm-conds">
              <span v-for="(c, i) in smartConds" :key="c.field" class="sm-cond">
                {{ condLabel(c) }}
                <b class="sm-cond-x" @click="removeSmartCond(i)">×</b>
              </span>
            </div>

            <!-- 条件编辑器 -->
            <div class="sm-editor">
              <select v-model="smartFieldGroup" class="sm-sel" @change="onFieldGroupChange">
                <option v-for="g in FIELD_GROUPS" :key="g.label" :value="g.label">{{ g.label }}</option>
              </select>
              <select v-model="smartField" class="sm-sel">
                <option v-for="f in FIELD_GROUPS.find((x) => x.label === smartFieldGroup)?.fields ?? []" :key="f.key" :value="f.key">
                  {{ f.label }}
                </option>
              </select>
              <select v-model="smartOp" class="sm-sel sm-op">
                <option value=">=">≥</option>
                <option value="<=">≤</option>
                <option value="==">=</option>
              </select>
              <input
                v-model.number="smartValue"
                class="sm-in sm-val"
                type="number"
                placeholder="数值"
                @keydown.enter="addSmartCond"
              />
              <button class="sm-add" @click="addSmartCond">添加</button>
            </div>

            <div class="sm-row sm-logic">
              <label>满足条件</label>
              <select v-model="smartLogic">
                <option value="AND">全部满足（且）</option>
                <option value="OR">任一满足（或）</option>
              </select>
            </div>

            <div class="sm-tip">
              成员从涨幅/成交额/换手三榜前 300 只动态筛选（约 700-900 只候选），每次打开分组自动刷新；连板数来自近 5 日涨停记录。
            </div>
            <button class="sm-go" :class="{ disabled: !smartCanCreate() }" :disabled="!smartCanCreate()" @click="commitSmartAdd">
              创建
            </button>
          </div>
        </div>
      </Teleport>
      <div class="chip add" title="新建普通分组" @click="startAdd">+</div>
      <div class="chip addsmart" title="新建智能分组（按战法/题材自动归类）" @click="startSmartAdd">智+</div>
    </div>

    <div class="table-wrap">
    <table class="list">
      <colgroup>
        <col style="width: 38%">
        <col style="width: 20%">
        <col style="width: 20%">
        <col style="width: 13%">
        <col style="width: 9%">
      </colgroup>
      <thead>
        <tr>
          <th>名称</th><th class="r">最新</th><th class="r">涨跌幅</th><th class="r">成交额</th><th class="c">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(s, i) in wl.currentStocks"
          :key="s.code"
          v-flash="qOf(s.code)?.price"
          :class="{ active: s.code === props.selected, hit: !!hitBadge(s.code) }"
          @click="emit('select', s.code)"
        >
          <td class="stock-cell">
            <span class="nm">{{ qOf(s.code)?.name || s.name || "--" }}</span>
            <span class="cd">{{ s.code }}</span>
            <i v-if="hitBadge(s.code)" class="hit-badge">{{ hitBadge(s.code) }}</i>
          </td>
          <td class="r" :class="cls(qOf(s.code)?.pct)">
            <AnimatedNumber v-if="qOf(s.code)" :value="qOf(s.code)!.price" kind="price" />
            <span v-else>--</span>
          </td>
          <td class="r" :class="cls(qOf(s.code)?.pct)">
            <AnimatedNumber v-if="qOf(s.code)" :value="qOf(s.code)!.pct" kind="pct" />
            <span v-else>--</span>
          </td>
          <td class="r dim">
            <span v-if="qOf(s.code)">{{ (qOf(s.code)!.amount / 1e8).toFixed(1) }}</span>
            <span v-else>--</span>
          </td>
          <td class="c ops">
            <template v-if="isSmartGroup(wl.currentGroupId)">
              <button
                v-if="!isWatched(s.code)"
                class="op addw"
                title="加入默认自选分组"
                @click.stop="wl.add(s.code, s.name, 1)"
              >+</button>
              <span v-else class="inwatch" title="已在自选">✓</span>
            </template>
            <template v-else>
              <button class="op move" title="移动到其他分组" @click.stop="openMove(s.code)">⇄</button>
              <button class="op del" title="移出自选" @click.stop="wl.remove(s.code)">×</button>
            </template>
          </td>
        </tr>
        <tr v-if="wl.currentStocks.length === 0">
          <td colspan="5" class="empty">该分组暂无股票，上方搜索添加</td>
        </tr>
      </tbody>
    </table>
    </div><!-- /.table-wrap -->
    <Teleport to="body">
      <div v-if="menuCode" class="move-modal">
        <div class="mm-mask" @click="closeMoveMenu"></div>
        <div class="mm-box">
          <div class="mm-head">
            <span class="mm-caption">移动到分组</span>
            <button class="mm-x" title="关闭" @click="closeMoveMenu">×</button>
          </div>
          <div class="mm-stock">
            {{ qOf(menuCode)?.name || "--" }}
            <span class="mm-scode">{{ menuCode }}</span>
          </div>
          <div class="mm-list">
            <button
              v-for="g in wl.groups"
              :key="g.id"
              class="mm-item"
              :class="{ cur: isCurrent(menuCode, g.id) }"
              :disabled="isCurrent(menuCode, g.id)"
              @click="moveTo(menuCode, g.id)"
            >
              <span class="mm-gname">{{ g.name }}</span>
              <span class="mm-right">
                <span class="mm-c">{{ wl.stocksOf(g.id).length }}</span>
                <span v-if="isCurrent(menuCode, g.id)" class="mm-tag">当前</span>
              </span>
            </button>
          </div>
          <div class="mm-add">
            <input
              v-model="moveNewName"
              placeholder="新建分组名称"
              maxlength="12"
              @keydown.enter="moveAddGroup"
            />
            <button class="mm-addgo" @click="moveAddGroup">新建并移动</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.search { position: relative; padding: 8px; }
.search input { width: 100%; }
.results {
  position: absolute; top: 100%; left: 8px; right: 8px; z-index: 30;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 6px;
  max-height: 240px; overflow: auto;
}
.result-item { display: flex; gap: 8px; padding: 7px 10px; cursor: pointer; }
.result-item:hover { background: var(--bg-hover); }
.result-item .code { color: var(--text-dim); }
.result-item .mkt { margin-left: auto; color: var(--text-dim); font-size: 11px; }

/* 分组栏 */
.groups {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 4px 8px 8px; border-bottom: 1px solid var(--border);
}
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 9px; border-radius: 14px; font-size: 12px;
  background: var(--bg-panel); border: 1px solid var(--border);
  cursor: pointer; color: var(--text-dim); white-space: nowrap;
}
.chip:hover { background: var(--bg-hover); }
.chip.active { color: #e6edf3; border-color: #2f6fed; background: #16233a; }
.gcount {
  font-size: 10px; background: rgba(255,255,255,0.08); border-radius: 8px; padding: 0 6px;
}
.gdel { color: #8b98a5; padding: 0 2px; }
.gdel:hover { color: #f23645; }
.chip.add { font-size: 15px; line-height: 1; padding: 2px 10px; }
.chip.editing { padding: 1px 6px; }
.chip-input { width: 84px; background: transparent; border: none; outline: none; color: #e6edf3; font-size: 12px; }

table { width: 100%; border-collapse: collapse; table-layout: fixed; }
thead th {
  text-align: left; color: var(--text-dim); font-weight: 500;
  padding: 5px 8px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg-panel); z-index: 5;
  font-size: 11px;
}
th.r, td.r { text-align: right; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--bg-hover); }
tbody tr.active { background: #1c2735; }
td { padding: 5px 8px; border-bottom: 1px solid #1b2129; font-size: 12px; white-space: nowrap; overflow: hidden; }
.stock-cell { display: flex; align-items: baseline; gap: 5px; overflow: hidden; }
.nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cd { font-size: 10px; color: var(--text-dim); flex-shrink: 0; }
.dim { color: var(--text-dim); }
th.c, td.c { text-align: center; }
.ops { position: relative; white-space: nowrap; }
.op {
  width: 18px; height: 18px; border-radius: 4px; border: 1px solid transparent;
  background: transparent; color: var(--text-dim); font-size: 11px; line-height: 1;
  cursor: pointer; padding: 0; display: inline-flex; align-items: center; justify-content: center;
}
tbody tr:hover .op { border-color: var(--border); }
.op.move:hover { color: #e8c66a; border-color: #d4af37; }
.op.del:hover { color: #f23645; border-color: #f23645; }
/* ===== 移动分组居中弹层 ===== */
.move-modal {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
}
.mm-mask { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(3px); }
.mm-box {
  position: relative; width: 300px; max-width: calc(100vw - 32px);
  background: var(--bg-panel); border: 1px solid var(--border-light); border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6); padding: 14px;
  animation: mmPop 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes mmPop {
  from { opacity: 0; transform: scale(0.94); }
  to { opacity: 1; transform: scale(1); }
}
.mm-head { display: flex; align-items: center; margin-bottom: 8px; }
.mm-caption { font-size: 13px; font-weight: 700; color: var(--text); }
.mm-x {
  margin-left: auto; width: 22px; height: 22px; border: none;
  background: transparent; color: var(--text-dim); font-size: 16px;
  cursor: pointer; border-radius: 6px; line-height: 1;
}
.mm-x:hover { background: var(--bg-hover); color: var(--text); }
.mm-stock {
  font-size: 12px; color: var(--text); padding: 6px 9px;
  background: var(--bg-hover); border-radius: 7px; margin-bottom: 10px;
}
.mm-scode { color: var(--text-dim); font-size: 10px; margin-left: 6px; }
.mm-list {
  display: flex; flex-direction: column; gap: 4px;
  max-height: 220px; overflow-y: auto; margin-bottom: 10px;
}
.mm-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
  background: transparent; color: var(--text); font-size: 12px; cursor: pointer;
}
.mm-item:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-2); }
.mm-item.cur { opacity: 0.55; cursor: default; }
.mm-gname { text-align: left; }
.mm-right { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.mm-c {
  font-size: 10px; background: rgba(255, 255, 255, 0.08);
  border-radius: 8px; padding: 0 7px; color: var(--text-dim);
}
.mm-tag { font-size: 10px; color: var(--accent-2); }
.mm-add { display: flex; gap: 6px; }
.mm-add input {
  flex: 1; min-width: 0; height: 30px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg);
  color: var(--text); padding: 0 9px; font-size: 12px;
}
.mm-add input:focus { outline: none; border-color: var(--accent); }
.mm-addgo {
  height: 30px; padding: 0 12px; border: none; border-radius: 7px;
  background: var(--accent); color: #1a1405; font-size: 12px;
  font-weight: 700; cursor: pointer; white-space: nowrap;
}
.mm-addgo:hover { filter: brightness(1.08); }
.empty { text-align: center; color: var(--text-dim); padding: 30px; font-size: 12px; }

.table-wrap { position: relative; flex: 1; min-height: 0; overflow: hidden; }

/* v2.31 智能分组 / 信号高亮 */
.chip.addsmart { font-size: 11px; line-height: 1; padding: 3px 8px; color: #e8c66a; border-color: #8a753588; }
.gsmart {
  font-style: normal; font-size: 9px; color: #e8c66a;
  border: 1px solid #e8c66a66; border-radius: 4px; padding: 0 3px;
}
tbody tr.hit { box-shadow: inset 2px 0 0 #e8c66a; }
.hit-badge {
  font-style: normal; font-size: 9px; color: #ffb13d;
  border: 1px solid #ffb13d66; background: #ffb13d12;
  border-radius: 4px; padding: 0 4px; margin-left: 2px; flex-shrink: 0;
}
.op.addw:hover { color: #1dbe7d; border-color: #1dbe7d; }
.inwatch { color: #1dbe7d; font-size: 11px; }
.smart-modal {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
}
.sm-mask { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(3px); }
.sm-box {
  position: relative; width: 300px; max-width: calc(100vw - 32px);
  background: var(--bg-panel); border: 1px solid var(--border-light); border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6); padding: 14px;
  animation: mmPop 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.sm-head { display: flex; align-items: center; font-size: 13px; font-weight: 700; margin-bottom: 10px; }
.sm-x {
  margin-left: auto; width: 22px; height: 22px; border: none;
  background: transparent; color: var(--text-dim); font-size: 16px;
  cursor: pointer; border-radius: 6px; line-height: 1;
}
.sm-x:hover { background: var(--bg-hover); color: var(--text); }
.sm-in {
  width: 100%; height: 30px; border-radius: 7px; box-sizing: border-box;
  border: 1px solid var(--border); background: var(--bg);
  color: var(--text); padding: 0 9px; font-size: 12px; margin-bottom: 8px;
}
.sm-in:focus { outline: none; border-color: var(--accent); }
.sm-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; }
.sm-row label { width: 36px; color: var(--text-dim); flex-shrink: 0; }
.sm-row select {
  flex: 1; height: 28px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg); color: var(--text); padding: 0 7px; font-size: 12px;
}
.sm-tip { font-size: 10px; color: var(--text-dim); line-height: 1.6; margin: 2px 0 10px; }
.sm-tip.warn { color: #ffb13d; }
.sm-q { display: flex; gap: 6px; }
.sm-q .sm-q-in { flex: 1; margin-bottom: 8px; }
.sm-parse {
  height: 30px; padding: 0 10px; border: none; border-radius: 7px;
  background: #2a3344; color: #e8c66a; font-size: 12px; font-weight: 700;
  cursor: pointer; white-space: nowrap; margin-bottom: 8px;
}
.sm-parse:hover { filter: brightness(1.1); }
.sm-conds { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
.sm-cond {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; color: #e8c66a; background: rgba(232, 198, 106, 0.08);
  border: 1px solid rgba(232, 198, 106, 0.35); border-radius: 6px; padding: 2px 7px;
}
.sm-cond-x { cursor: pointer; color: var(--text-dim); font-size: 12px; line-height: 1; }
.sm-cond-x:hover { color: #f23645; }
.sm-editor { display: flex; gap: 5px; margin-bottom: 8px; align-items: center; }
.sm-editor .sm-sel {
  flex: 1; min-width: 0; height: 28px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--bg); color: var(--text);
  padding: 0 6px; font-size: 11px;
}
.sm-editor .sm-op { flex: 0 0 44px; }
.sm-editor .sm-val { flex: 0 0 62px; width: 62px; height: 28px; margin-bottom: 0; }
.sm-add {
  height: 28px; padding: 0 8px; border: none; border-radius: 7px;
  background: var(--accent); color: #1a1405; font-size: 11px; font-weight: 700;
  cursor: pointer; white-space: nowrap; flex-shrink: 0;
}
.sm-add:hover { filter: brightness(1.08); }
.sm-logic label { width: 52px; }
.sm-go.disabled { opacity: 0.45; cursor: not-allowed; }
.sm-go.disabled:hover { filter: none; }
.gupd { font-size: 9px; color: var(--text-dim); margin-left: 3px; }
.grefresh {
  font-size: 11px; line-height: 1; color: var(--text-dim);
  cursor: pointer; margin-left: 2px; padding: 0 2px;
}
.grefresh:hover { color: #e8c66a; }
.grefresh.loading { animation: gspin 0.9s linear infinite; cursor: default; }
@keyframes gspin { to { transform: rotate(360deg); } }
.sm-go {
  width: 100%; height: 32px; border: none; border-radius: 7px;
  background: var(--accent); color: #1a1405; font-size: 12px;
  font-weight: 700; cursor: pointer;
}
.sm-go:hover { filter: brightness(1.08); }
</style>
